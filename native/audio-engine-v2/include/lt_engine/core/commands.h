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

// ---------------------------------------------------------------------------
// Metronome
// ---------------------------------------------------------------------------
struct CmdSetMetronomeEnabled     { bool enabled; };
struct CmdSetMetronomeVolume      { float volume; };
struct CmdSetMetronomeOutputRoute { std::string route; };
struct CmdSetMetronomeConfig      { bool enabled; float volume; std::string route; };

// ---------------------------------------------------------------------------
// Pitch
// ---------------------------------------------------------------------------
struct CmdSetSongTranspose    { Id song_id;    Semitones semitones; };
struct CmdSetRegionTranspose  { Id region_id;  Semitones semitones; };

struct CmdSetSongRegions {
    struct RegionUpdate {
        Id          id;
        std::string name;
        Frame       start_frame = 0;
        Frame       end_frame = 0;
        Semitones   transpose_semitones = 0;
    };
    Id song_id;
    std::vector<RegionUpdate> regions;
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
struct CmdSetOutputDevice { std::string device_id; };
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
    CmdSetTrackTransposeEnabled,
    CmdSetMetronomeEnabled, CmdSetMetronomeVolume, CmdSetMetronomeOutputRoute,
    CmdSetMetronomeConfig,
    CmdSetSongTranspose, CmdSetRegionTranspose, CmdSetSongRegions,
    CmdSetOutputDevice, CmdSetSampleRate, CmdSetBufferSize
>;

// ---------------------------------------------------------------------------
// JSON round-trip (declared here, implemented in core/commands.cpp)
// ---------------------------------------------------------------------------
EngineCommand command_from_json(const std::string& json);
std::string   command_to_json(const EngineCommand& cmd);

} // namespace lt
