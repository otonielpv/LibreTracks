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
                             std::function<void(const Id&, int)> request_block)
    : source_id_(std::move(source_id))
    , cache_(cache)
    , request_block_(std::move(request_block))
    , channel_count_(channel_count)
    , sample_rate_(sample_rate)
    , duration_frames_(duration_frames)
{}

int DecodedSource::read(Frame offset_frames, int frame_count,
                         float** out, int out_channels) const noexcept {
    if (!is_loaded() || offset_frames >= duration_frames_)
        return 0;

    int readable = static_cast<int>(
        std::min<Frame>(frame_count, duration_frames_ - offset_frames));

    int ch_copy = std::min(out_channels, channel_count_);

    if (cache_) {
        int copied = 0;
        while (copied < readable) {
            const Frame absolute = offset_frames + copied;
            const int block_index = cache_->block_index_for(absolute);
            const int block_offset = cache_->offset_in_block(absolute);
            const int chunk = std::min(readable - copied,
                                       cache_->block_frames() - block_offset);
            bool missed_current_block = false;
            float* shifted[32];
            const int channels = std::min(out_channels, 32);
            for (int ch = 0; ch < channels; ++ch)
                shifted[ch] = out[ch] + copied;
            if (!cache_->read(source_id_, block_index, block_offset, chunk,
                              shifted, channels)) {
                if (lt_env_flag_enabled("LIBRETRACKS_JUMP_DEBUG")) {
                    lt_debug_log(
                        "[LT_JUMP_DEBUG][source] cache_miss source=%s frame=%lld block=%d offset=%d frames=%d\n",
                        source_id_.c_str(),
                        static_cast<long long>(absolute),
                        block_index,
                        block_offset,
                        chunk);
                }
                if (request_block_)
                    request_block_(source_id_, block_index);
                for (int ch = 0; ch < out_channels; ++ch)
                    std::fill(out[ch] + copied, out[ch] + copied + chunk, 0.f);
                // Count the silenced frames (streaming starvation) so the
                // snapshot can surface it in release builds.
                cache_miss_frames_.fetch_add(chunk, std::memory_order_relaxed);
                missed_current_block = true;
            }
            if (request_block_) {
                const int kReadAheadBlocks = streaming_read_ahead_blocks();
                int previous = read_ahead_anchor_block_.load(std::memory_order_relaxed);
                bool should_request = missed_current_block;
                while (!should_request) {
                    should_request = previous < 0 ||
                        block_index > previous ||
                        block_index + kReadAheadBlocks < previous;
                    if (!should_request)
                        break;
                    if (read_ahead_anchor_block_.compare_exchange_weak(
                            previous, block_index, std::memory_order_relaxed)) {
                        break;
                    }
                }
                if (missed_current_block) {
                    read_ahead_anchor_block_.store(block_index, std::memory_order_relaxed);
                }
                if (should_request) {
                    for (int ahead = 1; ahead <= kReadAheadBlocks; ++ahead) {
                        const int next_block = block_index + ahead;
                        const Frame next_start =
                            static_cast<Frame>(next_block) * cache_->block_frames();
                        if (next_start >= duration_frames_)
                            break;
                        request_block_(source_id_, next_block);
                    }
                }
            }
            copied += chunk;
        }

        for (int ch = ch_copy; ch < out_channels; ++ch)
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
    for (int ch = ch_copy; ch < out_channels; ++ch)
        std::fill(out[ch], out[ch] + readable, 0.f);

    return readable;
}

bool DecodedSource::is_range_ready(Frame offset_frames, int frame_count) const noexcept {
    if (!cache_)
        return is_loaded();
    if (frame_count <= 0)
        return true;
    if (offset_frames < 0 || offset_frames >= duration_frames_)
        return false;
    const int first = cache_->block_index_for(std::max<Frame>(0, offset_frames));
    const int last = cache_->block_index_for(
        std::max<Frame>(0, std::min<Frame>(duration_frames_ - 1,
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
