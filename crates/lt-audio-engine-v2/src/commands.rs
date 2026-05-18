//! Rust mirror of the C++ EngineCommand types.
//! Serializes to the same JSON schema the C++ layer expects.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum EngineCommand {
    LoadSession {
        project_json: String,
    },

    Play,
    Pause,
    Stop,

    SeekAbsolute {
        frame: i64,
    },
    SeekRelative {
        delta_frames: i64,
    },

    JumpToMarker {
        marker_id: String,
    },
    JumpToRegion {
        region_id: String,
    },
    JumpToSong {
        song_id: String,
    },
    JumpToNextSong,
    JumpToPreviousSong,

    ScheduleJump {
        jump_id: String,
        target: JumpTarget,
        trigger: JumpTrigger,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        trigger_frame: Option<i64>,
    },
    CancelScheduledJump {
        jump_id: String,
    },
    CancelAllScheduledJumps,
    ReplaceScheduledJump {
        jump_id: String,
        new_target: JumpTarget,
        new_trigger: JumpTrigger,
    },

    SetTrackGain {
        track_id: String,
        gain: f32,
    },
    SetTrackPan {
        track_id: String,
        pan: f32,
    },
    SetTrackMute {
        track_id: String,
        mute: bool,
    },
    SetTrackSolo {
        track_id: String,
        solo: bool,
    },
    SetTrackAudioRoute {
        track_id: String,
        audio_to: String,
    },
    SetTrackTransposeEnabled {
        track_id: String,
        enabled: bool,
    },

    SetMetronomeEnabled {
        enabled: bool,
    },
    SetMetronomeVolume {
        volume: f32,
    },
    SetMetronomeOutputRoute {
        route: String,
    },
    SetMetronomeConfig {
        enabled: bool,
        volume: f32,
        route: String,
    },

    SetSongTranspose {
        song_id: String,
        semitones: i32,
    },
    SetRegionTranspose {
        region_id: String,
        semitones: i32,
    },
    SetSongRegions {
        song_id: String,
        regions: Vec<RegionUpdate>,
    },

    SetOutputDevice {
        device_id: String,
    },
    SetSampleRate {
        sample_rate: i32,
    },
    SetBufferSize {
        buffer_size: i32,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegionUpdate {
    pub id: String,
    pub name: String,
    pub start_frame: i64,
    pub end_frame: i64,
    pub transpose_semitones: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JumpTarget {
    pub kind: JumpTargetKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frame: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum JumpTargetKind {
    Marker,
    Region,
    Song,
    NextSong,
    PreviousSong,
    Frame,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum JumpTrigger {
    Immediate,
    AtRegionEnd,
    AtSongEnd,
    AtFrame,
}
