#pragma once

#include <lt_engine/core/types.h>
#include <lt_engine/sources/decoded_source.h>

#include <memory>
#include <vector>

#if LT_ENGINE_USE_RUBBERBAND && __has_include(<rubberband/RubberBandStretcher.h>)
#define LT_ENGINE_SEEK_SAFE_HAS_RUBBERBAND_HEADER 1
namespace RubberBand { class RubberBandStretcher; }
#elif LT_ENGINE_USE_RUBBERBAND && __has_include(<RubberBandStretcher.h>)
#define LT_ENGINE_SEEK_SAFE_HAS_RUBBERBAND_HEADER 1
namespace RubberBand { class RubberBandStretcher; }
#else
#define LT_ENGINE_SEEK_SAFE_HAS_RUBBERBAND_HEADER 0
#endif

namespace lt {

class SeekSafePitchStream {
public:
    struct Config {
        int sample_rate = 48000;
        int channel_count = 2;
        double semitones = 0.0;
    };

    SeekSafePitchStream();
    ~SeekSafePitchStream();

    void configure(const Config& config);
    void reset_for_seek(const DecodedSource& source, Frame target_source_frame);

    int render_aligned(const DecodedSource& source,
                       Frame source_frame,
                       int frame_count,
                       float** out,
                       int out_channels) noexcept;

    int start_pad_frames() const noexcept { return start_pad_frames_; }
    int start_delay_frames() const noexcept { return start_delay_frames_; }
    int preroll_frames() const noexcept { return preroll_frames_; }
    int discarded_frames() const noexcept { return discarded_frames_; }
    bool is_ready() const noexcept { return ready_; }
    Frame expected_source_frame() const noexcept { return expected_source_frame_; }

private:
    static constexpr int kMaxChannels = 32;
    static constexpr int kMaxChunkFrames = 4096;

    void ensure_buffers();
    void process_zeroes(int frames) noexcept;
    int process_source(const DecodedSource& source, Frame start, int frames) noexcept;
    int discard_available() noexcept;
    int retrieve_available(float** out, int out_channels, int offset, int frames) noexcept;
    void apply_reset_fade(float** out, int out_channels, int frames) noexcept;

    Config config_{};
    bool configured_ = false;
    bool ready_ = false;
    Frame expected_source_frame_ = -1;
    Frame feed_source_frame_ = 0;
    int start_pad_frames_ = 0;
    int start_delay_frames_ = 0;
    int preroll_frames_ = 0;
    int discard_remaining_ = 0;
    int discarded_frames_ = 0;
    int fade_frames_ = 0;
    int fade_processed_ = 0;
    int alignment_correction_frames_ = 0;

#if LT_ENGINE_SEEK_SAFE_HAS_RUBBERBAND_HEADER
    std::unique_ptr<RubberBand::RubberBandStretcher> rb_;
#endif
    std::vector<std::vector<float>> input_;
    std::vector<std::vector<float>> output_;
    std::vector<float*> input_ptrs_;
    std::vector<float*> output_ptrs_;
};

} // namespace lt
