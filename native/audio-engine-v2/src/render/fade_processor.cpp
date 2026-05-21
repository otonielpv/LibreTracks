#include <lt_engine/render/fade_processor.h>

#include <algorithm>
#include <cstdlib>
#include <limits>

namespace lt {

namespace {

int configured_ramp_frames(int requested) noexcept {
    int value = requested > 0 ? requested : 128;
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

void FadeProcessor::capture_previous_sample(float** channels, int num_channels, int frame_index) noexcept {
    if (!channels || num_channels <= 0 || frame_index < 0)
        return;
    const int channel_count = std::clamp(num_channels, 0, kMaxChannels);
    for (int ch = 0; ch < channel_count; ++ch)
        previous_sample_[static_cast<std::size_t>(ch)] =
            channels[ch] ? channels[ch][frame_index] : 0.0f;
    previous_channels_ = channel_count;
}

void FadeProcessor::clear() noexcept {
    triggered_.store(false, std::memory_order_release);
    processed_ = 0;
    remaining_ = 0;
    previous_sample_.fill(0.0f);
    fade_anchor_sample_.fill(0.0f);
    previous_channels_ = 0;
    fade_anchor_channels_ = 0;
}

bool FadeProcessor::is_active() const noexcept {
    return remaining_ > 0 || triggered_.load(std::memory_order_acquire);
}

void FadeProcessor::process(float** channels, int num_channels, int num_frames) noexcept {
    if (num_channels <= 0 || num_frames <= 0)
        return;

    const int channel_count = std::clamp(num_channels, 0, kMaxChannels);
    if (triggered_.exchange(false, std::memory_order_acq_rel)) {
        processed_ = 0;
        remaining_ = ramp_frames_;
        fade_anchor_sample_ = previous_sample_;
        fade_anchor_channels_ = previous_channels_;
    }

    const auto old_sample = fade_anchor_sample_;
    const int old_channels = fade_anchor_channels_;

    for (int f = 0; f < num_frames && remaining_ > 0; ++f) {
        const float progress = ramp_frames_ <= 1
            ? 1.0f
            : static_cast<float>(processed_) / static_cast<float>(ramp_frames_ - 1);
        const float gain = smoothstep(progress);
        const float old_gain = 1.0f - gain;

        for (int ch = 0; ch < num_channels; ++ch) {
            const float old = (ch < old_channels && ch < kMaxChannels)
                ? old_sample[static_cast<std::size_t>(ch)]
                : 0.0f;
            channels[ch][f] = channels[ch][f] * gain + old * old_gain;
        }

        ++processed_;
        --remaining_;
    }

    for (int ch = 0; ch < channel_count; ++ch) {
        previous_sample_[static_cast<std::size_t>(ch)] =
            channels[ch] ? channels[ch][num_frames - 1] : 0.0f;
    }
    previous_channels_ = channel_count;
}

} // namespace lt
