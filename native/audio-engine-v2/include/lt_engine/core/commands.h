#pragma once

// ---------------------------------------------------------------------------
// EngineCommand — every action the caller can send to the engine.
//
// Serialization: JSON via nlohmann/json (header-only, bundled).
// Schema convention:
//   { "type": "<CommandType>", ...fields }
// ---------------------------------------------------------------------------

#include <lt_engine/core/types.h>
#include <optional>
#include <string>
#include <variant>
#include <vector>

namespace lt {

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------
struct CmdPlay   {};
struct CmdPause  {};
struct CmdStop   {};

struct CmdSeekAbsolute {
    Frame frame;
};

struct CmdSeekRelative {
    Frame delta_frames;
};

// ---------------------------------------------------------------------------
// Jump scheduling
// ---------------------------------------------------------------------------

enum class JumpTrigger {
    Immediate,
    AtRegionEnd,
    AtSongEnd,
    AtFrame,
};

struct JumpTarget {
    enum class Kind { Marker, Region, Song, NextSong, PreviousSong, Frame };
    Kind kind;
    std::optional<Id>    id;      // marker/region/song id
    std::optional<Frame> frame;   // for Frame target
};

struct CmdJumpToMarker         { Id marker_id; };
struct CmdJumpToRegion         { Id region_id; };
struct CmdJumpToSong           { Id song_id; };
struct CmdJumpToNextSong       {};
struct CmdJumpToPreviousSong   {};

struct CmdScheduleJump {
    Id          jump_id;   // caller-assigned, used to cancel/replace
    JumpTarget  target;
    JumpTrigger trigger;
    std::optional<Frame> trigger_frame; // for AtFrame: exact frame where target should fire
    bool suppress_seek_fade = false;
};

struct CmdCancelScheduledJump      { Id jump_id; };
struct CmdCancelAllScheduledJumps  {};

struct CmdReplaceScheduledJump {
    Id         jump_id;    // existing jump to replace
    JumpTarget new_target;
    JumpTrigger new_trigger;
};

// ---------------------------------------------------------------------------
// Track / mix
// ---------------------------------------------------------------------------
struct CmdSetTrackGain              { Id track_id; Gain gain; };
struct CmdSetTrackPan               { Id track_id; float pan; };
struct CmdSetTrackMute              { Id track_id; bool mute; };
struct CmdSetTrackSolo              { Id track_id; bool solo; };
struct CmdSetTrackAudioRoute        { Id track_id; std::string audio_to; };
struct CmdSetTrackTransposeEnabled  { Id track_id; bool enabled; };
struct CmdStartMasterFade           { float target_gain; double duration_seconds; };

// ---------------------------------------------------------------------------
// Metronome
// ---------------------------------------------------------------------------
struct CmdSetMetronomeEnabled     { bool enabled; };
struct CmdSetMetronomeVolume      { float volume; };
struct CmdSetMetronomeOutputRoute { std::string route; };
struct CmdSetMetronomeConfig      {
    bool enabled;
    float volume;
    std::string route;
    bool accent_enabled = true;
    int accent_preset = 0;
    int beat_preset = 0;
    float accent_pitch = 0.0f;
    float beat_pitch = 0.0f;
    int subdivision = 1;
    int subdivision_preset = 0;
    float subdivision_pitch = 0.0f;
    float subdivision_gain = 0.5f;
};

// ---------------------------------------------------------------------------
// Pitch
// ---------------------------------------------------------------------------
struct CmdSetSongTranspose    { Id song_id;    Semitones semitones; };
struct CmdSetRegionTranspose  { Id region_id;  Semitones semitones; };

// Per-region warp toggle. Hot-applied without rebuilding the session — the
// renderer reads warp_enabled / warp_source_bpm per block and feeds Bungee
// the resulting time_ratio. `warp_source_bpm <= 0` disables warp regardless
// of `warp_enabled`, matching the Rust-side validation.
struct CmdSetRegionWarp {
    Id     region_id;
    bool   warp_enabled = false;
    double warp_source_bpm = 0.0;
};

// Per-song master fader. Hot-applied — the mixer multiplies the output of
// every track by `master_gain` of the region active under the playhead.
struct CmdSetRegionMasterGain {
    Id    region_id;
    float master_gain = 1.0f;
};

struct CmdSetSongRegions {
    struct RegionUpdate {
        Id          id;
        std::string name;
        Frame       start_frame = 0;
        Frame       end_frame = 0;
        Semitones   transpose_semitones = 0;
        bool        warp_enabled = false;
        double      warp_source_bpm = 0.0;
        float       master_gain = 1.0f;
    };
    Id song_id;
    std::vector<RegionUpdate> regions;
};

struct CmdSetSongClips {
    struct ClipUpdate {
        Id    id;
        Id    track_id;
        Id    source_id;
        Frame timeline_start_frame = 0;
        Frame source_start_frame = 0;
        Frame length_frames = 0;
        Gain  gain = 1.0f;
        Frame fade_in_frames = 0;
        Frame fade_out_frames = 0;
        Semitones semitones = 0;
    };
    Id song_id;
    std::vector<ClipUpdate> clips;
};

struct CmdSetSongMarkers {
    struct MarkerUpdate {
        Id          id;
        std::string name;
        Frame       frame = 0;
    };
    Id song_id;
    std::vector<MarkerUpdate> markers;
};

struct CmdSetSongTiming {
    struct TempoMarkerUpdate {
        Id     id;
        Frame  frame = 0;
        double bpm = 120.0;
    };
    struct TimeSignatureMarkerUpdate {
        Id     id;
        Frame  frame = 0;
        int    beats_per_bar = 4;
        int    beat_unit = 4;
    };
    Id song_id;
    double bpm = 120.0;
    int beats_per_bar = 4;
    int beat_unit = 4;
    std::vector<TempoMarkerUpdate> tempo_markers;
    std::vector<TimeSignatureMarkerUpdate> time_signature_markers;
};

struct CmdSetSongTimelineWindow {
    Id song_id;
    std::vector<CmdSetSongClips::ClipUpdate> clips;
    std::vector<CmdSetSongRegions::RegionUpdate> regions;
    std::vector<CmdSetSongMarkers::MarkerUpdate> markers;
    double bpm = 120.0;
    int beats_per_bar = 4;
    int beat_unit = 4;
    std::vector<CmdSetSongTiming::TempoMarkerUpdate> tempo_markers;
    std::vector<CmdSetSongTiming::TimeSignatureMarkerUpdate> time_signature_markers;
};

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

// Load a project from its JSON representation.
// The engine will decode sources and install the Mixer callback.
struct CmdLoadSession { std::string project_json; };

// ---------------------------------------------------------------------------
// Device / stream
// ---------------------------------------------------------------------------
struct CmdSetOutputDevice {
    std::string device_id;
    // Output channel indices to activate (0-based). Empty = back-compat stereo.
    std::vector<int> active_channels;
};
struct CmdSetSampleRate   { int sample_rate; };
struct CmdSetBufferSize   { int buffer_size; };

// ---------------------------------------------------------------------------
// Union type
// ---------------------------------------------------------------------------
using EngineCommand = std::variant<
    CmdLoadSession,
    CmdPlay, CmdPause, CmdStop,
    CmdSeekAbsolute, CmdSeekRelative,
    CmdJumpToMarker, CmdJumpToRegion,
    CmdJumpToSong, CmdJumpToNextSong, CmdJumpToPreviousSong,
    CmdScheduleJump, CmdCancelScheduledJump,
    CmdCancelAllScheduledJumps, CmdReplaceScheduledJump,
    CmdSetTrackGain, CmdSetTrackPan, CmdSetTrackMute, CmdSetTrackSolo,
    CmdSetTrackAudioRoute,
    CmdSetTrackTransposeEnabled, CmdStartMasterFade,
    CmdSetMetronomeEnabled, CmdSetMetronomeVolume, CmdSetMetronomeOutputRoute,
    CmdSetMetronomeConfig,
    CmdSetSongTranspose, CmdSetRegionTranspose, CmdSetRegionWarp, CmdSetRegionMasterGain, CmdSetSongRegions,
    CmdSetSongClips, CmdSetSongMarkers, CmdSetSongTiming, CmdSetSongTimelineWindow,
    CmdSetOutputDevice, CmdSetSampleRate, CmdSetBufferSize
>;

// ---------------------------------------------------------------------------
// JSON round-trip (declared here, implemented in core/commands.cpp)
// ---------------------------------------------------------------------------
EngineCommand command_from_json(const std::string& json);
std::string   command_to_json(const EngineCommand& cmd);

} // namespace lt
