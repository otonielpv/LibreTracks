use std::{
    collections::{hash_map::DefaultHasher, HashMap},
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::Instant,
};

use libretracks_core::Song;
use libretracks_remote::RemoteServerHandle;
use lt_audio_engine_v2::{
    DeviceInfo, Engine, EngineCommand, EngineSnapshot, JumpTarget, JumpTargetKind, JumpTrigger,
    RegionUpdate, SourcePeaks,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::models::PitchPrepareSummary;
use crate::{error::DesktopError, settings::AppSettings};

const ENGINE_SAMPLE_RATE: f64 = 48_000.0;
const ENGINE_V2_FALLBACK_OUTPUT_CHANNELS: usize = 2;
pub(crate) const ENGINE_WAVEFORM_RESOLUTION_FRAMES: usize = 256;

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
    /// Total Category A realtime bridge commands (SetTrackGain/Pan/Mute/Solo/Route/Transpose).
    live_mix_realtime_command_count: AtomicU64,
    live_mix_ensure_live_track_count: AtomicU64,
    metronome_realtime_toggle_count: AtomicU64,
    metronome_realtime_volume_count: AtomicU64,
    /// Total commits that updated mixer state (volume/pan/muted/solo/audioTo) in the model
    /// and sent one targeted realtime command. Should match pointer-up events.
    commit_mix_command_count: AtomicU64,
    /// Total commits that updated pitch runtime (transpose_enabled, region_transpose).
    commit_pitch_command_count: AtomicU64,
    /// Total commits that updated model only (name, visual metadata) with no audio command.
    commit_model_only_count: AtomicU64,
    /// Counts `LoadSession` commands sent for structural changes.
    session_rebuild_count: AtomicU64,
    /// Human-readable reason string for the most recent `replace_song_buffers` call.
    last_session_rebuild_reason: Mutex<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RealtimeControlDiagnostics {
    /// Category A: realtime bridge commands (no model mutation, no undo, no session reload).
    pub live_mix_realtime_command_count: u64,
    pub live_mix_ensure_live_track_count: u64,
    pub metronome_realtime_toggle_count: u64,
    pub metronome_realtime_volume_count: u64,
    /// Commit: model updated + one targeted mixer command. Fires on pointer-up.
    pub commit_mix_command_count: u64,
    /// Commit: model updated + one targeted pitch command (transpose_enabled, region_transpose).
    pub commit_pitch_command_count: u64,
    /// Commit: model updated only — no audio command (name, visual metadata).
    pub commit_model_only_count: u64,
    /// Structural: `LoadSession` sent. Must not increment for any Category A or commit-only op.
    pub session_rebuild_count: u64,
    /// Reason for the most recent structural `replace_song_buffers` call.
    pub last_session_rebuild_reason: String,
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
            live_mix_realtime_command_count: AtomicU64::new(0),
            live_mix_ensure_live_track_count: AtomicU64::new(0),
            metronome_realtime_toggle_count: AtomicU64::new(0),
            metronome_realtime_volume_count: AtomicU64::new(0),
            commit_mix_command_count: AtomicU64::new(0),
            commit_pitch_command_count: AtomicU64::new(0),
            commit_model_only_count: AtomicU64::new(0),
            session_rebuild_count: AtomicU64::new(0),
            last_session_rebuild_reason: Mutex::new(String::new()),
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

    pub fn schedule_region_end_jump(
        &self,
        jump_id: &str,
        target_region_id: &str,
    ) -> Result<(), DesktopError> {
        self.with_engine_state("schedule_region_end_jump", None, |engine, _state| {
            if jump_debug_logging_enabled() {
                eprintln!(
                    "[LT_JUMP_DEBUG][rust-command] schedule_region_end jump_id={jump_id} target_region={target_region_id}"
                );
            }
            engine.send_command(&EngineCommand::CancelAllScheduledJumps)?;
            engine.send_command(&EngineCommand::ScheduleJump {
                jump_id: jump_id.to_string(),
                target: JumpTarget {
                    kind: JumpTargetKind::Region,
                    id: Some(target_region_id.to_string()),
                    frame: None,
                },
                trigger: JumpTrigger::AtRegionEnd,
                trigger_frame: None,
                suppress_seek_fade: false,
            })?;
            Ok(())
        })
    }

    pub fn schedule_jump_at_frame(
        &self,
        jump_id: &str,
        target: JumpTarget,
        trigger_seconds: f64,
        suppress_seek_fade: bool,
    ) -> Result<(), DesktopError> {
        self.with_engine_state("schedule_jump_at_frame", None, |engine, _state| {
            let trigger_frame = seconds_to_frame_for_engine(engine, trigger_seconds);
            if jump_debug_logging_enabled() {
                eprintln!(
                    "[LT_JUMP_DEBUG][rust-command] schedule_at_frame jump_id={jump_id} target_kind={:?} target_id={:?} trigger_seconds={:.9} trigger_frame={trigger_frame} suppress_seek_fade={suppress_seek_fade}",
                    target.kind,
                    target.id,
                    trigger_seconds
                );
            }
            engine.send_command(&EngineCommand::CancelAllScheduledJumps)?;
            engine.send_command(&EngineCommand::ScheduleJump {
                jump_id: jump_id.to_string(),
                target,
                trigger: JumpTrigger::AtFrame,
                trigger_frame: Some(trigger_frame),
                suppress_seek_fade,
            })?;
            Ok(())
        })
    }

    pub fn cancel_scheduled_jumps(&self) -> Result<(), DesktopError> {
        self.with_engine_state("cancel_scheduled_jumps", None, |engine, _state| {
            engine.send_command(&EngineCommand::CancelAllScheduledJumps)?;
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

    pub fn update_live_region_transpose(
        &self,
        region_id: &str,
        semitones: i32,
        // INVARIANT: `semitones` is the raw region offset from the Rust model, not effective
        // semitones. Rust never computes effective_semitones or needs_pitch.
        // C++ resolve_pitch_render_decision() is the sole authority on pitch decisions.
    ) -> Result<(), DesktopError> {
        self.with_engine_state("set_region_transpose", None, |engine, _state| {
            engine.send_command(&EngineCommand::SetRegionTranspose {
                region_id: region_id.into(),
                semitones,
            })?;
            Ok(())
        })
    }

    pub fn update_live_song_regions(&self, song: &Song) -> Result<(), DesktopError> {
        self.with_engine_state("set_song_regions", None, |engine, state| {
            let regions = song
                .regions
                .iter()
                .map(|region| RegionUpdate {
                    id: region.id.clone(),
                    name: region.name.clone(),
                    start_frame: seconds_to_frame_for_engine(engine, region.start_seconds),
                    end_frame: seconds_to_frame_for_engine(engine, region.end_seconds),
                    transpose_semitones: region.transpose_semitones,
                })
                .collect();
            engine.send_command(&EngineCommand::SetSongRegions {
                song_id: song.id.clone(),
                regions,
            })?;
            state.last_sync = Some(AudioOperationSummary {
                reason: Some("set_song_regions".into()),
                elapsed_ms: 0.0,
                scheduled_clips: song.clips.len(),
                active_sinks: song.tracks.len(),
                opened_files: 0,
            });
            Ok(())
        })
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
        self.live_mix_realtime_command_count
            .fetch_add(1, Ordering::Relaxed);
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

    pub fn set_track_transpose_enabled_realtime(
        &self,
        track_id: &str,
        enabled: bool,
    ) -> Result<(), DesktopError> {
        self.live_mix_realtime_command_count
            .fetch_add(1, Ordering::Relaxed);
        let track_id = track_id.to_owned();
        self.with_engine_state("set_track_transpose_enabled_realtime", None, |engine, _state| {
            engine.send_command(&EngineCommand::SetTrackTransposeEnabled {
                track_id: track_id.clone(),
                enabled,
            })?;
            Ok(())
        })
    }

    /// Record that a mixer commit (volume/pan/muted/solo/audioTo) was completed.
    /// Called by commit paths in state.rs after model update + targeted command.
    pub fn record_commit_mix(&self) {
        self.commit_mix_command_count.fetch_add(1, Ordering::Relaxed);
    }

    /// Record that a pitch commit (transpose_enabled, region_transpose) was completed.
    pub fn record_commit_pitch(&self) {
        self.commit_pitch_command_count.fetch_add(1, Ordering::Relaxed);
    }

    /// Record that a model-only commit (name, visual metadata) was completed.
    pub fn record_commit_model_only(&self) {
        self.commit_model_only_count.fetch_add(1, Ordering::Relaxed);
    }

    pub fn set_metronome_enabled_realtime(&self, enabled: bool) -> Result<(), DesktopError> {
        self.metronome_realtime_toggle_count
            .fetch_add(1, Ordering::Relaxed);
        self.with_engine_state("set_metronome_enabled_realtime", None, |engine, _state| {
            engine.send_command(&EngineCommand::SetMetronomeEnabled { enabled })?;
            Ok(())
        })
    }

    pub fn set_metronome_volume_realtime(&self, volume: f64) -> Result<(), DesktopError> {
        self.metronome_realtime_volume_count
            .fetch_add(1, Ordering::Relaxed);
        self.with_engine_state("set_metronome_volume_realtime", None, |engine, _state| {
            engine.send_command(&EngineCommand::SetMetronomeVolume {
                volume: volume.clamp(0.0, 1.0) as f32,
            })?;
            Ok(())
        })
    }

    pub fn realtime_control_diagnostics(&self) -> RealtimeControlDiagnostics {
        RealtimeControlDiagnostics {
            live_mix_realtime_command_count: self
                .live_mix_realtime_command_count
                .load(Ordering::Relaxed),
            live_mix_ensure_live_track_count: self
                .live_mix_ensure_live_track_count
                .load(Ordering::Relaxed),
            metronome_realtime_toggle_count: self
                .metronome_realtime_toggle_count
                .load(Ordering::Relaxed),
            metronome_realtime_volume_count: self
                .metronome_realtime_volume_count
                .load(Ordering::Relaxed),
            commit_mix_command_count: self.commit_mix_command_count.load(Ordering::Relaxed),
            commit_pitch_command_count: self.commit_pitch_command_count.load(Ordering::Relaxed),
            commit_model_only_count: self.commit_model_only_count.load(Ordering::Relaxed),
            session_rebuild_count: self.session_rebuild_count.load(Ordering::Relaxed),
            last_session_rebuild_reason: self
                .last_session_rebuild_reason
                .lock()
                .map(|r| r.clone())
                .unwrap_or_default(),
        }
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
        mut settings: AppSettings,
        _rebuild_stream: bool,
    ) -> Result<(), DesktopError> {
        self.with_engine_state("apply_settings", None, |engine, state| {
            // Device-open errors must NOT abort apply_settings: the saved
            // device may have been unplugged (Razer/USB), renamed, or
            // disabled since last launch. Treating that as fatal kept the
            // whole app from starting. Log + clear the stale device fields
            // + fall back to the system default device. Subsequent settings
            // (sample rate / buffer / metronome) MUST still apply.
            if let Some(device_id) = settings
                .selected_output_device_id
                .clone()
                .or_else(|| settings.selected_output_device.clone())
            {
                if let Err(error) = engine.send_command(&EngineCommand::SetOutputDevice {
                    device_id: device_id.clone(),
                }) {
                    if audio_debug_logging_enabled() {
                        eprintln!(
                            "[libretracks-audio] saved output device '{device_id}' \
                             failed to open ({error}); falling back to system default \
                             and clearing the saved selection so subsequent launches \
                             don't re-hit this error."
                        );
                    }
                    settings.selected_output_device = None;
                    settings.selected_output_device_id = None;
                    settings.selected_output_device_name = None;
                    if let Err(fallback_error) = engine.send_command(&EngineCommand::SetOutputDevice {
                        device_id: String::new(),
                    }) {
                        if audio_debug_logging_enabled() {
                            eprintln!(
                                "[libretracks-audio] fallback output device failed to open after \
                                 rejecting '{device_id}' ({fallback_error})."
                            );
                        }
                    }
                }
            }
            // Sample rate / buffer size are also best-effort — bad combos
            // shouldn't kill startup either.
            if let Some(sample_rate) = settings.output_sample_rate {
                if let Err(error) = engine.send_command(&EngineCommand::SetSampleRate {
                    sample_rate: sample_rate as i32,
                }) {
                    if audio_debug_logging_enabled() {
                        eprintln!(
                            "[libretracks-audio] sample rate {sample_rate} \
                             rejected ({error}); using device default."
                        );
                    }
                    settings.output_sample_rate = None;
                }
            }
            if let AudioBufferSizeRequest::Fixed(buffer_size) = settings.output_buffer_size {
                if let Err(error) = engine.send_command(&EngineCommand::SetBufferSize {
                    buffer_size: buffer_size as i32,
                }) {
                    if audio_debug_logging_enabled() {
                        eprintln!(
                            "[libretracks-audio] buffer size {buffer_size} \
                             rejected ({error}); using device default."
                        );
                    }
                    settings.output_buffer_size = AudioBufferSizeRequest::Default;
                }
            }
            // Metronome config is a pure state setter; if THIS fails it's a
            // genuine engine bug, so we DO propagate.
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

    pub fn engine_snapshot(&self) -> Result<EngineSnapshot, DesktopError> {
        let mut state = match self.state.try_lock() {
            Ok(guard) => guard,
            Err(_) => return Err(DesktopError::AudioCommand("engine_snapshot: state locked".into())),
        };
        ensure_engine(&mut state)?
            .get_snapshot()
            .map_err(|e| DesktopError::AudioCommand(e.to_string()))
    }

    pub fn source_peaks(
        &self,
        song_dir: &Path,
        waveform_key: &str,
    ) -> Result<SourcePeaks, DesktopError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| DesktopError::AudioCommand("audio v2 state lock poisoned".into()))?;
        state.song_dir = Some(song_dir.to_path_buf());
        let source_id = resolve_engine_source_id(song_dir, waveform_key);
        ensure_engine(&mut state)?
            .source_peaks(&source_id, ENGINE_WAVEFORM_RESOLUTION_FRAMES)
            .map_err(|error| DesktopError::AudioCommand(error.to_string()))
    }

    pub fn debug_snapshot(&self) -> Result<AudioDebugSnapshot, DesktopError> {
        let mut state = match self.state.try_lock() {
            Ok(guard) => guard,
            Err(std::sync::TryLockError::WouldBlock) => {
                return Err(DesktopError::AudioCommand("debug_snapshot: state locked".into()))
            }
            Err(std::sync::TryLockError::Poisoned(_)) => {
                return Err(DesktopError::AudioCommand("audio v2 state lock poisoned".into()))
            }
        };
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

    pub fn pitch_prepare_summary(&self) -> PitchPrepareSummary {
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(_) => return PitchPrepareSummary::default(),
        };
        let Ok(snapshot) = ensure_engine(&mut state).and_then(|engine| {
            engine
                .get_snapshot()
                .map_err(|error| DesktopError::AudioCommand(error.to_string()))
        }) else {
            return PitchPrepareSummary::default();
        };
        let pitch = snapshot.pitch;
        PitchPrepareSummary {
            pitch_prepare_active: pitch.pitch_prepare_active,
            pitch_prepare_pending: pitch.pitch_prepare_pending,
            pitch_prepare_progress: pitch.pitch_prepare_progress,
            pitch_proxy_blocks_ready: pitch.pitch_proxy_blocks_ready,
            pitch_proxy_blocks_missing: pitch.pitch_proxy_blocks_missing,
            pitch_proxy_blocks_pending: pitch.pitch_proxy_blocks_pending,
            pitch_jobs_pending: pitch.pitch_jobs_pending,
            pitch_jobs_running: pitch.pitch_jobs_running,
            pitch_jobs_completed: pitch.pitch_jobs_completed,
            pitch_jobs_failed: pitch.pitch_jobs_failed,
            pitch_prepare_status: pitch.pitch_prepare_status,
            pitch_prepare_message: pitch.pitch_prepare_message,
            active_pitch_render_path: pitch.active_pitch_render_path,
            last_pitch_prepare_reason: pitch.last_pitch_prepare_reason,
            last_pitch_proxy_error: pitch.last_pitch_proxy_error,
            last_missing_proxy_key: pitch.last_missing_proxy_key,
            last_missing_proxy_block_index: pitch.last_missing_proxy_block_index,
        }
    }

    pub fn replace_song_buffers(
        &self,
        song_dir: &Path,
        song: &Song,
        reason: &str,
    ) -> Result<(), DesktopError> {
        self.session_rebuild_count.fetch_add(1, Ordering::Relaxed);
        if let Ok(mut r) = self.last_session_rebuild_reason.lock() {
            *r = reason.to_owned();
        }
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
        // Use try_lock so the meter thread never blocks command dispatch. If a
        // command holds the lock, we simply return empty levels for this 33ms poll cycle.
        let mut state = match self.state.try_lock() {
            Ok(guard) => guard,
            Err(std::sync::TryLockError::WouldBlock) => return Ok(vec![]),
            Err(std::sync::TryLockError::Poisoned(_)) => {
                return Err(DesktopError::AudioCommand(
                    "audio v2 state lock poisoned".into(),
                ))
            }
        };
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
        let should_service_control = !matches!(
            kind,
            "play"
                | "seek"
                | "stop"
                | "update_live_track_mix"
                | "set_track_transpose_enabled_realtime"
                | "set_region_transpose"
                | "set_metronome_enabled_realtime"
                | "set_metronome_volume_realtime"
        );
        if should_service_control {
            engine.service_control_thread();
        }
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

pub fn jump_debug_logging_enabled() -> bool {
    audio_debug_logging_enabled()
        || std::env::var("LIBRETRACKS_JUMP_DEBUG")
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

fn resolve_engine_source_id(song_dir: &Path, file_path: &str) -> String {
    let normalized = normalize_engine_audio_path(file_path);
    let raw_path = normalized.trim();
    if raw_path.is_empty() {
        return String::new();
    }
    let path = Path::new(raw_path);
    if path.is_relative() {
        song_dir.join(path).to_string_lossy().replace('\\', "/")
    } else {
        raw_path.replace('\\', "/")
    }
}

fn normalize_engine_audio_path(path: &str) -> String {
    let mut normalized = path
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .replace('\\', "/");
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
    for track in &song.tracks {
        track.id.hash(&mut hasher);
        track.name.hash(&mut hasher);
        format!("{:?}", track.kind).hash(&mut hasher);
        track.parent_track_id.hash(&mut hasher);
        // volume/pan/muted/solo/audio_to/transpose_enabled are sent via
        // SetTrack* realtime commands and must NOT change the signature.
        // Including them causes ensure_song_loaded to re-fire LoadSession
        // on the next seek/play, which tears down all 9 Bungee voices and
        // rebuilds them serially (~600ms each = 5s freeze). The realtime
        // command path already keeps the C++ engine state in sync, so
        // skipping LoadSession here is safe and correct.
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
        let output_channels = if device.output_channel_count > 0 {
            device.output_channel_count as usize
        } else {
            ENGINE_V2_FALLBACK_OUTPUT_CHANNELS
        };
        channel_counts.insert(name.clone(), output_channels);
        channel_counts.insert(stable_id.clone(), output_channels);
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
            max_output_channels: output_channels,
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
        // JUCE 6+ on Windows exposes three WASAPI typenames depending on the
        // shared/exclusive/low-latency mode it was opened in. All three are
        // the same backend from the user's point of view.
        "wasapi"
        | "windows audio"
        | "wasapi shared"
        | "wasapi exclusive"
        | "windows audio (low latency mode)"
        | "windows audio (exclusive mode)" => AudioBackendKind::Wasapi,
        "coreaudio" | "core_audio" | "core audio" => AudioBackendKind::CoreAudio,
        "alsa" => AudioBackendKind::Alsa,
        "jack" => AudioBackendKind::Jack,
        "directsound" | "direct_sound" | "direct sound" => AudioBackendKind::DirectSound,
        "mme" => AudioBackendKind::Mme,
        other => {
            // Surface unknown backend typenames so we can extend the match
            // arms above instead of silently hiding the backend behind
            // "Unknown" in the UI dropdown. Logged only the first time per
            // value via a static dedup set is overkill; this fires once per
            // device-list refresh which is rare.
            eprintln!(
                "[audio] backend_from_str: unknown JUCE typename {:?}, mapping to Unknown",
                other
            );
            AudioBackendKind::Unknown
        }
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
