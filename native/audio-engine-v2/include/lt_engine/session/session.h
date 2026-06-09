#pragma once

// ---------------------------------------------------------------------------
// Session V2 model
//
// This is the engine's internal representation of a live-performance session.
// It is distinct from the project file format; a Rust adapter converts from
// libretracks-project to Session V2 before handing it to the engine.
// ---------------------------------------------------------------------------

#include <lt_engine/core/types.h>
#include <lt_engine/core/result.h>
#include <optional>
#include <string>
#include <vector>

namespace lt {

// ---------------------------------------------------------------------------
// Source — a decoded audio file reference
// ---------------------------------------------------------------------------
enum class DecodeStatus { Unknown, Queued, Running, Ready, Failed };
enum class CacheStatus  { Uncached, Partial, Complete };

struct Source {
    Id              id;
    std::string     file_path;
    int             original_sample_rate = 0;
    int             channel_count        = 0;
    Frame           duration_frames      = 0;
    DecodeStatus    decode_status        = DecodeStatus::Unknown;
    CacheStatus     cache_status         = CacheStatus::Uncached;
};

// ---------------------------------------------------------------------------
// Clip — a region of a Source placed on a Track timeline
// ---------------------------------------------------------------------------
struct Clip {
    Id    id;
    Id    source_id;

    Frame timeline_start_frame = 0;   // position in song timeline
    Frame source_start_frame   = 0;   // read offset inside source
    Frame length_frames        = 0;

    Gain  gain          = 1.0f;
    Frame fade_in_frames  = 0;
    Frame fade_out_frames = 0;
    Semitones semitones = 0;
};

// ---------------------------------------------------------------------------
// Track
// ---------------------------------------------------------------------------

// Whether pitch transposition is applied to this track.
enum class TransposeBehavior {
    FollowsSongOrRegion,   // normal tracks: follow whatever is active
    NeverTranspose,        // click, cue — always play at original pitch
};

// Semantic role of the track, used for routing and behaviour decisions.
enum class TrackRole {
    Normal,
    Click,
    Guide,
    Cue,
    Backing,
    Other,
};

// Semantic kind of the track in the hierarchy.
enum class TrackKind {
    Audio,
    Folder,
};

struct Track {
    Id                  id;
    std::string         name;
    Gain                gain               = 1.0f;
    float               pan                = 0.0f;
    std::string         audio_to           = "master";
    bool                mute               = false;
    bool                solo               = false;
    TransposeBehavior   transpose_behavior = TransposeBehavior::FollowsSongOrRegion;
    TrackRole           role               = TrackRole::Normal;
    TrackKind           kind               = TrackKind::Audio;
    Id                  parent_track_id;      // empty if top-level
    std::vector<Clip>   clips;
};

// ---------------------------------------------------------------------------
// Marker — a named position within a Song
// ---------------------------------------------------------------------------
// Semantic section type, mirrors Rust `MarkerKind` / TS `MarkerKind`. Drives
// the voice-guide announcement clip. Order must match the Rust enum's intent
// but the engine only ever sets it from the parsed `kind` string, so the
// integer values are an engine-internal detail (Custom is the default/fallback).
enum class MarkerKind : int {
    Intro = 0,
    Verse = 1,
    PreChorus = 2,
    Chorus = 3,
    PostChorus = 4,
    Bridge = 5,
    Breakdown = 6,
    Drop = 7,
    Solo = 8,
    Outro = 9,
    Custom = 10,
};

// Map a serialized snake_case kind token (as sent by Rust/TS) to the enum.
// Unknown or empty tokens fall back to Custom.
MarkerKind marker_kind_from_string(const std::string& token) noexcept;

struct Marker {
    Id          id;
    std::string name;
    Frame       frame = 0;
    MarkerKind  kind = MarkerKind::Custom;
};

struct TempoMarker {
    Id     id;
    Frame  frame = 0;
    double bpm = 120.0;
};

struct TimeSignatureMarker {
    Id     id;
    Frame  frame = 0;
    int    beats_per_bar = 4;
    int    beat_unit = 4;
};

// ---------------------------------------------------------------------------
// Region — a named sub-range of a Song that can carry its own transpose
// ---------------------------------------------------------------------------
struct Region {
    Id          id;
    std::string name;
    Frame       start_frame = 0;
    Frame       end_frame   = 0;
    Semitones   transpose_semitones = 0;

    // Per-region warp configuration. When enabled, the renderer time-stretches
    // every clip overlapping this region so the audio at `warp_source_bpm`
    // aligns with the timeline's effective tempo. Pitch is preserved.
    // `warp_source_bpm <= 0` (or NaN) is treated as "no warp" by the renderer
    // regardless of `warp_enabled`, mirroring the Rust validation.
    bool   warp_enabled    = false;
    double warp_source_bpm = 0.0;

    // Per-song master fader. The mixer multiplies the post-mix bus by this
    // value while the playhead lies inside the region. Defaults to unity.
    float master_gain = 1.0f;
};

// ---------------------------------------------------------------------------
// Song
// ---------------------------------------------------------------------------
struct Song {
    Id                    id;
    std::string           name;
    Frame                 start_frame = 0;
    Frame                 end_frame   = 0;
    double                bpm = 120.0;
    int                   beats_per_bar = 4;
    int                   beat_unit = 4;
    Semitones             transpose_semitones = 0;
    std::vector<Track>    tracks;
    std::vector<Marker>   markers;
    std::vector<TempoMarker> tempo_markers;
    std::vector<TimeSignatureMarker> time_signature_markers;
    std::vector<Region>   regions;
};

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------
struct Session {
    Id                    id;
    std::string           name;
    int                   sample_rate = 48000;
    std::vector<Song>     songs;
    std::vector<Source>   sources;
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
Result<void> validate_session(const Session& session);

// ---------------------------------------------------------------------------
// JSON round-trip (for diagnostics and command embedding, not performance path)
// ---------------------------------------------------------------------------
std::string session_to_json(const Session& session);
Result<Session> session_from_json(const std::string& json);

} // namespace lt
