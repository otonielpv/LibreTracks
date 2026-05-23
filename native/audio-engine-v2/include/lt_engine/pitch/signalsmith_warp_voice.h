#pragma once

// ---------------------------------------------------------------------------
// SignalsmithWarpVoice
//
// Audio-thread time-stretch using Signalsmith Stretch
// (https://github.com/Signalsmith-Audio/signalsmith-stretch, MIT).
//
// One instance per warp-active clip. Built on the control thread, rendered
// from the audio thread block-by-block. Unlike Bungee, Signalsmith is a
// pure time-stretch (it can transpose too but we keep that responsibility
// on Bungee — see WARP_BACKEND_COMPARISON.md). The voice consumes
// ceil(out_frames * time_ratio) input frames per render_block call.
//
// Compiled into a no-op when LT_ENGINE_HAVE_SIGNALSMITH is 0 so the engine
// builds normally on systems where Signalsmith is not available.
// ---------------------------------------------------------------------------

#include <lt_engine/core/types.h>

#include <memory>

namespace lt {

class SignalsmithWarpVoice {
public:
    SignalsmithWarpVoice();
    ~SignalsmithWarpVoice();

    SignalsmithWarpVoice(const SignalsmithWarpVoice&) = delete;
    SignalsmithWarpVoice& operator=(const SignalsmithWarpVoice&) = delete;
    SignalsmithWarpVoice(SignalsmithWarpVoice&&) noexcept;
    SignalsmithWarpVoice& operator=(SignalsmithWarpVoice&&) noexcept;

    // ── Lifetime (control thread) ────────────────────────────────────────

    bool configure(int sample_rate,
                   int channel_count,
                   int max_input_frames_per_block);

    bool is_ready() const noexcept;

    const char* backend_name() const noexcept;

    // ── DSP (audio thread, must not allocate) ────────────────────────────

    // Render up to `output_frames` time-stretched frames into `output`.
    // `time_ratio` is the source-advance multiplier per call: values >1
    // consume the source faster than output is produced (plays faster);
    // values <1 do the opposite. 1.0 is identity (no stretch).
    //
    // The caller must supply at least `ceil(output_frames * time_ratio)`
    // input frames in `input`. Returns the actual number of frames written
    // (always equal to output_frames for Signalsmith — it produces exactly
    // what was requested).
    int render_block(const float* const* input,
                     int input_frames,
                     float* const* output,
                     int output_frames,
                     double time_ratio) noexcept;

    // Algorithmic latency in input-rate frames. Constant for a given
    // sample rate after configure(); included so the renderer can pad/seek
    // correctly when the source ends and the voice still has tail audio.
    int input_latency_frames() const noexcept;
    int output_latency_frames() const noexcept;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace lt
