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
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        suppress_seek_fade: bool,
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
    StartMasterFade {
        target_gain: f32,
        duration_seconds: f64,
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
    /// Hot-toggle warp on a single region without rebuilding the session.
    /// The renderer reads warp_enabled / warp_source_bpm per block, so the
    /// new ratio takes effect on the next audio callback.
    SetRegionWarp {
        region_id: String,
        warp_enabled: bool,
        warp_source_bpm: f64,
    },
    SetSongRegions {
        song_id: String,
        regions: Vec<RegionUpdate>,
    },
    SetSongMarkers {
        song_id: String,
        markers: Vec<MarkerUpdate>,
    },
    SetSongTiming {
        song_id: String,
        bpm: f64,
        beats_per_bar: i32,
        beat_unit: i32,
        tempo_markers: Vec<TempoMarkerUpdate>,
        time_signature_markers: Vec<TimeSignatureMarkerUpdate>,
    },

    SetOutputDevice {
        device_id: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        active_channels: Vec<i32>,
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
    #[serde(default)]
    pub warp_enabled: bool,
    /// 0.0 means "no warp" regardless of `warp_enabled`. Use this default when
    /// warp is disabled and the user has not configured a source BPM yet.
    #[serde(default)]
    pub warp_source_bpm: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarkerUpdate {
    pub id: String,
    pub name: String,
    pub frame: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TempoMarkerUpdate {
    pub id: String,
    pub frame: i64,
    pub bpm: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimeSignatureMarkerUpdate {
    pub id: String,
    pub frame: i64,
    pub beats_per_bar: i32,
    pub beat_unit: i32,
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
