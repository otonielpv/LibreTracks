#include <lt_engine/pitch/signalsmith_warp_voice.h>

#ifndef LT_ENGINE_HAVE_SIGNALSMITH
#  define LT_ENGINE_HAVE_SIGNALSMITH 0
#endif

#if LT_ENGINE_HAVE_SIGNALSMITH
#  include <signalsmith-stretch/signalsmith-stretch.h>
#  include <algorithm>
#  include <cmath>
#endif

namespace lt {

#if LT_ENGINE_HAVE_SIGNALSMITH

struct SignalsmithWarpVoice::Impl {
    int  sample_rate   = 0;
    int  channel_count = 0;
    int  max_in_frames = 0;
    bool ready         = false;

    signalsmith::stretch::SignalsmithStretch<float> stretcher;
};

SignalsmithWarpVoice::SignalsmithWarpVoice()
    : impl_(std::make_unique<Impl>()) {}

SignalsmithWarpVoice::~SignalsmithWarpVoice() = default;
SignalsmithWarpVoice::SignalsmithWarpVoice(SignalsmithWarpVoice&&) noexcept = default;
SignalsmithWarpVoice& SignalsmithWarpVoice::operator=(SignalsmithWarpVoice&&) noexcept = default;

bool SignalsmithWarpVoice::configure(int sample_rate,
                                      int channel_count,
                                      int max_input_frames_per_block) {
    if (!impl_) return false;
    if (sample_rate <= 0 || channel_count <= 0 || max_input_frames_per_block <= 0)
        return false;
    impl_->sample_rate   = sample_rate;
    impl_->channel_count = channel_count;
    impl_->max_in_frames = max_input_frames_per_block;
    impl_->ready         = false;
    try {
        // presetDefault is what the bench measured. splitComputation=false
        // keeps each process() call synchronous; we can revisit that later
        // if a longer block size lets us amortise FFT cost.
        impl_->stretcher.presetDefault(
            channel_count,
            static_cast<float>(sample_rate),
            /*splitComputation*/ false);
        impl_->stretcher.setTransposeSemitones(0.0f);
        impl_->ready = true;
        return true;
    } catch (...) {
        return false;
    }
}

bool SignalsmithWarpVoice::is_ready() const noexcept {
    return impl_ && impl_->ready;
}

const char* SignalsmithWarpVoice::backend_name() const noexcept {
    return "signalsmith_stretch";
}

int SignalsmithWarpVoice::render_block(const float* const* input,
                                        int input_frames,
                                        float* const* output,
                                        int output_frames,
                                        double time_ratio) noexcept {
    if (!impl_ || !impl_->ready || !input || !output
        || output_frames <= 0 || input_frames <= 0)
        return 0;

    // Signalsmith's process() expects sample-precise input length matching
    // ceil(output * speed) but it's also resilient to slight surplus —
    // anything past the required count it ignores. We honour the caller's
    // contract: feed input_frames, produce output_frames at the given
    // ratio (speed). Caller is responsible for sizing input correctly.
    (void)time_ratio;
    try {
        impl_->stretcher.process(input, input_frames,
                                 output, output_frames);
    } catch (...) {
        return 0;
    }
    return output_frames;
}

int SignalsmithWarpVoice::input_latency_frames() const noexcept {
    return impl_ ? impl_->stretcher.inputLatency() : 0;
}

int SignalsmithWarpVoice::output_latency_frames() const noexcept {
    return impl_ ? impl_->stretcher.outputLatency() : 0;
}

#else

struct SignalsmithWarpVoice::Impl {};

SignalsmithWarpVoice::SignalsmithWarpVoice() = default;
SignalsmithWarpVoice::~SignalsmithWarpVoice() = default;
SignalsmithWarpVoice::SignalsmithWarpVoice(SignalsmithWarpVoice&&) noexcept = default;
SignalsmithWarpVoice& SignalsmithWarpVoice::operator=(SignalsmithWarpVoice&&) noexcept = default;

bool SignalsmithWarpVoice::configure(int, int, int) { return false; }
bool SignalsmithWarpVoice::is_ready() const noexcept { return false; }
const char* SignalsmithWarpVoice::backend_name() const noexcept { return "unavailable"; }
int SignalsmithWarpVoice::render_block(const float* const*, int,
                                        float* const* output, int output_frames,
                                        double) noexcept {
    if (output && output_frames > 0) {
        for (int c = 0; c < 2; ++c)
            if (output[c])
                for (int f = 0; f < output_frames; ++f)
                    output[c][f] = 0.0f;
    }
    return 0;
}
int SignalsmithWarpVoice::input_latency_frames() const noexcept { return 0; }
int SignalsmithWarpVoice::output_latency_frames() const noexcept { return 0; }

#endif

} // namespace lt
