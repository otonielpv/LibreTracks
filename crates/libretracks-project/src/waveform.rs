use std::{
    collections::hash_map::DefaultHasher,
    fs,
    hash::{Hash, Hasher},
    io,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use symphonia::core::{
    audio::SampleBuffer,
    codecs::{DecoderOptions, CODEC_TYPE_NULL},
    errors::Error as SymphoniaError,
    formats::FormatOptions,
    io::MediaSourceStream,
    meta::MetadataOptions,
    probe::Hint,
};

use crate::ProjectError;

const WAVEFORM_FORMAT_VERSION: u32 = 5;
const MIN_READABLE_WAVEFORM_FORMAT_VERSION: u32 = 4;
const WAVEFORM_FILE_MAGIC: &[u8; 8] = b"LTPEAKS1";
const WAVEFORM_LOD_RESOLUTIONS: [usize; 4] = [256, 2_048, 16_384, 131_072];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WaveformLod {
    pub resolution_frames: usize,
    /// Min peaks for the left channel (or the only channel for mono sources).
    #[serde(default)]
    pub min_peaks: Vec<f32>,
    /// Max peaks for the left channel (or the only channel for mono sources).
    #[serde(default)]
    pub max_peaks: Vec<f32>,
    /// Min peaks for the right channel. Empty for mono sources — consumers
    /// that see an empty vector should render the clip as a single waveform.
    #[serde(default)]
    pub min_peaks_right: Vec<f32>,
    /// Max peaks for the right channel. See `min_peaks_right`.
    #[serde(default)]
    pub max_peaks_right: Vec<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WaveformSummary {
    pub version: u32,
    #[serde(default)]
    pub duration_seconds: f64,
    pub sample_rate: u32,
    pub lods: Vec<WaveformLod>,
    #[serde(default)]
    pub seek_index: Vec<SeekIndexEntry>,
}

impl WaveformSummary {
    pub fn primary_lod(&self) -> Option<&WaveformLod> {
        self.lods.first()
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SeekIndexEntry {
    pub timestamp: u64,
    pub packet_offset: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AnalyzedWav {
    pub duration_seconds: f64,
    pub sample_rate: u32,
    pub channels: u16,
    pub waveform: WaveformSummary,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyWaveformSummary {
    version: u32,
    #[serde(default)]
    duration_seconds: f64,
    bucket_count: usize,
    #[serde(default)]
    min_peaks: Vec<f32>,
    #[serde(default)]
    max_peaks: Vec<f32>,
}

pub fn waveform_file_path(
    song_dir: impl AsRef<Path>,
    audio_relative_path: impl AsRef<Path>,
) -> PathBuf {
    let file_stem = waveform_cache_file_stem(audio_relative_path.as_ref());

    song_dir
        .as_ref()
        .join("cache")
        .join("waveforms")
        .join(format!("{file_stem}.waveform.ltpeaks"))
}

fn resolve_audio_source_path(song_dir: &Path, audio_path: &Path) -> PathBuf {
    if audio_path.is_absolute() {
        audio_path.to_path_buf()
    } else {
        song_dir.join(audio_path)
    }
}

fn legacy_waveform_json_file_path(
    song_dir: impl AsRef<Path>,
    audio_relative_path: impl AsRef<Path>,
) -> PathBuf {
    let file_stem = waveform_cache_file_stem(audio_relative_path.as_ref());

    song_dir
        .as_ref()
        .join("cache")
        .join("waveforms")
        .join(format!("{file_stem}.waveform.json"))
}

fn waveform_cache_file_stem(audio_path: &Path) -> String {
    let stem = audio_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("waveform");
    if !audio_path.is_absolute() {
        return stem.to_string();
    }

    let mut hasher = DefaultHasher::new();
    audio_path.to_string_lossy().hash(&mut hasher);
    format!("{stem}-{:016x}", hasher.finish())
}

pub fn analyze_wav_file(path: impl AsRef<Path>) -> Result<AnalyzedWav, ProjectError> {
    let path = path.as_ref();
    let file = fs::File::open(path)?;
    let mut hint = Hint::new();
    if let Some(extension) = path.extension().and_then(|value| value.to_str()) {
        hint.with_extension(extension);
    }
    let media_source_stream = MediaSourceStream::new(Box::new(file), Default::default());
    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            media_source_stream,
            &FormatOptions {
                prebuild_seek_index: true,
                seek_index_fill_rate: 1,
                ..FormatOptions::default()
            },
            &MetadataOptions::default(),
        )
        .map_err(|_| ProjectError::UnsupportedAudioFormat {
            path: path.to_path_buf(),
        })?;
    let mut format = probed.format;
    let track = format
        .default_track()
        .or_else(|| {
            format
                .tracks()
                .iter()
                .find(|track| track.codec_params.codec != CODEC_TYPE_NULL)
        })
        .ok_or_else(|| ProjectError::UnsupportedAudioFormat {
            path: path.to_path_buf(),
        })?;
    let track_id = track.id;
    let sample_rate = track.codec_params.sample_rate.ok_or_else(|| {
        ProjectError::AudioDecode(format!("missing sample rate for {}", path.display()))
    })?;
    let channels = track
        .codec_params
        .channels
        .map(|channels| channels.count() as u16)
        .unwrap_or(1)
        .max(1);
    let codec_params = track.codec_params.clone();
    let mut decoder = symphonia::default::get_codecs()
        .make(&codec_params, &DecoderOptions::default())
        .map_err(|error| ProjectError::AudioDecode(error.to_string()))?;
    let track_right = channels >= 2;
    let mut buckets = WaveformBuckets::new(
        codec_params.n_frames.unwrap_or(sample_rate as u64) as usize,
        WAVEFORM_LOD_RESOLUTIONS[0],
        track_right,
    );
    let mut frame_index = 0usize;
    let mut seek_index = Vec::new();
    let mut packet_offset = 0u64;

    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(SymphoniaError::IoError(error)) if error.kind() == io::ErrorKind::UnexpectedEof => {
                break;
            }
            Err(error) => return Err(ProjectError::AudioDecode(error.to_string())),
        };

        if packet.track_id() != track_id {
            continue;
        }

        if seek_index
            .last()
            .map(|entry: &SeekIndexEntry| {
                packet.ts().saturating_sub(entry.timestamp) >= u64::from(sample_rate)
            })
            .unwrap_or(true)
        {
            seek_index.push(SeekIndexEntry {
                timestamp: packet.ts(),
                packet_offset,
            });
        }
        packet_offset = packet_offset.saturating_add(1);

        let decoded = match decoder.decode(&packet) {
            Ok(decoded) => decoded,
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(SymphoniaError::IoError(error)) if error.kind() == io::ErrorKind::UnexpectedEof => {
                break;
            }
            Err(error) => return Err(ProjectError::AudioDecode(error.to_string())),
        };
        let mut sample_buffer =
            SampleBuffer::<f32>::new(decoded.capacity() as u64, *decoded.spec());
        sample_buffer.copy_interleaved_ref(decoded);
        let channel_count = usize::from(channels.max(1));
        for frame in sample_buffer.samples().chunks(channel_count) {
            let left_sample = if frame.is_empty() {
                0.0
            } else {
                frame[0].clamp(-1.0, 1.0)
            };
            let right_sample = if track_right {
                frame.get(1).map(|sample| sample.clamp(-1.0, 1.0))
            } else {
                None
            };
            buckets.push_frame(frame_index, left_sample, right_sample);
            frame_index += 1;
        }
    }

    buckets.truncate(frame_index);
    let duration_seconds = frame_index as f64 / f64::from(sample_rate.max(1));

    let waveform = WaveformSummary {
        version: WAVEFORM_FORMAT_VERSION,
        duration_seconds,
        sample_rate,
        lods: build_waveform_lods(buckets.finish()),
        seek_index,
    };

    Ok(AnalyzedWav {
        duration_seconds,
        sample_rate,
        channels,
        waveform,
    })
}

pub fn write_waveform_summary(
    output_path: impl AsRef<Path>,
    summary: &WaveformSummary,
) -> Result<(), ProjectError> {
    let path = output_path.as_ref();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    validate_waveform_summary(summary, path)?;
    fs::write(path, encode_waveform_summary_binary(summary)?)?;
    Ok(())
}

pub fn waveform_summary_from_peaks(
    sample_rate: u32,
    duration_frames: u64,
    resolution_frames: usize,
    min_peaks: Vec<f32>,
    max_peaks: Vec<f32>,
) -> Result<WaveformSummary, ProjectError> {
    if sample_rate == 0
        || duration_frames == 0
        || resolution_frames == 0
        || min_peaks.is_empty()
        || min_peaks.len() != max_peaks.len()
    {
        return Err(ProjectError::InvalidWaveformSummary(
            "<native-waveform>".into(),
        ));
    }

    let base_lod = WaveformLod {
        resolution_frames,
        min_peaks,
        max_peaks,
        min_peaks_right: Vec::new(),
        max_peaks_right: Vec::new(),
    };
    let summary = WaveformSummary {
        version: WAVEFORM_FORMAT_VERSION,
        duration_seconds: duration_frames as f64 / f64::from(sample_rate),
        sample_rate,
        lods: build_waveform_lods(base_lod),
        seek_index: Vec::new(),
    };
    validate_waveform_summary(&summary, "<native-waveform>")?;
    Ok(summary)
}

pub fn generate_waveform_summary(
    song_dir: impl AsRef<Path>,
    audio_relative_path: impl AsRef<Path>,
) -> Result<WaveformSummary, ProjectError> {
    let song_dir = song_dir.as_ref();
    let audio_relative_path = audio_relative_path.as_ref();
    let source_path = resolve_audio_source_path(song_dir, audio_relative_path);
    let summary = analyze_wav_file(&source_path)?.waveform;

    let path = waveform_file_path(song_dir, audio_relative_path);
    write_waveform_summary(path, &summary)?;

    Ok(summary)
}

pub fn load_waveform_summary(
    song_dir: impl AsRef<Path>,
    audio_relative_path: impl AsRef<Path>,
) -> Result<WaveformSummary, ProjectError> {
    let song_dir = song_dir.as_ref();
    let audio_relative_path = audio_relative_path.as_ref();
    let path = waveform_file_path(song_dir, audio_relative_path);

    if path.exists() {
        let summary = decode_waveform_summary_binary(&fs::read(&path)?)
            .ok_or_else(|| ProjectError::InvalidWaveformSummary(path.clone()))?;
        if summary.version < WAVEFORM_FORMAT_VERSION {
            let summary =
                analyze_wav_file(resolve_audio_source_path(song_dir, audio_relative_path))?
                    .waveform;
            write_waveform_summary(&path, &summary)?;
            return Ok(summary);
        }
        validate_waveform_summary(&summary, &path)?;
        return Ok(summary);
    }

    let legacy_path = legacy_waveform_json_file_path(song_dir, audio_relative_path);
    if !legacy_path.exists() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("waveform cache not found: {}", path.display()),
        )
        .into());
    }

    let summary = load_legacy_waveform_summary(song_dir, audio_relative_path, &legacy_path)?;
    write_waveform_summary(&path, &summary)?;
    Ok(summary)
}

fn validate_waveform_summary(
    summary: &WaveformSummary,
    path: impl AsRef<Path>,
) -> Result<(), ProjectError> {
    let path = path.as_ref().to_path_buf();
    let lods_are_valid = !summary.lods.is_empty()
        && summary.lods.iter().all(|lod| {
            lod.resolution_frames > 0
                && !lod.max_peaks.is_empty()
                && lod.min_peaks.len() == lod.max_peaks.len()
                && (lod.max_peaks_right.is_empty()
                    || (lod.min_peaks_right.len() == lod.max_peaks.len()
                        && lod.max_peaks_right.len() == lod.max_peaks.len()))
        });

    if summary.version < MIN_READABLE_WAVEFORM_FORMAT_VERSION
        || summary.duration_seconds <= 0.0
        || summary.sample_rate == 0
        || !lods_are_valid
    {
        return Err(ProjectError::InvalidWaveformSummary(path));
    }

    Ok(())
}

fn load_legacy_waveform_summary(
    song_dir: &Path,
    audio_relative_path: &Path,
    legacy_path: &Path,
) -> Result<WaveformSummary, ProjectError> {
    let legacy: LegacyWaveformSummary = serde_json::from_str(&fs::read_to_string(legacy_path)?)?;
    if legacy.version == 0
        || legacy.duration_seconds <= 0.0
        || legacy.bucket_count == 0
        || legacy.min_peaks.len() != legacy.bucket_count
        || legacy.max_peaks.len() != legacy.bucket_count
    {
        return Err(ProjectError::InvalidWaveformSummary(
            legacy_path.to_path_buf(),
        ));
    }

    let metadata = analyze_wav_file(resolve_audio_source_path(song_dir, audio_relative_path))?;
    let frame_count = (metadata.duration_seconds * f64::from(metadata.sample_rate.max(1)))
        .round()
        .max(1.0) as usize;
    let resolution_frames = frame_count.div_ceil(legacy.bucket_count).max(1);
    let base_lod = WaveformLod {
        resolution_frames,
        min_peaks: legacy.min_peaks,
        max_peaks: legacy.max_peaks,
        min_peaks_right: Vec::new(),
        max_peaks_right: Vec::new(),
    };

    let summary = WaveformSummary {
        version: WAVEFORM_FORMAT_VERSION,
        duration_seconds: legacy.duration_seconds,
        sample_rate: metadata.sample_rate,
        lods: build_waveform_lods(base_lod),
        seek_index: Vec::new(),
    };
    validate_waveform_summary(&summary, legacy_path)?;
    Ok(summary)
}

fn build_waveform_lods(base_lod: WaveformLod) -> Vec<WaveformLod> {
    let mut lods = vec![base_lod];

    for resolution_frames in WAVEFORM_LOD_RESOLUTIONS {
        let last_resolution = lods
            .last()
            .map(|lod| lod.resolution_frames)
            .unwrap_or(resolution_frames);
        if resolution_frames <= last_resolution {
            continue;
        }

        let next_lod = downsample_waveform_lod(
            lods.last().expect("base waveform lod should exist"),
            resolution_frames,
        );
        lods.push(next_lod);
    }

    lods
}

fn downsample_waveform_lod(source: &WaveformLod, target_resolution_frames: usize) -> WaveformLod {
    let chunk_size = target_resolution_frames
        .div_ceil(source.resolution_frames.max(1))
        .max(1);
    let (min_peaks, max_peaks) =
        downsample_peak_pair(&source.min_peaks, &source.max_peaks, chunk_size);
    let (min_peaks_right, max_peaks_right) = if source.max_peaks_right.is_empty() {
        (Vec::new(), Vec::new())
    } else {
        downsample_peak_pair(&source.min_peaks_right, &source.max_peaks_right, chunk_size)
    };

    WaveformLod {
        resolution_frames: target_resolution_frames,
        min_peaks,
        max_peaks,
        min_peaks_right,
        max_peaks_right,
    }
}

fn downsample_peak_pair(
    min_source: &[f32],
    max_source: &[f32],
    chunk_size: usize,
) -> (Vec<f32>, Vec<f32>) {
    let mut min_peaks = Vec::with_capacity(max_source.len().div_ceil(chunk_size));
    let mut max_peaks = Vec::with_capacity(max_source.len().div_ceil(chunk_size));

    for chunk_start in (0..max_source.len()).step_by(chunk_size) {
        let chunk_end = (chunk_start + chunk_size).min(max_source.len());
        let min_peak = min_source[chunk_start..chunk_end]
            .iter()
            .fold(1.0_f32, |current, value| current.min(*value));
        let max_peak = max_source[chunk_start..chunk_end]
            .iter()
            .fold(-1.0_f32, |current, value| current.max(*value));
        min_peaks.push(min_peak);
        max_peaks.push(max_peak);
    }

    (min_peaks, max_peaks)
}

fn encode_waveform_summary_binary(summary: &WaveformSummary) -> Result<Vec<u8>, ProjectError> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(WAVEFORM_FILE_MAGIC);
    bytes.extend_from_slice(&summary.version.to_le_bytes());
    bytes.extend_from_slice(&summary.duration_seconds.to_le_bytes());
    bytes.extend_from_slice(&summary.sample_rate.to_le_bytes());
    bytes.extend_from_slice(&(summary.lods.len() as u32).to_le_bytes());

    for lod in &summary.lods {
        if lod.min_peaks.len() != lod.max_peaks.len() {
            return Err(ProjectError::InvalidWaveformSummary(PathBuf::from(
                "<waveform-memory>",
            )));
        }
        if !lod.max_peaks_right.is_empty()
            && (lod.min_peaks_right.len() != lod.max_peaks.len()
                || lod.max_peaks_right.len() != lod.max_peaks.len())
        {
            return Err(ProjectError::InvalidWaveformSummary(PathBuf::from(
                "<waveform-memory>",
            )));
        }

        bytes.extend_from_slice(&(lod.resolution_frames as u64).to_le_bytes());
        bytes.extend_from_slice(&(lod.max_peaks.len() as u32).to_le_bytes());
        for value in &lod.min_peaks {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        for value in &lod.max_peaks {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        // v5+ appends a flag byte: 0 = mono (no right peaks follow), 1 =
        // stereo (right channel peaks follow, same bucket count as left).
        let stereo_flag: u8 = if lod.max_peaks_right.is_empty() { 0 } else { 1 };
        bytes.push(stereo_flag);
        if stereo_flag == 1 {
            for value in &lod.min_peaks_right {
                bytes.extend_from_slice(&value.to_le_bytes());
            }
            for value in &lod.max_peaks_right {
                bytes.extend_from_slice(&value.to_le_bytes());
            }
        }
    }
    bytes.extend_from_slice(&(summary.seek_index.len() as u32).to_le_bytes());
    for entry in &summary.seek_index {
        bytes.extend_from_slice(&entry.timestamp.to_le_bytes());
        bytes.extend_from_slice(&entry.packet_offset.to_le_bytes());
    }

    Ok(bytes)
}

fn decode_waveform_summary_binary(bytes: &[u8]) -> Option<WaveformSummary> {
    let mut offset = 0usize;
    let magic = read_exact::<8>(bytes, &mut offset)?;
    if magic != *WAVEFORM_FILE_MAGIC {
        return None;
    }

    let version = read_u32(bytes, &mut offset)?;
    let duration_seconds = read_f64(bytes, &mut offset)?;
    let sample_rate = read_u32(bytes, &mut offset)?;
    let lod_count = read_u32(bytes, &mut offset)? as usize;
    let mut lods = Vec::with_capacity(lod_count);

    for _ in 0..lod_count {
        let resolution_frames = read_u64(bytes, &mut offset)? as usize;
        let bucket_count = read_u32(bytes, &mut offset)? as usize;
        let mut min_peaks = Vec::with_capacity(bucket_count);
        let mut max_peaks = Vec::with_capacity(bucket_count);

        for _ in 0..bucket_count {
            min_peaks.push(read_f32(bytes, &mut offset)?);
        }

        for _ in 0..bucket_count {
            max_peaks.push(read_f32(bytes, &mut offset)?);
        }

        let mut min_peaks_right = Vec::new();
        let mut max_peaks_right = Vec::new();
        if version >= 5 {
            let stereo_flag = *bytes.get(offset)?;
            offset += 1;
            if stereo_flag > 1 {
                return None;
            }
            if stereo_flag == 1 {
                min_peaks_right.reserve(bucket_count);
                max_peaks_right.reserve(bucket_count);
                for _ in 0..bucket_count {
                    min_peaks_right.push(read_f32(bytes, &mut offset)?);
                }
                for _ in 0..bucket_count {
                    max_peaks_right.push(read_f32(bytes, &mut offset)?);
                }
            }
        }

        lods.push(WaveformLod {
            resolution_frames,
            min_peaks,
            max_peaks,
            min_peaks_right,
            max_peaks_right,
        });
    }

    let mut seek_index = Vec::new();
    if version >= 4 {
        let seek_count = read_u32(bytes, &mut offset)? as usize;
        seek_index.reserve(seek_count);
        for _ in 0..seek_count {
            seek_index.push(SeekIndexEntry {
                timestamp: read_u64(bytes, &mut offset)?,
                packet_offset: read_u64(bytes, &mut offset)?,
            });
        }
    }

    if offset != bytes.len() {
        return None;
    }

    Some(WaveformSummary {
        version,
        duration_seconds,
        sample_rate,
        lods,
        seek_index,
    })
}

fn read_exact<const N: usize>(bytes: &[u8], offset: &mut usize) -> Option<[u8; N]> {
    let end = offset.checked_add(N)?;
    let chunk = bytes.get(*offset..end)?;
    let mut array = [0_u8; N];
    array.copy_from_slice(chunk);
    *offset = end;
    Some(array)
}

fn read_u32(bytes: &[u8], offset: &mut usize) -> Option<u32> {
    Some(u32::from_le_bytes(read_exact(bytes, offset)?))
}

fn read_u64(bytes: &[u8], offset: &mut usize) -> Option<u64> {
    Some(u64::from_le_bytes(read_exact(bytes, offset)?))
}

fn read_f32(bytes: &[u8], offset: &mut usize) -> Option<f32> {
    Some(f32::from_le_bytes(read_exact(bytes, offset)?))
}

fn read_f64(bytes: &[u8], offset: &mut usize) -> Option<f64> {
    Some(f64::from_le_bytes(read_exact(bytes, offset)?))
}

/// Accumulator that builds the base-resolution peak data while a file is
/// being decoded. Tracks the left/L channel (or the only channel for mono)
/// in `min_peaks`/`max_peaks`; when `track_right` is true, the right channel
/// is tracked separately in `min_peaks_right`/`max_peaks_right` so the
/// renderer can paint L on top and R on the bottom half of the clip.
struct WaveformBuckets {
    resolution_frames: usize,
    bucket_count: usize,
    min_peaks: Vec<f32>,
    max_peaks: Vec<f32>,
    min_peaks_right: Vec<f32>,
    max_peaks_right: Vec<f32>,
    track_right: bool,
    touched: Vec<bool>,
}

impl WaveformBuckets {
    fn new(frame_count: usize, resolution_frames: usize, track_right: bool) -> Self {
        let bucket_count = frame_count.div_ceil(resolution_frames.max(1)).max(1);

        let right_capacity = if track_right { bucket_count } else { 0 };
        Self {
            resolution_frames: resolution_frames.max(1),
            bucket_count,
            min_peaks: vec![1.0; bucket_count],
            max_peaks: vec![-1.0; bucket_count],
            min_peaks_right: vec![1.0; right_capacity],
            max_peaks_right: vec![-1.0; right_capacity],
            track_right,
            touched: vec![false; bucket_count],
        }
    }

    fn push_frame(&mut self, frame_index: usize, left_sample: f32, right_sample: Option<f32>) {
        if self.bucket_count == 0 {
            return;
        }

        let bucket_index = (frame_index / self.resolution_frames).min(self.bucket_count - 1);
        self.min_peaks[bucket_index] = self.min_peaks[bucket_index].min(left_sample);
        self.max_peaks[bucket_index] = self.max_peaks[bucket_index].max(left_sample);
        if self.track_right {
            if let Some(right) = right_sample {
                self.min_peaks_right[bucket_index] = self.min_peaks_right[bucket_index].min(right);
                self.max_peaks_right[bucket_index] = self.max_peaks_right[bucket_index].max(right);
            }
        }
        self.touched[bucket_index] = true;
    }

    fn finish(mut self) -> WaveformLod {
        self.truncate(self.bucket_count.saturating_mul(self.resolution_frames));
        for bucket_index in 0..self.bucket_count {
            if !self.touched[bucket_index] {
                self.min_peaks[bucket_index] = 0.0;
                self.max_peaks[bucket_index] = 0.0;
                if self.track_right {
                    self.min_peaks_right[bucket_index] = 0.0;
                    self.max_peaks_right[bucket_index] = 0.0;
                }
            }
        }

        WaveformLod {
            resolution_frames: self.resolution_frames,
            min_peaks: self.min_peaks,
            max_peaks: self.max_peaks,
            min_peaks_right: self.min_peaks_right,
            max_peaks_right: self.max_peaks_right,
        }
    }

    fn truncate(&mut self, frame_count: usize) {
        let bucket_count = frame_count.div_ceil(self.resolution_frames.max(1)).max(1);
        if bucket_count < self.bucket_count {
            self.bucket_count = bucket_count;
            self.min_peaks.truncate(bucket_count);
            self.max_peaks.truncate(bucket_count);
            if self.track_right {
                self.min_peaks_right.truncate(bucket_count);
                self.max_peaks_right.truncate(bucket_count);
            }
            self.touched.truncate(bucket_count);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn write_mono_wav(path: &Path, sample_rate: u32, samples: &[i16]) {
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(path, spec).expect("create wav");
        for &sample in samples {
            writer.write_sample(sample).expect("write sample");
        }
        writer.finalize().expect("finalize wav");
    }

    // ── waveform_file_path / cache stem ───────────────────────────────────

    #[test]
    fn waveform_file_path_uses_relative_stem_verbatim() {
        let path = waveform_file_path("C:/songs/demo", "audio/kick.wav");
        let path_str = path.to_string_lossy().replace('\\', "/");
        assert!(path_str.ends_with("cache/waveforms/kick.waveform.ltpeaks"));
    }

    #[test]
    fn waveform_cache_stem_hashes_absolute_paths_to_avoid_collisions() {
        // Absolute paths from different folders sharing a file name must not
        // collide in the cache.
        // Use an OS-absolute path so is_absolute() holds on every platform
        // (Windows needs a drive prefix; Unix accepts a leading slash).
        let (path_a, path_b) = if cfg!(windows) {
            ("C:\\a\\kick.wav", "C:\\b\\kick.wav")
        } else {
            ("/a/kick.wav", "/b/kick.wav")
        };
        let a = waveform_cache_file_stem(Path::new(path_a));
        let b = waveform_cache_file_stem(Path::new(path_b));
        assert!(a.starts_with("kick-"));
        assert!(b.starts_with("kick-"));
        assert_ne!(a, b);
    }

    // ── waveform_summary_from_peaks ───────────────────────────────────────

    #[test]
    fn summary_from_peaks_builds_a_valid_summary() {
        let summary = waveform_summary_from_peaks(
            44_100,
            44_100,
            256,
            vec![-0.5; 172],
            vec![0.5; 172],
        )
        .expect("valid peaks");
        assert_eq!(summary.sample_rate, 44_100);
        assert!((summary.duration_seconds - 1.0).abs() < 1e-9);
        assert_eq!(summary.lods[0].resolution_frames, 256);
        assert!(validate_waveform_summary(&summary, "<test>").is_ok());
    }

    #[test]
    fn summary_from_peaks_rejects_invalid_input() {
        // Zero sample rate, mismatched peak lengths, and empty peaks all fail.
        assert!(waveform_summary_from_peaks(0, 100, 256, vec![0.0], vec![0.0]).is_err());
        assert!(waveform_summary_from_peaks(44_100, 0, 256, vec![0.0], vec![0.0]).is_err());
        assert!(waveform_summary_from_peaks(44_100, 100, 256, vec![0.0], vec![]).is_err());
        assert!(waveform_summary_from_peaks(44_100, 100, 256, vec![], vec![]).is_err());
    }

    // ── LOD pyramid ───────────────────────────────────────────────────────

    #[test]
    fn build_waveform_lods_produces_coarser_levels() {
        let base = WaveformLod {
            resolution_frames: 256,
            min_peaks: vec![-0.2; 4096],
            max_peaks: vec![0.2; 4096],
            min_peaks_right: Vec::new(),
            max_peaks_right: Vec::new(),
        };
        let lods = build_waveform_lods(base);
        assert!(lods.len() > 1);
        for window in lods.windows(2) {
            assert!(window[1].resolution_frames > window[0].resolution_frames);
            assert!(window[1].max_peaks.len() <= window[0].max_peaks.len());
        }
    }

    #[test]
    fn downsample_preserves_the_peak_envelope() {
        let mut min_source = vec![-0.1_f32; 1000];
        let mut max_source = vec![0.1_f32; 1000];
        min_source[500] = -0.9;
        max_source[500] = 0.9;
        let (min_peaks, max_peaks) = downsample_peak_pair(&min_source, &max_source, 100);
        assert_eq!(min_peaks.len(), 10);
        assert!(max_peaks.iter().cloned().fold(f32::MIN, f32::max) >= 0.9);
        assert!(min_peaks.iter().cloned().fold(f32::MAX, f32::min) <= -0.9);
    }

    // ── Binary round-trip ─────────────────────────────────────────────────

    fn sample_summary() -> WaveformSummary {
        waveform_summary_from_peaks(48_000, 48_000, 256, vec![-0.3; 188], vec![0.3; 188])
            .expect("summary")
    }

    #[test]
    fn binary_encode_decode_round_trips() {
        let summary = sample_summary();
        let bytes = encode_waveform_summary_binary(&summary).expect("encode");
        assert_eq!(&bytes[..8], WAVEFORM_FILE_MAGIC);
        let decoded = decode_waveform_summary_binary(&bytes).expect("decode");
        assert_eq!(decoded, summary);
    }

    #[test]
    fn decode_rejects_a_bad_magic_header() {
        let mut bytes = encode_waveform_summary_binary(&sample_summary()).expect("encode");
        bytes[0] = b'X';
        assert!(decode_waveform_summary_binary(&bytes).is_none());
    }

    #[test]
    fn decode_rejects_truncated_bytes() {
        let bytes = encode_waveform_summary_binary(&sample_summary()).expect("encode");
        assert!(decode_waveform_summary_binary(&bytes[..10]).is_none());
    }

    // ── write + load through the filesystem ───────────────────────────────

    #[test]
    fn write_then_load_round_trips_through_disk() {
        let dir = tempdir().expect("tempdir");
        let song_dir = dir.path();
        let summary = sample_summary();
        let path = waveform_file_path(song_dir, "audio/loop.wav");
        write_waveform_summary(&path, &summary).expect("write");
        assert!(path.exists());

        let loaded = load_waveform_summary(song_dir, "audio/loop.wav").expect("load");
        assert_eq!(loaded, summary);
    }

    #[test]
    fn load_errors_when_no_cache_or_legacy_exists() {
        let dir = tempdir().expect("tempdir");
        let result = load_waveform_summary(dir.path(), "audio/missing.wav");
        assert!(result.is_err());
    }

    // ── validate_waveform_summary ─────────────────────────────────────────

    #[test]
    fn validate_rejects_empty_lods_and_old_versions() {
        let mut summary = sample_summary();
        summary.lods.clear();
        assert!(validate_waveform_summary(&summary, "<t>").is_err());

        let mut old = sample_summary();
        old.version = MIN_READABLE_WAVEFORM_FORMAT_VERSION - 1;
        assert!(validate_waveform_summary(&old, "<t>").is_err());
    }

    #[test]
    fn validate_rejects_mismatched_peak_lengths() {
        let mut summary = sample_summary();
        summary.lods[0].min_peaks.pop();
        assert!(validate_waveform_summary(&summary, "<t>").is_err());
    }

    // ── analyze_wav_file (full decode pipeline) ───────────────────────────

    #[test]
    fn analyze_wav_file_reports_duration_and_sample_rate() {
        let dir = tempdir().expect("tempdir");
        let wav_path = dir.path().join("tone.wav");
        // 1 second of a simple ramp at 8 kHz mono.
        let samples: Vec<i16> = (0..8_000)
            .map(|i| ((i as f32 / 8_000.0 - 0.5) * 2.0 * i16::MAX as f32) as i16)
            .collect();
        write_mono_wav(&wav_path, 8_000, &samples);

        let analyzed = analyze_wav_file(&wav_path).expect("analyze");
        assert_eq!(analyzed.sample_rate, 8_000);
        assert_eq!(analyzed.channels, 1);
        assert!((analyzed.duration_seconds - 1.0).abs() < 0.05);
        assert!(!analyzed.waveform.lods.is_empty());
        assert!(validate_waveform_summary(&analyzed.waveform, "<t>").is_ok());
    }
}

