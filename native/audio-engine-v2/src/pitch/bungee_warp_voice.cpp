#include <lt_engine/pitch/bungee_warp_voice.h>

#ifndef LT_ENGINE_HAVE_BUNGEE
#  define LT_ENGINE_HAVE_BUNGEE 0
#endif

#include <algorithm>
#include <cmath>
#include <vector>

#if LT_ENGINE_HAVE_BUNGEE
#  include <bungee/Bungee.h>
#  include <bungee/Stream.h>
#endif

namespace lt {

#if LT_ENGINE_HAVE_BUNGEE

namespace {

constexpr int kBungeeWarpHop = -1;
constexpr int kMaxWarmFramesAt48k = 8192;

} // namespace

struct BungeeWarpVoice::Impl {
    using Edition = Bungee::Basic;
    using Stretcher = Bungee::Stretcher<Edition>;
    using Stream = Bungee::Stream<Edition>;

    int sample_rate = 0;
    int channel_count = 0;
    int max_in_frames = 0;
    bool ready = false;

    long long source_cursor = 0;
    int warmed_latency_frames = 0;

    std::unique_ptr<Stretcher> stretcher;
    std::unique_ptr<Stream> stream;

    int fifo_capacity_frames = 0;
    int fifo_read = 0;
    int fifo_size = 0;
    std::vector<std::vector<float>> process_planes;
    std::vector<float*> process_ptrs;
    std::vector<std::vector<float>> fifo_planes;

    void clear_fifo() noexcept {
        fifo_read = 0;
        fifo_size = 0;
    }

    int fifo_write_index() const noexcept {
        return fifo_capacity_frames > 0
            ? (fifo_read + fifo_size) % fifo_capacity_frames
            : 0;
    }

    void push_fifo(int frames) noexcept {
        if (frames <= 0 || fifo_capacity_frames <= 0) return;
        const int writable = std::min(frames, fifo_capacity_frames - fifo_size);
        int written = 0;
        while (written < writable) {
            const int dst = (fifo_write_index() + written) % fifo_capacity_frames;
            const int n = std::min(writable - written, fifo_capacity_frames - dst);
            for (int c = 0; c < channel_count; ++c) {
                std::copy_n(process_planes[static_cast<std::size_t>(c)].data() + written,
                            n,
                            fifo_planes[static_cast<std::size_t>(c)].data() + dst);
            }
            written += n;
        }
        fifo_size += writable;
    }

    int pop_fifo(float* const* output, int output_offset, int frames) noexcept {
        if (!output || frames <= 0 || fifo_size <= 0 || fifo_capacity_frames <= 0)
            return 0;
        const int readable = std::min(frames, fifo_size);
        int read = 0;
        while (read < readable) {
            const int src = (fifo_read + read) % fifo_capacity_frames;
            const int n = std::min(readable - read, fifo_capacity_frames - src);
            for (int c = 0; c < channel_count; ++c) {
                if (output[c]) {
                    std::copy_n(fifo_planes[static_cast<std::size_t>(c)].data() + src,
                                n,
                                output[c] + output_offset + read);
                }
            }
            read += n;
        }
        fifo_read = (fifo_read + readable) % fifo_capacity_frames;
        fifo_size -= readable;
        if (fifo_size == 0)
            fifo_read = 0;
        return readable;
    }

    void warm() noexcept {
        if (!stream || max_in_frames <= 0 || channel_count <= 0) return;

        const int max_warm_frames = std::max(0,
            static_cast<int>(static_cast<long long>(kMaxWarmFramesAt48k) * sample_rate / 48000));
        if (max_warm_frames <= 0) return;

        std::vector<std::vector<float>> zeros(
            static_cast<std::size_t>(channel_count),
            std::vector<float>(static_cast<std::size_t>(max_in_frames), 0.0f));
        std::vector<const float*> in_ptrs(static_cast<std::size_t>(channel_count), nullptr);
        for (int c = 0; c < channel_count; ++c)
            in_ptrs[static_cast<std::size_t>(c)] = zeros[static_cast<std::size_t>(c)].data();

        int fed = 0;
        while (fed < max_warm_frames) {
            const int chunk = std::min(max_in_frames, max_warm_frames - fed);
            (void)stream->process(
                in_ptrs.data(), process_ptrs.data(),
                chunk, static_cast<double>(chunk),
                /*pitch*/ 1.0);
            fed += chunk;
            if (stream->latency() < static_cast<double>(max_in_frames))
                break;
        }
        warmed_latency_frames = static_cast<int>(std::lround(stream->latency()));
        clear_fifo();
    }
};

BungeeWarpVoice::BungeeWarpVoice()
    : impl_(std::make_unique<Impl>()) {}

BungeeWarpVoice::~BungeeWarpVoice() = default;
BungeeWarpVoice::BungeeWarpVoice(BungeeWarpVoice&&) noexcept = default;
BungeeWarpVoice& BungeeWarpVoice::operator=(BungeeWarpVoice&&) noexcept = default;

bool BungeeWarpVoice::configure(int sample_rate,
                                int channel_count,
                                int max_input_frames_per_block) {
    if (!impl_) return false;
    if (sample_rate <= 0 || channel_count <= 0 || max_input_frames_per_block <= 0)
        return false;

    auto& I = *impl_;
    I.sample_rate = sample_rate;
    I.channel_count = channel_count;
    I.max_in_frames = max_input_frames_per_block;
    I.ready = false;

    try {
        Bungee::SampleRates rates{sample_rate, sample_rate};
        I.stretcher = std::make_unique<Impl::Stretcher>(
            rates, channel_count, kBungeeWarpHop);
        I.stream = std::make_unique<Impl::Stream>(
            *I.stretcher, max_input_frames_per_block, channel_count);

        I.fifo_capacity_frames = std::max(max_input_frames_per_block * 4,
                                          max_input_frames_per_block + 1);
        I.process_planes.assign(
            static_cast<std::size_t>(channel_count),
            std::vector<float>(static_cast<std::size_t>(max_input_frames_per_block), 0.0f));
        I.process_ptrs.assign(static_cast<std::size_t>(channel_count), nullptr);
        I.fifo_planes.assign(
            static_cast<std::size_t>(channel_count),
            std::vector<float>(static_cast<std::size_t>(I.fifo_capacity_frames), 0.0f));
        for (int c = 0; c < channel_count; ++c) {
            I.process_ptrs[static_cast<std::size_t>(c)] =
                I.process_planes[static_cast<std::size_t>(c)].data();
        }
        I.clear_fifo();
        I.warm();
        I.source_cursor = 0;
        I.ready = true;
        return true;
    } catch (...) {
        I.stretcher.reset();
        I.stream.reset();
        I.ready = false;
        return false;
    }
}

bool BungeeWarpVoice::is_ready() const noexcept {
    return impl_ && impl_->ready;
}

const char* BungeeWarpVoice::backend_name() const noexcept {
    return "bungee_basic_warp";
}

int BungeeWarpVoice::input_latency_frames() const noexcept {
    if (!impl_) return 0;
    if (impl_->warmed_latency_frames > 0)
        return impl_->warmed_latency_frames;
    if (!impl_->stream) return 0;
    return static_cast<int>(std::lround(impl_->stream->latency()));
}

int BungeeWarpVoice::output_latency_frames() const noexcept {
    return input_latency_frames();
}

bool BungeeWarpVoice::needs_source_latency_compensation() const noexcept {
    return true;
}

int BungeeWarpVoice::render_block(const float* const* input,
                                  int                 input_frames,
                                  float* const*       output,
                                  int                 output_frames,
                                  double              time_ratio) noexcept {
    if (!impl_ || !impl_->ready || !impl_->stream
        || !output || output_frames <= 0)
        return 0;

    auto& I = *impl_;
    int delivered = I.pop_fifo(output, 0, output_frames);
    if (delivered >= output_frames)
        return delivered;

    if (input && input_frames > 0) {
        const double safe_ratio = time_ratio > 0.0 ? time_ratio : 1.0;
        const int remaining_output = output_frames - delivered;
        const int wanted_input = std::max(1, static_cast<int>(
            std::ceil(static_cast<double>(remaining_output) * safe_ratio)));
        const int input_to_consume = std::min({input_frames, I.max_in_frames, wanted_input});
        if (input_to_consume > 0) {
            const double requested_output =
                static_cast<double>(input_to_consume) / safe_ratio;
            const int produced = I.stream->process(
                input, I.process_ptrs.data(),
                input_to_consume, requested_output,
                /*pitch*/ 1.0);
            I.source_cursor += input_to_consume;
            I.push_fifo(produced);
            delivered += I.pop_fifo(output, delivered, output_frames - delivered);
        }
    }

    return delivered;
}

void BungeeWarpVoice::advance_silent(int input_frames) noexcept {
    if (!impl_ || input_frames <= 0) return;
    impl_->source_cursor += input_frames;
}

void BungeeWarpVoice::reset_source_cursor(long long source_frame) noexcept {
    if (impl_) impl_->source_cursor = source_frame;
}

long long BungeeWarpVoice::source_cursor() const noexcept {
    return impl_ ? impl_->source_cursor : 0;
}

#else

struct BungeeWarpVoice::Impl {};

BungeeWarpVoice::BungeeWarpVoice() = default;
BungeeWarpVoice::~BungeeWarpVoice() = default;
BungeeWarpVoice::BungeeWarpVoice(BungeeWarpVoice&&) noexcept = default;
BungeeWarpVoice& BungeeWarpVoice::operator=(BungeeWarpVoice&&) noexcept = default;

bool BungeeWarpVoice::configure(int, int, int) { return false; }
bool BungeeWarpVoice::is_ready() const noexcept { return false; }
const char* BungeeWarpVoice::backend_name() const noexcept { return "unavailable"; }
int BungeeWarpVoice::input_latency_frames() const noexcept { return 0; }
int BungeeWarpVoice::output_latency_frames() const noexcept { return 0; }
bool BungeeWarpVoice::needs_source_latency_compensation() const noexcept { return false; }
int BungeeWarpVoice::render_block(const float* const*, int,
                                  float* const* output, int output_frames,
                                  double) noexcept {
    if (output && output_frames > 0) {
        for (int c = 0; c < 2; ++c) {
            if (output[c])
                std::fill(output[c], output[c] + output_frames, 0.0f);
        }
    }
    return 0;
}
void BungeeWarpVoice::advance_silent(int) noexcept {}
void BungeeWarpVoice::reset_source_cursor(long long) noexcept {}
long long BungeeWarpVoice::source_cursor() const noexcept { return 0; }

#endif

} // namespace lt
