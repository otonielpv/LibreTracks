#include <lt_engine/pitch/bungee_pitch_voice.h>

// File is intentionally a no-op when Bungee is not compiled in.
#ifndef LT_ENGINE_HAVE_BUNGEE
#  define LT_ENGINE_HAVE_BUNGEE 0
#endif

#if LT_ENGINE_HAVE_BUNGEE
// Bungee's Stream.h uses std::vector / std::span / std::ceil without including
// the corresponding headers; pull them in before Bungee so MSVC can compile.
#  include <cmath>
#  include <span>
#  include <vector>
#  include <bungee/Bungee.h>
#  include <bungee/Stream.h>
#endif

#include <algorithm>

namespace lt {

#if LT_ENGINE_HAVE_BUNGEE

// ─── Active Bungee-backed implementation ────────────────────────────────

struct BungeePitchVoice::Impl {
    using Edition  = Bungee::Basic;
    using Stretcher = Bungee::Stretcher<Edition>;
    using Stream    = Bungee::Stream<Edition>;

    int sample_rate   = 0;
    int channel_count = 0;
    int max_in_frames = 0;
    bool ready        = false;

    std::unique_ptr<Stretcher> stretcher;
    std::unique_ptr<Stream>    stream;
};

BungeePitchVoice::BungeePitchVoice()
    : impl_(std::make_unique<Impl>()) {}

BungeePitchVoice::~BungeePitchVoice() = default;

BungeePitchVoice::BungeePitchVoice(BungeePitchVoice&&) noexcept = default;
BungeePitchVoice& BungeePitchVoice::operator=(BungeePitchVoice&&) noexcept = default;

bool BungeePitchVoice::configure(int sample_rate,
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
        Bungee::SampleRates rates{sample_rate, sample_rate};
        impl_->stretcher = std::make_unique<Impl::Stretcher>(rates, channel_count);
        // Stream allocates an internal overlap buffer sized to:
        //   stretcher.maxInputFrameCount() + max_input_frames_per_block
        impl_->stream = std::make_unique<Impl::Stream>(
            *impl_->stretcher, max_input_frames_per_block, channel_count);
    } catch (...) {
        impl_->stretcher.reset();
        impl_->stream.reset();
        return false;
    }
    impl_->ready = true;
    return true;
}

bool BungeePitchVoice::is_ready() const noexcept {
    return impl_ && impl_->ready;
}

const char* BungeePitchVoice::backend_name() const noexcept {
    return "bungee_basic";
}

int BungeePitchVoice::render_block(const float* const* input,
                                    int input_frames,
                                    float* const* output,
                                    int output_frames,
                                    double pitch_scale) noexcept {
    if (!impl_ || !impl_->ready || !impl_->stream || input_frames < 0 || output_frames <= 0)
        return 0;
    if (!output) return 0;
    // Bungee::Stream::process signature:
    //   process(const float* const* inputPointers,
    //           float* const* outputPointers,
    //           int inputFrameCount,
    //           double outputFrameCount,
    //           double pitch = 1.0);
    // Returns the number of output frames actually produced.
    return impl_->stream->process(
        input,
        output,
        input_frames,
        static_cast<double>(output_frames),
        pitch_scale);
}

long long BungeePitchVoice::input_position() const noexcept {
    if (!impl_ || !impl_->stream) return 0;
    return static_cast<long long>(impl_->stream->inputPosition());
}

double BungeePitchVoice::output_position() const noexcept {
    if (!impl_ || !impl_->stream) return 0.0;
    return impl_->stream->outputPosition();
}

double BungeePitchVoice::latency_frames() const noexcept {
    if (!impl_ || !impl_->stream) return 0.0;
    return impl_->stream->latency();
}

bool BungeePitchVoice::is_warm() const noexcept {
    if (!impl_ || !impl_->stream) return false;
    // Stream::latency() reports input-rate frames. "Warm" = output has caught
    // up to within one block of the input we've fed (cheap and stable).
    return impl_->stream->latency() < static_cast<double>(impl_->max_in_frames);
}

#else // !LT_ENGINE_HAVE_BUNGEE

// ─── Stub when Bungee is not compiled in ────────────────────────────────

struct BungeePitchVoice::Impl {};

BungeePitchVoice::BungeePitchVoice() = default;
BungeePitchVoice::~BungeePitchVoice() = default;
BungeePitchVoice::BungeePitchVoice(BungeePitchVoice&&) noexcept = default;
BungeePitchVoice& BungeePitchVoice::operator=(BungeePitchVoice&&) noexcept = default;

bool BungeePitchVoice::configure(int, int, int) { return false; }
bool BungeePitchVoice::is_ready() const noexcept { return false; }
const char* BungeePitchVoice::backend_name() const noexcept { return "unavailable"; }

long long BungeePitchVoice::input_position() const noexcept { return 0; }
double    BungeePitchVoice::output_position() const noexcept { return 0.0; }
double    BungeePitchVoice::latency_frames() const noexcept  { return 0.0; }
bool      BungeePitchVoice::is_warm() const noexcept         { return false; }

int BungeePitchVoice::render_block(const float* const* /*input*/,
                                    int /*input_frames*/,
                                    float* const* output,
                                    int output_frames,
                                    double /*pitch_scale*/) noexcept {
    // Silence: clear the output buffers so callers don't get garbage.
    if (output && output_frames > 0) {
        // We don't know channel count at this point; caller passes its own
        // channel array. Conservatively try the first two channels — engines
        // that pass more will see uninitialized memory in higher channels.
        // Stub mode is only used when Bungee was not compiled in, so this
        // branch should not be hit in production builds.
        for (int ch = 0; ch < 2; ++ch) {
            if (output[ch])
                std::fill(output[ch], output[ch] + output_frames, 0.0f);
        }
    }
    return 0;
}

#endif // LT_ENGINE_HAVE_BUNGEE

} // namespace lt
