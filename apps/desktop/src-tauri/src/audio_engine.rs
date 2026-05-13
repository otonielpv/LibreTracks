use std::{
    collections::{hash_map::DefaultHasher, HashMap},
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use libretracks_core::Song;
use libretracks_remote::RemoteServerHandle;
use lt_audio_engine_v2::{
    DeviceInfo, Engine, EngineCommand, JumpTarget, JumpTargetKind, JumpTrigger,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::{error::DesktopError, settings::AppSettings};

const ENGINE_SAMPLE_RATE: f64 = 48_000.0;
const ENGINE_V2_MAX_OUTPUT_CHANNELS: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AudioBackendKind {
    Asio,
    Wasapi,
    CoreAudio,
    Alsa,
    Jack,
    DirectSound,
    Mme,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AudioSampleFormat {
    F32,
    I16,
    U16,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AudioBufferSizeRequest {
    Default,
    Fixed(u32),
}

impl Default for AudioBufferSizeRequest {
    fn default() -> Self {
        Self::Default
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputChannelRequest {
    pub channels: Vec<usize>,
}

impl Default for OutputChannelRequest {
    fn default() -> Self {
        Self {
            channels: vec![0, 1],
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDeviceDescriptor {
    pub backend: AudioBackendKind,
    pub backend_id: String,
    pub stable_id: String,
    pub name: String,
    pub display_name: String,
    pub is_default: bool,
    pub max_output_channels: usize,
    pub default_sample_rate: Option<u32>,
    pub supported_sample_rates: Vec<u32>,
    pub supported_buffer_sizes: Vec<u32>,
    pub supported_sample_formats: Vec<AudioSampleFormat>,
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

#[derive(Debug)]
pub(crate) struct AudioCommand;

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
    pub backend_counters: AudioBackendCountersSummary,
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
    pub master_gain: f32,
    pub far_seek_cache_status: Option<String>,
    pub far_seek_exact_ready: bool,
    pub far_seek_used_fallback: bool,
    pub far_seek_prepare_requested: bool,
    pub far_seek_swap_to_exact_ms: Option<f64>,
    pub last_seek_path: Option<String>,
    pub last_seek_exact_pitch_hit: bool,
    pub last_seek_fallback_used: bool,
    pub last_seek_source_waited: bool,
    pub source_swap_ms_after_seek: Option<f64>,
    pub starved_frames: u64,
    pub streaming_reader_used_in_zero_latency_mode: bool,
    pub ram_cache_used_mb: usize,
    pub disk_cache_used_mb: usize,
    pub prepare_queue_len: usize,
    pub prepare_active_tasks: usize,
    pub prepare_cancelled_tasks: usize,
    pub source_swap_count: u64,
    pub playback_path: Option<String>,
    pub source_kind: Option<String>,
    pub silence_fallback_count: u64,
    pub last_silence_fallback_position: Option<f64>,
    pub last_silence_fallback_file: Option<String>,
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
            master_gain: 1.0,
            far_seek_cache_status: None,
            far_seek_exact_ready: false,
            far_seek_used_fallback: false,
            far_seek_prepare_requested: false,
            far_seek_swap_to_exact_ms: None,
            last_seek_path: None,
            last_seek_exact_pitch_hit: false,
            last_seek_fallback_used: false,
            last_seek_source_waited: false,
            source_swap_ms_after_seek: None,
            starved_frames: 0,
            streaming_reader_used_in_zero_latency_mode: false,
            ram_cache_used_mb: 0,
            disk_cache_used_mb: 0,
            prepare_queue_len: 0,
            prepare_active_tasks: 0,
            prepare_cancelled_tasks: 0,
            source_swap_count: 0,
            playback_path: Some("cpp-v2".into()),
            source_kind: Some("EngineV2".into()),
            silence_fallback_count: 0,
            last_silence_fallback_position: None,
            last_silence_fallback_file: None,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioBackendCountersSummary {
    pub backend: Option<String>,
    pub device: Option<String>,
    pub sample_rate: u32,
    pub actual_buffer_size: usize,
    pub ring_capacity_frames: usize,
    pub prefill_frames: usize,
    pub prefill_completed: bool,
    pub prefill_available_frames: usize,
    pub callback_count: u64,
    pub callback_min_frames: usize,
    pub callback_max_frames: usize,
    pub valid_rendered_frames: u64,
    pub underrun_frames: u64,
    pub xrun_count: u64,
    pub needs_resync: bool,
    pub stale_drop_count: u64,
    pub resync_count: u64,
    pub realtime_pitch_clip_count: usize,
    pub min_queued_pitch_output_frames: usize,
    pub clip_diagnostics: Vec<serde_json::Value>,
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

struct ControllerState {
    engine: Option<Engine>,
    settings: AppSettings,
    command_count: u64,
    last_command: Option<AudioCommandTrace>,
    last_restart: Option<AudioOperationSummary>,
    last_sync: Option<AudioOperationSummary>,
    last_stop: Option<AudioStopSummary>,
    running: bool,
    anchor_position_seconds: Option<f64>,
    anchor_started_at: Option<Instant>,
    song_duration_seconds: Option<f64>,
    last_start_reason: Option<String>,
    song_dir: Option<PathBuf>,
    loaded_session_signature: Option<String>,
}

impl ControllerState {
    fn new() -> Self {
        Self {
            engine: None,
            settings: AppSettings::default(),
            command_count: 0,
            last_command: None,
            last_restart: None,
            last_sync: None,
            last_stop: None,
            running: false,
            anchor_position_seconds: None,
            anchor_started_at: None,
            song_duration_seconds: None,
            last_start_reason: None,
            song_dir: None,
            loaded_session_signature: None,
        }
    }
}

pub struct AudioController {
    state: Mutex<ControllerState>,
    sender: mpsc::Sender<AudioCommand>,
    meter_thread_started: AtomicBool,
    meter_thread_stop: Arc<AtomicBool>,
    meter_thread: Mutex<Option<JoinHandle<()>>>,
}

impl AudioController {
    pub fn new() -> Self {
        let (sender, _receiver) = mpsc::channel();
        Self {
            state: Mutex::new(ControllerState::new()),
            sender,
            meter_thread_started: AtomicBool::new(false),
            meter_thread_stop: Arc::new(AtomicBool::new(false)),
            meter_thread: Mutex::new(None),
        }
    }

    pub fn attach_app_handle(&self, app_handle: AppHandle) {
        if self
            .meter_thread_started
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return;
        }
        let stop = Arc::clone(&self.meter_thread_stop);
        let controller_addr = self as *const AudioController as usize;
        let handle = thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                let controller = unsafe { &*(controller_addr as *const AudioController) };
                if let Ok(levels) = controller.current_meter_levels() {
                    if !levels.is_empty() {
                        let _ = app_handle.emit("audio:meters", levels);
                    }
                }
                thread::sleep(std::time::Duration::from_millis(33));
            }
        });
        if let Ok(mut thread_slot) = self.meter_thread.lock() {
            *thread_slot = Some(handle);
        }
    }

    pub fn attach_remote_handle(&self, _remote_handle: RemoteServerHandle) {}

    pub(crate) fn command_sender(&self) -> mpsc::Sender<AudioCommand> {
        self.sender.clone()
    }

    pub fn play(
        &self,
        song_dir: PathBuf,
        song: Song,
        position_seconds: f64,
        reason: PlaybackStartReason,
    ) -> Result<(), DesktopError> {
        self.with_engine_state("play", Some(reason), |engine, state| {
            state.song_dir = Some(song_dir);
            ensure_song_loaded(engine, state, &song)?;
            engine.send_command(&EngineCommand::SeekAbsolute {
                frame: seconds_to_frame_for_engine(engine, position_seconds),
            })?;
            wait_for_playback_sources(engine)?;
            engine.send_command(&EngineCommand::Play)?;
            state.running = true;
            state.anchor_position_seconds = Some(position_seconds);
            state.anchor_started_at = Some(Instant::now());
            state.song_duration_seconds = Some(song.duration_seconds);
            state.last_start_reason = Some(playback_reason_label(reason).into());
            state.last_restart = Some(AudioOperationSummary {
                reason: Some(playback_reason_label(reason).into()),
                elapsed_ms: 0.0,
                scheduled_clips: song.clips.len(),
                active_sinks: song.tracks.len(),
                opened_files: 0,
            });
            Ok(())
        })
    }

    pub fn seek(
        &self,
        song: Song,
        position_seconds: f64,
        reason: PlaybackStartReason,
    ) -> Result<(), DesktopError> {
        self.with_engine_state("seek", Some(reason), |engine, state| {
            ensure_song_loaded(engine, state, &song)?;
            engine.send_command(&EngineCommand::SeekAbsolute {
                frame: seconds_to_frame_for_engine(engine, position_seconds),
            })?;
            state.anchor_position_seconds = Some(position_seconds);
            state.anchor_started_at = if state.running {
                Some(Instant::now())
            } else {
                None
            };
            state.song_duration_seconds = Some(song.duration_seconds);
            state.last_start_reason = Some(playback_reason_label(reason).into());
            Ok(())
        })
    }

    pub fn on_timeline_hover_or_drag(
        &self,
        song_dir: PathBuf,
        song: Song,
        _position_seconds: f64,
    ) -> Result<(), DesktopError> {
        self.with_engine_state("sync_song", None, |_engine, state| {
            state.song_dir = Some(song_dir);
            state.song_duration_seconds = Some(song.duration_seconds);
            state.last_sync = Some(AudioOperationSummary {
                reason: Some("remember_song_dir".into()),
                elapsed_ms: 0.0,
                scheduled_clips: song.clips.len(),
                active_sinks: song.tracks.len(),
                opened_files: 0,
            });
            Ok(())
        })
    }

    pub fn sync_song(&self, song: Song) -> Result<(), DesktopError> {
        self.with_engine_state("sync_song", None, |engine, state| {
            ensure_song_loaded(engine, state, &song)?;
            state.song_duration_seconds = Some(song.duration_seconds);
            state.last_sync = Some(AudioOperationSummary {
                reason: Some("load_session".into()),
                elapsed_ms: 0.0,
                scheduled_clips: song.clips.len(),
                active_sinks: song.tracks.len(),
                opened_files: 0,
            });
            Ok(())
        })
    }

    pub fn sync_live_mix(&self, song: &Song) -> Result<(), DesktopError> {
        self.with_engine_state("sync_live_mix", None, |engine, _state| {
            for track in &song.tracks {
                engine.send_command(&EngineCommand::SetTrackGain {
                    track_id: track.id.clone(),
                    gain: track.volume as f32,
                })?;
                engine.send_command(&EngineCommand::SetTrackPan {
                    track_id: track.id.clone(),
                    pan: track.pan as f32,
                })?;
                engine.send_command(&EngineCommand::SetTrackMute {
                    track_id: track.id.clone(),
                    mute: track.muted,
                })?;
                engine.send_command(&EngineCommand::SetTrackSolo {
                    track_id: track.id.clone(),
                    solo: track.solo,
                })?;
                engine.send_command(&EngineCommand::SetTrackAudioRoute {
                    track_id: track.id.clone(),
                    audio_to: track.audio_to.clone(),
                })?;
                engine.send_command(&EngineCommand::SetTrackTransposeEnabled {
                    track_id: track.id.clone(),
                    enabled: track.transpose_enabled,
                })?;
            }
            Ok(())
        })
    }

    pub fn update_live_region_transpose(
        &self,
        region_id: &str,
        semitones: i32,
    ) -> Result<(), DesktopError> {
        self.with_engine_state("set_region_transpose", None, |engine, _state| {
            engine.send_command(&EngineCommand::SetRegionTranspose {
                region_id: region_id.into(),
                semitones,
            })?;
            Ok(())
        })
    }

    pub fn ensure_live_track(&self, song: &Song, _track_id: &str) -> Result<(), DesktopError> {
        self.sync_live_mix(song)
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
        self.with_engine_state("update_live_track_mix", None, |engine, _state| {
            if let Some(volume) = volume {
                engine.send_command(&EngineCommand::SetTrackGain {
                    track_id: track_id.into(),
                    gain: volume as f32,
                })?;
            }
            if let Some(pan) = pan {
                engine.send_command(&EngineCommand::SetTrackPan {
                    track_id: track_id.into(),
                    pan: pan as f32,
                })?;
            }
            if let Some(muted) = muted {
                engine.send_command(&EngineCommand::SetTrackMute {
                    track_id: track_id.into(),
                    mute: muted,
                })?;
            }
            if let Some(solo) = solo {
                engine.send_command(&EngineCommand::SetTrackSolo {
                    track_id: track_id.into(),
                    solo,
                })?;
            }
            if let Some(audio_to) = audio_to {
                engine.send_command(&EngineCommand::SetTrackAudioRoute {
                    track_id: track_id.into(),
                    audio_to: audio_to.into(),
                })?;
            }
            Ok(())
        })
    }

    pub fn current_settings(&self) -> Result<AppSettings, DesktopError> {
        self.state
            .lock()
            .map(|state| state.settings.clone())
            .map_err(|_| DesktopError::AudioCommand("audio v2 state lock poisoned".into()))
    }

    pub fn apply_settings(&self, settings: AppSettings) -> Result<(), DesktopError> {
        self.apply_settings_with_stream_rebuild(settings, true)
    }

    pub fn apply_settings_with_stream_rebuild(
        &self,
        settings: AppSettings,
        _rebuild_stream: bool,
    ) -> Result<(), DesktopError> {
        self.with_engine_state("apply_settings", None, |engine, state| {
            if let Some(device_id) = settings
                .selected_output_device_id
                .clone()
                .or_else(|| settings.selected_output_device.clone())
            {
                engine.send_command(&EngineCommand::SetOutputDevice { device_id })?;
            }
            if let Some(sample_rate) = settings.output_sample_rate {
                engine.send_command(&EngineCommand::SetSampleRate {
                    sample_rate: sample_rate as i32,
                })?;
            }
            if let AudioBufferSizeRequest::Fixed(buffer_size) = settings.output_buffer_size {
                engine.send_command(&EngineCommand::SetBufferSize {
                    buffer_size: buffer_size as i32,
                })?;
            }
            engine.send_command(&EngineCommand::SetMetronomeConfig {
                enabled: settings.metronome_enabled,
                volume: settings.metronome_volume.clamp(0.0, 1.0) as f32,
                route: settings.metronome_output.clone(),
            })?;
            state.settings = settings;
            Ok(())
        })
    }

    pub fn stop(&self) -> Result<(), DesktopError> {
        self.with_engine_state("stop", None, |engine, state| {
            engine.send_command(&EngineCommand::Stop)?;
            state.running = false;
            state.anchor_started_at = None;
            state.last_stop = Some(AudioStopSummary {
                elapsed_ms: 0.0,
                stopped_sinks: 1,
            });
            Ok(())
        })
    }

    pub fn start_master_fade(
        &self,
        _target_gain: f32,
        _duration_seconds: f64,
    ) -> Result<(), DesktopError> {
        Ok(())
    }

    pub fn debug_snapshot(&self) -> Result<AudioDebugSnapshot, DesktopError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| DesktopError::AudioCommand("audio v2 state lock poisoned".into()))?;
        let snapshot = ensure_engine(&mut state)?.get_snapshot().ok();
        let device = snapshot.as_ref().map(|snapshot| snapshot.device.clone());
        let cpu = snapshot.as_ref().map(|snapshot| snapshot.cpu.clone());
        let estimated_position_seconds = snapshot
            .as_ref()
            .map(|snapshot| snapshot.current_seconds)
            .or_else(|| estimate_position(&state));

        Ok(AudioDebugSnapshot {
            enabled: true,
            log_commands: false,
            command_count: state.command_count,
            last_command: state.last_command.clone(),
            last_restart: state.last_restart.clone(),
            last_sync: state.last_sync.clone(),
            last_stop: state.last_stop.clone(),
            runtime_state: AudioRuntimeStateSummary::default(),
            playhead: AudioPlayheadEstimate {
                running: state.running,
                anchor_position_seconds: state.anchor_position_seconds,
                estimated_position_seconds,
                song_duration_seconds: state.song_duration_seconds,
                anchor_age_ms: state
                    .anchor_started_at
                    .map(|started| started.elapsed().as_secs_f64() * 1000.0),
                last_start_reason: state.last_start_reason.clone(),
            },
            backend_counters: AudioBackendCountersSummary {
                backend: device.as_ref().map(|device| device.backend.clone()),
                device: device.as_ref().map(|device| device.device_name.clone()),
                sample_rate: device
                    .as_ref()
                    .map(|device| device.sample_rate.max(0) as u32)
                    .unwrap_or_default(),
                actual_buffer_size: device
                    .as_ref()
                    .map(|device| device.buffer_size.max(0) as usize)
                    .unwrap_or_default(),
                callback_count: cpu
                    .as_ref()
                    .map(|cpu| cpu.callback_count.max(0) as u64)
                    .unwrap_or_default(),
                xrun_count: cpu
                    .as_ref()
                    .map(|cpu| cpu.underrun_count.max(0) as u64)
                    .unwrap_or_default(),
                ..AudioBackendCountersSummary::default()
            },
        })
    }

    pub fn replace_song_buffers(&self, song_dir: &Path, song: &Song) -> Result<(), DesktopError> {
        let song_dir = song_dir.to_path_buf();
        let song = song.clone();
        self.with_engine_state("sync_song", None, |engine, state| {
            state.song_dir = Some(song_dir);
            force_load_song(engine, state, &song)?;
            state.song_duration_seconds = Some(song.duration_seconds);
            state.last_sync = Some(AudioOperationSummary {
                reason: Some("load_session".into()),
                elapsed_ms: 0.0,
                scheduled_clips: song.clips.len(),
                active_sinks: song.tracks.len(),
                opened_files: 0,
            });
            Ok(())
        })
    }

    fn current_meter_levels(&self) -> Result<Vec<AudioMeterLevel>, DesktopError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| DesktopError::AudioCommand("audio v2 state lock poisoned".into()))?;
        let snapshot = ensure_engine(&mut state)?
            .get_snapshot()
            .map_err(|error| DesktopError::AudioCommand(error.to_string()))?;
        Ok(snapshot
            .track_meters
            .into_iter()
            .map(|meter| AudioMeterLevel {
                track_id: meter.track_id,
                left_peak: meter.left_peak,
                right_peak: meter.right_peak,
            })
            .collect())
    }

    pub fn prepare_song_buffers_async(&self, song_dir: PathBuf, _song: Song) {
        // Source preparation is owned by the C++ engine after LoadSession.
        // Avoid issuing a second LoadSession immediately before Play; replacing
        // the native preparation queue while decode workers are active can race
        // with worker completion callbacks.
        if let Ok(mut state) = self.state.lock() {
            state.song_dir = Some(song_dir);
            state.command_count += 1;
            state.last_command = Some(AudioCommandTrace {
                kind: "prepare_sources".into(),
                reason: Some("engine_v2_owned".into()),
            });
        }
    }

    pub fn export_region_rendered_audio(
        &self,
        _song_dir: PathBuf,
        _song: Song,
        _region_id: &str,
        _output_path: &Path,
    ) -> Result<(), DesktopError> {
        Err(DesktopError::AudioCommand(
            "rendered audio export has not been reconnected to C++ engine v2 yet".into(),
        ))
    }

    fn with_engine_state(
        &self,
        kind: &str,
        reason: Option<PlaybackStartReason>,
        f: impl FnOnce(&Engine, &mut ControllerState) -> Result<(), DesktopError>,
    ) -> Result<(), DesktopError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| DesktopError::AudioCommand("audio v2 state lock poisoned".into()))?;
        state.command_count += 1;
        state.last_command = Some(AudioCommandTrace {
            kind: kind.into(),
            reason: reason.map(playback_reason_label).map(str::to_string),
        });
        if state.engine.is_none() {
            let engine =
                Engine::new().map_err(|error| DesktopError::AudioCommand(error.to_string()))?;
            engine
                .initialize()
                .map_err(|error| DesktopError::AudioCommand(error.to_string()))?;
            state.engine = Some(engine);
        }
        let engine = state
            .engine
            .take()
            .expect("engine should be initialized before command dispatch");
        let result = f(&engine, &mut state);
        state.engine = Some(engine);
        result
    }
}

impl Default for AudioController {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for AudioController {
    fn drop(&mut self) {
        self.meter_thread_stop.store(true, Ordering::Relaxed);
        if let Ok(mut handle) = self.meter_thread.lock() {
            if let Some(handle) = handle.take() {
                let _ = handle.join();
            }
        }
        if let Ok(mut state) = self.state.lock() {
            if let Some(engine) = state.engine.as_ref() {
                let _ = engine.shutdown();
            }
            state.engine = None;
        }
    }
}

#[tauri::command]
pub fn get_audio_output_devices() -> Result<AudioOutputDevicesResponse, String> {
    let engine = Engine::new().map_err(|error| error.to_string())?;
    engine.initialize().map_err(|error| error.to_string())?;
    let devices = engine.list_devices().map_err(|error| error.to_string())?;
    let _ = engine.shutdown();
    Ok(devices_response(devices))
}

pub fn audio_debug_logging_enabled() -> bool {
    std::env::var("LIBRETRACKS_AUDIO_DEBUG")
        .map(|value| matches!(value.as_str(), "1" | "true" | "TRUE" | "yes" | "YES"))
        .unwrap_or(false)
}

fn ensure_engine(state: &mut ControllerState) -> Result<&Engine, DesktopError> {
    if state.engine.is_none() {
        let engine =
            Engine::new().map_err(|error| DesktopError::AudioCommand(error.to_string()))?;
        engine
            .initialize()
            .map_err(|error| DesktopError::AudioCommand(error.to_string()))?;
        state.engine = Some(engine);
    }
    Ok(state.engine.as_ref().expect("engine should be initialized"))
}

fn ensure_song_loaded(
    engine: &Engine,
    state: &mut ControllerState,
    song: &Song,
) -> Result<(), DesktopError> {
    let resolved = song_with_resolved_audio_paths(state.song_dir.as_deref(), song);
    let signature = session_signature(&resolved);
    if state.loaded_session_signature.as_deref() == Some(signature.as_str()) {
        return Ok(());
    }
    load_resolved_song(engine, state, &resolved, signature)
}

fn force_load_song(
    engine: &Engine,
    state: &mut ControllerState,
    song: &Song,
) -> Result<(), DesktopError> {
    let resolved = song_with_resolved_audio_paths(state.song_dir.as_deref(), song);
    let signature = session_signature(&resolved);
    load_resolved_song(engine, state, &resolved, signature)
}

fn load_resolved_song(
    engine: &Engine,
    state: &mut ControllerState,
    song: &Song,
    signature: String,
) -> Result<(), DesktopError> {
    let project_json = serde_json::to_string(song)
        .map_err(|error| DesktopError::AudioCommand(error.to_string()))?;
    engine
        .send_command(&EngineCommand::LoadSession { project_json })
        .map_err(|error| DesktopError::AudioCommand(error.to_string()))?;
    state.loaded_session_signature = Some(signature);
    Ok(())
}

fn song_with_resolved_audio_paths(song_dir: Option<&Path>, song: &Song) -> Song {
    let Some(song_dir) = song_dir else {
        return song.clone();
    };
    let mut resolved = song.clone();
    for clip in &mut resolved.clips {
        let normalized_clip_path = normalize_engine_audio_path(&clip.file_path);
        let raw_path = normalized_clip_path.trim();
        if raw_path.is_empty() {
            continue;
        }
        let path = Path::new(raw_path);
        if path.is_relative() {
            clip.file_path = song_dir.join(path).to_string_lossy().replace('\\', "/");
        } else {
            clip.file_path = raw_path.replace('\\', "/");
        }
    }
    resolved
}

fn normalize_engine_audio_path(path: &str) -> String {
    let mut normalized = path.trim().trim_matches('"').trim_matches('\'').replace('\\', "/");
    while normalized.starts_with('?') {
        normalized.remove(0);
    }
    for prefix in ["//?/", "/?/", "file:///"] {
        if let Some(stripped) = normalized.strip_prefix(prefix) {
            normalized = stripped.to_string();
            break;
        }
    }
    normalized
}

fn session_signature(song: &Song) -> String {
    let mut hasher = DefaultHasher::new();
    song.id.hash(&mut hasher);
    song.title.hash(&mut hasher);
    song.bpm.to_bits().hash(&mut hasher);
    song.time_signature.hash(&mut hasher);
    song.duration_seconds.to_bits().hash(&mut hasher);
    song.tempo_markers.len().hash(&mut hasher);
    song.time_signature_markers.len().hash(&mut hasher);
    song.tracks.len().hash(&mut hasher);
    song.clips.len().hash(&mut hasher);
    song.section_markers.len().hash(&mut hasher);
    song.regions.len().hash(&mut hasher);
    for track in &song.tracks {
        track.id.hash(&mut hasher);
        track.name.hash(&mut hasher);
        format!("{:?}", track.kind).hash(&mut hasher);
        track.parent_track_id.hash(&mut hasher);
        track.volume.to_bits().hash(&mut hasher);
        track.pan.to_bits().hash(&mut hasher);
        track.muted.hash(&mut hasher);
        track.solo.hash(&mut hasher);
        track.audio_to.hash(&mut hasher);
        track.transpose_enabled.hash(&mut hasher);
    }
    for clip in &song.clips {
        clip.id.hash(&mut hasher);
        clip.track_id.hash(&mut hasher);
        clip.file_path.hash(&mut hasher);
        clip.timeline_start_seconds.to_bits().hash(&mut hasher);
        clip.source_start_seconds.to_bits().hash(&mut hasher);
        clip.duration_seconds.to_bits().hash(&mut hasher);
        clip.gain.to_bits().hash(&mut hasher);
        clip.fade_in_seconds.map(f64::to_bits).hash(&mut hasher);
        clip.fade_out_seconds.map(f64::to_bits).hash(&mut hasher);
    }
    for marker in &song.section_markers {
        marker.id.hash(&mut hasher);
        marker.name.hash(&mut hasher);
        marker.start_seconds.to_bits().hash(&mut hasher);
    }
    for marker in &song.tempo_markers {
        marker.id.hash(&mut hasher);
        marker.start_seconds.to_bits().hash(&mut hasher);
        marker.bpm.to_bits().hash(&mut hasher);
    }
    for marker in &song.time_signature_markers {
        marker.id.hash(&mut hasher);
        marker.start_seconds.to_bits().hash(&mut hasher);
        marker.signature.hash(&mut hasher);
    }
    for region in &song.regions {
        region.id.hash(&mut hasher);
        region.name.hash(&mut hasher);
        region.start_seconds.to_bits().hash(&mut hasher);
        region.end_seconds.to_bits().hash(&mut hasher);
        region.transpose_semitones.hash(&mut hasher);
    }
    format!("{:016x}", hasher.finish())
}

fn seconds_to_frame_for_engine(engine: &Engine, seconds: f64) -> i64 {
    let sample_rate = engine
        .get_snapshot()
        .ok()
        .map(|snapshot| snapshot.device.sample_rate)
        .filter(|sample_rate| *sample_rate > 0)
        .map(f64::from)
        .unwrap_or(ENGINE_SAMPLE_RATE);
    (seconds.max(0.0) * sample_rate).round() as i64
}

fn wait_for_playback_sources(engine: &Engine) -> Result<(), DesktopError> {
    let timeout_ms = std::env::var("LIBRETRACKS_PREBUFFER_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(5_000)
        .clamp(0, 5_000);
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);

    loop {
        let snapshot = engine
            .get_snapshot()
            .map_err(|error| DesktopError::AudioCommand(error.to_string()))?;
        if snapshot.source_states.is_empty() {
            return Ok(());
        }

        let failed = snapshot
            .source_states
            .iter()
            .find(|state| state.status == "failed");
        if let Some(failed) = failed {
            let reason = if failed.error_message.trim().is_empty() {
                "decode failed".to_string()
            } else {
                failed.error_message.clone()
            };
            return Err(DesktopError::AudioCommand(format!(
                "audio source '{}' is not playable: {}",
                failed.source_id, reason
            )));
        }

        let pending = snapshot.source_states.iter().any(|state| {
            matches!(
                state.status.as_str(),
                "queued" | "loading" | "running" | "unloaded"
            )
        });
        if !pending {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use libretracks_core::{Clip, Song, Track, TrackKind};

    fn song_for_signature() -> Song {
        Song {
            id: "song".into(),
            title: "Song".into(),
            artist: None,
            key: None,
            bpm: 120.0,
            time_signature: "4/4".into(),
            duration_seconds: 10.0,
            tempo_markers: vec![],
            time_signature_markers: vec![],
            regions: vec![],
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
                audio_to: "master".into(),
            }],
            clips: vec![Clip {
                id: "clip".into(),
                track_id: "track".into(),
                file_path: "audio/test.mp3".into(),
                timeline_start_seconds: 0.0,
                source_start_seconds: 0.0,
                duration_seconds: 10.0,
                gain: 1.0,
                fade_in_seconds: None,
                fade_out_seconds: None,
            }],
            section_markers: vec![],
        }
    }

    #[test]
    fn session_signature_changes_when_bpm_changes() {
        let mut song = song_for_signature();
        let before = session_signature(&song);
        song.bpm = 96.0;
        assert_ne!(before, session_signature(&song));
    }

    #[test]
    fn session_signature_changes_when_time_signature_changes() {
        let mut song = song_for_signature();
        let before = session_signature(&song);
        song.time_signature = "6/8".into();
        assert_ne!(before, session_signature(&song));
    }

    #[test]
    fn engine_audio_path_normalization_strips_malformed_windows_verbatim_prefix() {
        assert_eq!(
            normalize_engine_audio_path("?//?/C:/Users/me/song.mp3"),
            "C:/Users/me/song.mp3"
        );
    }
}

fn estimate_position(state: &ControllerState) -> Option<f64> {
    let anchor = state.anchor_position_seconds?;
    if state.running {
        Some(anchor + state.anchor_started_at?.elapsed().as_secs_f64())
    } else {
        Some(anchor)
    }
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

fn devices_response(devices: Vec<DeviceInfo>) -> AudioOutputDevicesResponse {
    let mut names = Vec::new();
    let mut channel_counts = HashMap::new();
    let mut backends = Vec::new();
    let mut descriptors = Vec::new();

    for (index, device) in devices.into_iter().enumerate() {
        let name = if device.device_name.is_empty() {
            device.device_id.clone()
        } else {
            device.device_name.clone()
        };
        let stable_id = if device.device_id.is_empty() {
            name.clone()
        } else {
            device.device_id.clone()
        };
        names.push(name.clone());
        channel_counts.insert(name.clone(), ENGINE_V2_MAX_OUTPUT_CHANNELS);
        channel_counts.insert(stable_id.clone(), ENGINE_V2_MAX_OUTPUT_CHANNELS);
        let backend = backend_from_str(&device.backend);
        if !backends.contains(&backend) {
            backends.push(backend);
        }
        descriptors.push(AudioDeviceDescriptor {
            backend,
            backend_id: device.backend.clone(),
            stable_id,
            name: name.clone(),
            display_name: name,
            is_default: index == 0,
            max_output_channels: ENGINE_V2_MAX_OUTPUT_CHANNELS,
            default_sample_rate: (device.sample_rate > 0).then_some(device.sample_rate as u32),
            supported_sample_rates: if device.sample_rate > 0 {
                vec![device.sample_rate as u32]
            } else {
                vec![44100, 48000]
            },
            supported_buffer_sizes: if device.buffer_size > 0 {
                vec![device.buffer_size as u32]
            } else {
                vec![128, 256, 512, 1024]
            },
            supported_sample_formats: vec![AudioSampleFormat::F32],
        });
    }

    AudioOutputDevicesResponse {
        default_device: names.first().cloned(),
        devices: names,
        channel_counts,
        backends,
        device_descriptors: descriptors,
    }
}

fn backend_from_str(value: &str) -> AudioBackendKind {
    match value.to_ascii_lowercase().as_str() {
        "asio" => AudioBackendKind::Asio,
        "wasapi" | "windows audio" | "wasapi shared" | "wasapi exclusive" => {
            AudioBackendKind::Wasapi
        }
        "coreaudio" | "core_audio" | "core audio" => AudioBackendKind::CoreAudio,
        "alsa" => AudioBackendKind::Alsa,
        "jack" => AudioBackendKind::Jack,
        "directsound" | "direct_sound" | "direct sound" => AudioBackendKind::DirectSound,
        "mme" => AudioBackendKind::Mme,
        _ => AudioBackendKind::Unknown,
    }
}

impl From<lt_audio_engine_v2::EngineError> for DesktopError {
    fn from(error: lt_audio_engine_v2::EngineError) -> Self {
        DesktopError::AudioCommand(error.to_string())
    }
}

#[allow(dead_code)]
fn jump_target_marker(marker_id: String) -> (JumpTarget, JumpTrigger) {
    (
        JumpTarget {
            kind: JumpTargetKind::Marker,
            id: Some(marker_id),
            frame: None,
        },
        JumpTrigger::Immediate,
    )
}
