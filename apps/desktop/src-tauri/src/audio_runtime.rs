use std::{
    collections::HashSet,
    fs::File,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        mpsc::{self, Receiver, Sender},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};

use cpal::{
    traits::{DeviceTrait, HostTrait, StreamTrait},
    Device, SampleFormat, Stream, StreamConfig,
};
use libretracks_core::{Song, TrackKind};
use serde::Serialize;
use symphonia::core::{
    codecs::{DecoderOptions, CODEC_TYPE_NULL},
    formats::FormatOptions,
    io::MediaSourceStream,
    meta::MetadataOptions,
    probe::Hint,
};

use crate::state::DesktopError;

const DEFAULT_DUMMY_GAIN: f32 = 0.12;
const DEFAULT_DUMMY_FREQUENCY_HZ: f32 = 440.0;

pub struct AudioRuntime {
    backend: AudioBackend,
}

pub struct AudioController {
    sender: Sender<AudioCommand>,
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

#[derive(Default)]
struct RenderShared {
    running: AtomicBool,
    gain_bits: AtomicU32,
    frequency_bits: AtomicU32,
}

enum AudioBackend {
    Cpal(CpalBackend),
    Null(NullBackend),
}

struct CpalBackend {
    _stream: Stream,
    shared: Arc<RenderShared>,
    _channels: usize,
    _sample_rate: u32,
}

struct NullBackend {
    shared: Arc<RenderShared>,
}

struct AssetProbeReport {
    opened_files: usize,
}

enum AudioCommand {
    Play {
        song_dir: PathBuf,
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
            reason: Some("dummy_callback".to_string()),
            elapsed_ms: report.elapsed.as_secs_f64() * 1000.0,
            scheduled_clips: report.updated_sinks,
            active_sinks: report.active_sinks,
            opened_files: 0,
        });
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
    fn new() -> Self {
        Self {
            backend: AudioBackend::new(),
        }
    }

    fn stop_all(&mut self) -> StopReport {
        let started_at = Instant::now();
        let stopped_sinks = usize::from(self.backend.is_running());
        self.backend.stop();

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
    ) -> RestartReport {
        let started_at = Instant::now();
        self.backend.stop();

        let scheduled_clips = scheduled_clip_count(song, position_seconds);
        let probe_report =
            probe_scheduled_audio_assets(song_dir, song, position_seconds, debug_config);
        let target_gain = dummy_gain_for_song(song);

        self.backend
            .start_dummy_tone(DEFAULT_DUMMY_FREQUENCY_HZ, target_gain);

        RestartReport {
            elapsed: started_at.elapsed(),
            scheduled_clips,
            active_sinks: usize::from(self.backend.is_running()),
            opened_files: probe_report.opened_files,
            cached_buffers: 0,
        }
    }

    fn sync_song(&mut self, song: &Song) -> SyncReport {
        let started_at = Instant::now();
        let updated_sinks = usize::from(
            self.backend
                .set_gain(dummy_gain_for_song(song))
                .unwrap_or(false),
        );

        SyncReport {
            elapsed: started_at.elapsed(),
            updated_sinks,
            active_sinks: usize::from(self.backend.is_running()),
        }
    }
}

impl AudioController {
    pub fn new() -> Self {
        let (sender, receiver) = mpsc::channel();
        let debug_config = AudioDebugConfig::from_env();

        thread::Builder::new()
            .name("libretracks-audio".into())
            .spawn(move || run_audio_thread(receiver, debug_config))
            .expect("audio thread should start");

        Self { sender }
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

impl AudioBackend {
    fn new() -> Self {
        match CpalBackend::new() {
            Ok(backend) => Self::Cpal(backend),
            Err(error) => {
                eprintln!("[libretracks-audio] falling back to null backend: {error}");
                Self::Null(NullBackend::new())
            }
        }
    }

    fn start_dummy_tone(&mut self, frequency_hz: f32, gain: f32) {
        let shared = self.shared();
        store_f32(&shared.frequency_bits, frequency_hz.max(1.0));
        store_f32(&shared.gain_bits, gain.max(0.0));
        shared.running.store(true, Ordering::Relaxed);
    }

    fn stop(&mut self) {
        let shared = self.shared();
        shared.running.store(false, Ordering::Relaxed);
        store_f32(&shared.gain_bits, 0.0);
    }

    fn set_gain(&mut self, gain: f32) -> Option<bool> {
        if !self.is_running() {
            return None;
        }

        let shared = self.shared();
        let current_gain = load_f32(&shared.gain_bits);
        let changed = (current_gain - gain).abs() > 0.0005;
        if changed {
            store_f32(&shared.gain_bits, gain.max(0.0));
        }

        Some(changed)
    }

    fn is_running(&self) -> bool {
        self.shared().running.load(Ordering::Relaxed)
    }

    fn shared(&self) -> &Arc<RenderShared> {
        match self {
            AudioBackend::Cpal(backend) => &backend.shared,
            AudioBackend::Null(backend) => &backend.shared,
        }
    }
}

impl CpalBackend {
    fn new() -> Result<Self, String> {
        let host = cpal::default_host();
        let device = host
            .default_output_device()
            .ok_or_else(|| "no default output device available".to_string())?;
        let supported_config = device
            .default_output_config()
            .map_err(|error| error.to_string())?;
        let sample_format = supported_config.sample_format();
        let config: StreamConfig = supported_config.into();
        let channels = usize::from(config.channels.max(1));
        let sample_rate = config.sample_rate.0.max(1);
        let shared = Arc::new(RenderShared::default());
        let stream = build_output_stream(&device, &config, sample_format, Arc::clone(&shared))?;
        stream.play().map_err(|error| error.to_string())?;

        Ok(Self {
            _stream: stream,
            shared,
            _channels: channels,
            _sample_rate: sample_rate,
        })
    }
}

impl NullBackend {
    fn new() -> Self {
        Self {
            shared: Arc::new(RenderShared::default()),
        }
    }
}

fn build_output_stream(
    device: &Device,
    config: &StreamConfig,
    sample_format: SampleFormat,
    shared: Arc<RenderShared>,
) -> Result<Stream, String> {
    let channels = usize::from(config.channels.max(1));
    let sample_rate = config.sample_rate.0.max(1) as f32;
    let error_callback = |error| eprintln!("[libretracks-audio] cpal stream error: {error}");

    match sample_format {
        SampleFormat::F32 => {
            let mut phase = 0.0_f32;
            device
                .build_output_stream(
                    config,
                    move |data: &mut [f32], _| {
                        write_output_buffer_f32(data, channels, sample_rate, &shared, &mut phase);
                    },
                    error_callback,
                    None,
                )
                .map_err(|error| error.to_string())
        }
        SampleFormat::I16 => {
            let mut phase = 0.0_f32;
            device
                .build_output_stream(
                    config,
                    move |data: &mut [i16], _| {
                        write_output_buffer_i16(data, channels, sample_rate, &shared, &mut phase);
                    },
                    error_callback,
                    None,
                )
                .map_err(|error| error.to_string())
        }
        SampleFormat::U16 => {
            let mut phase = 0.0_f32;
            device
                .build_output_stream(
                    config,
                    move |data: &mut [u16], _| {
                        write_output_buffer_u16(data, channels, sample_rate, &shared, &mut phase);
                    },
                    error_callback,
                    None,
                )
                .map_err(|error| error.to_string())
        }
        other => Err(format!("unsupported output sample format: {other:?}")),
    }
}

fn write_output_buffer_f32(
    data: &mut [f32],
    channels: usize,
    sample_rate: f32,
    shared: &RenderShared,
    phase: &mut f32,
) {
    render_mono_samples(data, channels, sample_rate, shared, phase, |sample| sample);
}

fn write_output_buffer_i16(
    data: &mut [i16],
    channels: usize,
    sample_rate: f32,
    shared: &RenderShared,
    phase: &mut f32,
) {
    render_mono_samples(data, channels, sample_rate, shared, phase, |sample| {
        (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16
    });
}

fn write_output_buffer_u16(
    data: &mut [u16],
    channels: usize,
    sample_rate: f32,
    shared: &RenderShared,
    phase: &mut f32,
) {
    render_mono_samples(data, channels, sample_rate, shared, phase, |sample| {
        (((sample.clamp(-1.0, 1.0) * 0.5) + 0.5) * u16::MAX as f32) as u16
    });
}

fn render_mono_samples<T>(
    data: &mut [T],
    channels: usize,
    sample_rate: f32,
    shared: &RenderShared,
    phase: &mut f32,
    convert: impl Fn(f32) -> T,
) where
    T: Copy,
{
    let running = shared.running.load(Ordering::Relaxed);
    let gain = load_f32(&shared.gain_bits);
    let frequency_hz = load_f32(&shared.frequency_bits).max(1.0);
    let phase_step = frequency_hz / sample_rate.max(1.0);

    for frame in data.chunks_mut(channels.max(1)) {
        let sample = if running {
            let value = (*phase * std::f32::consts::TAU).sin() * gain;
            *phase = (*phase + phase_step).fract();
            value
        } else {
            *phase = 0.0;
            0.0
        };

        let converted = convert(sample);
        for output in frame {
            *output = converted;
        }
    }
}

fn run_audio_thread(receiver: Receiver<AudioCommand>, debug_config: AudioDebugConfig) {
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

                let report = ensure_runtime(&mut runtime).restart(
                    &song_dir,
                    &song,
                    position_seconds,
                    debug_config,
                );
                debug_state.record_restart(
                    reason,
                    position_seconds,
                    song.duration_seconds,
                    &report,
                );

                let _ = respond_to.send(Ok(()));
            }
            AudioCommand::SyncSong { song, respond_to } => {
                let (song, respond_tos, next_deferred) =
                    coalesce_sync_song_commands(&receiver, song, respond_to);
                deferred_command = next_deferred;

                debug_state
                    .record_command(AudioCommandKind::SyncSong, Some("mix_only".to_string()));

                let report = ensure_runtime(&mut runtime).sync_song(&song);
                debug_state.record_sync(&report);

                for respond_to in respond_tos {
                    let _ = respond_to.send(Ok(()));
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
                break;
            }
        }
    }
}

fn ensure_runtime(runtime: &mut Option<AudioRuntime>) -> &mut AudioRuntime {
    runtime.get_or_insert_with(AudioRuntime::new)
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

fn scheduled_clip_count(song: &Song, position_seconds: f64) -> usize {
    song.clips
        .iter()
        .filter(|clip| clip.timeline_start_seconds + clip.duration_seconds > position_seconds)
        .count()
}

fn probe_scheduled_audio_assets(
    song_dir: &Path,
    song: &Song,
    position_seconds: f64,
    debug_config: AudioDebugConfig,
) -> AssetProbeReport {
    let mut unique_paths = HashSet::new();
    let mut opened_files = 0;

    for clip in song
        .clips
        .iter()
        .filter(|clip| clip.timeline_start_seconds + clip.duration_seconds > position_seconds)
    {
        let full_path = song_dir.join(&clip.file_path);
        if !unique_paths.insert(full_path.clone()) {
            continue;
        }

        if probe_audio_file(&full_path).is_ok() {
            opened_files += 1;
            continue;
        }

        if debug_config.enabled || debug_config.log_commands {
            eprintln!(
                "[libretracks-audio] symphonia probe skipped for {}",
                full_path.display()
            );
        }
    }

    AssetProbeReport { opened_files }
}

fn probe_audio_file(file_path: &Path) -> Result<(), String> {
    let file = File::open(file_path).map_err(|error| error.to_string())?;
    let mut hint = Hint::new();
    if let Some(extension) = file_path.extension().and_then(|value| value.to_str()) {
        hint.with_extension(extension);
    }

    let media_source_stream = MediaSourceStream::new(Box::new(file), Default::default());
    let mut probed = symphonia::default::get_probe()
        .format(
            &hint,
            media_source_stream,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|error| error.to_string())?;

    let track = probed
        .format
        .default_track()
        .or_else(|| {
            probed
                .format
                .tracks()
                .iter()
                .find(|track| track.codec_params.codec != CODEC_TYPE_NULL)
        })
        .ok_or_else(|| "no decodable audio track found".to_string())?;

    let track_id = track.id;
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|error| error.to_string())?;

    loop {
        let packet = probed
            .format
            .next_packet()
            .map_err(|error| error.to_string())?;
        if packet.track_id() != track_id {
            continue;
        }

        decoder.decode(&packet).map_err(|error| error.to_string())?;
        return Ok(());
    }
}

fn dummy_gain_for_song(song: &Song) -> f32 {
    let has_audible_clip = song.clips.iter().any(|clip| {
        resolve_track_clip_gain(song, &clip.track_id, clip.gain)
            .map(|gain| gain > 0.0)
            .unwrap_or(false)
    });

    if has_audible_clip {
        DEFAULT_DUMMY_GAIN
    } else {
        0.0
    }
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

fn store_f32(target: &AtomicU32, value: f32) {
    target.store(value.to_bits(), Ordering::Relaxed);
}

fn load_f32(source: &AtomicU32) -> f32 {
    f32::from_bits(source.load(Ordering::Relaxed))
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
        AudioCommandKind::SyncSong => "sync_song",
        AudioCommandKind::Stop => "stop",
        AudioCommandKind::DebugSnapshot => "debug_snapshot",
        AudioCommandKind::Shutdown => "shutdown",
    }
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf, sync::mpsc, thread, time::Duration};

    use libretracks_core::{Clip, OutputBus, Song, TempoMetadata, TempoSource, Track};
    use tempfile::tempdir;

    use super::{
        coalesce_sync_song_commands, dummy_gain_for_song, env_flag, playback_reason_label,
        probe_audio_file, scheduled_clip_count, AudioCommand, AudioCommandKind, AudioDebugConfig,
        AudioDebugSnapshot, AudioDebugState, PlaybackStartReason, RestartReport, StopReport,
        SyncReport,
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

    #[test]
    fn playback_reason_labels_match_command_telemetry() {
        assert_eq!(playback_reason_label(PlaybackStartReason::Seek), "seek");
        assert_eq!(
            playback_reason_label(PlaybackStartReason::StructureRebuild),
            "structure_rebuild"
        );
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
                opened_files: 2,
                cached_buffers: 0,
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
                opened_files: 1,
                cached_buffers: 0,
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
    fn dummy_gain_drops_to_zero_when_track_is_muted() {
        let mut song = demo_song();
        song.tracks[1].muted = true;

        assert_eq!(dummy_gain_for_song(&song), 0.0);
        assert!(dummy_gain_for_song(&demo_song()) > 0.0);
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
