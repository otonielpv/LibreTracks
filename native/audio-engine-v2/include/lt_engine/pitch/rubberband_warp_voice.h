#pragma once

// ---------------------------------------------------------------------------
// RubberBandWarpVoice
//
// Time-stretch backend backed by RubberBand R3 ("Finer") in realtime mode.
// Higher quality on transients than Signalsmith Stretch at the cost of ~5x
// the CPU. Opt-in via LT_ENGINE_USE_RUBBERBAND because RubberBand is
// GPL v2 / commercial.
//
// Same shape as SignalsmithWarpVoice: implements the WarpVoice interface,
// owns its own source cursor so the renderer stays cursor-math-free.
//
// Compiled into a stub when LT_ENGINE_HAVE_RUBBERBAND is 0.
// ---------------------------------------------------------------------------

#include <lt_engine/core/types.h>
#include <lt_engine/pitch/warp_voice.h>

#include <memory>

namespace lt {

class RubberBandWarpVoice final : public WarpVoice {
public:
    RubberBandWarpVoice();
    ~RubberBandWarpVoice() override;

    RubberBandWarpVoice(const RubberBandWarpVoice&) = delete;
    RubberBandWarpVoice& operator=(const RubberBandWarpVoice&) = delete;
    RubberBandWarpVoice(RubberBandWarpVoice&&) noexcept;
    RubberBandWarpVoice& operator=(RubberBandWarpVoice&&) noexcept;

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
