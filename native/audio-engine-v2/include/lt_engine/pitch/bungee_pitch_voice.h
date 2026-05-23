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

    // Control-thread prefill used by prepared jumps. It feeds source input to
    // Bungee and stores the produced output in the realtime FIFO without
    // delivering it yet, so tiny post-jump spans can be served without doing
    // the first synthesis call on the audio thread.
    int prime_output_fifo(const float* const* input,
                          int input_frames,
                          double pitch_scale) noexcept;

    // Output frames already produced by Bungee and waiting in the realtime
    // FIFO. TrackRenderer uses this to advance the next source read so partial
    // post-jump renders keep Bungee's input stream continuous.
    int queued_output_frames() const noexcept;

    // ── Latency / position introspection (per Bungee issue #38) ─────────
    //
    // Per the Bungee maintainer, the correct way to know the current
    // algorithmic delay is to query the Stream wrapper after at least one
    // process() call has returned output. Bungee Stream APIs:
    //   inputPosition()  - total input frames fed so far
    //   outputPosition() - input-frame position corresponding to current out
    //   latency()        - inputPosition() - outputPosition()
    //
    // These are reported in INPUT-rate frames. Before the first process()
    // call has produced output, latency() may return 0 or be undefined per
    // issue #23; callers should call render_block() at least once before
    // relying on this value.

    // Total input frames passed to the underlying Stream so far.
    long long input_position() const noexcept;

    // Input-frame position corresponding to the most recent output sample.
    double output_position() const noexcept;

    // Current algorithmic delay in input-rate frames. 0 when no Bungee voice
    // is alive (stub build). May be 0 until the first render_block() returns
    // a non-zero frame count.
    double latency_frames() const noexcept;
    int    alignment_compensation_frames(double pitch_scale) const noexcept;

    // Convenience: true when the next render_block() should produce useful,
    // timeline-aligned audio (i.e. latency has caught up). Equivalent to
    // latency_frames() < epsilon.
    bool   is_warm() const noexcept;

    // Re-arm the post-construction fade-in so the next `fade_ms` of OUTPUT
    // frames the caller receives are ramped from 0→1 (equal-power). Used by
    // BungeeVoiceManager after warm_voice() has consumed the initial fade
    // window with zero input — so the audio thread still gets the masking
    // ramp when it first asks for real audio. Default 5 ms.
    void arm_fade_in(int fade_ms = 5) noexcept;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace lt
