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
        accent_enabled: bool,
        accent_preset: i32,
        beat_preset: i32,
        accent_pitch: f32,
        beat_pitch: f32,
        subdivision: i32,
        subdivision_preset: i32,
        subdivision_pitch: f32,
        subdivision_gain: f32,
    },

    SetVoiceGuideConfig {
        enabled: bool,
        volume: f32,
        route: String,
        /// Bars of announcement/count-in before a marker (1..4).
        lead_bars: i32,
        /// false = speak the section name only, no beat count.
        count_in_enabled: bool,
    },

    /// Decode and install the voice-guide clip bank for a language. The engine
    /// reads `<voices_dir>/<lang>/{sections,counts}/*.wav`. Decoding happens off
    /// the audio thread; the new bank is swapped in atomically.
    LoadVoiceGuideBank {
        voices_dir: String,
        lang: String,
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
    /// Per-song master fader. The mixer multiplies the post-mix bus by this
    /// value while the playhead lies inside the region.
    SetRegionMasterGain {
        region_id: String,
        master_gain: f32,
    },
    SetSongRegions {
        song_id: String,
        regions: Vec<RegionUpdate>,
    },
    SetSongClips {
        song_id: String,
        clips: Vec<ClipUpdate>,
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
    SetSongTimelineWindow {
        song_id: String,
        clips: Vec<ClipUpdate>,
        regions: Vec<RegionUpdate>,
        markers: Vec<MarkerUpdate>,
        bpm: f64,
        beats_per_bar: i32,
        beat_unit: i32,
        tempo_markers: Vec<TempoMarkerUpdate>,
        time_signature_markers: Vec<TimeSignatureMarkerUpdate>,
    },

    /// Incrementally upsert a song's full track set WITHOUT a full LoadSession.
    /// The structural-edit path (add/remove/move tracks & clips, import audio)
    /// that replaces LoadSession for in-session changes: the engine copies the
    /// live session, replaces the named song's tracks, registers ONLY new
    /// sources (already-decoded ones are kept), and atomically swaps the session
    /// — so it never stalls the audio thread mid-playback. See
    /// docs/HANDOFF_import_while_playing_glitches.md.
    UpsertSongTracks {
        song_id: String,
        tracks: Vec<TrackUpsert>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        sources: Vec<SourceRef>,
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
    /// Per-song master fader gain. Defaults to unity if absent for back-compat
    /// with engine snapshots that predate the master fader.
    #[serde(default = "default_region_master_gain")]
    pub master_gain: f32,
}

fn default_region_master_gain() -> f32 {
    1.0
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClipUpdate {
    pub id: String,
    pub track_id: String,
    pub source_id: String,
    pub timeline_start_frame: i64,
    pub source_start_frame: i64,
    pub length_frames: i64,
    pub gain: f32,
    pub fade_in_frames: i64,
    pub fade_out_frames: i64,
    #[serde(default)]
    pub semitones: i32,
}

/// A track in a `CmdUpsertSongTracks` command — full metadata plus its clips.
/// Clips are nested here (no `track_id`), unlike the flat `ClipUpdate`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrackUpsert {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default = "default_unity_gain")]
    pub gain: f32,
    #[serde(default)]
    pub pan: f32,
    #[serde(default = "default_audio_route")]
    pub audio_to: String,
    #[serde(default)]
    pub mute: bool,
    #[serde(default)]
    pub solo: bool,
    /// Serialized token, e.g. "follows_song_or_region" | "never_transpose".
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub transpose_behavior: String,
    /// Serialized token, e.g. "normal" | "click" | "guide".
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub role: String,
    /// "audio" | "folder".
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub kind: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub parent_track_id: String,
    #[serde(default)]
    pub clips: Vec<TrackClipUpdate>,
}

/// A clip inside a `TrackUpsert` (no `track_id`; the parent track owns it).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrackClipUpdate {
    pub id: String,
    pub source_id: String,
    pub timeline_start_frame: i64,
    pub source_start_frame: i64,
    pub length_frames: i64,
    #[serde(default = "default_unity_gain")]
    pub gain: f32,
    #[serde(default)]
    pub fade_in_frames: i64,
    #[serde(default)]
    pub fade_out_frames: i64,
    #[serde(default)]
    pub semitones: i32,
}

/// A source file referenced by an upsert. The engine registers + enqueues it
/// for background decode only if its id isn't already known.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceRef {
    pub id: String,
    #[serde(default)]
    pub file_path: String,
}

fn default_unity_gain() -> f32 {
    1.0
}

fn default_audio_route() -> String {
    "master".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarkerUpdate {
    pub id: String,
    pub name: String,
    pub frame: i64,
    /// Serialized snake_case `MarkerKind` token (e.g. "chorus", "custom"). The
    /// C++ engine maps it via `marker_kind_from_string`; an empty/unknown value
    /// falls back to Custom. Defaults to "custom" so older callers stay valid.
    #[serde(default = "default_marker_kind")]
    pub kind: String,
    /// Numbered section variant (0 = unnumbered base). Plays `<kind>_<n>.wav`
    /// with fallback to the base clip.
    #[serde(default)]
    pub variant: i32,
}

fn default_marker_kind() -> String {
    "custom".to_string()
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
