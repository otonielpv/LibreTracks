#pragma once

#include <lt_engine/core/types.h>
#include <optional>
#include <string>
#include <variant>

namespace lt {

// ---------------------------------------------------------------------------
// EngineEvent — notifications the engine emits to the caller.
// Poll via lt_audio_engine_poll_event() / EngineImpl::poll_event().
// ---------------------------------------------------------------------------

struct EvPlaybackStarted  { Frame frame; };
struct EvPlaybackPaused   { Frame frame; };
struct EvPlaybackStopped  { Frame frame; };
struct EvSeekExecuted     { Frame from_frame; Frame to_frame; };

struct EvJumpScheduled {
    Id          jump_id;
    std::string target_description;
};

struct EvJumpCancelled { Id jump_id; };

struct EvJumpExecuted {
    Id     jump_id;
    Frame  from_frame;
    Frame  to_frame;
};

struct EvJumpFailed {
    Id          jump_id;
    std::string reason;
};

struct EvDeviceChanged {
    std::string device_id;
    std::string device_name;
    int         sample_rate;
    int         buffer_size;
};

struct EvDeviceError { std::string message; };

struct EvSourcePrepared   { Id source_id; };
struct EvSourceStarved    { Id source_id; Id track_id; };
struct EvPitchCachePrepared { Id source_id; Semitones semitones; };

struct EvDiagnosticWarning { std::string message; };

// ---------------------------------------------------------------------------
// Union type
// ---------------------------------------------------------------------------
using EngineEvent = std::variant<
    EvPlaybackStarted, EvPlaybackPaused, EvPlaybackStopped,
    EvSeekExecuted,
    EvJumpScheduled, EvJumpCancelled, EvJumpExecuted, EvJumpFailed,
    EvDeviceChanged, EvDeviceError,
    EvSourcePrepared, EvSourceStarved, EvPitchCachePrepared,
    EvDiagnosticWarning
>;

std::string event_to_json(const EngineEvent& ev);

} // namespace lt
