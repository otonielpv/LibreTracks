mod backend;
mod mixer;
mod pitch;
mod playback_dump;
mod source;
mod telemetry;

use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError, Sender},
        Arc, RwLock,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use cpal::{
    traits::{DeviceTrait, StreamTrait},
    SampleFormat, Stream, StreamConfig,
};
use libretracks_core::Song;
use libretracks_remote::RemoteServerHandle;
use rtrb::RingBuffer;
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::error::DesktopError;
use crate::settings::AppSettings;

use self::backend::{
    actual_buffer_size_frames, build_output_stream, enumerate_output_devices,
    is_system_default_backend_candidate, resolve_output_device, resolve_output_stream_config,
    sample_format_from_cpal, spawn_disk_reader, stream_config_with_buffer_request,
    AudioDeviceDescriptor, AudioDeviceResolveError, AudioOutputRequest, AudioRuntimeCounters,
    BackendPolicy, DiskReaderReport, DiskReaderState, OutputSample, PrefillResult,
    ResolvedOutputStreamConfig,
};
#[cfg(test)]
use self::backend::{drain_consumer_samples, CpalCrossfadeState};
pub use self::backend::{
    AudioBackendKind, AudioBufferSizeRequest, AudioSampleFormat, OutputChannelRequest,
};
#[cfg(test)]
use self::mixer::{
    apply_runtime_pan, build_live_mix_map, build_playback_plans, interpolated_gain,
    resolve_track_runtime_pan, set_zero_latency_test_mode, PlaybackClipPlan,
};
use self::mixer::{replace_shared_live_mix, update_shared_track_mix, LiveTrackMix, Mixer};
#[cfg(test)]
use self::source::{prepare_audio_source, probe_audio_file, MemoryClipReader, SharedAudioSource};
use self::source::{AudioBufferCache, AudioBufferCacheStats};
pub use self::telemetry::AudioDebugSnapshot;
#[cfg(test)]
use self::telemetry::{command_kind_label, env_flag};
use self::telemetry::{
    playback_reason_label, AudioBackendCountersSummary, AudioDebugConfig, AudioDebugState,
    FarSeekTelemetry, RestartReport, StopReport, SyncReport,
};

const DISK_RENDER_BLOCK_FRAMES: usize = 512;
const STOP_FADE_DURATION_SECONDS: f64 = 0.005;
const GAIN_EPSILON: f32 = 0.000_001;
const AUDIO_METER_EVENT: &str = "audio:meters";
const AUDIO_METER_EMIT_INTERVAL: Duration = Duration::from_millis(16);
const AUDIO_SHORT_COMMAND_RESPONSE_TIMEOUT: Duration = Duration::from_millis(250);
const AUDIO_LONG_COMMAND_RESPONSE_TIMEOUT: Duration = Duration::from_millis(5_000);
const MAX_HIERARCHY_DEPTH: usize = 16;

type SharedAppHandle = Arc<RwLock<Option<AppHandle>>>;
type SharedRemoteHandle = Arc<RwLock<Option<RemoteServerHandle>>>;
type SharedTrackMixState = Arc<RwLock<HashMap<String, LiveTrackMix>>>;
type SharedAudioSettings = Arc<RwLock<AppSettings>>;

pub struct AudioRuntime {
    session: Option<PlaybackSession>,
    audio_buffers: AudioBufferCache,
    app_handle: SharedAppHandle,
    remote_handle: SharedRemoteHandle,
    live_mix_state: SharedTrackMixState,
    audio_settings: SharedAudioSettings,
}

pub struct AudioController {
    sender: Sender<AudioCommand>,
    audio_buffers: AudioBufferCache,
    app_handle: SharedAppHandle,
    remote_handle: SharedRemoteHandle,
    live_mix_state: SharedTrackMixState,
    audio_settings: SharedAudioSettings,
    audio_thread_handle: Option<JoinHandle<()>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioOutputDevicesResponse {
    pub devices: Vec<String>,
    pub default_device: Option<String>,
    pub channel_counts: HashMap<String, usize>,
    pub backends: Vec<AudioBackendKind>,
    pub device_descriptors: Vec<AudioDeviceDescriptor>,
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
    ApplySettings,
    Stop,
    StartMasterFade,
    DebugSnapshot,
    Shutdown,
}

pub(crate) enum AudioCommand {
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
    TimelineIntent {
        song_dir: PathBuf,
        song: Song,
        position_seconds: f64,
        respond_to: Sender<Result<(), String>>,
    },
    SyncSong {
        song: Song,
        respond_to: Sender<Result<(), String>>,
    },
    ApplySettings {
        settings: AppSettings,
        rebuild_stream: bool,
        respond_to: Sender<Result<(), String>>,
    },
    Stop {
        respond_to: Sender<Result<(), String>>,
    },
    StartMasterFade {
        target_gain: f32,
        duration_seconds: f64,
        respond_to: Sender<Result<(), String>>,
    },
    DebugSnapshot {
        respond_to: Sender<AudioDebugSnapshot>,
    },
    Shutdown,
}

struct PlaybackSession {
    backend: PlaybackBackend,
    song_dir: PathBuf,
    reader_sender: Option<Sender<ReaderCommand>>,
    reader_handle: Option<JoinHandle<DiskReaderReport>>,
    seek_generation: Arc<AtomicU64>,
    counters: Arc<AudioRuntimeCounters>,
    backend_kind: Option<AudioBackendKind>,
    device_name: Option<String>,
    output_sample_rate: u32,
    actual_buffer_size: usize,
    ring_capacity_frames: usize,
    prefill_frames: usize,
    prefill_result: PrefillResult,
    startup_readiness: mixer::MixerStartupReadiness,
    audio_buffers: AudioBufferCache,
}

enum PlaybackBackend {
    Cpal { _stream: Stream },
    Null,
}

enum ReaderCommand {
    UpdateSong(Song),
    Play {
        song: Song,
        position_seconds: f64,
        reason: PlaybackStartReason,
        generation: u64,
    },
    Seek {
        song: Song,
        position_seconds: f64,
        reason: PlaybackStartReason,
        generation: u64,
    },
    Stop {
        fade_duration_seconds: f64,
    },
    StartMasterFade {
        target_gain: f32,
        duration_seconds: f64,
    },
    Shutdown,
}

impl AudioRuntime {
    fn new(
        audio_buffers: AudioBufferCache,
        app_handle: SharedAppHandle,
        remote_handle: SharedRemoteHandle,
        live_mix_state: SharedTrackMixState,
        audio_settings: SharedAudioSettings,
    ) -> Self {
        Self {
            session: None,
            audio_buffers,
            app_handle,
            remote_handle,
            live_mix_state,
            audio_settings,
        }
    }

    fn stop_all(&mut self) -> StopReport {
        let started_at = Instant::now();
        let stopped_sinks = usize::from(self.session.is_some());

        if let Some(session) = self.session.as_mut() {
            let _ = session.stop_playback();
        }

        StopReport {
            elapsed: started_at.elapsed(),
            stopped_sinks,
        }
    }

    fn close_stream(&mut self) -> StopReport {
        let started_at = Instant::now();
        let stopped_sinks = usize::from(self.session.is_some());
        if let Some(session) = self.session.take() {
            let _ = session.shutdown();
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
        reason: PlaybackStartReason,
        debug_config: AudioDebugConfig,
    ) -> Result<RestartReport, String> {
        let started_at = Instant::now();
        let scheduled_clips = scheduled_clip_count(song, position_seconds);
        let cache_stats = if let Some(session) = self.session.as_mut() {
            if session.song_dir == song_dir {
                session.play(song.clone(), position_seconds, reason)?;
                session.cache_stats()
            } else {
                let old_session = self.session.take();
                if let Some(session) = old_session {
                    let _ = session.shutdown();
                }
                let session = PlaybackSession::start(
                    song_dir.to_path_buf(),
                    song.clone(),
                    position_seconds,
                    self.app_handle.clone(),
                    self.remote_handle.clone(),
                    self.live_mix_state.clone(),
                    self.audio_settings.clone(),
                    debug_config,
                    self.audio_buffers.clone(),
                )?;
                let cache_stats = session.cache_stats();
                self.session = Some(session);
                cache_stats
            }
        } else {
            let session = PlaybackSession::start(
                song_dir.to_path_buf(),
                song.clone(),
                position_seconds,
                self.app_handle.clone(),
                self.remote_handle.clone(),
                self.live_mix_state.clone(),
                self.audio_settings.clone(),
                debug_config,
                self.audio_buffers.clone(),
            )?;
            let cache_stats = session.cache_stats();
            self.session = Some(session);
            cache_stats
        };

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

    fn seek(
        &mut self,
        song: &Song,
        position_seconds: f64,
        reason: PlaybackStartReason,
    ) -> Result<SeekReport, String> {
        match self.session.as_mut() {
            Some(session) => session.seek(song.clone(), position_seconds, reason),
            None => Ok(SeekReport {
                active_sinks: 0,
                far_seek: FarSeekTelemetry {
                    cache_status: "Silence".to_string(),
                    playback_path: "PreparedSource".to_string(),
                    exact_ready: false,
                    used_fallback: true,
                    prepare_requested: false,
                    swap_to_exact_ms: None,
                },
            }),
        }
    }

    fn start_master_fade(&mut self, target_gain: f32, duration_seconds: f64) -> Result<(), String> {
        if let Some(session) = self.session.as_mut() {
            session.start_master_fade(target_gain, duration_seconds)?;
        }
        Ok(())
    }

    fn master_gain(&self) -> f32 {
        self.session
            .as_ref()
            .map(PlaybackSession::master_gain)
            .unwrap_or(1.0)
    }

    fn backend_counters_snapshot(&self) -> AudioBackendCountersSummary {
        self.session
            .as_ref()
            .map(PlaybackSession::counters_snapshot)
            .unwrap_or_default()
    }
}

impl AudioController {
    pub fn new() -> Self {
        let (sender, receiver) = mpsc::channel();
        let debug_config = AudioDebugConfig::from_env();
        let audio_buffers = AudioBufferCache::default();
        let app_handle = Arc::new(RwLock::new(None));
        let remote_handle = Arc::new(RwLock::new(None));
        let live_mix_state = Arc::new(RwLock::new(HashMap::new()));
        let audio_settings = Arc::new(RwLock::new(AppSettings::default()));
        let runtime_audio_buffers = audio_buffers.clone();
        let runtime_app_handle = app_handle.clone();
        let runtime_remote_handle = remote_handle.clone();
        let runtime_live_mix_state = live_mix_state.clone();
        let runtime_audio_settings = audio_settings.clone();

        let audio_thread_handle = thread::Builder::new()
            .name("libretracks-audio".into())
            .spawn(move || {
                run_audio_thread(
                    receiver,
                    debug_config,
                    runtime_audio_buffers,
                    runtime_app_handle,
                    runtime_remote_handle,
                    runtime_live_mix_state,
                    runtime_audio_settings,
                )
            })
            .expect("audio thread should start");

        Self {
            sender,
            audio_buffers,
            app_handle,
            remote_handle,
            live_mix_state,
            audio_settings,
            audio_thread_handle: Some(audio_thread_handle),
        }
    }

    pub fn attach_app_handle(&self, app_handle: AppHandle) {
        if let Ok(mut shared_app_handle) = self.app_handle.write() {
            *shared_app_handle = Some(app_handle);
        }
    }

    pub fn attach_remote_handle(&self, remote_handle: RemoteServerHandle) {
        if let Ok(mut shared_remote_handle) = self.remote_handle.write() {
            *shared_remote_handle = Some(remote_handle);
        }
    }

    pub(crate) fn command_sender(&self) -> Sender<AudioCommand> {
        self.sender.clone()
    }

    pub fn play(
        &self,
        song_dir: PathBuf,
        song: Song,
        position_seconds: f64,
        reason: PlaybackStartReason,
    ) -> Result<(), DesktopError> {
        self.sync_live_mix(&song)?;
        self.request_long(|respond_to| AudioCommand::Play {
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

    pub fn on_timeline_hover_or_drag(
        &self,
        song_dir: PathBuf,
        song: Song,
        position_seconds: f64,
    ) -> Result<(), DesktopError> {
        self.request(|respond_to| AudioCommand::TimelineIntent {
            song_dir,
            song,
            position_seconds,
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
        audio_to: Option<&str>,
    ) -> Result<(), DesktopError> {
        update_shared_track_mix(
            &self.live_mix_state,
            track_id,
            volume,
            pan,
            muted,
            solo,
            audio_to,
        )
        .map_err(DesktopError::AudioCommand)
    }

    pub fn current_settings(&self) -> Result<AppSettings, DesktopError> {
        self.audio_settings
            .read()
            .map(|settings| settings.clone())
            .map_err(|_| DesktopError::AudioCommand("audio settings lock poisoned".into()))
    }

    pub fn apply_settings(&self, settings: AppSettings) -> Result<(), DesktopError> {
        self.apply_settings_with_stream_rebuild(settings, false)
    }

    pub fn apply_settings_with_stream_rebuild(
        &self,
        settings: AppSettings,
        rebuild_stream: bool,
    ) -> Result<(), DesktopError> {
        self.request_long(|respond_to| AudioCommand::ApplySettings {
            settings,
            rebuild_stream,
            respond_to,
        })
    }

    pub fn stop(&self) -> Result<(), DesktopError> {
        self.request_long(|respond_to| AudioCommand::Stop { respond_to })
    }

    pub fn start_master_fade(
        &self,
        target_gain: f32,
        duration_seconds: f64,
    ) -> Result<(), DesktopError> {
        self.request(|respond_to| AudioCommand::StartMasterFade {
            target_gain,
            duration_seconds,
            respond_to,
        })
    }

    pub fn debug_snapshot(&self) -> Result<AudioDebugSnapshot, DesktopError> {
        let (respond_to, response) = mpsc::channel();

        self.sender
            .send(AudioCommand::DebugSnapshot { respond_to })
            .map_err(|_| DesktopError::AudioThreadUnavailable)?;

        recv_audio_response(response, AUDIO_SHORT_COMMAND_RESPONSE_TIMEOUT)
    }

    pub fn replace_song_buffers(&self, song_dir: &Path, song: &Song) -> Result<(), DesktopError> {
        self.audio_buffers
            .replace_song_buffers(song_dir, song)
            .map_err(DesktopError::AudioCommand)
    }

    pub fn prepare_song_buffers_async(&self, song_dir: PathBuf, song: Song) {
        let audio_buffers = self.audio_buffers.clone();
        let _ = thread::Builder::new()
            .name("libretracks-audio-prepare".into())
            .spawn(move || {
                if let Err(error) = audio_buffers.replace_song_buffers(&song_dir, &song) {
                    eprintln!("[libretracks-audio] async prepare failed: {error}");
                }
            });
    }

    pub fn export_region_rendered_audio(
        &self,
        song_dir: PathBuf,
        song: Song,
        region_id: &str,
        output_path: &Path,
    ) -> Result<(), DesktopError> {
        self.replace_song_buffers(&song_dir, &song)?;

        let region = song
            .regions
            .iter()
            .find(|region| region.id == region_id)
            .cloned()
            .ok_or_else(|| DesktopError::RegionNotFound(region_id.to_string()))?;
        self.audio_buffers.record_recent_seek_and_reprioritize(
            &song_dir,
            &song,
            region.start_seconds,
            region.transpose_semitones,
        );

        let render_live_mix_state = Arc::new(RwLock::new(HashMap::new()));
        let render_app_handle = Arc::new(RwLock::new(None));
        let render_remote_handle = Arc::new(RwLock::new(None));
        let render_audio_settings = Arc::new(RwLock::new(self.current_settings()?));
        let mut mixer = Mixer::new(
            song_dir,
            song,
            region.start_seconds,
            48_000,
            2,
            render_app_handle,
            render_remote_handle,
            render_live_mix_state,
            render_audio_settings,
            AudioDebugConfig::from_env(),
            self.audio_buffers.clone(),
        );

        let total_frames = seconds_to_frames(
            (region.end_seconds - region.start_seconds).max(0.0),
            mixer.output_sample_rate,
        ) as usize;
        let spec = hound::WavSpec {
            channels: mixer.output_channels.max(1) as u16,
            sample_rate: mixer.output_sample_rate.max(1),
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(output_path, spec)
            .map_err(|error| DesktopError::AudioCommand(error.to_string()))?;

        let mut remaining_frames = total_frames;
        while remaining_frames > 0 {
            let block_frames = remaining_frames.min(DISK_RENDER_BLOCK_FRAMES);
            let block = mixer.render_next_block(block_frames);
            for sample in block {
                let clamped = sample.clamp(-1.0, 1.0);
                let pcm = (clamped * i16::MAX as f32) as i16;
                writer
                    .write_sample(pcm)
                    .map_err(|error| DesktopError::AudioCommand(error.to_string()))?;
            }
            remaining_frames -= block_frames;
        }

        writer
            .finalize()
            .map_err(|error| DesktopError::AudioCommand(error.to_string()))?;

        Ok(())
    }

    fn request(
        &self,
        command: impl FnOnce(Sender<Result<(), String>>) -> AudioCommand,
    ) -> Result<(), DesktopError> {
        let (respond_to, response) = mpsc::channel();

        self.sender
            .send(command(respond_to))
            .map_err(|_| DesktopError::AudioThreadUnavailable)?;

        recv_audio_response(response, AUDIO_SHORT_COMMAND_RESPONSE_TIMEOUT)?
            .map_err(DesktopError::AudioCommand)
    }

    fn request_long(
        &self,
        command: impl FnOnce(Sender<Result<(), String>>) -> AudioCommand,
    ) -> Result<(), DesktopError> {
        let (respond_to, response) = mpsc::channel();

        self.sender
            .send(command(respond_to))
            .map_err(|_| DesktopError::AudioThreadUnavailable)?;

        recv_audio_response(response, AUDIO_LONG_COMMAND_RESPONSE_TIMEOUT)?
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
        if let Some(audio_thread_handle) = self.audio_thread_handle.take() {
            let _ = audio_thread_handle.join();
        }
    }
}

impl PlaybackSession {
    fn start(
        song_dir: PathBuf,
        song: Song,
        position_seconds: f64,
        app_handle: SharedAppHandle,
        remote_handle: SharedRemoteHandle,
        live_mix_state: SharedTrackMixState,
        audio_settings: SharedAudioSettings,
        debug_config: AudioDebugConfig,
        audio_buffers: AudioBufferCache,
    ) -> Result<Self, String> {
        let output_request = audio_settings
            .read()
            .ok()
            .map(|settings| AudioOutputRequest {
                backend: settings.selected_audio_backend,
                device_id: settings
                    .selected_output_device_id
                    .clone()
                    .and_then(|value| trimmed_nonempty(value)),
                device_name: settings
                    .selected_output_device_name
                    .clone()
                    .or_else(|| settings.selected_output_device.clone())
                    .and_then(|value| trimmed_nonempty(value)),
                sample_rate: settings.output_sample_rate,
                buffer_size: settings.output_buffer_size.clone(),
                output_channels: OutputChannelRequest {
                    channels: if settings.output_channel_mapping.channels.is_empty() {
                        settings.enabled_output_channels.clone()
                    } else {
                        settings.output_channel_mapping.channels.clone()
                    },
                },
                sample_format: settings.output_sample_format,
                low_latency_mode: settings
                    .selected_audio_backend
                    .is_some_and(|backend| backend == AudioBackendKind::Asio),
                safe_mode: settings.audio_safe_mode,
            })
            .unwrap_or_else(|| AudioOutputRequest {
                backend: None,
                device_id: None,
                device_name: None,
                sample_rate: None,
                buffer_size: AudioBufferSizeRequest::Default,
                output_channels: OutputChannelRequest::default(),
                sample_format: None,
                low_latency_mode: false,
                safe_mode: false,
            });
        log_requested_output_device(&output_request);
        let (host_id, _host, device) = match resolve_output_device(&output_request) {
            Ok(resolved) => resolved,
            Err(AudioDeviceResolveError::NoDefaultOutputDevice)
                if !output_request.has_explicit_device_selection() =>
            {
                eprintln!(
                    "[libretracks-audio] no default output device available, using null backend"
                );
                return Ok(Self {
                    backend: PlaybackBackend::Null,
                    song_dir,
                    reader_sender: None,
                    reader_handle: None,
                    seek_generation: Arc::new(AtomicU64::new(0)),
                    counters: Arc::new(AudioRuntimeCounters::default()),
                    backend_kind: None,
                    device_name: None,
                    output_sample_rate: 0,
                    actual_buffer_size: 0,
                    ring_capacity_frames: 0,
                    prefill_frames: 0,
                    prefill_result: PrefillResult::default(),
                    startup_readiness: mixer::MixerStartupReadiness::default(),
                    audio_buffers,
                });
            }
            Err(error) => {
                log_stream_open_failure(&output_request, error.failure_stage(), &error.to_string());
                return Err(error.to_string());
            }
        };

        let device_name = device.name().unwrap_or_else(|_| "unknown".to_string());
        let backend_kind = backend::backend_kind_from_host_id(host_id);
        let resolved_config =
            resolve_output_stream_config(&device, &output_request).map_err(|error| {
                let message = error.to_string();
                log_stream_open_failure(&output_request, "config_not_supported", &message);
                message
            })?;
        log_resolved_output_config(&device_name, &resolved_config);
        let supported_config = resolved_config.supported_config;
        let sample_format = supported_config.sample_format();
        let config = stream_config_with_buffer_request(&supported_config, &output_request);
        let output_channels = usize::from(config.channels.max(1));
        let output_sample_rate = config.sample_rate.0.max(1);
        let actual_buffer_size = actual_buffer_size_frames(&config, &supported_config).max(1);
        let policy = BackendPolicy::for_backend(backend_kind, output_request.safe_mode);
        let ring_capacity_frames = policy.ring_capacity_frames(actual_buffer_size);
        let prefill_frames = policy.prefill_frames(actual_buffer_size, ring_capacity_frames);
        let ring_capacity_samples = ring_capacity_frames.saturating_mul(output_channels.max(1));
        let (producer, consumer) = RingBuffer::<OutputSample>::new(ring_capacity_samples);
        let (reader_sender, reader_receiver) = mpsc::channel();
        let seek_generation = Arc::new(AtomicU64::new(0));
        let counters = Arc::new(AudioRuntimeCounters::default());

        let mixer = Mixer::new(
            song_dir.clone(),
            song.clone(),
            position_seconds,
            output_sample_rate,
            output_channels,
            app_handle.clone(),
            remote_handle,
            live_mix_state,
            audio_settings,
            debug_config,
            audio_buffers.clone(),
        );
        let startup_readiness = mixer.startup_readiness();
        log_startup_readiness(
            backend_kind,
            &device_name,
            output_sample_rate,
            &startup_readiness,
        );

        let reader_handle = spawn_disk_reader(DiskReaderState {
            mixer,
            producer,
            command_receiver: reader_receiver,
            current_generation: 0,
            is_running: true,
            stop_after_master_fade: false,
        });

        let mut prefill_result = wait_for_prefill(
            &consumer,
            prefill_frames,
            output_channels,
            Duration::from_millis(250),
        );
        if backend_kind == AudioBackendKind::Asio && !prefill_result.completed {
            prefill_result = wait_for_prefill(
                &consumer,
                prefill_frames,
                output_channels,
                Duration::from_millis(1_500),
            );
        }
        log_prefill_result(backend_kind, prefill_result);
        if backend_kind == AudioBackendKind::Asio
            && (!prefill_result.completed || !startup_readiness.all_realtime_pitch_engines_ready)
        {
            #[cfg(debug_assertions)]
            {
                return Err(format!(
                    "ASIO startup preflight failed: prefill_completed={}, realtime_ready={}, requested_frames={}, available_frames={}, realtime_pitch_clip_count={}, min_queued_pitch_output_frames={}",
                    prefill_result.completed,
                    startup_readiness.all_realtime_pitch_engines_ready,
                    prefill_result.requested_frames,
                    prefill_result.available_frames,
                    startup_readiness.realtime_pitch_clip_count,
                    startup_readiness.min_queued_pitch_output_frames
                ));
            }
        }

        let stream = build_output_stream(
            &device,
            &config,
            sample_format,
            consumer,
            seek_generation.clone(),
            counters.clone(),
        )
        .map_err(|error| {
            log_stream_open_failure(&output_request, "stream_build_failed", &error);
            error
        })?;
        log_audio_startup_to_file(
            &app_handle,
            backend_kind,
            &device_name,
            output_sample_rate,
            actual_buffer_size,
            ring_capacity_frames,
            prefill_frames,
            prefill_result,
            &startup_readiness,
        );
        stream.play().map_err(|error| {
            let message = error.to_string();
            log_stream_open_failure(&output_request, "stream_play_failed", &message);
            message
        })?;

        Ok(Self {
            backend: PlaybackBackend::Cpal { _stream: stream },
            song_dir,
            reader_sender: Some(reader_sender),
            reader_handle: Some(reader_handle),
            seek_generation,
            counters,
            backend_kind: Some(backend_kind),
            device_name: Some(device_name),
            output_sample_rate,
            actual_buffer_size,
            ring_capacity_frames,
            prefill_frames,
            prefill_result,
            startup_readiness,
            audio_buffers,
        })
    }

    fn cache_stats(&self) -> AudioBufferCacheStats {
        self.audio_buffers.stats()
    }

    fn counters_snapshot(&self) -> AudioBackendCountersSummary {
        AudioBackendCountersSummary {
            backend: self.backend_kind.map(|backend| format!("{backend:?}")),
            device: self.device_name.clone(),
            sample_rate: self.output_sample_rate,
            actual_buffer_size: self.actual_buffer_size,
            ring_capacity_frames: self.ring_capacity_frames,
            prefill_frames: self.prefill_frames,
            prefill_completed: self.prefill_result.completed,
            prefill_available_frames: self.prefill_result.available_frames,
            callback_count: self.counters.callback_count.load(Ordering::Relaxed),
            callback_min_frames: self.counters.callback_min_frames.load(Ordering::Relaxed),
            callback_max_frames: self.counters.callback_max_frames.load(Ordering::Relaxed),
            valid_rendered_frames: self.counters.valid_rendered_frames.load(Ordering::Relaxed),
            underrun_frames: self.counters.underrun_frames.load(Ordering::Relaxed),
            xrun_count: self.counters.xrun_count.load(Ordering::Relaxed),
            needs_resync: self.counters.needs_resync.load(Ordering::Acquire),
            stale_drop_count: self.counters.stale_drop_count.load(Ordering::Relaxed),
            resync_count: self.counters.resync_count.load(Ordering::Relaxed),
            realtime_pitch_clip_count: self.startup_readiness.realtime_pitch_clip_count,
            min_queued_pitch_output_frames: self.startup_readiness.min_queued_pitch_output_frames,
            clip_diagnostics: self.startup_readiness.clip_diagnostics.clone(),
        }
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

    fn seek(
        &mut self,
        song: Song,
        position_seconds: f64,
        reason: PlaybackStartReason,
    ) -> Result<SeekReport, String> {
        let required_transpose = transpose_for_song_position(&song, position_seconds);
        let decision = self.audio_buffers.get_best_source_for_seek(
            &self.song_dir,
            &song,
            position_seconds,
            required_transpose,
        );
        let decision_kind = decision.kind();
        self.audio_buffers.record_recent_seek_and_reprioritize(
            &self.song_dir,
            &song,
            position_seconds,
            required_transpose,
        );
        let generation = self
            .seek_generation
            .fetch_add(1, Ordering::AcqRel)
            .saturating_add(1);
        let far_seek = FarSeekTelemetry {
            cache_status: format!("{decision_kind:?}"),
            playback_path: playback_path_for_decision(decision_kind).to_string(),
            exact_ready: matches!(
                decision_kind,
                source::SeekSourceKind::ExactRam | source::SeekSourceKind::ExactDisk
            ),
            used_fallback: decision.used_fallback(required_transpose),
            prepare_requested: true,
            swap_to_exact_ms: None,
        };
        if let Some(source) = decision.source() {
            let _ = (source.sample_rate(), source.channels());
        }

        if let Some(reader_sender) = &self.reader_sender {
            reader_sender
                .send(ReaderCommand::Seek {
                    song,
                    position_seconds,
                    reason,
                    generation,
                })
                .map_err(|_| "disk reader thread is unavailable".to_string())?;
            return Ok(SeekReport {
                active_sinks: 1,
                far_seek,
            });
        }

        Ok(SeekReport {
            active_sinks: usize::from(matches!(self.backend, PlaybackBackend::Null)),
            far_seek,
        })
    }

    fn play(
        &mut self,
        song: Song,
        position_seconds: f64,
        reason: PlaybackStartReason,
    ) -> Result<bool, String> {
        let generation = self
            .seek_generation
            .fetch_add(1, Ordering::AcqRel)
            .saturating_add(1);

        if let Some(reader_sender) = &self.reader_sender {
            reader_sender
                .send(ReaderCommand::Play {
                    song,
                    position_seconds,
                    reason,
                    generation,
                })
                .map_err(|_| "disk reader thread is unavailable".to_string())?;
            return Ok(true);
        }

        Ok(matches!(self.backend, PlaybackBackend::Null))
    }

    fn start_master_fade(
        &mut self,
        target_gain: f32,
        duration_seconds: f64,
    ) -> Result<bool, String> {
        if let Some(reader_sender) = &self.reader_sender {
            reader_sender
                .send(ReaderCommand::StartMasterFade {
                    target_gain,
                    duration_seconds,
                })
                .map_err(|_| "disk reader thread is unavailable".to_string())?;
            return Ok(true);
        }

        Ok(false)
    }

    fn master_gain(&self) -> f32 {
        match &self.backend {
            PlaybackBackend::Null => 1.0,
            PlaybackBackend::Cpal { .. } => self.reader_sender.as_ref().map(|_| 1.0).unwrap_or(1.0),
        }
    }

    fn stop_playback(&mut self) -> Result<bool, String> {
        if let Some(reader_sender) = &self.reader_sender {
            let _ = reader_sender.send(ReaderCommand::Stop {
                fade_duration_seconds: STOP_FADE_DURATION_SECONDS,
            });
            return Ok(true);
        }
        Ok(false)
    }

    fn shutdown(mut self) -> DiskReaderReport {
        if let Some(reader_sender) = self.reader_sender.take() {
            let _ = reader_sender.send(ReaderCommand::Shutdown);
        }
        self.reader_handle
            .take()
            .and_then(|handle| handle.join().ok())
            .unwrap_or_default()
    }
}

fn run_audio_thread(
    receiver: Receiver<AudioCommand>,
    debug_config: AudioDebugConfig,
    audio_buffers: AudioBufferCache,
    app_handle: SharedAppHandle,
    remote_handle: SharedRemoteHandle,
    live_mix_state: SharedTrackMixState,
    audio_settings: SharedAudioSettings,
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

                let result = ensure_runtime(
                    &mut runtime,
                    &audio_buffers,
                    &app_handle,
                    &remote_handle,
                    &live_mix_state,
                    &audio_settings,
                )
                .restart(&song_dir, &song, position_seconds, reason, debug_config)
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

                let result = ensure_runtime(
                    &mut runtime,
                    &audio_buffers,
                    &app_handle,
                    &remote_handle,
                    &live_mix_state,
                    &audio_settings,
                )
                .seek(&song, position_seconds, reason)
                .map(|report| {
                    debug_state.record_seek(
                        reason,
                        position_seconds,
                        song.duration_seconds,
                        report.active_sinks.max(1),
                        Some(&report.far_seek),
                    );
                });

                let _ = respond_to.send(result);
            }
            AudioCommand::TimelineIntent {
                song_dir,
                song,
                position_seconds,
                respond_to,
            } => {
                ensure_runtime(
                    &mut runtime,
                    &audio_buffers,
                    &app_handle,
                    &remote_handle,
                    &live_mix_state,
                    &audio_settings,
                )
                .audio_buffers
                .on_timeline_hover_or_drag(&song_dir, &song, position_seconds);
                let _ = respond_to.send(Ok(()));
            }
            AudioCommand::SyncSong { song, respond_to } => {
                let (song, respond_tos, next_deferred) =
                    coalesce_sync_song_commands(&receiver, song, respond_to);
                deferred_command = next_deferred;

                debug_state
                    .record_command(AudioCommandKind::SyncSong, Some("mix_only".to_string()));

                let result = ensure_runtime(
                    &mut runtime,
                    &audio_buffers,
                    &app_handle,
                    &remote_handle,
                    &live_mix_state,
                    &audio_settings,
                )
                .sync_song(&song)
                .map(|report| {
                    debug_state.record_sync(&report);
                });

                for respond_to in respond_tos {
                    let _ = respond_to.send(result.clone());
                }
            }
            AudioCommand::ApplySettings {
                settings,
                rebuild_stream,
                respond_to,
            } => {
                debug_state.record_command(
                    AudioCommandKind::ApplySettings,
                    rebuild_stream.then(|| "rebuild_stream".to_string()),
                );

                let result = (|| {
                    if rebuild_stream {
                        if let Some(runtime) = runtime.as_mut() {
                            let report = runtime.close_stream();
                            debug_state.record_stop(&report, 0);
                        }
                    }

                    let mut current_settings = audio_settings
                        .write()
                        .map_err(|_| "audio settings lock poisoned".to_string())?;
                    *current_settings = settings;
                    Ok(())
                })();

                let _ = respond_to.send(result);
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
            AudioCommand::StartMasterFade {
                target_gain,
                duration_seconds,
                respond_to,
            } => {
                debug_state.record_command(AudioCommandKind::StartMasterFade, None);

                let result = ensure_runtime(
                    &mut runtime,
                    &audio_buffers,
                    &app_handle,
                    &remote_handle,
                    &live_mix_state,
                    &audio_settings,
                )
                .start_master_fade(target_gain, duration_seconds);

                let _ = respond_to.send(result);
            }
            AudioCommand::DebugSnapshot { respond_to } => {
                debug_state.record_command(AudioCommandKind::DebugSnapshot, None);
                let mut snapshot = debug_state.snapshot();
                if let Some(active_runtime) = runtime.as_ref() {
                    snapshot.runtime_state.master_gain = active_runtime.master_gain();
                    snapshot.backend_counters = active_runtime.backend_counters_snapshot();
                    log_audio_snapshot_to_file(&active_runtime.app_handle, &snapshot);
                }
                let _ = respond_to.send(snapshot);
            }
            AudioCommand::Shutdown => {
                debug_state.record_command(AudioCommandKind::Shutdown, None);
                if let Some(mut active_runtime) = runtime.take() {
                    if let Some(session) = active_runtime.session.take() {
                        let _ = session.shutdown();
                    }
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
    remote_handle: &SharedRemoteHandle,
    live_mix_state: &SharedTrackMixState,
    audio_settings: &SharedAudioSettings,
) -> &'a mut AudioRuntime {
    runtime.get_or_insert_with(|| {
        AudioRuntime::new(
            audio_buffers.clone(),
            app_handle.clone(),
            remote_handle.clone(),
            live_mix_state.clone(),
            audio_settings.clone(),
        )
    })
}

#[tauri::command]
pub fn get_audio_output_devices() -> Result<AudioOutputDevicesResponse, String> {
    let descriptors = enumerate_output_devices();
    let mut channel_counts = HashMap::new();
    for descriptor in &descriptors {
        channel_counts.insert(
            descriptor.name.clone(),
            descriptor.max_output_channels.max(1),
        );
        channel_counts.insert(
            descriptor.stable_id.clone(),
            descriptor.max_output_channels.max(1),
        );
    }
    let mut devices = descriptors
        .iter()
        .map(|descriptor| descriptor.name.clone())
        .collect::<Vec<_>>();
    devices.sort();
    devices.dedup();
    let default_device = descriptors
        .iter()
        .find(|descriptor| {
            descriptor.is_default && is_system_default_backend_candidate(descriptor.backend)
        })
        .or_else(|| descriptors.iter().find(|descriptor| descriptor.is_default))
        .map(|descriptor| descriptor.name.clone());
    let mut backends = descriptors
        .iter()
        .map(|descriptor| descriptor.backend)
        .collect::<Vec<_>>();
    backends.sort_by_key(|backend| format!("{backend:?}"));
    backends.dedup();

    Ok(AudioOutputDevicesResponse {
        devices,
        default_device,
        channel_counts,
        backends,
        device_descriptors: descriptors,
    })
}

pub(crate) fn audio_debug_logging_enabled() -> bool {
    AudioDebugConfig::from_env().enabled
}

fn trimmed_nonempty(value: String) -> Option<String> {
    let trimmed = value.trim().to_string();
    (!trimmed.is_empty()).then_some(trimmed)
}

fn wait_for_prefill(
    consumer: &rtrb::Consumer<OutputSample>,
    requested_frames: usize,
    output_channels: usize,
    max_wait: Duration,
) -> PrefillResult {
    let requested_samples = requested_frames.saturating_mul(output_channels.max(1));
    let started_at = Instant::now();
    while consumer.slots() < requested_samples && started_at.elapsed() < max_wait {
        thread::sleep(Duration::from_millis(1));
    }
    let available_samples = consumer.slots();
    let available_frames = available_samples / output_channels.max(1);
    PrefillResult {
        requested_frames,
        requested_samples,
        available_frames,
        available_samples,
        elapsed_ms: started_at.elapsed().as_secs_f64() * 1000.0,
        completed: available_frames >= requested_frames && available_samples >= requested_samples,
    }
}

fn log_prefill_result(_backend: AudioBackendKind, _result: PrefillResult) {
}

fn log_startup_readiness(
    backend: AudioBackendKind,
    device: &str,
    sample_rate: u32,
    readiness: &mixer::MixerStartupReadiness,
) {
    if !audio_debug_logging_enabled() {
        return;
    }
    eprintln!(
        "[playback_source_policy] policy=\"{}\" backend=\"{backend:?}\" device=\"{}\" resolved_sample_rate={}",
        readiness.playback_source_policy.label(),
        escape_log_value(device),
        sample_rate
    );
    eprintln!(
        "[libretracks-audio] startup_readiness backend={backend:?} active_clip_count={} active_transposed_clip_count={} realtime_pitch_clip_count={} all_realtime_pitch_engines_ready={} min_queued_pitch_output_frames={}",
        readiness.active_clip_count,
        readiness.active_transposed_clip_count,
        readiness.realtime_pitch_clip_count,
        readiness.all_realtime_pitch_engines_ready,
        readiness.min_queued_pitch_output_frames
    );
    for clip in &readiness.clip_diagnostics {
        eprintln!(
            "[playback_route_selected] backend=\"{backend:?}\" device=\"{}\" resolved_sample_rate={} clip_id=\"{}\" track_id=\"{}\" source_kind=\"{}\" uses_realtime_pitch={}",
            escape_log_value(device),
            sample_rate,
            escape_log_value(&clip.clip_id),
            escape_log_value(&clip.track_id),
            escape_log_value(&clip.source_kind),
            clip.uses_realtime_pitch
        );
        eprintln!(
            "[libretracks-audio] clip_playback_path backend={backend:?} clip_id={} track_id={} transpose_semitones={} source_kind={} uses_exact_prepared_transposed={} uses_original_plus_realtime_pitch={} uses_streaming_reader={} uses_realtime_pitch={} pitch_latency_frames={} queued_output_frames_before_first_emit={} first_non_silent_input_frame={:?} first_non_silent_output_frame={:?}",
            clip.clip_id,
            clip.track_id,
            clip.transpose_semitones,
            clip.source_kind,
            clip.uses_exact_prepared_transposed,
            clip.uses_original_plus_realtime_pitch,
            clip.uses_streaming_reader,
            clip.uses_realtime_pitch,
            clip.pitch_latency_frames,
            clip.queued_output_frames_before_first_emit,
            clip.first_non_silent_input_frame,
            clip.first_non_silent_output_frame
        );
    }
}

#[allow(clippy::too_many_arguments)]
fn log_audio_startup_to_file(
    app_handle: &SharedAppHandle,
    backend: AudioBackendKind,
    device: &str,
    sample_rate: u32,
    actual_buffer_size: usize,
    ring_capacity_frames: usize,
    prefill_frames: usize,
    prefill_result: PrefillResult,
    readiness: &mixer::MixerStartupReadiness,
) {
    append_audio_runtime_log(
        app_handle,
        &format!(
            "audio_startup backend={backend:?} device=\"{}\" sample_rate={} actual_buffer_size={} ring_capacity_frames={} prefill_frames={} prefill_completed={} prefill_available_frames={} xrun_count=0 underrun_frames=0 stale_drop_count=0 resync_count=0 callback_frame_min=0 callback_frame_max=0 realtime_pitch_clip_count={} min_queued_pitch_output_frames={}",
            escape_log_value(device),
            sample_rate,
            actual_buffer_size,
            ring_capacity_frames,
            prefill_frames,
            prefill_result.completed,
            prefill_result.available_frames,
            readiness.realtime_pitch_clip_count,
            readiness.min_queued_pitch_output_frames
        ),
    );
    append_audio_runtime_log(
        app_handle,
        &format!(
            "playback_source_policy policy=\"{}\" backend={backend:?} device=\"{}\" resolved_sample_rate={}",
            readiness.playback_source_policy.label(),
            escape_log_value(device),
            sample_rate
        ),
    );
    for clip in &readiness.clip_diagnostics {
        append_audio_runtime_log(
            app_handle,
            &format!(
                "playback_route_selected backend={backend:?} device=\"{}\" resolved_sample_rate={} clip_id={} track_id={} source_kind=\"{}\" uses_realtime_pitch={}",
                escape_log_value(device),
                sample_rate,
                escape_log_value(&clip.clip_id),
                escape_log_value(&clip.track_id),
                escape_log_value(&clip.source_kind),
                clip.uses_realtime_pitch
            ),
        );
        append_audio_runtime_log(
            app_handle,
            &format!(
                "audio_clip_startup backend={backend:?} device=\"{}\" clip_id={} track_id={} source_kind={} uses_realtime_pitch={}",
                escape_log_value(device),
                escape_log_value(&clip.clip_id),
                escape_log_value(&clip.track_id),
                escape_log_value(&clip.source_kind),
                clip.uses_realtime_pitch
            ),
        );
    }
}

fn log_audio_snapshot_to_file(app_handle: &SharedAppHandle, snapshot: &AudioDebugSnapshot) {
    let counters = &snapshot.backend_counters;
    append_audio_runtime_log(
        app_handle,
        &format!(
            "audio_snapshot backend={} device=\"{}\" sample_rate={} actual_buffer_size={} ring_capacity_frames={} prefill_frames={} prefill_completed={} prefill_available_frames={} xrun_count={} underrun_frames={} stale_drop_count={} resync_count={} callback_frame_min={} callback_frame_max={} realtime_pitch_clip_count={} min_queued_pitch_output_frames={}",
            counters.backend.as_deref().unwrap_or("None"),
            escape_log_value(counters.device.as_deref().unwrap_or("")),
            counters.sample_rate,
            counters.actual_buffer_size,
            counters.ring_capacity_frames,
            counters.prefill_frames,
            counters.prefill_completed,
            counters.prefill_available_frames,
            counters.xrun_count,
            counters.underrun_frames,
            counters.stale_drop_count,
            counters.resync_count,
            counters.callback_min_frames,
            counters.callback_max_frames,
            counters.realtime_pitch_clip_count,
            counters.min_queued_pitch_output_frames
        ),
    );
    for clip in &counters.clip_diagnostics {
        append_audio_runtime_log(
            app_handle,
            &format!(
                "audio_clip_snapshot backend={} device=\"{}\" clip_id={} track_id={} source_kind={} uses_realtime_pitch={}",
                counters.backend.as_deref().unwrap_or("None"),
                escape_log_value(counters.device.as_deref().unwrap_or("")),
                escape_log_value(&clip.clip_id),
                escape_log_value(&clip.track_id),
                escape_log_value(&clip.source_kind),
                clip.uses_realtime_pitch
            ),
        );
    }
}

fn append_audio_runtime_log(app_handle: &SharedAppHandle, line: &str) {
    let Some(app_handle) = app_handle.read().ok().and_then(|handle| handle.clone()) else {
        eprintln!("[libretracks-audio] audio-runtime.log unavailable before app handle: {line}");
        return;
    };
    let result = (|| -> Result<(), String> {
        let log_dir = app_handle
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?;
        fs::create_dir_all(&log_dir).map_err(|error| error.to_string())?;
        let log_path = log_dir.join("audio-runtime.log");
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_path)
            .map_err(|error| error.to_string())?;
        let timestamp_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or(0);
        writeln!(file, "[{timestamp_ms}] {line}").map_err(|error| error.to_string())
    })();
    if let Err(error) = result {
        eprintln!("[libretracks-audio] failed to write audio-runtime.log: {error}");
    }
}

fn escape_log_value(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn log_requested_output_device(_request: &AudioOutputRequest) {
}

fn log_stream_open_failure(
    _request: &AudioOutputRequest,
    _failure_stage: &'static str,
    _message: &str,
) {
}

fn log_resolved_output_config(_device_name: &str, _config: &ResolvedOutputStreamConfig) {
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

fn recv_audio_response<T>(response: Receiver<T>, timeout: Duration) -> Result<T, DesktopError> {
    response
        .recv_timeout(timeout)
        .map_err(|error| map_audio_response_error(error, timeout))
}

fn map_audio_response_error(error: RecvTimeoutError, timeout: Duration) -> DesktopError {
    match error {
        RecvTimeoutError::Timeout => DesktopError::AudioCommand(format!(
            "audio thread did not respond within {} ms",
            timeout.as_millis()
        )),
        RecvTimeoutError::Disconnected => DesktopError::AudioThreadUnavailable,
    }
}

fn scheduled_clip_count(song: &Song, position_seconds: f64) -> usize {
    song.clips
        .iter()
        .filter(|clip| clip.timeline_start_seconds + clip.duration_seconds > position_seconds)
        .count()
}

#[derive(Debug, Clone)]
struct SeekReport {
    active_sinks: usize,
    far_seek: FarSeekTelemetry,
}

fn transpose_for_song_position(song: &Song, position_seconds: f64) -> i32 {
    song.regions
        .iter()
        .find(|region| {
            position_seconds >= region.start_seconds && position_seconds < region.end_seconds
        })
        .map(|region| region.transpose_semitones)
        .unwrap_or(0)
}

fn playback_path_for_decision(_kind: source::SeekSourceKind) -> &'static str {
    "PreparedSource"
}

fn seconds_to_frames(seconds: f64, sample_rate: u32) -> u64 {
    (seconds.max(0.0) * sample_rate.max(1) as f64).round() as u64
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

    use libretracks_core::{Clip, Marker, Song, SongRegion, Track};
    use rtrb::RingBuffer;
    use tempfile::tempdir;

    use super::pitch;

    use crate::settings::AppSettings;

    use super::backend::{
        resolve_output_stream_config_for_test, system_default_backend_from_available_for_test,
    };
    use super::mixer::{MixerStartupReadiness, PlaybackSourcePolicy};
    use super::{
        apply_runtime_pan, build_live_mix_map, build_playback_plans, coalesce_sync_song_commands,
        drain_consumer_samples, env_flag, interpolated_gain, playback_reason_label,
        prepare_audio_source, probe_audio_file, resolve_track_runtime_pan, scheduled_clip_count,
        set_zero_latency_test_mode, source, update_shared_track_mix,
    };
    use super::{
        AudioBackendKind, AudioBufferCache, AudioBufferCacheStats, AudioBufferSizeRequest,
        AudioCommand, AudioCommandKind, AudioController, AudioDebugConfig, AudioDebugSnapshot,
        AudioDebugState, AudioMeterLevel, AudioOutputRequest, AudioRuntimeCounters,
        AudioSampleFormat, CpalCrossfadeState, DiskReaderState, MemoryClipReader, Mixer,
        OutputChannelRequest, OutputSample, PlaybackBackend, PlaybackClipPlan, PlaybackSession,
        PlaybackStartReason, PrefillResult, ReaderCommand, RestartReport, SharedAudioSource,
        StopReport, SyncReport, AUDIO_LONG_COMMAND_RESPONSE_TIMEOUT,
        AUDIO_SHORT_COMMAND_RESPONSE_TIMEOUT, DISK_RENDER_BLOCK_FRAMES, GAIN_EPSILON,
        STOP_FADE_DURATION_SECONDS,
    };

    fn demo_song() -> Song {
        Song {
            id: "song_audio".into(),
            title: "Audio Runtime".into(),
            artist: None,
            key: None,
            bpm: 120.0,
            time_signature: "4/4".into(),
            duration_seconds: 20.0,
            tempo_markers: vec![],
            time_signature_markers: vec![],
            regions: vec![SongRegion {
                id: "region_1".into(),
                name: "Audio Runtime".into(),
                start_seconds: 0.0,
                end_seconds: 20.0,
                transpose_semitones: 0,
            }],
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
                    transpose_enabled: true,
                    audio_to: "master".to_string(),
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
                    transpose_enabled: true,
                    audio_to: "master".to_string(),
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

    #[test]
    fn explicit_output_request_is_not_system_default() {
        let request = AudioOutputRequest {
            backend: Some(AudioBackendKind::Wasapi),
            device_id: Some("WASAPI::Device B".into()),
            device_name: Some("Device B".into()),
            sample_rate: Some(48_000),
            buffer_size: AudioBufferSizeRequest::Fixed(256),
            output_channels: OutputChannelRequest {
                channels: vec![0, 1],
            },
            sample_format: Some(AudioSampleFormat::F32),
            low_latency_mode: false,
            safe_mode: false,
        };

        assert!(request.has_explicit_device_selection());
        assert_eq!(request.requested_device_label(), "WASAPI::Device B");
    }

    #[test]
    fn system_default_request_allows_default_fallback() {
        let request = AudioOutputRequest {
            backend: None,
            device_id: None,
            device_name: None,
            sample_rate: None,
            buffer_size: AudioBufferSizeRequest::Default,
            output_channels: OutputChannelRequest::default(),
            sample_format: None,
            low_latency_mode: false,
            safe_mode: false,
        };

        assert!(!request.has_explicit_device_selection());
        assert_eq!(request.requested_device_label(), "System default");
    }

    #[test]
    fn system_default_backend_candidates_exclude_asio() {
        assert!(!super::is_system_default_backend_candidate(
            AudioBackendKind::Asio
        ));

        #[cfg(target_os = "windows")]
        assert!(super::is_system_default_backend_candidate(
            AudioBackendKind::Wasapi
        ));
    }

    #[test]
    fn windows_system_default_prefers_wasapi_over_asio() {
        #[cfg(target_os = "windows")]
        {
            assert_eq!(
                system_default_backend_from_available_for_test(&[
                    AudioBackendKind::Asio,
                    AudioBackendKind::Wasapi,
                ]),
                Some(AudioBackendKind::Wasapi)
            );
            assert_eq!(
                system_default_backend_from_available_for_test(&[AudioBackendKind::Asio]),
                None
            );
        }
    }

    #[test]
    fn device_switching_commands_use_long_timeout() {
        assert!(AUDIO_LONG_COMMAND_RESPONSE_TIMEOUT >= Duration::from_millis(3_000));
        assert!(AUDIO_SHORT_COMMAND_RESPONSE_TIMEOUT <= Duration::from_millis(250));
    }

    #[test]
    fn requested_supported_sample_rate_is_resolved_without_fallback() {
        let (requested, resolved, used_fallback, fallback_reason) =
            resolve_output_stream_config_for_test(Some(44_100), 48_000, 44_100, 96_000);

        assert_eq!(requested, Some(44_100));
        assert_eq!(resolved, 44_100);
        assert!(!used_fallback);
        assert_eq!(fallback_reason, None);
    }

    #[test]
    fn requested_unsupported_sample_rate_reports_fallback_reason() {
        let (requested, resolved, used_fallback, fallback_reason) =
            resolve_output_stream_config_for_test(Some(44_100), 48_000, 48_000, 96_000);

        assert_eq!(requested, Some(44_100));
        assert_eq!(resolved, 48_000);
        assert!(used_fallback);
        assert_eq!(
            fallback_reason.as_deref(),
            Some("requested sample rate not supported")
        );
    }

    fn transposed_far_seek_song() -> Song {
        let mut song = demo_song();
        song.regions = vec![
            SongRegion {
                id: "region_intro".into(),
                name: "Intro".into(),
                start_seconds: 0.0,
                end_seconds: 10.0,
                transpose_semitones: 0,
            },
            SongRegion {
                id: "region_far".into(),
                name: "Far".into(),
                start_seconds: 10.0,
                end_seconds: 20.0,
                transpose_semitones: 4,
            },
        ];
        song
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

    fn write_extensible_float_test_wav(path: &std::path::Path) {
        let channels = 1u16;
        let sample_rate = 48_000u32;
        let bits_per_sample = 32u16;
        let bytes_per_sample = usize::from(bits_per_sample / 8);
        let samples = [0.25_f32, -0.5_f32];

        let mut data_bytes = Vec::with_capacity(samples.len() * bytes_per_sample);
        for sample in samples {
            data_bytes.extend_from_slice(&sample.to_le_bytes());
        }

        let fmt_chunk_len = 40u32;
        let data_chunk_len = data_bytes.len() as u32;
        let riff_chunk_len = 4 + (8 + fmt_chunk_len) + (8 + data_chunk_len);
        let byte_rate = sample_rate * u32::from(channels) * u32::from(bits_per_sample / 8);
        let block_align = channels * (bits_per_sample / 8);

        let mut wav_bytes = Vec::with_capacity((riff_chunk_len + 8) as usize);
        wav_bytes.extend_from_slice(b"RIFF");
        wav_bytes.extend_from_slice(&riff_chunk_len.to_le_bytes());
        wav_bytes.extend_from_slice(b"WAVE");

        wav_bytes.extend_from_slice(b"fmt ");
        wav_bytes.extend_from_slice(&fmt_chunk_len.to_le_bytes());
        wav_bytes.extend_from_slice(&0xFFFEu16.to_le_bytes());
        wav_bytes.extend_from_slice(&channels.to_le_bytes());
        wav_bytes.extend_from_slice(&sample_rate.to_le_bytes());
        wav_bytes.extend_from_slice(&byte_rate.to_le_bytes());
        wav_bytes.extend_from_slice(&block_align.to_le_bytes());
        wav_bytes.extend_from_slice(&bits_per_sample.to_le_bytes());
        wav_bytes.extend_from_slice(&22u16.to_le_bytes());
        wav_bytes.extend_from_slice(&bits_per_sample.to_le_bytes());
        wav_bytes.extend_from_slice(&0u32.to_le_bytes());
        wav_bytes.extend_from_slice(&[
            0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xAA, 0x00, 0x38,
            0x9B, 0x71,
        ]);

        wav_bytes.extend_from_slice(b"data");
        wav_bytes.extend_from_slice(&data_chunk_len.to_le_bytes());
        wav_bytes.extend_from_slice(&data_bytes);

        fs::write(path, wav_bytes).expect("wav should be created");
    }

    fn cache_with_shared_buffer(
        path: &Path,
        samples: Vec<f32>,
        sample_rate: u32,
        channels: usize,
    ) -> AudioBufferCache {
        let cache = AudioBufferCache::default();
        cache.insert_for_test(
            path.to_path_buf(),
            SharedAudioSource::from_preloaded(samples, sample_rate, channels, true),
        );
        cache
    }

    fn shared_mix_state(
        song: &Song,
    ) -> Arc<RwLock<std::collections::HashMap<String, super::LiveTrackMix>>> {
        Arc::new(RwLock::new(build_live_mix_map(song)))
    }

    fn write_impulse_train_test_wav(
        path: &Path,
        sample_rate: u32,
        total_frames: usize,
        interval_frames: usize,
    ) {
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        };
        let mut writer = hound::WavWriter::create(path, spec).expect("wav should be created");
        let click_frames = ((sample_rate as f32) * 0.01).round() as usize;
        let click_frequency_hz = 1_000.0_f32;

        for frame in 0..total_frames {
            let phase = frame % interval_frames.max(1);
            let sample = if phase < click_frames {
                let envelope = 1.0 - (phase as f32 / click_frames.max(1) as f32);
                let radians = 2.0 * std::f32::consts::PI * click_frequency_hz * phase as f32
                    / sample_rate.max(1) as f32;
                radians.cos() * envelope
            } else {
                0.0
            };
            writer.write_sample(sample).expect("sample should write");
        }

        writer.finalize().expect("wav should finalize");
    }

    fn ab_sync_song(audio_path: &Path, duration_seconds: f64) -> Song {
        let audio_path = audio_path.to_string_lossy().to_string();
        Song {
            id: "ab-sync-song".into(),
            title: "AB Sync".into(),
            artist: None,
            key: None,
            bpm: 120.0,
            time_signature: "4/4".into(),
            duration_seconds,
            tempo_markers: vec![],
            time_signature_markers: vec![],
            regions: vec![SongRegion {
                id: "region-ab".into(),
                name: "AB".into(),
                start_seconds: 0.0,
                end_seconds: duration_seconds,
                transpose_semitones: 2,
            }],
            tracks: vec![
                Track {
                    id: "track-bypass".into(),
                    name: "Bypass".into(),
                    kind: libretracks_core::TrackKind::Audio,
                    parent_track_id: None,
                    volume: 1.0,
                    pan: -1.0,
                    muted: false,
                    solo: false,
                    transpose_enabled: false,
                    audio_to: "master".to_string(),
                },
                Track {
                    id: "track-transposed".into(),
                    name: "Transposed".into(),
                    kind: libretracks_core::TrackKind::Audio,
                    parent_track_id: None,
                    volume: 1.0,
                    pan: 1.0,
                    muted: false,
                    solo: false,
                    transpose_enabled: true,
                    audio_to: "master".to_string(),
                },
            ],
            clips: vec![
                Clip {
                    id: "clip-bypass".into(),
                    track_id: "track-bypass".into(),
                    file_path: audio_path.clone(),
                    timeline_start_seconds: 0.0,
                    source_start_seconds: 0.0,
                    duration_seconds,
                    gain: 1.0,
                    fade_in_seconds: None,
                    fade_out_seconds: None,
                },
                Clip {
                    id: "clip-transposed".into(),
                    track_id: "track-transposed".into(),
                    file_path: audio_path,
                    timeline_start_seconds: 0.0,
                    source_start_seconds: 0.0,
                    duration_seconds,
                    gain: 1.0,
                    fade_in_seconds: None,
                    fade_out_seconds: None,
                },
            ],
            section_markers: vec![],
        }
    }

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
        let left_window = &left[start..end];
        let right_window = &right[start..end];
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
        let left_envelope = smooth_envelope(left_window);
        let right_envelope = smooth_envelope(right_window);

        (-(max_shift as isize)..=(max_shift as isize))
            .map(|shift| {
                let (left_offset, right_offset, compare_len) = if shift >= 0 {
                    let shift = shift as usize;
                    (0, shift, left_window.len().saturating_sub(shift))
                } else {
                    let shift = (-shift) as usize;
                    (shift, 0, left_window.len().saturating_sub(shift))
                };

                let error = left_envelope[left_offset..left_offset + compare_len]
                    .iter()
                    .zip(&right_envelope[right_offset..right_offset + compare_len])
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
                    prepare_queue_len: 0,
                    ram_cache_used_mb: 0,
                    disk_cache_used_mb: 0,
                    silence_fallback_count: 0,
                    last_silence_fallback_position: None,
                    last_silence_fallback_file: None,
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
                    prepare_queue_len: 0,
                    ram_cache_used_mb: 0,
                    disk_cache_used_mb: 0,
                    silence_fallback_count: 0,
                    last_silence_fallback_position: None,
                    last_silence_fallback_file: None,
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
    fn debug_state_does_not_clamp_playhead_to_song_duration() {
        let mut debug_state = AudioDebugState::new(AudioDebugConfig {
            enabled: true,
            log_commands: false,
        });

        debug_state.record_seek(PlaybackStartReason::Seek, 12.0, 8.0, 0, None);

        let snapshot = debug_state.snapshot();

        assert_eq!(snapshot.playhead.anchor_position_seconds, Some(12.0));
        assert!(
            snapshot
                .playhead
                .estimated_position_seconds
                .unwrap_or_default()
                >= 12.0
        );
        assert_eq!(snapshot.playhead.song_duration_seconds, Some(8.0));
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
            transpose_semitones: 0,
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
                transpose_semitones: 0,
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
        assert_eq!(reader.current_frame(), 2);
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
                transpose_semitones: 0,
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
                transpose_semitones: 0,
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
            key: None,
            bpm: 120.0,
            time_signature: "4/4".into(),
            duration_seconds: 1.0,
            tempo_markers: vec![],
            time_signature_markers: vec![],
            regions: vec![SongRegion {
                id: "region_1".into(),
                name: "Cycle".into(),
                start_seconds: 0.0,
                end_seconds: 1.0,
                transpose_semitones: 0,
            }],
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
                    transpose_enabled: true,
                    audio_to: "master".to_string(),
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
                    transpose_enabled: true,
                    audio_to: "master".to_string(),
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
                    transpose_enabled: true,
                    audio_to: "master".to_string(),
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
            Arc::new(RwLock::new(None)),
            shared_mix_state(&song),
            Arc::new(RwLock::new(AppSettings::default())),
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
        cache.insert_for_test(
            song_dir.join("audio/intro.wav"),
            SharedAudioSource::from_preloaded(vec![0.0; 48_000 * 10], 48_000, 2, true),
        );
        cache.insert_for_test(
            song_dir.join("audio/late.wav"),
            SharedAudioSource::from_preloaded(vec![0.0; 48_000 * 10], 48_000, 2, true),
        );

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
                    Arc::new(RwLock::new(None)),
                    live_mix_state,
                    Arc::new(RwLock::new(AppSettings::default())),
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
                        None,
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
                transpose_semitones: 0,
            },
            48_000,
            &cache,
            0,
        )
        .expect("memory reader should open");

        reader.seek_to(1);
        let mut mixed = [0.0_f32; 2];
        reader.mix_into_with_channel_gains(&mut mixed, 0, 1, 2, 1.0, 0.0);

        assert_eq!(mixed, [0.0, 0.0]);
        assert_eq!(reader.current_frame(), 2);
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
                transpose_semitones: 0,
            },
            4,
            &cache,
            0,
        )
        .expect("memory reader should open");

        assert_eq!(reader.current_frame(), 2);
        assert!(!reader.eof);
    }

    #[test]
    fn prepared_audio_source_maps_entire_pcm_payload_for_long_files() {
        let root = tempdir().expect("temp dir should exist");
        let audio_path = root.path().join("long.wav");
        write_counting_test_wav(&audio_path, 8_000, 8_000 * 4);

        let source = prepare_audio_source(&audio_path).expect("audio source should prepare");

        assert_eq!(source.sample_rate(), 8_000);
        assert_eq!(source.channels(), 1);
        assert_eq!(source.preload_frame_count(), 8_000 * 4);
        assert!(!source.is_fully_cached());
        assert!(!source.has_mapped_audio());
    }

    #[test]
    fn prepared_audio_source_accepts_wave_format_extensible_float32() {
        let root = tempdir().expect("temp dir should exist");
        let audio_path = root.path().join("extensible-float.wav");
        write_extensible_float_test_wav(&audio_path);

        let source = prepare_audio_source(&audio_path).expect("audio source should prepare");

        assert_eq!(source.sample_rate(), 48_000);
        assert_eq!(source.channels(), 1);
        assert_eq!(source.preload_frame_count(), 2);
        assert!(!source.has_mapped_audio());
        assert!((source.read_preloaded_sample_for_test(0, 0, 1) - 0.25).abs() < 0.000_001);
        assert!((source.read_preloaded_sample_for_test(1, 0, 1) + 0.5).abs() < 0.000_001);
    }

    #[test]
    fn memory_clip_reader_reads_past_the_old_preload_boundary() {
        let root = tempdir().expect("temp dir should exist");
        let audio_path = root.path().join("streaming.wav");
        write_counting_test_wav(&audio_path, 8_000, 8_000 * 3);

        let cache = AudioBufferCache::default();
        cache.insert_for_test(
            audio_path.clone(),
            prepare_audio_source(&audio_path).expect("audio source should prepare"),
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
                transpose_semitones: 0,
            },
            8_000,
            &cache,
            0,
        )
        .expect("memory reader should open");

        reader.seek_to(8_000 * 2 + 32);
        let mut mixed = [0.0_f32; 260];
        let (_left_peak, right_peak) =
            reader.mix_into_with_channel_gains(&mut mixed, 0, 260, 1, 1.0, 0.0);

        assert!(mixed.iter().any(|sample| sample.abs() > 0.01));
        assert!(right_peak.abs() > 0.01);
        assert!(!reader.shared_source().has_mapped_audio());
    }

    #[test]
    fn duplicated_transposed_and_bypass_tracks_stay_frame_aligned_for_30_seconds() {
        if !pitch::rubberband_backend_available_for_test() {
            return;
        }
        let root = tempdir().expect("temp dir should exist");
        let song_dir = root.path().to_path_buf();
        let audio_path = song_dir.join("audio/impulse-train.wav");
        if let Some(parent) = audio_path.parent() {
            fs::create_dir_all(parent).expect("audio directory should exist");
        }

        let sample_rate = 48_000;
        let total_duration_seconds = 45.0;
        let analysis_start_seconds = 10.0;
        let analysis_duration_seconds = 30.0;
        let total_duration_frames = sample_rate as usize * total_duration_seconds as usize;
        let analysis_start_frame = sample_rate as usize * analysis_start_seconds as usize;
        let interval_frames = sample_rate as usize;
        write_impulse_train_test_wav(
            &audio_path,
            sample_rate,
            total_duration_frames,
            interval_frames,
        );

        let cache = AudioBufferCache::default();
        cache.insert_for_test(
            audio_path.clone(),
            prepare_audio_source(&audio_path).expect("audio source should prepare"),
        );

        let song = ab_sync_song(&audio_path, total_duration_seconds);
        let plans = build_playback_plans(&song_dir, &song, sample_rate);
        let left_plan = plans
            .iter()
            .find(|plan| plan.track_id == "track-bypass")
            .expect("bypass plan should exist");
        let right_plan = plans
            .iter()
            .find(|plan| plan.track_id == "track-transposed")
            .expect("transposed plan should exist");
        let left = super::source::render_plan_frames_for_test(
            left_plan,
            sample_rate,
            &cache,
            0,
            total_duration_frames,
        )
        .expect("bypass render should succeed");
        let right = super::source::render_plan_frames_for_test(
            right_plan,
            sample_rate,
            &cache,
            0,
            total_duration_frames,
        )
        .expect("transposed render should succeed");
        let marker_frames = (0..analysis_duration_seconds as usize)
            .map(|index| analysis_start_frame + (index * interval_frames))
            .collect::<Vec<_>>();
        let offsets = marker_frames
            .iter()
            .map(|&marker_frame| {
                best_envelope_alignment_offset(&left, &right, marker_frame, 1_024, 32)
            })
            .collect::<Vec<_>>();

        assert!(
            offsets.iter().copied().max().unwrap_or_default() <= 5,
            "peak offsets exceeded one frame: {offsets:?}"
        );
        assert!(
            offsets.iter().copied().max().unwrap_or_default()
                - offsets.iter().copied().min().unwrap_or_default()
                <= 1,
            "peak offset drift exceeded one frame: {offsets:?}"
        );
    }

    #[test]
    fn rendered_region_export_changes_with_transpose() {
        if !pitch::rubberband_backend_available_for_test() {
            return;
        }
        let root = tempdir().expect("temp dir should exist");
        let song_dir = root.path().to_path_buf();
        let audio_path = song_dir.join("audio/phrase.wav");
        if let Some(parent) = audio_path.parent() {
            fs::create_dir_all(parent).expect("audio directory should exist");
        }

        let mut samples = Vec::with_capacity(48_000 * 4 * 2);
        for frame in 0..(48_000 * 4) {
            let value = ((frame as f32) / 97.0).sin() * 0.5;
            samples.push(value);
            samples.push(-value);
        }

        let controller = AudioController::default();
        controller.audio_buffers.insert_for_test(
            audio_path.clone(),
            SharedAudioSource::from_preloaded(samples, 48_000, 2, true),
        );

        let base_song = Song {
            id: "song_render".into(),
            title: "Rendered Export".into(),
            artist: None,
            key: None,
            bpm: 120.0,
            time_signature: "4/4".into(),
            duration_seconds: 4.0,
            tempo_markers: vec![],
            time_signature_markers: vec![],
            regions: vec![SongRegion {
                id: "region_render".into(),
                name: "Render Region".into(),
                start_seconds: 0.0,
                end_seconds: 4.0,
                transpose_semitones: 0,
            }],
            tracks: vec![Track {
                id: "track_render".into(),
                name: "Track".into(),
                kind: libretracks_core::TrackKind::Audio,
                parent_track_id: None,
                volume: 1.0,
                pan: 0.0,
                muted: false,
                solo: false,
                transpose_enabled: true,
                audio_to: "master".to_string(),
            }],
            clips: vec![Clip {
                id: "clip_render".into(),
                track_id: "track_render".into(),
                file_path: "audio/phrase.wav".into(),
                timeline_start_seconds: 0.0,
                source_start_seconds: 0.0,
                duration_seconds: 4.0,
                gain: 1.0,
                fade_in_seconds: None,
                fade_out_seconds: None,
            }],
            section_markers: vec![],
        };

        let flat_path = song_dir.join("flat.wav");
        controller
            .export_region_rendered_audio(
                song_dir.clone(),
                base_song.clone(),
                "region_render",
                &flat_path,
            )
            .expect("flat export should succeed");

        let mut transposed_song = base_song;
        transposed_song.regions[0].transpose_semitones = 5;
        let transposed_path = song_dir.join("transposed.wav");
        controller
            .export_region_rendered_audio(
                song_dir,
                transposed_song,
                "region_render",
                &transposed_path,
            )
            .expect("transposed export should succeed");

        let read_samples = |path: &Path| -> Vec<i16> {
            hound::WavReader::open(path)
                .expect("rendered wav should open")
                .into_samples::<i16>()
                .map(|sample| sample.expect("sample should decode"))
                .collect()
        };

        let flat_samples = read_samples(&flat_path);
        let transposed_samples = read_samples(&transposed_path);

        assert!(!flat_samples.is_empty());
        assert_eq!(flat_samples.len(), transposed_samples.len());
        assert_ne!(flat_samples, transposed_samples);
    }

    #[test]
    fn mixer_seek_reuses_absolute_plans_and_activates_overlapping_clip() {
        let song = demo_song();
        let song_dir = PathBuf::from("song");
        let cache = AudioBufferCache::default();
        cache.insert_for_test(
            song_dir.join("audio/intro.wav"),
            SharedAudioSource::from_preloaded(vec![0.0; 48_000 * 5], 48_000, 1, true),
        );
        cache.insert_for_test(
            song_dir.join("audio/late.wav"),
            SharedAudioSource::from_preloaded(vec![0.0; 48_000 * 5], 48_000, 1, true),
        );

        let mut mixer = Mixer::new(
            song_dir,
            song.clone(),
            0.0,
            48_000,
            1,
            Arc::new(RwLock::new(None)),
            Arc::new(RwLock::new(None)),
            shared_mix_state(&song),
            Arc::new(RwLock::new(AppSettings::default())),
            AudioDebugConfig {
                enabled: false,
                log_commands: false,
            },
            cache,
        );

        assert_eq!(mixer.plans().len(), 2);
        assert_eq!(mixer.timeline_cursor_frame, 0);
        assert_eq!(mixer.active_clips().len(), 1);
        assert_eq!(mixer.active_clips()[0].plan().clip_id, "clip_intro");

        mixer.seek(song, 11.0);

        assert_eq!(mixer.plans().len(), 2);
        assert_eq!(mixer.timeline_cursor_frame, 48_000 * 11);
        assert_eq!(mixer.active_clips().len(), 1);
        assert_eq!(mixer.active_clips()[0].plan().clip_id, "clip_late");
        assert_eq!(mixer.active_clips()[0].reader_current_frame(), 48_000);
    }

    #[test]
    fn musical_seek_uses_equal_power_crossfade_instead_of_fading_from_zero() {
        let song = demo_song();
        let song_dir = PathBuf::from("song");
        let cache = AudioBufferCache::default();
        let intro_path = song_dir.join("audio/intro.wav");
        let late_path = song_dir.join("audio/late.wav");
        cache.insert_for_test(
            intro_path.clone(),
            SharedAudioSource::from_preloaded(vec![0.75; 48_000 * 5], 48_000, 1, true),
        );
        cache.insert_for_test(
            late_path.clone(),
            SharedAudioSource::from_preloaded(vec![-0.25; 48_000 * 5], 48_000, 1, true),
        );
        cache.insert_prepared_ram_for_test(
            source::PreparedAudioKey {
                file_id: intro_path.to_string_lossy().to_string(),
                file_hash: intro_path.to_string_lossy().to_string(),
                sample_rate: 48_000,
                channels: 1,
                transpose_semitones: 0,
            },
            Arc::new(source::RawRamSource::new(vec![0.75; 48_000 * 5], 48_000, 1)),
        );
        cache.insert_prepared_ram_for_test(
            source::PreparedAudioKey {
                file_id: late_path.to_string_lossy().to_string(),
                file_hash: late_path.to_string_lossy().to_string(),
                sample_rate: 48_000,
                channels: 1,
                transpose_semitones: 0,
            },
            Arc::new(source::RawRamSource::new(
                vec![-0.25; 48_000 * 5],
                48_000,
                1,
            )),
        );

        let mut mixer = Mixer::new(
            song_dir,
            song.clone(),
            0.0,
            48_000,
            1,
            Arc::new(RwLock::new(None)),
            Arc::new(RwLock::new(None)),
            shared_mix_state(&song),
            Arc::new(RwLock::new(AppSettings::default())),
            AudioDebugConfig {
                enabled: false,
                log_commands: false,
            },
            cache,
        );

        let _first_block = mixer.render_next_block(192);

        mixer.seek(song, 10.0);
        let spliced_block = mixer.render_next_block(64);

        assert!(spliced_block[0].abs() <= f32::EPSILON);
        assert!(spliced_block[63].abs() > spliced_block[1].abs());

        let crossfade_tail = mixer.render_next_block(896);
        let last_sample = crossfade_tail.last().copied().unwrap_or_default();
        assert!((last_sample + 0.0875).abs() < 0.02);
    }

    #[test]
    fn initial_play_still_fades_from_zero() {
        let song = demo_song();
        let song_dir = PathBuf::from("song");
        let cache = AudioBufferCache::default();
        let intro_path = song_dir.join("audio/intro.wav");
        cache.insert_for_test(
            intro_path.clone(),
            SharedAudioSource::from_preloaded(vec![0.75; 48_000 * 5], 48_000, 1, true),
        );
        cache.insert_prepared_ram_for_test(
            source::PreparedAudioKey {
                file_id: intro_path.to_string_lossy().to_string(),
                file_hash: intro_path.to_string_lossy().to_string(),
                sample_rate: 48_000,
                channels: 1,
                transpose_semitones: 0,
            },
            Arc::new(source::RawRamSource::new(vec![0.75; 48_000 * 5], 48_000, 1)),
        );

        let mut mixer = Mixer::new(
            song_dir,
            song.clone(),
            0.0,
            48_000,
            1,
            Arc::new(RwLock::new(None)),
            Arc::new(RwLock::new(None)),
            shared_mix_state(&song),
            Arc::new(RwLock::new(AppSettings::default())),
            AudioDebugConfig {
                enabled: false,
                log_commands: false,
            },
            cache,
        );

        let block = mixer.render_next_block(64);

        assert!(block[0].abs() < 0.000_001);
        assert!(block[1] > block[0]);
    }

    #[test]
    fn mixer_uses_prepared_source_when_available() {
        let song = demo_song();
        let song_dir = PathBuf::from("song");
        let prepared_path = song_dir.join("audio/late.wav");
        let cache = AudioBufferCache::default();
        cache.insert_for_test(
            prepared_path.clone(),
            SharedAudioSource::from_preloaded(vec![0.5; 48_000 * 5], 48_000, 1, true),
        );
        cache.insert_prepared_ram_for_test(
            source::PreparedAudioKey {
                file_id: prepared_path.to_string_lossy().to_string(),
                file_hash: prepared_path.to_string_lossy().to_string(),
                sample_rate: 48_000,
                channels: 1,
                transpose_semitones: 0,
            },
            Arc::new(source::RawRamSource::new(vec![0.5; 48_000 * 5], 48_000, 1)),
        );

        let mut mixer = Mixer::new_with_playback_source_policy(
            song_dir,
            song.clone(),
            10.0,
            48_000,
            1,
            Arc::new(RwLock::new(None)),
            Arc::new(RwLock::new(None)),
            shared_mix_state(&song),
            Arc::new(RwLock::new(AppSettings::default())),
            AudioDebugConfig {
                enabled: false,
                log_commands: false,
            },
            cache,
            PlaybackSourcePolicy::PreferPreparedExact,
        );

        assert_eq!(
            mixer.active_clips()[0].source_kind(),
            Some(source::SeekSourceKind::ExactRam)
        );
        let block = mixer.render_next_block(128);
        assert!(block.iter().any(|sample| sample.abs() > 0.0));
    }

    #[test]
    fn mixer_uses_prepared_original_with_sync_pitch_for_transposed_clip() {
        if !pitch::rubberband_backend_available_for_test() {
            return;
        }
        let mut song = demo_song();
        song.regions[0].transpose_semitones = 2;
        let song_dir = PathBuf::from("song");
        let prepared_path = song_dir.join("audio/intro.wav");
        let cache = AudioBufferCache::default();
        cache.insert_for_test(
            prepared_path.clone(),
            SharedAudioSource::from_preloaded(vec![0.25; 48_000 * 5], 48_000, 1, true),
        );
        let exact_key = source::PreparedAudioKey {
            file_id: prepared_path.to_string_lossy().to_string(),
            file_hash: prepared_path.to_string_lossy().to_string(),
            sample_rate: 48_000,
            channels: 1,
            transpose_semitones: 0,
        };
        cache.insert_prepared_ram_for_test(
            source::PreparedAudioKey {
                transpose_semitones: 0,
                ..exact_key.clone()
            },
            Arc::new(source::RawRamSource::new(vec![0.25; 48_000 * 5], 48_000, 1)),
        );

        let mixer = Mixer::new(
            song_dir,
            song.clone(),
            0.0,
            48_000,
            1,
            Arc::new(RwLock::new(None)),
            Arc::new(RwLock::new(None)),
            shared_mix_state(&song),
            Arc::new(RwLock::new(AppSettings::default())),
            AudioDebugConfig {
                enabled: false,
                log_commands: false,
            },
            cache.clone(),
        );

        assert_eq!(mixer.active_clips().len(), 1);
        assert!(!mixer.active_clips()[0].has_reader());
        assert!(mixer.active_clips()[0].has_prepared_source());
        cache.insert_prepared_ram_for_test(
            exact_key,
            Arc::new(source::TransposedRamSource::new(
                vec![0.5; 48_000 * 5],
                48_000,
                1,
            )),
        );

        assert!(!mixer.active_clips()[0].has_reader());
        assert!(mixer.active_clips()[0].has_prepared_source());
        assert!(!mixer.active_clips()[0].is_bypass_pitch_engine());
    }

    #[test]
    fn zero_latency_mode_counts_silence_fallback_as_preparation_failure() {
        set_zero_latency_test_mode(true);
        let song = demo_song();
        let song_dir = PathBuf::from("song");
        let cache = AudioBufferCache::default();
        let mut mixer = Mixer::new(
            song_dir,
            song.clone(),
            10.0,
            48_000,
            1,
            Arc::new(RwLock::new(None)),
            Arc::new(RwLock::new(None)),
            shared_mix_state(&song),
            Arc::new(RwLock::new(AppSettings::default())),
            AudioDebugConfig {
                enabled: false,
                log_commands: false,
            },
            cache.clone(),
        );
        set_zero_latency_test_mode(false);

        assert!(mixer.active_clips().is_empty());
        assert_eq!(cache.stats().silence_fallback_count, 1);
        let block = mixer.render_next_block(64);
        assert!(block.iter().all(|sample| sample.abs() <= GAIN_EPSILON));
    }

    #[test]
    fn disk_reader_stop_waits_for_short_master_fade_before_pausing_render() {
        let song = demo_song();
        let song_dir = PathBuf::from("song");
        let cache = AudioBufferCache::default();
        cache.insert_for_test(
            song_dir.join("audio/intro.wav"),
            SharedAudioSource::from_preloaded(vec![0.75; 48_000 * 5], 48_000, 1, true),
        );
        cache.insert_for_test(
            song_dir.join("audio/late.wav"),
            SharedAudioSource::from_preloaded(vec![0.75; 48_000 * 5], 48_000, 1, true),
        );

        let mixer = Mixer::new(
            song_dir,
            song.clone(),
            0.0,
            48_000,
            1,
            Arc::new(RwLock::new(None)),
            Arc::new(RwLock::new(None)),
            shared_mix_state(&song),
            Arc::new(RwLock::new(AppSettings::default())),
            AudioDebugConfig {
                enabled: false,
                log_commands: false,
            },
            cache,
        );
        let (producer, _consumer) = RingBuffer::<OutputSample>::new(1_024);
        let (command_sender, command_receiver) = mpsc::channel();
        let mut state = DiskReaderState {
            mixer,
            producer,
            command_receiver,
            current_generation: 0,
            is_running: true,
            stop_after_master_fade: false,
        };

        command_sender
            .send(ReaderCommand::Stop {
                fade_duration_seconds: STOP_FADE_DURATION_SECONDS,
            })
            .expect("stop command should send");

        assert!(!state.consume_commands());
        assert!(state.is_running);
        assert!(state.stop_after_master_fade);
        assert!(state.mixer.is_master_fade_active());

        let _ = state.mixer.render_next_block(DISK_RENDER_BLOCK_FRAMES);
        state.finish_stop_after_fade_if_needed();

        assert!(!state.is_running);
        assert!(!state.stop_after_master_fade);
        assert!(state.mixer.master_gain() <= GAIN_EPSILON);
    }

    #[test]
    fn disk_reader_play_after_stop_restores_master_gain() {
        let song = demo_song();
        let song_dir = PathBuf::from("song");
        let cache = AudioBufferCache::default();
        cache.insert_for_test(
            song_dir.join("audio/intro.wav"),
            SharedAudioSource::from_preloaded(vec![0.75; 48_000 * 5], 48_000, 1, true),
        );
        cache.insert_for_test(
            song_dir.join("audio/late.wav"),
            SharedAudioSource::from_preloaded(vec![0.75; 48_000 * 5], 48_000, 1, true),
        );

        let mixer = Mixer::new(
            song_dir,
            song.clone(),
            0.0,
            48_000,
            1,
            Arc::new(RwLock::new(None)),
            Arc::new(RwLock::new(None)),
            shared_mix_state(&song),
            Arc::new(RwLock::new(AppSettings::default())),
            AudioDebugConfig {
                enabled: false,
                log_commands: false,
            },
            cache,
        );
        let (producer, _consumer) = RingBuffer::<OutputSample>::new(1_024);
        let (command_sender, command_receiver) = mpsc::channel();
        let mut state = DiskReaderState {
            mixer,
            producer,
            command_receiver,
            current_generation: 0,
            is_running: true,
            stop_after_master_fade: false,
        };

        command_sender
            .send(ReaderCommand::Stop {
                fade_duration_seconds: STOP_FADE_DURATION_SECONDS,
            })
            .expect("stop command should send");
        assert!(!state.consume_commands());
        let _ = state.mixer.render_next_block(DISK_RENDER_BLOCK_FRAMES);
        state.finish_stop_after_fade_if_needed();
        assert!(state.mixer.master_gain() <= GAIN_EPSILON);

        command_sender
            .send(ReaderCommand::Play {
                song,
                position_seconds: 1.0,
                reason: PlaybackStartReason::ResumePlay,
                generation: 1,
            })
            .expect("play command should send");

        assert!(!state.consume_commands());
        assert!(state.is_running);
        assert!(!state.stop_after_master_fade);
        assert!((state.mixer.master_gain() - 1.0).abs() <= GAIN_EPSILON);
    }

    #[test]
    fn ring_consumer_writes_silence_when_buffer_runs_empty() {
        let (mut producer, mut consumer) = RingBuffer::<OutputSample>::new(4);
        let seek_generation = Arc::new(AtomicU64::new(0));
        let mut state =
            CpalCrossfadeState::new(0, 48_000, 1, Arc::new(AudioRuntimeCounters::default()));
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
            &mut state,
            |sample| sample,
        );

        assert_eq!(output, [0.25, -0.5, 0.0, 0.0]);
    }

    #[test]
    fn ring_consumer_flushes_stale_generation_on_seek() {
        let (mut producer, mut consumer) = RingBuffer::<OutputSample>::new(4);
        let seek_generation = Arc::new(AtomicU64::new(0));
        let mut state =
            CpalCrossfadeState::new(0, 48_000, 1, Arc::new(AudioRuntimeCounters::default()));

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
            &mut state,
            |sample| sample,
        );

        assert_eq!(output, [1.25, 0.0]);
        assert_eq!(state.active_generation, 1);
    }

    #[test]
    fn playback_session_seek_increments_generation_for_buffer_flush() {
        let song = demo_song();
        let seek_generation = Arc::new(AtomicU64::new(0));
        let mut session = PlaybackSession {
            backend: PlaybackBackend::Null,
            song_dir: PathBuf::new(),
            reader_sender: None,
            reader_handle: None,
            seek_generation: seek_generation.clone(),
            counters: Arc::new(AudioRuntimeCounters::default()),
            backend_kind: None,
            device_name: None,
            output_sample_rate: 0,
            actual_buffer_size: 0,
            ring_capacity_frames: 0,
            prefill_frames: 0,
            prefill_result: PrefillResult::default(),
            startup_readiness: MixerStartupReadiness::default(),
            audio_buffers: AudioBufferCache::default(),
        };

        let seek_report = session
            .seek(song, 8.0, PlaybackStartReason::Seek)
            .expect("seek should succeed on null backend");

        assert_eq!(seek_report.active_sinks, 1);
        assert_eq!(seek_generation.load(Ordering::Acquire), 1);
    }

    #[test]
    fn far_seek_to_exact_ram_is_immediate() {
        let song = transposed_far_seek_song();
        let song_dir = PathBuf::from("song");
        let clip_path = song_dir.join("audio/late.wav");
        let cache = AudioBufferCache::default();
        cache.insert_hot_for_test(
            clip_path,
            4,
            SharedAudioSource::from_preloaded(vec![0.2; 48_000], 48_000, 1, true),
        );

        let started_at = Instant::now();
        let decision = cache.get_best_source_for_seek(&song_dir, &song, 11.0, 4);

        assert_eq!(decision.kind(), source::SeekSourceKind::ExactRam);
        assert!(started_at.elapsed() < Duration::from_millis(10));
    }

    #[test]
    fn far_seek_to_exact_disk_is_immediate_and_non_blocking() {
        let song = transposed_far_seek_song();
        let song_dir = PathBuf::from("song");
        let clip_path = song_dir.join("audio/late.wav");
        let cache = AudioBufferCache::default();
        cache.insert_prepared_disk_for_test(
            clip_path,
            4,
            SharedAudioSource::from_preloaded(vec![0.2; 48_000], 48_000, 1, true),
        );

        let started_at = Instant::now();
        let decision = cache.get_best_source_for_seek(&song_dir, &song, 11.0, 4);

        assert_eq!(decision.kind(), source::SeekSourceKind::ExactDisk);
        assert!(started_at.elapsed() < Duration::from_millis(10));
    }

    #[test]
    fn far_seek_to_missing_transposed_source_falls_back_immediately() {
        let song = transposed_far_seek_song();
        let song_dir = PathBuf::from("song");
        let clip_path = song_dir.join("audio/late.wav");
        let cache = AudioBufferCache::default();
        cache.insert_for_test(
            clip_path,
            SharedAudioSource::from_preloaded(vec![0.2; 48_000], 48_000, 1, true),
        );

        let decision = cache.get_best_source_for_seek(&song_dir, &song, 11.0, 4);

        assert_eq!(decision.kind(), source::SeekSourceKind::OriginalDisk);
        assert!(decision.used_fallback(4));
    }

    #[test]
    fn far_seek_schedules_urgent_transposed_render() {
        let song = transposed_far_seek_song();
        let seek_generation = Arc::new(AtomicU64::new(0));
        let mut session = PlaybackSession {
            backend: PlaybackBackend::Null,
            song_dir: PathBuf::from("song"),
            reader_sender: None,
            reader_handle: None,
            seek_generation,
            counters: Arc::new(AudioRuntimeCounters::default()),
            backend_kind: None,
            device_name: None,
            output_sample_rate: 0,
            actual_buffer_size: 0,
            ring_capacity_frames: 0,
            prefill_frames: 0,
            prefill_result: PrefillResult::default(),
            startup_readiness: MixerStartupReadiness::default(),
            audio_buffers: AudioBufferCache::default(),
        };

        let report = session
            .seek(song, 11.0, PlaybackStartReason::ImmediateJump)
            .expect("far seek should schedule preparation");
        let requests = session.audio_buffers.prepare_requests_for_test();

        assert!(report.far_seek.prepare_requested);
        assert_eq!(
            requests[0].priority,
            source::PreparePriority::RealtimeCritical
        );
        assert!(requests
            .iter()
            .any(|request| request.transpose_semitones == 4));
        assert!(requests
            .iter()
            .any(|request| request.transpose_semitones == 0));
    }

    #[test]
    fn simulated_asio_start_does_not_emit_original_before_realtime_pitch_is_ready() {
        if !pitch::rubberband_backend_available_for_test() {
            return;
        }
        let song_dir = PathBuf::from("song");
        let file_path = song_dir.join("audio/dup.wav");
        let mut song = demo_song();
        song.regions[0].transpose_semitones = -3;
        song.tracks = vec![
            Track {
                id: "track_original".into(),
                name: "Original".into(),
                kind: libretracks_core::TrackKind::Audio,
                parent_track_id: None,
                volume: 1.0,
                pan: -1.0,
                muted: false,
                solo: false,
                transpose_enabled: false,
                audio_to: "master".to_string(),
            },
            Track {
                id: "track_transposed".into(),
                name: "Transposed".into(),
                kind: libretracks_core::TrackKind::Audio,
                parent_track_id: None,
                volume: 1.0,
                pan: 1.0,
                muted: false,
                solo: false,
                transpose_enabled: true,
                audio_to: "master".to_string(),
            },
        ];
        song.clips = vec![
            Clip {
                id: "clip_original".into(),
                track_id: "track_original".into(),
                file_path: "audio/dup.wav".into(),
                timeline_start_seconds: 0.0,
                source_start_seconds: 0.0,
                duration_seconds: 2.0,
                gain: 1.0,
                fade_in_seconds: None,
                fade_out_seconds: None,
            },
            Clip {
                id: "clip_transposed".into(),
                track_id: "track_transposed".into(),
                file_path: "audio/dup.wav".into(),
                timeline_start_seconds: 0.0,
                source_start_seconds: 0.0,
                duration_seconds: 2.0,
                gain: 1.0,
                fade_in_seconds: None,
                fade_out_seconds: None,
            },
        ];
        let cache = AudioBufferCache::default();
        cache.insert_prepared_ram_for_test(
            source::PreparedAudioKey {
                file_id: file_path.to_string_lossy().to_string(),
                file_hash: file_path.to_string_lossy().to_string(),
                sample_rate: 48_000,
                channels: 2,
                transpose_semitones: 0,
            },
            Arc::new(source::RawRamSource::new(
                vec![0.5; 48_000 * 2 * 2],
                48_000,
                2,
            )),
        );

        let mixer = Mixer::new(
            song_dir,
            song.clone(),
            0.0,
            48_000,
            2,
            Arc::new(RwLock::new(None)),
            Arc::new(RwLock::new(None)),
            shared_mix_state(&song),
            Arc::new(RwLock::new(AppSettings::default())),
            AudioDebugConfig {
                enabled: false,
                log_commands: false,
            },
            cache,
        );
        let readiness = mixer.startup_readiness();
        assert_eq!(readiness.active_clip_count, 0);
        assert_eq!(readiness.realtime_pitch_clip_count, 0);
        assert!(
            readiness.all_realtime_pitch_engines_ready,
            "unsafe exact + realtime pitch route should be blocked until exact cache or homogeneous streaming is available"
        );
    }

    #[test]
    fn replace_song_buffers_prepares_original_sources_for_active_song() {
        let root = tempdir().expect("temp dir should exist");
        let song_dir = root.path().join("song");
        fs::create_dir_all(song_dir.join("audio")).expect("audio dir should exist");
        write_counting_test_wav(&song_dir.join("audio/intro.wav"), 48_000, 48_000);
        write_counting_test_wav(&song_dir.join("audio/late.wav"), 48_000, 48_000);
        let song = demo_song();
        let cache = AudioBufferCache::default();

        cache
            .replace_song_buffers(&song_dir, &song)
            .expect("song buffers should prepare");

        for clip in &song.clips {
            let file_path = song_dir.join(&clip.file_path);
            let key = source::PreparedAudioKey {
                file_id: file_path.to_string_lossy().to_string(),
                file_hash: file_path.to_string_lossy().to_string(),
                sample_rate: 48_000,
                channels: 2,
                transpose_semitones: 0,
            };
            assert!(
                cache.prepared_audio().get_original(&key, 0).is_some(),
                "missing original prepared source for {}",
                file_path.display()
            );
        }
    }

    #[test]
    fn urgent_seek_prepares_original_and_exact_runtime_sources() {
        let root = tempdir().expect("temp dir should exist");
        let song_dir = root.path().join("song");
        fs::create_dir_all(song_dir.join("audio")).expect("audio dir should exist");
        write_counting_test_wav(&song_dir.join("audio/intro.wav"), 48_000, 48_000);
        write_counting_test_wav(&song_dir.join("audio/late.wav"), 48_000, 48_000);
        let song = transposed_far_seek_song();
        let cache = AudioBufferCache::default();
        cache
            .replace_song_buffers(&song_dir, &song)
            .expect("song buffers should prepare");

        cache.record_recent_seek_and_reprioritize(&song_dir, &song, 11.0, 4);

        let late_path = song_dir.join("audio/late.wav");
        let exact_key = source::PreparedAudioKey {
            file_id: late_path.to_string_lossy().to_string(),
            file_hash: late_path.to_string_lossy().to_string(),
            sample_rate: 48_000,
            channels: 2,
            transpose_semitones: 4,
        };
        assert!(cache.prepared_audio().get_original(&exact_key, 0).is_some());
        assert!(cache.prepared_audio().get_exact(&exact_key, 0).is_none());
        let requests = cache.prepare_requests_for_test();
        assert!(requests
            .iter()
            .any(|request| request.transpose_semitones == 4
                && request.priority == source::PreparePriority::RealtimeCritical));
    }

    #[test]
    fn seek_readiness_map_tracks_regions_markers_and_recent_positions() {
        let mut song = transposed_far_seek_song();
        song.section_markers.push(Marker {
            id: "marker_far".into(),
            name: "Far".into(),
            start_seconds: 11.0,
            digit: Some(1),
        });
        let song_dir = PathBuf::from("song");
        let cache = AudioBufferCache::default();

        cache.on_timeline_hover_or_drag(&song_dir, &song, 11.0);
        let map = cache
            .seek_readiness_map_for_test(&song.id)
            .expect("readiness map should be built");

        assert!(map
            .hot_targets
            .iter()
            .any(|target| target.kind == source::SeekTargetKind::Marker));
        assert_eq!(map.regions.len(), song.regions.len());
        assert_eq!(map.last_user_positions, vec![11.0]);
    }

    #[test]
    fn first_output_frame_after_musical_seek_is_not_forced_to_zero() {
        let song = demo_song();
        let song_dir = PathBuf::from("song");
        let cache = AudioBufferCache::default();
        let intro_path = song_dir.join("audio/intro.wav");
        let late_path = song_dir.join("audio/late.wav");
        cache.insert_for_test(
            intro_path.clone(),
            SharedAudioSource::from_preloaded(vec![0.75; 48_000 * 5], 48_000, 1, true),
        );
        cache.insert_for_test(
            late_path.clone(),
            SharedAudioSource::from_preloaded(vec![-0.25; 48_000 * 5], 48_000, 1, true),
        );
        cache.insert_prepared_ram_for_test(
            source::PreparedAudioKey {
                file_id: intro_path.to_string_lossy().to_string(),
                file_hash: intro_path.to_string_lossy().to_string(),
                sample_rate: 48_000,
                channels: 1,
                transpose_semitones: 0,
            },
            Arc::new(source::RawRamSource::new(vec![0.75; 48_000 * 5], 48_000, 1)),
        );
        cache.insert_prepared_ram_for_test(
            source::PreparedAudioKey {
                file_id: late_path.to_string_lossy().to_string(),
                file_hash: late_path.to_string_lossy().to_string(),
                sample_rate: 48_000,
                channels: 1,
                transpose_semitones: 0,
            },
            Arc::new(source::RawRamSource::new(
                vec![-0.25; 48_000 * 5],
                48_000,
                1,
            )),
        );

        let mut mixer = Mixer::new(
            song_dir,
            song.clone(),
            0.0,
            48_000,
            1,
            Arc::new(RwLock::new(None)),
            Arc::new(RwLock::new(None)),
            shared_mix_state(&song),
            Arc::new(RwLock::new(AppSettings::default())),
            AudioDebugConfig {
                enabled: false,
                log_commands: false,
            },
            cache,
        );

        let _first_block = mixer.render_next_block(192);
        mixer.seek(song, 10.0);
        let spliced_block = mixer.render_next_block(64);

        assert!(spliced_block[0].abs() <= f32::EPSILON);
        assert!(spliced_block[63].abs() > spliced_block[1].abs());

        let crossfade_tail = mixer.render_next_block(896);
        let last_sample = crossfade_tail.last().copied().unwrap_or_default();
        assert!((last_sample + 0.0875).abs() < 0.02);
    }

    #[test]
    fn wav_pcm_cache_probes_assets() {
        let temp_dir = tempdir().expect("temp dir should exist");
        let audio_path = temp_dir.path().join("clip.wav");
        write_silent_test_wav(&audio_path);

        probe_audio_file(&audio_path).expect("wav should probe");
    }

    #[test]
    fn wav_pcm_cache_probe_fails_for_missing_file() {
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
