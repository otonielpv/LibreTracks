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

struct CmdSetVoiceGuideConfig {
    bool enabled = false;
    float volume = 1.0f;
    std::string route = "monitor";
    int lead_bars = 1;
    bool count_in_enabled = true;
};

struct CmdLoadVoiceGuideBank {
    std::string voices_dir;
    std::string lang;
};

// ---------------------------------------------------------------------------
// Ambient pad
// ---------------------------------------------------------------------------
struct CmdSetPadConfig {
    bool enabled = false;
    float volume = 1.0f;
    std::string route = "master";
    int key = 0;               // 0..11 (C..B)
    std::string pad_id;
    float fade_in_seconds = 0.0f;   // soft entrance on enable (0 = near-instant)
    float fade_out_seconds = 0.0f;  // soft exit on disable / key swap
};

// Decode a single pad key from disk and hand it to the renderer. Runs the
// (slow) decode on the command thread; the resulting clip is swapped in
// realtime-safely. `pads_dir/<pad_id>/<key>.<ext>`.
struct CmdLoadPadClip {
    std::string pads_dir;
    std::string pad_id;
    int key = 0;
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
        // Serialized snake_case MarkerKind token (e.g. "chorus"). Converted to
        // the Marker::kind enum when applied to the session. Empty == custom.
        std::string kind;
        int variant = 0;   // numbered section variant; 0 = base
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
    // True while a drag is IN PROGRESS. The handler then skips the warp
    // voice hard-retime for moved clips (re-priming Bungee every tick of a
    // big drag is what buzzes); the final commit sends live=false so voices
    // retime once at the drop. Defaults false for back-compat.
    bool live = false;
};

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

// Incrementally upsert a song's full track set WITHOUT a full LoadSession.
//
// This is the structural-edit path (add/remove/move tracks and clips, import
// audio) that replaces CmdLoadSession for the common in-session case. Unlike
// LoadSession it does NOT call source_manager_->clear() or re-decode existing
// sources — it copies the live session, replaces the named song's tracks in
// place, registers ONLY the sources that aren't already known (the prep queue
// skips ones already ready/loading), and atomically swaps the session pointer.
// Already-decoded sources and the audio thread's warm pages are preserved, so
// importing audio mid-playback no longer stalls the callback.
struct CmdUpsertSongTracks {
    struct ClipUpdate {
        Id    id;
        Id    source_id;
        Frame timeline_start_frame = 0;
        Frame source_start_frame = 0;
        Frame length_frames = 0;
        Gain  gain = 1.0f;
        Frame fade_in_frames = 0;
        Frame fade_out_frames = 0;
        Semitones semitones = 0;
    };
    struct TrackUpdate {
        Id          id;
        std::string name;
        Gain        gain = 1.0f;
        float       pan = 0.0f;
        std::string audio_to = "master";
        bool        mute = false;
        bool        solo = false;
        // Serialized tokens; converted to the engine enums when applied.
        std::string transpose_behavior;  // e.g. "follows_song_or_region" | "never"
        std::string role;                // e.g. "normal" | "click" | "guide"
        std::string kind;                // e.g. "audio" | "folder"
        Id          parent_track_id;     // empty = top level
        std::vector<ClipUpdate> clips;
    };
    // New source files to register+enqueue for background decode. Sources whose
    // id is already known are skipped by the prep queue (no re-decode).
    struct SourceRef {
        Id          id;
        std::string file_path;
    };
    Id song_id;
    std::vector<TrackUpdate> tracks;   // authoritative full track set for the song
    std::vector<SourceRef>   sources;  // sources referenced by the clips above
    // Regions / markers / timing are carried too so this single command is a
    // complete structural snapshot of the song (any structural edit — not just
    // import — can route through it without losing region/marker/tempo changes).
    // Reuses the same update shapes as CmdSetSongTimelineWindow.
    std::vector<CmdSetSongRegions::RegionUpdate> regions;
    std::vector<CmdSetSongMarkers::MarkerUpdate> markers;
    double bpm = 120.0;
    int beats_per_bar = 4;
    int beat_unit = 4;
    std::vector<CmdSetSongTiming::TempoMarkerUpdate> tempo_markers;
    std::vector<CmdSetSongTiming::TimeSignatureMarkerUpdate> time_signature_markers;
};

// Prepare (decode→cache + same-pass waveform peaks) a set of audio files WITHOUT
// putting them in a session/timeline. Used when files are imported into the
// library or dragged from the OS, so decoding starts the moment we know the
// file — Ableton-style — instead of waiting for a LoadSession. Sources already
// prepared are skipped (no re-decode). The prep queue + source manager persist,
// so a later LoadSession reuses these instead of re-decoding.
struct CmdPrepareSources {
    struct SourceRef { Id id; std::string file_path; };
    std::vector<SourceRef> sources;
};

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
// Retry opening the last-requested output device after it died (the engine is
// running on the internal fallback clock — see AudioDeviceManager::
// fallback_active). No-op when a hardware stream is healthy. Sent periodically
// by the Rust watchdog until the device comes back.
struct CmdRecoverOutputDevice {};
// Android only: toggle AAudio low-latency PerformanceMode. Reopens the device.
struct CmdSetLowLatency   { bool enabled; };

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
    CmdSetVoiceGuideConfig, CmdLoadVoiceGuideBank,
    CmdSetPadConfig, CmdLoadPadClip,
    CmdSetSongTranspose, CmdSetRegionTranspose, CmdSetRegionWarp, CmdSetRegionMasterGain, CmdSetSongRegions,
    CmdSetSongClips, CmdSetSongMarkers, CmdSetSongTiming, CmdSetSongTimelineWindow,
    CmdUpsertSongTracks, CmdPrepareSources,
    CmdSetOutputDevice, CmdSetSampleRate, CmdSetBufferSize, CmdSetLowLatency,
    CmdRecoverOutputDevice
>;

// ---------------------------------------------------------------------------
// JSON round-trip (declared here, implemented in core/commands.cpp)
// ---------------------------------------------------------------------------
EngineCommand command_from_json(const std::string& json);
std::string   command_to_json(const EngineCommand& cmd);

} // namespace lt
