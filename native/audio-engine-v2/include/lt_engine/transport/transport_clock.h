#pragma once

// ---------------------------------------------------------------------------
// TransportClock — single source of truth for the engine's frame position.
//
// Thread-safety: The clock is OWNED by the audio callback thread.
// Command thread must only call the thread-safe scheduling helpers.
// ---------------------------------------------------------------------------

#include <lt_engine/core/types.h>
#include <lt_engine/session/session.h>
#include <optional>

namespace lt {

enum class TransportState { Stopped, Playing, Paused };

struct ClockPosition {
    Frame          frame         = 0;
    double         seconds       = 0.0;
    TransportState state         = TransportState::Stopped;
    std::optional<Id> song_id;
    std::optional<Id> region_id;
    std::optional<Id> marker_id;
};

class TransportClock {
public:
    explicit TransportClock(int sample_rate);

    // Called by audio thread to advance the clock by one block.
    void advance(int block_frames);

    // Called by audio thread on command execution.
    void play();
    void pause();
    void stop();
    void seek(Frame frame);

    // Resolve which song/region/marker the clock is in, given a session.
    // Called by audio thread after advance() or seek().
    void resolve_context(const Session& session);

    // Read-only snapshot (audio thread).
    ClockPosition position() const { return position_; }

    int sample_rate() const { return sample_rate_; }

private:
    int            sample_rate_;
    ClockPosition  position_;
};

} // namespace lt
