#pragma once

// ---------------------------------------------------------------------------
// RubberBandPitchProcessor — wraps RubberBand Library v3 in realtime mode.
//
// Construction is expensive (allocates RubberBand state); do it off the audio
// thread.  process() is realtime-safe once constructed.
//
// Latency: RubberBand in realtime mode typically reports ~512–2048 frames of
// latency depending on pitch ratio and block size.  Query latency_frames()
// after construction and after the first process() call (it may refine after
// the first block).
// ---------------------------------------------------------------------------

#include <lt_engine/pitch/pitch_processor.h>
#include <memory>

#if LT_ENGINE_USE_RUBBERBAND && __has_include(<RubberBandStretcher.h>)
#define LT_ENGINE_HAS_RUBBERBAND_HEADER 1
namespace RubberBand { class RubberBandStretcher; }
#else
#define LT_ENGINE_HAS_RUBBERBAND_HEADER 0
#endif

namespace lt {

class RubberBandPitchProcessor : public PitchProcessor {
public:
    // Construct for a specific channel count and sample rate.
    // semitones: initial shift applied immediately.
    RubberBandPitchProcessor(int channel_count,
                              int sample_rate,
                              double semitones = 0.0);
    ~RubberBandPitchProcessor() override;

    void   reset()                                              noexcept override;
    int    process(float** in_out,
                   int     num_channels,
                   int     frame_count)                         noexcept override;
    void   set_semitones(double semitones)                     noexcept override;
    int    latency_frames()  const noexcept override;
    bool   is_bypass()       const noexcept override { return false; }
    const char* type_name()  const noexcept override { return "rubberband"; }

private:
#if LT_ENGINE_HAS_RUBBERBAND_HEADER
    std::unique_ptr<RubberBand::RubberBandStretcher> rb_;
    int    channel_count_;
    int    sample_rate_;
    double semitones_{0.0};

    // Scratch output buffers (allocated once, never resized on audio thread).
    static constexpr int kMaxBlockFrames = 4096;
    static constexpr int kMaxChannels    = 32;
    float  out_scratch_[kMaxChannels][kMaxBlockFrames]{};
    float* out_ptrs_[kMaxChannels]{};
#endif
};

} // namespace lt
