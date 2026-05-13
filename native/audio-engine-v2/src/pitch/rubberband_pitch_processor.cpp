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
    : channel_count_(channel_count)
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

    // Pre-fill output pointer array.
    for (int ch = 0; ch < kMaxChannels; ++ch)
        out_ptrs_[ch] = out_scratch_[ch];
}

RubberBandPitchProcessor::~RubberBandPitchProcessor() = default;

void RubberBandPitchProcessor::reset() noexcept {
    rb_->reset();
    std::fill(std::begin(last_output_), std::end(last_output_), 0.0f);
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
    const int frames = std::min(frame_count, kMaxBlockFrames);

    // Feed the input block.
    rb_->process(in_out, static_cast<size_t>(frames), false);

    // Retrieve available output.
    int available = static_cast<int>(rb_->available());
    const int retrieve = std::clamp(available, 0, frames);
    if (retrieve > 0)
        rb_->retrieve(out_ptrs_, static_cast<size_t>(retrieve));

    // Copy back into caller's in_out buffers.
    for (int c = 0; c < ch; ++c) {
        if (retrieve > 0) {
            std::copy(out_scratch_[c], out_scratch_[c] + retrieve, in_out[c]);
            last_output_[c] = out_scratch_[c][retrieve - 1];
        }
        if (retrieve < frames)
            std::fill(in_out[c] + retrieve, in_out[c] + frames, last_output_[c]);
    }

    return frames;
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
