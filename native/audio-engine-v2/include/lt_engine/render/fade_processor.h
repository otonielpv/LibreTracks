#pragma once

#include <array>
#include <atomic>
#include <lt_engine/core/types.h>

namespace lt {

// Short smooth fade-in applied immediately after seeks/jumps. This is the
// first-stage discontinuity guard; a true old-tail/new-head crossfade can sit
// behind the same trigger later.
class FadeProcessor {
public:
    explicit FadeProcessor(int ramp_frames = -1);

    void trigger_fade_in() noexcept;
    void trigger_crossfade() noexcept { trigger_fade_in(); }
    void clear() noexcept;

    void process(float** channels, int num_channels, int num_frames) noexcept;

    bool is_active() const noexcept;
    int ramp_frames() const noexcept { return ramp_frames_; }

private:
    int ramp_frames_;
    int processed_ = 0;
    int remaining_ = 0;
    std::atomic<bool> triggered_{false};

    static constexpr int kMaxChannels = 8;
    std::array<float, kMaxChannels> previous_sample_{};
    int previous_channels_ = 0;
};

} // namespace lt
