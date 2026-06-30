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
    codecs::{CodecParameters, DecoderOptions, CODEC_TYPE_NULL},
    errors::Error as SymphoniaError,
    formats::FormatOptions,
    io::MediaSourceStream,
    meta::MetadataOptions,
    probe::Hint,
};

use crate::ProjectError;

const WAVEFORM_FORMAT_VERSION: u32 = 6;
const MIN_READABLE_WAVEFORM_FORMAT_VERSION: u32 = 4;
const WAVEFORM_FILE_MAGIC: &[u8; 8] = b"LTPEAKS1";
const WAVEFORM_LOD_RESOLUTIONS: [usize; 4] = [256, 2_048, 16_384, 131_072];
const WAVEFORM_DURATION_MISMATCH_GRACE_SECONDS: f64 = 2.0;
const WAVEFORM_DURATION_MISMATCH_RATIO: f64 = 0.98;

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
    /// Size in bytes of the source audio this waveform was derived from, used to
    /// detect a stale cache when the original file is edited in place. 0 means
    /// "unknown" (a pre-v6 cache that predates freshness tracking).
    #[serde(default)]
    pub source_size: u64,
    /// Source audio mtime in milliseconds since the unix epoch. See `source_size`.
    #[serde(default)]
    pub source_modified_millis: u128,
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

/// Read the freshness signature (size, mtime-millis) of a source audio file.
/// Returns (0, 0) when the file can't be stat'd — callers treat 0 as "unknown",
/// which keeps a cache usable rather than discarding it on a transient stat error.
fn source_freshness(source_path: &Path) -> (u64, u128) {
    let Ok(metadata) = fs::metadata(source_path) else {
        return (0, 0);
    };
    let size = metadata.len();
    let modified_millis = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|delta| delta.as_millis())
        .unwrap_or(0);
    (size, modified_millis)
}

/// Whether a persisted waveform still matches its source audio. A v6+ summary
/// carries the source size+mtime it was built from; if either differs from the
/// file on disk the cache is stale and must be regenerated. We also reject
/// summaries whose decoded duration is clearly shorter than the source metadata
/// duration, which catches MP3 streams Symphonia can probe but only partially
/// decode. Pre-v6 summaries (source_size == 0) carry no signature, so size/mtime
/// cannot prove staleness, but the duration sanity check still applies when the
/// source can be probed.
pub fn is_waveform_fresh(summary: &WaveformSummary, source_path: &Path) -> bool {
    if summary.source_size == 0 && summary.source_modified_millis == 0 {
        return is_waveform_duration_consistent(summary, source_path);
    }
    let (size, modified_millis) = source_freshness(source_path);
    if size == 0 && modified_millis == 0 {
        return true; // can't stat the source right now — don't discard the cache
    }
    summary.source_size == size
        && summary.source_modified_millis == modified_millis
        && is_waveform_duration_consistent(summary, source_path)
}

fn is_waveform_duration_consistent(summary: &WaveformSummary, source_path: &Path) -> bool {
    let Ok(metadata) = crate::importer::read_audio_metadata(source_path) else {
        return true;
    };
    !is_duration_significantly_shorter(summary.duration_seconds, metadata.duration_seconds)
}

fn codec_duration_seconds(codec_params: &CodecParameters) -> Option<f64> {
    if let (Some(n_frames), Some(sample_rate)) = (codec_params.n_frames, codec_params.sample_rate) {
        return Some(n_frames as f64 / f64::from(sample_rate.max(1)));
    }

    if let (Some(n_frames), Some(time_base)) = (codec_params.n_frames, codec_params.time_base) {
        let time = time_base.calc_time(n_frames);
        return Some(time.seconds as f64 + f64::from(time.frac));
    }

    None
}

fn is_duration_significantly_shorter(actual_seconds: f64, expected_seconds: f64) -> bool {
    expected_seconds.is_finite()
        && actual_seconds.is_finite()
        && expected_seconds > 0.0
        && actual_seconds >= 0.0
        && expected_seconds - actual_seconds > WAVEFORM_DURATION_MISMATCH_GRACE_SECONDS
        && actual_seconds < expected_seconds * WAVEFORM_DURATION_MISMATCH_RATIO
}

fn resolve_audio_source_path(song_dir: &Path, audio_path: &Path) -> PathBuf {
    if audio_path.is_absolute() {
        audio_path.to_path_buf()
    } else {
        song_dir.join(audio_path)
    }
}

/// Per-file global waveform cache path: `<cache_root>/waveform-cache/<stem>-<hash>.waveform.ltpeaks`.
/// The hash folds the resolved absolute source path plus its size+mtime, so the
/// same audio reused across projects hits one cache entry, and an edited file
/// (new size/mtime) maps to a different entry — a first line of invalidation on
/// top of the freshness signature embedded inside the file.
pub fn global_waveform_file_path(cache_root: &Path, source_abs_path: &Path) -> PathBuf {
    let (size, modified_millis) = source_freshness(source_abs_path);
    let stem = source_abs_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("waveform");

    let mut hasher = DefaultHasher::new();
    source_abs_path.to_string_lossy().hash(&mut hasher);
    size.hash(&mut hasher);
    modified_millis.hash(&mut hasher);

    cache_root
        .join("waveform-cache")
        .join(format!("{stem}-{:016x}.waveform.ltpeaks", hasher.finish()))
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

pub(crate) fn waveform_cache_file_stem(audio_path: &Path) -> String {
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
    let expected_duration_seconds = codec_duration_seconds(&codec_params);
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
    if expected_duration_seconds
        .is_some_and(|expected| is_duration_significantly_shorter(duration_seconds, expected))
    {
        return Err(ProjectError::AudioDecode(format!(
            "decoded waveform for {} is shorter than the container duration ({duration_seconds:.3}s decoded vs {:.3}s expected)",
            path.display(),
            expected_duration_seconds.unwrap_or_default()
        )));
    }

    let (source_size, source_modified_millis) = source_freshness(path);
    let waveform = WaveformSummary {
        version: WAVEFORM_FORMAT_VERSION,
        duration_seconds,
        sample_rate,
        lods: build_waveform_lods(buckets.finish()),
        seek_index,
        source_size,
        source_modified_millis,
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
    source_path: &Path,
) -> Result<WaveformSummary, ProjectError> {
    waveform_summary_from_channel_peaks(
        sample_rate,
        duration_frames,
        resolution_frames,
        min_peaks,
        max_peaks,
        Vec::new(),
        Vec::new(),
        source_path,
    )
}

pub fn waveform_summary_from_channel_peaks(
    sample_rate: u32,
    duration_frames: u64,
    resolution_frames: usize,
    min_peaks: Vec<f32>,
    max_peaks: Vec<f32>,
    min_peaks_right: Vec<f32>,
    max_peaks_right: Vec<f32>,
    source_path: &Path,
) -> Result<WaveformSummary, ProjectError> {
    if sample_rate == 0
        || duration_frames == 0
        || resolution_frames == 0
        || min_peaks.is_empty()
        || min_peaks.len() != max_peaks.len()
        || (!min_peaks_right.is_empty()
            && (min_peaks_right.len() != min_peaks.len()
                || max_peaks_right.len() != min_peaks.len()))
        || (min_peaks_right.is_empty() && !max_peaks_right.is_empty())
    {
        return Err(ProjectError::InvalidWaveformSummary(
            "<native-waveform>".into(),
        ));
    }

    let base_lod = WaveformLod {
        resolution_frames,
        min_peaks,
        max_peaks,
        min_peaks_right,
        max_peaks_right,
    };
    let (source_size, source_modified_millis) = source_freshness(source_path);
    let summary = WaveformSummary {
        version: WAVEFORM_FORMAT_VERSION,
        duration_seconds: duration_frames as f64 / f64::from(sample_rate),
        sample_rate,
        lods: build_waveform_lods(base_lod),
        seek_index: Vec::new(),
        source_size,
        source_modified_millis,
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
        if summary.version != WAVEFORM_FORMAT_VERSION {
            let summary =
                analyze_wav_file(resolve_audio_source_path(song_dir, audio_relative_path))?
                    .waveform;
            write_waveform_summary(&path, &summary)?;
            return Ok(summary);
        }
        let source_path = resolve_audio_source_path(song_dir, audio_relative_path);
        if !is_waveform_fresh(&summary, &source_path) {
            let summary = analyze_wav_file(source_path)?.waveform;
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

/// Read a decoded `.ltpeaks` from disk and treat it as a miss (Err) when it is
/// either an older format version or stale relative to `source_path`. A v6+ file
/// that is fresh is returned as-is; everything else surfaces as
/// `InvalidWaveformSummary` so callers regenerate.
fn read_fresh_waveform_file(
    path: &Path,
    source_path: &Path,
) -> Result<WaveformSummary, ProjectError> {
    let summary = decode_waveform_summary_binary(&fs::read(path)?)
        .ok_or_else(|| ProjectError::InvalidWaveformSummary(path.to_path_buf()))?;
    if summary.version != WAVEFORM_FORMAT_VERSION || !is_waveform_fresh(&summary, source_path) {
        return Err(ProjectError::InvalidWaveformSummary(path.to_path_buf()));
    }
    validate_waveform_summary(&summary, path)?;
    Ok(summary)
}

/// Migrate a project-local (or package-staged) `.ltpeaks` into the global cache.
/// Unlike the global read, this does NOT require the embedded freshness to match
/// the source mtime: a packaged waveform carries the *origin* machine's mtime,
/// which legitimately differs after copying to another PC. We accept any
/// current-version, structurally-valid summary whose embedded source_size either
/// matches the local file or is unknown (0), then **re-stamp** it with the local
/// source freshness so future fresh-checks pass. Returns None when the legacy
/// file is missing/older/corrupt or clearly belongs to a different audio (size
/// mismatch), so the caller regenerates instead.
fn migrate_legacy_waveform(legacy_path: &Path, source_path: &Path) -> Option<WaveformSummary> {
    if !legacy_path.exists() {
        return None;
    }
    let mut summary = decode_waveform_summary_binary(&fs::read(legacy_path).ok()?)?;
    // A v4/v5 cache is valid waveform data — it just predates the freshness
    // signature. Migrate (and re-stamp) it instead of throwing it away and
    // re-analysing the whole file; only truly unreadable formats (< v4) are
    // regenerated. This is what keeps opening a project with old caches fast.
    if summary.version < MIN_READABLE_WAVEFORM_FORMAT_VERSION
        || summary.version > WAVEFORM_FORMAT_VERSION
    {
        return None;
    }
    if validate_waveform_summary(&summary, legacy_path).is_err() {
        return None;
    }
    // Stamp the current format version so the migrated copy is written as v6.
    summary.version = WAVEFORM_FORMAT_VERSION;
    let (size, modified_millis) = source_freshness(source_path);
    // If we can read the local size and it disagrees with what the cache was
    // built from, it's a different file — don't migrate a mismatched waveform.
    if size != 0 && summary.source_size != 0 && summary.source_size != size {
        return None;
    }
    if !is_waveform_duration_consistent(&summary, source_path) {
        return None;
    }
    // Re-stamp to the local source so the migrated entry is considered fresh.
    summary.source_size = size;
    summary.source_modified_millis = modified_millis;
    Some(summary)
}

/// Load a waveform from the per-file **global** cache, migrating in from a
/// project-local cache when present. Read order:
///   1. `<cache_root>/waveform-cache/…` — if present, current-version and fresh.
///   2. project-local `song_dir/cache/waveforms/…` (legacy/package) — migrate it
///      into the global cache (re-stamping freshness) and use it.
///   3. otherwise analyse the source and write **only** the global cache.
pub fn load_or_generate_global_waveform(
    cache_root: &Path,
    song_dir: &Path,
    audio_relative_path: &Path,
) -> Result<WaveformSummary, ProjectError> {
    let source_path = resolve_audio_source_path(song_dir, audio_relative_path);
    let global_path = global_waveform_file_path(cache_root, &source_path);

    if global_path.exists() {
        if let Ok(summary) = read_fresh_waveform_file(&global_path, &source_path) {
            return Ok(summary);
        }
    }

    let legacy_path = waveform_file_path(song_dir, audio_relative_path);
    if let Some(summary) = migrate_legacy_waveform(&legacy_path, &source_path) {
        write_waveform_summary(&global_path, &summary)?;
        return Ok(summary);
    }

    let summary = analyze_wav_file(&source_path)?.waveform;
    write_waveform_summary(&global_path, &summary)?;
    Ok(summary)
}

/// Read-only counterpart of [`load_or_generate_global_waveform`]: returns the
/// cached summary from the global (or migrated project-local) cache, or an Err
/// when no fresh cache exists. Never analyses the source — use when the caller
/// wants to fall back to a different generation path (e.g. native engine peaks).
pub fn load_global_waveform(
    cache_root: &Path,
    song_dir: &Path,
    audio_relative_path: &Path,
) -> Result<WaveformSummary, ProjectError> {
    let source_path = resolve_audio_source_path(song_dir, audio_relative_path);
    let global_path = global_waveform_file_path(cache_root, &source_path);

    if global_path.exists() {
        if let Ok(summary) = read_fresh_waveform_file(&global_path, &source_path) {
            return Ok(summary);
        }
    }
    let legacy_path = waveform_file_path(song_dir, audio_relative_path);
    if let Some(summary) = migrate_legacy_waveform(&legacy_path, &source_path) {
        write_waveform_summary(&global_path, &summary)?;
        return Ok(summary);
    }
    Err(ProjectError::InvalidWaveformSummary(global_path))
}

/// Persist an externally-built summary (e.g. native engine peaks) into the
/// global per-file cache, returning the path written.
pub fn write_global_waveform(
    cache_root: &Path,
    source_abs_path: &Path,
    summary: &WaveformSummary,
) -> Result<PathBuf, ProjectError> {
    let path = global_waveform_file_path(cache_root, source_abs_path);
    write_waveform_summary(&path, summary)?;
    Ok(path)
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

    let source_path = resolve_audio_source_path(song_dir, audio_relative_path);
    let metadata = analyze_wav_file(&source_path)?;
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

    let (source_size, source_modified_millis) = source_freshness(&source_path);
    let summary = WaveformSummary {
        version: WAVEFORM_FORMAT_VERSION,
        duration_seconds: legacy.duration_seconds,
        sample_rate: metadata.sample_rate,
        lods: build_waveform_lods(base_lod),
        seek_index: Vec::new(),
        source_size,
        source_modified_millis,
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
    // v6+ appends the source-audio freshness signature (size + mtime millis) so a
    // cache can be invalidated when the original file is edited in place.
    bytes.extend_from_slice(&summary.source_size.to_le_bytes());
    bytes.extend_from_slice(&summary.source_modified_millis.to_le_bytes());

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

    let mut source_size = 0u64;
    let mut source_modified_millis = 0u128;
    if version >= 6 {
        source_size = read_u64(bytes, &mut offset)?;
        source_modified_millis = read_u128(bytes, &mut offset)?;
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
        source_size,
        source_modified_millis,
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

fn read_u128(bytes: &[u8], offset: &mut usize) -> Option<u128> {
    Some(u128::from_le_bytes(read_exact(bytes, offset)?))
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
            Path::new("<test-source>"),
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
        let src = Path::new("<test-source>");
        assert!(waveform_summary_from_peaks(0, 100, 256, vec![0.0], vec![0.0], src).is_err());
        assert!(waveform_summary_from_peaks(44_100, 0, 256, vec![0.0], vec![0.0], src).is_err());
        assert!(waveform_summary_from_peaks(44_100, 100, 256, vec![0.0], vec![], src).is_err());
        assert!(waveform_summary_from_peaks(44_100, 100, 256, vec![], vec![], src).is_err());
    }

    #[test]
    fn summary_from_channel_peaks_preserves_stereo() {
        let src = Path::new("<test-source>");
        let summary = waveform_summary_from_channel_peaks(
            44_100,
            512,
            256,
            vec![-0.5, -0.2],
            vec![0.6, 0.3],
            vec![-0.4, -0.1],
            vec![0.7, 0.2],
            src,
        )
        .expect("summary");

        assert_eq!(summary.lods[0].min_peaks_right, vec![-0.4, -0.1]);
        assert_eq!(summary.lods[0].max_peaks_right, vec![0.7, 0.2]);
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
        waveform_summary_from_peaks(
            48_000,
            48_000,
            256,
            vec![-0.3; 188],
            vec![0.3; 188],
            Path::new("<test-source>"),
        )
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

    // ── v6 freshness ──────────────────────────────────────────────────────

    #[test]
    fn v6_round_trip_preserves_source_freshness() {
        let mut summary = sample_summary();
        summary.source_size = 123_456;
        summary.source_modified_millis = 1_700_000_000_000;
        let bytes = encode_waveform_summary_binary(&summary).expect("encode");
        let decoded = decode_waveform_summary_binary(&bytes).expect("decode");
        assert_eq!(decoded.source_size, 123_456);
        assert_eq!(decoded.source_modified_millis, 1_700_000_000_000);
        assert_eq!(decoded, summary);
    }

    #[test]
    fn pre_v6_bytes_decode_with_zeroed_freshness() {
        // A v5 file has no freshness trailer; emulate one by encoding a v6 file
        // and stripping the version down + trimming the trailing 24 bytes
        // (u64 size + u128 mtime). The decoder must accept it with 0/0.
        let mut summary = sample_summary();
        summary.version = 5;
        summary.source_size = 0;
        summary.source_modified_millis = 0;
        // Re-encode at v6 layout but mark version 5 so decode skips the trailer.
        let mut bytes = encode_waveform_summary_binary(&summary).expect("encode");
        // Drop the 24-byte freshness trailer the encoder appended.
        bytes.truncate(bytes.len() - 24);
        // Patch the version field (bytes 8..12) to 5.
        bytes[8..12].copy_from_slice(&5u32.to_le_bytes());
        let decoded = decode_waveform_summary_binary(&bytes).expect("decode v5");
        assert_eq!(decoded.version, 5);
        assert_eq!(decoded.source_size, 0);
        assert_eq!(decoded.source_modified_millis, 0);
    }

    #[test]
    fn is_waveform_fresh_detects_edited_source() {
        let dir = tempdir().expect("tempdir");
        let audio = dir.path().join("tone.wav");
        std::fs::write(&audio, b"first version of the audio bytes").expect("write audio");

        let (size, mtime) = source_freshness(&audio);
        let mut summary = sample_summary();
        summary.source_size = size;
        summary.source_modified_millis = mtime;
        assert!(is_waveform_fresh(&summary, &audio));

        // Rewriting with a different length changes the size → stale.
        std::fs::write(&audio, b"a clearly different and longer audio payload here")
            .expect("rewrite audio");
        assert!(!is_waveform_fresh(&summary, &audio));
    }

    #[test]
    fn is_waveform_fresh_rejects_truncated_waveform_duration() {
        let dir = tempdir().expect("tempdir");
        let audio = dir.path().join("long.wav");
        let samples = vec![0_i16; 80_000];
        write_mono_wav(&audio, 8_000, &samples);

        let summary =
            waveform_summary_from_peaks(8_000, 8_000, 256, vec![-0.1; 32], vec![0.1; 32], &audio)
                .expect("summary");

        assert!(!is_waveform_fresh(&summary, &audio));
    }

    #[test]
    fn legacy_unknown_freshness_is_treated_as_fresh() {
        // source_size == 0 && mtime == 0 → can't prove staleness, keep the cache.
        let summary = sample_summary(); // built with a non-existent path → 0/0
        assert_eq!(summary.source_size, 0);
        assert!(is_waveform_fresh(
            &summary,
            Path::new("/whatever/does/not/exist")
        ));
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
    fn load_waveform_summary_regenerates_future_version_cache() {
        let dir = tempdir().expect("tempdir");
        let song_dir = dir.path();
        let audio_rel = Path::new("audio/loop.wav");
        let audio_abs = song_dir.join(audio_rel);
        let samples = vec![0_i16; 8_000];
        std::fs::create_dir_all(audio_abs.parent().expect("audio parent")).expect("audio dir");
        write_mono_wav(&audio_abs, 8_000, &samples);

        let mut summary = analyze_wav_file(&audio_abs).expect("analyze").waveform;
        summary.version = WAVEFORM_FORMAT_VERSION + 1;
        let path = waveform_file_path(song_dir, audio_rel);
        std::fs::create_dir_all(path.parent().expect("cache parent")).expect("cache dir");
        std::fs::write(
            &path,
            encode_waveform_summary_binary(&summary).expect("encode"),
        )
        .expect("write future cache");

        let loaded = load_waveform_summary(song_dir, audio_rel).expect("load");

        assert_eq!(loaded.version, WAVEFORM_FORMAT_VERSION);
    }

    #[test]
    fn load_errors_when_no_cache_or_legacy_exists() {
        let dir = tempdir().expect("tempdir");
        let result = load_waveform_summary(dir.path(), "audio/missing.wav");
        assert!(result.is_err());
    }

    // ── global per-file cache + lazy migration ────────────────────────────

    #[test]
    fn global_waveform_path_is_stable_per_source_and_under_cache_root() {
        let cache_root = Path::new("/cache/root");
        let source = Path::new("/music/kick.wav");
        let a = global_waveform_file_path(cache_root, source);
        let b = global_waveform_file_path(cache_root, source);
        assert_eq!(a, b);
        assert!(a.starts_with(cache_root.join("waveform-cache")));
        assert!(a.to_string_lossy().ends_with(".waveform.ltpeaks"));
        // A different source yields a different file.
        let other = global_waveform_file_path(cache_root, Path::new("/music/snare.wav"));
        assert_ne!(a, other);
    }

    #[test]
    fn lazy_migration_copies_a_fresh_project_cache_into_the_global_cache() {
        let dir = tempdir().expect("tempdir");
        let song_dir = dir.path().join("song");
        let cache_root = dir.path().join("global");
        std::fs::create_dir_all(&song_dir).expect("song dir");

        // Real audio so freshness + analysis can run.
        let audio_rel = Path::new("kick.wav");
        let audio_abs = song_dir.join(audio_rel);
        let samples: Vec<i16> = (0..4_800).map(|i| ((i % 200) as i16 - 100) * 64).collect();
        write_mono_wav(&audio_abs, 48_000, &samples);

        // Seed a project-local (legacy) cache by generating it the old way.
        let legacy = generate_waveform_summary(&song_dir, audio_rel).expect("legacy gen");
        let legacy_path = waveform_file_path(&song_dir, audio_rel);
        assert!(legacy_path.exists());

        let global_path = global_waveform_file_path(&cache_root, &audio_abs);
        assert!(!global_path.exists());

        // First global load migrates the legacy cache up.
        let migrated =
            load_or_generate_global_waveform(&cache_root, &song_dir, audio_rel).expect("migrate");
        assert_eq!(migrated.sample_rate, legacy.sample_rate);
        assert!(global_path.exists());

        // Second load is served from the global cache (delete legacy to prove it).
        std::fs::remove_file(&legacy_path).expect("rm legacy");
        let from_global =
            load_or_generate_global_waveform(&cache_root, &song_dir, audio_rel).expect("global");
        assert_eq!(from_global.sample_rate, legacy.sample_rate);
    }

    #[test]
    fn legacy_v5_cache_is_migrated_not_regenerated() {
        let dir = tempdir().expect("tempdir");
        let song_dir = dir.path().join("song");
        let cache_root = dir.path().join("global");
        std::fs::create_dir_all(&song_dir).expect("song dir");

        let audio_rel = Path::new("kick.wav");
        let audio_abs = song_dir.join(audio_rel);
        let samples: Vec<i16> = (0..4_800).map(|i| ((i % 200) as i16 - 100) * 64).collect();
        write_mono_wav(&audio_abs, 48_000, &samples);

        // Hand-craft a v5 legacy cache: encode a v6 summary, drop the 24-byte
        // freshness trailer and patch the version field to 5.
        let summary = analyze_wav_file(&audio_abs).expect("analyze").waveform;
        let mut bytes = encode_waveform_summary_binary(&summary).expect("encode");
        bytes.truncate(bytes.len() - 24);
        bytes[8..12].copy_from_slice(&5u32.to_le_bytes());
        let legacy_path = waveform_file_path(&song_dir, audio_rel);
        std::fs::create_dir_all(legacy_path.parent().unwrap()).expect("cache dir");
        std::fs::write(&legacy_path, &bytes).expect("write v5");

        // The read-only loader must migrate the v5 cache (NOT analyse). To prove
        // no analysis happened we delete the audio first: a regeneration would
        // fail to open it, a migration succeeds from the legacy bytes alone.
        std::fs::remove_file(&audio_abs).expect("rm audio");
        let migrated = load_global_waveform(&cache_root, &song_dir, audio_rel)
            .expect("v5 must migrate without re-analysing");
        assert_eq!(migrated.sample_rate, summary.sample_rate);

        // The migrated copy is written to the global cache at the current version.
        let global_path = global_waveform_file_path(&cache_root, &audio_abs);
        assert!(global_path.exists());
        let on_disk =
            decode_waveform_summary_binary(&std::fs::read(&global_path).unwrap()).unwrap();
        assert_eq!(on_disk.version, WAVEFORM_FORMAT_VERSION);
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
