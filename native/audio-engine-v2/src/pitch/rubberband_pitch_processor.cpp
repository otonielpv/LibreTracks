#include <lt_engine/pitch/rubberband_pitch_processor.h>
#include <cmath>
#include <algorithm>

#if LT_ENGINE_USE_RUBBERBAND && __has_include(<rubberband/RubberBandStretcher.h>)
#  define LT_ENGINE_HAS_RUBBERBAND_IMPL 1
#  include <rubberband/RubberBandStretcher.h>
#  define LT_ENGINE_RUBBERBAND_HEADER_FOUND 1
#elif LT_ENGINE_USE_RUBBERBAND && __has_include(<RubberBandStretcher.h>)
#  define LT_ENGINE_HAS_RUBBERBAND_IMPL 1
#  include <RubberBandStretcher.h>
#  define LT_ENGINE_RUBBERBAND_HEADER_FOUND 1
#else
#  define LT_ENGINE_HAS_RUBBERBAND_IMPL 0
#endif

namespace lt {

#if LT_ENGINE_HAS_RUBBERBAND_IMPL

static inline double semitones_to_ratio(double semitones) noexcept {
    return std::pow(2.0, semitones / 12.0);
}

RubberBandPitchProcessor::RubberBandPitchProcessor(int channel_count,
                                                    int sample_rate,
                                                    double semitones)
    : channel_count_(std::clamp(channel_count, 1, kMaxChannels))
    , sample_rate_(sample_rate)
    , semitones_(semitones)
{
    using RBOption = RubberBand::RubberBandStretcher::Option;
    int options = RBOption::OptionProcessRealTime
                | RBOption::OptionPitchHighConsistency
                | RBOption::OptionChannelsTogether;

    rb_ = std::make_unique<RubberBand::RubberBandStretcher>(
        static_cast<size_t>(sample_rate),
        static_cast<size_t>(channel_count),
        options,
        1.0,                               // time ratio = 1 (pitch-only)
        semitones_to_ratio(semitones));

    const int channels = std::clamp(channel_count_, 1, kMaxChannels);
    out_scratch_.resize(static_cast<std::size_t>(channels));
    out_ptrs_.resize(static_cast<std::size_t>(channels), nullptr);
}

RubberBandPitchProcessor::~RubberBandPitchProcessor() = default;

void RubberBandPitchProcessor::reset() noexcept {
    rb_->reset();
}

void RubberBandPitchProcessor::set_semitones(double semitones) noexcept {
    if (semitones == semitones_) return;
    semitones_ = semitones;
    rb_->setPitchScale(semitones_to_ratio(semitones));
}

int RubberBandPitchProcessor::latency_frames() const noexcept {
    return static_cast<int>(rb_->getLatency());
}

int RubberBandPitchProcessor::process(float** in_out,
                                       int     num_channels,
                                       int     frame_count) noexcept {
    const int ch = std::min(num_channels, kMaxChannels);
    if (ch <= 0 || frame_count <= 0)
        return 0;
    const int frames = frame_count;

    try {
        if (static_cast<int>(out_scratch_.size()) < ch)
            out_scratch_.resize(static_cast<std::size_t>(ch));
        if (static_cast<int>(out_ptrs_.size()) < ch)
            out_ptrs_.resize(static_cast<std::size_t>(ch), nullptr);
        for (int c = 0; c < ch; ++c) {
            auto& channel = out_scratch_[static_cast<std::size_t>(c)];
            if (static_cast<int>(channel.size()) < frames)
                channel.resize(static_cast<std::size_t>(frames), 0.0f);
            out_ptrs_[static_cast<std::size_t>(c)] = channel.data();
        }
    } catch (...) {
        for (int c = 0; c < ch; ++c)
            std::fill(in_out[c], in_out[c] + frames, 0.0f);
        return 0;
    }

    // Feed the input block.
    rb_->process(in_out, static_cast<size_t>(frames), false);

    // Retrieve available output.
    int available = static_cast<int>(rb_->available());
    const int retrieve = std::clamp(available, 0, frames);
    if (retrieve > 0)
        rb_->retrieve(out_ptrs_.data(), static_cast<size_t>(retrieve));

    // Copy back into caller's in_out buffers.
    for (int c = 0; c < ch; ++c) {
        if (retrieve > 0) {
            const auto& channel = out_scratch_[static_cast<std::size_t>(c)];
            if (retrieve <= static_cast<int>(channel.size()))
                std::copy(channel.begin(), channel.begin() + retrieve, in_out[c]);
        }
        if (retrieve < frames)
            std::fill(in_out[c] + retrieve, in_out[c] + frames, 0.0f);
    }

    return retrieve;
}

#else  // !LT_ENGINE_USE_RUBBERBAND — stub

RubberBandPitchProcessor::RubberBandPitchProcessor(int, int, double) {}
RubberBandPitchProcessor::~RubberBandPitchProcessor() = default;
void RubberBandPitchProcessor::reset()                          noexcept {}
void RubberBandPitchProcessor::set_semitones(double)           noexcept {}
int  RubberBandPitchProcessor::latency_frames() const          noexcept { return 0; }
int  RubberBandPitchProcessor::process(float**, int, int fc)   noexcept { return fc; }

#endif // LT_ENGINE_USE_RUBBERBAND

} // namespace lt
