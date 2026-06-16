use std::{
    collections::{hash_map::DefaultHasher, HashMap},
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use libretracks_core::{
    audible_clip_duration_seconds, effective_bpm_at, warp_timeline_seconds_at, Song, TempoMarker,
    TrackKind,
};
use libretracks_remote::RemoteServerHandle;
use lt_audio_engine_v2::{
    ClipUpdate, DeviceInfo, Engine, EngineCommand, EngineError, EngineSnapshot, JumpTarget,
    JumpTargetKind, JumpTrigger, MarkerUpdate, RegionUpdate, SourceRef, TempoMarkerUpdate,
    TimeSignatureMarkerUpdate, TrackClipUpdate, TrackUpsert,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::models::{PitchPrepareSummary, SourceReadinessSummary};
use crate::{error::DesktopError, settings::AppSettings};

const ENGINE_SAMPLE_RATE: f64 = 48_000.0;
const ENGINE_V2_FALLBACK_OUTPUT_CHANNELS: usize = 2;
const METRONOME_OUTPUT_GAIN: f64 = 2.5;
pub(crate) const ENGINE_WAVEFORM_RESOLUTION_FRAMES: usize = 256;

fn metronome_engine_volume(settings_volume: f64) -> f32 {
    (settings_volume.clamp(0.0, 1.0) * METRONOME_OUTPUT_GAIN) as f32
}

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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegionMeterLevel {
    pub region_id: String,
    pub peak: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PlaybackStartReason {
    InitialPlay,
    ResumePlay,
    Seek,
    ImmediateJump,
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
    remote_handle: Mutex<Option<RemoteServerHandle>>,
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
    /// Total tempo/time-signature session updates sent without reloading sources.
    transport_timing_update_count: AtomicU64,
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
    /// Transport timing: model updated + one targeted session timing command.
    pub transport_timing_update_count: u64,
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
            remote_handle: Mutex::new(None),
            meter_thread_started: AtomicBool::new(false),
            meter_thread_stop: Arc::new(AtomicBool::new(false)),
            meter_thread: Mutex::new(None),
            live_mix_realtime_command_count: AtomicU64::new(0),
            live_mix_ensure_live_track_count: AtomicU64::new(0),
            metronome_realtime_toggle_count: AtomicU64::new(0),
            metronome_realtime_volume_count: AtomicU64::new(0),
            commit_mix_command_count: AtomicU64::new(0),
            commit_pitch_command_count: AtomicU64::new(0),
            transport_timing_update_count: AtomicU64::new(0),
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
                        let _ = app_handle.emit("audio:meters", &levels);
                        if let Ok(remote_handle) = controller.remote_handle.lock() {
                            if let Some(remote_handle) = remote_handle.as_ref() {
                                remote_handle.publish_meters(&levels);
                            }
                        }
                    }
                }
                if let Ok(region_levels) = controller.current_region_meter_levels() {
                    if !region_levels.is_empty() {
                        let _ = app_handle.emit("audio:region_meters", &region_levels);
                    }
                }
                thread::sleep(std::time::Duration::from_millis(33));
            }
        });
        if let Ok(mut thread_slot) = self.meter_thread.lock() {
            *thread_slot = Some(handle);
        }
    }

    pub fn attach_remote_handle(&self, remote_handle: RemoteServerHandle) {
        if let Ok(mut slot) = self.remote_handle.lock() {
            *slot = Some(remote_handle);
        }
    }

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
        // Phase 1 — load the session under the lock. This kicks off the C++
        // engine's background decode of every source; we do NOT wait for it.
        self.with_engine_state("play", Some(reason), |engine, state| {
            // song_dir must be set before ensure_song_loaded: it resolves clip
            // paths relative to it (song_with_resolved_audio_paths).
            state.song_dir = Some(song_dir);
            ensure_song_loaded(engine, state, &song)
        })?;

        // No wait for sources: playback starts immediately. The mixer renders
        // silence for any track whose source is still decoding (the track
        // renderer skips clips when `!src->is_loaded()`), and the source
        // manager publishes each source atomically the moment it finishes, so
        // an unready clip starts producing sound mid-playback on the next render
        // block — no restart needed. This keeps already-ready sources from being
        // held hostage by one slow new source (e.g. an MP3 on a slow disk).

        // Phase 2 — start playback and update bookkeeping under the lock.
        self.with_engine_state("play", Some(reason), |engine, state| {
            if !state.running {
                engine.send_command(&EngineCommand::SeekAbsolute {
                    frame: seconds_to_frame_for_engine(engine, position_seconds),
                })?;
                engine.send_command(&EngineCommand::Play)?;
            }
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

    pub fn wait_until_sources_ready(&self, timeout: Duration) -> Result<(), DesktopError> {
        // Lock-releasing wait: never holds self.state for the whole timeout, so
        // the 120s import wait can't starve engine_snapshot() / the UI.
        self.wait_sources_ready_unlocked(timeout, true)
    }

    pub fn prepare_playback_at(
        &self,
        song: Song,
        position_seconds: f64,
    ) -> Result<(), DesktopError> {
        // Phase 1 — load under the lock.
        self.with_engine_state("prepare_playback_at", None, |engine, state| {
            ensure_song_loaded(engine, state, &song)
        })?;

        // Phase 2 — wait without holding the lock continuously.
        self.wait_sources_ready_unlocked(playback_prepare_wait_timeout(), true)?;

        // Phase 3 — seek + bookkeeping under the lock.
        self.with_engine_state("prepare_playback_at", None, |engine, state| {
            engine.send_command(&EngineCommand::SeekAbsolute {
                frame: seconds_to_frame_for_engine(engine, position_seconds),
            })?;
            state.anchor_position_seconds = Some(position_seconds.max(0.0));
            state.anchor_started_at = None;
            state.song_duration_seconds = Some(song.duration_seconds);
            Ok(())
        })
    }

    /// Poll the engine until all sources report ready (or `timeout` elapses),
    /// RELEASING `self.state` between polls.
    ///
    /// The engine is `Send` but not `Sync`, so it must only be touched while the
    /// lock is held — we re-acquire the lock for each `get_snapshot()` and drop
    /// it again before sleeping. This keeps engine access serialized while
    /// letting other threads (project load/save's `engine_snapshot()`, the meter
    /// thread, the snapshot poll) interleave during the 20ms sleeps. Holding the
    /// lock for the whole wait — as the old in-closure wait did — froze the UI
    /// and made those callers fail with "engine_snapshot: state locked" whenever
    /// a source (e.g. an MP3 on a slow disk) took a while to build its cache.
    ///
    /// `service` mirrors `with_engine_state`'s control-thread gating: `play`
    /// passes `false` (it's on the no-service list), the others pass `true`.
    /// Timeout is treated as success (best-effort), matching the prior behavior.
    fn wait_sources_ready_unlocked(
        &self,
        timeout: Duration,
        service: bool,
    ) -> Result<(), DesktopError> {
        let started_at = Instant::now();
        loop {
            let ready = {
                let mut state = self.state.lock().map_err(|_| {
                    DesktopError::AudioCommand("audio v2 state lock poisoned".into())
                })?;
                // No engine means nothing has been loaded yet -> nothing to wait
                // for. Don't lazily create it here; the wait is a poll, not an
                // initializer (load happens under with_engine_state).
                let Some(engine) = state.engine.take() else {
                    return Ok(());
                };
                if service {
                    engine.service_control_thread();
                }
                let snapshot_result = engine.get_snapshot();
                // Always restore the engine before the guard drops, even on error.
                state.engine = Some(engine);
                match snapshot_result {
                    Ok(snapshot) => sources_ready(&snapshot),
                    Err(error) => {
                        return Err(DesktopError::AudioCommand(error.to_string()))
                    }
                }
                // `state` guard drops here -> lock released before the sleep.
            };
            if ready || started_at.elapsed() >= timeout {
                return Ok(());
            }
            thread::sleep(Duration::from_millis(20));
        }
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
        suppress_seek_fade: bool,
    ) -> Result<(), DesktopError> {
        self.with_engine_state("schedule_region_end_jump", None, |engine, _state| {
            if jump_debug_logging_enabled() {
                eprintln!(
                    "[LT_JUMP_DEBUG][rust-command] schedule_region_end jump_id={jump_id} target_region={target_region_id} suppress_seek_fade={suppress_seek_fade}"
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
                suppress_seek_fade,
            })?;
            Ok(())
        })
    }

    pub fn schedule_jump_at_frame(
        &self,
        jump_id: &str,
        mut target: JumpTarget,
        trigger_seconds: f64,
        target_seconds: Option<f64>,
        suppress_seek_fade: bool,
    ) -> Result<(), DesktopError> {
        self.with_engine_state("schedule_jump_at_frame", None, |engine, _state| {
            let trigger_frame = seconds_to_frame_for_engine(engine, trigger_seconds);
            if target.frame.is_none() {
                target.frame =
                    target_seconds.map(|seconds| seconds_to_frame_for_engine(engine, seconds));
            }
            if jump_debug_logging_enabled() {
                eprintln!(
                    "[LT_JUMP_DEBUG][rust-command] schedule_at_frame jump_id={jump_id} target_kind={:?} target_id={:?} target_frame={:?} trigger_seconds={:.9} trigger_frame={trigger_frame} suppress_seek_fade={suppress_seek_fade}",
                    target.kind,
                    target.id,
                    target.frame,
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

    pub fn update_live_region_warp(
        &self,
        region_id: &str,
        warp_enabled: bool,
        warp_source_bpm: Option<f64>,
    ) -> Result<(), DesktopError> {
        self.with_engine_state("set_region_warp", None, |engine, _state| {
            engine.send_command(&EngineCommand::SetRegionWarp {
                region_id: region_id.into(),
                warp_enabled,
                // 0.0 is the "no warp" sentinel C++ interprets defensively.
                warp_source_bpm: warp_source_bpm.unwrap_or(0.0),
            })?;
            Ok(())
        })
    }

    pub fn update_live_region_master_gain(
        &self,
        region_id: &str,
        master_gain: f32,
    ) -> Result<(), DesktopError> {
        self.with_engine_state("set_region_master_gain", None, |engine, _state| {
            engine.send_command(&EngineCommand::SetRegionMasterGain {
                region_id: region_id.into(),
                master_gain,
            })?;
            Ok(())
        })
    }

    pub fn update_live_song_regions(&self, song: &Song) -> Result<(), DesktopError> {
        self.with_engine_state("set_song_regions", None, |engine, state| {
            let runtime_song = song_with_warped_timeline(song);
            let regions = song
                .regions
                .iter()
                .zip(runtime_song.regions.iter())
                .map(|region| RegionUpdate {
                    id: region.0.id.clone(),
                    name: region.0.name.clone(),
                    start_frame: seconds_to_frame_for_engine(engine, region.1.start_seconds),
                    end_frame: seconds_to_frame_for_engine(engine, region.1.end_seconds),
                    transpose_semitones: region.0.transpose_semitones,
                    warp_enabled: region.0.warp_enabled,
                    warp_source_bpm: region.0.warp_source_bpm.unwrap_or(0.0),
                    master_gain: region.0.master.gain as f32,
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

    pub fn update_live_song_clips(&self, song: &Song) -> Result<(), DesktopError> {
        self.with_engine_state("set_song_clips", None, |engine, state| {
            let resolved_song = song_with_resolved_audio_paths(state.song_dir.as_deref(), song);
            let runtime_song = song_with_warped_timeline(&resolved_song);
            let clips = runtime_song
                .clips
                .iter()
                .map(|clip| ClipUpdate {
                    id: clip.id.clone(),
                    track_id: clip.track_id.clone(),
                    source_id: clip.file_path.clone(),
                    timeline_start_frame: seconds_to_frame_for_engine(
                        engine,
                        clip.timeline_start_seconds,
                    ),
                    source_start_frame: seconds_to_frame_for_engine(
                        engine,
                        clip.source_start_seconds,
                    ),
                    length_frames: seconds_to_frame_for_engine(engine, clip.duration_seconds),
                    gain: clip.gain as f32,
                    fade_in_frames: seconds_to_frame_for_engine(
                        engine,
                        clip.fade_in_seconds.unwrap_or(0.0),
                    ),
                    fade_out_frames: seconds_to_frame_for_engine(
                        engine,
                        clip.fade_out_seconds.unwrap_or(0.0),
                    ),
                    semitones: 0,
                })
                .collect();
            engine.send_command(&EngineCommand::SetSongClips {
                song_id: song.id.clone(),
                clips,
            })?;
            state.last_sync = Some(AudioOperationSummary {
                reason: Some("set_song_clips".into()),
                elapsed_ms: 0.0,
                scheduled_clips: song.clips.len(),
                active_sinks: song.tracks.len(),
                opened_files: 0,
            });
            Ok(())
        })
    }

    pub fn update_live_section_markers(&self, song: &Song) -> Result<(), DesktopError> {
        self.with_engine_state("set_song_markers", None, |engine, state| {
            let runtime_song = song_with_warped_timeline(song);
            let markers = song
                .section_markers
                .iter()
                .zip(runtime_song.section_markers.iter())
                .map(|marker| MarkerUpdate {
                    id: marker.0.id.clone(),
                    name: marker.0.name.clone(),
                    frame: seconds_to_frame_for_engine(engine, marker.1.start_seconds),
                    kind: marker.0.kind.as_token().to_string(),
                    variant: marker.0.variant.unwrap_or(0) as i32,
                })
                .collect();
            engine.send_command(&EngineCommand::SetSongMarkers {
                song_id: song.id.clone(),
                markers,
            })?;
            state.last_sync = Some(AudioOperationSummary {
                reason: Some("set_song_markers".into()),
                elapsed_ms: 0.0,
                scheduled_clips: song.clips.len(),
                active_sinks: song.tracks.len(),
                opened_files: 0,
            });
            Ok(())
        })
    }

    pub fn update_live_timeline_window(&self, song: &Song) -> Result<(), DesktopError> {
        self.transport_timing_update_count
            .fetch_add(1, Ordering::Relaxed);
        self.with_engine_state("set_song_timeline_window", None, |engine, state| {
            let resolved_song = song_with_resolved_audio_paths(state.song_dir.as_deref(), song);
            let runtime_song = song_with_warped_timeline(&resolved_song);
            let clips = runtime_song
                .clips
                .iter()
                .map(|clip| ClipUpdate {
                    id: clip.id.clone(),
                    track_id: clip.track_id.clone(),
                    source_id: clip.file_path.clone(),
                    timeline_start_frame: seconds_to_frame_for_engine(
                        engine,
                        clip.timeline_start_seconds,
                    ),
                    source_start_frame: seconds_to_frame_for_engine(
                        engine,
                        clip.source_start_seconds,
                    ),
                    length_frames: seconds_to_frame_for_engine(engine, clip.duration_seconds),
                    gain: clip.gain as f32,
                    fade_in_frames: seconds_to_frame_for_engine(
                        engine,
                        clip.fade_in_seconds.unwrap_or(0.0),
                    ),
                    fade_out_frames: seconds_to_frame_for_engine(
                        engine,
                        clip.fade_out_seconds.unwrap_or(0.0),
                    ),
                    semitones: 0,
                })
                .collect();
            let regions = song
                .regions
                .iter()
                .zip(runtime_song.regions.iter())
                .map(|region| RegionUpdate {
                    id: region.0.id.clone(),
                    name: region.0.name.clone(),
                    start_frame: seconds_to_frame_for_engine(engine, region.1.start_seconds),
                    end_frame: seconds_to_frame_for_engine(engine, region.1.end_seconds),
                    transpose_semitones: region.0.transpose_semitones,
                    warp_enabled: region.0.warp_enabled,
                    warp_source_bpm: region.0.warp_source_bpm.unwrap_or(0.0),
                    master_gain: region.0.master.gain as f32,
                })
                .collect();
            let markers = song
                .section_markers
                .iter()
                .zip(runtime_song.section_markers.iter())
                .map(|marker| MarkerUpdate {
                    id: marker.0.id.clone(),
                    name: marker.0.name.clone(),
                    frame: seconds_to_frame_for_engine(engine, marker.1.start_seconds),
                    kind: marker.0.kind.as_token().to_string(),
                    variant: marker.0.variant.unwrap_or(0) as i32,
                })
                .collect();
            let (beats_per_bar, beat_unit) = parse_engine_time_signature(&song.time_signature)?;
            let tempo_markers = runtime_song
                .tempo_markers
                .iter()
                .map(|marker| TempoMarkerUpdate {
                    id: marker.id.clone(),
                    frame: seconds_to_frame_for_engine(engine, marker.start_seconds),
                    bpm: marker.bpm,
                })
                .collect();
            let time_signature_markers = song
                .time_signature_markers
                .iter()
                .zip(runtime_song.time_signature_markers.iter())
                .map(|marker| {
                    let (beats_per_bar, beat_unit) =
                        parse_engine_time_signature(&marker.0.signature)?;
                    Ok(TimeSignatureMarkerUpdate {
                        id: marker.0.id.clone(),
                        frame: seconds_to_frame_for_engine(engine, marker.1.start_seconds),
                        beats_per_bar,
                        beat_unit,
                    })
                })
                .collect::<Result<Vec<_>, DesktopError>>()?;
            engine.send_command(&EngineCommand::SetSongTimelineWindow {
                song_id: song.id.clone(),
                clips,
                regions,
                markers,
                bpm: song.bpm,
                beats_per_bar,
                beat_unit,
                tempo_markers,
                time_signature_markers,
            })?;
            if state.loaded_session_signature.is_some() {
                let resolved = song_with_resolved_audio_paths(state.song_dir.as_deref(), song);
                state.loaded_session_signature = Some(session_signature(&resolved));
            }
            state.last_sync = Some(AudioOperationSummary {
                reason: Some("set_song_timeline_window".into()),
                elapsed_ms: 0.0,
                scheduled_clips: song.clips.len(),
                active_sinks: song.tracks.len(),
                opened_files: 0,
            });
            Ok(())
        })
    }

    /// Incremental structural update (add/remove/move tracks & clips, import
    /// audio) WITHOUT a full LoadSession. Sends `CmdUpsertSongTracks` so the
    /// engine mutates the live session in place and registers only NEW sources,
    /// preserving already-decoded ones — so it can run mid-playback without
    /// stalling the audio thread. See
    /// docs/HANDOFF_import_while_playing_glitches.md.
    pub fn upsert_song_tracks(&self, song: &Song) -> Result<(), DesktopError> {
        self.transport_timing_update_count
            .fetch_add(1, Ordering::Relaxed);
        self.with_engine_state("upsert_song_tracks", None, |engine, state| {
            let resolved_song = song_with_resolved_audio_paths(state.song_dir.as_deref(), song);
            let runtime_song = song_with_warped_timeline(&resolved_song);

            // Group the warped clips by their owning track so each TrackUpsert
            // carries its own clips (the engine command nests clips per track).
            let mut clips_by_track: std::collections::HashMap<String, Vec<TrackClipUpdate>> =
                std::collections::HashMap::new();
            // Distinct source files referenced by the clips, for registration.
            let mut sources: Vec<SourceRef> = Vec::new();
            let mut seen_sources: std::collections::HashSet<String> =
                std::collections::HashSet::new();
            for clip in &runtime_song.clips {
                if seen_sources.insert(clip.file_path.clone()) {
                    sources.push(SourceRef {
                        id: clip.file_path.clone(),
                        file_path: clip.file_path.clone(),
                    });
                }
                clips_by_track
                    .entry(clip.track_id.clone())
                    .or_default()
                    .push(TrackClipUpdate {
                        id: clip.id.clone(),
                        source_id: clip.file_path.clone(),
                        timeline_start_frame: seconds_to_frame_for_engine(
                            engine,
                            clip.timeline_start_seconds,
                        ),
                        source_start_frame: seconds_to_frame_for_engine(
                            engine,
                            clip.source_start_seconds,
                        ),
                        length_frames: seconds_to_frame_for_engine(engine, clip.duration_seconds),
                        gain: clip.gain as f32,
                        fade_in_frames: seconds_to_frame_for_engine(
                            engine,
                            clip.fade_in_seconds.unwrap_or(0.0),
                        ),
                        fade_out_frames: seconds_to_frame_for_engine(
                            engine,
                            clip.fade_out_seconds.unwrap_or(0.0),
                        ),
                        semitones: 0,
                    });
            }

            let tracks = resolved_song
                .tracks
                .iter()
                .map(|track| TrackUpsert {
                    id: track.id.clone(),
                    name: track.name.clone(),
                    gain: track.volume as f32,
                    pan: track.pan as f32,
                    audio_to: track.audio_to.clone(),
                    mute: track.muted,
                    solo: track.solo,
                    // transpose_enabled=false maps to NeverTranspose; default
                    // (true) leaves the engine's FollowsSongOrRegion behaviour.
                    transpose_behavior: if track.transpose_enabled {
                        String::new()
                    } else {
                        "never_transpose".to_string()
                    },
                    role: String::new(),
                    kind: match track.kind {
                        TrackKind::Folder => "folder".to_string(),
                        TrackKind::Audio => "audio".to_string(),
                    },
                    parent_track_id: track.parent_track_id.clone().unwrap_or_default(),
                    clips: clips_by_track.remove(&track.id).unwrap_or_default(),
                })
                .collect();

            engine.send_command(&EngineCommand::UpsertSongTracks {
                song_id: song.id.clone(),
                tracks,
                sources,
            })?;

            if state.loaded_session_signature.is_some() {
                state.loaded_session_signature = Some(session_signature(&resolved_song));
            }
            state.last_sync = Some(AudioOperationSummary {
                reason: Some("upsert_song_tracks".into()),
                elapsed_ms: 0.0,
                scheduled_clips: song.clips.len(),
                active_sinks: song.tracks.len(),
                opened_files: 0,
            });
            Ok(())
        })
    }

    pub fn update_live_song_timing(&self, song: &Song) -> Result<(), DesktopError> {
        self.transport_timing_update_count
            .fetch_add(1, Ordering::Relaxed);
        self.with_engine_state("set_song_timing", None, |engine, state| {
            let runtime_song = song_with_warped_timeline(song);
            let (beats_per_bar, beat_unit) = parse_engine_time_signature(&song.time_signature)?;
            let tempo_markers = runtime_song
                .tempo_markers
                .iter()
                .map(|marker| TempoMarkerUpdate {
                    id: marker.id.clone(),
                    frame: seconds_to_frame_for_engine(engine, marker.start_seconds),
                    bpm: marker.bpm,
                })
                .collect();
            let time_signature_markers = song
                .time_signature_markers
                .iter()
                .zip(runtime_song.time_signature_markers.iter())
                .map(|marker| {
                    let (beats_per_bar, beat_unit) =
                        parse_engine_time_signature(&marker.0.signature)?;
                    Ok(TimeSignatureMarkerUpdate {
                        id: marker.0.id.clone(),
                        frame: seconds_to_frame_for_engine(engine, marker.1.start_seconds),
                        beats_per_bar,
                        beat_unit,
                    })
                })
                .collect::<Result<Vec<_>, DesktopError>>()?;
            engine.send_command(&EngineCommand::SetSongTiming {
                song_id: song.id.clone(),
                bpm: song.bpm,
                beats_per_bar,
                beat_unit,
                tempo_markers,
                time_signature_markers,
            })?;
            if state.loaded_session_signature.is_some() {
                let resolved = song_with_resolved_audio_paths(state.song_dir.as_deref(), song);
                state.loaded_session_signature = Some(session_signature(&resolved));
            }
            state.last_sync = Some(AudioOperationSummary {
                reason: Some("set_song_timing".into()),
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
        self.with_engine_state(
            "set_track_transpose_enabled_realtime",
            None,
            |engine, _state| {
                engine.send_command(&EngineCommand::SetTrackTransposeEnabled {
                    track_id: track_id.clone(),
                    enabled,
                })?;
                Ok(())
            },
        )
    }

    /// Record that a mixer commit (volume/pan/muted/solo/audioTo) was completed.
    /// Called by commit paths in state.rs after model update + targeted command.
    pub fn record_commit_mix(&self) {
        self.commit_mix_command_count
            .fetch_add(1, Ordering::Relaxed);
    }

    /// Record that a pitch commit (transpose_enabled, region_transpose) was completed.
    pub fn record_commit_pitch(&self) {
        self.commit_pitch_command_count
            .fetch_add(1, Ordering::Relaxed);
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
                volume: metronome_engine_volume(volume),
            })?;
            Ok(())
        })
    }

    /// Push the full metronome sound config (presets, pitch, subdivision) to the
    /// engine without reopening the audio device, so changing the click sound
    /// never interrupts playback. Mirrors the realtime enabled/volume path.
    pub fn set_metronome_sound_realtime(&self, settings: &AppSettings) -> Result<(), DesktopError> {
        self.with_engine_state("set_metronome_sound_realtime", None, |engine, _state| {
            engine.send_command(&EngineCommand::SetMetronomeConfig {
                enabled: settings.metronome_enabled,
                volume: metronome_engine_volume(settings.metronome_volume),
                route: settings.metronome_output.clone(),
                accent_enabled: settings.metronome_accent_enabled,
                accent_preset: settings.metronome_accent_preset,
                beat_preset: settings.metronome_beat_preset,
                accent_pitch: settings.metronome_accent_pitch,
                beat_pitch: settings.metronome_beat_pitch,
                subdivision: settings.metronome_subdivision,
                subdivision_preset: settings.metronome_subdivision_preset,
                subdivision_pitch: settings.metronome_subdivision_pitch,
                subdivision_gain: settings.metronome_subdivision_gain,
            })?;
            Ok(())
        })
    }

    /// Push the voice-guide config (enabled/volume/lead bars/count-in) to the
    /// engine live, without reopening the device. Mirrors the metronome path.
    pub fn set_voice_guide_config_realtime(
        &self,
        settings: &AppSettings,
    ) -> Result<(), DesktopError> {
        self.with_engine_state("set_voice_guide_config_realtime", None, |engine, _state| {
            engine.send_command(&EngineCommand::SetVoiceGuideConfig {
                enabled: settings.voice_guide_enabled,
                volume: settings.voice_guide_volume as f32,
                route: settings.voice_guide_output.clone(),
                lead_bars: settings.voice_guide_lead_bars,
                count_in_enabled: settings.voice_guide_count_in_enabled,
            })?;
            Ok(())
        })
    }

    /// Decode and install the voice-guide clip bank for a language. `voices_dir`
    /// is the bundled resources path (resolved by the command layer from the
    /// Tauri app handle). Decoding happens on the engine command thread.
    pub fn load_voice_guide_bank(&self, voices_dir: &str, lang: &str) -> Result<(), DesktopError> {
        self.with_engine_state("load_voice_guide_bank", None, |engine, _state| {
            engine.send_command(&EngineCommand::LoadVoiceGuideBank {
                voices_dir: voices_dir.to_string(),
                lang: lang.to_string(),
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
            transport_timing_update_count: self
                .transport_timing_update_count
                .load(Ordering::Relaxed),
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

    /// Update the cached settings without touching the audio device. Used by
    /// realtime paths (e.g. metronome sound) that send their own engine command
    /// but must keep `current_settings()` consistent for later device changes.
    pub fn replace_settings(&self, settings: AppSettings) -> Result<(), DesktopError> {
        self.state
            .lock()
            .map(|mut state| state.settings = settings)
            .map_err(|_| DesktopError::AudioCommand("audio v2 state lock poisoned".into()))
    }

    pub fn apply_settings(&self, settings: AppSettings) -> Result<(), DesktopError> {
        self.apply_settings_with_stream_rebuild(settings, true)
    }

    pub fn apply_settings_with_stream_rebuild(
        &self,
        mut settings: AppSettings,
        rebuild_stream: bool,
    ) -> Result<(), DesktopError> {
        self.with_engine_state("apply_settings", None, |engine, state| {
            // Only touch the audio DEVICE (open/reconfigure — multi-second on
            // slow DirectSound stacks, and it holds the lock) when the
            // device-affecting settings actually changed. The caller (state.rs)
            // sets rebuild_stream = device_changed || output_channels_changed.
            // Metronome / voice-only changes skip this entirely (they used to
            // needlessly reopen the device and freeze playback). Startup passes
            // rebuild_stream = true.
            if rebuild_stream {
            // Device-open errors must NOT abort apply_settings. There are
            // two failure modes we treat differently:
            //   (a) the saved device is GONE (unplugged USB, removed driver,
            //       renamed). It will never come back under this id, so we
            //       clear the saved selection and fall back to default.
            //   (b) the saved device EXISTS but its open call failed (ASIO
            //       hogged by another app, sample-rate negotiation failure,
            //       driver in a bad state). This is transient — keep the
            //       saved selection so the next launch can retry, and fall
            //       back to default for now.
            if let Some(device_id) = settings
                .selected_output_device_id
                .clone()
                .or_else(|| settings.selected_output_device.clone())
            {
                let active_channels: Vec<i32> = settings
                    .enabled_output_channels
                    .iter()
                    .map(|c| *c as i32)
                    .collect();
                // Probe the available devices BEFORE attempting to open
                // the saved one. A failed setAudioDeviceSetup can leave
                // the JUCE manager in a degraded state where subsequent
                // list_devices() calls return an empty list — that's
                // the "audio settings only shows System default" bug
                // reported when the user changes headphones between
                // sessions. Checking first means we skip the doomed
                // open entirely and go straight to system default.
                let available = engine.list_devices().unwrap_or_default();
                let device_exists = available
                    .iter()
                    .any(|d| d.device_id == device_id || d.device_name == device_id);
                if audio_debug_logging_enabled() {
                    eprintln!(
                        "[libretracks-audio] apply_settings: {} device(s) available; \
                         saved='{device_id}' present={device_exists}",
                        available.len(),
                    );
                }
                let attempt_result = if device_exists {
                    engine.send_command(&EngineCommand::SetOutputDevice {
                        device_id: device_id.clone(),
                        active_channels: active_channels.clone(),
                    })
                } else {
                    if audio_debug_logging_enabled() {
                        eprintln!(
                            "[libretracks-audio] saved output device '{device_id}' is not in \
                             the current device list; skipping its open attempt and clearing \
                             the saved selection so future launches don't keep failing."
                        );
                    }
                    settings.selected_output_device = None;
                    settings.selected_output_device_id = None;
                    settings.selected_output_device_name = None;
                    Err(EngineError::Internal(
                        "saved device not present".to_string(),
                    ))
                };
                if let Err(error) = attempt_result {
                    if device_exists && audio_debug_logging_enabled() {
                        eprintln!(
                            "[libretracks-audio] saved output device '{device_id}' exists \
                             but failed to open ({error}); falling back to system default."
                        );
                    }
                    // Two-tier fallback: first try the system default
                    // (empty device_id). If that also fails, walk the
                    // enumerated device list and open the first one
                    // that the engine accepts. Without this, a user
                    // whose saved default points to a flaky alias
                    // (e.g. DirectSound's "Controlador primario de
                    // sonido", which can refuse to open after audio
                    // hardware changes) ends up with no working
                    // device at all, even though several other
                    // perfectly fine devices are in the list.
                    let mut opened = engine
                        .send_command(&EngineCommand::SetOutputDevice {
                            device_id: String::new(),
                            active_channels: active_channels.clone(),
                        })
                        .is_ok();
                    if !opened {
                        for candidate in available.iter() {
                            // Skip the same id we already failed on.
                            if candidate.device_id == device_id
                                || candidate.device_name == device_id
                            {
                                continue;
                            }
                            // Prefer non-"primary alias" devices —
                            // those are the ones that commonly fail.
                            if candidate
                                .device_name
                                .to_ascii_lowercase()
                                .contains("controlador primario")
                                || candidate
                                    .device_name
                                    .to_ascii_lowercase()
                                    .contains("primary sound driver")
                            {
                                continue;
                            }
                            if engine
                                .send_command(&EngineCommand::SetOutputDevice {
                                    device_id: candidate.device_id.clone(),
                                    active_channels: active_channels.clone(),
                                })
                                .is_ok()
                            {
                                eprintln!(
                                    "[libretracks-audio] fallback opened '{}'.",
                                    candidate.device_id,
                                );
                                opened = true;
                                break;
                            }
                        }
                    }
                    if !opened {
                        // Truly nothing opened. Log unconditionally so
                        // the silent-transport state has a paper trail.
                        eprintln!(
                            "[libretracks-audio] no audio output could be opened after \
                             rejecting '{device_id}'; tried system default and every \
                             enumerated device. Transport will run silently until the \
                             user picks a device that opens cleanly."
                        );
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
            } // end if rebuild_stream
            // Metronome config is a pure state setter; if THIS fails it's a
            // genuine engine bug, so we DO propagate.
            engine.send_command(&EngineCommand::SetMetronomeConfig {
                enabled: settings.metronome_enabled,
                volume: metronome_engine_volume(settings.metronome_volume),
                route: settings.metronome_output.clone(),
                accent_enabled: settings.metronome_accent_enabled,
                accent_preset: settings.metronome_accent_preset,
                beat_preset: settings.metronome_beat_preset,
                accent_pitch: settings.metronome_accent_pitch,
                beat_pitch: settings.metronome_beat_pitch,
                subdivision: settings.metronome_subdivision,
                subdivision_preset: settings.metronome_subdivision_preset,
                subdivision_pitch: settings.metronome_subdivision_pitch,
                subdivision_gain: settings.metronome_subdivision_gain,
            })?;
            // Voice-guide config (the clip bank is loaded separately via the
            // command layer, which knows the bundled resources path).
            engine.send_command(&EngineCommand::SetVoiceGuideConfig {
                enabled: settings.voice_guide_enabled,
                volume: settings.voice_guide_volume as f32,
                route: settings.voice_guide_output.clone(),
                lead_bars: settings.voice_guide_lead_bars,
                count_in_enabled: settings.voice_guide_count_in_enabled,
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
        target_gain: f32,
        duration_seconds: f64,
    ) -> Result<(), DesktopError> {
        self.with_engine_state("start_master_fade", None, |engine, _state| {
            if jump_debug_logging_enabled() {
                eprintln!(
                    "[LT_JUMP_DEBUG][rust-command] start_master_fade target_gain={target_gain:.6} duration_seconds={duration_seconds:.9}"
                );
            }
            engine.send_command(&EngineCommand::StartMasterFade {
                target_gain: target_gain.clamp(0.0, 1.0),
                duration_seconds: duration_seconds.max(0.0),
            })?;
            Ok(())
        })
    }

    pub fn engine_snapshot(&self) -> Result<EngineSnapshot, DesktopError> {
        // Defense in depth: retry a few times before giving up with "state
        // locked". The root cause of long lock holds is fixed (waits no longer
        // hold the lock), but a brief overlap with any other command shouldn't
        // make a project load/save fail. ~3 tries x 10ms covers short overlaps;
        // a genuinely poisoned lock fails immediately (no point retrying).
        const SNAPSHOT_LOCK_RETRIES: u32 = 3;
        let mut state = 'acquire: loop {
            for attempt in 0..SNAPSHOT_LOCK_RETRIES {
                match self.state.try_lock() {
                    Ok(guard) => break 'acquire guard,
                    Err(std::sync::TryLockError::Poisoned(_)) => {
                        return Err(DesktopError::AudioCommand(
                            "audio v2 state lock poisoned".into(),
                        ))
                    }
                    Err(std::sync::TryLockError::WouldBlock) => {
                        if attempt + 1 < SNAPSHOT_LOCK_RETRIES {
                            thread::sleep(Duration::from_millis(10));
                        }
                    }
                }
            }
            return Err(DesktopError::AudioCommand(
                "engine_snapshot: state locked".into(),
            ));
        };
        ensure_engine(&mut state)?
            .get_snapshot()
            .map_err(|e| DesktopError::AudioCommand(e.to_string()))
    }

    /// Enumerate output devices through the LIVE engine (the one playback uses),
    /// reusing it via `ensure_engine` instead of spinning up a throwaway engine.
    /// The throwaway path paid a full, multi-second `open_device` on every
    /// Settings open (and on a process-global DirectSound stack it tore down the
    /// live playback stream). Uses try_lock with a short retry so a device-list
    /// refresh never blocks behind an in-flight command — it degrades to "state
    /// locked" exactly like engine_snapshot.
    pub fn list_devices(&self) -> Result<AudioOutputDevicesResponse, DesktopError> {
        const LIST_LOCK_RETRIES: u32 = 3;
        let mut state = 'acquire: loop {
            for attempt in 0..LIST_LOCK_RETRIES {
                match self.state.try_lock() {
                    Ok(guard) => break 'acquire guard,
                    Err(std::sync::TryLockError::Poisoned(_)) => {
                        return Err(DesktopError::AudioCommand(
                            "audio v2 state lock poisoned".into(),
                        ))
                    }
                    Err(std::sync::TryLockError::WouldBlock) => {
                        if attempt + 1 < LIST_LOCK_RETRIES {
                            thread::sleep(Duration::from_millis(10));
                        }
                    }
                }
            }
            return Err(DesktopError::AudioCommand(
                "list_devices: state locked".into(),
            ));
        };
        let devices = ensure_engine(&mut state)?
            .list_devices()
            .map_err(|e| DesktopError::AudioCommand(e.to_string()))?;
        Ok(devices_response(devices))
    }

    pub fn debug_snapshot(&self) -> Result<AudioDebugSnapshot, DesktopError> {
        let mut state = match self.state.try_lock() {
            Ok(guard) => guard,
            Err(std::sync::TryLockError::WouldBlock) => {
                return Err(DesktopError::AudioCommand(
                    "debug_snapshot: state locked".into(),
                ))
            }
            Err(std::sync::TryLockError::Poisoned(_)) => {
                return Err(DesktopError::AudioCommand(
                    "audio v2 state lock poisoned".into(),
                ))
            }
        };
        let snapshot = ensure_engine(&mut state)?.get_snapshot().ok();
        let device = snapshot.as_ref().map(|snapshot| snapshot.device.clone());
        let cpu = snapshot.as_ref().map(|snapshot| snapshot.cpu.clone());
        let estimated_position_seconds = snapshot
            .as_ref()
            .map(|snapshot| snapshot.current_seconds)
            .or_else(|| estimate_position(&state));

        let mut runtime_state = AudioRuntimeStateSummary::default();
        if let Some(snapshot) = snapshot.as_ref() {
            runtime_state.ram_cache_used_mb =
                (snapshot.source_cache.ram_bytes_used / (1024 * 1024)) as usize;
            runtime_state.disk_cache_used_mb =
                (snapshot.source_cache.disk_bytes_used / (1024 * 1024)) as usize;
            runtime_state.cached_audio_buffers = snapshot.source_cache.blocks_cached as usize;
            runtime_state.cached_audio_preload_bytes =
                snapshot.source_cache.ram_bytes_used as usize;
        }

        Ok(AudioDebugSnapshot {
            enabled: true,
            log_commands: false,
            command_count: state.command_count,
            last_command: state.last_command.clone(),
            last_restart: state.last_restart.clone(),
            last_sync: state.last_sync.clone(),
            last_stop: state.last_stop.clone(),
            runtime_state,
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

    /// Aggregate source-preparation readiness for the global "Preparando audio…"
    /// indicator. Mirrors `pitch_prepare_summary`'s plumbing. The aggregate
    /// percent is REAL: each source's live `progress_percent` is averaged, with
    /// terminal sources counted as 100%.
    pub fn source_readiness_summary(&self) -> SourceReadinessSummary {
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(_) => return SourceReadinessSummary::default(),
        };
        let Ok(snapshot) = ensure_engine(&mut state).and_then(|engine| {
            engine
                .get_snapshot()
                .map_err(|error| DesktopError::AudioCommand(error.to_string()))
        }) else {
            return SourceReadinessSummary::default();
        };

        let total = snapshot.source_states.len();
        let mut ready_count = 0usize;
        let mut loading_count = 0usize;
        let mut failed_count = 0usize;
        let mut progress_sum: f64 = 0.0;
        for source in &snapshot.source_states {
            match source.status.as_str() {
                "ready" | "cache_ready" => {
                    ready_count += 1;
                    progress_sum += 100.0;
                }
                "failed" | "cancelled" => {
                    failed_count += 1;
                    // Terminal (won't progress further) — counts as done so the
                    // aggregate can reach 100 and the indicator dismisses.
                    progress_sum += 100.0;
                }
                _ => {
                    // "unloaded" | "loading" (or anything non-terminal).
                    loading_count += 1;
                    progress_sum += source.progress_percent.clamp(0, 100) as f64;
                }
            }
        }

        // Terminal states match the `sources_ready` predicate used by the wait
        // loop: every source is ready/cached or failed/cancelled.
        let sources_ready = total == 0 || (ready_count + failed_count) >= total;
        let progress_percent = if total == 0 {
            100.0
        } else {
            progress_sum / total as f64
        };

        SourceReadinessSummary {
            sources_ready,
            sources_total: total,
            sources_ready_count: ready_count,
            sources_loading_count: loading_count,
            sources_failed_count: failed_count,
            sources_progress_percent: progress_percent,
            cache_ram_used_mb: snapshot.source_cache.ram_bytes_used / (1024 * 1024),
            cache_disk_used_mb: snapshot.source_cache.disk_bytes_used / (1024 * 1024),
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

    fn current_region_meter_levels(&self) -> Result<Vec<RegionMeterLevel>, DesktopError> {
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
            .region_meters
            .into_iter()
            .map(|meter| RegionMeterLevel {
                region_id: meter.region_id,
                peak: meter.peak,
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
        if let Err(ref error) = result {
            if audio_debug_logging_enabled() {
                eprintln!("[engine] with_engine_state kind={kind} failed: {error}");
            }
        }
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
pub fn get_audio_output_devices(
    state: State<'_, crate::state::DesktopState>,
) -> Result<AudioOutputDevicesResponse, String> {
    // Enumerate through the LIVE audio engine (the one playback uses), reusing
    // it instead of spinning up a throwaway. The old code reused EngineV2State,
    // which the normal app flow never populates, so it ALWAYS fell back to
    // creating a throwaway Engine + a full ~multi-second open_device on every
    // Settings open — dozens of redundant device opens that froze playback on
    // slow DirectSound stacks (and on the process-global DirectSound primary
    // buffer, the throwaway's scan tore down the live stream). AudioController::
    // list_devices reuses the live engine and never touches a second JUCE
    // device manager.
    state.audio.list_devices().map_err(|error| {
        eprintln!("[audio] get_audio_output_devices FAILED: {error}");
        error.to_string()
    })
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
    let runtime_song = song_with_warped_timeline(song);
    let project_json = serde_json::to_string(&runtime_song)
        .map_err(|error| DesktopError::AudioCommand(error.to_string()))?;
    if audio_debug_logging_enabled() {
        eprintln!(
            "[engine] load_resolved_song: id={} bpm={} duration={:.3}s tracks={} regions={} clips={} markers={{tempo:{}, section:{}, time_sig:{}}} json_bytes={}",
            runtime_song.id,
            runtime_song.bpm,
            runtime_song.duration_seconds,
            runtime_song.tracks.len(),
            runtime_song.regions.len(),
            runtime_song.clips.len(),
            runtime_song.tempo_markers.len(),
            runtime_song.section_markers.len(),
            runtime_song.time_signature_markers.len(),
            project_json.len(),
        );
    }
    engine
        .send_command(&EngineCommand::LoadSession { project_json })
        .map_err(|error| {
            // Load failures are surfaced to the user as a status banner
            // anyway; the verbose line goes only under the debug flag so
            // normal runs stay quiet.
            if audio_debug_logging_enabled() {
                eprintln!("[engine] load_resolved_song FAILED: {error}");
            }
            DesktopError::AudioCommand(error.to_string())
        })?;
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

fn song_with_warped_timeline(song: &Song) -> Song {
    let source_song = song.clone();
    let mut runtime = song.clone();
    let track_transpose_enabled: HashMap<&str, bool> = source_song
        .tracks
        .iter()
        .map(|track| (track.id.as_str(), track.transpose_enabled))
        .collect();

    for clip in &mut runtime.clips {
        let source_start_seconds = clip.timeline_start_seconds;
        let transpose_enabled = track_transpose_enabled
            .get(clip.track_id.as_str())
            .copied()
            .unwrap_or(true);
        clip.timeline_start_seconds = warp_timeline_seconds_at(&source_song, source_start_seconds);
        clip.duration_seconds = audible_clip_duration_seconds(
            &source_song,
            source_start_seconds,
            clip.duration_seconds,
            transpose_enabled,
        );
    }

    for region in &mut runtime.regions {
        let source_start_seconds = region.start_seconds;
        let source_end_seconds = region.end_seconds;
        region.start_seconds = warp_timeline_seconds_at(&source_song, source_start_seconds);
        region.end_seconds = warp_timeline_seconds_at(&source_song, source_end_seconds)
            .max(region.start_seconds + 0.001);
    }

    for marker in &mut runtime.section_markers {
        marker.start_seconds = warp_timeline_seconds_at(&source_song, marker.start_seconds);
    }
    for marker in &mut runtime.tempo_markers {
        let source_start_seconds = marker.start_seconds;
        marker.start_seconds = warp_timeline_seconds_at(&source_song, marker.start_seconds);
        if let Some(scale) = varispeed_scale_at_source_second(&source_song, source_start_seconds) {
            marker.bpm *= scale;
        }
    }
    for marker in &mut runtime.time_signature_markers {
        marker.start_seconds = warp_timeline_seconds_at(&source_song, marker.start_seconds);
    }

    let max_clip_end = runtime
        .clips
        .iter()
        .map(|clip| clip.timeline_start_seconds + clip.duration_seconds)
        .fold(
            warp_timeline_seconds_at(&source_song, source_song.duration_seconds),
            f64::max,
        );
    runtime.duration_seconds = max_clip_end.max(1.0);
    add_varispeed_tempo_boundaries(&source_song, &mut runtime);
    runtime
}

fn semitones_to_pitch_scale(semitones: i32) -> f64 {
    let scale = 2.0_f64.powf(semitones as f64 / 12.0);
    if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    }
}

fn varispeed_scale_at_source_second(song: &Song, source_seconds: f64) -> Option<f64> {
    song.regions.iter().find_map(|region| {
        if region.warp_enabled
            || region.transpose_semitones == 0
            || source_seconds < region.start_seconds
            || source_seconds >= region.end_seconds
        {
            return None;
        }
        Some(semitones_to_pitch_scale(region.transpose_semitones))
    })
}

fn add_varispeed_tempo_boundaries(source_song: &Song, runtime: &mut Song) {
    let mut synthetic_markers = Vec::new();
    for region in &source_song.regions {
        if region.warp_enabled || region.transpose_semitones == 0 {
            continue;
        }
        let scale = semitones_to_pitch_scale(region.transpose_semitones);
        if (scale - 1.0).abs() < f64::EPSILON {
            continue;
        }
        let view_start = warp_timeline_seconds_at(source_song, region.start_seconds);
        let view_end = warp_timeline_seconds_at(source_song, region.end_seconds).max(view_start);
        synthetic_markers.push(TempoMarker {
            id: format!("{}_varispeed_start", region.id),
            start_seconds: view_start,
            bpm: effective_bpm_at(source_song, region.start_seconds) * scale,
        });
        synthetic_markers.push(TempoMarker {
            id: format!("{}_varispeed_end", region.id),
            start_seconds: view_end,
            bpm: effective_bpm_at(source_song, region.end_seconds),
        });
    }
    runtime.tempo_markers.extend(synthetic_markers);
    runtime.tempo_markers.sort_by(|left, right| {
        left.start_seconds
            .partial_cmp(&right.start_seconds)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
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

fn parse_engine_time_signature(signature: &str) -> Result<(i32, i32), DesktopError> {
    let (beats_per_bar, beat_unit) = signature
        .split_once('/')
        .ok_or_else(|| DesktopError::AudioCommand("time signature is invalid".into()))?;
    let beats_per_bar = beats_per_bar
        .parse::<i32>()
        .map_err(|_| DesktopError::AudioCommand("time signature is invalid".into()))?;
    let beat_unit = beat_unit
        .parse::<i32>()
        .map_err(|_| DesktopError::AudioCommand("time signature is invalid".into()))?;
    if beats_per_bar <= 0 || beat_unit <= 0 {
        return Err(DesktopError::AudioCommand(
            "time signature is invalid".into(),
        ));
    }
    Ok((beats_per_bar, beat_unit))
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
    song.regions.len().hash(&mut hasher);
    song.section_markers.len().hash(&mut hasher);
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
    for region in &song.regions {
        region.id.hash(&mut hasher);
        region.start_seconds.to_bits().hash(&mut hasher);
        region.end_seconds.to_bits().hash(&mut hasher);
        region.transpose_semitones.hash(&mut hasher);
        region.warp_enabled.hash(&mut hasher);
        region.warp_source_bpm.map(f64::to_bits).hash(&mut hasher);
    }
    for marker in &song.section_markers {
        marker.id.hash(&mut hasher);
        marker.start_seconds.to_bits().hash(&mut hasher);
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
                color: None,
                auto_created: false,
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
                color: None,
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

    #[test]
    fn metronome_engine_volume_boosts_saved_setting_range() {
        assert_eq!(metronome_engine_volume(0.0), 0.0);
        assert_eq!(metronome_engine_volume(0.5), 1.25);
        assert_eq!(metronome_engine_volume(1.0), 2.5);
        assert_eq!(metronome_engine_volume(2.0), 2.5);
    }

    fn source_state(status: &str) -> lt_audio_engine_v2::SourcePreparationInfo {
        lt_audio_engine_v2::SourcePreparationInfo {
            status: status.into(),
            ..Default::default()
        }
    }

    fn snapshot_with(statuses: &[&str]) -> EngineSnapshot {
        EngineSnapshot {
            source_states: statuses.iter().map(|s| source_state(s)).collect(),
            ..Default::default()
        }
    }

    #[test]
    fn sources_ready_is_true_when_no_sources() {
        assert!(sources_ready(&snapshot_with(&[])));
    }

    #[test]
    fn sources_ready_is_true_when_all_terminal() {
        assert!(sources_ready(&snapshot_with(&["ready", "cache_ready"])));
    }

    #[test]
    fn sources_ready_counts_failed_and_cancelled_as_done() {
        // A broken/cancelled source must never hang the wait.
        assert!(sources_ready(&snapshot_with(&[
            "ready",
            "failed",
            "cancelled"
        ])));
    }

    #[test]
    fn sources_ready_is_false_while_any_pending() {
        assert!(!sources_ready(&snapshot_with(&["ready", "loading"])));
        assert!(!sources_ready(&snapshot_with(&["unloaded"])));
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

fn playback_prepare_wait_timeout() -> Duration {
    let millis = std::env::var("LIBRETRACKS_PLAYBACK_PREPARE_WAIT_MS")
        .ok()
        .and_then(|raw| raw.parse::<u64>().ok())
        .filter(|value| *value <= 120_000)
        .unwrap_or(5_000);
    Duration::from_millis(millis)
}

/// True when every source in the snapshot has reached a terminal preparation
/// state (decoded/cached, or failed/cancelled — both count as "done" so a broken
/// source never hangs the wait). An empty source set is trivially ready.
fn sources_ready(snapshot: &EngineSnapshot) -> bool {
    let total = snapshot.source_states.len();
    if total == 0 {
        return true;
    }
    let ready = snapshot
        .source_states
        .iter()
        .filter(|source| {
            matches!(
                source.status.as_str(),
                "ready" | "cache_ready" | "failed" | "cancelled"
            )
        })
        .count();
    ready >= total
}

fn playback_reason_label(reason: PlaybackStartReason) -> &'static str {
    match reason {
        PlaybackStartReason::InitialPlay => "initial_play",
        PlaybackStartReason::ResumePlay => "resume_play",
        PlaybackStartReason::Seek => "seek",
        PlaybackStartReason::ImmediateJump => "immediate_jump",
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
