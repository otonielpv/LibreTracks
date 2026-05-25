#pragma once

// ---------------------------------------------------------------------------
// BungeeWarpVoice
//
// Time-stretch backend backed by Bungee::Stream. This mirrors the Bungee
// pitch voice integration, but locks pitch to 1.0 and exposes the WarpVoice
// cursor contract used by TrackRenderer.
//
// Compiled into a stub when LT_ENGINE_HAVE_BUNGEE is 0.
// ---------------------------------------------------------------------------

#include <lt_engine/core/types.h>
#include <lt_engine/pitch/warp_voice.h>

#include <memory>

namespace lt {

class BungeeWarpVoice final : public WarpVoice {
public:
    BungeeWarpVoice();
    ~BungeeWarpVoice() override;

    BungeeWarpVoice(const BungeeWarpVoice&) = delete;
    BungeeWarpVoice& operator=(const BungeeWarpVoice&) = delete;
    BungeeWarpVoice(BungeeWarpVoice&&) noexcept;
    BungeeWarpVoice& operator=(BungeeWarpVoice&&) noexcept;

    bool configure(int sample_rate,
                   int channel_count,
                   int max_input_frames_per_block);

    bool        is_ready()              const noexcept override;
    const char* backend_name()          const noexcept override;
    int         input_latency_frames()  const noexcept override;
    int         output_latency_frames() const noexcept override;
    bool        needs_source_latency_compensation() const noexcept override;

    int render_block(const float* const* input,
                     int                 input_frames,
                     float* const*       output,
                     int                 output_frames,
                     double              time_ratio) noexcept override;

    void advance_silent(int input_frames) noexcept override;
    void reset_source_cursor(long long source_frame) noexcept override;
    long long source_cursor() const noexcept override;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace lt
