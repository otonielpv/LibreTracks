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
    pub last_error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CpuDiagnostics {
    pub callback_duration_ms: f64,
    pub callback_load_percent: f64,
    pub underrun_count: i32,
    pub callback_count: i32,
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
}
