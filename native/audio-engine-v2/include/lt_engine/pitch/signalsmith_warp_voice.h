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
#include <lt_engine/pitch/warp_voice.h>

#include <memory>

namespace lt {

class SignalsmithWarpVoice final : public WarpVoice {
public:
    SignalsmithWarpVoice();
    ~SignalsmithWarpVoice() override;

    SignalsmithWarpVoice(const SignalsmithWarpVoice&) = delete;
    SignalsmithWarpVoice& operator=(const SignalsmithWarpVoice&) = delete;
    SignalsmithWarpVoice(SignalsmithWarpVoice&&) noexcept;
    SignalsmithWarpVoice& operator=(SignalsmithWarpVoice&&) noexcept;

    // Configure for a given sample-rate / channel-count. max_input_frames
    // is accepted for parity with BungeePitchVoice but Signalsmith ignores
    // it (it sizes internally from sample rate). Returns true on success.
    bool configure(int sample_rate,
                   int channel_count,
                   int max_input_frames_per_block);

    bool        is_ready()              const noexcept override;
    const char* backend_name()          const noexcept override;
    int         input_latency_frames()  const noexcept override;
    int         output_latency_frames() const noexcept override;

    int render_block(const float* const* input,
                     int                 input_frames,
                     float* const*       output,
                     int                 output_frames,
                     double              time_ratio) noexcept override;

    void      reset_source_cursor(long long source_frame) noexcept override;
    long long source_cursor()                  const noexcept override;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace lt
