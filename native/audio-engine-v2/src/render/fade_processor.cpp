#include <lt_engine/render/fade_processor.h>

#include <algorithm>
#include <cstdlib>
#include <limits>

namespace lt {

namespace {

int configured_ramp_frames(int requested) noexcept {
    int value = requested > 0 ? requested : 256;
    if (requested <= 0) {
        if (const char* env = std::getenv("LIBRETRACKS_SEEK_FADE_FRAMES")) {
            char* end = nullptr;
            long parsed = std::strtol(env, &end, 10);
            if (end != env && parsed > 0 && parsed <= std::numeric_limits<int>::max())
                value = static_cast<int>(parsed);
        }
    }
    return std::clamp(value, 1, 8192);
}

float smoothstep(float x) noexcept {
    x = std::clamp(x, 0.0f, 1.0f);
    return x * x * (3.0f - 2.0f * x);
}

} // namespace

FadeProcessor::FadeProcessor(int ramp_frames)
    : ramp_frames_(configured_ramp_frames(ramp_frames)) {}

void FadeProcessor::trigger_fade_in() noexcept {
    triggered_.store(true, std::memory_order_release);
}

void FadeProcessor::clear() noexcept {
    triggered_.store(false, std::memory_order_release);
    processed_ = 0;
    remaining_ = 0;
}

bool FadeProcessor::is_active() const noexcept {
    return remaining_ > 0 || triggered_.load(std::memory_order_acquire);
}

void FadeProcessor::process(float** channels, int num_channels, int num_frames) noexcept {
    if (triggered_.exchange(false, std::memory_order_acq_rel)) {
        processed_ = 0;
        remaining_ = ramp_frames_;
    }

    if (remaining_ <= 0 || num_channels <= 0 || num_frames <= 0)
        return;

    for (int f = 0; f < num_frames && remaining_ > 0; ++f) {
        const float progress = ramp_frames_ <= 1
            ? 1.0f
            : static_cast<float>(processed_) / static_cast<float>(ramp_frames_ - 1);
        const float gain = smoothstep(progress);

        for (int ch = 0; ch < num_channels; ++ch)
            channels[ch][f] *= gain;

        ++processed_;
        --remaining_;
    }
}

} // namespace lt
