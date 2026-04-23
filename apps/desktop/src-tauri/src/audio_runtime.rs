use std::{
    collections::{HashMap, HashSet},
    fs::File,
    io::ErrorKind,
    mem::size_of,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError, Sender},
        Arc, RwLock,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use cpal::{
    traits::{DeviceTrait, HostTrait, StreamTrait},
    Device, SampleFormat, Stream, StreamConfig,
};
use libretracks_core::{Song, Track, TrackKind};
use rayon::prelude::*;
use rtrb::{Consumer, Producer, RingBuffer};
use serde::Serialize;
use symphonia::core::{
    audio::{AudioBufferRef, SampleBuffer},
    codecs::{Decoder, DecoderOptions, CODEC_TYPE_NULL},
    errors::Error as SymphoniaError,
    formats::{FormatOptions, FormatReader},
    io::MediaSourceStream,
    meta::MetadataOptions,
    probe::Hint,
};
use tauri::{AppHandle, Emitter};

use crate::state::DesktopError;

const PCM_RING_CAPACITY_FRAMES: usize = 4_096;
const DISK_RENDER_BLOCK_FRAMES: usize = 512;
const AUDIO_PRELOAD_SECONDS: f64 = 2.0;
const GAIN_EPSILON: f32 = 0.000_001;
const AUDIO_METER_EVENT: &str = "audio:meters";
const AUDIO_METER_EMIT_INTERVAL: Duration = Duration::from_millis(16);
const AUDIO_COMMAND_RESPONSE_TIMEOUT: Duration = Duration::from_millis(250);
const MAX_HIERARCHY_DEPTH: usize = 16;

type SharedAppHandle = Arc<RwLock<Option<AppHandle>>>;
type SharedTrackMixState = Arc<RwLock<HashMap<String, LiveTrackMix>>>;

#[derive(Debug, Clone)]
struct LiveTrackMix {
    parent_track_id: Option<String>,
    kind: TrackKind,
    volume: f32,
    pan: f32,
    muted: bool,
    solo: bool,
}

pub struct AudioRuntime {
    session: Option<PlaybackSession>,
    audio_buffers: AudioBufferCache,
    app_handle: SharedAppHandle,
    live_mix_state: SharedTrackMixState,
}

pub struct AudioController {
    sender: Sender<AudioCommand>,
    audio_buffers: AudioBufferCache,
    app_handle: SharedAppHandle,
    live_mix_state: SharedTrackMixState,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioMeterLevel {
    pub track_id: String,
    pub left_peak: f32,
    pub right_peak: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PlaybackStartReason {
    InitialPlay,
    ResumePlay,
    Seek,
    ImmediateJump,
    TimelineWindow,
    StructureRebuild,
    TransportResync,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AudioCommandKind {
    Play,
    Seek,
    SyncSong,
    Stop,
    DebugSnapshot,
    Shutdown,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDebugSnapshot {
    pub enabled: bool,
    pub log_commands: bool,
    pub command_count: u64,
    pub last_command: Option<AudioCommandTrace>,
    pub last_restart: Option<AudioOperationSummary>,
    pub last_sync: Option<AudioOperationSummary>,
    pub last_stop: Option<AudioStopSummary>,
    pub runtime_state: AudioRuntimeStateSummary,
    pub playhead: AudioPlayheadEstimate,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioCommandTrace {
    pub kind: String,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioOperationSummary {
    pub reason: Option<String>,
    pub elapsed_ms: f64,
    pub scheduled_clips: usize,
    pub active_sinks: usize,
    pub opened_files: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioStopSummary {
    pub elapsed_ms: f64,
    pub stopped_sinks: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioRuntimeStateSummary {
    pub active_sinks: usize,
    pub files_opened_last_restart: usize,
    pub last_scheduled_clips: usize,
    pub cached_audio_buffers: usize,
    pub fully_cached_audio_buffers: usize,
    pub cached_audio_preload_bytes: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioPlayheadEstimate {
    pub running: bool,
    pub anchor_position_seconds: Option<f64>,
    pub estimated_position_seconds: Option<f64>,
    pub song_duration_seconds: Option<f64>,
    pub anchor_age_ms: Option<f64>,
    pub last_start_reason: Option<String>,
}

#[derive(Debug, Clone)]
struct RestartReport {
    elapsed: Duration,
    scheduled_clips: usize,
    active_sinks: usize,
    opened_files: usize,
    cache_stats: AudioBufferCacheStats,
}

#[derive(Debug, Clone, Copy, Default)]
struct AudioBufferCacheStats {
    cached_buffers: usize,
    fully_cached_buffers: usize,
    preload_bytes: usize,
}

#[derive(Debug, Clone)]
struct SyncReport {
    elapsed: Duration,
    updated_sinks: usize,
    active_sinks: usize,
}

#[derive(Debug, Clone)]
struct StopReport {
    elapsed: Duration,
    stopped_sinks: usize,
}

#[derive(Debug, Clone, Copy)]
struct AudioDebugConfig {
    enabled: bool,
    log_commands: bool,
}

#[derive(Debug, Clone)]
struct AudioDebugState {
    config: AudioDebugConfig,
    command_count: u64,
    last_command: Option<AudioCommandTrace>,
    last_restart: Option<AudioOperationSummary>,
    last_sync: Option<AudioOperationSummary>,
    last_stop: Option<AudioStopSummary>,
    runtime_state: AudioRuntimeStateSummary,
    playback_anchor_position_seconds: Option<f64>,
    playback_anchor_started_at: Option<Instant>,
    playback_song_duration_seconds: Option<f64>,
    last_start_reason: Option<PlaybackStartReason>,
}

enum AudioCommand {
    Play {
        song_dir: PathBuf,
        song: Song,
        position_seconds: f64,
        reason: PlaybackStartReason,
        respond_to: Sender<Result<(), String>>,
    },
    Seek {
        song: Song,
        position_seconds: f64,
        reason: PlaybackStartReason,
        respond_to: Sender<Result<(), String>>,
    },
    SyncSong {
        song: Song,
        respond_to: Sender<Result<(), String>>,
    },
    Stop {
        respond_to: Sender<Result<(), String>>,
    },
    DebugSnapshot {
        respond_to: Sender<AudioDebugSnapshot>,
    },
    Shutdown,
}

struct PlaybackSession {
    backend: PlaybackBackend,
    reader_sender: Option<Sender<ReaderCommand>>,
    reader_handle: Option<JoinHandle<DiskReaderReport>>,
    seek_generation: Arc<AtomicU64>,
    audio_buffers: AudioBufferCache,
}

enum PlaybackBackend {
    Cpal { _stream: Stream },
    Null,
}

enum ReaderCommand {
    UpdateSong(Song),
    Seek {
        song: Song,
        position_seconds: f64,
        generation: u64,
    },
    Stop,
}

#[derive(Default)]
struct DiskReaderReport;

#[derive(Debug, Clone)]
struct PlaybackClipPlan {
    #[cfg_attr(not(test), allow(dead_code))]
    clip_id: String,
    track_id: String,
    file_path: PathBuf,
    clip_gain: f32,
    timeline_start_frame: u64,
    duration_frames: u64,
    fade_in_frames: u64,
    fade_out_frames: u64,
    source_start_seconds: f64,
}

#[derive(Debug)]
struct SharedAudioSource {
    file_path: PathBuf,
    preload_samples: Vec<f32>,
    preload_frame_count: usize,
    sample_rate: u32,
    channels: usize,
    fully_cached: bool,
}

#[derive(Clone, Default)]
struct AudioBufferCache {
    entries: Arc<RwLock<HashMap<PathBuf, Arc<SharedAudioSource>>>>,
}

struct DiskReaderState {
    mixer: Mixer,
    producer: Producer<OutputSample>,
    command_receiver: Receiver<ReaderCommand>,
    current_generation: u64,
}

#[derive(Clone, Copy)]
struct OutputSample {
    generation: u64,
    value: f32,
}

struct Mixer {
    song: Song,
    live_mix_state: SharedTrackMixState,
    cached_live_mix: LiveMixSnapshot,
    audio_buffers: AudioBufferCache,
    output_sample_rate: u32,
    output_channels: usize,
    timeline_cursor_frame: u64,
    song_duration_frames: u64,
    next_plan_index: usize,
    plans: Vec<PlaybackClipPlan>,
    active_clips: Vec<MixClipState>,
    debug_config: AudioDebugConfig,
    opened_files: usize,
    track_meter_indices: HashMap<String, usize>,
    track_child_indices: Vec<Vec<usize>>,
    meter_emitter: MeterEmitterState,
}

struct MixClipState {
    plan: PlaybackClipPlan,
    reader: MemoryClipReader,
    current_gain: f32,
    current_pan: f32,
}

#[derive(Clone, Default)]
struct LiveMixSnapshot {
    tracks: HashMap<String, LiveTrackMix>,
    is_any_track_soloed: bool,
}

struct MeterEmitterState {
    app_handle: SharedAppHandle,
    pending_track_meters: Vec<AudioMeterLevel>,
    last_emit_at: Option<Instant>,
}

struct MemoryClipReader {
    shared_source: Arc<SharedAudioSource>,
    output_sample_rate: u32,
    current_frame: usize,
    source_frame_cursor: f64,
    eof: bool,
    streaming_reader: Option<StreamingAudioReader>,
}

struct OpenAudioSource {
    format: Box<dyn FormatReader>,
    decoder: Box<dyn Decoder>,
    track_id: u32,
    sample_rate: u32,
    channels: usize,
}

struct StreamingAudioReader {
    source: OpenAudioSource,
    decoded_samples: Vec<f32>,
    decoded_start_frame: usize,
    decoded_frame_count: usize,
    next_source_frame: usize,
    eof: bool,
}

impl PlaybackClipPlan {
    fn timeline_end_frame(&self) -> u64 {
        self.timeline_start_frame
            .saturating_add(self.duration_frames)
    }

    fn edge_gain(&self, clip_frame_position: u64) -> f32 {
        let fade_in_gain = if self.fade_in_frames == 0 || clip_frame_position >= self.fade_in_frames
        {
            1.0
        } else {
            clip_frame_position as f32 / self.fade_in_frames as f32
        };

        let remaining_frames = self.duration_frames.saturating_sub(clip_frame_position);
        let fade_out_gain = if self.fade_out_frames == 0 || remaining_frames >= self.fade_out_frames
        {
            1.0
        } else {
            remaining_frames as f32 / self.fade_out_frames as f32
        };

        fade_in_gain.min(fade_out_gain).clamp(0.0, 1.0)
    }
}

impl LiveTrackMix {
    fn from_track(track: &Track) -> Self {
        Self {
            parent_track_id: track.parent_track_id.clone(),
            kind: track.kind,
            volume: track.volume as f32,
            pan: track.pan as f32,
            muted: track.muted,
            solo: track.solo,
        }
    }
}

impl LiveMixSnapshot {
    fn from_tracks(tracks: &HashMap<String, LiveTrackMix>) -> Self {
        Self {
            tracks: tracks.clone(),
            is_any_track_soloed: tracks.values().any(|track| track.solo),
        }
    }

    fn from_song(song: &Song) -> Self {
        let tracks = build_live_mix_map(song);
        Self {
            is_any_track_soloed: tracks.values().any(|track| track.solo),
            tracks,
        }
    }
}

impl SharedAudioSource {
    fn preload_frame_count(&self) -> usize {
        self.preload_frame_count
    }

    fn preload_bytes(&self) -> usize {
        self.preload_samples.len().saturating_mul(size_of::<f32>())
    }

    fn read_preloaded_sample(
        &self,
        frame_index: usize,
        channel: usize,
        output_channels: usize,
    ) -> f32 {
        if frame_index >= self.preload_frame_count {
            return 0.0;
        }

        let sample_index = frame_index.saturating_mul(self.channels);
        if sample_index >= self.preload_samples.len() {
            return 0.0;
        }

        if output_channels == 1 && self.channels > 1 {
            let left = self.preload_samples[sample_index];
            let right = self.preload_samples[sample_index + 1.min(self.channels - 1)];
            return (left + right) * 0.5;
        }

        let source_channel = if self.channels == 1 {
            0
        } else {
            channel.min(self.channels - 1)
        };

        self.preload_samples[sample_index + source_channel]
    }
}

impl AudioBufferCache {
    fn replace_song_buffers(&self, song_dir: &Path, song: &Song) -> Result<(), String> {
        let mut unique_paths = Vec::new();
        let mut seen_paths = HashSet::new();

        for clip in &song.clips {
            let file_path = song_dir.join(&clip.file_path);
            if seen_paths.insert(file_path.clone()) {
                unique_paths.push(file_path);
            }
        }

        unique_paths.sort();

        let existing_entries = self
            .entries
            .read()
            .map_err(|_| "audio buffer cache lock poisoned".to_string())?;
        let mut next_entries = HashMap::with_capacity(unique_paths.len());
        let mut missing_paths = Vec::new();

        for file_path in unique_paths {
            if let Some(buffer) = existing_entries.get(&file_path) {
                next_entries.insert(file_path.clone(), Arc::clone(buffer));
            } else {
                missing_paths.push(file_path);
            }
        }

        drop(existing_entries);

        let prepared_entries = missing_paths
            .into_par_iter()
            .map(|file_path| {
                prepare_audio_source(&file_path).map(|source| (file_path, Arc::new(source)))
            })
            .collect::<Result<Vec<_>, _>>()?;

        for (file_path, prepared_source) in prepared_entries {
            next_entries.insert(file_path, prepared_source);
        }

        let mut entries = self
            .entries
            .write()
            .map_err(|_| "audio buffer cache lock poisoned".to_string())?;
        *entries = next_entries;

        Ok(())
    }

    fn get(&self, file_path: &Path) -> Result<Option<Arc<SharedAudioSource>>, String> {
        let entries = self
            .entries
            .read()
            .map_err(|_| "audio buffer cache lock poisoned".to_string())?;
        Ok(entries.get(file_path).cloned())
    }

    fn stats(&self) -> AudioBufferCacheStats {
        self.entries
            .read()
            .map(|entries| AudioBufferCacheStats {
                cached_buffers: entries.len(),
                fully_cached_buffers: entries
                    .values()
                    .filter(|source| source.fully_cached)
                    .count(),
                preload_bytes: entries.values().map(|source| source.preload_bytes()).sum(),
            })
            .unwrap_or_default()
    }
}

impl Default for AudioRuntimeStateSummary {
    fn default() -> Self {
        Self {
            active_sinks: 0,
            files_opened_last_restart: 0,
            last_scheduled_clips: 0,
            cached_audio_buffers: 0,
            fully_cached_audio_buffers: 0,
            cached_audio_preload_bytes: 0,
        }
    }
}

impl AudioDebugConfig {
    fn from_env() -> Self {
        Self {
            enabled: env_flag("LIBRETRACKS_AUDIO_DEBUG"),
            log_commands: env_flag("LIBRETRACKS_AUDIO_LOG_COMMANDS"),
        }
    }
}

impl AudioDebugState {
    fn new(config: AudioDebugConfig) -> Self {
        Self {
            config,
            command_count: 0,
            last_command: None,
            last_restart: None,
            last_sync: None,
            last_stop: None,
            runtime_state: AudioRuntimeStateSummary::default(),
            playback_anchor_position_seconds: None,
            playback_anchor_started_at: None,
            playback_song_duration_seconds: None,
            last_start_reason: None,
        }
    }

    fn record_command(&mut self, kind: AudioCommandKind, reason: Option<String>) {
        let kind_label = command_kind_label(kind);

        self.command_count += 1;
        self.last_command = Some(AudioCommandTrace {
            kind: kind_label.to_string(),
            reason: reason.clone(),
        });

        if self.config.log_commands {
            match reason {
                Some(reason) => {
                    eprintln!("[libretracks-audio] command={kind_label} reason={reason}")
                }
                None => eprintln!("[libretracks-audio] command={kind_label}"),
            }
        }
    }

    fn record_restart(
        &mut self,
        reason: PlaybackStartReason,
        position_seconds: f64,
        song_duration_seconds: f64,
        report: &RestartReport,
    ) {
        self.runtime_state.active_sinks = report.active_sinks;
        self.runtime_state.files_opened_last_restart = report.opened_files;
        self.runtime_state.last_scheduled_clips = report.scheduled_clips;
        self.runtime_state.cached_audio_buffers = report.cache_stats.cached_buffers;
        self.runtime_state.fully_cached_audio_buffers = report.cache_stats.fully_cached_buffers;
        self.runtime_state.cached_audio_preload_bytes = report.cache_stats.preload_bytes;
        self.playback_anchor_position_seconds =
            Some(position_seconds.clamp(0.0, song_duration_seconds));
        self.playback_anchor_started_at = Some(Instant::now());
        self.playback_song_duration_seconds = Some(song_duration_seconds.max(0.0));
        self.last_start_reason = Some(reason);

        if !self.config.enabled {
            return;
        }

        self.last_restart = Some(AudioOperationSummary {
            reason: Some(playback_reason_label(reason).to_string()),
            elapsed_ms: report.elapsed.as_secs_f64() * 1000.0,
            scheduled_clips: report.scheduled_clips,
            active_sinks: report.active_sinks,
            opened_files: report.opened_files,
        });
    }

    fn record_sync(&mut self, report: &SyncReport) {
        self.runtime_state.active_sinks = report.active_sinks;

        if !self.config.enabled {
            return;
        }

        self.last_sync = Some(AudioOperationSummary {
            reason: Some("memory_mix".to_string()),
            elapsed_ms: report.elapsed.as_secs_f64() * 1000.0,
            scheduled_clips: report.updated_sinks,
            active_sinks: report.active_sinks,
            opened_files: 0,
        });
    }

    fn record_seek(
        &mut self,
        reason: PlaybackStartReason,
        position_seconds: f64,
        song_duration_seconds: f64,
        active_sinks: usize,
    ) {
        self.runtime_state.active_sinks = active_sinks;
        self.playback_anchor_position_seconds =
            Some(position_seconds.clamp(0.0, song_duration_seconds));
        self.playback_anchor_started_at = Some(Instant::now());
        self.playback_song_duration_seconds = Some(song_duration_seconds.max(0.0));
        self.last_start_reason = Some(reason);
    }

    fn record_stop(&mut self, report: &StopReport, active_sinks_after_stop: usize) {
        self.runtime_state.active_sinks = active_sinks_after_stop;
        self.playback_anchor_position_seconds = self.estimated_position_seconds();
        self.playback_anchor_started_at = None;

        if !self.config.enabled {
            return;
        }

        self.last_stop = Some(AudioStopSummary {
            elapsed_ms: report.elapsed.as_secs_f64() * 1000.0,
            stopped_sinks: report.stopped_sinks,
        });
    }

    fn snapshot(&self) -> AudioDebugSnapshot {
        AudioDebugSnapshot {
            enabled: self.config.enabled,
            log_commands: self.config.log_commands,
            command_count: self.command_count,
            last_command: self.last_command.clone(),
            last_restart: self.last_restart.clone(),
            last_sync: self.last_sync.clone(),
            last_stop: self.last_stop.clone(),
            runtime_state: self.runtime_state.clone(),
            playhead: AudioPlayheadEstimate {
                running: self.playback_anchor_started_at.is_some(),
                anchor_position_seconds: self.playback_anchor_position_seconds,
                estimated_position_seconds: self.estimated_position_seconds(),
                song_duration_seconds: self.playback_song_duration_seconds,
                anchor_age_ms: self
                    .playback_anchor_started_at
                    .map(|started_at| started_at.elapsed().as_secs_f64() * 1000.0),
                last_start_reason: self
                    .last_start_reason
                    .map(playback_reason_label)
                    .map(str::to_string),
            },
        }
    }

    fn estimated_position_seconds(&self) -> Option<f64> {
        let anchor_position = self.playback_anchor_position_seconds?;
        let estimated_position = match self.playback_anchor_started_at {
            Some(started_at) => anchor_position + started_at.elapsed().as_secs_f64(),
            None => anchor_position,
        };

        Some(match self.playback_song_duration_seconds {
            Some(song_duration_seconds) => estimated_position.clamp(0.0, song_duration_seconds),
            None => estimated_position.max(0.0),
        })
    }
}

impl AudioRuntime {
    fn new(
        audio_buffers: AudioBufferCache,
        app_handle: SharedAppHandle,
        live_mix_state: SharedTrackMixState,
    ) -> Self {
        Self {
            session: None,
            audio_buffers,
            app_handle,
            live_mix_state,
        }
    }

    fn stop_all(&mut self) -> StopReport {
        let started_at = Instant::now();
        let stopped_sinks = usize::from(self.session.is_some());

        if let Some(session) = self.session.take() {
            let _ = session.stop();
        }

        StopReport {
            elapsed: started_at.elapsed(),
            stopped_sinks,
        }
    }

    fn restart(
        &mut self,
        song_dir: &Path,
        song: &Song,
        position_seconds: f64,
        debug_config: AudioDebugConfig,
    ) -> Result<RestartReport, String> {
        let started_at = Instant::now();
        self.stop_all();

        let scheduled_clips = scheduled_clip_count(song, position_seconds);
        let session = PlaybackSession::start(
            song_dir.to_path_buf(),
            song.clone(),
            position_seconds,
            self.app_handle.clone(),
            self.live_mix_state.clone(),
            debug_config,
            self.audio_buffers.clone(),
        )?;
        let cache_stats = session.cache_stats();

        self.session = Some(session);

        Ok(RestartReport {
            elapsed: started_at.elapsed(),
            scheduled_clips,
            active_sinks: 1,
            opened_files: 0,
            cache_stats,
        })
    }

    fn sync_song(&mut self, song: &Song) -> Result<SyncReport, String> {
        let started_at = Instant::now();
        let updated_sinks = match self.session.as_mut() {
            Some(session) => usize::from(session.update_song(song.clone())?),
            None => 0,
        };

        Ok(SyncReport {
            elapsed: started_at.elapsed(),
            updated_sinks,
            active_sinks: usize::from(self.session.is_some()),
        })
    }

    fn seek(&mut self, song: &Song, position_seconds: f64) -> Result<usize, String> {
        let updated_sinks = match self.session.as_mut() {
            Some(session) => usize::from(session.seek(song.clone(), position_seconds)?),
            None => 0,
        };
        Ok(updated_sinks)
    }
}

impl AudioController {
    pub fn new() -> Self {
        let (sender, receiver) = mpsc::channel();
        let debug_config = AudioDebugConfig::from_env();
        let audio_buffers = AudioBufferCache::default();
        let app_handle = Arc::new(RwLock::new(None));
        let live_mix_state = Arc::new(RwLock::new(HashMap::new()));
        let runtime_audio_buffers = audio_buffers.clone();
        let runtime_app_handle = app_handle.clone();
        let runtime_live_mix_state = live_mix_state.clone();

        thread::Builder::new()
            .name("libretracks-audio".into())
            .spawn(move || {
                run_audio_thread(
                    receiver,
                    debug_config,
                    runtime_audio_buffers,
                    runtime_app_handle,
                    runtime_live_mix_state,
                )
            })
            .expect("audio thread should start");

        Self {
            sender,
            audio_buffers,
            app_handle,
            live_mix_state,
        }
    }

    pub fn attach_app_handle(&self, app_handle: AppHandle) {
        if let Ok(mut shared_app_handle) = self.app_handle.write() {
            *shared_app_handle = Some(app_handle);
        }
    }

    pub fn play(
        &self,
        song_dir: PathBuf,
        song: Song,
        position_seconds: f64,
        reason: PlaybackStartReason,
    ) -> Result<(), DesktopError> {
        self.sync_live_mix(&song)?;
        self.request(|respond_to| AudioCommand::Play {
            song_dir,
            song,
            position_seconds,
            reason,
            respond_to,
        })
    }

    pub fn seek(
        &self,
        song: Song,
        position_seconds: f64,
        reason: PlaybackStartReason,
    ) -> Result<(), DesktopError> {
        self.sync_live_mix(&song)?;
        self.request(|respond_to| AudioCommand::Seek {
            song,
            position_seconds,
            reason,
            respond_to,
        })
    }

    #[allow(dead_code)]
    pub fn sync_song(&self, song: Song) -> Result<(), DesktopError> {
        self.sync_live_mix(&song)?;
        self.request(|respond_to| AudioCommand::SyncSong { song, respond_to })
    }

    pub fn sync_live_mix(&self, song: &Song) -> Result<(), DesktopError> {
        replace_shared_live_mix(&self.live_mix_state, song).map_err(DesktopError::AudioCommand)
    }

    pub fn ensure_live_track(&self, song: &Song, track_id: &str) -> Result<(), DesktopError> {
        let has_track = self
            .live_mix_state
            .read()
            .map_err(|_| DesktopError::AudioCommand("live mix state lock poisoned".into()))?
            .contains_key(track_id);
        if !has_track {
            self.sync_live_mix(song)?;
        }
        Ok(())
    }

    pub fn update_live_track_mix(
        &self,
        track_id: &str,
        volume: Option<f64>,
        pan: Option<f64>,
        muted: Option<bool>,
        solo: Option<bool>,
    ) -> Result<(), DesktopError> {
        update_shared_track_mix(&self.live_mix_state, track_id, volume, pan, muted, solo)
            .map_err(DesktopError::AudioCommand)
    }

    pub fn stop(&self) -> Result<(), DesktopError> {
        self.request(|respond_to| AudioCommand::Stop { respond_to })
    }

    pub fn debug_snapshot(&self) -> Result<AudioDebugSnapshot, DesktopError> {
        let (respond_to, response) = mpsc::channel();

        self.sender
            .send(AudioCommand::DebugSnapshot { respond_to })
            .map_err(|_| DesktopError::AudioThreadUnavailable)?;

        recv_audio_response(response)
    }

    pub fn replace_song_buffers(&self, song_dir: &Path, song: &Song) -> Result<(), DesktopError> {
        self.audio_buffers
            .replace_song_buffers(song_dir, song)
            .map_err(DesktopError::AudioCommand)
    }

    fn request(
        &self,
        command: impl FnOnce(Sender<Result<(), String>>) -> AudioCommand,
    ) -> Result<(), DesktopError> {
        let (respond_to, response) = mpsc::channel();

        self.sender
            .send(command(respond_to))
            .map_err(|_| DesktopError::AudioThreadUnavailable)?;

        recv_audio_response(response)?.map_err(DesktopError::AudioCommand)
    }
}

impl Default for AudioController {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for AudioController {
    fn drop(&mut self) {
        let _ = self.sender.send(AudioCommand::Shutdown);
    }
}

impl PlaybackSession {
    fn start(
        song_dir: PathBuf,
        song: Song,
        position_seconds: f64,
        app_handle: SharedAppHandle,
        live_mix_state: SharedTrackMixState,
        debug_config: AudioDebugConfig,
        audio_buffers: AudioBufferCache,
    ) -> Result<Self, String> {
        let host = cpal::default_host();
        let Some(device) = host.default_output_device() else {
            eprintln!("[libretracks-audio] no default output device available, using null backend");
            return Ok(Self {
                backend: PlaybackBackend::Null,
                reader_sender: None,
                reader_handle: None,
                seek_generation: Arc::new(AtomicU64::new(0)),
                audio_buffers,
            });
        };

        let supported_config = device
            .default_output_config()
            .map_err(|error| error.to_string())?;
        let sample_format = supported_config.sample_format();
        let config: StreamConfig = supported_config.into();
        let output_channels = usize::from(config.channels.max(1));
        let output_sample_rate = config.sample_rate.0.max(1);
        let ring_capacity_samples = PCM_RING_CAPACITY_FRAMES.saturating_mul(output_channels.max(1));
        let (producer, consumer) = RingBuffer::<OutputSample>::new(ring_capacity_samples);
        let (reader_sender, reader_receiver) = mpsc::channel();
        let seek_generation = Arc::new(AtomicU64::new(0));

        let reader_handle = spawn_disk_reader(DiskReaderState {
            mixer: Mixer::new(
                song_dir.clone(),
                song.clone(),
                position_seconds,
                output_sample_rate,
                output_channels,
                app_handle,
                live_mix_state,
                debug_config,
                audio_buffers.clone(),
            ),
            producer,
            command_receiver: reader_receiver,
            current_generation: 0,
        });

        let stream = build_output_stream(
            &device,
            &config,
            sample_format,
            consumer,
            seek_generation.clone(),
        )?;
        stream.play().map_err(|error| error.to_string())?;

        Ok(Self {
            backend: PlaybackBackend::Cpal { _stream: stream },
            reader_sender: Some(reader_sender),
            reader_handle: Some(reader_handle),
            seek_generation,
            audio_buffers,
        })
    }

    fn cache_stats(&self) -> AudioBufferCacheStats {
        self.audio_buffers.stats()
    }

    fn update_song(&mut self, song: Song) -> Result<bool, String> {
        if let Some(reader_sender) = &self.reader_sender {
            reader_sender
                .send(ReaderCommand::UpdateSong(song))
                .map_err(|_| "disk reader thread is unavailable".to_string())?;
            return Ok(true);
        }

        Ok(false)
    }

    fn seek(&mut self, song: Song, position_seconds: f64) -> Result<bool, String> {
        let generation = self
            .seek_generation
            .fetch_add(1, Ordering::AcqRel)
            .saturating_add(1);

        if let Some(reader_sender) = &self.reader_sender {
            reader_sender
                .send(ReaderCommand::Seek {
                    song,
                    position_seconds,
                    generation,
                })
                .map_err(|_| "disk reader thread is unavailable".to_string())?;
            return Ok(true);
        }

        Ok(matches!(self.backend, PlaybackBackend::Null))
    }

    fn stop(mut self) -> DiskReaderReport {
        if let Some(reader_sender) = self.reader_sender.take() {
            let _ = reader_sender.send(ReaderCommand::Stop);
        }

        self.reader_handle
            .take()
            .and_then(|handle| handle.join().ok())
            .unwrap_or_default()
    }
}

impl MemoryClipReader {
    fn open(
        plan: &PlaybackClipPlan,
        output_sample_rate: u32,
        audio_buffers: &AudioBufferCache,
        timeline_frame: u64,
    ) -> Result<Self, String> {
        let shared_source = audio_buffers
            .get(&plan.file_path)?
            .ok_or_else(|| format!("audio buffer is not cached: {}", plan.file_path.display()))?;
        let mut reader = Self {
            shared_source,
            output_sample_rate: output_sample_rate.max(1),
            current_frame: 0,
            source_frame_cursor: 0.0,
            eof: false,
            streaming_reader: None,
        };
        let source_start_frame = source_frame_for_timeline_position(
            plan,
            timeline_frame,
            output_sample_rate,
            reader.shared_source.sample_rate,
        );
        reader.seek_to_internal(source_start_frame)?;
        Ok(reader)
    }

    fn seek_to(&mut self, target_frame: usize) {
        let _ = self.seek_to_internal(target_frame);
    }

    fn seek_to_internal(&mut self, target_frame: usize) -> Result<(), String> {
        self.current_frame = target_frame;
        self.source_frame_cursor = self.current_frame as f64;
        self.eof = false;

        if self.shared_source.fully_cached {
            self.streaming_reader = None;
            self.eof = self.current_frame >= self.shared_source.preload_frame_count();
            return Ok(());
        }

        if target_frame < self.shared_source.preload_frame_count() {
            self.streaming_reader = None;
            return Ok(());
        }

        self.streaming_reader = Some(StreamingAudioReader::open(
            &self.shared_source.file_path,
            target_frame,
        )?);
        Ok(())
    }

    fn mix_into_with_channel_gains(
        &mut self,
        buffer: &mut [f32],
        offset_frames: usize,
        frame_count: usize,
        output_channels: usize,
        gain: f32,
        pan: f32,
    ) -> (f32, f32) {
        if self.eof {
            return (0.0, 0.0);
        }

        let frame_step = self.shared_source.sample_rate as f64 / self.output_sample_rate as f64;
        let mut left_peak = 0.0_f32;
        let mut right_peak = 0.0_f32;
        let pan = pan.clamp(-1.0, 1.0);

        for frame_offset in 0..frame_count {
            if !self.ensure_frame_available(self.current_frame) {
                self.eof = true;
                break;
            }

            if gain.abs() > GAIN_EPSILON {
                let buffer_base = (offset_frames + frame_offset) * output_channels;
                if output_channels <= 1 {
                    let mono_sample =
                        self.read_sample(self.current_frame, 0, output_channels) * gain;
                    buffer[buffer_base] += mono_sample;
                    let mono_peak = mono_sample.abs();
                    left_peak = left_peak.max(mono_peak);
                    right_peak = right_peak.max(mono_peak);
                } else {
                    let left_input = self.read_sample(self.current_frame, 0, 2);
                    let right_input = if self.shared_source.channels > 1 {
                        self.read_sample(self.current_frame, 1, 2)
                    } else {
                        left_input
                    };
                    let (mut left_output, mut right_output) = apply_runtime_pan(
                        left_input,
                        right_input,
                        pan,
                        self.shared_source.channels,
                    );
                    left_output *= gain;
                    right_output *= gain;

                    buffer[buffer_base] += left_output;
                    buffer[buffer_base + 1] += right_output;
                    left_peak = left_peak.max(left_output.abs());
                    right_peak = right_peak.max(right_output.abs());
                }
            }

            self.source_frame_cursor += frame_step;
            self.current_frame = self.source_frame_cursor.round().max(0.0) as usize;
        }

        if self.shared_source.fully_cached
            && self.current_frame >= self.shared_source.preload_frame_count()
        {
            self.eof = true;
        }

        (left_peak, right_peak)
    }

    fn ensure_frame_available(&mut self, frame_index: usize) -> bool {
        if frame_index < self.shared_source.preload_frame_count() {
            return true;
        }

        if self.shared_source.fully_cached {
            return false;
        }

        if self.streaming_reader.is_none() {
            match StreamingAudioReader::open(&self.shared_source.file_path, frame_index) {
                Ok(reader) => self.streaming_reader = Some(reader),
                Err(error) => {
                    eprintln!(
                        "[libretracks-audio] failed to open streaming reader for {}: {error}",
                        self.shared_source.file_path.display()
                    );
                    return false;
                }
            }
        }

        self.streaming_reader
            .as_mut()
            .is_some_and(|reader| reader.ensure_frame_available(frame_index))
    }

    fn read_sample(&self, frame_index: usize, channel: usize, output_channels: usize) -> f32 {
        if frame_index < self.shared_source.preload_frame_count() {
            return self
                .shared_source
                .read_preloaded_sample(frame_index, channel, output_channels);
        }

        self.streaming_reader
            .as_ref()
            .map(|reader| reader.read_sample(frame_index, channel, output_channels))
            .unwrap_or(0.0)
    }
}

fn append_decoded_samples(target: &mut Vec<f32>, decoded: AudioBufferRef<'_>) {
    let mut sample_buffer = SampleBuffer::<f32>::new(decoded.capacity() as u64, *decoded.spec());
    sample_buffer.copy_interleaved_ref(decoded);
    target.extend_from_slice(sample_buffer.samples());
}

fn decoded_samples_from_ref(decoded: AudioBufferRef<'_>) -> Vec<f32> {
    let mut samples = Vec::new();
    append_decoded_samples(&mut samples, decoded);
    samples
}

fn source_start_seconds_floor(seconds: f64) -> f64 {
    if seconds.is_finite() && seconds > 0.0 {
        seconds
    } else {
        0.0
    }
}

fn source_frame_for_timeline_position(
    plan: &PlaybackClipPlan,
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

fn open_audio_source(file_path: &Path) -> Result<OpenAudioSource, String> {
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
            &FormatOptions::default(),
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
        .ok_or_else(|| "no decodable audio track found".to_string())?;

    let sample_rate = track
        .codec_params
        .sample_rate
        .ok_or_else(|| "audio track sample rate is unavailable".to_string())?;
    let channels = track
        .codec_params
        .channels
        .map(|channels| channels.count())
        .unwrap_or(1);
    let track_id = track.id;
    let decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|error| error.to_string())?;

    Ok(OpenAudioSource {
        format,
        decoder,
        track_id,
        sample_rate,
        channels,
    })
}

fn prepare_audio_source(file_path: &Path) -> Result<SharedAudioSource, String> {
    let mut source = open_audio_source(file_path)?;
    let preload_frame_limit = (source.sample_rate as f64 * AUDIO_PRELOAD_SECONDS)
        .ceil()
        .max(1.0) as usize;
    let preload_sample_limit = preload_frame_limit.saturating_mul(source.channels.max(1));
    let mut preload_samples = Vec::new();
    let mut fully_cached = false;

    loop {
        let packet = match source.format.next_packet() {
            Ok(packet) => packet,
            Err(SymphoniaError::IoError(error)) if error.kind() == ErrorKind::UnexpectedEof => {
                fully_cached = true;
                break;
            }
            Err(error) => return Err(error.to_string()),
        };

        if packet.track_id() != source.track_id {
            continue;
        }

        let decoded = match source.decoder.decode(&packet) {
            Ok(decoded) => decoded,
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(SymphoniaError::IoError(error)) if error.kind() == ErrorKind::UnexpectedEof => {
                fully_cached = true;
                break;
            }
            Err(error) => return Err(error.to_string()),
        };

        append_decoded_samples(&mut preload_samples, decoded);
        if preload_samples.len() >= preload_sample_limit {
            preload_samples.truncate(preload_sample_limit);
            break;
        }
    }

    let preload_frame_count = preload_samples.len() / source.channels.max(1);

    Ok(SharedAudioSource {
        file_path: file_path.to_path_buf(),
        preload_samples,
        preload_frame_count,
        sample_rate: source.sample_rate.max(1),
        channels: source.channels.max(1),
        fully_cached,
    })
}

impl StreamingAudioReader {
    fn open(file_path: &Path, target_frame: usize) -> Result<Self, String> {
        let source = open_audio_source(file_path)?;
        let mut reader = Self {
            source,
            decoded_samples: Vec::new(),
            decoded_start_frame: 0,
            decoded_frame_count: 0,
            next_source_frame: 0,
            eof: false,
        };
        let _ = reader.ensure_frame_available(target_frame);
        Ok(reader)
    }

    fn ensure_frame_available(&mut self, frame_index: usize) -> bool {
        while !self.eof {
            let decoded_end_frame = self
                .decoded_start_frame
                .saturating_add(self.decoded_frame_count);
            if frame_index >= self.decoded_start_frame && frame_index < decoded_end_frame {
                return true;
            }

            if !self.decode_next_chunk() {
                break;
            }
        }

        let decoded_end_frame = self
            .decoded_start_frame
            .saturating_add(self.decoded_frame_count);
        frame_index >= self.decoded_start_frame && frame_index < decoded_end_frame
    }

    fn decode_next_chunk(&mut self) -> bool {
        loop {
            let packet = match self.source.format.next_packet() {
                Ok(packet) => packet,
                Err(SymphoniaError::IoError(error)) if error.kind() == ErrorKind::UnexpectedEof => {
                    self.eof = true;
                    self.decoded_frame_count = 0;
                    return false;
                }
                Err(_) => {
                    self.eof = true;
                    self.decoded_frame_count = 0;
                    return false;
                }
            };

            if packet.track_id() != self.source.track_id {
                continue;
            }

            let decoded = match self.source.decoder.decode(&packet) {
                Ok(decoded) => decoded,
                Err(SymphoniaError::DecodeError(_)) => continue,
                Err(SymphoniaError::IoError(error)) if error.kind() == ErrorKind::UnexpectedEof => {
                    self.eof = true;
                    self.decoded_frame_count = 0;
                    return false;
                }
                Err(_) => {
                    self.eof = true;
                    self.decoded_frame_count = 0;
                    return false;
                }
            };

            let decoded_samples = decoded_samples_from_ref(decoded);
            let decoded_frame_count = decoded_samples.len() / self.source.channels.max(1);
            self.decoded_start_frame = self.next_source_frame;
            self.decoded_frame_count = decoded_frame_count;
            self.next_source_frame = self.next_source_frame.saturating_add(decoded_frame_count);
            self.decoded_samples = decoded_samples;
            return decoded_frame_count > 0;
        }
    }

    fn read_sample(&self, frame_index: usize, channel: usize, output_channels: usize) -> f32 {
        if frame_index < self.decoded_start_frame
            || frame_index
                >= self
                    .decoded_start_frame
                    .saturating_add(self.decoded_frame_count)
        {
            return 0.0;
        }

        let local_frame_index = frame_index - self.decoded_start_frame;
        let sample_index = local_frame_index.saturating_mul(self.source.channels);
        if sample_index >= self.decoded_samples.len() {
            return 0.0;
        }

        if output_channels == 1 && self.source.channels > 1 {
            let left = self.decoded_samples[sample_index];
            let right = self.decoded_samples[sample_index + 1.min(self.source.channels - 1)];
            return (left + right) * 0.5;
        }

        let source_channel = if self.source.channels == 1 {
            0
        } else {
            channel.min(self.source.channels - 1)
        };

        self.decoded_samples[sample_index + source_channel]
    }
}

fn spawn_disk_reader(state: DiskReaderState) -> JoinHandle<DiskReaderReport> {
    thread::Builder::new()
        .name("libretracks-disk-reader".into())
        .spawn(move || run_disk_reader(state))
        .expect("disk reader thread should start")
}

fn build_output_stream(
    device: &Device,
    config: &StreamConfig,
    sample_format: SampleFormat,
    consumer: Consumer<OutputSample>,
    seek_generation: Arc<AtomicU64>,
) -> Result<Stream, String> {
    let error_callback = |error| eprintln!("[libretracks-audio] cpal stream error: {error}");

    match sample_format {
        SampleFormat::F32 => {
            let mut consumer = consumer;
            let seek_generation = seek_generation.clone();
            let mut active_generation = seek_generation.load(Ordering::Acquire);
            device
                .build_output_stream(
                    config,
                    move |data: &mut [f32], _| {
                        drain_consumer_samples(
                            data,
                            &mut consumer,
                            &seek_generation,
                            &mut active_generation,
                            |sample| sample,
                        )
                    },
                    error_callback,
                    None,
                )
                .map_err(|error| error.to_string())
        }
        SampleFormat::I16 => {
            let mut consumer = consumer;
            let seek_generation = seek_generation.clone();
            let mut active_generation = seek_generation.load(Ordering::Acquire);
            device
                .build_output_stream(
                    config,
                    move |data: &mut [i16], _| {
                        drain_consumer_samples(
                            data,
                            &mut consumer,
                            &seek_generation,
                            &mut active_generation,
                            |sample| (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16,
                        )
                    },
                    error_callback,
                    None,
                )
                .map_err(|error| error.to_string())
        }
        SampleFormat::U16 => {
            let mut consumer = consumer;
            let seek_generation = seek_generation.clone();
            let mut active_generation = seek_generation.load(Ordering::Acquire);
            device
                .build_output_stream(
                    config,
                    move |data: &mut [u16], _| {
                        drain_consumer_samples(
                            data,
                            &mut consumer,
                            &seek_generation,
                            &mut active_generation,
                            |sample| {
                                (((sample.clamp(-1.0, 1.0) * 0.5) + 0.5) * u16::MAX as f32) as u16
                            },
                        )
                    },
                    error_callback,
                    None,
                )
                .map_err(|error| error.to_string())
        }
        other => Err(format!("unsupported output sample format: {other:?}")),
    }
}

fn drain_consumer_samples<T>(
    data: &mut [T],
    consumer: &mut Consumer<OutputSample>,
    seek_generation: &Arc<AtomicU64>,
    active_generation: &mut u64,
    convert: impl Fn(f32) -> T,
) where
    T: Copy,
{
    let latest_generation = seek_generation.load(Ordering::Acquire);
    if latest_generation != *active_generation {
        while consumer.pop().is_ok() {}
        *active_generation = latest_generation;
    }

    for output in data {
        let sample = match consumer.pop() {
            Ok(sample) if sample.generation == *active_generation => sample.value,
            Ok(_) | Err(_) => 0.0,
        };
        *output = convert(sample);
    }
}

fn run_audio_thread(
    receiver: Receiver<AudioCommand>,
    debug_config: AudioDebugConfig,
    audio_buffers: AudioBufferCache,
    app_handle: SharedAppHandle,
    live_mix_state: SharedTrackMixState,
) {
    let mut runtime: Option<AudioRuntime> = None;
    let mut debug_state = AudioDebugState::new(debug_config);
    let mut deferred_command: Option<AudioCommand> = None;

    while let Some(command) = next_audio_command(&receiver, &mut deferred_command) {
        match command {
            AudioCommand::Play {
                song_dir,
                song,
                position_seconds,
                reason,
                respond_to,
            } => {
                debug_state.record_command(
                    AudioCommandKind::Play,
                    Some(playback_reason_label(reason).to_string()),
                );

                let result =
                    ensure_runtime(&mut runtime, &audio_buffers, &app_handle, &live_mix_state)
                        .restart(&song_dir, &song, position_seconds, debug_config)
                        .map(|report| {
                            debug_state.record_restart(
                                reason,
                                position_seconds,
                                song.duration_seconds,
                                &report,
                            );
                        });

                let _ = respond_to.send(result);
            }
            AudioCommand::Seek {
                song,
                position_seconds,
                reason,
                respond_to,
            } => {
                debug_state.record_command(
                    AudioCommandKind::Seek,
                    Some(playback_reason_label(reason).to_string()),
                );

                let result =
                    ensure_runtime(&mut runtime, &audio_buffers, &app_handle, &live_mix_state)
                        .seek(&song, position_seconds)
                        .map(|active_sinks| {
                            debug_state.record_seek(
                                reason,
                                position_seconds,
                                song.duration_seconds,
                                active_sinks.max(1),
                            );
                        });

                let _ = respond_to.send(result);
            }
            AudioCommand::SyncSong { song, respond_to } => {
                let (song, respond_tos, next_deferred) =
                    coalesce_sync_song_commands(&receiver, song, respond_to);
                deferred_command = next_deferred;

                debug_state
                    .record_command(AudioCommandKind::SyncSong, Some("mix_only".to_string()));

                let result =
                    ensure_runtime(&mut runtime, &audio_buffers, &app_handle, &live_mix_state)
                        .sync_song(&song)
                        .map(|report| {
                            debug_state.record_sync(&report);
                        });

                for respond_to in respond_tos {
                    let _ = respond_to.send(result.clone());
                }
            }
            AudioCommand::Stop { respond_to } => {
                debug_state.record_command(AudioCommandKind::Stop, None);

                let report = if let Some(runtime) = runtime.as_mut() {
                    runtime.stop_all()
                } else {
                    StopReport {
                        elapsed: Duration::ZERO,
                        stopped_sinks: 0,
                    }
                };

                debug_state.record_stop(&report, 0);

                let _ = respond_to.send(Ok(()));
            }
            AudioCommand::DebugSnapshot { respond_to } => {
                debug_state.record_command(AudioCommandKind::DebugSnapshot, None);
                let _ = respond_to.send(debug_state.snapshot());
            }
            AudioCommand::Shutdown => {
                debug_state.record_command(AudioCommandKind::Shutdown, None);
                if let Some(runtime) = runtime.as_mut() {
                    runtime.stop_all();
                }
                break;
            }
        }
    }
}

fn ensure_runtime<'a>(
    runtime: &'a mut Option<AudioRuntime>,
    audio_buffers: &AudioBufferCache,
    app_handle: &SharedAppHandle,
    live_mix_state: &SharedTrackMixState,
) -> &'a mut AudioRuntime {
    runtime.get_or_insert_with(|| {
        AudioRuntime::new(
            audio_buffers.clone(),
            app_handle.clone(),
            live_mix_state.clone(),
        )
    })
}

fn next_audio_command(
    receiver: &Receiver<AudioCommand>,
    deferred_command: &mut Option<AudioCommand>,
) -> Option<AudioCommand> {
    match deferred_command.take() {
        Some(command) => Some(command),
        None => receiver.recv().ok(),
    }
}

fn coalesce_sync_song_commands(
    receiver: &Receiver<AudioCommand>,
    mut latest_song: Song,
    initial_respond_to: Sender<Result<(), String>>,
) -> (Song, Vec<Sender<Result<(), String>>>, Option<AudioCommand>) {
    let mut respond_tos = vec![initial_respond_to];
    let mut deferred_command = None;

    while let Ok(command) = receiver.try_recv() {
        match command {
            AudioCommand::SyncSong { song, respond_to } => {
                latest_song = song;
                respond_tos.push(respond_to);
            }
            other => {
                deferred_command = Some(other);
                break;
            }
        }
    }

    (latest_song, respond_tos, deferred_command)
}

fn run_disk_reader(mut state: DiskReaderState) -> DiskReaderReport {
    while state.mixer.timeline_cursor_frame < state.mixer.song_duration_frames {
        if state.consume_commands() {
            break;
        }

        let free_frames = state.producer.slots() / state.mixer.output_channels.max(1);
        if free_frames == 0 {
            thread::yield_now();
            continue;
        }

        let remaining_frames =
            (state.mixer.song_duration_frames - state.mixer.timeline_cursor_frame) as usize;
        let block_frames = DISK_RENDER_BLOCK_FRAMES
            .min(free_frames)
            .min(remaining_frames);
        if block_frames == 0 {
            break;
        }

        let block = state.mixer.render_next_block(block_frames);
        if !push_block_into_ring(&mut state.producer, &block, state.current_generation) {
            break;
        }
    }

    DiskReaderReport
}

impl DiskReaderState {
    fn consume_commands(&mut self) -> bool {
        let mut should_stop = false;

        while let Ok(command) = self.command_receiver.try_recv() {
            match command {
                ReaderCommand::UpdateSong(song) => self.mixer.apply_song_update(song),
                ReaderCommand::Seek {
                    song,
                    position_seconds,
                    generation,
                } => {
                    self.mixer.seek(song, position_seconds);
                    self.current_generation = generation;
                }
                ReaderCommand::Stop => should_stop = true,
            }
        }

        should_stop
    }
}

impl Mixer {
    fn new(
        song_dir: PathBuf,
        song: Song,
        position_seconds: f64,
        output_sample_rate: u32,
        output_channels: usize,
        app_handle: SharedAppHandle,
        live_mix_state: SharedTrackMixState,
        debug_config: AudioDebugConfig,
        audio_buffers: AudioBufferCache,
    ) -> Self {
        let _ = replace_shared_live_mix(&live_mix_state, &song);
        let plans = build_playback_plans(&song_dir, &song, output_sample_rate);
        let track_meter_indices = song
            .tracks
            .iter()
            .enumerate()
            .map(|(index, track)| (track.id.clone(), index))
            .collect();
        let track_child_indices = vec![Vec::new(); song.tracks.len()];
        let mut mixer = Self {
            song,
            live_mix_state,
            cached_live_mix: LiveMixSnapshot::default(),
            audio_buffers,
            output_sample_rate,
            output_channels,
            timeline_cursor_frame: 0,
            song_duration_frames: 0,
            next_plan_index: 0,
            plans,
            active_clips: Vec::new(),
            debug_config,
            opened_files: 0,
            track_meter_indices,
            track_child_indices,
            meter_emitter: MeterEmitterState::new(app_handle),
        };
        mixer.cached_live_mix = LiveMixSnapshot::from_song(&mixer.song);
        mixer.seek(mixer.song.clone(), position_seconds);
        mixer
    }

    fn apply_song_update(&mut self, song: Song) {
        let _ = replace_shared_live_mix(&self.live_mix_state, &song);
        self.song = song;
        self.cached_live_mix = LiveMixSnapshot::from_song(&self.song);
        self.rebuild_track_meter_indices();
    }

    fn seek(&mut self, song: Song, position_seconds: f64) {
        let _ = replace_shared_live_mix(&self.live_mix_state, &song);
        self.song = song;
        self.cached_live_mix = LiveMixSnapshot::from_song(&self.song);
        self.rebuild_track_meter_indices();
        self.song_duration_frames =
            seconds_to_frames(self.song.duration_seconds, self.output_sample_rate);
        self.timeline_cursor_frame = seconds_to_frames(position_seconds, self.output_sample_rate)
            .min(self.song_duration_frames);
        self.next_plan_index = self
            .plans
            .partition_point(|plan| plan.timeline_end_frame() <= self.timeline_cursor_frame);
        self.active_clips.clear();
        self.opened_files = 0;
        self.activate_due_clips(
            self.timeline_cursor_frame
                .saturating_add(DISK_RENDER_BLOCK_FRAMES as u64),
        );
    }

    fn render_next_block(&mut self, block_frames: usize) -> Vec<f32> {
        let block_start = self.timeline_cursor_frame;
        let block_end = block_start + block_frames as u64;
        let mut mixed = vec![0.0_f32; block_frames * self.output_channels.max(1)];
        let should_capture_track_meters = self.meter_emitter.is_enabled();
        let mut track_meters = should_capture_track_meters.then(|| self.empty_track_meters());

        self.refresh_cached_live_mix();
        self.activate_due_clips(block_end);
        {
            let live_mix_state = &self.cached_live_mix.tracks;
            let is_any_track_soloed = self.cached_live_mix.is_any_track_soloed;

            for clip_state in &mut self.active_clips {
                let overlap_start = block_start.max(clip_state.plan.timeline_start_frame);
                let overlap_end = block_end.min(clip_state.plan.timeline_end_frame());
                if overlap_end <= overlap_start {
                    continue;
                }

                let offset_frames = (overlap_start - block_start) as usize;
                let overlap_frames = (overlap_end - overlap_start) as usize;
                let target_gain = resolve_clip_runtime_gain(
                    live_mix_state,
                    &clip_state.plan.track_id,
                    clip_state.plan.clip_gain,
                    is_any_track_soloed,
                );
                let target_pan =
                    resolve_track_runtime_pan(live_mix_state, &clip_state.plan.track_id);
                let parent_gain =
                    resolve_parent_track_runtime_gain(live_mix_state, &clip_state.plan.track_id)
                        .unwrap_or(1.0);

                let (left_peak, right_peak) = clip_state.mix_into(
                    &mut mixed,
                    offset_frames,
                    overlap_frames,
                    self.output_channels,
                    overlap_start,
                    target_gain,
                    target_pan,
                );

                if let Some(index) = track_meters.as_ref().and_then(|_| {
                    self.track_meter_indices
                        .get(clip_state.plan.track_id.as_str())
                        .copied()
                }) {
                    if let Some(track_meter_levels) = track_meters.as_mut() {
                        let meter_left_peak = if parent_gain.abs() <= GAIN_EPSILON {
                            0.0
                        } else {
                            left_peak / parent_gain
                        };
                        let meter_right_peak = if parent_gain.abs() <= GAIN_EPSILON {
                            0.0
                        } else {
                            right_peak / parent_gain
                        };
                        track_meter_levels[index].left_peak =
                            track_meter_levels[index].left_peak.max(meter_left_peak);
                        track_meter_levels[index].right_peak =
                            track_meter_levels[index].right_peak.max(meter_right_peak);
                    }
                }
            }
        }

        if let Some(track_meter_levels) = track_meters.as_mut() {
            self.roll_up_folder_track_meters(track_meter_levels);
        }

        if let Some(track_meter_levels) = track_meters.as_ref() {
            self.meter_emitter.emit(track_meter_levels);
        }

        self.active_clips.retain(|clip_state| {
            !clip_state.reader.eof && block_end < clip_state.plan.timeline_end_frame()
        });
        self.timeline_cursor_frame += block_frames as u64;

        mixed
    }

    fn activate_due_clips(&mut self, window_end_frame: u64) {
        let activation_start_frame = self.timeline_cursor_frame;
        while self.next_plan_index < self.plans.len()
            && self.plans[self.next_plan_index].timeline_start_frame < window_end_frame
        {
            let plan = self.plans[self.next_plan_index].clone();
            self.next_plan_index += 1;

            if plan.timeline_end_frame() <= activation_start_frame {
                continue;
            }

            match MemoryClipReader::open(
                &plan,
                self.output_sample_rate,
                &self.audio_buffers,
                activation_start_frame,
            ) {
                Ok(reader) => {
                    let current_gain = resolve_clip_runtime_gain(
                        &self.cached_live_mix.tracks,
                        &plan.track_id,
                        plan.clip_gain,
                        self.cached_live_mix.is_any_track_soloed,
                    );
                    let current_pan =
                        resolve_track_runtime_pan(&self.cached_live_mix.tracks, &plan.track_id);
                    self.active_clips.push(MixClipState {
                        plan,
                        reader,
                        current_gain,
                        current_pan,
                    });
                }
                Err(error) => {
                    if self.debug_config.enabled || self.debug_config.log_commands {
                        eprintln!("[libretracks-audio] failed to open clip reader: {error}");
                    }
                }
            }
        }
    }

    fn rebuild_track_meter_indices(&mut self) {
        self.track_meter_indices = self
            .song
            .tracks
            .iter()
            .enumerate()
            .map(|(index, track)| (track.id.clone(), index))
            .collect();
        self.track_child_indices = vec![Vec::new(); self.song.tracks.len()];

        for (child_index, track) in self.song.tracks.iter().enumerate() {
            let Some(parent_track_id) = track.parent_track_id.as_deref() else {
                continue;
            };
            let Some(&parent_index) = self.track_meter_indices.get(parent_track_id) else {
                continue;
            };
            self.track_child_indices[parent_index].push(child_index);
        }
    }

    fn empty_track_meters(&self) -> Vec<AudioMeterLevel> {
        self.song
            .tracks
            .iter()
            .map(|track| AudioMeterLevel {
                track_id: track.id.clone(),
                left_peak: 0.0,
                right_peak: 0.0,
            })
            .collect()
    }

    fn roll_up_folder_track_meters(&self, track_meters: &mut [AudioMeterLevel]) {
        for track_index in (0..self.song.tracks.len()).rev() {
            let track = &self.song.tracks[track_index];
            if track.kind != TrackKind::Folder {
                continue;
            }

            let mut left_peak = 0.0_f32;
            let mut right_peak = 0.0_f32;

            for &child_index in &self.track_child_indices[track_index] {
                left_peak = left_peak.max(track_meters[child_index].left_peak);
                right_peak = right_peak.max(track_meters[child_index].right_peak);
            }

            let folder_gain = self
                .cached_live_mix
                .tracks
                .get(track.id.as_str())
                .map(|track_mix| track_mix.volume.clamp(0.0, 1.0))
                .unwrap_or(0.0);
            track_meters[track_index].left_peak = (left_peak * folder_gain).clamp(0.0, 1.0);
            track_meters[track_index].right_peak = (right_peak * folder_gain).clamp(0.0, 1.0);
        }
    }

    fn refresh_cached_live_mix(&mut self) {
        if let Ok(live_mix_state) = self.live_mix_state.try_read() {
            self.cached_live_mix = LiveMixSnapshot::from_tracks(&live_mix_state);
        }
    }
}

impl MeterEmitterState {
    fn new(app_handle: SharedAppHandle) -> Self {
        Self {
            app_handle,
            pending_track_meters: Vec::new(),
            last_emit_at: None,
        }
    }

    fn is_enabled(&self) -> bool {
        self.app_handle
            .read()
            .ok()
            .and_then(|app_handle| app_handle.as_ref().cloned())
            .is_some()
    }

    fn emit(&mut self, track_meters: &[AudioMeterLevel]) {
        let Some(app_handle) = self
            .app_handle
            .read()
            .ok()
            .and_then(|app_handle| app_handle.as_ref().cloned())
        else {
            return;
        };

        self.accumulate(track_meters);

        let now = Instant::now();
        let should_emit = match self.last_emit_at {
            Some(last_emit_at) => now.duration_since(last_emit_at) >= AUDIO_METER_EMIT_INTERVAL,
            None => true,
        };

        if !should_emit {
            return;
        }

        self.last_emit_at = Some(now);

        if let Err(error) = app_handle.emit(AUDIO_METER_EVENT, self.pending_track_meters.clone()) {
            eprintln!("[libretracks-audio] failed to emit audio meters: {error}");
        }

        self.pending_track_meters.clear();
    }

    fn accumulate(&mut self, track_meters: &[AudioMeterLevel]) {
        if self.pending_track_meters.len() != track_meters.len()
            || self
                .pending_track_meters
                .iter()
                .zip(track_meters)
                .any(|(pending, next)| pending.track_id != next.track_id)
        {
            self.pending_track_meters = track_meters.to_vec();
            return;
        }

        for (pending_meter, next_meter) in self.pending_track_meters.iter_mut().zip(track_meters) {
            pending_meter.left_peak = pending_meter.left_peak.max(next_meter.left_peak);
            pending_meter.right_peak = pending_meter.right_peak.max(next_meter.right_peak);
        }
    }
}

impl MixClipState {
    fn mix_into(
        &mut self,
        buffer: &mut [f32],
        offset_frames: usize,
        frame_count: usize,
        output_channels: usize,
        overlap_start_frame: u64,
        target_gain: f32,
        target_pan: f32,
    ) -> (f32, f32) {
        let start_gain = self.current_gain;
        let start_pan = self.current_pan;
        let mut left_peak = 0.0_f32;
        let mut right_peak = 0.0_f32;

        for frame_offset in 0..frame_count {
            let dynamic_gain =
                interpolated_gain(start_gain, target_gain, frame_offset, frame_count);
            let dynamic_pan = interpolated_gain(start_pan, target_pan, frame_offset, frame_count);
            let clip_frame_position =
                (overlap_start_frame - self.plan.timeline_start_frame) + frame_offset as u64;
            let edge_gain = self.plan.edge_gain(clip_frame_position);

            let (frame_left_peak, frame_right_peak) = self.reader.mix_into_with_channel_gains(
                buffer,
                offset_frames + frame_offset,
                1,
                output_channels,
                dynamic_gain * edge_gain,
                dynamic_pan,
            );
            left_peak = left_peak.max(frame_left_peak);
            right_peak = right_peak.max(frame_right_peak);
        }

        self.current_gain = target_gain;
        self.current_pan = target_pan;

        (left_peak, right_peak)
    }
}

fn interpolated_gain(
    start_gain: f32,
    target_gain: f32,
    frame_offset: usize,
    frame_count: usize,
) -> f32 {
    if (target_gain - start_gain).abs() <= GAIN_EPSILON {
        return target_gain;
    }

    if frame_count == 0 {
        return start_gain;
    }

    if frame_count == 1 {
        return target_gain;
    }

    let gain_ratio = frame_offset as f32 / frame_count.saturating_sub(1) as f32;
    start_gain + (target_gain - start_gain) * gain_ratio
}

fn recv_audio_response<T>(response: Receiver<T>) -> Result<T, DesktopError> {
    response
        .recv_timeout(AUDIO_COMMAND_RESPONSE_TIMEOUT)
        .map_err(map_audio_response_error)
}

fn map_audio_response_error(error: RecvTimeoutError) -> DesktopError {
    match error {
        RecvTimeoutError::Timeout => DesktopError::AudioCommand(format!(
            "audio thread did not respond within {} ms",
            AUDIO_COMMAND_RESPONSE_TIMEOUT.as_millis()
        )),
        RecvTimeoutError::Disconnected => DesktopError::AudioThreadUnavailable,
    }
}

fn push_block_into_ring(
    producer: &mut Producer<OutputSample>,
    block: &[f32],
    generation: u64,
) -> bool {
    for &sample in block {
        if producer
            .push(OutputSample {
                generation,
                value: sample,
            })
            .is_err()
        {
            return false;
        }
    }

    true
}

fn build_playback_plans(
    song_dir: &Path,
    song: &Song,
    output_sample_rate: u32,
) -> Vec<PlaybackClipPlan> {
    let mut plans = Vec::new();

    for clip in &song.clips {
        if clip.duration_seconds <= 0.0 {
            continue;
        }

        plans.push(PlaybackClipPlan {
            clip_id: clip.id.clone(),
            track_id: clip.track_id.clone(),
            file_path: song_dir.join(&clip.file_path),
            clip_gain: clip.gain as f32,
            timeline_start_frame: seconds_to_frames(
                clip.timeline_start_seconds,
                output_sample_rate,
            ),
            duration_frames: seconds_to_frames(clip.duration_seconds, output_sample_rate),
            fade_in_frames: clip
                .fade_in_seconds
                .map(|seconds| seconds_to_frames(seconds, output_sample_rate))
                .unwrap_or(0),
            fade_out_frames: clip
                .fade_out_seconds
                .map(|seconds| seconds_to_frames(seconds, output_sample_rate))
                .unwrap_or(0),
            source_start_seconds: clip.source_start_seconds,
        });
    }

    plans.sort_by_key(|plan| plan.timeline_start_frame);
    plans
}

fn apply_runtime_pan(
    left_input: f32,
    right_input: f32,
    pan: f32,
    source_channels: usize,
) -> (f32, f32) {
    let pan = pan.clamp(-1.0, 1.0);

    if source_channels <= 1 {
        if pan < 0.0 {
            (left_input, right_input * (1.0 - pan.abs()))
        } else if pan > 0.0 {
            (left_input * (1.0 - pan), right_input)
        } else {
            (left_input, right_input)
        }
    } else if pan < 0.0 {
        let fold = pan.abs();
        (left_input + right_input * fold, right_input * (1.0 - fold))
    } else if pan > 0.0 {
        (left_input * (1.0 - pan), right_input + left_input * pan)
    } else {
        (left_input, right_input)
    }
}

fn scheduled_clip_count(song: &Song, position_seconds: f64) -> usize {
    song.clips
        .iter()
        .filter(|clip| clip.timeline_start_seconds + clip.duration_seconds > position_seconds)
        .count()
}

#[cfg(test)]
fn probe_audio_file(file_path: &Path) -> Result<(), String> {
    let prepared = prepare_audio_source(file_path)?;
    (prepared.preload_frame_count() > 0)
        .then_some(())
        .ok_or_else(|| "empty audio stream".to_string())
}

fn build_live_mix_map(song: &Song) -> HashMap<String, LiveTrackMix> {
    song.tracks
        .iter()
        .map(|track| (track.id.clone(), LiveTrackMix::from_track(track)))
        .collect()
}

fn replace_shared_live_mix(
    shared_mix_state: &SharedTrackMixState,
    song: &Song,
) -> Result<(), String> {
    let mut live_mix_state = shared_mix_state
        .write()
        .map_err(|_| "live mix state lock poisoned".to_string())?;
    *live_mix_state = build_live_mix_map(song);
    Ok(())
}

fn update_shared_track_mix(
    shared_mix_state: &SharedTrackMixState,
    track_id: &str,
    volume: Option<f64>,
    pan: Option<f64>,
    muted: Option<bool>,
    solo: Option<bool>,
) -> Result<(), String> {
    let mut live_mix_state = shared_mix_state
        .write()
        .map_err(|_| "live mix state lock poisoned".to_string())?;
    let track_mix = live_mix_state
        .get_mut(track_id)
        .ok_or_else(|| format!("track not found: {track_id}"))?;

    if let Some(volume) = volume {
        track_mix.volume = volume.clamp(0.0, 1.0) as f32;
    }

    if let Some(pan) = pan {
        track_mix.pan = pan.clamp(-1.0, 1.0) as f32;
    }

    if let Some(muted) = muted {
        track_mix.muted = muted;
    }

    if let Some(solo) = solo {
        track_mix.solo = solo;
    }

    Ok(())
}

fn resolve_clip_runtime_gain(
    live_mix_state: &HashMap<String, LiveTrackMix>,
    track_id: &str,
    clip_gain: f32,
    is_any_track_soloed: bool,
) -> f32 {
    resolve_track_clip_gain(live_mix_state, track_id, clip_gain, is_any_track_soloed).unwrap_or(0.0)
}

fn resolve_track_runtime_pan(
    live_mix_state: &HashMap<String, LiveTrackMix>,
    track_id: &str,
) -> f32 {
    let Some(track) = live_mix_state.get(track_id) else {
        return 0.0;
    };

    let mut pan = track.pan;
    let mut cursor = track.parent_track_id.as_deref();
    let mut depth = 0;

    while let Some(parent_track_id) = cursor {
        if depth >= MAX_HIERARCHY_DEPTH {
            return 0.0;
        }

        let Some(parent_track) = live_mix_state.get(parent_track_id) else {
            return 0.0;
        };

        if parent_track.kind != TrackKind::Folder {
            return 0.0;
        }

        pan += parent_track.pan;
        cursor = parent_track.parent_track_id.as_deref();
        depth += 1;
    }

    pan.clamp(-1.0, 1.0)
}

fn resolve_parent_track_runtime_gain(
    live_mix_state: &HashMap<String, LiveTrackMix>,
    track_id: &str,
) -> Option<f32> {
    let track = live_mix_state.get(track_id)?;
    let mut gain = 1.0_f32;
    let mut cursor = track.parent_track_id.as_deref();
    let mut depth = 0;

    while let Some(parent_track_id) = cursor {
        if depth >= MAX_HIERARCHY_DEPTH {
            return None;
        }

        let parent_track = live_mix_state.get(parent_track_id)?;
        if parent_track.kind != TrackKind::Folder {
            return None;
        }

        gain *= parent_track.volume;
        cursor = parent_track.parent_track_id.as_deref();
        depth += 1;
    }

    Some(gain)
}

fn resolve_track_clip_gain(
    live_mix_state: &HashMap<String, LiveTrackMix>,
    track_id: &str,
    clip_gain: f32,
    is_any_track_soloed: bool,
) -> Option<f32> {
    let track = live_mix_state.get(track_id)?;

    if is_any_track_soloed && !is_track_soloed_in_hierarchy(live_mix_state, track) {
        return Some(0.0);
    }

    if track.muted {
        return Some(0.0);
    }

    let mut gain = track.volume;
    let mut cursor = track.parent_track_id.as_deref();
    let mut depth = 0;

    while let Some(parent_track_id) = cursor {
        if depth >= MAX_HIERARCHY_DEPTH {
            return None;
        }

        let parent_track = live_mix_state.get(parent_track_id)?;
        if parent_track.kind != TrackKind::Folder {
            return None;
        }

        if parent_track.muted {
            return Some(0.0);
        }

        gain *= parent_track.volume;
        cursor = parent_track.parent_track_id.as_deref();
        depth += 1;
    }

    Some(gain * clip_gain)
}

fn is_track_soloed_in_hierarchy(
    live_mix_state: &HashMap<String, LiveTrackMix>,
    track: &LiveTrackMix,
) -> bool {
    if track.solo {
        return true;
    }

    let mut cursor = track.parent_track_id.as_deref();
    let mut depth = 0;

    while let Some(parent_track_id) = cursor {
        if depth >= MAX_HIERARCHY_DEPTH {
            return false;
        }

        let Some(parent_track) = live_mix_state.get(parent_track_id) else {
            return false;
        };

        if parent_track.kind != TrackKind::Folder {
            return false;
        }

        if parent_track.solo {
            return true;
        }

        cursor = parent_track.parent_track_id.as_deref();
        depth += 1;
    }

    false
}

fn seconds_to_frames(seconds: f64, sample_rate: u32) -> u64 {
    (seconds.max(0.0) * sample_rate.max(1) as f64).round() as u64
}

fn env_flag(name: &str) -> bool {
    std::env::var(name)
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

fn playback_reason_label(reason: PlaybackStartReason) -> &'static str {
    match reason {
        PlaybackStartReason::InitialPlay => "initial_play",
        PlaybackStartReason::ResumePlay => "resume_play",
        PlaybackStartReason::Seek => "seek",
        PlaybackStartReason::ImmediateJump => "immediate_jump",
        PlaybackStartReason::TimelineWindow => "timeline_window",
        PlaybackStartReason::StructureRebuild => "structure_rebuild",
        PlaybackStartReason::TransportResync => "transport_resync",
    }
}

fn command_kind_label(kind: AudioCommandKind) -> &'static str {
    match kind {
        AudioCommandKind::Play => "play",
        AudioCommandKind::Seek => "seek",
        AudioCommandKind::SyncSong => "sync_song",
        AudioCommandKind::Stop => "stop",
        AudioCommandKind::DebugSnapshot => "debug_snapshot",
        AudioCommandKind::Shutdown => "shutdown",
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::{Path, PathBuf},
        sync::{
            atomic::{AtomicBool, AtomicU64, Ordering},
            mpsc, Arc, RwLock,
        },
        thread,
        time::{Duration, Instant},
    };

    use libretracks_core::{Clip, OutputBus, Song, TempoMetadata, TempoSource, Track};
    use rtrb::RingBuffer;
    use tempfile::tempdir;

    use super::{
        apply_runtime_pan, build_live_mix_map, build_playback_plans, coalesce_sync_song_commands,
        drain_consumer_samples, env_flag, interpolated_gain, playback_reason_label,
        prepare_audio_source, probe_audio_file, resolve_track_runtime_pan, scheduled_clip_count,
        update_shared_track_mix, AudioBufferCache, AudioBufferCacheStats, AudioCommand,
        AudioCommandKind, AudioDebugConfig, AudioDebugSnapshot, AudioDebugState, AudioMeterLevel,
        MemoryClipReader, Mixer, OutputSample, PlaybackBackend, PlaybackClipPlan, PlaybackSession,
        PlaybackStartReason, RestartReport, SharedAudioSource, StopReport, SyncReport,
    };

    fn demo_song() -> Song {
        Song {
            id: "song_audio".into(),
            title: "Audio Runtime".into(),
            artist: None,
            bpm: 120.0,
            tempo_metadata: TempoMetadata {
                source: TempoSource::Manual,
                confidence: None,
                reference_file_path: None,
            },
            key: None,
            time_signature: "4/4".into(),
            duration_seconds: 20.0,
            tracks: vec![
                Track {
                    id: "folder_main".into(),
                    name: "Main".into(),
                    kind: libretracks_core::TrackKind::Folder,
                    parent_track_id: None,
                    volume: 0.7,
                    pan: 0.0,
                    muted: false,
                    solo: false,
                    output_bus_id: OutputBus::Main.id(),
                },
                Track {
                    id: "track_drums".into(),
                    name: "Drums".into(),
                    kind: libretracks_core::TrackKind::Audio,
                    parent_track_id: Some("folder_main".into()),
                    volume: 0.5,
                    pan: 0.0,
                    muted: false,
                    solo: false,
                    output_bus_id: OutputBus::Main.id(),
                },
            ],
            clips: vec![
                Clip {
                    id: "clip_intro".into(),
                    track_id: "track_drums".into(),
                    file_path: "audio/intro.wav".into(),
                    timeline_start_seconds: 0.0,
                    source_start_seconds: 0.0,
                    duration_seconds: 5.0,
                    gain: 1.0,
                    fade_in_seconds: None,
                    fade_out_seconds: None,
                },
                Clip {
                    id: "clip_late".into(),
                    track_id: "track_drums".into(),
                    file_path: "audio/late.wav".into(),
                    timeline_start_seconds: 10.0,
                    source_start_seconds: 0.0,
                    duration_seconds: 5.0,
                    gain: 1.0,
                    fade_in_seconds: None,
                    fade_out_seconds: None,
                },
            ],
            section_markers: vec![],
        }
    }

    fn write_silent_test_wav(path: &std::path::Path) {
        let spec = hound::WavSpec {
            channels: 2,
            sample_rate: 44_100,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(path, spec).expect("wav should be created");
        for _ in 0..44_100 {
            writer.write_sample(0_i16).expect("sample should write");
            writer.write_sample(0_i16).expect("sample should write");
        }
        writer.finalize().expect("wav should finalize");
    }

    fn write_counting_test_wav(path: &std::path::Path, sample_rate: u32, frame_count: usize) {
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(path, spec).expect("wav should be created");
        for frame_index in 0..frame_count {
            let normalized = ((frame_index % 200) as f32 / 100.0) - 1.0;
            let sample = (normalized * i16::MAX as f32 * 0.5) as i16;
            writer.write_sample(sample).expect("sample should write");
        }
        writer.finalize().expect("wav should finalize");
    }

    fn cache_with_shared_buffer(
        path: &Path,
        samples: Vec<f32>,
        sample_rate: u32,
        channels: usize,
    ) -> AudioBufferCache {
        let cache = AudioBufferCache::default();
        cache
            .entries
            .write()
            .expect("audio cache should lock")
            .insert(
                path.to_path_buf(),
                Arc::new(SharedAudioSource {
                    file_path: path.to_path_buf(),
                    preload_frame_count: samples.len() / channels.max(1),
                    preload_samples: samples,
                    sample_rate,
                    channels,
                    fully_cached: true,
                }),
            );
        cache
    }

    fn shared_mix_state(
        song: &Song,
    ) -> Arc<RwLock<std::collections::HashMap<String, super::LiveTrackMix>>> {
        Arc::new(RwLock::new(build_live_mix_map(song)))
    }

    #[test]
    fn playback_reason_labels_match_command_telemetry() {
        assert_eq!(playback_reason_label(PlaybackStartReason::Seek), "seek");
        assert_eq!(
            playback_reason_label(PlaybackStartReason::StructureRebuild),
            "structure_rebuild"
        );
        assert_eq!(super::command_kind_label(AudioCommandKind::Seek), "seek");
        assert_eq!(super::command_kind_label(AudioCommandKind::Stop), "stop");
    }

    #[test]
    fn debug_state_tracks_restart_sync_and_stop() {
        let mut debug_state = AudioDebugState::new(AudioDebugConfig {
            enabled: true,
            log_commands: false,
        });

        debug_state.record_command(
            AudioCommandKind::Play,
            Some(playback_reason_label(PlaybackStartReason::InitialPlay).to_string()),
        );
        debug_state.record_restart(
            PlaybackStartReason::InitialPlay,
            1.25,
            20.0,
            &RestartReport {
                elapsed: Duration::from_millis(12),
                scheduled_clips: 3,
                active_sinks: 1,
                opened_files: 0,
                cache_stats: AudioBufferCacheStats {
                    cached_buffers: 1,
                    fully_cached_buffers: 1,
                    preload_bytes: 16,
                },
            },
        );
        debug_state.record_sync(&SyncReport {
            elapsed: Duration::from_millis(2),
            updated_sinks: 1,
            active_sinks: 1,
        });
        debug_state.record_stop(
            &StopReport {
                elapsed: Duration::from_millis(1),
                stopped_sinks: 1,
            },
            0,
        );

        let snapshot = debug_state.snapshot();
        assert!(snapshot.enabled);
        assert_eq!(snapshot.command_count, 1);
        assert_eq!(
            snapshot
                .last_restart
                .expect("restart summary should exist")
                .scheduled_clips,
            3
        );
        assert_eq!(
            snapshot.playhead.last_start_reason.as_deref(),
            Some("initial_play")
        );
        assert_eq!(snapshot.runtime_state.active_sinks, 0);
        assert_eq!(snapshot.runtime_state.cached_audio_buffers, 1);
        assert_eq!(snapshot.runtime_state.fully_cached_audio_buffers, 1);
        assert_eq!(snapshot.runtime_state.cached_audio_preload_bytes, 16);
        assert_eq!(
            snapshot
                .last_stop
                .expect("stop summary should exist")
                .stopped_sinks,
            1
        );
        assert!(!snapshot.playhead.running);
        assert!(
            snapshot
                .playhead
                .estimated_position_seconds
                .unwrap_or_default()
                >= 1.25
        );
    }

    #[test]
    fn debug_state_estimates_playhead_while_running_and_freezes_after_stop() {
        let mut debug_state = AudioDebugState::new(AudioDebugConfig {
            enabled: true,
            log_commands: false,
        });

        debug_state.record_restart(
            PlaybackStartReason::Seek,
            2.0,
            10.0,
            &RestartReport {
                elapsed: Duration::from_millis(4),
                scheduled_clips: 2,
                active_sinks: 1,
                opened_files: 0,
                cache_stats: AudioBufferCacheStats {
                    cached_buffers: 1,
                    fully_cached_buffers: 0,
                    preload_bytes: 8,
                },
            },
        );

        thread::sleep(Duration::from_millis(20));
        let running_snapshot = debug_state.snapshot();
        let running_position = running_snapshot
            .playhead
            .estimated_position_seconds
            .expect("running playhead should exist");

        assert!(running_snapshot.playhead.running);
        assert!(running_snapshot.playhead.anchor_age_ms.unwrap_or_default() >= 10.0);
        assert!(running_position > 2.0);
        assert_eq!(
            running_snapshot.playhead.last_start_reason.as_deref(),
            Some("seek")
        );

        debug_state.record_stop(
            &StopReport {
                elapsed: Duration::from_millis(1),
                stopped_sinks: 1,
            },
            0,
        );

        let stopped_snapshot = debug_state.snapshot();
        let stopped_position = stopped_snapshot
            .playhead
            .estimated_position_seconds
            .expect("stopped playhead should remain visible");

        thread::sleep(Duration::from_millis(20));
        let frozen_snapshot = debug_state.snapshot();
        let frozen_position = frozen_snapshot
            .playhead
            .estimated_position_seconds
            .expect("frozen playhead should remain visible");

        assert!(!stopped_snapshot.playhead.running);
        assert!(stopped_snapshot.playhead.anchor_age_ms.is_none());
        assert!((frozen_position - stopped_position).abs() < 0.001);
    }

    #[test]
    fn env_flag_accepts_common_truthy_values() {
        let key = "LIBRETRACKS_AUDIO_ENV_FLAG_TEST";
        std::env::set_var(key, "YES");
        assert!(env_flag(key));
        std::env::remove_var(key);
    }

    #[test]
    fn coalesces_consecutive_mix_sync_commands() {
        let (sender, receiver) = mpsc::channel();
        let (respond_to_1, _) = mpsc::channel();
        let (respond_to_2, _) = mpsc::channel();
        let (respond_to_3, _) = mpsc::channel::<AudioDebugSnapshot>();

        let song_a = demo_song();
        let mut song_b = demo_song();
        song_b.tracks[0].volume = 0.2;

        sender
            .send(AudioCommand::SyncSong {
                song: song_b.clone(),
                respond_to: respond_to_2,
            })
            .expect("second sync command should queue");
        sender
            .send(AudioCommand::DebugSnapshot {
                respond_to: respond_to_3,
            })
            .expect("debug command should queue");

        let (latest_song, respond_tos, deferred_command) =
            coalesce_sync_song_commands(&receiver, song_a, respond_to_1);

        assert_eq!(latest_song.tracks[0].volume, 0.2);
        assert_eq!(respond_tos.len(), 2);
        assert!(matches!(
            deferred_command,
            Some(AudioCommand::DebugSnapshot { .. })
        ));
    }

    #[test]
    fn scheduled_clip_count_ignores_finished_regions() {
        assert_eq!(scheduled_clip_count(&demo_song(), 1.0), 2);
        assert_eq!(scheduled_clip_count(&demo_song(), 6.0), 1);
        assert_eq!(scheduled_clip_count(&demo_song(), 16.0), 0);
    }

    #[test]
    fn playback_plans_use_absolute_song_timeline_frames() {
        let plans = build_playback_plans(Path::new("song"), &demo_song(), 48_000);

        assert_eq!(plans.len(), 2);
        assert_eq!(plans[0].clip_id, "clip_intro");
        assert_eq!(plans[0].timeline_start_frame, 0);
        assert_eq!(plans[0].duration_frames, 48_000 * 5);
        assert!((plans[0].source_start_seconds - 0.0).abs() < 0.000_001);

        assert_eq!(plans[1].clip_id, "clip_late");
        assert_eq!(plans[1].timeline_start_frame, 48_000 * 10);
    }

    #[test]
    fn interpolated_gain_reaches_target_on_last_sample() {
        assert!((interpolated_gain(0.2, 1.0, 0, 4) - 0.2).abs() < 0.000_001);
        assert!((interpolated_gain(0.2, 1.0, 1, 4) - 0.466_666_67).abs() < 0.000_1);
        assert!((interpolated_gain(0.2, 1.0, 3, 4) - 1.0).abs() < 0.000_001);
    }

    #[test]
    fn interpolated_gain_handles_empty_and_single_frame_blocks() {
        assert!((interpolated_gain(0.2, 1.0, 0, 0) - 0.2).abs() < 0.000_001);
        assert!((interpolated_gain(0.2, 1.0, 0, 1) - 1.0).abs() < 0.000_001);
    }

    #[test]
    fn playback_plan_edge_gain_applies_fades_in_sample_domain() {
        let plan = PlaybackClipPlan {
            clip_id: "clip".into(),
            track_id: "track".into(),
            file_path: PathBuf::from("audio/test.wav"),
            clip_gain: 1.0,
            timeline_start_frame: 0,
            duration_frames: 100,
            fade_in_frames: 20,
            fade_out_frames: 20,
            source_start_seconds: 0.0,
        };

        assert!((plan.edge_gain(0) - 0.0).abs() < 0.000_001);
        assert!(plan.edge_gain(10) > 0.45 && plan.edge_gain(10) < 0.55);
        assert!((plan.edge_gain(50) - 1.0).abs() < 0.000_001);
        assert!(plan.edge_gain(90) > 0.45 && plan.edge_gain(90) < 0.55);
    }

    #[test]
    fn memory_clip_reader_reads_pcm_from_shared_buffer() {
        let clip_path = PathBuf::from("audio/shared-buffer.wav");
        let cache = cache_with_shared_buffer(&clip_path, vec![0.25, -0.25, 0.5, -0.5], 48_000, 2);
        let mut reader = MemoryClipReader::open(
            &PlaybackClipPlan {
                clip_id: "clip".into(),
                track_id: "track".into(),
                file_path: clip_path,
                clip_gain: 1.0,
                timeline_start_frame: 0,
                duration_frames: 2,
                fade_in_frames: 0,
                fade_out_frames: 0,
                source_start_seconds: 0.0,
            },
            48_000,
            &cache,
            0,
        )
        .expect("memory reader should open");

        let mut mixed = [0.0_f32; 4];
        reader.mix_into_with_channel_gains(&mut mixed, 0, 2, 2, 1.0, 0.0);

        assert_eq!(mixed, [0.25, -0.25, 0.5, -0.5]);
        assert!(reader.eof);
        assert_eq!(reader.current_frame, 2);
    }

    #[test]
    fn memory_clip_reader_applies_true_stereo_pan_folding() {
        let clip_path = PathBuf::from("audio/pan-buffer.wav");
        let cache = cache_with_shared_buffer(&clip_path, vec![0.3, 0.7], 48_000, 2);
        let mut reader = MemoryClipReader::open(
            &PlaybackClipPlan {
                clip_id: "clip".into(),
                track_id: "track".into(),
                file_path: clip_path,
                clip_gain: 1.0,
                timeline_start_frame: 0,
                duration_frames: 1,
                fade_in_frames: 0,
                fade_out_frames: 0,
                source_start_seconds: 0.0,
            },
            48_000,
            &cache,
            0,
        )
        .expect("memory reader should open");

        let mut mixed = [0.0_f32; 2];
        let (left_peak, right_peak) =
            reader.mix_into_with_channel_gains(&mut mixed, 0, 1, 2, 1.0, -0.5);

        assert_eq!(mixed, [0.65, 0.35]);
        assert!((left_peak - 0.65).abs() < 0.000_001);
        assert!((right_peak - 0.35).abs() < 0.000_001);
    }

    #[test]
    fn runtime_pan_folds_stereo_and_balances_mono() {
        let (hard_left_l, hard_left_r) = apply_runtime_pan(0.25, 0.75, -1.0, 2);
        let (center_l, center_r) = apply_runtime_pan(0.25, 0.75, 0.0, 2);
        let (hard_right_l, hard_right_r) = apply_runtime_pan(0.25, 0.75, 1.0, 2);
        let (mono_left, mono_right) = apply_runtime_pan(0.5, 0.5, 0.4, 1);

        assert!((hard_left_l - 1.0).abs() < 0.000_001);
        assert!(hard_left_r.abs() < 0.000_001);
        assert!((center_l - 0.25).abs() < 0.000_001);
        assert!((center_r - 0.75).abs() < 0.000_001);
        assert!(hard_right_l.abs() < 0.000_001);
        assert!((hard_right_r - 1.0).abs() < 0.000_001);
        assert!((mono_left - 0.3).abs() < 0.000_001);
        assert!((mono_right - 0.5).abs() < 0.000_001);
    }

    #[test]
    fn memory_clip_reader_keeps_extra_output_channels_silent() {
        let clip_path = PathBuf::from("audio/multichannel-pan-buffer.wav");
        let cache = cache_with_shared_buffer(&clip_path, vec![0.25, 0.75], 48_000, 2);
        let mut reader = MemoryClipReader::open(
            &PlaybackClipPlan {
                clip_id: "clip".into(),
                track_id: "track".into(),
                file_path: clip_path,
                clip_gain: 1.0,
                timeline_start_frame: 0,
                duration_frames: 1,
                fade_in_frames: 0,
                fade_out_frames: 0,
                source_start_seconds: 0.0,
            },
            48_000,
            &cache,
            0,
        )
        .expect("memory reader should open");

        let mut mixed = [0.0_f32; 4];
        reader.mix_into_with_channel_gains(&mut mixed, 0, 1, 4, 1.0, -1.0);

        assert_eq!(mixed, [1.0, 0.0, 0.0, 0.0]);
    }

    #[test]
    fn resolve_track_runtime_pan_accumulates_folder_pan_and_clamps() {
        let mut song = demo_song();
        song.tracks[0].pan = -0.35;
        song.tracks[1].pan = -0.8;

        let pan = resolve_track_runtime_pan(&build_live_mix_map(&song), "track_drums");

        assert!((pan + 1.0).abs() < 0.000_001);
    }

    #[test]
    fn resolve_track_runtime_pan_rejects_circular_folder_hierarchies() {
        let song = Song {
            id: "cycle_song".into(),
            title: "Cycle".into(),
            artist: None,
            bpm: 120.0,
            tempo_metadata: TempoMetadata {
                source: TempoSource::Manual,
                confidence: None,
                reference_file_path: None,
            },
            key: None,
            time_signature: "4/4".into(),
            duration_seconds: 1.0,
            tracks: vec![
                Track {
                    id: "folder_a".into(),
                    name: "Folder A".into(),
                    kind: libretracks_core::TrackKind::Folder,
                    parent_track_id: Some("folder_b".into()),
                    volume: 1.0,
                    pan: 0.25,
                    muted: false,
                    solo: false,
                    output_bus_id: OutputBus::Main.id(),
                },
                Track {
                    id: "folder_b".into(),
                    name: "Folder B".into(),
                    kind: libretracks_core::TrackKind::Folder,
                    parent_track_id: Some("folder_a".into()),
                    volume: 1.0,
                    pan: 0.25,
                    muted: false,
                    solo: false,
                    output_bus_id: OutputBus::Main.id(),
                },
                Track {
                    id: "track_cycle".into(),
                    name: "Track".into(),
                    kind: libretracks_core::TrackKind::Audio,
                    parent_track_id: Some("folder_a".into()),
                    volume: 1.0,
                    pan: 0.25,
                    muted: false,
                    solo: false,
                    output_bus_id: OutputBus::Main.id(),
                },
            ],
            clips: vec![],
            section_markers: vec![],
        };

        let pan = resolve_track_runtime_pan(&build_live_mix_map(&song), "track_cycle");

        assert_eq!(pan, 0.0);
    }

    #[test]
    fn mixer_rolls_child_meter_peaks_up_to_folder_tracks() {
        let song = demo_song();
        let mixer = Mixer::new(
            PathBuf::from("song"),
            song.clone(),
            0.0,
            48_000,
            2,
            Arc::new(RwLock::new(None)),
            shared_mix_state(&song),
            AudioDebugConfig {
                enabled: false,
                log_commands: false,
            },
            AudioBufferCache::default(),
        );
        let mut track_meters = vec![
            AudioMeterLevel {
                track_id: "folder_main".into(),
                left_peak: 0.0,
                right_peak: 0.0,
            },
            AudioMeterLevel {
                track_id: "track_drums".into(),
                left_peak: 0.5,
                right_peak: 0.25,
            },
        ];

        mixer.roll_up_folder_track_meters(&mut track_meters);

        assert!((track_meters[0].left_peak - 0.35).abs() < 0.000_001);
        assert!((track_meters[0].right_peak - 0.175).abs() < 0.000_001);
    }

    #[test]
    fn mixer_render_stays_responsive_during_live_mix_updates() {
        let song = demo_song();
        let song_dir = PathBuf::from("song");
        let cache = AudioBufferCache::default();
        cache
            .entries
            .write()
            .expect("audio cache should lock")
            .extend([
                (
                    song_dir.join("audio/intro.wav"),
                    Arc::new(SharedAudioSource {
                        file_path: song_dir.join("audio/intro.wav"),
                        preload_frame_count: 48_000 * 5,
                        preload_samples: vec![0.0; 48_000 * 10],
                        sample_rate: 48_000,
                        channels: 2,
                        fully_cached: true,
                    }),
                ),
                (
                    song_dir.join("audio/late.wav"),
                    Arc::new(SharedAudioSource {
                        file_path: song_dir.join("audio/late.wav"),
                        preload_frame_count: 48_000 * 5,
                        preload_samples: vec![0.0; 48_000 * 10],
                        sample_rate: 48_000,
                        channels: 2,
                        fully_cached: true,
                    }),
                ),
            ]);

        let live_mix_state = shared_mix_state(&song);
        let render_iterations = Arc::new(AtomicU64::new(0));
        let update_iterations = Arc::new(AtomicU64::new(0));
        let should_stop = Arc::new(AtomicBool::new(false));

        let render_handle = {
            let live_mix_state = live_mix_state.clone();
            let render_iterations = render_iterations.clone();
            let should_stop = should_stop.clone();
            let cache = cache.clone();
            let song = song.clone();
            let song_dir = song_dir.clone();

            thread::spawn(move || {
                let mut mixer = Mixer::new(
                    song_dir,
                    song,
                    0.0,
                    48_000,
                    2,
                    Arc::new(RwLock::new(None)),
                    live_mix_state,
                    AudioDebugConfig {
                        enabled: false,
                        log_commands: false,
                    },
                    cache,
                );
                let started_at = Instant::now();

                while started_at.elapsed() < Duration::from_millis(150) {
                    let _ = mixer.render_next_block(64);
                    render_iterations.fetch_add(1, Ordering::Relaxed);
                }

                should_stop.store(true, Ordering::Release);
            })
        };

        let update_handle = {
            let live_mix_state = live_mix_state.clone();
            let update_iterations = update_iterations.clone();
            let should_stop = should_stop.clone();

            thread::spawn(move || {
                let mut volume = 0.0_f64;
                let mut solo = false;
                let started_at = Instant::now();

                while !should_stop.load(Ordering::Acquire)
                    && started_at.elapsed() < Duration::from_millis(300)
                {
                    update_shared_track_mix(
                        &live_mix_state,
                        "track_drums",
                        Some(volume),
                        Some(volume * 2.0 - 1.0),
                        Some(false),
                        Some(solo),
                    )
                    .expect("track mix update should succeed");
                    update_iterations.fetch_add(1, Ordering::Relaxed);
                    volume = (volume + 0.07).fract();
                    solo = !solo;
                    thread::sleep(Duration::from_millis(1));
                }
            })
        };

        render_handle
            .join()
            .expect("render thread should not panic");
        should_stop.store(true, Ordering::Release);
        update_handle
            .join()
            .expect("update thread should not panic");

        assert!(render_iterations.load(Ordering::Relaxed) > 10);
        assert!(update_iterations.load(Ordering::Relaxed) > 10);
    }

    #[test]
    fn memory_clip_reader_seek_to_jumps_directly_to_target_frame() {
        let clip_path = PathBuf::from("audio/seek-buffer.wav");
        let cache =
            cache_with_shared_buffer(&clip_path, vec![0.1, 0.2, 0.3, 0.4, 0.5, 0.6], 48_000, 2);
        let mut reader = MemoryClipReader::open(
            &PlaybackClipPlan {
                clip_id: "clip".into(),
                track_id: "track".into(),
                file_path: clip_path,
                clip_gain: 1.0,
                timeline_start_frame: 0,
                duration_frames: 3,
                fade_in_frames: 0,
                fade_out_frames: 0,
                source_start_seconds: 0.0,
            },
            48_000,
            &cache,
            0,
        )
        .expect("memory reader should open");

        reader.seek_to(1);
        let mut mixed = [0.0_f32; 2];
        reader.mix_into_with_channel_gains(&mut mixed, 0, 1, 2, 1.0, 0.0);

        assert_eq!(mixed, [0.3, 0.4]);
        assert_eq!(reader.current_frame, 2);
        assert!(!reader.eof);
    }

    #[test]
    fn memory_clip_reader_honors_source_start_offset_when_opening() {
        let clip_path = PathBuf::from("audio/offset-buffer.wav");
        let cache = cache_with_shared_buffer(&clip_path, vec![0.1, 0.2, 0.3, 0.4], 4, 1);
        let reader = MemoryClipReader::open(
            &PlaybackClipPlan {
                clip_id: "clip".into(),
                track_id: "track".into(),
                file_path: clip_path,
                clip_gain: 1.0,
                timeline_start_frame: 0,
                duration_frames: 1,
                fade_in_frames: 0,
                fade_out_frames: 0,
                source_start_seconds: 0.5,
            },
            4,
            &cache,
            0,
        )
        .expect("memory reader should open");

        assert_eq!(reader.current_frame, 2);
        assert!(!reader.eof);
    }

    #[test]
    fn prepared_audio_source_preloads_only_the_head_for_long_files() {
        let root = tempdir().expect("temp dir should exist");
        let audio_path = root.path().join("long.wav");
        write_counting_test_wav(&audio_path, 8_000, 8_000 * 4);

        let source = prepare_audio_source(&audio_path).expect("audio source should prepare");

        assert_eq!(source.sample_rate, 8_000);
        assert_eq!(source.channels, 1);
        assert_eq!(source.preload_frame_count, 8_000 * 2);
        assert!(!source.fully_cached);
    }

    #[test]
    fn memory_clip_reader_streams_past_the_preloaded_head() {
        let root = tempdir().expect("temp dir should exist");
        let audio_path = root.path().join("streaming.wav");
        write_counting_test_wav(&audio_path, 8_000, 8_000 * 3);

        let cache = AudioBufferCache::default();
        cache
            .entries
            .write()
            .expect("audio cache should lock")
            .insert(
                audio_path.clone(),
                Arc::new(prepare_audio_source(&audio_path).expect("audio source should prepare")),
            );

        let mut reader = MemoryClipReader::open(
            &PlaybackClipPlan {
                clip_id: "clip".into(),
                track_id: "track".into(),
                file_path: audio_path,
                clip_gain: 1.0,
                timeline_start_frame: 0,
                duration_frames: 8_000 * 3,
                fade_in_frames: 0,
                fade_out_frames: 0,
                source_start_seconds: 0.0,
            },
            8_000,
            &cache,
            0,
        )
        .expect("memory reader should open");

        reader.seek_to(8_000 * 2 + 32);
        let mut mixed = [0.0_f32; 1];
        let (_left_peak, right_peak) =
            reader.mix_into_with_channel_gains(&mut mixed, 0, 1, 1, 1.0, 0.0);

        assert!(mixed[0].abs() > 0.01);
        assert!(right_peak.abs() > 0.01);
        assert!(reader.streaming_reader.is_some());
    }

    #[test]
    fn mixer_seek_reuses_absolute_plans_and_activates_overlapping_clip() {
        let song = demo_song();
        let song_dir = PathBuf::from("song");
        let cache = AudioBufferCache::default();
        cache
            .entries
            .write()
            .expect("audio cache should lock")
            .extend([
                (
                    song_dir.join("audio/intro.wav"),
                    Arc::new(SharedAudioSource {
                        file_path: song_dir.join("audio/intro.wav"),
                        preload_frame_count: 48_000 * 5,
                        preload_samples: vec![0.0; 48_000 * 5],
                        sample_rate: 48_000,
                        channels: 1,
                        fully_cached: true,
                    }),
                ),
                (
                    song_dir.join("audio/late.wav"),
                    Arc::new(SharedAudioSource {
                        file_path: song_dir.join("audio/late.wav"),
                        preload_frame_count: 48_000 * 5,
                        preload_samples: vec![0.0; 48_000 * 5],
                        sample_rate: 48_000,
                        channels: 1,
                        fully_cached: true,
                    }),
                ),
            ]);

        let mut mixer = Mixer::new(
            song_dir,
            song.clone(),
            0.0,
            48_000,
            1,
            Arc::new(RwLock::new(None)),
            shared_mix_state(&song),
            AudioDebugConfig {
                enabled: false,
                log_commands: false,
            },
            cache,
        );

        assert_eq!(mixer.plans.len(), 2);
        assert_eq!(mixer.timeline_cursor_frame, 0);
        assert_eq!(mixer.active_clips.len(), 1);
        assert_eq!(mixer.active_clips[0].plan.clip_id, "clip_intro");

        mixer.seek(song, 11.0);

        assert_eq!(mixer.plans.len(), 2);
        assert_eq!(mixer.timeline_cursor_frame, 48_000 * 11);
        assert_eq!(mixer.active_clips.len(), 1);
        assert_eq!(mixer.active_clips[0].plan.clip_id, "clip_late");
        assert_eq!(mixer.active_clips[0].reader.current_frame, 48_000);
    }

    #[test]
    fn ring_consumer_writes_silence_when_buffer_runs_empty() {
        let (mut producer, mut consumer) = RingBuffer::<OutputSample>::new(4);
        let seek_generation = Arc::new(AtomicU64::new(0));
        let mut active_generation = 0;
        producer
            .push(OutputSample {
                generation: 0,
                value: 0.25,
            })
            .expect("sample should push");
        producer
            .push(OutputSample {
                generation: 0,
                value: -0.5,
            })
            .expect("sample should push");

        let mut output = [0.0_f32; 4];
        drain_consumer_samples(
            &mut output,
            &mut consumer,
            &seek_generation,
            &mut active_generation,
            |sample| sample,
        );

        assert_eq!(output, [0.25, -0.5, 0.0, 0.0]);
    }

    #[test]
    fn ring_consumer_flushes_stale_generation_on_seek() {
        let (mut producer, mut consumer) = RingBuffer::<OutputSample>::new(4);
        let seek_generation = Arc::new(AtomicU64::new(0));
        let mut active_generation = 0;

        producer
            .push(OutputSample {
                generation: 0,
                value: 0.75,
            })
            .expect("stale sample should push");
        seek_generation.store(1, Ordering::Release);
        producer
            .push(OutputSample {
                generation: 1,
                value: 0.5,
            })
            .expect("fresh sample should push");

        let mut output = [0.0_f32; 2];
        drain_consumer_samples(
            &mut output,
            &mut consumer,
            &seek_generation,
            &mut active_generation,
            |sample| sample,
        );

        assert_eq!(output, [0.0, 0.0]);
        assert_eq!(active_generation, 1);
    }

    #[test]
    fn playback_session_seek_increments_generation_for_buffer_flush() {
        let song = demo_song();
        let seek_generation = Arc::new(AtomicU64::new(0));
        let mut session = PlaybackSession {
            backend: PlaybackBackend::Null,
            reader_sender: None,
            reader_handle: None,
            seek_generation: seek_generation.clone(),
            audio_buffers: AudioBufferCache::default(),
        };

        let consumed_null_backend = session
            .seek(song, 8.0)
            .expect("seek should succeed on null backend");

        assert!(consumed_null_backend);
        assert_eq!(seek_generation.load(Ordering::Acquire), 1);
    }

    #[test]
    fn symphonia_probes_wav_assets() {
        let temp_dir = tempdir().expect("temp dir should exist");
        let audio_path = temp_dir.path().join("clip.wav");
        write_silent_test_wav(&audio_path);

        probe_audio_file(&audio_path).expect("wav should probe");
    }

    #[test]
    fn symphonia_probe_fails_for_missing_file() {
        let missing = PathBuf::from("missing-audio-file.wav");
        assert!(probe_audio_file(&missing).is_err());
    }

    #[test]
    fn silent_wav_fixture_is_created_for_tests() {
        let temp_dir = tempdir().expect("temp dir should exist");
        let audio_path = temp_dir.path().join("clip.wav");
        write_silent_test_wav(&audio_path);

        let metadata = fs::metadata(audio_path).expect("wav metadata should load");
        assert!(metadata.len() > 0);
    }
}
