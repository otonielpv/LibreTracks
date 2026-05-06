use super::*;
use libretracks_project::load_waveform_summary;
use memmap2::Mmap;
use rayon::prelude::*;
use rtrb::{Consumer, Producer, RingBuffer};
use std::time::Instant;
use std::{
    collections::HashSet,
    fs::{self, File},
    io::{Read, Write},
    sync::Mutex,
};
use symphonia::core::{
    audio::SampleBuffer,
    codecs::{DecoderOptions, CODEC_TYPE_NULL},
    errors::Error as SymphoniaError,
    formats::{FormatOptions, SeekMode, SeekTo},
    io::MediaSourceStream,
    meta::MetadataOptions,
    probe::Hint,
    units::Time,
};

const STREAM_SECONDS_PER_CLIP: usize = 2;
const STREAM_WORKER_CHUNK_FRAMES: usize = 512;
const STREAM_WORKER_READY_TIMEOUT: Duration = Duration::from_millis(250);
const LTAF_MAGIC: &[u8; 4] = b"LTAF";
const LTAF_VERSION: u32 = 1;
const LTAF_HEADER_LEN: u64 = 64;

#[derive(Debug, Clone, Default)]
pub(crate) struct AudioBufferCacheStats {
    pub cached_buffers: usize,
    pub fully_cached_buffers: usize,
    pub preload_bytes: usize,
    pub prepare_queue_len: usize,
    pub ram_cache_used_mb: usize,
    pub disk_cache_used_mb: usize,
    pub silence_fallback_count: u64,
    pub last_silence_fallback_position: Option<TimelinePosition>,
    pub last_silence_fallback_file: Option<String>,
}

#[derive(Clone, Default)]
pub(crate) struct AudioBufferCache {
    entries: Arc<RwLock<HashMap<PathBuf, Arc<StreamingAudioSource>>>>,
    prepared_audio: PreparedAudioCache,
    hot_entries: Arc<RwLock<HashMap<LegacyPreparedAudioKey, Arc<StreamingAudioSource>>>>,
    prepared_disk_entries: Arc<RwLock<HashMap<LegacyPreparedAudioKey, Arc<StreamingAudioSource>>>>,
    previous_pitch_entries: Arc<RwLock<HashMap<PathBuf, (i32, Arc<StreamingAudioSource>)>>>,
    seek_readiness_maps: Arc<RwLock<HashMap<SongId, SeekReadinessMap>>>,
    prepare_requests: Arc<RwLock<Vec<PrepareRequest>>>,
    silence_fallback: Arc<RwLock<SilenceFallbackTelemetry>>,
}

#[derive(Debug)]
pub(crate) struct StreamingAudioSource {
    file_path: PathBuf,
    sample_rate: u32,
    channels: usize,
    frame_count: usize,
    seek_index: Vec<SeekIndexEntry>,
}

#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct SeekIndexEntry {
    pub timestamp: u64,
    pub packet_offset: u64,
}

pub(crate) type SongId = String;
pub(crate) type TimelinePosition = f64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RegionReadiness {
    ExactRam,
    ExactDisk,
    OriginalRam,
    OriginalDisk,
    Missing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) enum SeekTargetKind {
    CurrentPlayhead,
    RegionStart,
    RegionEnd,
    Marker,
    LoopPoint,
    RecentSeek,
    TimelineIntent,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct SeekTarget {
    pub position: TimelinePosition,
    pub kind: SeekTargetKind,
    pub readiness: RegionReadiness,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RegionReadinessEntry {
    pub region_id: String,
    pub start: TimelinePosition,
    pub end: TimelinePosition,
    pub readiness: RegionReadiness,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct SeekReadinessMap {
    pub song_id: SongId,
    pub hot_targets: Vec<SeekTarget>,
    pub regions: Vec<RegionReadinessEntry>,
    pub last_user_positions: Vec<TimelinePosition>,
}

pub(crate) trait PreparedAudioSource: Send + Sync {
    fn sample_rate(&self) -> u32;
    fn channels(&self) -> usize;
    fn frame_count(&self) -> u64;
    fn read_interleaved_at(&self, source_frame: u64, output: &mut [f32]) -> usize;
    fn alignment_valid(&self) -> bool {
        true
    }
}

#[derive(Debug, Clone)]
pub(crate) struct RawRamSource {
    samples: Arc<[f32]>,
    sample_rate: u32,
    channels: usize,
    frame_count: u64,
}

#[derive(Debug)]
pub(crate) struct RawDiskSource {
    mmap: Arc<Mmap>,
    sample_rate: u32,
    channels: usize,
    frame_count: u64,
    payload_offset: usize,
}

#[derive(Debug, Clone, Default)]
struct SilenceFallbackTelemetry {
    count: u64,
    last_position: Option<TimelinePosition>,
    last_file: Option<String>,
}

#[derive(Debug, Clone)]
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) struct TransposedRamSource {
    inner: RawRamSource,
}

#[derive(Debug, Clone)]
pub(crate) struct SilentSource {
    sample_rate: u32,
    channels: usize,
    frame_count: u64,
}

#[derive(Clone, Hash, Eq, PartialEq, Debug)]
pub(crate) struct PreparedAudioKey {
    pub file_id: String,
    pub file_hash: String,
    pub sample_rate: u32,
    pub channels: usize,
    pub transpose_semitones: i32,
}

#[derive(Clone, Hash, Eq, PartialEq, Debug)]
pub(crate) struct PreparedWindowKey {
    pub audio_key: PreparedAudioKey,
    pub start_frame: u64,
    pub end_frame: u64,
}

#[derive(Clone)]
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) enum PreparedState {
    ReadyRam(Arc<dyn PreparedAudioSource>),
    ReadyDisk(Arc<dyn PreparedAudioSource>),
    Preparing,
    Missing,
    Failed(String),
}

pub(crate) enum SeekSourceDecision {
    ExactRam(Arc<dyn PreparedAudioSource>),
    ExactDisk(Arc<dyn PreparedAudioSource>),
    OriginalRam(Arc<dyn PreparedAudioSource>),
    OriginalDisk(Arc<dyn PreparedAudioSource>),
    PreviousPitch(Arc<dyn PreparedAudioSource>),
    Silence,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SeekSourceKind {
    ExactRam,
    ExactDisk,
    OriginalRam,
    OriginalDisk,
    PreviousPitch,
    Silence,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) enum PreparePriority {
    RealtimeCritical,
    CurrentPlayback,
    HotSeekTarget,
    CurrentSong,
    NextSong,
    Background,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct PrepareRequest {
    pub song_id: SongId,
    pub position: TimelinePosition,
    pub transpose_semitones: i32,
    pub window_seconds: f64,
    pub priority: PreparePriority,
}

#[derive(Debug, Clone, Copy)]
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) struct PrepareWindowConfig {
    pub current_ahead_seconds: f32,
    pub current_behind_seconds: f32,
    pub seek_target_radius_seconds: f32,
    pub hover_radius_seconds: f32,
    pub urgent_window_seconds: f32,
}

impl Default for PrepareWindowConfig {
    fn default() -> Self {
        Self {
            current_ahead_seconds: 30.0,
            current_behind_seconds: 5.0,
            seek_target_radius_seconds: 5.0,
            hover_radius_seconds: 4.0,
            urgent_window_seconds: 5.0,
        }
    }
}

#[derive(Debug, Clone, Copy)]
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) struct RamCacheConfig {
    pub max_mb: usize,
    pub min_free_system_mb: usize,
    pub window_seconds: f32,
}

impl Default for RamCacheConfig {
    fn default() -> Self {
        Self {
            max_mb: 512,
            min_free_system_mb: 512,
            window_seconds: 5.0,
        }
    }
}

#[derive(Debug, Clone)]
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) struct RamWindowEntry {
    key: PreparedWindowKey,
    bytes: usize,
    priority_weight: u8,
    last_used_tick: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct LegacyPreparedAudioKey {
    file_path: PathBuf,
    transpose_semitones: i32,
}

#[cfg_attr(not(test), allow(dead_code))]
pub(crate) struct StreamingClipReader {
    shared_source: Arc<StreamingAudioSource>,
    consumer: Consumer<ClipSample>,
    command_sender: Sender<StreamingWorkerCommand>,
    output_sample_rate: u32,
    current_generation: u64,
    current_source_start_frame: usize,
    emitted_frames: usize,
    total_output_frames: usize,
    declick_fade_frames: usize,
    declick_frames_remaining: usize,
    pub(crate) eof: bool,
}

#[derive(Clone, Copy)]
struct ClipSample {
    generation: u64,
    value: f32,
}

#[cfg_attr(not(test), allow(dead_code))]
enum StreamingWorkerCommand {
    Seek {
        target_start_seconds: f64,
        generation: u64,
    },
    Shutdown,
}

enum WorkerReadyState {
    Ready,
    Finished,
}

impl StreamingAudioSource {
    pub(crate) fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    pub(crate) fn channels(&self) -> usize {
        self.channels
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn preload_frame_count(&self) -> usize {
        self.frame_count
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn is_fully_cached(&self) -> bool {
        false
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn has_mapped_audio(&self) -> bool {
        false
    }

    #[cfg(test)]
    pub(crate) fn from_preloaded(
        preload_samples: Vec<f32>,
        sample_rate: u32,
        channels: usize,
        _fully_cached: bool,
    ) -> Self {
        let temp_path = std::env::temp_dir().join(format!(
            "libretracks-test-source-{}-{}.wav",
            std::process::id(),
            randomish_id()
        ));
        write_test_wav(&temp_path, &preload_samples, sample_rate, channels)
            .expect("test wav should be writable");
        Self {
            file_path: temp_path,
            sample_rate: sample_rate.max(1),
            channels: channels.max(1),
            frame_count: preload_samples.len() / channels.max(1),
            seek_index: Vec::new(),
        }
    }

    fn preload_bytes(&self) -> usize {
        self.frame_count
            .saturating_mul(self.channels)
            .saturating_mul(size_of::<f32>())
    }

    #[cfg(test)]
    pub(crate) fn read_preloaded_sample_for_test(
        &self,
        frame_index: usize,
        channel: usize,
        output_channels: usize,
    ) -> f32 {
        decode_file_region(
            &self.file_path,
            self.sample_rate,
            self.channels,
            frame_index as f64 / f64::from(self.sample_rate.max(1)),
            1,
        )
        .ok()
        .and_then(|samples| {
            let source_channel = if output_channels == 1 && self.channels > 1 {
                return Some((samples[0] + samples[1.min(samples.len() - 1)]) * 0.5);
            } else if self.channels == 1 {
                0
            } else {
                channel.min(self.channels - 1)
            };
            samples.get(source_channel).copied()
        })
        .unwrap_or(0.0)
    }
}

impl PreparedAudioSource for StreamingAudioSource {
    fn sample_rate(&self) -> u32 {
        self.sample_rate()
    }

    fn channels(&self) -> usize {
        self.channels()
    }

    fn frame_count(&self) -> u64 {
        self.frame_count as u64
    }

    fn read_interleaved_at(&self, _source_frame: u64, _output: &mut [f32]) -> usize {
        0
    }
}

impl RawRamSource {
    pub(crate) fn new(samples: Vec<f32>, sample_rate: u32, channels: usize) -> Self {
        let channels = channels.max(1);
        let frame_count = (samples.len() / channels) as u64;
        Self {
            samples: Arc::from(samples),
            sample_rate: sample_rate.max(1),
            channels,
            frame_count,
        }
    }
}

impl PreparedAudioSource for RawRamSource {
    fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    fn channels(&self) -> usize {
        self.channels
    }

    fn frame_count(&self) -> u64 {
        self.frame_count
    }

    fn read_interleaved_at(&self, source_frame: u64, output: &mut [f32]) -> usize {
        let channels = self.channels.max(1);
        let requested_frames = output.len() / channels;
        if requested_frames == 0 || source_frame >= self.frame_count {
            return 0;
        }

        let available_frames = (self.frame_count - source_frame) as usize;
        let frames_to_copy = requested_frames.min(available_frames);
        let source_start = source_frame as usize * channels;
        let sample_count = frames_to_copy * channels;
        output[..sample_count]
            .copy_from_slice(&self.samples[source_start..source_start + sample_count]);
        frames_to_copy
    }
}

impl RawDiskSource {
    pub(crate) fn open_ltaf(path: &Path) -> Result<Self, String> {
        let mut header_file = File::open(path).map_err(|error| error.to_string())?;
        let mut header = [0_u8; LTAF_HEADER_LEN as usize];
        header_file
            .read_exact(&mut header)
            .map_err(|error| error.to_string())?;
        if &header[0..4] != LTAF_MAGIC {
            return Err("invalid LTAF magic".to_string());
        }

        let version = u32::from_le_bytes(header[4..8].try_into().expect("version bytes"));
        if version != LTAF_VERSION {
            return Err(format!("unsupported LTAF version: {version}"));
        }

        let sample_rate = u32::from_le_bytes(header[8..12].try_into().expect("sample rate bytes"));
        let channels =
            u32::from_le_bytes(header[12..16].try_into().expect("channel bytes")) as usize;
        let frame_count = u64::from_le_bytes(header[16..24].try_into().expect("frame count bytes"));
        let file = File::open(path).map_err(|error| error.to_string())?;
        let mmap = unsafe { Mmap::map(&file).map_err(|error| error.to_string())? };

        Ok(Self {
            mmap: Arc::new(mmap),
            sample_rate: sample_rate.max(1),
            channels: channels.max(1),
            frame_count,
            payload_offset: LTAF_HEADER_LEN as usize,
        })
    }

    #[cfg(test)]
    pub(crate) fn write_ltaf_for_test(
        path: &Path,
        samples: &[f32],
        sample_rate: u32,
        channels: usize,
    ) -> Result<(), String> {
        write_ltaf_file(path, samples, sample_rate, channels)
    }
}

impl PreparedAudioSource for RawDiskSource {
    fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    fn channels(&self) -> usize {
        self.channels
    }

    fn frame_count(&self) -> u64 {
        self.frame_count
    }

    fn read_interleaved_at(&self, source_frame: u64, output: &mut [f32]) -> usize {
        let channels = self.channels.max(1);
        let requested_frames = output.len() / channels;
        if requested_frames == 0 || source_frame >= self.frame_count {
            return 0;
        }

        let frames_to_read = requested_frames.min((self.frame_count - source_frame) as usize);
        let sample_count = frames_to_read * channels;
        let byte_offset = self.payload_offset.saturating_add(
            (source_frame as usize)
                .saturating_mul(channels)
                .saturating_mul(size_of::<f32>()),
        );
        let byte_count = sample_count.saturating_mul(size_of::<f32>());
        let Some(bytes) = self
            .mmap
            .get(byte_offset..byte_offset.saturating_add(byte_count))
        else {
            return 0;
        };
        let frames_read = (bytes.len() / size_of::<f32>() / channels).min(frames_to_read);
        for sample_index in 0..(frames_read * channels) {
            let byte_index = sample_index * 4;
            output[sample_index] = f32::from_le_bytes(
                bytes[byte_index..byte_index + 4]
                    .try_into()
                    .expect("sample bytes"),
            );
        }
        frames_read
    }
}

impl TransposedRamSource {
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn new(samples: Vec<f32>, sample_rate: u32, channels: usize) -> Self {
        Self {
            inner: RawRamSource::new(samples, sample_rate, channels),
        }
    }
}

impl PreparedAudioSource for TransposedRamSource {
    fn sample_rate(&self) -> u32 {
        self.inner.sample_rate()
    }

    fn channels(&self) -> usize {
        self.inner.channels()
    }

    fn frame_count(&self) -> u64 {
        self.inner.frame_count()
    }

    fn read_interleaved_at(&self, source_frame: u64, output: &mut [f32]) -> usize {
        self.inner.read_interleaved_at(source_frame, output)
    }
}

impl SilentSource {
    pub(crate) fn new(sample_rate: u32, channels: usize, frame_count: u64) -> Self {
        Self {
            sample_rate: sample_rate.max(1),
            channels: channels.max(1),
            frame_count,
        }
    }
}

impl PreparedAudioSource for SilentSource {
    fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    fn channels(&self) -> usize {
        self.channels
    }

    fn frame_count(&self) -> u64 {
        self.frame_count
    }

    fn read_interleaved_at(&self, source_frame: u64, output: &mut [f32]) -> usize {
        if source_frame >= self.frame_count {
            return 0;
        }
        let frames =
            (output.len() / self.channels.max(1)).min((self.frame_count - source_frame) as usize);
        output[..frames * self.channels.max(1)].fill(0.0);
        frames
    }
}

impl SeekSourceDecision {
    pub(crate) fn source(&self) -> Option<&dyn PreparedAudioSource> {
        match self {
            Self::ExactRam(source)
            | Self::ExactDisk(source)
            | Self::OriginalRam(source)
            | Self::OriginalDisk(source)
            | Self::PreviousPitch(source) => Some(source.as_ref()),
            Self::Silence => None,
        }
    }

    pub(crate) fn kind(&self) -> SeekSourceKind {
        match self {
            Self::ExactRam(_) => SeekSourceKind::ExactRam,
            Self::ExactDisk(_) => SeekSourceKind::ExactDisk,
            Self::OriginalRam(_) => SeekSourceKind::OriginalRam,
            Self::OriginalDisk(_) => SeekSourceKind::OriginalDisk,
            Self::PreviousPitch(_) => SeekSourceKind::PreviousPitch,
            Self::Silence => SeekSourceKind::Silence,
        }
    }

    pub(crate) fn used_fallback(&self, required_transpose: i32) -> bool {
        let _ = required_transpose;
        !matches!(self, Self::ExactRam(_) | Self::ExactDisk(_))
    }
}

#[derive(Clone)]
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) struct PreparedAudioCache {
    states: Arc<RwLock<HashMap<PreparedAudioKey, PreparedState>>>,
    previous_pitch: Arc<RwLock<HashMap<String, Arc<dyn PreparedAudioSource>>>>,
    ram_windows: Arc<RwLock<HashMap<PreparedWindowKey, RamWindowEntry>>>,
    active_renders: Arc<Mutex<HashSet<PreparedAudioKey>>>,
    prepare_queue: Arc<RwLock<Vec<PrepareRequest>>>,
    tick: Arc<AtomicU64>,
    ram_config: RamCacheConfig,
    silent_source: Arc<SilentSource>,
}

impl Default for PreparedAudioCache {
    fn default() -> Self {
        Self {
            states: Arc::new(RwLock::new(HashMap::new())),
            previous_pitch: Arc::new(RwLock::new(HashMap::new())),
            ram_windows: Arc::new(RwLock::new(HashMap::new())),
            active_renders: Arc::new(Mutex::new(HashSet::new())),
            prepare_queue: Arc::new(RwLock::new(Vec::new())),
            tick: Arc::new(AtomicU64::new(0)),
            ram_config: RamCacheConfig::default(),
            silent_source: Arc::new(SilentSource::new(48_000, 2, u64::MAX)),
        }
    }
}

impl PreparedAudioCache {
    pub(crate) fn get_exact(
        &self,
        key: &PreparedAudioKey,
        frame: u64,
    ) -> Option<Arc<dyn PreparedAudioSource>> {
        let states = self.states.try_read().ok()?;
        let state = states.get(key)?;
        let source = match state {
            PreparedState::ReadyRam(source) | PreparedState::ReadyDisk(source) => source.clone(),
            PreparedState::Preparing | PreparedState::Missing | PreparedState::Failed(_) => {
                return None
            }
        };
        (frame < source.frame_count()).then_some(source)
    }

    pub(crate) fn get_original(
        &self,
        key: &PreparedAudioKey,
        frame: u64,
    ) -> Option<Arc<dyn PreparedAudioSource>> {
        let original_key = PreparedAudioKey {
            transpose_semitones: 0,
            ..key.clone()
        };
        self.get_exact(&original_key, frame)
    }

    pub(crate) fn get_best_available(
        &self,
        key: &PreparedAudioKey,
        frame: u64,
    ) -> SeekSourceDecision {
        if audio_safe_mode_enabled() {
            if let Some(source) = self.get_original(key, frame) {
                return match self.state_kind(&PreparedAudioKey {
                    transpose_semitones: 0,
                    ..key.clone()
                }) {
                    Some(SeekSourceKind::ExactDisk) => SeekSourceDecision::OriginalDisk(source),
                    _ => SeekSourceDecision::OriginalRam(source),
                };
            }
            return SeekSourceDecision::Silence;
        }

        if let Some(source) = self.get_exact(key, frame) {
            return match self.state_kind(key) {
                Some(SeekSourceKind::ExactDisk) => SeekSourceDecision::ExactDisk(source),
                _ => SeekSourceDecision::ExactRam(source),
            };
        }

        if key.transpose_semitones != 0 {
            return SeekSourceDecision::Silence;
        }

        if let Some(source) = self.get_original(key, frame) {
            return match self.state_kind(&PreparedAudioKey {
                transpose_semitones: 0,
                ..key.clone()
            }) {
                Some(SeekSourceKind::ExactDisk) => SeekSourceDecision::OriginalDisk(source),
                _ => SeekSourceDecision::OriginalRam(source),
            };
        }

        if let Ok(previous_pitch) = self.previous_pitch.try_read() {
            if let Some(source) = previous_pitch.get(&key.file_id).cloned() {
                if frame < source.frame_count() {
                    return SeekSourceDecision::PreviousPitch(source);
                }
            }
        }

        SeekSourceDecision::Silence
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn mark_preparing(&self, key: PreparedAudioKey) {
        if let Ok(mut states) = self.states.write() {
            states.insert(key, PreparedState::Preparing);
        }
    }

    pub(crate) fn insert_ready_ram(
        &self,
        key: PreparedAudioKey,
        source: Arc<dyn PreparedAudioSource>,
    ) -> Result<(), String> {
        validate_prepared_key_matches_source(&key, source.as_ref())?;
        if key.transpose_semitones != 0 {
            if let Ok(mut previous_pitch) = self.previous_pitch.write() {
                previous_pitch.insert(key.file_id.clone(), source.clone());
            }
        }
        if let Ok(mut states) = self.states.write() {
            states.insert(key, PreparedState::ReadyRam(source));
        }
        Ok(())
    }

    pub(crate) fn insert_ready_disk(
        &self,
        key: PreparedAudioKey,
        source: Arc<dyn PreparedAudioSource>,
    ) -> Result<(), String> {
        validate_prepared_key_matches_source(&key, source.as_ref())?;
        if key.transpose_semitones != 0 {
            if let Ok(mut previous_pitch) = self.previous_pitch.write() {
                previous_pitch.insert(key.file_id.clone(), source.clone());
            }
        }
        if let Ok(mut states) = self.states.write() {
            states.insert(key, PreparedState::ReadyDisk(source));
        }
        Ok(())
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn insert_missing(&self, key: PreparedAudioKey) {
        if let Ok(mut states) = self.states.write() {
            states.insert(key, PreparedState::Missing);
        }
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn insert_failed(&self, key: PreparedAudioKey, error: String) {
        if let Ok(mut states) = self.states.write() {
            states.insert(key, PreparedState::Failed(error));
        }
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn request_prepare(&self, request: PrepareRequest) {
        if let Ok(mut queue) = self.prepare_queue.write() {
            queue.push(request);
            queue.sort_by_key(|request| prepare_priority_rank(request.priority));
            const MAX_PREPARE_QUEUE: usize = 512;
            if queue.len() > MAX_PREPARE_QUEUE {
                queue.truncate(MAX_PREPARE_QUEUE);
            }
        }
    }

    pub(crate) fn prepare_queue_len(&self) -> usize {
        self.prepare_queue
            .try_read()
            .map(|queue| queue.len())
            .unwrap_or_default()
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn insert_ram_window(
        &self,
        key: PreparedWindowKey,
        bytes: usize,
        priority_weight: u8,
    ) {
        let tick = self.tick.fetch_add(1, Ordering::AcqRel).saturating_add(1);
        if let Ok(mut windows) = self.ram_windows.write() {
            windows.insert(
                key.clone(),
                RamWindowEntry {
                    key,
                    bytes,
                    priority_weight,
                    last_used_tick: tick,
                },
            );
            self.evict_ram_windows_locked(&mut windows);
        }
    }

    pub(crate) fn ram_cache_used_mb(&self) -> usize {
        self.ram_windows
            .try_read()
            .map(|windows| windows.values().map(|entry| entry.bytes).sum::<usize>() / (1024 * 1024))
            .unwrap_or_default()
    }

    #[cfg_attr(not(test), allow(dead_code))]
    fn evict_ram_windows_locked(&self, windows: &mut HashMap<PreparedWindowKey, RamWindowEntry>) {
        let max_bytes = self.ram_config.max_mb.saturating_mul(1024 * 1024);
        while windows.values().map(|entry| entry.bytes).sum::<usize>() > max_bytes {
            let Some(victim_key) = windows
                .values()
                .filter(|entry| entry.priority_weight < 90)
                .min_by_key(|entry| (entry.priority_weight, entry.last_used_tick))
                .map(|entry| entry.key.clone())
            else {
                break;
            };
            windows.remove(&victim_key);
        }
    }

    pub(crate) fn source_or_silence(
        &self,
        decision: &SeekSourceDecision,
    ) -> Arc<dyn PreparedAudioSource> {
        match decision {
            SeekSourceDecision::ExactRam(source)
            | SeekSourceDecision::ExactDisk(source)
            | SeekSourceDecision::OriginalRam(source)
            | SeekSourceDecision::OriginalDisk(source)
            | SeekSourceDecision::PreviousPitch(source) => source.clone(),
            SeekSourceDecision::Silence => self.silent_source.clone(),
        }
    }

    fn state_kind(&self, key: &PreparedAudioKey) -> Option<SeekSourceKind> {
        let states = self.states.try_read().ok()?;
        let state = states.get(key).or_else(|| {
            states.iter().find_map(|(candidate_key, state)| {
                (candidate_key.file_id == key.file_id
                    && candidate_key.file_hash == key.file_hash
                    && candidate_key.transpose_semitones == key.transpose_semitones)
                    .then_some(state)
            })
        })?;
        match state {
            PreparedState::ReadyRam(_) => Some(SeekSourceKind::ExactRam),
            PreparedState::ReadyDisk(_) => Some(SeekSourceKind::ExactDisk),
            PreparedState::Preparing | PreparedState::Missing | PreparedState::Failed(_) => None,
        }
    }
}

#[derive(Clone)]
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) struct AudioPrepareManager {
    cache: PreparedAudioCache,
    window_config: PrepareWindowConfig,
}

impl AudioPrepareManager {
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn new(cache: PreparedAudioCache) -> Self {
        Self {
            cache,
            window_config: PrepareWindowConfig::default(),
        }
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn request_urgent_window(
        &self,
        song_id: SongId,
        position: TimelinePosition,
        transpose_semitones: i32,
    ) {
        self.cache.request_prepare(PrepareRequest {
            song_id,
            position,
            transpose_semitones,
            window_seconds: f64::from(self.window_config.urgent_window_seconds),
            priority: PreparePriority::RealtimeCritical,
        });
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn request_current_playback_window(
        &self,
        song_id: SongId,
        position: TimelinePosition,
        transpose_semitones: i32,
    ) {
        self.cache.request_prepare(PrepareRequest {
            song_id,
            position,
            transpose_semitones,
            window_seconds: f64::from(self.window_config.current_ahead_seconds),
            priority: PreparePriority::CurrentPlayback,
        });
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn queue_len(&self) -> usize {
        self.cache.prepare_queue_len()
    }
}

pub(crate) fn render_transposed_to_cache(
    raw_source: Arc<dyn PreparedAudioSource>,
    key: PreparedAudioKey,
    output_path: PathBuf,
) -> Result<Arc<dyn PreparedAudioSource>, String> {
    validate_prepared_key_matches_source(&key, raw_source.as_ref())?;
    if key.transpose_semitones == 0 || audio_safe_mode_enabled() {
        return Ok(raw_source);
    }
    if !prepared_pitch_render_enabled() {
        return Err("prepared pitch render is temporarily disabled".to_string());
    }
    let rendered =
        render_pitch_shift_offline_aligned(raw_source.as_ref(), key.transpose_semitones)?;
    write_ltaf_file(
        &output_path,
        &rendered.samples,
        rendered.sample_rate,
        rendered.channels,
    )?;
    let disk_source = Arc::new(RawDiskSource::open_ltaf(&output_path)?);
    validate_prepared_key_matches_source(&key, disk_source.as_ref())?;
    Ok(disk_source)
}

struct OfflinePitchRender {
    samples: Vec<f32>,
    sample_rate: u32,
    channels: usize,
}

fn render_pitch_shift_offline_aligned(
    raw_source: &dyn PreparedAudioSource,
    transpose_semitones: i32,
) -> Result<OfflinePitchRender, String> {
    let channels = raw_source.channels().max(1);
    let sample_rate = raw_source.sample_rate().max(1);
    let frame_count = raw_source.frame_count() as usize;
    let mut pitch_engine =
        pitch::create_pitch_shift_engine(sample_rate, channels, transpose_semitones);
    let block_frames = STREAM_WORKER_CHUNK_FRAMES;
    let mut rendered = Vec::with_capacity(frame_count.saturating_mul(channels));
    let mut source_frame = 0_u64;

    pitch_engine.reset();
    pitch_engine
        .prepare_for_aligned_output()
        .map_err(|error| format!("pitch alignment failed: {error:?}"))?;

    while source_frame < raw_source.frame_count() {
        let frames = block_frames.min((raw_source.frame_count() - source_frame) as usize);
        let mut input = vec![0.0_f32; frames * channels];
        let frames_read = raw_source.read_interleaved_at(source_frame, &mut input);
        if frames_read == 0 {
            break;
        }
        input.truncate(frames_read * channels);
        let mut output = vec![0.0_f32; input.len()];
        pitch_engine
            .process_realtime_block(&input, &mut output)
            .map_err(|error| format!("pitch render failed: {error:?}"))?;
        rendered.extend_from_slice(&output);
        source_frame = source_frame.saturating_add(frames_read as u64);
    }

    let wanted_samples = frame_count.saturating_mul(channels);
    if rendered.len() > wanted_samples {
        rendered.truncate(wanted_samples);
    } else if rendered.len() < wanted_samples {
        rendered.resize(wanted_samples, 0.0);
    }
    validate_rendered_samples(&rendered)?;

    Ok(OfflinePitchRender {
        samples: rendered,
        sample_rate,
        channels,
    })
}

impl AudioBufferCache {
    pub(crate) fn prepared_audio(&self) -> PreparedAudioCache {
        self.prepared_audio.clone()
    }

    #[cfg(test)]
    pub(crate) fn insert_for_test(&self, file_path: PathBuf, source: StreamingAudioSource) {
        self.entries
            .write()
            .expect("audio cache should lock")
            .insert(file_path, Arc::new(source));
    }

    #[cfg(test)]
    pub(crate) fn insert_prepared_ram_for_test(
        &self,
        key: PreparedAudioKey,
        source: Arc<dyn PreparedAudioSource>,
    ) {
        self.prepared_audio
            .insert_ready_ram(key, source)
            .expect("prepared test source should match key");
    }

    #[cfg(test)]
    pub(crate) fn insert_hot_for_test(
        &self,
        file_path: PathBuf,
        transpose_semitones: i32,
        source: StreamingAudioSource,
    ) {
        self.hot_entries
            .write()
            .expect("audio hot cache should lock")
            .insert(
                LegacyPreparedAudioKey {
                    file_path,
                    transpose_semitones,
                },
                Arc::new(source),
            );
    }

    #[cfg(test)]
    pub(crate) fn insert_prepared_disk_for_test(
        &self,
        file_path: PathBuf,
        transpose_semitones: i32,
        source: StreamingAudioSource,
    ) {
        self.prepared_disk_entries
            .write()
            .expect("prepared disk cache should lock")
            .insert(
                LegacyPreparedAudioKey {
                    file_path,
                    transpose_semitones,
                },
                Arc::new(source),
            );
    }

    #[cfg(test)]
    pub(crate) fn insert_previous_pitch_for_test(
        &self,
        file_path: PathBuf,
        transpose_semitones: i32,
        source: StreamingAudioSource,
    ) {
        self.previous_pitch_entries
            .write()
            .expect("previous pitch cache should lock")
            .insert(file_path, (transpose_semitones, Arc::new(source)));
    }

    pub(crate) fn replace_song_buffers(&self, song_dir: &Path, song: &Song) -> Result<(), String> {
        let mut unique_paths = Vec::new();
        let mut seen_paths = HashSet::new();

        for clip in &song.clips {
            let file_path = resolve_clip_audio_path(song_dir, &clip.file_path);
            if seen_paths.insert(file_path.clone()) {
                unique_paths.push((file_path, clip.file_path.clone()));
            }
        }

        unique_paths.sort_by(|left, right| left.0.cmp(&right.0));

        let existing_entries = self
            .entries
            .read()
            .map_err(|_| "audio buffer cache lock poisoned".to_string())?;
        let mut next_entries = HashMap::with_capacity(unique_paths.len());
        let mut missing_paths = Vec::new();

        for (file_path, waveform_key) in unique_paths {
            if let Some(buffer) = existing_entries.get(&file_path) {
                next_entries.insert(file_path.clone(), Arc::clone(buffer));
            } else {
                missing_paths.push((file_path, waveform_key));
            }
        }

        drop(existing_entries);

        let prepared_entries = missing_paths
            .into_par_iter()
            .map(|(file_path, waveform_key)| {
                let mut source = prepare_audio_source(&file_path).map_err(|error| {
                    format!(
                        "failed to prepare original audio {}: {error}",
                        file_path.display()
                    )
                })?;
                if let Ok(summary) = load_waveform_summary(song_dir, &waveform_key) {
                    source.seek_index = summary
                        .seek_index
                        .into_iter()
                        .map(|entry| SeekIndexEntry {
                            timestamp: entry.timestamp,
                            packet_offset: entry.packet_offset,
                        })
                        .collect();
                }
                let original_source = decode_original_to_engine_ram(&source, 48_000, 2)?;
                Ok::<_, String>((file_path, Arc::new(source), Arc::new(original_source)))
            })
            .collect::<Result<Vec<_>, _>>()?;

        for (file_path, prepared_source, original_source) in prepared_entries {
            self.insert_original_prepared_source(&file_path, original_source)?;
            next_entries.insert(file_path, prepared_source);
        }

        for file_path in next_entries.keys() {
            self.ensure_original_prepared_source(file_path)?;
        }

        let mut entries = self
            .entries
            .write()
            .map_err(|_| "audio buffer cache lock poisoned".to_string())?;
        *entries = next_entries;
        self.rebuild_seek_readiness_map(song_dir, song, 0.0);

        Ok(())
    }

    fn ensure_original_prepared_source(&self, file_path: &Path) -> Result<(), String> {
        let key = PreparedAudioKey {
            file_id: file_path.to_string_lossy().to_string(),
            file_hash: file_path.to_string_lossy().to_string(),
            sample_rate: 48_000,
            channels: 2,
            transpose_semitones: 0,
        };
        if self.prepared_audio.get_original(&key, 0).is_some() {
            return Ok(());
        }
        let source = self
            .entries
            .read()
            .map_err(|_| "audio buffer cache lock poisoned".to_string())?
            .get(file_path)
            .cloned()
            .ok_or_else(|| format!("audio source is not prepared: {}", file_path.display()))?;
        let original_source = Arc::new(decode_original_to_engine_ram(&source, 48_000, 2)?);
        self.insert_original_prepared_source(file_path, original_source)?;
        Ok(())
    }

    fn insert_original_prepared_source(
        &self,
        file_path: &Path,
        source: Arc<dyn PreparedAudioSource>,
    ) -> Result<(), String> {
        let key = PreparedAudioKey {
            file_id: file_path.to_string_lossy().to_string(),
            file_hash: file_path.to_string_lossy().to_string(),
            sample_rate: 48_000,
            channels: 2,
            transpose_semitones: 0,
        };
        self.prepared_audio.insert_ready_ram(key, source)
    }

    pub(crate) fn get(
        &self,
        file_path: &Path,
    ) -> Result<Option<Arc<StreamingAudioSource>>, String> {
        let entries = self
            .entries
            .read()
            .map_err(|_| "audio buffer cache lock poisoned".to_string())?;
        Ok(entries.get(file_path).cloned())
    }

    pub(crate) fn get_best_source_for_seek(
        &self,
        song_dir: &Path,
        song: &Song,
        position: TimelinePosition,
        required_transpose: i32,
    ) -> SeekSourceDecision {
        let required_transpose = if audio_safe_mode_enabled() {
            0
        } else {
            required_transpose
        };
        let Some(plan) = mixer::build_playback_plans(song_dir, song, 48_000)
            .into_iter()
            .find(|plan| {
                let position_frame = seconds_to_frames(position, 48_000);
                position_frame >= plan.timeline_start_frame
                    && position_frame < plan.timeline_end_frame()
            })
        else {
            return SeekSourceDecision::Silence;
        };

        let exact_key = LegacyPreparedAudioKey {
            file_path: plan.file_path.clone(),
            transpose_semitones: required_transpose,
        };
        let prepared_key = PreparedAudioKey {
            file_id: plan.file_path.to_string_lossy().to_string(),
            file_hash: plan.file_path.to_string_lossy().to_string(),
            sample_rate: 48_000,
            channels: 2,
            transpose_semitones: required_transpose,
        };
        let prepared_decision = self.prepared_audio.get_best_available(&prepared_key, 0);
        if !matches!(prepared_decision, SeekSourceDecision::Silence) {
            return prepared_decision;
        }
        if let Ok(hot_entries) = self.hot_entries.try_read() {
            if let Some(source) = hot_entries.get(&exact_key).cloned() {
                return SeekSourceDecision::ExactRam(source);
            }
        }

        if required_transpose == 0 {
            if let Ok(entries) = self.entries.try_read() {
                if let Some(source) = entries.get(&plan.file_path).cloned() {
                    return SeekSourceDecision::ExactDisk(source);
                }
            }
        }
        if let Ok(prepared_disk_entries) = self.prepared_disk_entries.try_read() {
            if let Some(source) = prepared_disk_entries.get(&exact_key).cloned() {
                return SeekSourceDecision::ExactDisk(source);
            }
        }

        let original_key = LegacyPreparedAudioKey {
            file_path: plan.file_path.clone(),
            transpose_semitones: 0,
        };
        if let Ok(hot_entries) = self.hot_entries.try_read() {
            if let Some(source) = hot_entries.get(&original_key).cloned() {
                return SeekSourceDecision::OriginalRam(source);
            }
        }

        if let Ok(entries) = self.entries.try_read() {
            if let Some(source) = entries.get(&plan.file_path).cloned() {
                return SeekSourceDecision::OriginalDisk(source);
            }
        }

        if let Ok(previous_pitch_entries) = self.previous_pitch_entries.try_read() {
            if let Some((_transpose, source)) = previous_pitch_entries.get(&plan.file_path).cloned()
            {
                return SeekSourceDecision::PreviousPitch(source);
            }
        }

        SeekSourceDecision::Silence
    }

    pub(crate) fn record_recent_seek_and_reprioritize(
        &self,
        song_dir: &Path,
        song: &Song,
        position: TimelinePosition,
        required_transpose: i32,
    ) {
        self.push_prepare_request(PrepareRequest {
            song_id: song.id.clone(),
            position,
            transpose_semitones: required_transpose,
            window_seconds: 30.0,
            priority: PreparePriority::RealtimeCritical,
        });
        if required_transpose != 0 {
            self.push_prepare_request(PrepareRequest {
                song_id: song.id.clone(),
                position,
                transpose_semitones: 0,
                window_seconds: 30.0,
                priority: PreparePriority::RealtimeCritical,
            });
        }
        let cache = self.clone();
        let song_dir_clone = song_dir.to_path_buf();
        let song_clone = song.clone();
        rayon::spawn(move || {
            let _ = cache.prepare_window_now(&song_dir_clone, &song_clone, position, 0);
            if required_transpose != 0 {
                let _ = cache.prepare_window_now(
                    &song_dir_clone,
                    &song_clone,
                    position,
                    required_transpose,
                );
            }
        });

        self.rebuild_seek_readiness_map(song_dir, song, position);
    }

    fn prepare_window_now(
        &self,
        song_dir: &Path,
        song: &Song,
        position: TimelinePosition,
        transpose_semitones: i32,
    ) -> Result<(), String> {
        let Some(plan) = mixer::build_playback_plans(song_dir, song, 48_000)
            .into_iter()
            .find(|plan| {
                let position_frame = seconds_to_frames(position, 48_000);
                position_frame >= plan.timeline_start_frame
                    && position_frame < plan.timeline_end_frame()
            })
        else {
            return Ok(());
        };

        self.ensure_original_prepared_source(&plan.file_path)?;
        if transpose_semitones == 0 || audio_safe_mode_enabled() {
            return Ok(());
        }
        if !prepared_pitch_render_enabled() {
            return Ok(());
        }

        let exact_key = PreparedAudioKey {
            file_id: plan.file_path.to_string_lossy().to_string(),
            file_hash: plan.file_path.to_string_lossy().to_string(),
            sample_rate: 48_000,
            channels: 2,
            transpose_semitones,
        };
        if self.prepared_audio.get_exact(&exact_key, 0).is_some() {
            return Ok(());
        }
        let render_claimed = self
            .prepared_audio
            .active_renders
            .lock()
            .map(|mut active_renders| active_renders.insert(exact_key.clone()))
            .unwrap_or(false);
        if !render_claimed {
            return Ok(());
        }
        let render_result = (|| {
            if self.prepared_audio.get_exact(&exact_key, 0).is_some() {
                return Ok(());
            }
            let Some(original_source) = self.prepared_audio.get_original(&exact_key, 0) else {
                return Ok(());
            };
            let output_path = std::env::temp_dir().join(format!(
                "libretracks-runtime-render-{}-{}-{}.ltaf",
                std::process::id(),
                sanitize_cache_name(&plan.file_path),
                transpose_semitones
            ));
            let rendered =
                render_transposed_to_cache(original_source, exact_key.clone(), output_path)?;
            self.prepared_audio
                .insert_ready_disk(exact_key.clone(), rendered)?;
            Ok(())
        })();
        if let Ok(mut active_renders) = self.prepared_audio.active_renders.lock() {
            active_renders.remove(&exact_key);
        }
        render_result
    }

    pub(crate) fn record_silence_fallback(&self, position: TimelinePosition, file: String) {
        if let Ok(mut telemetry) = self.silence_fallback.write() {
            telemetry.count = telemetry.count.saturating_add(1);
            telemetry.last_position = Some(position);
            telemetry.last_file = Some(file);
        }
    }

    pub(crate) fn on_timeline_hover_or_drag(
        &self,
        song_dir: &Path,
        song: &Song,
        position: TimelinePosition,
    ) {
        let transpose = transpose_for_position(song, position);
        self.push_prepare_request(PrepareRequest {
            song_id: song.id.clone(),
            position,
            transpose_semitones: transpose,
            window_seconds: 5.0,
            priority: PreparePriority::RealtimeCritical,
        });
        self.rebuild_seek_readiness_map(song_dir, song, position);
    }

    fn rebuild_seek_readiness_map(
        &self,
        song_dir: &Path,
        song: &Song,
        current_playhead: TimelinePosition,
    ) {
        let regions = song
            .regions
            .iter()
            .map(|region| RegionReadinessEntry {
                region_id: region.id.clone(),
                start: region.start_seconds,
                end: region.end_seconds,
                readiness: self.readiness_at(
                    song_dir,
                    song,
                    region.start_seconds,
                    region.transpose_semitones,
                ),
            })
            .collect::<Vec<_>>();

        let mut hot_targets = Vec::new();
        hot_targets.push(SeekTarget {
            position: current_playhead,
            kind: SeekTargetKind::CurrentPlayhead,
            readiness: self.readiness_at(
                song_dir,
                song,
                current_playhead,
                transpose_for_position(song, current_playhead),
            ),
        });
        for region in &song.regions {
            hot_targets.push(SeekTarget {
                position: region.start_seconds,
                kind: SeekTargetKind::RegionStart,
                readiness: self.readiness_at(
                    song_dir,
                    song,
                    region.start_seconds,
                    region.transpose_semitones,
                ),
            });
            hot_targets.push(SeekTarget {
                position: region.end_seconds,
                kind: SeekTargetKind::RegionEnd,
                readiness: self.readiness_at(
                    song_dir,
                    song,
                    region.end_seconds,
                    region.transpose_semitones,
                ),
            });
        }
        for marker in &song.section_markers {
            hot_targets.push(SeekTarget {
                position: marker.start_seconds,
                kind: SeekTargetKind::Marker,
                readiness: self.readiness_at(
                    song_dir,
                    song,
                    marker.start_seconds,
                    transpose_for_position(song, marker.start_seconds),
                ),
            });
        }

        let mut last_user_positions = self
            .prepare_requests
            .read()
            .ok()
            .map(|requests| {
                requests
                    .iter()
                    .rev()
                    .filter(|request| request.song_id == song.id)
                    .take(10)
                    .map(|request| request.position)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        last_user_positions.reverse();

        if let Ok(mut maps) = self.seek_readiness_maps.write() {
            maps.insert(
                song.id.clone(),
                SeekReadinessMap {
                    song_id: song.id.clone(),
                    hot_targets,
                    regions,
                    last_user_positions,
                },
            );
        }
    }

    fn readiness_at(
        &self,
        song_dir: &Path,
        song: &Song,
        position: TimelinePosition,
        required_transpose: i32,
    ) -> RegionReadiness {
        match self
            .get_best_source_for_seek(song_dir, song, position, required_transpose)
            .kind()
        {
            SeekSourceKind::ExactRam => RegionReadiness::ExactRam,
            SeekSourceKind::ExactDisk => RegionReadiness::ExactDisk,
            SeekSourceKind::OriginalRam => RegionReadiness::OriginalRam,
            SeekSourceKind::OriginalDisk => RegionReadiness::OriginalDisk,
            SeekSourceKind::PreviousPitch | SeekSourceKind::Silence => RegionReadiness::Missing,
        }
    }

    fn push_prepare_request(&self, request: PrepareRequest) {
        if let Ok(mut requests) = self.prepare_requests.write() {
            requests.push(request);
            requests.sort_by_key(|request| prepare_priority_rank(request.priority));
            const MAX_PREPARE_REQUESTS: usize = 256;
            if requests.len() > MAX_PREPARE_REQUESTS {
                requests.truncate(MAX_PREPARE_REQUESTS);
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn prepare_requests_for_test(&self) -> Vec<PrepareRequest> {
        self.prepare_requests
            .read()
            .expect("prepare requests should lock")
            .clone()
    }

    #[cfg(test)]
    pub(crate) fn seek_readiness_map_for_test(&self, song_id: &str) -> Option<SeekReadinessMap> {
        self.seek_readiness_maps
            .read()
            .expect("readiness maps should lock")
            .get(song_id)
            .cloned()
    }

    pub(crate) fn stats(&self) -> AudioBufferCacheStats {
        let silence_fallback = self
            .silence_fallback
            .read()
            .map(|telemetry| telemetry.clone())
            .unwrap_or_default();
        self.entries
            .read()
            .map(|entries| AudioBufferCacheStats {
                cached_buffers: entries.len(),
                fully_cached_buffers: 0,
                preload_bytes: entries.values().map(|source| source.preload_bytes()).sum(),
                prepare_queue_len: self.prepared_audio.prepare_queue_len(),
                ram_cache_used_mb: self.prepared_audio.ram_cache_used_mb(),
                disk_cache_used_mb: self
                    .prepared_disk_entries
                    .try_read()
                    .map(|entries| entries.len())
                    .unwrap_or_default(),
                silence_fallback_count: silence_fallback.count,
                last_silence_fallback_position: silence_fallback.last_position,
                last_silence_fallback_file: silence_fallback.last_file.clone(),
            })
            .unwrap_or_default()
    }
}

impl StreamingClipReader {
    pub(crate) fn open(
        plan: &mixer::PlaybackClipPlan,
        output_sample_rate: u32,
        audio_buffers: &AudioBufferCache,
        timeline_frame: u64,
    ) -> Result<Self, String> {
        let shared_source = audio_buffers
            .get(&plan.file_path)?
            .ok_or_else(|| format!("audio source is not prepared: {}", plan.file_path.display()))?;
        let output_sample_rate = output_sample_rate.max(1);
        let source_start_frame = source_frame_for_timeline_position(
            plan,
            timeline_frame,
            output_sample_rate,
            shared_source.sample_rate,
        );
        Self::open_from_source_frame(
            plan,
            output_sample_rate,
            shared_source,
            timeline_frame,
            source_start_frame,
        )
    }

    pub(crate) fn open_with_preroll(
        plan: &mixer::PlaybackClipPlan,
        output_sample_rate: u32,
        audio_buffers: &AudioBufferCache,
        timeline_frame: u64,
        preroll_source_frame: usize,
    ) -> Result<Self, String> {
        let shared_source = audio_buffers
            .get(&plan.file_path)?
            .ok_or_else(|| format!("audio source is not prepared: {}", plan.file_path.display()))?;
        Self::open_from_source_frame(
            plan,
            output_sample_rate.max(1),
            shared_source,
            timeline_frame,
            preroll_source_frame,
        )
    }

    fn open_from_source_frame(
        plan: &mixer::PlaybackClipPlan,
        output_sample_rate: u32,
        shared_source: Arc<StreamingAudioSource>,
        timeline_frame: u64,
        source_start_frame: usize,
    ) -> Result<Self, String> {
        let output_sample_rate = output_sample_rate.max(1);
        let target_source_frame = source_frame_for_timeline_position(
            plan,
            timeline_frame,
            output_sample_rate,
            shared_source.sample_rate,
        );
        let source_start_seconds =
            source_start_frame as f64 / f64::from(shared_source.sample_rate.max(1));
        let ring_capacity =
            output_sample_rate as usize * STREAM_SECONDS_PER_CLIP * shared_source.channels.max(1);
        let (producer, consumer) = RingBuffer::<ClipSample>::new(ring_capacity.max(256));
        let (command_sender, command_receiver) = mpsc::channel();
        let (ready_sender, ready_receiver) = mpsc::sync_channel(1);
        let worker_source = Arc::clone(&shared_source);
        let _worker_handle = thread::Builder::new()
            .name("libretracks-streaming-source".into())
            .spawn(move || {
                run_streaming_worker(
                    worker_source,
                    output_sample_rate,
                    source_start_seconds,
                    producer,
                    command_receiver,
                    Some(ready_sender),
                )
            })
            .map_err(|error| error.to_string())?;

        match ready_receiver.recv_timeout(STREAM_WORKER_READY_TIMEOUT) {
            Ok(WorkerReadyState::Ready | WorkerReadyState::Finished) => {}
            Err(mpsc::RecvTimeoutError::Timeout) => {
                return Err("streaming worker did not become ready in time".to_string())
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err("streaming worker exited before becoming ready".to_string())
            }
        }

        let elapsed_frames = timeline_frame.saturating_sub(plan.timeline_start_frame);
        let preroll_output_frames = target_source_frame
            .saturating_sub(source_start_frame)
            .saturating_mul(output_sample_rate as usize)
            .div_ceil(shared_source.sample_rate.max(1) as usize);
        let remaining_frames = (plan.duration_frames.saturating_sub(elapsed_frames) as usize)
            .saturating_add(preroll_output_frames);
        let declick_fade_frames = (0.015 * output_sample_rate as f32).round() as usize;
        let is_true_clip_start = elapsed_frames == 0
            && preroll_output_frames == 0
            && plan.source_start_seconds <= f64::EPSILON;
        Ok(Self {
            shared_source,
            consumer,
            command_sender,
            output_sample_rate,
            current_generation: 0,
            current_source_start_frame: source_start_frame,
            emitted_frames: 0,
            total_output_frames: remaining_frames,
            declick_fade_frames,
            declick_frames_remaining: if is_true_clip_start {
                0
            } else {
                declick_fade_frames
            },
            eof: remaining_frames == 0,
        })
    }

    #[cfg_attr(not(test), allow(dead_code))]
    fn seek_to_internal(&mut self, target_frame: usize) -> Result<(), String> {
        self.current_generation = self.current_generation.saturating_add(1);
        let channels = self.shared_source.channels.max(1);
        let slots = self.consumer.slots();
        let frames_to_drop = slots / channels;
        for _ in 0..(frames_to_drop * channels) {
            let _ = self.consumer.pop();
        }

        self.emitted_frames = 0;
        self.current_source_start_frame = target_frame;
        self.declick_frames_remaining = self.declick_fade_frames;
        self.eof = self.total_output_frames == 0;
        let target_start_seconds =
            target_frame as f64 / f64::from(self.shared_source.sample_rate.max(1));
        self.command_sender
            .send(StreamingWorkerCommand::Seek {
                target_start_seconds,
                generation: self.current_generation,
            })
            .map_err(|_| "streaming worker is unavailable".to_string())
    }

    #[cfg(test)]
    pub(crate) fn seek_to(&mut self, target_frame: usize) {
        let _ = self.seek_to_internal(target_frame);
    }

    #[cfg(test)]
    pub(crate) fn current_frame(&self) -> usize {
        let source_ratio = self.shared_source.sample_rate as f64 / self.output_sample_rate as f64;
        self.current_source_start_frame
            .saturating_add((self.emitted_frames as f64 * source_ratio).round() as usize)
    }

    #[cfg(test)]
    pub(crate) fn shared_source(&self) -> &StreamingAudioSource {
        &self.shared_source
    }

    pub(crate) fn source_channels(&self) -> usize {
        self.shared_source.channels.max(1)
    }

    pub(crate) fn read_interleaved(&mut self, output: &mut [f32], max_frames: usize) -> usize {
        if self.eof {
            return 0;
        }

        let channels = self.shared_source.channels.max(1);
        let frames_to_read = max_frames.min(output.len() / channels);
        let mut frames_read = 0;
        for frame_index in 0..frames_to_read {
            let frame_base = frame_index * channels;
            for channel in 0..channels {
                let Some(sample) = self.pop_current_sample() else {
                    self.eof = true;
                    return frames_read;
                };
                output[frame_base + channel] = sample;
            }
            self.emitted_frames = self.emitted_frames.saturating_add(1);
            frames_read += 1;
            if self.emitted_frames >= self.total_output_frames {
                self.eof = true;
                break;
            }
        }
        frames_read
    }

    pub(crate) fn next_stereo_frame(&mut self, gain: f32, pan: f32) -> Option<(f32, f32)> {
        if self.eof {
            return None;
        }

        let channels = self.shared_source.channels.max(1);

        let pan = pan.clamp(-1.0, 1.0);
        let (left_input, right_input) = if channels <= 1 {
            let sample = self.pop_current_sample()?;
            (sample, sample)
        } else {
            match (self.pop_current_sample(), self.pop_current_sample()) {
                (Some(left), Some(right)) => {
                    for _ in 2..channels {
                        let _ = self.pop_current_sample();
                    }
                    (left, right)
                }
                _ => return None,
            }
        };

        self.emitted_frames = self.emitted_frames.saturating_add(1);
        if self.emitted_frames >= self.total_output_frames {
            self.eof = true;
        }

        let mut final_gain = gain;
        if self.declick_frames_remaining > 0 {
            let fade_progress =
                1.0 - (self.declick_frames_remaining as f32 / self.declick_fade_frames as f32);
            final_gain *= fade_progress;
            self.declick_frames_remaining -= 1;
        }

        if final_gain.abs() <= GAIN_EPSILON {
            return Some((0.0, 0.0));
        }

        let (left_output, right_output) =
            mixer::apply_runtime_pan(left_input, right_input, pan, channels);
        Some((left_output * final_gain, right_output * final_gain))
    }

    fn pop_current_sample(&mut self) -> Option<f32> {
        let started_at = Instant::now();
        loop {
            match self.consumer.pop() {
                Ok(sample) if sample.generation < self.current_generation => continue,
                Ok(sample) => return Some(sample.value),
                Err(_) if started_at.elapsed() < STREAM_WORKER_READY_TIMEOUT => {
                    thread::yield_now();
                    continue;
                }
                Err(_) => return None,
            }
        }
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn mix_into_with_channel_gains(
        &mut self,
        buffer: &mut [f32],
        offset_frames: usize,
        frame_count: usize,
        output_channels: usize,
        gain: f32,
        pan: f32,
    ) -> (f32, f32) {
        let mut left_peak = 0.0_f32;
        let mut right_peak = 0.0_f32;

        for frame_offset in 0..frame_count {
            let Some((left_output, right_output)) = self.next_stereo_frame(gain, pan) else {
                break;
            };
            let buffer_base = (offset_frames + frame_offset) * output_channels;
            if output_channels <= 1 {
                let mono_sample = (left_output + right_output) * 0.5;
                buffer[buffer_base] += mono_sample;
                let mono_peak = mono_sample.abs();
                left_peak = left_peak.max(mono_peak);
                right_peak = right_peak.max(mono_peak);
            } else {
                buffer[buffer_base] += left_output;
                buffer[buffer_base + 1] += right_output;
                left_peak = left_peak.max(left_output.abs());
                right_peak = right_peak.max(right_output.abs());
            }
        }

        (left_peak, right_peak)
    }
}

impl Drop for StreamingClipReader {
    fn drop(&mut self) {
        let _ = self.command_sender.send(StreamingWorkerCommand::Shutdown);
    }
}

#[cfg_attr(not(test), allow(dead_code))]
pub(crate) type SharedAudioSource = StreamingAudioSource;
pub(crate) type MemoryClipReader = StreamingClipReader;

fn run_streaming_worker(
    source: Arc<StreamingAudioSource>,
    output_sample_rate: u32,
    initial_target_start_seconds: f64,
    mut producer: Producer<ClipSample>,
    command_receiver: Receiver<StreamingWorkerCommand>,
    mut ready_sender: Option<mpsc::SyncSender<WorkerReadyState>>,
) {
    let mut target_start_seconds = initial_target_start_seconds;
    let mut generation = 0;

    loop {
        match stream_decode_from(
            &source,
            output_sample_rate,
            target_start_seconds,
            generation,
            &mut producer,
            &command_receiver,
            ready_sender.take(),
        ) {
            WorkerOutcome::Restart {
                target_start_seconds: next_start,
                generation: next_generation,
            } => {
                target_start_seconds = next_start;
                generation = next_generation;
            }
            WorkerOutcome::Finished => match command_receiver.recv() {
                Ok(StreamingWorkerCommand::Seek {
                    target_start_seconds: next_start_seconds,
                    generation: next_generation,
                }) => {
                    target_start_seconds = next_start_seconds;
                    generation = next_generation;
                }
                Ok(StreamingWorkerCommand::Shutdown) | Err(_) => break,
            },
            WorkerOutcome::Shutdown => break,
        }
    }
}

enum WorkerOutcome {
    Restart {
        target_start_seconds: f64,
        generation: u64,
    },
    Finished,
    Shutdown,
}

fn stream_decode_from(
    source: &StreamingAudioSource,
    output_sample_rate: u32,
    target_start_seconds: f64,
    generation: u64,
    producer: &mut Producer<ClipSample>,
    command_receiver: &Receiver<StreamingWorkerCommand>,
    ready_sender: Option<mpsc::SyncSender<WorkerReadyState>>,
) -> WorkerOutcome {
    let mut decoder = match StreamingDecoder::open(source, output_sample_rate, target_start_seconds)
    {
        Ok(decoder) => decoder,
        Err(_) => return WorkerOutcome::Finished,
    };
    let channels = source.channels.max(1);
    let mut pending_samples = Vec::new();

    let mut ready_sender = ready_sender;

    loop {
        while let Ok(command) = command_receiver.try_recv() {
            match command {
                StreamingWorkerCommand::Seek {
                    target_start_seconds,
                    generation,
                } => {
                    return WorkerOutcome::Restart {
                        target_start_seconds,
                        generation,
                    };
                }
                StreamingWorkerCommand::Shutdown => return WorkerOutcome::Shutdown,
            }
        }

        if producer.slots() < source.channels.max(1) {
            thread::yield_now();
            continue;
        }

        let processed_samples = match take_decoder_samples(
            &mut decoder,
            &mut pending_samples,
            STREAM_WORKER_CHUNK_FRAMES,
            channels,
            false,
        ) {
            Ok(samples) if samples.is_empty() => {
                signal_worker_ready(&mut ready_sender, WorkerReadyState::Finished);
                return WorkerOutcome::Finished;
            }
            Ok(samples) => samples,
            Err(_) => {
                signal_worker_ready(&mut ready_sender, WorkerReadyState::Finished);
                return WorkerOutcome::Finished;
            }
        };

        for frame in processed_samples.chunks_exact(channels) {
            // Wait until there is enough space for the WHOLE frame
            while producer.slots() < channels {
                if let Ok(command) = command_receiver.try_recv() {
                    match command {
                        StreamingWorkerCommand::Seek {
                            target_start_seconds,
                            generation,
                        } => {
                            return WorkerOutcome::Restart {
                                target_start_seconds,
                                generation,
                            }
                        }
                        StreamingWorkerCommand::Shutdown => return WorkerOutcome::Shutdown,
                    }
                }
                thread::yield_now();
            }

            // Space is guaranteed, now we can push all samples in the frame
            for &sample in frame {
                let _ = producer.push(ClipSample {
                    generation,
                    value: sample,
                });
            }
        }

        signal_worker_ready(&mut ready_sender, WorkerReadyState::Ready);
    }
}

fn signal_worker_ready(
    ready_sender: &mut Option<mpsc::SyncSender<WorkerReadyState>>,
    state: WorkerReadyState,
) {
    if let Some(sender) = ready_sender.take() {
        let _ = sender.send(state);
    }
}

struct StreamingDecoder {
    format: Box<dyn symphonia::core::formats::FormatReader>,
    decoder: Box<dyn symphonia::core::codecs::Decoder>,
    track_id: u32,
    channels: usize,
    input_sample_rate: u32,
    output_sample_rate: u32,
    discard_input_frames: usize,
}

impl StreamingDecoder {
    fn open(
        source: &StreamingAudioSource,
        output_sample_rate: u32,
        start_seconds: f64,
    ) -> Result<Self, String> {
        let file = File::open(&source.file_path).map_err(|error| error.to_string())?;
        let mut hint = Hint::new();
        if let Some(extension) = source
            .file_path
            .extension()
            .and_then(|value| value.to_str())
        {
            hint.with_extension(extension);
        }
        let media_source_stream = MediaSourceStream::new(Box::new(file), Default::default());
        let probed = symphonia::default::get_probe()
            .format(
                &hint,
                media_source_stream,
                &FormatOptions {
                    prebuild_seek_index: false,
                    seek_index_fill_rate: 1,
                    ..FormatOptions::default()
                },
                &MetadataOptions::default(),
            )
            .map_err(|error| error.to_string())?;
        let mut format = probed.format;
        let track = format
            .default_track()
            .or_else(|| {
                format
                    .tracks()
                    .iter()
                    .find(|track| track.codec_params.codec != CODEC_TYPE_NULL)
            })
            .ok_or_else(|| "unsupported audio stream".to_string())?;
        let track_id = track.id;
        let codec_params = track.codec_params.clone();
        let input_sample_rate = codec_params
            .sample_rate
            .unwrap_or(source.sample_rate)
            .max(1);
        let channels = codec_params
            .channels
            .map(|channels| channels.count())
            .unwrap_or(source.channels)
            .max(1);
        let decoder = symphonia::default::get_codecs()
            .make(&codec_params, &DecoderOptions::default())
            .map_err(|error| error.to_string())?;

        let mut actual_seek_seconds = 0.0;
        if start_seconds > 0.0 {
            let seek_time = nearest_seek_time(source, start_seconds, input_sample_rate);
            if let Ok(seeked) = format.seek(
                SeekMode::Accurate,
                SeekTo::Time {
                    time: Time::from(seek_time),
                    track_id: Some(track_id),
                },
            ) {
                actual_seek_seconds = seeked.actual_ts as f64 / f64::from(input_sample_rate);
            }
        }
        let discard_input_frames = ((start_seconds.max(0.0) - actual_seek_seconds).max(0.0)
            * f64::from(input_sample_rate))
        .round() as usize;

        Ok(Self {
            format,
            decoder,
            track_id,
            channels,
            input_sample_rate,
            output_sample_rate: output_sample_rate.max(1),
            discard_input_frames,
        })
    }

    fn next_output_chunk(&mut self, max_frames: usize) -> Result<Vec<f32>, String> {
        let mut input = Vec::new();
        while input.len() < max_frames.saturating_mul(self.channels) {
            let packet = match self.format.next_packet() {
                Ok(packet) => packet,
                Err(SymphoniaError::IoError(error))
                    if error.kind() == std::io::ErrorKind::UnexpectedEof =>
                {
                    break;
                }
                Err(error) => return Err(error.to_string()),
            };

            if packet.track_id() != self.track_id {
                continue;
            }

            let decoded = match self.decoder.decode(&packet) {
                Ok(decoded) => decoded,
                Err(SymphoniaError::DecodeError(_)) => continue,
                Err(error) => return Err(error.to_string()),
            };
            let mut sample_buffer =
                SampleBuffer::<f32>::new(decoded.capacity() as u64, *decoded.spec());
            sample_buffer.copy_interleaved_ref(decoded);
            let mut samples = sample_buffer.samples();
            if self.discard_input_frames > 0 {
                let decoded_frames = samples.len() / self.channels.max(1);
                let skip_frames = self.discard_input_frames.min(decoded_frames);
                self.discard_input_frames -= skip_frames;
                samples = &samples[skip_frames * self.channels.max(1)..];
            }
            input.extend_from_slice(samples);
        }

        Ok(resample_interleaved(
            &input,
            self.channels,
            self.input_sample_rate,
            self.output_sample_rate,
        ))
    }
}

pub(crate) fn prepare_audio_source(file_path: &Path) -> Result<StreamingAudioSource, String> {
    let file = File::open(file_path).map_err(|error| error.to_string())?;
    let mut hint = Hint::new();
    if let Some(extension) = file_path.extension().and_then(|value| value.to_str()) {
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
        .map_err(|error| error.to_string())?;
    let format = probed.format;
    let track = format
        .default_track()
        .or_else(|| {
            format
                .tracks()
                .iter()
                .find(|track| track.codec_params.codec != CODEC_TYPE_NULL)
        })
        .ok_or_else(|| format!("unsupported audio stream: {}", file_path.display()))?;
    let sample_rate = track.codec_params.sample_rate.unwrap_or(48_000).max(1);
    let channels = track
        .codec_params
        .channels
        .map(|channels| channels.count())
        .unwrap_or(1)
        .max(1);
    let frame_count = track.codec_params.n_frames.unwrap_or(0) as usize;

    Ok(StreamingAudioSource {
        file_path: file_path.to_path_buf(),
        sample_rate,
        channels,
        frame_count,
        seek_index: Vec::new(),
    })
}

fn validate_rendered_samples(samples: &[f32]) -> Result<(), String> {
    let mut peak = 0.0_f32;
    for &sample in samples {
        if !sample.is_finite() {
            return Err("pitch render produced non-finite samples".to_string());
        }
        peak = peak.max(sample.abs());
    }
    if peak > 4.0 {
        return Err(format!("pitch render peak is unsafe: {peak}"));
    }
    Ok(())
}

fn decode_original_to_engine_ram(
    source: &StreamingAudioSource,
    output_sample_rate: u32,
    output_channels: usize,
) -> Result<RawRamSource, String> {
    let mut decoder = StreamingDecoder::open(source, source.sample_rate, 0.0)?;
    let channels = source.channels.max(1);
    let mut samples = Vec::with_capacity(source.frame_count.saturating_mul(channels));

    loop {
        let chunk = decoder.next_output_chunk(STREAM_WORKER_CHUNK_FRAMES)?;
        if chunk.is_empty() {
            break;
        }
        samples.extend_from_slice(&chunk);
    }

    let resampled = resample_interleaved(
        &samples,
        channels,
        source.sample_rate,
        output_sample_rate.max(1),
    );
    let converted = convert_interleaved_channels(&resampled, channels, output_channels.max(1));
    validate_rendered_samples(&converted)?;

    Ok(RawRamSource::new(
        converted,
        output_sample_rate.max(1),
        output_channels.max(1),
    ))
}

fn convert_interleaved_channels(
    samples: &[f32],
    source_channels: usize,
    target_channels: usize,
) -> Vec<f32> {
    let source_channels = source_channels.max(1);
    let target_channels = target_channels.max(1);
    if source_channels == target_channels {
        return samples.to_vec();
    }

    let frame_count = samples.len() / source_channels;
    let mut output = vec![0.0_f32; frame_count * target_channels];
    for frame in 0..frame_count {
        let source_base = frame * source_channels;
        let target_base = frame * target_channels;
        let left = samples[source_base];
        let right = if source_channels > 1 {
            samples[source_base + 1]
        } else {
            left
        };

        if target_channels == 1 {
            output[target_base] = if source_channels == 1 {
                left
            } else {
                (left + right) * 0.5
            };
            continue;
        }

        output[target_base] = left;
        output[target_base + 1] = right;
        for extra_channel in 2..target_channels {
            output[target_base + extra_channel] = samples
                .get(source_base + extra_channel.min(source_channels - 1))
                .copied()
                .unwrap_or(right);
        }
    }
    output
}

fn nearest_seek_time(source: &StreamingAudioSource, start_seconds: f64, sample_rate: u32) -> f64 {
    if source.seek_index.is_empty() {
        return start_seconds.max(0.0);
    }
    let target_ts = (start_seconds.max(0.0) * f64::from(sample_rate.max(1))) as u64;
    source
        .seek_index
        .iter()
        .take_while(|entry| entry.timestamp <= target_ts)
        .max_by_key(|entry| (entry.timestamp, entry.packet_offset))
        .map(|entry| entry.timestamp as f64 / f64::from(sample_rate.max(1)))
        .unwrap_or(0.0)
}

fn resample_interleaved(
    samples: &[f32],
    channels: usize,
    source_sample_rate: u32,
    target_sample_rate: u32,
) -> Vec<f32> {
    if samples.is_empty() || channels == 0 || source_sample_rate == target_sample_rate {
        return samples.to_vec();
    }

    let source_frame_count = samples.len() / channels;
    if source_frame_count <= 1 {
        return samples.to_vec();
    }

    let ratio = target_sample_rate as f64 / source_sample_rate.max(1) as f64;
    let target_frame_count = ((source_frame_count as f64) * ratio).round().max(1.0) as usize;
    let mut output = vec![0.0_f32; target_frame_count * channels];

    for target_frame in 0..target_frame_count {
        let source_position = target_frame as f64 / ratio;
        let base_frame = source_position.floor() as usize;
        let next_frame = (base_frame + 1).min(source_frame_count - 1);
        let blend = (source_position - base_frame as f64) as f32;

        for channel in 0..channels {
            let base_sample = samples[base_frame * channels + channel];
            let next_sample = samples[next_frame * channels + channel];
            output[target_frame * channels + channel] =
                base_sample + (next_sample - base_sample) * blend;
        }
    }

    output
}

fn source_start_seconds_floor(seconds: f64) -> f64 {
    if seconds.is_finite() && seconds > 0.0 {
        seconds
    } else {
        0.0
    }
}

fn source_frame_for_timeline_position(
    plan: &mixer::PlaybackClipPlan,
    timeline_frame: u64,
    output_sample_rate: u32,
    source_sample_rate: u32,
) -> usize {
    let elapsed_frames = timeline_frame.saturating_sub(plan.timeline_start_frame);
    let elapsed_seconds = elapsed_frames as f64 / output_sample_rate.max(1) as f64;
    seconds_to_frames(
        source_start_seconds_floor(plan.source_start_seconds) + elapsed_seconds,
        source_sample_rate,
    ) as usize
}

fn transpose_for_position(song: &Song, position_seconds: f64) -> i32 {
    song.regions
        .iter()
        .find(|region| {
            position_seconds >= region.start_seconds && position_seconds < region.end_seconds
        })
        .map(|region| region.transpose_semitones)
        .unwrap_or(0)
}

fn write_ltaf_file(
    path: &Path,
    samples: &[f32],
    sample_rate: u32,
    channels: usize,
) -> Result<(), String> {
    let channels = channels.max(1);
    let frame_count = (samples.len() / channels) as u64;
    let mut header = [0_u8; LTAF_HEADER_LEN as usize];
    header[0..4].copy_from_slice(LTAF_MAGIC);
    header[4..8].copy_from_slice(&LTAF_VERSION.to_le_bytes());
    header[8..12].copy_from_slice(&sample_rate.max(1).to_le_bytes());
    header[12..16].copy_from_slice(&(channels as u32).to_le_bytes());
    header[16..24].copy_from_slice(&frame_count.to_le_bytes());
    header[24..28].copy_from_slice(&0_i32.to_le_bytes());
    header[28] = 1;

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let mut file = File::create(path).map_err(|error| error.to_string())?;
    file.write_all(&header).map_err(|error| error.to_string())?;
    for &sample in samples {
        file.write_all(&sample.to_le_bytes())
            .map_err(|error| error.to_string())?;
    }
    file.flush().map_err(|error| error.to_string())
}

fn prepare_priority_rank(priority: PreparePriority) -> u8 {
    match priority {
        PreparePriority::RealtimeCritical => 0,
        PreparePriority::CurrentPlayback => 1,
        PreparePriority::HotSeekTarget => 2,
        PreparePriority::CurrentSong => 3,
        PreparePriority::NextSong => 4,
        PreparePriority::Background => 5,
    }
}

pub(crate) fn resolve_clip_audio_path(song_dir: &Path, file_path: &str) -> PathBuf {
    let path = Path::new(file_path);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        song_dir.join(path)
    }
}

fn sanitize_cache_name(path: &Path) -> String {
    path.to_string_lossy()
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

pub(crate) fn audio_safe_mode_enabled() -> bool {
    env_flag_value("LIBRETRACKS_AUDIO_SAFE_MODE")
}

pub(crate) fn prepared_playback_disabled() -> bool {
    env_flag_value("LIBRETRACKS_DISABLE_PREPARED_PLAYBACK")
}

pub(crate) fn prepared_pitch_render_enabled() -> bool {
    true
}

fn validate_prepared_key_matches_source(
    key: &PreparedAudioKey,
    source: &dyn PreparedAudioSource,
) -> Result<(), String> {
    if key.sample_rate != source.sample_rate() || key.channels != source.channels() {
        return Err(format!(
            "prepared source format mismatch for {}: key={}Hz/{}ch source={}Hz/{}ch",
            key.file_id,
            key.sample_rate,
            key.channels,
            source.sample_rate(),
            source.channels()
        ));
    }
    Ok(())
}

fn env_flag_value(key: &str) -> bool {
    env_override_for_current_thread(key)
        .or_else(|| std::env::var(key).ok())
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

#[cfg(test)]
fn env_override_for_current_thread(key: &str) -> Option<String> {
    TEST_ENV_OVERRIDES.with(|overrides| overrides.borrow().get(key).cloned().flatten())
}

#[cfg(not(test))]
fn env_override_for_current_thread(_key: &str) -> Option<String> {
    None
}

#[cfg(test)]
pub(crate) fn probe_audio_file(file_path: &Path) -> Result<(), String> {
    let prepared = prepare_audio_source(file_path)?;
    (prepared.channels() > 0 && prepared.sample_rate() > 0)
        .then_some(())
        .ok_or_else(|| "empty audio stream".to_string())
}

#[cfg(test)]
fn decode_file_region(
    file_path: &Path,
    _sample_rate: u32,
    channels: usize,
    start_seconds: f64,
    frames: usize,
) -> Result<Vec<f32>, String> {
    let source = prepare_audio_source(file_path)?;
    let mut decoder = StreamingDecoder::open(&source, source.sample_rate, start_seconds)?;
    let samples = decoder.next_output_chunk(frames)?;
    let wanted = frames.saturating_mul(channels.max(1));
    Ok(samples.into_iter().take(wanted).collect())
}

#[cfg(test)]
pub(crate) fn render_plan_frames_for_test(
    plan: &mixer::PlaybackClipPlan,
    output_sample_rate: u32,
    audio_buffers: &AudioBufferCache,
    timeline_frame: u64,
    frame_count: usize,
) -> Result<Vec<f32>, String> {
    let shared_source = audio_buffers
        .get(&plan.file_path)?
        .ok_or_else(|| format!("audio source is not prepared: {}", plan.file_path.display()))?;
    let channels = shared_source.channels.max(1);
    let source_start_frame = source_frame_for_timeline_position(
        plan,
        timeline_frame,
        output_sample_rate,
        shared_source.sample_rate,
    );
    let target_start_seconds =
        source_start_frame as f64 / f64::from(shared_source.sample_rate.max(1));
    let mut pitch_engine =
        pitch::create_pitch_shift_engine(output_sample_rate, channels, plan.transpose_semitones);

    render_pitch_aligned_frames_for_test(
        &shared_source,
        output_sample_rate,
        target_start_seconds,
        frame_count,
        pitch_engine.as_mut(),
    )
}

#[cfg(test)]
fn render_pitch_aligned_frames_for_test(
    source: &StreamingAudioSource,
    output_sample_rate: u32,
    target_start_seconds: f64,
    frame_count: usize,
    pitch_engine: &mut dyn pitch::PitchShiftEngine,
) -> Result<Vec<f32>, String> {
    let channels = source.channels.max(1);
    let mut decoder = StreamingDecoder::open(source, output_sample_rate, target_start_seconds)?;
    let mut pending_samples = Vec::new();

    pitch_engine.reset();
    pitch_engine
        .prepare_for_aligned_output()
        .map_err(|error| format!("pitch alignment failed: {error:?}"))?;

    let mut rendered = Vec::with_capacity(frame_count * channels);
    let wanted_samples = frame_count * channels;
    while rendered.len() < wanted_samples {
        let remaining_frames = (wanted_samples - rendered.len()).div_ceil(channels);
        let chunk_frames = remaining_frames.min(STREAM_WORKER_CHUNK_FRAMES).max(1);
        let samples = take_decoder_samples(
            &mut decoder,
            &mut pending_samples,
            chunk_frames,
            channels,
            false,
        )?;
        let input = if samples.is_empty() {
            vec![0.0_f32; chunk_frames * channels]
        } else {
            samples
        };

        let mut output = vec![0.0_f32; input.len()];
        pitch_engine
            .process_realtime_block(&input, &mut output)
            .map_err(|error| format!("pitch render failed: {error:?}"))?;
        rendered.extend_from_slice(&output);
    }

    rendered.truncate(wanted_samples);

    Ok(rendered)
}

fn take_decoder_samples(
    decoder: &mut StreamingDecoder,
    pending_samples: &mut Vec<f32>,
    requested_frames: usize,
    channels: usize,
    pad_with_silence: bool,
) -> Result<Vec<f32>, String> {
    let requested_samples = requested_frames.saturating_mul(channels.max(1));

    while pending_samples.len() < requested_samples {
        let samples = decoder.next_output_chunk(requested_frames)?;
        if samples.is_empty() {
            break;
        }
        pending_samples.extend_from_slice(&samples);
    }

    if pending_samples.is_empty() {
        return Ok(Vec::new());
    }

    let mut output = if pending_samples.len() > requested_samples {
        let overflow = pending_samples.split_off(requested_samples);
        std::mem::replace(pending_samples, overflow)
    } else {
        std::mem::take(pending_samples)
    };

    if pad_with_silence && output.len() < requested_samples {
        output.resize(requested_samples, 0.0);
    }

    Ok(output)
}

#[cfg(test)]
fn randomish_id() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT_ID: AtomicU64 = AtomicU64::new(1);
    NEXT_ID.fetch_add(1, Ordering::Relaxed)
}

#[cfg(test)]
pub(crate) fn with_env_var_for_test<T>(
    key: &str,
    value: Option<&str>,
    body: impl FnOnce() -> T,
) -> T {
    let previous = TEST_ENV_OVERRIDES.with(|overrides| {
        overrides
            .borrow_mut()
            .insert(key.to_string(), value.map(str::to_string))
    });
    let result = body();
    TEST_ENV_OVERRIDES.with(|overrides| {
        let mut overrides = overrides.borrow_mut();
        match previous {
            Some(previous) => {
                overrides.insert(key.to_string(), previous);
            }
            None => {
                overrides.remove(key);
            }
        }
    });
    result
}

#[cfg(test)]
thread_local! {
    static TEST_ENV_OVERRIDES: std::cell::RefCell<HashMap<String, Option<String>>> =
        std::cell::RefCell::new(HashMap::new());
}

#[cfg(test)]
fn write_test_wav(
    path: &Path,
    samples: &[f32],
    sample_rate: u32,
    channels: usize,
) -> Result<(), String> {
    let spec = hound::WavSpec {
        channels: channels.max(1) as u16,
        sample_rate: sample_rate.max(1),
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };
    let mut writer = hound::WavWriter::create(path, spec).map_err(|error| error.to_string())?;
    for &sample in samples {
        writer
            .write_sample(sample)
            .map_err(|error| error.to_string())?;
    }
    writer.finalize().map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use libretracks_core::{Clip, SongRegion, Track, TrackKind};

    fn best_envelope_alignment_offset(
        left: &[f32],
        right: &[f32],
        center: usize,
        radius: usize,
        max_shift: usize,
    ) -> usize {
        const ENVELOPE_RADIUS: usize = 32;

        let start = center.saturating_sub(radius + max_shift);
        let end = (center + radius + max_shift + 1)
            .min(left.len())
            .min(right.len());
        let smooth_envelope = |window: &[f32]| {
            (0..window.len())
                .map(|index| {
                    let envelope_start = index.saturating_sub(ENVELOPE_RADIUS);
                    let envelope_end = (index + ENVELOPE_RADIUS + 1).min(window.len());
                    let sum = window[envelope_start..envelope_end]
                        .iter()
                        .map(|sample| sample.abs())
                        .sum::<f32>();
                    sum / (envelope_end - envelope_start) as f32
                })
                .collect::<Vec<_>>()
        };
        let left_window = smooth_envelope(&left[start..end]);
        let right_window = smooth_envelope(&right[start..end]);

        (-(max_shift as isize)..=(max_shift as isize))
            .map(|shift| {
                let (left_offset, right_offset, compare_len) = if shift >= 0 {
                    let shift = shift as usize;
                    (0, shift, left_window.len().saturating_sub(shift))
                } else {
                    let shift = (-shift) as usize;
                    (shift, 0, left_window.len().saturating_sub(shift))
                };

                let error = left_window[left_offset..left_offset + compare_len]
                    .iter()
                    .zip(&right_window[right_offset..right_offset + compare_len])
                    .map(|(left, right)| {
                        let delta = left - right;
                        delta * delta
                    })
                    .sum::<f32>();

                (shift.unsigned_abs(), error)
            })
            .min_by(|(left_shift, left_error), (right_shift, right_error)| {
                left_error
                    .total_cmp(right_error)
                    .then_with(|| left_shift.cmp(right_shift))
            })
            .map(|(shift, _)| shift)
            .unwrap_or_default()
    }

    #[test]
    fn streaming_clip_reader_drops_stale_generation_samples() {
        let (mut producer, consumer) = RingBuffer::<ClipSample>::new(4);
        producer
            .push(ClipSample {
                generation: 1,
                value: 0.25,
            })
            .expect("sample should fit");
        producer
            .push(ClipSample {
                generation: 2,
                value: 0.5,
            })
            .expect("sample should fit");

        let (command_sender, _command_receiver) = mpsc::channel();
        let mut reader = StreamingClipReader {
            shared_source: Arc::new(StreamingAudioSource::from_preloaded(
                vec![0.0],
                48_000,
                1,
                false,
            )),
            consumer,
            command_sender,
            output_sample_rate: 48_000,
            current_generation: 2,
            current_source_start_frame: 0,
            emitted_frames: 0,
            total_output_frames: 1,
            declick_fade_frames: 1,
            declick_frames_remaining: 0,
            eof: false,
        };

        assert_eq!(reader.pop_current_sample(), Some(0.5));
    }

    #[test]
    fn streaming_clip_reader_preserves_true_start_transient() {
        let audio_buffers = AudioBufferCache::default();
        let source = StreamingAudioSource::from_preloaded(vec![1.0, 0.0], 48_000, 1, false);
        let file_path = source.file_path.clone();
        audio_buffers.insert_for_test(file_path.clone(), source);
        let plan = mixer::PlaybackClipPlan {
            clip_id: "clip".into(),
            track_id: "track".into(),
            file_path,
            clip_gain: 1.0,
            timeline_start_frame: 0,
            duration_frames: 2,
            fade_in_frames: 0,
            fade_out_frames: 0,
            source_start_seconds: 0.0,
            transpose_semitones: 0,
        };

        let reader = StreamingClipReader::open(&plan, 48_000, &audio_buffers, 0)
            .expect("reader should open");

        assert_eq!(reader.declick_frames_remaining, 0);
        assert!(reader.declick_fade_frames > 0);
    }

    #[test]
    fn streaming_clip_reader_starvation_returns_none_without_restarting_declick() {
        let (_producer, consumer) = RingBuffer::<ClipSample>::new(4);
        let (command_sender, _command_receiver) = mpsc::channel();
        let mut reader = StreamingClipReader {
            shared_source: Arc::new(StreamingAudioSource::from_preloaded(
                vec![0.0],
                48_000,
                1,
                false,
            )),
            consumer,
            command_sender,
            output_sample_rate: 48_000,
            current_generation: 0,
            current_source_start_frame: 0,
            emitted_frames: 0,
            total_output_frames: 16,
            declick_fade_frames: 8,
            declick_frames_remaining: 3,
            eof: false,
        };

        assert_eq!(reader.next_stereo_frame(1.0, 0.0), None);
        assert_eq!(reader.declick_frames_remaining, 3);
        assert!(!reader.eof);
    }

    #[test]
    fn raw_ram_source_reads_interleaved_frames_by_absolute_frame() {
        let source = RawRamSource::new(vec![0.1, 0.2, 0.3, 0.4, 0.5, 0.6], 48_000, 2);
        let mut output = [0.0_f32; 4];

        let frames = source.read_interleaved_at(1, &mut output);

        assert_eq!(frames, 2);
        assert_eq!(output, [0.3, 0.4, 0.5, 0.6]);
        assert_eq!(source.frame_count(), 3);
    }

    #[test]
    fn raw_ram_source_out_of_range_returns_zero_frames_without_panic() {
        let source = RawRamSource::new(vec![0.1, 0.2], 48_000, 1);
        let mut output = [1.0_f32; 2];

        let frames = source.read_interleaved_at(8, &mut output);

        assert_eq!(frames, 0);
        assert_eq!(output, [1.0, 1.0]);
    }

    #[test]
    fn raw_disk_source_reads_ltaf_random_access() {
        let temp_dir = tempfile::tempdir().expect("temp dir should exist");
        let path = temp_dir.path().join("cache/audio-renders/source.ltaf");
        RawDiskSource::write_ltaf_for_test(&path, &[0.1, 0.2, 0.3, 0.4, 0.5, 0.6], 48_000, 2)
            .expect("LTAF should write");
        let source = RawDiskSource::open_ltaf(&path).expect("LTAF should open");
        let mut output = [0.0_f32; 4];

        let frames = source.read_interleaved_at(1, &mut output);

        assert_eq!(frames, 2);
        assert_eq!(output, [0.3, 0.4, 0.5, 0.6]);
        assert_eq!(source.sample_rate(), 48_000);
        assert_eq!(source.channels(), 2);
        assert_eq!(source.frame_count(), 3);
    }

    #[test]
    fn prepared_audio_cache_requires_exact_for_transposed_audio() {
        let cache = PreparedAudioCache::default();
        let exact_key = PreparedAudioKey {
            file_id: "file-a".into(),
            file_hash: "hash-a".into(),
            sample_rate: 48_000,
            channels: 1,
            transpose_semitones: 2,
        };
        let original_key = PreparedAudioKey {
            transpose_semitones: 0,
            ..exact_key.clone()
        };
        cache
            .insert_ready_ram(
                original_key,
                Arc::new(RawRamSource::new(vec![0.1, 0.2, 0.3], 48_000, 1)),
            )
            .expect("prepared source should insert");

        let fallback = cache.get_best_available(&exact_key, 1);
        assert_eq!(fallback.kind(), SeekSourceKind::Silence);

        cache
            .insert_ready_ram(
                exact_key.clone(),
                Arc::new(TransposedRamSource::new(vec![0.4, 0.5, 0.6], 48_000, 1)),
            )
            .expect("prepared source should insert");
        let exact = cache.get_best_available(&exact_key, 1);

        assert_eq!(exact.kind(), SeekSourceKind::ExactRam);
    }

    #[test]
    fn prepared_audio_cache_get_best_available_is_non_blocking_on_locked_state() {
        let cache = PreparedAudioCache::default();
        let key = PreparedAudioKey {
            file_id: "file-a".into(),
            file_hash: "hash-a".into(),
            sample_rate: 48_000,
            channels: 1,
            transpose_semitones: 3,
        };
        let _held_lock = cache.states.write().expect("state lock should hold");
        let started_at = Instant::now();

        let decision = cache.get_best_available(&key, 0);

        assert_eq!(decision.kind(), SeekSourceKind::Silence);
        assert!(started_at.elapsed() < Duration::from_millis(10));
    }

    #[test]
    fn prepared_audio_cache_does_not_use_previous_pitch_for_transposed_seek() {
        let cache = PreparedAudioCache::default();
        let old_pitch_key = PreparedAudioKey {
            file_id: "file-a".into(),
            file_hash: "hash-a".into(),
            sample_rate: 48_000,
            channels: 1,
            transpose_semitones: 1,
        };
        let requested_key = PreparedAudioKey {
            transpose_semitones: 4,
            ..old_pitch_key.clone()
        };
        cache
            .insert_ready_ram(
                old_pitch_key,
                Arc::new(TransposedRamSource::new(vec![0.1, 0.2], 48_000, 1)),
            )
            .expect("prepared source should insert");

        let decision = cache.get_best_available(&requested_key, 0);

        assert_eq!(decision.kind(), SeekSourceKind::Silence);
    }

    #[test]
    fn prepared_audio_cache_requires_exact_format_match() {
        let cache = PreparedAudioCache::default();
        let cached_key = PreparedAudioKey {
            file_id: "file-a".into(),
            file_hash: "hash-a".into(),
            sample_rate: 44_100,
            channels: 1,
            transpose_semitones: 0,
        };
        let requested_key = PreparedAudioKey {
            sample_rate: 48_000,
            channels: 2,
            ..cached_key.clone()
        };
        cache
            .insert_ready_ram(
                cached_key,
                Arc::new(RawRamSource::new(vec![0.1, 0.2, 0.3], 44_100, 1)),
            )
            .expect("prepared source should insert");

        assert!(cache.get_exact(&requested_key, 0).is_none());
    }

    #[test]
    fn insert_ready_ram_rejects_mismatched_key_and_source_format() {
        let cache = PreparedAudioCache::default();
        let key = PreparedAudioKey {
            file_id: "file-a".into(),
            file_hash: "hash-a".into(),
            sample_rate: 48_000,
            channels: 2,
            transpose_semitones: 0,
        };

        let error = match cache
            .insert_ready_ram(key, Arc::new(RawRamSource::new(vec![0.1, 0.2], 44_100, 1)))
        {
            Ok(_) => panic!("mismatched source should be rejected"),
            Err(error) => error,
        };

        assert!(error.contains("prepared source format mismatch"));
    }

    #[test]
    fn render_transposed_to_cache_renders_when_prepared_pitch_is_enabled() {
        if !pitch::rubberband_backend_available_for_test() {
            return;
        }
        let temp_dir = tempfile::tempdir().expect("temp dir should exist");
        let output_path = temp_dir.path().join("audio-renders/transposed.ltaf");
        let raw: Arc<dyn PreparedAudioSource> =
            Arc::new(RawRamSource::new(vec![0.1; 4_096], 48_000, 1));
        let key = PreparedAudioKey {
            file_id: "file-a".into(),
            file_hash: "hash-a".into(),
            sample_rate: 48_000,
            channels: 1,
            transpose_semitones: 2,
        };

        let rendered = render_transposed_to_cache(raw, key, output_path)
            .expect("prepared pitch should render");

        assert_eq!(rendered.sample_rate(), 48_000);
        assert_eq!(rendered.channels(), 1);
        assert!(rendered.frame_count() > 0);
    }

    #[test]
    fn render_transposed_to_cache_rejects_mismatched_format() {
        if !pitch::rubberband_backend_available_for_test() {
            return;
        }
        let temp_dir = tempfile::tempdir().expect("temp dir should exist");
        let output_path = temp_dir.path().join("audio-renders/transposed.ltaf");
        let raw: Arc<dyn PreparedAudioSource> =
            Arc::new(RawRamSource::new(vec![0.1; 1_024], 44_100, 1));
        let key = PreparedAudioKey {
            file_id: "file-a".into(),
            file_hash: "hash-a".into(),
            sample_rate: 48_000,
            channels: 2,
            transpose_semitones: 2,
        };

        let error = match render_transposed_to_cache(raw, key, output_path) {
            Ok(_) => panic!("mismatched source should be rejected"),
            Err(error) => error,
        };

        assert!(error.contains("prepared source format mismatch"));
    }

    #[test]
    fn decode_original_to_engine_ram_normalizes_to_output_format() {
        let temp_dir = tempfile::tempdir().expect("temp dir should exist");
        let path = temp_dir.path().join("mono-44100.wav");
        let input = vec![0.25_f32; 44_100];
        write_test_wav(&path, &input, 44_100, 1).expect("wav should write");
        let source = prepare_audio_source(&path).expect("source should prepare");

        let decoded =
            decode_original_to_engine_ram(&source, 48_000, 2).expect("decode should normalize");

        assert_eq!(decoded.sample_rate(), 48_000);
        assert_eq!(decoded.channels(), 2);
        assert_eq!(decoded.frame_count(), 48_000);

        let mut output = vec![0.0_f32; 16];
        let frames = decoded.read_interleaved_at(0, &mut output);
        assert_eq!(frames, 8);
        assert!(output
            .chunks_exact(2)
            .all(|frame| (frame[0] - frame[1]).abs() <= 1e-6));
    }

    #[test]
    fn prepare_window_now_renders_transposed_cache_when_prepared_pitch_is_enabled() {
        if !pitch::rubberband_backend_available_for_test() {
            return;
        }
        let root = tempfile::tempdir().expect("temp dir should exist");
        let song_dir = root.path().join("song");
        std::fs::create_dir_all(song_dir.join("audio")).expect("audio dir should exist");
        let audio_path = song_dir.join("audio/test.wav");
        write_test_wav(&audio_path, &vec![0.25_f32; 48_000], 48_000, 2).expect("wav should write");

        let song = Song {
            id: "song".into(),
            title: "Prepared Pitch Off".into(),
            artist: None,
            key: None,
            bpm: 120.0,
            time_signature: "4/4".into(),
            duration_seconds: 1.0,
            tempo_markers: vec![],
            time_signature_markers: vec![],
            regions: vec![SongRegion {
                id: "region".into(),
                name: "Song".into(),
                start_seconds: 0.0,
                end_seconds: 1.0,
                transpose_semitones: 4,
            }],
            tracks: vec![Track {
                id: "track".into(),
                name: "Track".into(),
                kind: TrackKind::Audio,
                parent_track_id: None,
                volume: 1.0,
                pan: 0.0,
                muted: false,
                solo: false,
                transpose_enabled: true,
                audio_to: "master".to_string(),
            }],
            clips: vec![Clip {
                id: "clip".into(),
                track_id: "track".into(),
                file_path: "audio/test.wav".into(),
                timeline_start_seconds: 0.0,
                source_start_seconds: 0.0,
                duration_seconds: 1.0,
                gain: 1.0,
                fade_in_seconds: None,
                fade_out_seconds: None,
            }],
            section_markers: vec![],
        };

        let cache = AudioBufferCache::default();
        cache
            .replace_song_buffers(&song_dir, &song)
            .expect("song buffers should prepare");
        cache
            .prepare_window_now(&song_dir, &song, 0.0, 4)
            .expect("prepare should not fail");

        let exact_key = PreparedAudioKey {
            file_id: audio_path.to_string_lossy().to_string(),
            file_hash: audio_path.to_string_lossy().to_string(),
            sample_rate: 48_000,
            channels: 2,
            transpose_semitones: 4,
        };
        assert!(cache.prepared_audio.get_exact(&exact_key, 0).is_some());
        assert!(cache.prepared_audio.get_original(&exact_key, 0).is_some());
    }

    #[test]
    fn safe_mode_streaming_reader_bypasses_transpose() {
        with_env_var_for_test("LIBRETRACKS_AUDIO_SAFE_MODE", Some("1"), || {
            let sample_rate = 48_000;
            let total_frames = sample_rate as usize;
            let mut samples = Vec::with_capacity(total_frames);
            for frame in 0..total_frames {
                let radians =
                    2.0 * std::f32::consts::PI * 440.0 * frame as f32 / sample_rate as f32;
                samples.push(radians.sin());
            }

            let audio_buffers = AudioBufferCache::default();
            let source = StreamingAudioSource::from_preloaded(samples, sample_rate, 1, false);
            let file_path = source.file_path.clone();
            audio_buffers.insert_for_test(file_path.clone(), source);

            let bypass_plan = mixer::PlaybackClipPlan {
                clip_id: "clip-bypass".into(),
                track_id: "track-bypass".into(),
                file_path: file_path.clone(),
                clip_gain: 1.0,
                timeline_start_frame: 0,
                duration_frames: total_frames as u64,
                fade_in_frames: 0,
                fade_out_frames: 0,
                source_start_seconds: 0.0,
                transpose_semitones: 0,
            };
            let transposed_plan = mixer::PlaybackClipPlan {
                clip_id: "clip-transposed".into(),
                track_id: "track-transposed".into(),
                file_path,
                clip_gain: 1.0,
                timeline_start_frame: 0,
                duration_frames: total_frames as u64,
                fade_in_frames: 0,
                fade_out_frames: 0,
                source_start_seconds: 0.0,
                transpose_semitones: 7,
            };

            let mut bypass_reader =
                StreamingClipReader::open(&bypass_plan, sample_rate, &audio_buffers, 0)
                    .expect("bypass reader should open");
            let mut transposed_reader =
                StreamingClipReader::open(&transposed_plan, sample_rate, &audio_buffers, 0)
                    .expect("transposed reader should open");
            let mut bypass_mix = vec![0.0_f32; 2_048];
            let mut transposed_mix = vec![0.0_f32; 2_048];

            bypass_reader.mix_into_with_channel_gains(&mut bypass_mix, 0, 2_048, 1, 1.0, 0.0);
            transposed_reader.mix_into_with_channel_gains(
                &mut transposed_mix,
                0,
                2_048,
                1,
                1.0,
                0.0,
            );

            assert_eq!(bypass_mix, transposed_mix);
        });
    }

    #[test]
    fn prepare_manager_orders_realtime_critical_before_playback() {
        let cache = PreparedAudioCache::default();
        let manager = AudioPrepareManager::new(cache.clone());

        manager.request_current_playback_window("song".into(), 1.0, 0);
        manager.request_urgent_window("song".into(), 8.0, 2);

        let queue = cache
            .prepare_queue
            .read()
            .expect("prepare queue should lock");
        assert_eq!(manager.queue_len(), 2);
        assert_eq!(queue[0].priority, PreparePriority::RealtimeCritical);
        assert_eq!(queue[1].priority, PreparePriority::CurrentPlayback);
    }

    #[test]
    fn ram_hot_cache_evicts_low_priority_before_current_windows() {
        let cache = PreparedAudioCache {
            ram_config: RamCacheConfig {
                max_mb: 1,
                min_free_system_mb: 0,
                window_seconds: 5.0,
            },
            ..PreparedAudioCache::default()
        };
        let key = PreparedAudioKey {
            file_id: "file".into(),
            file_hash: "hash".into(),
            sample_rate: 48_000,
            channels: 1,
            transpose_semitones: 0,
        };
        cache.insert_ram_window(
            PreparedWindowKey {
                audio_key: key.clone(),
                start_frame: 0,
                end_frame: 10,
            },
            900 * 1024,
            95,
        );
        cache.insert_ram_window(
            PreparedWindowKey {
                audio_key: key,
                start_frame: 10,
                end_frame: 20,
            },
            900 * 1024,
            20,
        );

        let windows = cache.ram_windows.read().expect("ram windows should lock");
        assert_eq!(windows.len(), 1);
        assert!(windows.values().all(|entry| entry.priority_weight >= 90));
    }

    #[test]
    fn streaming_clip_reader_transposed_start_is_not_latency_delayed() {
        let sample_rate = 48_000;
        let interval_frames = sample_rate as usize;
        let total_frames = sample_rate as usize * 4;
        let click_frames = ((sample_rate as f32) * 0.01).round() as usize;
        let click_frequency_hz = 1_000.0_f32;
        let mut samples = Vec::with_capacity(total_frames);

        for frame in 0..total_frames {
            let phase = frame % interval_frames;
            let sample = if phase < click_frames {
                let envelope = 1.0 - (phase as f32 / click_frames.max(1) as f32);
                let radians = 2.0 * std::f32::consts::PI * click_frequency_hz * phase as f32
                    / sample_rate as f32;
                radians.cos() * envelope
            } else {
                0.0
            };
            samples.push(sample);
        }

        let audio_buffers = AudioBufferCache::default();
        let source = StreamingAudioSource::from_preloaded(samples, sample_rate, 1, false);
        let file_path = source.file_path.clone();
        audio_buffers.insert_for_test(file_path.clone(), source);

        let bypass_plan = mixer::PlaybackClipPlan {
            clip_id: "clip-bypass".into(),
            track_id: "track-bypass".into(),
            file_path: file_path.clone(),
            clip_gain: 1.0,
            timeline_start_frame: 0,
            duration_frames: total_frames as u64,
            fade_in_frames: 0,
            fade_out_frames: 0,
            source_start_seconds: 0.0,
            transpose_semitones: 0,
        };
        let transposed_plan = mixer::PlaybackClipPlan {
            clip_id: "clip-transposed".into(),
            track_id: "track-transposed".into(),
            file_path,
            clip_gain: 1.0,
            timeline_start_frame: 0,
            duration_frames: total_frames as u64,
            fade_in_frames: 0,
            fade_out_frames: 0,
            source_start_seconds: 0.0,
            transpose_semitones: 2,
        };

        let mut bypass_reader =
            StreamingClipReader::open(&bypass_plan, sample_rate, &audio_buffers, 0)
                .expect("bypass reader should open");
        let mut transposed_reader =
            StreamingClipReader::open(&transposed_plan, sample_rate, &audio_buffers, 0)
                .expect("transposed reader should open");

        let mut bypass_mix = vec![0.0_f32; 4_096];
        let mut transposed_mix = vec![0.0_f32; 4_096];
        bypass_reader.mix_into_with_channel_gains(&mut bypass_mix, 0, 4_096, 1, 1.0, 0.0);
        transposed_reader.mix_into_with_channel_gains(&mut transposed_mix, 0, 4_096, 1, 1.0, 0.0);

        let offset = best_envelope_alignment_offset(&bypass_mix, &transposed_mix, 0, 2_048, 64);

        assert!(offset <= 3, "startup offset too large: offset={offset}");
    }

    #[test]
    fn streaming_clip_reader_seek_keeps_transposed_reader_close_to_bypass() {
        let sample_rate = 48_000;
        let interval_frames = sample_rate as usize;
        let total_frames = sample_rate as usize * 30;
        let click_frames = ((sample_rate as f32) * 0.01).round() as usize;
        let click_frequency_hz = 1_000.0_f32;
        let mut samples = Vec::with_capacity(total_frames);

        for frame in 0..total_frames {
            let phase = frame % interval_frames;
            let sample = if phase < click_frames {
                let envelope = 1.0 - (phase as f32 / click_frames.max(1) as f32);
                let radians = 2.0 * std::f32::consts::PI * click_frequency_hz * phase as f32
                    / sample_rate as f32;
                radians.cos() * envelope
            } else {
                0.0
            };
            samples.push(sample);
        }

        let audio_buffers = AudioBufferCache::default();
        let source = StreamingAudioSource::from_preloaded(samples, sample_rate, 1, false);
        let file_path = source.file_path.clone();
        audio_buffers.insert_for_test(file_path.clone(), source);

        let bypass_plan = mixer::PlaybackClipPlan {
            clip_id: "clip-bypass".into(),
            track_id: "track-bypass".into(),
            file_path: file_path.clone(),
            clip_gain: 1.0,
            timeline_start_frame: 0,
            duration_frames: total_frames as u64,
            fade_in_frames: 0,
            fade_out_frames: 0,
            source_start_seconds: 0.0,
            transpose_semitones: 0,
        };
        let transposed_plan = mixer::PlaybackClipPlan {
            clip_id: "clip-transposed".into(),
            track_id: "track-transposed".into(),
            file_path,
            clip_gain: 1.0,
            timeline_start_frame: 0,
            duration_frames: total_frames as u64,
            fade_in_frames: 0,
            fade_out_frames: 0,
            source_start_seconds: 0.0,
            transpose_semitones: 2,
        };

        let mut bypass_reader =
            StreamingClipReader::open(&bypass_plan, sample_rate, &audio_buffers, 0)
                .expect("bypass reader should open");
        let mut transposed_reader =
            StreamingClipReader::open(&transposed_plan, sample_rate, &audio_buffers, 0)
                .expect("transposed reader should open");

        let seek_frame = sample_rate as usize * 10;
        bypass_reader.seek_to(seek_frame);
        transposed_reader.seek_to(seek_frame);

        let mut bypass_mix = vec![0.0_f32; 8_192];
        let mut transposed_mix = vec![0.0_f32; 8_192];
        bypass_reader.mix_into_with_channel_gains(&mut bypass_mix, 0, 8_192, 1, 1.0, 0.0);
        transposed_reader.mix_into_with_channel_gains(&mut transposed_mix, 0, 8_192, 1, 1.0, 0.0);

        let offset = best_envelope_alignment_offset(&bypass_mix, &transposed_mix, 0, 2_048, 64);

        assert!(offset <= 3, "seek offset too large: offset={offset}");
    }
}
