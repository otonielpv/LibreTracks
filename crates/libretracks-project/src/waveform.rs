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

const WAVEFORM_FORMAT_VERSION: u32 = 4;
const WAVEFORM_FILE_MAGIC: &[u8; 8] = b"LTPEAKS1";
const WAVEFORM_LOD_RESOLUTIONS: [usize; 4] = [256, 2_048, 16_384, 131_072];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WaveformLod {
    pub resolution_frames: usize,
    #[serde(default)]
    pub min_peaks: Vec<f32>,
    #[serde(default)]
    pub max_peaks: Vec<f32>,
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
    let mut buckets = WaveformBuckets::new(
        codec_params.n_frames.unwrap_or(sample_rate as u64) as usize,
        WAVEFORM_LOD_RESOLUTIONS[0],
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
            let value = if frame.is_empty() {
                0.0
            } else {
                frame.iter().copied().sum::<f32>() / frame.len() as f32
            };
            buckets.push_frame(frame_index, value.clamp(-1.0, 1.0));
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
        });

    if summary.version < WAVEFORM_FORMAT_VERSION
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
    let mut min_peaks = Vec::with_capacity(source.min_peaks.len().div_ceil(chunk_size));
    let mut max_peaks = Vec::with_capacity(source.max_peaks.len().div_ceil(chunk_size));

    for chunk_start in (0..source.max_peaks.len()).step_by(chunk_size) {
        let chunk_end = (chunk_start + chunk_size).min(source.max_peaks.len());
        let min_peak = source.min_peaks[chunk_start..chunk_end]
            .iter()
            .fold(1.0_f32, |current, value| current.min(*value));
        let max_peak = source.max_peaks[chunk_start..chunk_end]
            .iter()
            .fold(-1.0_f32, |current, value| current.max(*value));
        min_peaks.push(min_peak);
        max_peaks.push(max_peak);
    }

    WaveformLod {
        resolution_frames: target_resolution_frames,
        min_peaks,
        max_peaks,
    }
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

        bytes.extend_from_slice(&(lod.resolution_frames as u64).to_le_bytes());
        bytes.extend_from_slice(&(lod.max_peaks.len() as u32).to_le_bytes());
        for value in &lod.min_peaks {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        for value in &lod.max_peaks {
            bytes.extend_from_slice(&value.to_le_bytes());
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

        lods.push(WaveformLod {
            resolution_frames,
            min_peaks,
            max_peaks,
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

struct WaveformBuckets {
    resolution_frames: usize,
    bucket_count: usize,
    min_peaks: Vec<f32>,
    max_peaks: Vec<f32>,
    touched: Vec<bool>,
}

impl WaveformBuckets {
    fn new(frame_count: usize, resolution_frames: usize) -> Self {
        let bucket_count = frame_count.div_ceil(resolution_frames.max(1)).max(1);

        Self {
            resolution_frames: resolution_frames.max(1),
            bucket_count,
            min_peaks: vec![1.0; bucket_count],
            max_peaks: vec![-1.0; bucket_count],
            touched: vec![false; bucket_count],
        }
    }

    fn push_frame(&mut self, frame_index: usize, sample: f32) {
        if self.bucket_count == 0 {
            return;
        }

        let bucket_index = (frame_index / self.resolution_frames).min(self.bucket_count - 1);
        self.min_peaks[bucket_index] = self.min_peaks[bucket_index].min(sample);
        self.max_peaks[bucket_index] = self.max_peaks[bucket_index].max(sample);
        self.touched[bucket_index] = true;
    }

    fn finish(mut self) -> WaveformLod {
        self.truncate(self.bucket_count.saturating_mul(self.resolution_frames));
        for bucket_index in 0..self.bucket_count {
            if !self.touched[bucket_index] {
                self.min_peaks[bucket_index] = 0.0;
                self.max_peaks[bucket_index] = 0.0;
            }
        }

        WaveformLod {
            resolution_frames: self.resolution_frames,
            min_peaks: self.min_peaks,
            max_peaks: self.max_peaks,
        }
    }

    fn truncate(&mut self, frame_count: usize) {
        let bucket_count = frame_count.div_ceil(self.resolution_frames.max(1)).max(1);
        if bucket_count < self.bucket_count {
            self.bucket_count = bucket_count;
            self.min_peaks.truncate(bucket_count);
            self.max_peaks.truncate(bucket_count);
            self.touched.truncate(bucket_count);
        }
    }
}
