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
    std::vector<Clip>   clips;
};

// ---------------------------------------------------------------------------
// Marker — a named position within a Song
// ---------------------------------------------------------------------------
struct Marker {
    Id          id;
    std::string name;
    Frame       frame = 0;
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
