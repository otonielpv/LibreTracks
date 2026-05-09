#include <lt_engine/render/fade_processor.h>
#include <algorithm>
#include <cmath>

namespace lt {

FadeProcessor::FadeProcessor(int ramp_frames)
    : ramp_frames_(ramp_frames) {}

void FadeProcessor::trigger_crossfade() noexcept {
    triggered_.store(true, std::memory_order_release);
}

bool FadeProcessor::is_active() const noexcept {
    return remaining_ > 0 || triggered_.load(std::memory_order_acquire);
}

void FadeProcessor::process(float** channels, int num_channels,
                              int num_frames) noexcept {
    // Latch trigger from command thread.
    if (triggered_.exchange(false, std::memory_order_acq_rel)) {
        remaining_   = ramp_frames_ * 2;  // fade-out + fade-in
        fading_out_  = true;
    }

    if (remaining_ <= 0) return;

    for (int f = 0; f < num_frames && remaining_ > 0; ++f, --remaining_) {
        float gain;
        if (fading_out_) {
            // Fade-out: ramp_frames_ → 0
            int pos   = ramp_frames_ - remaining_;
            gain      = 1.f - static_cast<float>(pos) / ramp_frames_;
            if (remaining_ <= ramp_frames_) {
                // Switch to fade-in halfway.
                fading_out_ = false;
            }
        } else {
            // Fade-in: 0 → ramp_frames_
            int pos   = ramp_frames_ - remaining_;
            gain      = static_cast<float>(pos) / ramp_frames_;
        }

        // Clamp gain [0,1].
        gain = std::max(0.f, std::min(1.f, gain));

        for (int ch = 0; ch < num_channels; ++ch)
            channels[ch][f] *= gain;
    }
}

} // namespace lt
