#include <lt_engine/pitch/bungee_pitch_voice.h>

#ifndef LT_ENGINE_HAVE_BUNGEE
#  define LT_ENGINE_HAVE_BUNGEE 0
#endif

#if LT_ENGINE_HAVE_BUNGEE
#  include <cmath>
#  include <span>
#  include <vector>
#  include <bungee/Bungee.h>
#  include <bungee/Stream.h>
#endif

#include <algorithm>
#include <vector>

namespace lt {

#if LT_ENGINE_HAVE_BUNGEE

struct BungeePitchVoice::Impl {
    using Edition = Bungee::Basic;
    using Stretcher = Bungee::Stretcher<Edition>;
    using Stream = Bungee::Stream<Edition>;

    int sample_rate = 0;
    int channel_count = 0;
    int max_in_frames = 0;
    bool ready = false;

    std::unique_ptr<Stretcher> stretcher;
    std::unique_ptr<Stream> stream;

    int fade_total_frames = 0;
    int fade_frames_done = 0;

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

    void apply_fade(float* const* output, int offset, int frames) noexcept {
        if (!output || frames <= 0 || fade_frames_done >= fade_total_frames)
            return;
        const int n = std::min(frames, fade_total_frames - fade_frames_done);
        const double inv_total = 1.0 / static_cast<double>(fade_total_frames);
        for (int i = 0; i < n; ++i) {
            const double t = static_cast<double>(fade_frames_done + i) * inv_total;
            const double s = std::sin(t * 1.5707963267948966);
            const float gain = static_cast<float>(s * s);
            for (int c = 0; c < channel_count; ++c) {
                if (output[c]) output[c][offset + i] *= gain;
            }
        }
        fade_frames_done += n;
    }
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

    impl_->sample_rate = sample_rate;
    impl_->channel_count = channel_count;
    impl_->max_in_frames = max_input_frames_per_block;
    impl_->ready = false;

    try {
        Bungee::SampleRates rates{sample_rate, sample_rate};
        impl_->stretcher = std::make_unique<Impl::Stretcher>(
            rates, channel_count, 0);
        impl_->stream = std::make_unique<Impl::Stream>(
            *impl_->stretcher, max_input_frames_per_block, channel_count);

        impl_->fifo_capacity_frames = std::max(max_input_frames_per_block * 4,
                                               max_input_frames_per_block + 1);
        impl_->process_planes.assign(
            static_cast<std::size_t>(channel_count),
            std::vector<float>(static_cast<std::size_t>(max_input_frames_per_block), 0.0f));
        impl_->process_ptrs.assign(static_cast<std::size_t>(channel_count), nullptr);
        impl_->fifo_planes.assign(
            static_cast<std::size_t>(channel_count),
            std::vector<float>(static_cast<std::size_t>(impl_->fifo_capacity_frames), 0.0f));
        for (int c = 0; c < channel_count; ++c) {
            impl_->process_ptrs[static_cast<std::size_t>(c)] =
                impl_->process_planes[static_cast<std::size_t>(c)].data();
        }
        impl_->clear_fifo();
        impl_->fade_total_frames = std::max(1, (sample_rate * 5) / 1000);
        impl_->fade_frames_done = 0;
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
                                   double pitch_scale,
                                   double time_ratio) noexcept {
    if (!impl_ || !impl_->ready || !impl_->stream || input_frames < 0 || output_frames <= 0)
        return 0;
    if (!output) return 0;

    auto& I = *impl_;
    int delivered = I.pop_fifo(output, 0, output_frames);
    I.apply_fade(output, 0, delivered);
    if (delivered >= output_frames)
        return delivered;

    const int process_frames = std::min(input_frames, I.max_in_frames);
    if (process_frames > 0) {
        const double safe_ratio = time_ratio > 0.0 ? time_ratio : 1.0;
        const double input_advance =
            static_cast<double>(process_frames) * safe_ratio;
        const int produced = I.stream->process(
            input,
            I.process_ptrs.data(),
            process_frames,
            input_advance,
            pitch_scale);
        I.push_fifo(produced);
        const int popped = I.pop_fifo(output, delivered, output_frames - delivered);
        I.apply_fade(output, delivered, popped);
        delivered += popped;
    }

    return delivered;
}

int BungeePitchVoice::prime_output_fifo(const float* const* input,
                                        int input_frames,
                                        double pitch_scale,
                                        double time_ratio) noexcept {
    if (!impl_ || !impl_->ready || !impl_->stream || !input || input_frames <= 0)
        return 0;

    auto& I = *impl_;
    const int process_frames = std::min(input_frames, I.max_in_frames);
    if (process_frames <= 0)
        return 0;

    const double safe_ratio = time_ratio > 0.0 ? time_ratio : 1.0;
    const double input_advance =
        static_cast<double>(process_frames) * safe_ratio;
    const int before = I.fifo_size;
    const int produced = I.stream->process(
        input,
        I.process_ptrs.data(),
        process_frames,
        input_advance,
        pitch_scale);
    I.push_fifo(produced);
    return I.fifo_size - before;
}

int BungeePitchVoice::queued_output_frames() const noexcept {
    return impl_ ? impl_->fifo_size : 0;
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

int BungeePitchVoice::alignment_compensation_frames(double pitch_scale) const noexcept {
    if (!impl_ || impl_->sample_rate <= 0 || pitch_scale <= 0.0) return 0;
    const double base = static_cast<double>(impl_->sample_rate) * 0.032;
    return static_cast<int>(std::lround(base * ((1.0 / pitch_scale) - 1.0)));
}

bool BungeePitchVoice::is_warm() const noexcept {
    if (!impl_ || !impl_->stream) return false;
    return impl_->stream->latency() < static_cast<double>(impl_->max_in_frames);
}

void BungeePitchVoice::arm_fade_in(int fade_ms) noexcept {
    if (!impl_) return;
    const int sr = impl_->sample_rate;
    if (sr <= 0 || fade_ms <= 0) {
        impl_->fade_total_frames = 0;
        impl_->fade_frames_done = 0;
        return;
    }
    impl_->fade_total_frames = std::max(1, (sr * fade_ms) / 1000);
    impl_->fade_frames_done = 0;
}

#else

struct BungeePitchVoice::Impl {};

BungeePitchVoice::BungeePitchVoice() = default;
BungeePitchVoice::~BungeePitchVoice() = default;
BungeePitchVoice::BungeePitchVoice(BungeePitchVoice&&) noexcept = default;
BungeePitchVoice& BungeePitchVoice::operator=(BungeePitchVoice&&) noexcept = default;

bool BungeePitchVoice::configure(int, int, int) { return false; }
bool BungeePitchVoice::is_ready() const noexcept { return false; }
const char* BungeePitchVoice::backend_name() const noexcept { return "unavailable"; }

long long BungeePitchVoice::input_position() const noexcept { return 0; }
double BungeePitchVoice::output_position() const noexcept { return 0.0; }
double BungeePitchVoice::latency_frames() const noexcept { return 0.0; }
int BungeePitchVoice::alignment_compensation_frames(double) const noexcept { return 0; }
bool BungeePitchVoice::is_warm() const noexcept { return false; }
void BungeePitchVoice::arm_fade_in(int) noexcept {}
int BungeePitchVoice::queued_output_frames() const noexcept { return 0; }
int BungeePitchVoice::prime_output_fifo(const float* const*, int, double, double) noexcept { return 0; }

int BungeePitchVoice::render_block(const float* const*,
                                   int,
                                   float* const* output,
                                   int output_frames,
                                   double,
                                   double) noexcept {
    if (output && output_frames > 0) {
        for (int ch = 0; ch < 2; ++ch) {
            if (output[ch])
                std::fill(output[ch], output[ch] + output_frames, 0.0f);
        }
    }
    return 0;
}

#endif

} // namespace lt
