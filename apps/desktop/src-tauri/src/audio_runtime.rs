use std::{
    collections::{HashMap, HashSet},
    f32::consts::PI,
    fs::File,
    io::ErrorKind,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc::{self, Receiver, Sender},
        Arc, RwLock,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use cpal::{
    traits::{DeviceTrait, HostTrait, StreamTrait},
    Device, SampleFormat, Stream, StreamConfig,
};
use libretracks_core::{Song, TrackKind};
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

const PCM_RING_CAPACITY_FRAMES: usize = 16_384;
const DISK_RENDER_BLOCK_FRAMES: usize = 1_024;
const GAIN_EPSILON: f32 = 0.000_001;
const AUDIO_METER_EVENT: &str = "audio:meters";
const AUDIO_METER_EMIT_INTERVAL: Duration = Duration::from_millis(33);

type SharedAppHandle = Arc<RwLock<Option<AppHandle>>>;

pub struct AudioRuntime {
    session: Option<PlaybackSession>,
    audio_buffers: AudioBufferCache,
    app_handle: SharedAppHandle,
}

pub struct AudioController {
    sender: Sender<AudioCommand>,
    audio_buffers: AudioBufferCache,
    app_handle: SharedAppHandle,
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
    cached_buffers: usize,
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
    clip_id: String,
    track_id: String,
    file_path: PathBuf,
    timeline_start_frame: u64,
    duration_frames: u64,
    fade_in_frames: u64,
    fade_out_frames: u64,
    source_start_seconds: f64,
}

#[derive(Debug)]
struct SharedAudioBuffer {
    samples: Vec<f32>,
    sample_rate: u32,
    channels: usize,
}

#[derive(Clone, Default)]
struct AudioBufferCache {
    entries: Arc<RwLock<HashMap<PathBuf, Arc<SharedAudioBuffer>>>>,
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
    meter_emitter: MeterEmitterState,
}

struct MixClipState {
    plan: PlaybackClipPlan,
    reader: MemoryClipReader,
    current_gain: f32,
    current_pan: f32,
}

struct MeterEmitterState {
    app_handle: SharedAppHandle,
    last_emitted_at: Option<Instant>,
}

struct MemoryClipReader {
    shared_buffer: Arc<SharedAudioBuffer>,
    output_sample_rate: u32,
    current_frame: usize,
    source_frame_cursor: f64,
    eof: bool,
}

struct OpenAudioSource {
    format: Box<dyn FormatReader>,
    decoder: Box<dyn Decoder>,
    track_id: u32,
    sample_rate: u32,
    channels: usize,
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

impl SharedAudioBuffer {
    fn frame_count(&self) -> usize {
        self.samples.len() / self.channels.max(1)
    }

    fn read_sample(&self, frame_index: usize, channel: usize, output_channels: usize) -> f32 {
        let sample_index = frame_index.saturating_mul(self.channels);
        if sample_index >= self.samples.len() {
            return 0.0;
        }

        if output_channels == 1 && self.channels > 1 {
            let left = self.samples[sample_index];
            let right = self.samples[sample_index + 1.min(self.channels - 1)];
            return (left + right) * 0.5;
        }

        let source_channel = if self.channels == 1 {
            0
        } else {
            channel.min(self.channels - 1)
        };

        self.samples[sample_index + source_channel]
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

        for file_path in missing_paths {
            next_entries.insert(file_path.clone(), Arc::new(decode_audio_file(&file_path)?));
        }

        let mut entries = self
            .entries
            .write()
            .map_err(|_| "audio buffer cache lock poisoned".to_string())?;
        *entries = next_entries;

        Ok(())
    }

    fn get(&self, file_path: &Path) -> Result<Option<Arc<SharedAudioBuffer>>, String> {
        let entries = self
            .entries
            .read()
            .map_err(|_| "audio buffer cache lock poisoned".to_string())?;
        Ok(entries.get(file_path).cloned())
    }

    fn buffer_count(&self) -> usize {
        self.entries
            .read()
            .map(|entries| entries.len())
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
        self.runtime_state.cached_audio_buffers = report.cached_buffers;
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
    fn new(audio_buffers: AudioBufferCache, app_handle: SharedAppHandle) -> Self {
        Self {
            session: None,
            audio_buffers,
            app_handle,
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
            debug_config,
            self.audio_buffers.clone(),
        )?;
        let cached_buffers = session.cached_buffer_count();

        self.session = Some(session);

        Ok(RestartReport {
            elapsed: started_at.elapsed(),
            scheduled_clips,
            active_sinks: 1,
            opened_files: 0,
            cached_buffers,
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
        let runtime_audio_buffers = audio_buffers.clone();
        let runtime_app_handle = app_handle.clone();

        thread::Builder::new()
            .name("libretracks-audio".into())
            .spawn(move || {
                run_audio_thread(
                    receiver,
                    debug_config,
                    runtime_audio_buffers,
                    runtime_app_handle,
                )
            })
            .expect("audio thread should start");

        Self {
            sender,
            audio_buffers,
            app_handle,
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
        self.request(|respond_to| AudioCommand::Seek {
            song,
            position_seconds,
            reason,
            respond_to,
        })
    }

    pub fn sync_song(&self, song: Song) -> Result<(), DesktopError> {
        self.request(|respond_to| AudioCommand::SyncSong { song, respond_to })
    }

    pub fn stop(&self) -> Result<(), DesktopError> {
        self.request(|respond_to| AudioCommand::Stop { respond_to })
    }

    pub fn debug_snapshot(&self) -> Result<AudioDebugSnapshot, DesktopError> {
        let (respond_to, response) = mpsc::channel();

        self.sender
            .send(AudioCommand::DebugSnapshot { respond_to })
            .map_err(|_| DesktopError::AudioThreadUnavailable)?;

        response
            .recv()
            .map_err(|_| DesktopError::AudioThreadUnavailable)
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

        response
            .recv()
            .map_err(|_| DesktopError::AudioThreadUnavailable)?
            .map_err(DesktopError::AudioCommand)
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

    fn cached_buffer_count(&self) -> usize {
        self.audio_buffers.buffer_count()
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
        let shared_buffer = audio_buffers
            .get(&plan.file_path)?
            .ok_or_else(|| format!("audio buffer is not cached: {}", plan.file_path.display()))?;
        let mut reader = Self {
            shared_buffer,
            output_sample_rate: output_sample_rate.max(1),
            current_frame: 0,
            source_frame_cursor: 0.0,
            eof: false,
        };
        let source_start_frame = source_frame_for_timeline_position(
            plan,
            timeline_frame,
            output_sample_rate,
            reader.shared_buffer.sample_rate,
        );
        reader.seek_to(source_start_frame);
        Ok(reader)
    }

    fn seek_to(&mut self, target_frame: usize) {
        let frame_count = self.shared_buffer.frame_count();
        self.current_frame = target_frame.min(frame_count);
        self.source_frame_cursor = self.current_frame as f64;
        self.eof = self.current_frame >= frame_count;
    }

    fn mix_into(
        &mut self,
        buffer: &mut [f32],
        offset_frames: usize,
        frame_count: usize,
        output_channels: usize,
        gain: f32,
    ) -> (f32, f32) {
        self.mix_into_with_channel_gains(
            buffer,
            offset_frames,
            frame_count,
            output_channels,
            gain,
            1.0,
            1.0,
        );
    }

    fn mix_into_with_channel_gains(
        &mut self,
        buffer: &mut [f32],
        offset_frames: usize,
        frame_count: usize,
        output_channels: usize,
        gain: f32,
        left_gain: f32,
        right_gain: f32,
    ) -> (f32, f32) {
        if self.eof {
            return (0.0, 0.0);
        }

        let frame_step = self.shared_buffer.sample_rate as f64 / self.output_sample_rate as f64;
        let source_frame_count = self.shared_buffer.frame_count();
        let mut left_peak = 0.0_f32;
        let mut right_peak = 0.0_f32;

        for frame_offset in 0..frame_count {
            if self.current_frame >= source_frame_count {
                self.eof = true;
                break;
            }

            if gain.abs() > GAIN_EPSILON {
                let buffer_base = (offset_frames + frame_offset) * output_channels;
                for channel in 0..output_channels {
                    let channel_gain = if output_channels <= 1 {
                        1.0
                    } else if channel == 0 {
                        left_gain
                    } else if channel == 1 {
                        right_gain
                    } else {
                        1.0
                    };
                    let sample = self.shared_buffer.read_sample(
                        self.current_frame,
                        channel,
                        output_channels,
                    ) * gain * channel_gain;
                    buffer[buffer_base + channel] += sample;

                    if output_channels <= 1 {
                        let mono_peak = sample.abs();
                        left_peak = left_peak.max(mono_peak);
                        right_peak = right_peak.max(mono_peak);
                    } else if channel == 0 {
                        left_peak = left_peak.max(sample.abs());
                    } else if channel == 1 {
                        right_peak = right_peak.max(sample.abs());
                    }
                }
            }

            self.source_frame_cursor += frame_step;
            self.current_frame = self.source_frame_cursor.round().max(0.0) as usize;
        }

        if self.current_frame >= source_frame_count {
            self.eof = true;
        }

        (left_peak, right_peak)
    }
}

fn append_decoded_samples(target: &mut Vec<f32>, decoded: AudioBufferRef<'_>) {
    let mut sample_buffer = SampleBuffer::<f32>::new(decoded.capacity() as u64, *decoded.spec());
    sample_buffer.copy_interleaved_ref(decoded);
    target.extend_from_slice(sample_buffer.samples());
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

fn decode_audio_file(file_path: &Path) -> Result<SharedAudioBuffer, String> {
    let mut source = open_audio_source(file_path)?;
    let mut decoded_samples = Vec::new();

    loop {
        let packet = match source.format.next_packet() {
            Ok(packet) => packet,
            Err(SymphoniaError::IoError(error)) if error.kind() == ErrorKind::UnexpectedEof => {
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
                break;
            }
            Err(error) => return Err(error.to_string()),
        };

        append_decoded_samples(&mut decoded_samples, decoded);
    }

    Ok(SharedAudioBuffer {
        samples: decoded_samples,
        sample_rate: source.sample_rate.max(1),
        channels: source.channels.max(1),
    })
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

                let result = ensure_runtime(&mut runtime, &audio_buffers, &app_handle)
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

                let result = ensure_runtime(&mut runtime, &audio_buffers, &app_handle)
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

                let result = ensure_runtime(&mut runtime, &audio_buffers, &app_handle)
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
) -> &'a mut AudioRuntime {
    runtime.get_or_insert_with(|| AudioRuntime::new(audio_buffers.clone(), app_handle.clone()))
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
        debug_config: AudioDebugConfig,
        audio_buffers: AudioBufferCache,
    ) -> Self {
        let plans = build_playback_plans(&song_dir, &song, output_sample_rate);
        let track_meter_indices = song
            .tracks
            .iter()
            .enumerate()
            .map(|(index, track)| (track.id.clone(), index))
            .collect();
        let mut mixer = Self {
            song,
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
            meter_emitter: MeterEmitterState::new(app_handle),
        };
        mixer.seek(mixer.song.clone(), position_seconds);
        mixer
    }

    fn apply_song_update(&mut self, song: Song) {
        self.song = song;
        self.rebuild_track_meter_indices();
    }

    fn seek(&mut self, song: Song, position_seconds: f64) {
        self.song = song;
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
        let should_capture_track_meters = self.meter_emitter.should_emit();
        let mut track_meters = should_capture_track_meters.then(|| self.empty_track_meters());

        self.activate_due_clips(block_end);

        for clip_state in &mut self.active_clips {
            let overlap_start = block_start.max(clip_state.plan.timeline_start_frame);
            let overlap_end = block_end.min(clip_state.plan.timeline_end_frame());
            if overlap_end <= overlap_start {
                continue;
            }

            let offset_frames = (overlap_start - block_start) as usize;
            let overlap_frames = (overlap_end - overlap_start) as usize;
            let target_gain = resolve_clip_runtime_gain(
                &self.song,
                &clip_state.plan.clip_id,
                &clip_state.plan.track_id,
            ) as f32;
            let target_pan = resolve_track_runtime_pan(&self.song, &clip_state.plan.track_id);

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
                    track_meter_levels[index].left_peak =
                        track_meter_levels[index].left_peak.max(left_peak);
                    track_meter_levels[index].right_peak =
                        track_meter_levels[index].right_peak.max(right_peak);
                }
            }
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
                    let current_gain =
                        resolve_clip_runtime_gain(&self.song, &plan.clip_id, &plan.track_id) as f32;
                    let current_pan = resolve_track_runtime_pan(&self.song, &plan.track_id);
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
}

impl MeterEmitterState {
    fn new(app_handle: SharedAppHandle) -> Self {
        Self {
            app_handle,
            last_emitted_at: None,
        }
    }

    fn should_emit(&self) -> bool {
        let has_app_handle = self
            .app_handle
            .read()
            .ok()
            .and_then(|app_handle| app_handle.as_ref().cloned())
            .is_some();
        if !has_app_handle {
            return false;
        }

        self.last_emitted_at
            .map(|last_emitted_at| last_emitted_at.elapsed() >= AUDIO_METER_EMIT_INTERVAL)
            .unwrap_or(true)
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

        if let Err(error) = app_handle.emit(AUDIO_METER_EVENT, track_meters.to_vec()) {
            eprintln!("[libretracks-audio] failed to emit audio meters: {error}");
            return;
        }

        self.last_emitted_at = Some(Instant::now());
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
            let (left_gain, right_gain) = constant_power_pan_gains(dynamic_pan);
            let clip_frame_position =
                (overlap_start_frame - self.plan.timeline_start_frame) + frame_offset as u64;
            let edge_gain = self.plan.edge_gain(clip_frame_position);

            let (frame_left_peak, frame_right_peak) = self.reader.mix_into_with_channel_gains(
                buffer,
                offset_frames + frame_offset,
                1,
                output_channels,
                dynamic_gain * edge_gain,
                left_gain,
                right_gain,
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

    if frame_count <= 1 {
        return target_gain;
    }

    let gain_ratio = frame_offset as f32 / frame_count.saturating_sub(1).max(1) as f32;
    start_gain + (target_gain - start_gain) * gain_ratio
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

fn resolve_clip_runtime_gain(song: &Song, clip_id: &str, track_id: &str) -> f64 {
    let clip_gain = song
        .clips
        .iter()
        .find(|clip| clip.id == clip_id)
        .map(|clip| clip.gain)
        .unwrap_or(0.0);

    resolve_track_clip_gain(song, track_id, clip_gain).unwrap_or(0.0)
}

fn resolve_track_runtime_pan(song: &Song, track_id: &str) -> f32 {
    song.tracks
        .iter()
        .find(|track| track.id == track_id)
        .map(|track| track.pan as f32)
        .unwrap_or(0.0)
        .clamp(-1.0, 1.0)
}

fn constant_power_pan_gains(pan: f32) -> (f32, f32) {
    let angle = (pan.clamp(-1.0, 1.0) + 1.0) * PI * 0.25;
    (angle.cos(), angle.sin())
}

fn scheduled_clip_count(song: &Song, position_seconds: f64) -> usize {
    song.clips
        .iter()
        .filter(|clip| clip.timeline_start_seconds + clip.duration_seconds > position_seconds)
        .count()
}

#[cfg(test)]
fn probe_audio_file(file_path: &Path) -> Result<(), String> {
    let decoded = decode_audio_file(file_path)?;
    (decoded.frame_count() > 0)
        .then_some(())
        .ok_or_else(|| "empty audio stream".to_string())
}

fn resolve_track_clip_gain(
    song: &Song,
    track_id: &str,
    clip_gain: f64,
) -> Result<f64, DesktopError> {
    let track = song
        .tracks
        .iter()
        .find(|track| track.id == track_id)
        .ok_or_else(|| DesktopError::TrackNotFound(track_id.to_string()))?;

    if track.muted {
        return Ok(0.0);
    }

    let mut gain = track.volume;
    let mut cursor = track.parent_track_id.as_deref();

    while let Some(parent_track_id) = cursor {
        let parent_track = song
            .tracks
            .iter()
            .find(|track| track.id == parent_track_id)
            .ok_or_else(|| DesktopError::TrackNotFound(parent_track_id.to_string()))?;

        if parent_track.kind != TrackKind::Folder {
            return Err(DesktopError::TrackNotFound(parent_track_id.to_string()));
        }

        if parent_track.muted {
            return Ok(0.0);
        }

        gain *= parent_track.volume;
        cursor = parent_track.parent_track_id.as_deref();
    }

    Ok(gain * clip_gain)
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
            atomic::{AtomicU64, Ordering},
            mpsc, Arc,
        },
        thread,
        time::Duration,
    };

    use libretracks_core::{Clip, OutputBus, Song, TempoMetadata, TempoSource, Track};
    use rtrb::RingBuffer;
    use tempfile::tempdir;

    use super::{
        build_playback_plans, coalesce_sync_song_commands, drain_consumer_samples, env_flag,
        interpolated_gain, playback_reason_label, probe_audio_file, scheduled_clip_count,
        AudioBufferCache, AudioCommand, AudioCommandKind, AudioDebugConfig, AudioDebugSnapshot,
        AudioDebugState, MemoryClipReader, Mixer, OutputSample, PlaybackClipPlan,
        PlaybackStartReason, RestartReport, SharedAudioBuffer, StopReport, SyncReport,
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
                Arc::new(SharedAudioBuffer {
                    samples,
                    sample_rate,
                    channels,
                }),
            );
        cache
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
                cached_buffers: 1,
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
                cached_buffers: 1,
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
    fn playback_plan_edge_gain_applies_fades_in_sample_domain() {
        let plan = PlaybackClipPlan {
            clip_id: "clip".into(),
            track_id: "track".into(),
            file_path: PathBuf::from("audio/test.wav"),
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
        reader.mix_into(&mut mixed, 0, 2, 2, 1.0);

        assert_eq!(mixed, [0.25, -0.25, 0.5, -0.5]);
        assert!(reader.eof);
        assert_eq!(reader.current_frame, 2);
    }

    #[test]
    fn memory_clip_reader_applies_channel_gains_for_pan() {
        let clip_path = PathBuf::from("audio/pan-buffer.wav");
        let cache = cache_with_shared_buffer(&clip_path, vec![0.5, 0.25], 48_000, 1);
        let mut reader = MemoryClipReader::open(
            &PlaybackClipPlan {
                clip_id: "clip".into(),
                track_id: "track".into(),
                file_path: clip_path,
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
        let (left_peak, right_peak) =
            reader.mix_into_with_channel_gains(&mut mixed, 0, 2, 2, 1.0, 1.0, 0.0);

        assert_eq!(mixed, [0.5, 0.0, 0.25, 0.0]);
        assert!((left_peak - 0.5).abs() < 0.000_001);
        assert!(right_peak.abs() < 0.000_001);
    }

    #[test]
    fn constant_power_pan_gains_match_expected_edges_and_center() {
        let (hard_left_l, hard_left_r) = constant_power_pan_gains(-1.0);
        let (center_l, center_r) = constant_power_pan_gains(0.0);
        let (hard_right_l, hard_right_r) = constant_power_pan_gains(1.0);

        assert!((hard_left_l - 1.0).abs() < 0.000_001);
        assert!(hard_left_r.abs() < 0.000_001);
        assert!((center_l - 0.707_106_77).abs() < 0.000_1);
        assert!((center_r - 0.707_106_77).abs() < 0.000_1);
        assert!(hard_right_l.abs() < 0.000_001);
        assert!((hard_right_r - 1.0).abs() < 0.000_001);
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
        reader.mix_into(&mut mixed, 0, 1, 2, 1.0);

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
                    Arc::new(SharedAudioBuffer {
                        samples: vec![0.0; 48_000 * 5],
                        sample_rate: 48_000,
                        channels: 1,
                    }),
                ),
                (
                    song_dir.join("audio/late.wav"),
                    Arc::new(SharedAudioBuffer {
                        samples: vec![0.0; 48_000 * 5],
                        sample_rate: 48_000,
                        channels: 1,
                    }),
                ),
            ]);

        let mut mixer = Mixer::new(
            song_dir,
            song.clone(),
            0.0,
            48_000,
            1,
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
