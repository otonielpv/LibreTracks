#include <lt_engine/pitch/bungee_pitch_voice.h>
#include <lt_engine/diagnostics/rt_guard.h>
#include <atomic>
#include <cstdint>

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

// Voces destruidas dentro del callback. Ver la nota en el cabecero: destruir
// una voz libera los buffers de Bungee, o sea toma el lock del allocator, y
// hacerlo en el hilo de audio es un stall. En producción esto no se instrumenta
// (identificar el hilo de audio requiere la marca del paso 02, que sólo existe
// en el build de tests) y el destructor queda exactamente como estaba.
namespace {
std::atomic<std::uint64_t> g_destroyed_on_audio_thread{0};
}

std::uint64_t BungeePitchVoice::destroyed_on_audio_thread_count() noexcept {
    return g_destroyed_on_audio_thread.load(std::memory_order_relaxed);
}
void BungeePitchVoice::reset_destroyed_on_audio_thread_count() noexcept {
    g_destroyed_on_audio_thread.store(0, std::memory_order_relaxed);
}

namespace {
// Se llama desde los dos destructores (el real y el stub).
inline void note_voice_destruction() noexcept {
#if LT_ENGINE_RT_GUARD
    if (lt::rt::in_realtime_section())
        g_destroyed_on_audio_thread.fetch_add(1, std::memory_order_relaxed);
#endif
}
}

#if LT_ENGINE_HAVE_BUNGEE

struct BungeePitchVoice::Impl {
    using Edition = Bungee::Basic;
    using Stretcher = Bungee::Stretcher<Edition>;
    using Stream = Bungee::Stream<Edition>;

    int sample_rate = 0;
    int channel_count = 0;
    int max_in_frames = 0;
    bool ready = false;

    // How far into the source this voice has been fed, in absolute source
    // frames. Purely a contiguity pointer: the next feed starts here so the
    // stream Bungee sees has no seam. It says nothing about where playback is
    // — the renderer derives that from the timeline every block.
    long long fed_through = 0;
    // fed_through minus the source frame the voice was emitting when it was
    // anchored: the constant head start Bungee needs over its own output.
    long long feed_lead = 0;

    // Clip placement this voice was last built/retimed for. Compared by the
    // manager so an unchanged clip's voice is never hard-retimed (see header).
    long long mapped_timeline_start = 0;
    long long mapped_source_start = 0;
    double    mapped_time_ratio = 1.0;

    std::unique_ptr<Stretcher> stretcher;
    std::unique_ptr<Stream> stream;

    int fade_total_frames = 0;
    int fade_frames_done = 0;

    // Latency-convergence tracking for is_warm(). Bungee's latency climbs in
    // steps as the analysis pipeline fills, then holds. Two consecutive
    // readings at the same value mean it has settled.
    double last_latency = -1.0;
    int    latency_stable_blocks = 0;
    bool   warm = false;

    void observe_latency(double latency) noexcept {
        // latency() is only meaningful once a grain has been synthesised;
        // before that Stream::outputPosition() has no chunk to interpolate.
        if (!(latency > 0.0)) {
            last_latency = -1.0;
            latency_stable_blocks = 0;
            return;
        }
        if (last_latency >= 0.0 && std::abs(latency - last_latency) < 0.5)
            ++latency_stable_blocks;
        else
            latency_stable_blocks = 0;
        last_latency = latency;
        if (latency_stable_blocks >= 2)
            warm = true;
    }

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

BungeePitchVoice::~BungeePitchVoice() { note_voice_destruction(); }
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
        // log2SynthesisHopAdjust = -1 halves the grain hop, which halves the
        // structural latency. Measured against Bungee 2.4.24 Basic at 44.1 kHz:
        //
        //   hop =  0   9728 frames   220.6 ms
        //   hop = -1   4864 frames   110.3 ms
        //
        // That latency is the floor on everything the user feels: how long a
        // jump takes to speak, how much material a seek has to prefeed, how
        // long the engine spends in an inconsistent state after a warp toggle.
        // -1 is what WARP_BACKEND_NOTES.md documents and what shipped until the
        // warp and pitch voices were merged into this class, where the argument
        // was lost. -2 was tried and rejected: it is stable, but the quality
        // cost on real transposed material was audible in an A/B.
        impl_->stretcher = std::make_unique<Impl::Stretcher>(
            rates, channel_count, -1);
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
                                   double pitch_scale) noexcept {
    if (!impl_ || !impl_->ready || !impl_->stream || input_frames < 0 || output_frames <= 0)
        return 0;
    if (!output) return 0;

    auto& I = *impl_;

    // Anything already synthesised comes out first. A block served entirely
    // from here consumed no input, so the feed position must not move — and it
    // does not, because this function no longer owns a position at all.
    int delivered = I.pop_fifo(output, 0, output_frames);
    I.apply_fade(output, 0, delivered);
    if (delivered >= output_frames || input_frames <= 0)
        return delivered;

    // Bungee::Stream::process derives its speed from the two frame counts:
    //     speed = inputFrameCount / outputFrameCount
    // so handing over `input_frames` of source for `process_frames` of output
    // IS how the warp ratio is set. There is no separate ratio to keep in
    // agreement, which is the point: the caller sized the span from the
    // timeline, and that span is honoured exactly.
    //
    // Both sides are capped at max_in_frames — the output because
    // I.process_planes is sized to it, the input because that is the
    // maxInputFrameCount the Stream was constructed with.
    const int process_frames = std::min(output_frames - delivered, I.max_in_frames);
    const int input_to_consume = std::min(input_frames, I.max_in_frames);
    if (process_frames > 0) {
        const int produced = I.stream->process(
            input,
            I.process_ptrs.data(),
            input_to_consume,
            static_cast<double>(process_frames),
            pitch_scale);
        I.observe_latency(I.stream->latency());
        I.push_fifo(produced);
        const int popped = I.pop_fifo(output, delivered, output_frames - delivered);
        I.apply_fade(output, delivered, popped);
        delivered += popped;
    }

    return delivered;
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

bool BungeePitchVoice::is_warm() const noexcept {
    return impl_ && impl_->warm;
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

void BungeePitchVoice::set_feed_anchor(long long anchor_source_frame,
                                       long long fed_through) noexcept {
    if (!impl_) return;
    impl_->fed_through = fed_through;
    impl_->feed_lead   = fed_through - anchor_source_frame;
}

long long BungeePitchVoice::fed_through() const noexcept {
    return impl_ ? impl_->fed_through : 0;
}

long long BungeePitchVoice::feed_lead_frames() const noexcept {
    return impl_ ? impl_->feed_lead : 0;
}

void BungeePitchVoice::advance_fed_through(long long frames) noexcept {
    if (impl_ && frames > 0) impl_->fed_through += frames;
}

void BungeePitchVoice::reanchor_feed(long long fed_through) noexcept {
    if (impl_) impl_->fed_through = fed_through;
}

void BungeePitchVoice::clear_queued_output() noexcept {
    if (impl_) impl_->clear_fifo();
}

void BungeePitchVoice::set_clip_mapping(long long timeline_start_frame,
                                        long long source_start_frame,
                                        double time_ratio) noexcept {
    if (impl_) {
        impl_->mapped_timeline_start = timeline_start_frame;
        impl_->mapped_source_start = source_start_frame;
        impl_->mapped_time_ratio = time_ratio;
    }
}

long long BungeePitchVoice::mapped_timeline_start() const noexcept {
    return impl_ ? impl_->mapped_timeline_start : 0;
}

long long BungeePitchVoice::mapped_source_start() const noexcept {
    return impl_ ? impl_->mapped_source_start : 0;
}

double BungeePitchVoice::mapped_time_ratio() const noexcept {
    return impl_ ? impl_->mapped_time_ratio : 1.0;
}

#else

struct BungeePitchVoice::Impl {};

BungeePitchVoice::BungeePitchVoice() = default;
BungeePitchVoice::~BungeePitchVoice() { note_voice_destruction(); }
BungeePitchVoice::BungeePitchVoice(BungeePitchVoice&&) noexcept = default;
BungeePitchVoice& BungeePitchVoice::operator=(BungeePitchVoice&&) noexcept = default;

bool BungeePitchVoice::configure(int, int, int) { return false; }
bool BungeePitchVoice::is_ready() const noexcept { return false; }
const char* BungeePitchVoice::backend_name() const noexcept { return "unavailable"; }

long long BungeePitchVoice::input_position() const noexcept { return 0; }
double BungeePitchVoice::output_position() const noexcept { return 0.0; }
double BungeePitchVoice::latency_frames() const noexcept { return 0.0; }
bool BungeePitchVoice::is_warm() const noexcept { return false; }
void BungeePitchVoice::arm_fade_in(int) noexcept {}
int BungeePitchVoice::queued_output_frames() const noexcept { return 0; }

int BungeePitchVoice::render_block(const float* const*,
                                   int,
                                   float* const* output,
                                   int output_frames,
                                   double) noexcept {
    if (output && output_frames > 0) {
        for (int ch = 0; ch < 2; ++ch) {
            if (output[ch])
                std::fill(output[ch], output[ch] + output_frames, 0.0f);
        }
    }
    return 0;
}

void BungeePitchVoice::set_feed_anchor(long long, long long) noexcept {}
long long BungeePitchVoice::fed_through() const noexcept { return 0; }
long long BungeePitchVoice::feed_lead_frames() const noexcept { return 0; }
void BungeePitchVoice::advance_fed_through(long long) noexcept {}
void BungeePitchVoice::reanchor_feed(long long) noexcept {}
void BungeePitchVoice::clear_queued_output() noexcept {}
void BungeePitchVoice::set_clip_mapping(long long, long long, double) noexcept {}
long long BungeePitchVoice::mapped_timeline_start() const noexcept { return 0; }
long long BungeePitchVoice::mapped_source_start() const noexcept { return 0; }
double BungeePitchVoice::mapped_time_ratio() const noexcept { return 1.0; }

#endif

} // namespace lt
