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
    // No-op while pending_start_ is set so the playhead doesn't run ahead
    // during voice priming (Bungee needs ~600ms warm-up + ~110ms latency).
    void advance(int block_frames);

    // Called by audio thread on command execution.
    void play();
    void pause();
    void stop();
    void seek(Frame frame);

    // Audio thread: arm the "wait for first audible block" gate. Called from
    // play/seek paths so the next clock advance is held until the audio
    // thread reports a non-silent output block (see clear_pending_start).
    void arm_pending_start() { pending_start_ = true; }

    // Audio thread: clear the gate when the first non-silent block emerges
    // from the mixer. After this, advance() resumes normally.
    void clear_pending_start() { pending_start_ = false; }
    bool pending_start() const { return pending_start_; }

    // Resolve which song/region/marker the clock is in, given a session.
    // Called by audio thread after advance() or seek().
    void resolve_context(const Session& session);

    // Read-only snapshot (audio thread).
    ClockPosition position() const { return position_; }

    int sample_rate() const { return sample_rate_; }
    void set_sample_rate(int sample_rate);

private:
    int            sample_rate_;
    ClockPosition  position_;
    bool           pending_start_ = false;
};

} // namespace lt
