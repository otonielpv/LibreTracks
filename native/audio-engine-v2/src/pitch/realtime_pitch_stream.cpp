#include <lt_engine/pitch/realtime_pitch_stream.h>

#include <algorithm>
#include <cassert>
#include <cmath>
#include <cstdarg>
#include <cstdio>
#include <functional>
#include <thread>

static bool s_pitch_debug = false;
static void pitch_stream_log(const char* fmt, ...) {
    if (!s_pitch_debug) {
        const char* v = std::getenv("LIBRETRACKS_AUDIO_DEBUG");
        s_pitch_debug = v && (v[0] == '1');
        if (!s_pitch_debug) return;
    }
    va_list ap; va_start(ap, fmt);
    std::vfprintf(stdout, fmt, ap);
    std::fflush(stdout);
    va_end(ap);
}

#if LT_ENGINE_USE_RUBBERBAND && !LT_ENGINE_ALLOW_PITCH_STUB && __has_include(<rubberband/RubberBandStretcher.h>)
#  define LT_ENGINE_REALTIME_STREAM_HAS_RB 1
#  include <rubberband/RubberBandStretcher.h>
#elif LT_ENGINE_USE_RUBBERBAND && !LT_ENGINE_ALLOW_PITCH_STUB && __has_include(<RubberBandStretcher.h>)
#  define LT_ENGINE_REALTIME_STREAM_HAS_RB 1
#  include <RubberBandStretcher.h>
#else
#  define LT_ENGINE_REALTIME_STREAM_HAS_RB 0
#endif

// When the real RubberBand backend is unavailable at runtime, refuse to push original
// audio as pitch output — that silently deceives the user into thinking pitch is working.
// Only allow the stub passthrough in explicit test/stub builds
// (LT_ENGINE_ALLOW_RUNTIME_PITCH_STUB_PASSTHROUGH=1).
// Default: blocked so the diagnostic counters fire instead.
#ifndef LT_ENGINE_ALLOW_RUNTIME_PITCH_STUB_PASSTHROUGH
#  if LT_ENGINE_ALLOW_PITCH_STUB
#    define LT_ENGINE_ALLOW_RUNTIME_PITCH_STUB_PASSTHROUGH 1
#  else
#    define LT_ENGINE_ALLOW_RUNTIME_PITCH_STUB_PASSTHROUGH 0
#  endif
#endif

namespace lt {

void SourceReadAheadCache::prepare_window(const DecodedSource& source, Frame start_frame, Frame frame_count) noexcept {
    const Frame start = std::max<Frame>(0, start_frame);
    const Frame end = std::min<Frame>(source.duration_frames(), start + std::max<Frame>(0, frame_count));
    start_.store(start, std::memory_order_release);
    end_.store(end, std::memory_order_release);
    source_.store(&source, std::memory_order_release);
    prepare_count_.fetch_add(1, std::memory_order_relaxed);
}

bool SourceReadAheadCache::is_ready(const DecodedSource& source, Frame start_frame, Frame frame_count) const noexcept {
    const Frame start = std::max<Frame>(0, start_frame);
    const Frame end = std::min<Frame>(source.duration_frames(), start + std::max<Frame>(0, frame_count));
    const auto* cached = source_.load(std::memory_order_acquire);
    const Frame cached_start = start_.load(std::memory_order_acquire);
    const Frame cached_end = end_.load(std::memory_order_acquire);
    const bool ready = cached == &source && start >= cached_start && end <= cached_end;
    if (!ready)
        miss_count_.fetch_add(1, std::memory_order_relaxed);
    return ready;
}

RealtimePitchStream::RealtimePitchStream() = default;
RealtimePitchStream::~RealtimePitchStream() = default;

double RealtimePitchStream::semitones_to_ratio(double semitones) const noexcept {
    return std::pow(2.0, semitones / 12.0);
}

std::uint64_t RealtimePitchStream::current_thread_token() const noexcept {
    return static_cast<std::uint64_t>(std::hash<std::thread::id>{}(std::this_thread::get_id()));
}

void RealtimePitchStream::note_control_mutation_if_published() noexcept {
    if (!published_.load(std::memory_order_acquire))
        return;
    const auto thread = current_thread_token();
    const auto render_thread = render_thread_id_.load(std::memory_order_acquire);
    if (render_thread == 0 || thread != render_thread)
        unsafe_cross_thread_reset_count_.fetch_add(1, std::memory_order_relaxed);
}

void RealtimePitchStream::mark_published(std::uint64_t generation) noexcept {
    generation_.store(generation, std::memory_order_release);
    published_.store(true, std::memory_order_release);
}

void RealtimePitchStream::configure(const Config& config) {
    note_control_mutation_if_published();
    const int channels = std::clamp(config.channel_count, 1, 2);
    const int ring_capacity = std::max(config.ring_capacity_frames, config.max_block_size * 4);
    const bool same = configured_
        && config_.sample_rate == config.sample_rate
        && config_.channel_count == channels
        && config_.semitones == config.semitones
        && config_.max_block_size == config.max_block_size
        && config_.ring_capacity_frames == ring_capacity;
    config_ = config;
    config_.channel_count = channels;
    config_.pitch_scale = semitones_to_ratio(config_.semitones);
    config_.max_block_size = std::clamp(config_.max_block_size, 64, kScratchFrames);
    config_.preroll_frames = std::max(0, config_.preroll_frames);
    config_.ring_capacity_frames = ring_capacity;
    configured_ = true;
    if (!same)
        allocate_buffers();

#if LT_ENGINE_REALTIME_STREAM_HAS_RB
    using RBOption = RubberBand::RubberBandStretcher::Option;
    const int options = RBOption::OptionProcessRealTime
                      | RBOption::OptionPitchHighConsistency
                      | RBOption::OptionChannelsTogether;
    stretcher_ = std::make_unique<RubberBand::RubberBandStretcher>(
        static_cast<size_t>(config_.sample_rate),
        static_cast<size_t>(config_.channel_count),
        options,
        1.0,
        config_.pitch_scale);
    stretcher_->setTimeRatio(1.0);
    stretcher_->setPitchScale(config_.pitch_scale);
#endif
    primed_ = false;
}

void RealtimePitchStream::allocate_buffers() {
    const int channels = config_.channel_count;
    input_.assign(static_cast<std::size_t>(channels), {});
    rb_output_.assign(static_cast<std::size_t>(channels), {});
    input_ptrs_.assign(static_cast<std::size_t>(channels), nullptr);
    output_ptrs_.assign(static_cast<std::size_t>(channels), nullptr);
    ring_.assign(static_cast<std::size_t>(channels), {});
    for (int ch = 0; ch < channels; ++ch) {
        input_[static_cast<std::size_t>(ch)].assign(kScratchFrames, 0.0f);
        rb_output_[static_cast<std::size_t>(ch)].assign(kScratchFrames, 0.0f);
        ring_[static_cast<std::size_t>(ch)].assign(config_.ring_capacity_frames, 0.0f);
        input_ptrs_[static_cast<std::size_t>(ch)] = input_[static_cast<std::size_t>(ch)].data();
        output_ptrs_[static_cast<std::size_t>(ch)] = rb_output_[static_cast<std::size_t>(ch)].data();
    }
    clear_ring();
}

void RealtimePitchStream::clear_ring() noexcept {
    ring_read_ = 0;
    ring_write_ = 0;
    ring_size_ = 0;
}

int RealtimePitchStream::ring_available() const noexcept { return ring_size_; }
int RealtimePitchStream::ring_free() const noexcept { return config_.ring_capacity_frames - ring_size_; }

bool RealtimePitchStream::valid_ring_state() const noexcept {
    return config_.ring_capacity_frames > 0
        && ring_size_ >= 0
        && ring_size_ <= config_.ring_capacity_frames
        && ring_read_ >= 0
        && ring_read_ < config_.ring_capacity_frames
        && ring_write_ >= 0
        && ring_write_ < config_.ring_capacity_frames;
}

void RealtimePitchStream::push_ring(float* const* channels, int frames) noexcept {
    if (!channels || frames <= 0 || !valid_ring_state())
        return;
    const int take = std::min(frames, ring_free());
    if (take < frames)
        overflow_count_.fetch_add(1, std::memory_order_relaxed);
    for (int f = 0; f < take; ++f) {
        for (int ch = 0; ch < config_.channel_count; ++ch) {
            if (!channels[ch])
                return;
            assert(ring_write_ >= 0 && ring_write_ < config_.ring_capacity_frames);
            ring_[static_cast<std::size_t>(ch)][static_cast<std::size_t>(ring_write_)] = channels[ch][f];
        }
        ring_write_ = (ring_write_ + 1) % config_.ring_capacity_frames;
        ++ring_size_;
    }
}

int RealtimePitchStream::pop_ring(float** out, int out_channels, int offset, int frames) noexcept {
    if (!out || offset < 0 || frames <= 0 || !valid_ring_state())
        return 0;
    out_channels = std::clamp(out_channels, 0, config_.channel_count);
    for (int ch = 0; ch < out_channels; ++ch) {
        if (!out[ch])
            return 0;
    }
    const int take = std::min(frames, ring_size_);
    for (int f = 0; f < take; ++f) {
        for (int ch = 0; ch < out_channels; ++ch) {
            const int src_ch = std::min(ch, config_.channel_count - 1);
            assert(ring_read_ >= 0 && ring_read_ < config_.ring_capacity_frames);
            out[ch][offset + f] = ring_[static_cast<std::size_t>(src_ch)][static_cast<std::size_t>(ring_read_)];
        }
        ring_read_ = (ring_read_ + 1) % config_.ring_capacity_frames;
        --ring_size_;
    }
    return take;
}

int RealtimePitchStream::discard_ring(int frames) noexcept {
    if (frames <= 0 || !valid_ring_state())
        return 0;
    const int take = std::min(frames, ring_size_);
    ring_read_ = (ring_read_ + take) % config_.ring_capacity_frames;
    ring_size_ -= take;
    discarded_frames_ += take;
    return take;
}

void RealtimePitchStream::process_start_pad() noexcept {
#if LT_ENGINE_REALTIME_STREAM_HAS_RB
    if (!stretcher_)
        return;
    int pad = static_cast<int>(stretcher_->getPreferredStartPad());
    start_delay_frames_ = static_cast<int>(stretcher_->getStartDelay());
    while (pad > 0) {
        const int chunk = std::min(pad, config_.max_block_size);
        assert(chunk <= static_cast<int>(input_[0].size()));
        for (int ch = 0; ch < config_.channel_count; ++ch)
            std::fill(input_[static_cast<std::size_t>(ch)].begin(),
                      input_[static_cast<std::size_t>(ch)].begin() + chunk, 0.0f);
        stretcher_->process(input_ptrs_.data(), static_cast<size_t>(chunk), false);
        pad -= chunk;
    }
#endif
}

void RealtimePitchStream::reset_for_seek(const DecodedSource& source, Frame source_frame, Frame timeline_frame) {
    note_control_mutation_if_published();
    reset_thread_id_.store(current_thread_token(), std::memory_order_release);
    pitch_stream_log("[PITCH_STREAM] reset_for_seek src=%lld tl=%lld st=%.2f\n",
        (long long)source_frame, (long long)timeline_frame, config_.semitones);
    if (!configured_)
        configure(Config{source.sample_rate(), source.channel_count(), config_.semitones});
    configure(config_);
    clear_ring();
    // Set sentinel so audio thread accepts any position on first render after this seek.
    current_output_timeline_frame_ = -1;
    primed_timeline_frame_ = timeline_frame; // ring will start at this position after prime()
    const Frame target = std::max<Frame>(0, source_frame);
    const Frame read_start = std::max<Frame>(0, target - config_.preroll_frames);
    current_source_frame_ = read_start;
    discarded_frames_ = 0;
    reset_ramp_frames_ = std::clamp(config_.sample_rate / 200, 64, 512);
    reset_ramp_pos_ = 0;
    process_start_pad();
    const int pretarget = static_cast<int>(target - read_start);
    int remaining = pretarget;
    while (remaining > 0) {
        const int chunk = std::min(remaining, config_.max_block_size);
        process_source(source, current_source_frame_, chunk);
        current_source_frame_ += chunk;
        retrieve_to_ring();
        remaining -= chunk;
    }
    discard_remaining_ = start_delay_frames_ + pretarget;
    while (discard_remaining_ > 0) {
        retrieve_to_ring();
        const int discarded = discard_ring(discard_remaining_);
        if (discarded == 0)
            break;
        discard_remaining_ -= discarded;
    }
    primed_ = false;
    reset_count_.fetch_add(1, std::memory_order_relaxed);
}

bool RealtimePitchStream::prime(const DecodedSource& source, Frame timeline_frame, int min_output_frames) {
    note_control_mutation_if_published();
    (void)timeline_frame;
    const int produced = feed_required_input(source, min_output_frames);
    primed_ = ring_available() >= min_output_frames;
    pitch_stream_log("[PITCH_STREAM] prime tl=%lld primed=%d ring=%d src_pos=%lld\n",
        (long long)timeline_frame, (int)primed_, ring_available(), (long long)current_source_frame_);
    prime_count_.fetch_add(1, std::memory_order_relaxed);
    return primed_ || produced > 0;
}

int RealtimePitchStream::process_source(const DecodedSource& source, Frame start, int frames) noexcept {
    const int chunk = std::min(std::max(0, frames), config_.max_block_size);
    if (chunk <= 0)
        return 0;
    for (int ch = 0; ch < config_.channel_count; ++ch) {
        assert(chunk <= static_cast<int>(input_[static_cast<std::size_t>(ch)].size()));
        std::fill(input_[static_cast<std::size_t>(ch)].begin(),
                  input_[static_cast<std::size_t>(ch)].begin() + chunk, 0.0f);
    }
    int read = 0;
    if (start < source.duration_frames())
        read = source.read(start, chunk, input_ptrs_.data(),
                           std::min(config_.channel_count, source.channel_count()));
    if (read <= 0)
        source_miss_count_.fetch_add(1, std::memory_order_relaxed);
    if (source.channel_count() == 1 && config_.channel_count > 1 && read > 0) {
        for (int ch = 1; ch < config_.channel_count; ++ch)
            std::copy(input_[0].begin(), input_[0].begin() + read, input_[static_cast<std::size_t>(ch)].begin());
    }
#if LT_ENGINE_REALTIME_STREAM_HAS_RB
    if (stretcher_)
        stretcher_->process(input_ptrs_.data(), static_cast<size_t>(chunk), false);
#else
    // No real pitch backend available.
#  if LT_ENGINE_ALLOW_RUNTIME_PITCH_STUB_PASSTHROUGH
    // Explicit stub mode (tests only): push original audio and count it.
    stub_passthrough_count_.fetch_add(1, std::memory_order_relaxed);
    push_ring(input_ptrs_.data(), chunk);
#  else
    // Runtime mode: block passthrough to avoid silently playing un-pitched audio.
    // The caller sees ring_available() == 0 → underflow → silence for this block.
    // Diagnostics expose this clearly.
    stub_passthrough_blocked_count_.fetch_add(1, std::memory_order_relaxed);
    backend_unavailable_count_.fetch_add(1, std::memory_order_relaxed);
#  endif
#endif
    return chunk;
}

int RealtimePitchStream::retrieve_to_ring() noexcept {
#if LT_ENGINE_REALTIME_STREAM_HAS_RB
    if (!stretcher_)
        return 0;
    int total = 0;
    while (stretcher_->available() > 0 && ring_free() > 0) {
        const int take = std::min({static_cast<int>(stretcher_->available()), config_.max_block_size, ring_free()});
        assert(take <= static_cast<int>(rb_output_[0].size()));
        stretcher_->retrieve(output_ptrs_.data(), static_cast<size_t>(take));
        push_ring(output_ptrs_.data(), take);
        total += take;
    }
    return total;
#else
    return 0;
#endif
}

int RealtimePitchStream::feed_required_input(const DecodedSource& source, int min_output_frames) noexcept {
    int produced = retrieve_to_ring();
    while (discard_remaining_ > 0) {
        const int discarded = discard_ring(discard_remaining_);
        discard_remaining_ -= discarded;
        if (discard_remaining_ <= 0)
            break;
        const int before = ring_available();
        process_source(source, current_source_frame_, config_.max_block_size);
        current_source_frame_ += config_.max_block_size;
        produced += retrieve_to_ring();
        if (ring_available() <= before)
            break;
    }
    int guard = 0;
    const int max_iterations = std::max(16, (min_output_frames / std::max(1, config_.max_block_size)) + 32);
    while (discard_remaining_ <= 0 && ring_available() < min_output_frames && guard++ < max_iterations) {
        int required = config_.max_block_size;
#if LT_ENGINE_REALTIME_STREAM_HAS_RB
        if (stretcher_)
            required = static_cast<int>(std::clamp<long>(stretcher_->getSamplesRequired(), 64, config_.max_block_size));
#endif
        process_source(source, current_source_frame_, required);
        current_source_frame_ += required;
        produced += retrieve_to_ring();
        if (current_source_frame_ >= source.duration_frames() && ring_available() == 0)
            break;
    }
    return produced;
}

void RealtimePitchStream::apply_reset_ramp(float** out, int out_channels, int frames) noexcept {
    if (reset_ramp_pos_ >= reset_ramp_frames_)
        return;
    out_channels = std::clamp(out_channels, 0, config_.channel_count);
    const int count = std::min(frames, reset_ramp_frames_ - reset_ramp_pos_);
    const int denom = std::max(1, reset_ramp_frames_ - 1);
    for (int f = 0; f < count; ++f) {
        const float x = static_cast<float>(reset_ramp_pos_ + f) / static_cast<float>(denom);
        const float g = x * x * (3.0f - 2.0f * x);
        for (int ch = 0; ch < out_channels; ++ch)
            out[ch][f] *= g;
    }
    reset_ramp_pos_ += count;
}

int RealtimePitchStream::render(const DecodedSource& source,
                                Frame source_frame,
                                Frame timeline_frame,
                                int frame_count,
                                float** out,
                                int out_channels) noexcept {
    if (frame_count <= 0 || out_channels <= 0)
        return 0;
    if (!out)
        return 0;
    out_channels = std::clamp(out_channels, 0, config_.channel_count);
    for (int ch = 0; ch < out_channels; ++ch) {
        if (!out[ch])
            return 0;
        std::fill(out[ch], out[ch] + frame_count, 0.0f);
    }
    render_thread_id_.store(current_thread_token(), std::memory_order_release);
    if (config_.semitones == 0.0) {
        const int read = source.read(source_frame, frame_count, out, std::min(out_channels, 2));
        current_output_timeline_frame_ = timeline_frame + read;
        return read;
    }
    // Never call reset_for_seek from the audio thread — it allocates and runs preroll loops.
    // The control thread primes at primed_timeline_frame_; on first render we may need to
    // discard a small gap if the clock advanced between priming and publishing.
    if (current_output_timeline_frame_ == -1) {
        // First render after a seek. The ring contains audio starting at primed_timeline_frame_.
        // Discard frames the clock advanced past while we were priming.
        Frame gap = 0;
        int ring_before = ring_available();
        if (primed_timeline_frame_ >= 0 && timeline_frame > primed_timeline_frame_) {
            gap = timeline_frame - primed_timeline_frame_;
            const int to_discard = static_cast<int>(std::min(gap, static_cast<Frame>(ring_available())));
            discard_ring(to_discard);
            // If gap exceeded ring contents, advance source position to compensate.
            // This keeps pitched and non-pitched tracks in sync at the seek point.
            if (gap > static_cast<Frame>(to_discard)) {
                current_source_frame_ += (gap - to_discard);
            }
        }
        pitch_stream_log("[PITCH_STREAM] first_render tl=%lld primed_tl=%lld gap=%lld ring_before=%d ring_now=%d src_pos=%lld\n",
            (long long)timeline_frame, (long long)primed_timeline_frame_,
            (long long)gap, ring_before, ring_available(), (long long)current_source_frame_);
        current_output_timeline_frame_ = timeline_frame;
    }

    if (timeline_frame != current_output_timeline_frame_) {
        pitch_stream_log("[PITCH_STREAM] mismatch tl=%lld expected=%lld delta=%lld ring=%d src_pos=%lld\n",
            (long long)timeline_frame, (long long)current_output_timeline_frame_,
            (long long)(timeline_frame - current_output_timeline_frame_),
            ring_available(), (long long)current_source_frame_);
        underflow_count_.fetch_add(1, std::memory_order_relaxed);
        current_output_timeline_frame_ = timeline_frame + frame_count;
        render_count_.fetch_add(1, std::memory_order_relaxed);
        return 0;
    }

    feed_required_input(source, frame_count);
    const int produced = pop_ring(out, out_channels, 0, frame_count);
    if (produced < frame_count) {
        underflow_count_.fetch_add(1, std::memory_order_relaxed);
        pitch_stream_log("[PITCH_STREAM] underflow tl=%lld wanted=%d got=%d ring=%d src_pos=%lld\n",
            (long long)timeline_frame, frame_count, produced, ring_available(), (long long)current_source_frame_);
    }
    if (produced > 0)
        primed_ = true;
    apply_reset_ramp(out, out_channels, produced);
    // Always advance by frame_count so current_output_timeline_frame_ stays in sync with the
    // audio clock even on underflow. Falling behind causes a growing delta → false mismatch.
    current_output_timeline_frame_ = timeline_frame + frame_count;
    render_count_.fetch_add(1, std::memory_order_relaxed);
    return produced;
}

void RealtimePitchStream::set_pitch_ratio_or_reset(const DecodedSource& source,
                                                   double semitones,
                                                   Frame source_frame,
                                                   Frame timeline_frame) {
    if (semitones == config_.semitones)
        return;
    note_control_mutation_if_published();
    Config next = config_;
    next.semitones = semitones;
    configure(next);
    reset_for_seek(source, source_frame, timeline_frame);
}

PitchStreamDiagnostics RealtimePitchStream::diagnostics() const noexcept {
    PitchStreamDiagnostics d;
    d.render_count = render_count_.load(std::memory_order_relaxed);
    d.underflow_count = underflow_count_.load(std::memory_order_relaxed);
    d.overflow_count = overflow_count_.load(std::memory_order_relaxed);
    d.reset_count = reset_count_.load(std::memory_order_relaxed);
    d.prime_count = prime_count_.load(std::memory_order_relaxed);
    d.source_miss_count = source_miss_count_.load(std::memory_order_relaxed);
    d.unsafe_cross_thread_reset_count = unsafe_cross_thread_reset_count_.load(std::memory_order_relaxed);
    d.concurrent_stream_mutation_detected = concurrent_stream_mutation_detected_.load(std::memory_order_relaxed);
    d.stream_generation = generation_.load(std::memory_order_relaxed);
    d.stream_reset_thread_id = reset_thread_id_.load(std::memory_order_relaxed);
    d.stream_render_thread_id = render_thread_id_.load(std::memory_order_relaxed);
    d.start_delay_frames = start_delay_frames_;
    d.preroll_frames = config_.preroll_frames;
    d.discarded_frames = discarded_frames_;
    d.compensated_latency_frames = start_delay_frames_ + config_.preroll_frames;
    d.ring_available_frames = ring_available();
    d.ring_capacity_frames = config_.ring_capacity_frames;
    d.stub_passthrough_count = stub_passthrough_count_.load(std::memory_order_relaxed);
    d.stub_passthrough_blocked_count = stub_passthrough_blocked_count_.load(std::memory_order_relaxed);
    d.backend_unavailable_count = backend_unavailable_count_.load(std::memory_order_relaxed);
#if LT_ENGINE_REALTIME_STREAM_HAS_RB
    d.pitch_backend = "rubberband";
    d.pitch_runtime_enabled = true;
#elif LT_ENGINE_ALLOW_RUNTIME_PITCH_STUB_PASSTHROUGH
    d.pitch_backend = "stub";
    d.pitch_runtime_enabled = false;
    d.pitch_muted_or_bypassed_reason = "stub passthrough active (test/stub build only)";
#else
    d.pitch_backend = "stub";
    d.pitch_runtime_enabled = false;
    d.pitch_muted_or_bypassed_reason = "real RubberBand backend unavailable; passthrough blocked to prevent silent original-audio bypass";
#endif
    return d;
}

} // namespace lt
