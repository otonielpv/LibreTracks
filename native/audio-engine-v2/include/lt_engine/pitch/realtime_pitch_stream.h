#pragma once

#include <lt_engine/core/types.h>
#include <lt_engine/sources/decoded_source.h>

#include <array>
#include <atomic>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#if LT_ENGINE_USE_RUBBERBAND && !LT_ENGINE_ALLOW_PITCH_STUB
namespace RubberBand { class RubberBandStretcher; }
#endif

namespace lt {

struct PitchStreamDiagnostics {
    std::uint64_t render_count = 0;
    std::uint64_t underflow_count = 0;
    std::uint64_t overflow_count = 0;
    std::uint64_t reset_count = 0;
    std::uint64_t prime_count = 0;
    std::uint64_t source_miss_count = 0;
    std::uint64_t emergency_silence_count = 0;
    std::uint64_t unsafe_cross_thread_reset_count = 0;
    std::uint64_t concurrent_stream_mutation_detected = 0;
    std::uint64_t active_stream_swap_count = 0;
    std::uint64_t active_stream_set_generation = 0;
    std::uint64_t active_pitch_stream_count = 0;
    std::uint64_t pitch_timeline_mismatch_count = 0;
    std::uint64_t pitch_stream_not_aligned_count = 0;
    std::uint64_t pitch_audio_thread_reset_count = 0;
    std::uint64_t pitch_audio_thread_prime_count = 0;
    std::uint64_t pitch_repair_requested_count = 0;
    std::uint64_t pitch_repair_completed_count = 0;
    std::uint64_t stream_generation = 0;
    std::uint64_t stream_reset_thread_id = 0;
    std::uint64_t stream_render_thread_id = 0;
    std::uint64_t long_seek_count = 0;
    Frame last_transport_discontinuity_target_frame = 0;
    std::string last_transport_discontinuity_reason;
    int start_delay_frames = 0;
    int preroll_frames = 0;
    int discarded_frames = 0;
    int compensated_latency_frames = 0;
    int ring_available_frames = 0;
    int ring_capacity_frames = 0;
    std::string active_render_path = "realtime_stream";
};

class SourceReadAheadCache {
public:
    void prepare_window(const DecodedSource& source, Frame start_frame, Frame frame_count) noexcept;
    bool is_ready(const DecodedSource& source, Frame start_frame, Frame frame_count) const noexcept;
    std::uint64_t miss_count() const noexcept { return miss_count_.load(std::memory_order_relaxed); }
    std::uint64_t prepare_count() const noexcept { return prepare_count_.load(std::memory_order_relaxed); }

private:
    mutable std::atomic<std::uint64_t> miss_count_{0};
    std::atomic<std::uint64_t> prepare_count_{0};
    std::atomic<const DecodedSource*> source_{nullptr};
    std::atomic<Frame> start_{0};
    std::atomic<Frame> end_{0};
};

class RealtimePitchStream {
public:
    struct Config {
        int sample_rate = 48000;
        int channel_count = 2;
        double semitones = 0.0;
        double pitch_scale = 1.0;
        int max_block_size = 4096;
        int preroll_frames = 2048;
        int ring_capacity_frames = 32768;
    };

    RealtimePitchStream();
    ~RealtimePitchStream();

    void configure(const Config& config);
    void reset_for_seek(const DecodedSource& source, Frame source_frame, Frame timeline_frame);
    bool prime(const DecodedSource& source, Frame timeline_frame, int min_output_frames);
    int render(const DecodedSource& source,
               Frame timeline_frame,
               int frame_count,
               float** out,
               int out_channels) noexcept;
    void set_pitch_ratio_or_reset(const DecodedSource& source,
                                  double semitones,
                                  Frame source_frame,
                                  Frame timeline_frame);

    PitchStreamDiagnostics diagnostics() const noexcept;
    void mark_published(std::uint64_t generation) noexcept;
    bool configured() const noexcept { return configured_; }
    Frame expected_timeline_frame() const noexcept { return current_output_timeline_frame_; }
    Frame current_source_frame() const noexcept { return current_source_frame_; }

private:
    static constexpr int kMaxChannels = 32;
    static constexpr int kScratchFrames = 4096;

    double semitones_to_ratio(double semitones) const noexcept;
    void allocate_buffers();
    void clear_ring() noexcept;
    int ring_available() const noexcept;
    int ring_free() const noexcept;
    void push_ring(float* const* channels, int frames) noexcept;
    int pop_ring(float** out, int out_channels, int offset, int frames) noexcept;
    int discard_ring(int frames) noexcept;
    int feed_required_input(const DecodedSource& source, int min_output_frames) noexcept;
    int process_source(const DecodedSource& source, Frame start, int frames) noexcept;
    int retrieve_to_ring() noexcept;
    void process_start_pad() noexcept;
    void apply_reset_ramp(float** out, int out_channels, int frames) noexcept;
    void note_control_mutation_if_published() noexcept;
    bool valid_ring_state() const noexcept;
    std::uint64_t current_thread_token() const noexcept;

    Config config_{};
    bool configured_ = false;
    bool primed_ = false;
    Frame current_source_frame_ = 0;
    Frame current_output_timeline_frame_ = 0;
    int start_delay_frames_ = 0;
    int discard_remaining_ = 0;
    int discarded_frames_ = 0;
    int reset_ramp_frames_ = 0;
    int reset_ramp_pos_ = 0;

#if LT_ENGINE_USE_RUBBERBAND && !LT_ENGINE_ALLOW_PITCH_STUB
    std::unique_ptr<RubberBand::RubberBandStretcher> stretcher_;
#endif

    std::vector<std::vector<float>> input_;
    std::vector<std::vector<float>> rb_output_;
    std::vector<float*> input_ptrs_;
    std::vector<float*> output_ptrs_;
    std::vector<std::vector<float>> ring_;
    int ring_read_ = 0;
    int ring_write_ = 0;
    int ring_size_ = 0;

    std::atomic<bool> published_{false};
    std::atomic<std::uint64_t> generation_{0};
    std::atomic<std::uint64_t> render_thread_id_{0};
    std::atomic<std::uint64_t> reset_thread_id_{0};
    std::atomic<std::uint64_t> mutation_owner_{0};
    std::atomic<std::uint64_t> render_count_{0};
    std::atomic<std::uint64_t> underflow_count_{0};
    std::atomic<std::uint64_t> overflow_count_{0};
    std::atomic<std::uint64_t> reset_count_{0};
    std::atomic<std::uint64_t> prime_count_{0};
    std::atomic<std::uint64_t> source_miss_count_{0};
    std::atomic<std::uint64_t> unsafe_cross_thread_reset_count_{0};
    std::atomic<std::uint64_t> concurrent_stream_mutation_detected_{0};
};

} // namespace lt
