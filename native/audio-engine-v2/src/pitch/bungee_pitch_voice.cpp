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

    // External "source frame" counter the renderer reads to know where the
    // next file read should start. Lives in source-frame units regardless
    // of pitch_scale/time_ratio. Advanced by `input_to_consume` each
    // render_block / prime call.
    long long source_cursor = 0;
    double source_cursor_fraction = 0.0;

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

    void advance_source_cursor(double source_frames) noexcept {
        if (source_frames <= 0.0)
            return;
        const double total = source_cursor_fraction + source_frames;
        const auto whole = static_cast<long long>(std::floor(total));
        source_cursor += whole;
        source_cursor_fraction = total - static_cast<double>(whole);
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
    const double safe_ratio = time_ratio > 0.0 ? time_ratio : 1.0;
    int delivered = I.pop_fifo(output, 0, output_frames);
    I.apply_fade(output, 0, delivered);
    if (delivered >= output_frames) {
        I.advance_source_cursor(static_cast<double>(delivered) * safe_ratio);
        return delivered;
    }

    // Bungee::Stream::process semantics:
    //   speed = inputFrameCount / outputFrameCount
    //   returns ~outputFrameCount frames of output, written into outputPointers.
    // For warp speed R (output is R× faster than source), the source cursor
    // must advance R× per output frame → speed = R → inputFrameCount = R *
    // outputFrameCount. Output side stays at process_frames so the wrapped
    // I.process_planes scratch (sized to max_in_frames) is never overflowed,
    // and the caller must supply at least R*process_frames input samples.
    const int max_output_from_input = std::max(
        1, static_cast<int>(std::floor(
            static_cast<double>(std::max(1, input_frames)) / safe_ratio)));
    const int process_frames = std::min({
        output_frames - delivered,
        I.max_in_frames,
        max_output_from_input});
    if (process_frames > 0) {
        const int input_to_consume = std::min(
            input_frames,
            std::max(1, static_cast<int>(std::ceil(
                static_cast<double>(process_frames) * safe_ratio))));
        const int produced = I.stream->process(
            input,
            I.process_ptrs.data(),
            input_to_consume,
            static_cast<double>(process_frames),
            pitch_scale);
        I.push_fifo(produced);
        const int popped = I.pop_fifo(output, delivered, output_frames - delivered);
        I.apply_fade(output, delivered, popped);
        delivered += popped;
    }

    I.advance_source_cursor(static_cast<double>(delivered) * safe_ratio);

    return delivered;
}

int BungeePitchVoice::prime_output_fifo(const float* const* input,
                                        int input_frames,
                                        double pitch_scale,
                                        double time_ratio) noexcept {
    if (!impl_ || !impl_->ready || !impl_->stream || !input || input_frames <= 0)
        return 0;

    auto& I = *impl_;
    const double safe_ratio = time_ratio > 0.0 ? time_ratio : 1.0;
    const int process_frames = std::min(
        I.max_in_frames,
        std::max(1, static_cast<int>(std::floor(
            static_cast<double>(input_frames) / safe_ratio))));
    if (process_frames <= 0)
        return 0;

    const int input_to_consume = std::min(
        input_frames,
        std::max(1, static_cast<int>(std::ceil(
            static_cast<double>(process_frames) * safe_ratio))));
    const int before = I.fifo_size;
    const int produced = I.stream->process(
        input,
        I.process_ptrs.data(),
        input_to_consume,
        static_cast<double>(process_frames),
        pitch_scale);
    I.push_fifo(produced);
    I.source_cursor += input_to_consume;
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

void BungeePitchVoice::reset_source_cursor(long long source_frame) noexcept {
    if (impl_) {
        impl_->source_cursor = source_frame;
        impl_->source_cursor_fraction = 0.0;
    }
}

long long BungeePitchVoice::source_cursor() const noexcept {
    return impl_ ? impl_->source_cursor : 0;
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

void BungeePitchVoice::reset_source_cursor(long long) noexcept {}
long long BungeePitchVoice::source_cursor() const noexcept { return 0; }

#endif

} // namespace lt
