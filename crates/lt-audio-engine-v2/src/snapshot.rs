use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum PlaybackState {
    #[default]
    Stopped,
    Playing,
    Paused,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct EngineSnapshot {
    pub current_frame: i64,
    pub current_seconds: f64,
    pub playback_state: PlaybackState,

    #[serde(default)]
    pub current_song_id: String,
    #[serde(default)]
    pub current_region_id: String,
    #[serde(default)]
    pub current_marker_id: String,

    #[serde(default)]
    pub pending_jumps: Vec<PendingJumpInfo>,

    pub device: DeviceInfo,
    pub cpu: CpuDiagnostics,
    pub meters: MeterValues,

    #[serde(default)]
    pub track_meters: Vec<TrackMeterValues>,

    #[serde(default)]
    pub source_states: Vec<SourcePreparationInfo>,

    #[serde(default)]
    pub metronome: MetronomeSnapshot,

    #[serde(default)]
    pub pitch: PitchSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct PendingJumpInfo {
    pub jump_id: String,
    pub target_description: String,
    pub trigger_description: String,
    pub status: String,
    pub created_frame: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DeviceInfo {
    pub device_id: String,
    pub device_name: String,
    pub backend: String,
    pub sample_rate: i32,
    pub buffer_size: i32,
    #[serde(default = "default_output_channel_count")]
    pub output_channel_count: i32,
    #[serde(default)]
    pub output_channel_names: Vec<String>,
    pub last_error: String,
}

fn default_output_channel_count() -> i32 {
    2
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CpuDiagnostics {
    pub callback_duration_ms: f64,
    #[serde(default)]
    pub callback_duration_max_ms: f64,
    pub callback_load_percent: f64,
    pub underrun_count: i32,
    pub callback_count: i32,
    #[serde(default)]
    pub callback_over_budget_count: u64,
    #[serde(default)]
    pub mixer_rendered_track_count: u64,
    #[serde(default)]
    pub mixer_skipped_track_count: u64,
    #[serde(default)]
    pub track_renderer_prepare_count: u64,
    #[serde(default)]
    pub track_renderer_scratch_resize_count: u64,
    #[serde(default)]
    pub track_renderer_scratch_resize_in_audio_thread_count: u64,
    #[serde(default)]
    pub track_renderer_block_too_large_count: u64,
    #[serde(default)]
    pub track_renderer_scratch_capacity_frames: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MeterValues {
    pub left_peak: f32,
    pub right_peak: f32,
    pub left_rms: f32,
    pub right_rms: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TrackMeterValues {
    pub track_id: String,
    pub left_peak: f32,
    pub right_peak: f32,
    pub left_rms: f32,
    pub right_rms: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SourcePreparationInfo {
    pub source_id: String,
    pub status: String,
    pub progress_percent: i32,
    #[serde(default)]
    pub error_message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MetronomeSnapshot {
    pub enabled: bool,
    pub volume: f32,
    pub output: String,
    pub last_beat_frame: i64,
    pub next_beat_frame: i64,
    pub current_bar: i32,
    pub current_beat: i32,
    pub route_resolved: String,
    pub rendered_clicks_count: u64,
    pub muted_reason: String,
    #[serde(default)]
    pub current_gain: f32,
    #[serde(default)]
    pub target_gain: f32,
    #[serde(default)]
    pub toggle_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PitchSnapshot {
    #[serde(default)]
    pub pitch_engine_available: bool,
    #[serde(default)]
    pub pitch_backend: String,
    #[serde(default)]
    pub rubberband_version: String,
    #[serde(default)]
    pub pitch_runtime_enabled: bool,
    #[serde(default)]
    pub pitch_prepare_active: bool,
    #[serde(default)]
    pub pitch_prepare_pending: bool,
    #[serde(default)]
    pub pitch_prepare_progress: f64,
    #[serde(default)]
    pub pitch_prepare_status: String,
    #[serde(default)]
    pub pitch_prepare_message: String,
    #[serde(default)]
    pub pitch_proxy_blocks_ready: u64,
    #[serde(default)]
    pub pitch_proxy_blocks_missing: u64,
    #[serde(default)]
    pub pitch_proxy_blocks_pending: u64,
    #[serde(default)]
    pub pitch_jobs_queued: u64,
    #[serde(default)]
    pub pitch_jobs_pending: u64,
    #[serde(default)]
    pub pitch_jobs_running: u64,
    #[serde(default)]
    pub pitch_jobs_completed: u64,
    #[serde(default)]
    pub pitch_jobs_failed: u64,
    #[serde(default)]
    pub active_pitch_render_path: String,
    #[serde(default)]
    pub last_pitch_prepare_reason: String,
    #[serde(default)]
    pub last_pitch_proxy_error: String,
    #[serde(default)]
    pub last_missing_proxy_key: String,
    #[serde(default)]
    pub last_missing_proxy_block_index: i64,
    #[serde(default)]
    pub active_stream_set_generation: u64,
    #[serde(default)]
    pub active_pitch_stream_count: u64,
    #[serde(default)]
    pub pitch_timeline_mismatch_count: u64,
    #[serde(default)]
    pub pitch_stream_not_aligned_count: u64,
    #[serde(default)]
    pub pitch_audio_thread_reset_count: u64,
    #[serde(default)]
    pub pitch_audio_thread_prime_count: u64,
    #[serde(default)]
    pub stream_generation: u64,
    #[serde(default)]
    pub stream_reset_thread_id: u64,
    #[serde(default)]
    pub stream_render_thread_id: u64,
    #[serde(default)]
    pub unsafe_cross_thread_reset_count: u64,
    #[serde(default)]
    pub concurrent_stream_mutation_detected: u64,
    #[serde(default)]
    pub active_stream_swap_count: u64,
    #[serde(default)]
    pub long_seek_count: u64,
    #[serde(default)]
    pub last_transport_discontinuity_target_frame: i64,
    #[serde(default)]
    pub last_transport_discontinuity_reason: String,
}
