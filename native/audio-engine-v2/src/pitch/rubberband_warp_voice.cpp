#include <lt_engine/pitch/rubberband_warp_voice.h>

#ifndef LT_ENGINE_HAVE_RUBBERBAND
#  define LT_ENGINE_HAVE_RUBBERBAND 0
#endif

#if LT_ENGINE_HAVE_RUBBERBAND
#  include <rubberband/RubberBandStretcher.h>
#  include <algorithm>
#  include <cmath>
#  include <cstring>
#  include <vector>
#endif

namespace lt {

#if LT_ENGINE_HAVE_RUBBERBAND

struct RubberBandWarpVoice::Impl {
    int  sample_rate   = 0;
    int  channel_count = 0;
    int  max_in_frames = 0;
    bool ready         = false;

    long long source_cursor = 0;

    std::unique_ptr<RubberBand::RubberBandStretcher> stretcher;

    // RubberBand's API drains in chunks via retrieve(). It can yield more
    // frames than the caller asked for in a single render_block, so we
    // keep a small FIFO of leftover output between calls.
    std::vector<float> fifo_l;
    std::vector<float> fifo_r;
    int fifo_size = 0;

    // Scratch buffers for retrieving more than `out_frames` at once.
    std::vector<float> retrieve_l;
    std::vector<float> retrieve_r;
};

RubberBandWarpVoice::RubberBandWarpVoice()
    : impl_(std::make_unique<Impl>()) {}

RubberBandWarpVoice::~RubberBandWarpVoice() = default;
RubberBandWarpVoice::RubberBandWarpVoice(RubberBandWarpVoice&&) noexcept = default;
RubberBandWarpVoice& RubberBandWarpVoice::operator=(RubberBandWarpVoice&&) noexcept = default;

bool RubberBandWarpVoice::configure(int sample_rate,
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
        using RB = RubberBand::RubberBandStretcher;
        // R3 ("Finer") in realtime mode with the highest-quality flags
        // available without going offline. Same profile the bench measured.
        const int options =
            RB::OptionProcessRealTime
            | RB::OptionEngineFiner
            | RB::OptionTransientsMixed
            | RB::OptionWindowStandard
            | RB::OptionPitchHighQuality;
        impl_->stretcher = std::make_unique<RB>(
            sample_rate, channel_count, options,
            /*initial_time_ratio*/  1.0,
            /*initial_pitch_scale*/ 1.0);
        impl_->stretcher->setMaxProcessSize(max_input_frames_per_block);

        // 4x oversize for the retrieve scratch & FIFO — RubberBand can
        // emit a burst after warm-up that exceeds one output block.
        const int scratch_size = max_input_frames_per_block * 4;
        impl_->retrieve_l.assign(static_cast<size_t>(scratch_size), 0.f);
        impl_->retrieve_r.assign(static_cast<size_t>(scratch_size), 0.f);
        impl_->fifo_l.assign(static_cast<size_t>(scratch_size), 0.f);
        impl_->fifo_r.assign(static_cast<size_t>(scratch_size), 0.f);
        impl_->fifo_size = 0;

        impl_->source_cursor = 0;
        impl_->ready = true;
        return true;
    } catch (...) {
        impl_->stretcher.reset();
        return false;
    }
}

bool RubberBandWarpVoice::is_ready() const noexcept {
    return impl_ && impl_->ready;
}

const char* RubberBandWarpVoice::backend_name() const noexcept {
    return "rubberband_r3";
}

int RubberBandWarpVoice::input_latency_frames() const noexcept {
    if (!impl_ || !impl_->stretcher) return 0;
    return static_cast<int>(impl_->stretcher->getLatency());
}

int RubberBandWarpVoice::output_latency_frames() const noexcept {
    return input_latency_frames();
}

int RubberBandWarpVoice::render_block(const float* const* input,
                                       int                 input_frames,
                                       float* const*       output,
                                       int                 output_frames,
                                       double              time_ratio) noexcept {
    if (!impl_ || !impl_->ready || !impl_->stretcher
        || !input || !output
        || input_frames <= 0 || output_frames <= 0)
        return 0;

    try {
        // RubberBand defines time_ratio as output_duration / input_duration.
        // Our convention: ratio > 1 = output plays FASTER = shorter, so
        // RubberBand's time_ratio = 1 / ours.
        const double safe_ratio = time_ratio > 0.0 ? time_ratio : 1.0;
        impl_->stretcher->setTimeRatio(1.0 / safe_ratio);

        // First, drain any leftover FIFO into output.
        int written = 0;
        if (impl_->fifo_size > 0) {
            const int take = std::min(impl_->fifo_size, output_frames);
            for (int f = 0; f < take; ++f) {
                output[0][f] = impl_->fifo_l[static_cast<size_t>(f)];
                if (output[1]) output[1][f] = impl_->fifo_r[static_cast<size_t>(f)];
            }
            // Shift the remainder forward.
            const int leftover = impl_->fifo_size - take;
            if (leftover > 0) {
                std::memmove(impl_->fifo_l.data(),
                             impl_->fifo_l.data() + take,
                             static_cast<size_t>(leftover) * sizeof(float));
                std::memmove(impl_->fifo_r.data(),
                             impl_->fifo_r.data() + take,
                             static_cast<size_t>(leftover) * sizeof(float));
            }
            impl_->fifo_size = leftover;
            written += take;
        }

        // Feed input, then retrieve everything currently available.
        impl_->stretcher->process(input, input_frames, /*final*/ false);
        impl_->source_cursor += input_frames;

        int avail = impl_->stretcher->available();
        while (avail > 0 && (written < output_frames || impl_->fifo_size < static_cast<int>(impl_->fifo_l.size()))) {
            const int retrieve_cap = std::min(avail,
                static_cast<int>(impl_->retrieve_l.size()));
            float* drain[2] = { impl_->retrieve_l.data(), impl_->retrieve_r.data() };
            const int got = impl_->stretcher->retrieve(drain, retrieve_cap);
            if (got <= 0) break;

            // First fill the output buffer.
            int copy_to_out = std::min(got, output_frames - written);
            if (copy_to_out > 0) {
                for (int f = 0; f < copy_to_out; ++f) {
                    output[0][written + f] = impl_->retrieve_l[static_cast<size_t>(f)];
                    if (output[1])
                        output[1][written + f] = impl_->retrieve_r[static_cast<size_t>(f)];
                }
                written += copy_to_out;
            }

            // Anything left goes to the FIFO for the next call.
            const int spill = got - copy_to_out;
            if (spill > 0) {
                const int fifo_cap = static_cast<int>(impl_->fifo_l.size());
                const int can_fifo = std::min(spill, fifo_cap - impl_->fifo_size);
                if (can_fifo > 0) {
                    std::copy_n(impl_->retrieve_l.data() + copy_to_out, can_fifo,
                                impl_->fifo_l.data() + impl_->fifo_size);
                    std::copy_n(impl_->retrieve_r.data() + copy_to_out, can_fifo,
                                impl_->fifo_r.data() + impl_->fifo_size);
                    impl_->fifo_size += can_fifo;
                }
                // Anything past the FIFO cap is dropped — should be rare,
                // would mean RubberBand emitted >4 output blocks worth in
                // a single process() call.
            }
            avail = impl_->stretcher->available();
        }

        // Pad the tail if we still don't have a full block (RB warmup).
        if (written < output_frames) {
            for (int f = written; f < output_frames; ++f) {
                output[0][f] = 0.f;
                if (output[1]) output[1][f] = 0.f;
            }
        }
        return output_frames;
    } catch (...) {
        return 0;
    }
}

void RubberBandWarpVoice::reset_source_cursor(long long source_frame) noexcept {
    if (impl_) impl_->source_cursor = source_frame;
}

long long RubberBandWarpVoice::source_cursor() const noexcept {
    return impl_ ? impl_->source_cursor : 0;
}

#else

struct RubberBandWarpVoice::Impl {};

RubberBandWarpVoice::RubberBandWarpVoice() = default;
RubberBandWarpVoice::~RubberBandWarpVoice() = default;
RubberBandWarpVoice::RubberBandWarpVoice(RubberBandWarpVoice&&) noexcept = default;
RubberBandWarpVoice& RubberBandWarpVoice::operator=(RubberBandWarpVoice&&) noexcept = default;

bool RubberBandWarpVoice::configure(int, int, int) { return false; }
bool RubberBandWarpVoice::is_ready() const noexcept { return false; }
const char* RubberBandWarpVoice::backend_name() const noexcept { return "unavailable"; }
int RubberBandWarpVoice::input_latency_frames() const noexcept { return 0; }
int RubberBandWarpVoice::output_latency_frames() const noexcept { return 0; }
int RubberBandWarpVoice::render_block(const float* const*, int,
                                       float* const* output, int output_frames,
                                       double) noexcept {
    if (output && output_frames > 0) {
        for (int c = 0; c < 2; ++c)
            if (output[c])
                for (int f = 0; f < output_frames; ++f) output[c][f] = 0.f;
    }
    return 0;
}
void RubberBandWarpVoice::reset_source_cursor(long long) noexcept {}
long long RubberBandWarpVoice::source_cursor() const noexcept { return 0; }

#endif

} // namespace lt
