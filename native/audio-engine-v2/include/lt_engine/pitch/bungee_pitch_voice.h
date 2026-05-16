#pragma once

// ---------------------------------------------------------------------------
// BungeePitchVoice
//
// Audio-thread pitch shifting using the Bungee library
// (https://github.com/bungee-audio-stretch/bungee, MPL-2.0).
//
// One instance per (clip x active-pitch) voice. Built on the control thread,
// rendered from the audio thread block-by-block. The wrapped Bungee::Stream
// API supports forward playback only; for seek/jump the recommended pattern
// (per upstream issue #16) is to destroy and reconstruct the voice.
//
// Compiled into a no-op when LT_ENGINE_HAVE_BUNGEE is 0 so the engine
// builds normally on systems where Bungee is not available.
// ---------------------------------------------------------------------------

#include <lt_engine/core/types.h>

#include <memory>

namespace lt {

class BungeePitchVoice {
public:
    BungeePitchVoice();
    ~BungeePitchVoice();

    BungeePitchVoice(const BungeePitchVoice&) = delete;
    BungeePitchVoice& operator=(const BungeePitchVoice&) = delete;
    BungeePitchVoice(BungeePitchVoice&&) noexcept;
    BungeePitchVoice& operator=(BungeePitchVoice&&) noexcept;

    // ── Lifetime (control thread) ────────────────────────────────────────

    // Construct the underlying Stretcher and Stream. Call once before any
    // render_block(). Safe to call again to reconfigure (allocates).
    // Returns true on success; false means the build was compiled without
    // Bungee or configuration failed.
    bool configure(int sample_rate,
                   int channel_count,
                   int max_input_frames_per_block);

    // True when configure() succeeded and the voice is ready to render.
    bool is_ready() const noexcept;

    // Returns "bungee_basic" when active, "unavailable" otherwise.
    const char* backend_name() const noexcept;

    // ── DSP (audio thread, must not allocate) ────────────────────────────

    // Render up to output_frames pitched output frames into out[0..channels-1].
    // input is planar source audio: input[ch] points to input_frames floats.
    // pitch_scale is a frequency multiplier; 1.0 = no change, 0.5 = octave
    // down, 2.0 = octave up. Bungee accepts a new pitch value every call,
    // gaplessly.
    // Returns the actual number of output frames produced (may be less than
    // output_frames; remaining samples are left as written by the caller).
    int render_block(const float* const* input,
                     int input_frames,
                     float* const* output,
                     int output_frames,
                     double pitch_scale) noexcept;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace lt
