#include <lt_engine/pitch/seek_safe_pitch_stream.h>

#include <algorithm>
#include <cmath>
#include <map>
#include <mutex>
#include <tuple>

#if LT_ENGINE_USE_RUBBERBAND && __has_include(<rubberband/RubberBandStretcher.h>)
#  define LT_ENGINE_SEEK_SAFE_HAS_RUBBERBAND_IMPL 1
#  include <rubberband/RubberBandStretcher.h>
#elif LT_ENGINE_USE_RUBBERBAND && __has_include(<RubberBandStretcher.h>)
#  define LT_ENGINE_SEEK_SAFE_HAS_RUBBERBAND_IMPL 1
#  include <RubberBandStretcher.h>
#else
#  define LT_ENGINE_SEEK_SAFE_HAS_RUBBERBAND_IMPL 0
#endif

namespace lt {

namespace {

double semitones_to_ratio(double semitones) noexcept {
    return std::pow(2.0, semitones / 12.0);
}

#if LT_ENGINE_SEEK_SAFE_HAS_RUBBERBAND_IMPL
int calibrate_realtime_alignment(int sample_rate, int channel_count, double semitones) {
    if (semitones == 0.0)
        return 0;

    static std::mutex mutex;
    static std::map<std::tuple<int, int, int>, int> cache;
    const auto cache_key = std::make_tuple(sample_rate, channel_count,
                                           static_cast<int>(std::lround(semitones * 100.0)));
    {
        std::lock_guard lock(mutex);
        auto it = cache.find(cache_key);
        if (it != cache.end())
            return it->second;
    }

    using RBOption = RubberBand::RubberBandStretcher::Option;
    const int options = RBOption::OptionProcessRealTime
                      | RBOption::OptionPitchHighConsistency
                      | RBOption::OptionChannelsTogether;
    RubberBand::RubberBandStretcher rb(static_cast<size_t>(sample_rate),
                                       static_cast<size_t>(channel_count),
                                       options,
                                       1.0,
                                       semitones_to_ratio(semitones));
    rb.setTimeRatio(1.0);
    rb.setPitchScale(semitones_to_ratio(semitones));

    constexpr int kFrames = 16384;
    constexpr int kImpulse = 4096;
    constexpr int kChunk = 4096;
    std::vector<std::vector<float>> input(static_cast<std::size_t>(channel_count));
    std::vector<std::vector<float>> output(static_cast<std::size_t>(channel_count));
    std::vector<float*> in_ptrs(static_cast<std::size_t>(channel_count));
    std::vector<float*> out_ptrs(static_cast<std::size_t>(channel_count));
    for (int ch = 0; ch < channel_count; ++ch) {
        input[static_cast<std::size_t>(ch)].assign(kChunk, 0.0f);
        output[static_cast<std::size_t>(ch)].assign(kChunk, 0.0f);
        in_ptrs[static_cast<std::size_t>(ch)] = input[static_cast<std::size_t>(ch)].data();
        out_ptrs[static_cast<std::size_t>(ch)] = output[static_cast<std::size_t>(ch)].data();
    }

    int start_pad = static_cast<int>(rb.getPreferredStartPad());
    while (start_pad > 0) {
        const int chunk = std::min(start_pad, kChunk);
        for (auto& channel : input)
            std::fill(channel.begin(), channel.begin() + chunk, 0.0f);
        rb.process(in_ptrs.data(), static_cast<size_t>(chunk), false);
        start_pad -= chunk;
    }

    int discard = static_cast<int>(rb.getStartDelay());
    int produced = 0;
    int input_frame = 0;
    std::vector<float> rendered(kFrames, 0.0f);
    for (int guard = 0; produced < kFrames && guard < 64; ++guard) {
        while (discard > 0 && rb.available() > 0) {
            const int take = std::min({discard, static_cast<int>(rb.available()), kChunk});
            rb.retrieve(out_ptrs.data(), static_cast<size_t>(take));
            discard -= take;
        }
        while (discard == 0 && produced < kFrames && rb.available() > 0) {
            const int take = std::min({kFrames - produced, static_cast<int>(rb.available()), kChunk});
            rb.retrieve(out_ptrs.data(), static_cast<size_t>(take));
            std::copy(output[0].begin(), output[0].begin() + take, rendered.begin() + produced);
            produced += take;
        }
        if (produced >= kFrames)
            break;
        for (auto& channel : input)
            std::fill(channel.begin(), channel.end(), 0.0f);
        if (input_frame <= kImpulse && kImpulse < input_frame + kChunk) {
            const int offset = kImpulse - input_frame;
            for (auto& channel : input)
                channel[static_cast<std::size_t>(offset)] = 1.0f;
        }
        rb.process(in_ptrs.data(), kChunk, false);
        input_frame += kChunk;
    }

    int correction = 0;
    for (int i = 0; i < produced; ++i) {
        if (std::abs(rendered[static_cast<std::size_t>(i)]) >= 0.2f) {
            correction = std::clamp(i - kImpulse, -kChunk, kChunk);
            break;
        }
    }
    {
        std::lock_guard lock(mutex);
        cache.emplace(cache_key, correction);
    }
    return correction;
}
#endif

float smoothstep(float x) noexcept {
    x = std::clamp(x, 0.0f, 1.0f);
    return x * x * (3.0f - 2.0f * x);
}

} // namespace

SeekSafePitchStream::SeekSafePitchStream() = default;
SeekSafePitchStream::~SeekSafePitchStream() {
#if LT_ENGINE_SEEK_SAFE_HAS_RUBBERBAND_IMPL
    if (rb_)
        rb_->reset();
#endif
}

void SeekSafePitchStream::configure(const Config& config) {
    if (configured_
        && config.sample_rate == config_.sample_rate
        && config.channel_count == config_.channel_count
        && config.semitones == config_.semitones)
        return;

    config_ = config;
    config_.channel_count = std::clamp(config_.channel_count, 1, kMaxChannels);
    configured_ = true;
    ready_ = false;
    expected_source_frame_ = -1;
    ensure_buffers();

#if LT_ENGINE_SEEK_SAFE_HAS_RUBBERBAND_IMPL
    rb_.reset();
    alignment_correction_frames_ = 0;
#endif
}

void SeekSafePitchStream::ensure_buffers() {
    const int channels = std::max(1, config_.channel_count);
    input_.assign(static_cast<std::size_t>(channels), {});
    output_.assign(static_cast<std::size_t>(channels), {});
    input_ptrs_.assign(static_cast<std::size_t>(channels), nullptr);
    output_ptrs_.assign(static_cast<std::size_t>(channels), nullptr);
    for (int ch = 0; ch < channels; ++ch) {
        input_[static_cast<std::size_t>(ch)].assign(kMaxChunkFrames, 0.0f);
        output_[static_cast<std::size_t>(ch)].assign(kMaxChunkFrames, 0.0f);
        input_ptrs_[static_cast<std::size_t>(ch)] = input_[static_cast<std::size_t>(ch)].data();
        output_ptrs_[static_cast<std::size_t>(ch)] = output_[static_cast<std::size_t>(ch)].data();
    }
}

void SeekSafePitchStream::reset_for_seek(const DecodedSource& source, Frame target_source_frame) {
    if (!configured_)
        configure(Config{source.sample_rate(), source.channel_count(), config_.semitones});

    target_source_frame = std::max<Frame>(0, target_source_frame);
    ready_ = false;
    expected_source_frame_ = target_source_frame;
    feed_source_frame_ = target_source_frame;
    start_pad_frames_ = 0;
    start_delay_frames_ = 0;
    preroll_frames_ = 0;
    discard_remaining_ = 0;
    discarded_frames_ = 0;
    fade_frames_ = std::clamp(config_.sample_rate / 100, 240, 960);
    fade_processed_ = 0;

#if LT_ENGINE_SEEK_SAFE_HAS_RUBBERBAND_IMPL
    if (config_.semitones == 0.0) {
        rb_.reset();
        ready_ = true;
        return;
    }

    using RBOption = RubberBand::RubberBandStretcher::Option;
    const int options = RBOption::OptionProcessRealTime
                      | RBOption::OptionPitchHighConsistency
                      | RBOption::OptionChannelsTogether;
    rb_ = std::make_unique<RubberBand::RubberBandStretcher>(
        static_cast<size_t>(config_.sample_rate),
        static_cast<size_t>(config_.channel_count),
        options,
        1.0,
        semitones_to_ratio(config_.semitones));
    rb_->setTimeRatio(1.0);
    rb_->setPitchScale(semitones_to_ratio(config_.semitones));

    start_pad_frames_ = static_cast<int>(rb_->getPreferredStartPad());
    start_delay_frames_ = static_cast<int>(rb_->getStartDelay());
    alignment_correction_frames_ = 0;
    preroll_frames_ = std::clamp(config_.sample_rate / 20, 1024, 4096);

    process_zeroes(start_pad_frames_);

    const Frame read_start = std::max<Frame>(0, target_source_frame - preroll_frames_);
    const int pretarget_frames = static_cast<int>(target_source_frame - read_start);
    feed_source_frame_ = read_start;
    int preroll_left = pretarget_frames;
    while (preroll_left > 0) {
        const int chunk = std::min(preroll_left, kMaxChunkFrames);
        process_source(source, feed_source_frame_, chunk);
        feed_source_frame_ += chunk;
        preroll_left -= chunk;
    }
    discard_remaining_ = std::max(0, start_delay_frames_ + pretarget_frames);
    while (discard_remaining_ > 0) {
        const int before = discard_remaining_;
        discard_available();
        if (discard_remaining_ <= 0 || discard_remaining_ == before)
            break;
    }
#endif
    ready_ = true;
}

void SeekSafePitchStream::process_zeroes(int frames) noexcept {
#if LT_ENGINE_SEEK_SAFE_HAS_RUBBERBAND_IMPL
    if (!rb_ || frames <= 0)
        return;
    while (frames > 0) {
        const int chunk = std::min(frames, kMaxChunkFrames);
        for (int ch = 0; ch < config_.channel_count; ++ch)
            std::fill(input_[static_cast<std::size_t>(ch)].begin(),
                      input_[static_cast<std::size_t>(ch)].begin() + chunk,
                      0.0f);
        rb_->process(input_ptrs_.data(), static_cast<size_t>(chunk), false);
        frames -= chunk;
    }
#else
    (void)frames;
#endif
}

int SeekSafePitchStream::process_source(const DecodedSource& source, Frame start, int frames) noexcept {
    if (frames <= 0)
        return 0;
    const int chunk = std::min(frames, kMaxChunkFrames);
    for (int ch = 0; ch < config_.channel_count; ++ch)
        std::fill(input_[static_cast<std::size_t>(ch)].begin(),
                  input_[static_cast<std::size_t>(ch)].begin() + chunk,
                  0.0f);
    const int read_channels = std::min({2, config_.channel_count, source.channel_count()});
    int read = 0;
    if (start < source.duration_frames()) {
        read = source.read(start, chunk, input_ptrs_.data(), read_channels);
        if (read_channels == 1 && config_.channel_count > 1) {
            for (int ch = 1; ch < config_.channel_count; ++ch)
                std::copy(input_[0].begin(), input_[0].begin() + read,
                          input_[static_cast<std::size_t>(ch)].begin());
        } else if (config_.channel_count > 2) {
            for (int ch = 2; ch < config_.channel_count; ++ch)
                std::copy(input_[1].begin(), input_[1].begin() + read,
                          input_[static_cast<std::size_t>(ch)].begin());
        }
    }

#if LT_ENGINE_SEEK_SAFE_HAS_RUBBERBAND_IMPL
    if (rb_)
        rb_->process(input_ptrs_.data(), static_cast<size_t>(chunk), false);
#endif
    return chunk;
}

int SeekSafePitchStream::discard_available() noexcept {
#if LT_ENGINE_SEEK_SAFE_HAS_RUBBERBAND_IMPL
    if (!rb_ || discard_remaining_ <= 0)
        return 0;
    int discarded = 0;
    while (discard_remaining_ > 0) {
        const int available = static_cast<int>(rb_->available());
        if (available <= 0)
            break;
        const int take = std::min({available, discard_remaining_, kMaxChunkFrames});
        rb_->retrieve(output_ptrs_.data(), static_cast<size_t>(take));
        discard_remaining_ -= take;
        discarded += take;
        discarded_frames_ += take;
    }
    return discarded;
#else
    return 0;
#endif
}

int SeekSafePitchStream::retrieve_available(float** out,
                                            int out_channels,
                                            int offset,
                                            int frames) noexcept {
#if LT_ENGINE_SEEK_SAFE_HAS_RUBBERBAND_IMPL
    if (!rb_ || frames <= 0)
        return 0;
    discard_available();
    const int available = static_cast<int>(rb_->available());
    if (available <= 0)
        return 0;
    const int take = std::min({available, frames, kMaxChunkFrames});
    rb_->retrieve(output_ptrs_.data(), static_cast<size_t>(take));
    for (int ch = 0; ch < out_channels; ++ch) {
        const int src_ch = std::min(ch, config_.channel_count - 1);
        std::copy(output_[static_cast<std::size_t>(src_ch)].begin(),
                  output_[static_cast<std::size_t>(src_ch)].begin() + take,
                  out[ch] + offset);
    }
    return take;
#else
    (void)out;
    (void)out_channels;
    (void)offset;
    (void)frames;
    return 0;
#endif
}

void SeekSafePitchStream::apply_reset_fade(float** out, int out_channels, int frames) noexcept {
    if (fade_processed_ >= fade_frames_ || frames <= 0)
        return;
    const int fade_count = std::min(frames, fade_frames_ - fade_processed_);
    const int denom = std::max(1, fade_frames_ - 1);
    for (int f = 0; f < fade_count; ++f) {
        const float gain = smoothstep(static_cast<float>(fade_processed_ + f)
                                      / static_cast<float>(denom));
        for (int ch = 0; ch < out_channels; ++ch)
            out[ch][f] *= gain;
    }
    fade_processed_ += fade_count;
}

int SeekSafePitchStream::render_aligned(const DecodedSource& source,
                                        Frame source_frame,
                                        int frame_count,
                                        float** out,
                                        int out_channels) noexcept {
    if (frame_count <= 0 || out_channels <= 0)
        return 0;

    if (!configured_)
        configure(Config{source.sample_rate(), source.channel_count(), config_.semitones});

    for (int ch = 0; ch < out_channels; ++ch)
        std::fill(out[ch], out[ch] + frame_count, 0.0f);

    if (config_.semitones == 0.0) {
        const int read = source.read(source_frame, frame_count, out, std::min(out_channels, 2));
        expected_source_frame_ = source_frame + read;
        return read;
    }

#if LT_ENGINE_SEEK_SAFE_HAS_RUBBERBAND_IMPL
    if (!ready_ || expected_source_frame_ != source_frame)
        reset_for_seek(source, source_frame);

    int produced = 0;
    int guard = 0;
    while (produced < frame_count && guard++ < 4) {
        produced += retrieve_available(out, out_channels, produced, frame_count - produced);
        if (produced >= frame_count)
            break;

        const int need = frame_count - produced;
        const int chunk = std::min(kMaxChunkFrames, std::max(need + discard_remaining_, 256));
        process_source(source, feed_source_frame_, chunk);
        feed_source_frame_ += chunk;
    }

    apply_reset_fade(out, out_channels, produced);
    expected_source_frame_ = source_frame + produced;
    return produced;
#else
    const int read = source.read(source_frame, frame_count, out, std::min(out_channels, 2));
    expected_source_frame_ = source_frame + read;
    return read;
#endif
}

} // namespace lt
