use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum EngineEvent {
    PlaybackStarted  { frame: i64 },
    PlaybackPaused   { frame: i64 },
    PlaybackStopped  { frame: i64 },
    SeekExecuted     { from_frame: i64, to_frame: i64 },

    JumpScheduled { jump_id: String, target_description: String },
    JumpCancelled { jump_id: String },
    JumpExecuted  { jump_id: String, from_frame: i64, to_frame: i64 },
    JumpFailed    { jump_id: String, reason: String },

    DeviceChanged {
        device_id:   String,
        device_name: String,
        sample_rate: i32,
        buffer_size: i32,
    },
    DeviceError { message: String },

    SourcePrepared    { source_id: String },
    SourceStarved     { source_id: String, track_id: String },
    PitchCachePrepared{ source_id: String, semitones: i32 },
    DiagnosticWarning { message: String },
}
