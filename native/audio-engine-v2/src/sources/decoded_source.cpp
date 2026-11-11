#include <lt_engine/sources/decoded_source.h>
#include <lt_engine/debug/logging.h>
#include <algorithm>
#include <cstdlib>
#include <cstring>
#include <limits>

namespace lt {

namespace {

int streaming_read_ahead_blocks() {
    static const int value = [] {
        const char* raw = std::getenv("LIBRETRACKS_SOURCE_READ_AHEAD_BLOCKS");
        if (!raw) return 16;
        const int parsed = std::atoi(raw);
        return parsed >= 1 && parsed <= 256 ? parsed : 16;
    }();
    return value;
}

// Read once: this is checked on every cache miss on the audio thread, and an
// uncached getenv takes the CRT environment lock on Windows and builds a
// std::string, right when the callback is already starving.
bool jump_debug_enabled() {
    static const bool value = lt_env_flag_enabled("LIBRETRACKS_JUMP_DEBUG");
    return value;
}

} // namespace

DecodedSource::DecodedSource(std::vector<float> samples,
                             int                channel_count,
                             int                sample_rate,
                             Frame              duration_frames)
    : samples_(std::move(samples))
    , channel_count_(channel_count)
    , sample_rate_(sample_rate)
    , duration_frames_(duration_frames)
{}

DecodedSource::DecodedSource(Id                 source_id,
                             int                channel_count,
                             int                sample_rate,
                             Frame              duration_frames,
                             BlockCache*        cache,
                             std::function<void(const Id&, int, int, bool)> request_blocks)
    : source_id_(std::move(source_id))
    , cache_(cache)
    , request_blocks_(std::move(request_blocks))
    , channel_count_(channel_count)
    , sample_rate_(sample_rate)
    , duration_frames_(duration_frames)
{}

DecodedSource::DecodedSource(Id                 source_id,
                             int                channel_count,
                             int                native_sample_rate,
                             Frame              native_duration_frames,
                             int                engine_sample_rate,
                             BlockCache*        cache,
                             std::function<void(const Id&, int, int, bool)> request_blocks)
    : source_id_(std::move(source_id))
    , cache_(cache)
    , request_blocks_(std::move(request_blocks))
    , channel_count_(channel_count)
    , sample_rate_(engine_sample_rate)
    , native_duration_frames_(native_duration_frames)
{
    if (native_sample_rate != engine_sample_rate) {
        resampler_ = shared_sinc_interpolator(native_sample_rate, engine_sample_rate,
                                              kRealtimeResampleTaps);
        duration_frames_ = resampler_->output_length(native_duration_frames);
    } else {
        duration_frames_ = native_duration_frames;
    }
}

int DecodedSource::read(Frame offset_frames, int frame_count,
                         float** out, int out_channels) const noexcept {
    if (resampler_)
        return read_resampled(offset_frames, frame_count, out, out_channels);
    return read_stored(offset_frames, frame_count, out, out_channels);
}

void DecodedSource::native_span(Frame offset_frames, Frame frame_count,
                                Frame& first, Frame& last) const noexcept {
    const Frame stored = resampler_ ? native_duration_frames_ : duration_frames_;
    if (resampler_) {
        resampler_->source_span(offset_frames, frame_count, first, last);
    } else {
        first = offset_frames;
        last = offset_frames + std::max<Frame>(0, frame_count);
    }
    first = std::clamp<Frame>(first, 0, stored);
    last = std::clamp<Frame>(last, first, stored);
}

int DecodedSource::read_resampled(Frame offset_frames, int frame_count,
                                  float** out, int out_channels) const noexcept {
    if (!is_loaded() || frame_count <= 0 || offset_frames >= duration_frames_)
        return 0;
    const int readable = static_cast<int>(
        std::min<Frame>(frame_count, duration_frames_ - offset_frames));

    // Scratch on the stack (~27 KB): several render threads read sources at
    // once and the audio thread must not allocate. Not thread_local: a DLL's
    // TLS block is reserved in every thread of the process, and Android below
    // API 29 emulates TLS with a malloc on each thread's first touch.
    //
    // The native window is fixed and the chunk follows from the ratio, so the
    // common rates (44.1 <-> 48k) cover a whole callback in ONE cache read —
    // each read takes the block-cache lock — and only extreme ratios (192k)
    // split it further.
    constexpr int kChunk = 1024;
    constexpr int kSpan = 1160;
    float left[kSpan];
    float right[kSpan];
    float window[kSpan * 2];
    float rendered[kChunk * 2];

    const int ch = std::min(channel_count_, 2);
    const Frame num = resampler_->ratio_num();
    const Frame den = resampler_->ratio_den();
    const int max_chunk = static_cast<int>(std::min<Frame>(
        kChunk, (kSpan - resampler_->kernel_length() - 2) * den / num));
    if (max_chunk <= 0)
        return 0;

    int done = 0;
    while (done < readable) {
        const int n = std::min(max_chunk, readable - done);
        const Frame at = offset_frames + done;
        Frame first = 0, last = 0;
        native_span(at, n, first, last);
        int got = 0;
        if (last > first) {
            float* planes[2] = {left, right};
            got = read_stored(first, static_cast<int>(last - first), planes, ch);
        }
        for (int f = 0; f < got; ++f) {
            window[f * ch] = left[f];
            if (ch == 2) window[f * 2 + 1] = right[f];
        }
        resampler_->render(window, first, std::max(0, got), ch, at, n, rendered);

        for (int c = 0; c < out_channels; ++c) {
            float* dst = out[c] + done;
            if (c < ch) {
                for (int f = 0; f < n; ++f) dst[f] = rendered[f * ch + c];
            } else if (ch == 1 && c == 1) {
                for (int f = 0; f < n; ++f) dst[f] = rendered[f];
            } else {
                std::fill(dst, dst + n, 0.f);
            }
        }
        done += n;
    }
    return readable;
}

int DecodedSource::read_stored(Frame offset_frames, int frame_count,
                               float** out, int out_channels) const noexcept {
    const Frame stored_frames = resampler_ ? native_duration_frames_ : duration_frames_;
    if (!is_loaded() || offset_frames >= stored_frames)
        return 0;

    int readable = static_cast<int>(
        std::min<Frame>(frame_count, stored_frames - offset_frames));

    int ch_copy = std::min(out_channels, channel_count_);
    // Canales de salida con senal: una fuente mono pedida en estereo se
    // duplica en el segundo; solo los que sobren a partir de ahi van a cero.
    // (Antes la duplicacion se hacia y se volvia a poner a cero justo despues:
    // una fuente mono salia solo por la izquierda.)
    const int ch_filled = (channel_count_ == 1 && out_channels >= 2) ? 2 : ch_copy;

    if (cache_) {
        int copied = 0;
        while (copied < readable) {
            const Frame absolute = offset_frames + copied;
            const int block_index = cache_->block_index_for(absolute);
            const int block_offset = cache_->offset_in_block(absolute);
            const int chunk = std::min(readable - copied,
                                       cache_->block_frames() - block_offset);
            bool reask_starving_block = false;
            float* shifted[32];
            const int channels = std::min(out_channels, 32);
            for (int ch = 0; ch < channels; ++ch)
                shifted[ch] = out[ch] + copied;
            if (!cache_->read(source_id_, block_index, block_offset, chunk,
                              shifted, channels)) {
                if (jump_debug_enabled()) {
                    lt_debug_log(
                        "[LT_JUMP_DEBUG][source] cache_miss source=%s frame=%lld block=%d offset=%d frames=%d\n",
                        source_id_.c_str(),
                        static_cast<long long>(absolute),
                        block_index,
                        block_offset,
                        chunk);
                }
                if (request_blocks_) {
                    // URGENT: this is the block being silenced right now — but
                    // ask once per starving BLOCK, not once per silenced
                    // callback. See starving_block_ for why that difference
                    // decides whether the engine recovers or collapses.
                    const int previous_starving =
                        starving_block_.exchange(block_index, std::memory_order_relaxed);
                    int repeats = 0;
                    if (previous_starving == block_index) {
                        repeats = starving_repeats_.fetch_add(
                                      1, std::memory_order_relaxed) + 1;
                    } else {
                        starving_repeats_.store(0, std::memory_order_relaxed);
                    }
                    // ~170 ms between re-asks at a 256-frame buffer: soon
                    // enough that a dropped fill still recovers, rare enough
                    // that it cannot crowd the workers out of the queue.
                    constexpr int kStarveReaskCallbacks = 32;
                    reask_starving_block =
                        repeats == 0 || (repeats % kStarveReaskCallbacks) == 0;
                    if (reask_starving_block)
                        request_blocks_(source_id_, block_index, 1, /*urgent=*/true);
                }
                for (int ch = 0; ch < out_channels; ++ch)
                    std::fill(out[ch] + copied, out[ch] + copied + chunk, 0.f);
                // Count the silenced frames (streaming starvation) so the
                // snapshot can surface it in release builds.
                cache_miss_frames_.fetch_add(chunk, std::memory_order_relaxed);
            } else if (starving_block_.load(std::memory_order_relaxed) == block_index) {
                // Served again: clear the starvation state so the next miss on
                // this block counts as new and is re-asked immediately.
                starving_block_.store(-1, std::memory_order_relaxed);
                starving_repeats_.store(0, std::memory_order_relaxed);
            }
            if (request_blocks_) {
                const int kReadAheadBlocks = streaming_read_ahead_blocks();
                const int blocks_in_source = static_cast<int>(
                    (stored_frames + cache_->block_frames() - 1) /
                    cache_->block_frames());
                const int last_ahead = std::min(block_index + kReadAheadBlocks,
                                                blocks_in_source - 1);
                int covered = read_ahead_until_block_.load(std::memory_order_relaxed);
                while (last_ahead > block_index) {
                    // Normal forward playback extends the existing window by
                    // one edge block. A seek outside it rebuilds a full window.
                    const bool discontinuity =
                        covered < block_index || covered > last_ahead;
                    const int first_ahead = discontinuity
                        ? block_index + 1
                        : std::max(block_index + 1, covered + 1);
                    if (first_ahead > last_ahead)
                        break;
                    if (read_ahead_until_block_.compare_exchange_weak(
                            covered, last_ahead, std::memory_order_relaxed)) {
                        request_blocks_(source_id_, first_ahead,
                                        last_ahead - first_ahead + 1,
                                        /*urgent=*/false);
                        break;
                    }
                }
            }
            copied += chunk;
        }

        for (int ch = ch_filled; ch < out_channels; ++ch)
            std::fill(out[ch], out[ch] + copied, 0.f);
        return copied;
    }

    for (int ch = 0; ch < ch_copy; ++ch) {
        const float* src = samples_.data()
                         + offset_frames * channel_count_
                         + ch;
        float* dst = out[ch];
        for (int f = 0; f < readable; ++f) {
            dst[f] = src[f * channel_count_];
        }
    }

    // If source is mono and we have a stereo output, duplicate.
    if (channel_count_ == 1 && out_channels >= 2) {
        std::memcpy(out[1], out[0], sizeof(float) * readable);
    }

    // Zero any extra requested output channels.
    for (int ch = ch_filled; ch < out_channels; ++ch)
        std::fill(out[ch], out[ch] + readable, 0.f);

    return readable;
}

bool DecodedSource::is_range_ready(Frame offset_frames, int frame_count) const noexcept {
    if (!resampler_)
        return is_stored_range_ready(offset_frames, frame_count);
    if (frame_count <= 0)
        return true;
    if (offset_frames < 0 || offset_frames >= duration_frames_)
        return false;
    Frame first = 0, last = 0;
    native_span(offset_frames, frame_count, first, last);
    return last <= first || is_stored_range_ready(first, static_cast<int>(last - first));
}

bool DecodedSource::is_stored_range_ready(Frame offset_frames, int frame_count) const noexcept {
    if (!cache_)
        return is_loaded();
    if (frame_count <= 0)
        return true;
    const Frame stored_frames = resampler_ ? native_duration_frames_ : duration_frames_;
    if (offset_frames < 0 || offset_frames >= stored_frames)
        return false;
    const int first = cache_->block_index_for(std::max<Frame>(0, offset_frames));
    const int last = cache_->block_index_for(
        std::max<Frame>(0, std::min<Frame>(stored_frames - 1,
                                           offset_frames + frame_count - 1)));
    for (int block = first; block <= last; ++block) {
        if (!cache_->has_block(source_id_, block))
            return false;
    }
    return true;
}

SourcePeakOverview DecodedSource::peaks(int resolution_frames) const {
    SourcePeakOverview overview;
    overview.sample_rate = sample_rate_;
    overview.duration_frames = duration_frames_;
    overview.resolution_frames = std::max(1, resolution_frames);

    if (!is_loaded() || is_streaming() || channel_count_ <= 0 || duration_frames_ <= 0)
        return overview;

    const Frame bucket_width = static_cast<Frame>(overview.resolution_frames);
    const std::size_t bucket_count = static_cast<std::size_t>(
        (duration_frames_ + bucket_width - 1) / bucket_width);
    overview.min_peaks.assign(bucket_count, 0.f);
    overview.max_peaks.assign(bucket_count, 0.f);
    const bool has_right_channel = channel_count_ >= 2;
    if (has_right_channel) {
        overview.min_peaks_right.assign(bucket_count, 0.f);
        overview.max_peaks_right.assign(bucket_count, 0.f);
    }

    for (std::size_t bucket = 0; bucket < bucket_count; ++bucket) {
        const Frame start = static_cast<Frame>(bucket) * bucket_width;
        const Frame end = std::min<Frame>(duration_frames_, start + bucket_width);
        float min_peak = std::numeric_limits<float>::max();
        float max_peak = std::numeric_limits<float>::lowest();
        float min_peak_right = std::numeric_limits<float>::max();
        float max_peak_right = std::numeric_limits<float>::lowest();

        for (Frame frame = start; frame < end; ++frame) {
            const float* src = samples_.data() + frame * channel_count_;
            const float value = std::clamp(src[0], -1.f, 1.f);
            min_peak = std::min(min_peak, value);
            max_peak = std::max(max_peak, value);
            if (has_right_channel) {
                const float right = std::clamp(src[1], -1.f, 1.f);
                min_peak_right = std::min(min_peak_right, right);
                max_peak_right = std::max(max_peak_right, right);
            }
        }

        overview.min_peaks[bucket] = min_peak == std::numeric_limits<float>::max() ? 0.f : min_peak;
        overview.max_peaks[bucket] = max_peak == std::numeric_limits<float>::lowest() ? 0.f : max_peak;
        if (has_right_channel) {
            overview.min_peaks_right[bucket] =
                min_peak_right == std::numeric_limits<float>::max() ? 0.f : min_peak_right;
            overview.max_peaks_right[bucket] =
                max_peak_right == std::numeric_limits<float>::lowest() ? 0.f : max_peak_right;
        }
    }

    return overview;
}

} // namespace lt
