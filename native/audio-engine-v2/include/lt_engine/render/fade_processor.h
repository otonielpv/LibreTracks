#pragma once

// ---------------------------------------------------------------------------
// FadeProcessor — click-free fade-in/out and crossfade around discontinuities.
//
// All operations are realtime-safe (no alloc, no lock).
// Applied immediately after a seek or jump to eliminate the DC offset click
// that occurs when audio resumes mid-waveform.
// ---------------------------------------------------------------------------

#include <atomic>
#include <lt_engine/core/types.h>

namespace lt {

// Short fade applied to the output buffer right after a seek/jump.
// Length is configurable at construction; default is 256 samples (~5ms @ 48k).
class FadeProcessor {
public:
    explicit FadeProcessor(int ramp_frames = 256);

    // Trigger a fade-out then fade-in pair starting at the next render call.
    // Safe to call from command thread; render() reads the flag atomically.
    void trigger_crossfade() noexcept;

    // Apply the fade ramp (if active) to a stereo buffer in-place.
    // Called from the audio thread inside render().
    void process(float** channels, int num_channels, int num_frames) noexcept;

    bool is_active() const noexcept;

private:
    int  ramp_frames_;
    int  remaining_  = 0;    // frames left in current ramp
    bool fading_out_ = false; // true = fade-out phase, false = fade-in phase
    std::atomic<bool> triggered_{false};
};

} // namespace lt
