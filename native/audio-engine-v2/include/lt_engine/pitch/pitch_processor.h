#pragma once

// ---------------------------------------------------------------------------
// PitchProcessor — abstract interface for realtime pitch shifting.
//
// Audio-thread contract (process()):
//   - No heap allocation.
//   - No blocking.
//   - Must tolerate any combination of semitones in [-24, +24].
//
// Latency:
//   - latency_frames() returns the inherent algorithmic delay of the
//     implementation.  The Mixer uses this to pre-seek the source by
//     latency_frames() so the audible output remains in sync.
// ---------------------------------------------------------------------------

#include <lt_engine/core/types.h>

namespace lt {

class PitchProcessor {
public:
    virtual ~PitchProcessor() = default;

    // Reset internal state (e.g., after a seek).
    virtual void reset() noexcept = 0;

    // Process `frame_count` frames in-place on each channel.
    // `in_out[ch]` points to a buffer of `frame_count` floats.
    // Writes the pitch-shifted output back into the same buffers.
    // Returns the number of frames written (may differ from frame_count
    // if the processor needs to accumulate latency).
    virtual int process(float** in_out,
                        int     num_channels,
                        int     frame_count) noexcept = 0;

    // Set transposition in semitones.  May be called from the audio thread
    // between process() calls (must be cheap / atomic).
    virtual void set_semitones(double semitones) noexcept = 0;

    // Algorithmic latency in output frames.
    virtual int latency_frames() const noexcept = 0;

    // True if no pitch shift is applied (bypass optimisation path).
    virtual bool is_bypass() const noexcept = 0;

    // Tag for diagnostics.
    virtual const char* type_name() const noexcept = 0;
};

} // namespace lt
