#include <lt_engine/sources/decoded_source.h>
#include <lt_engine/debug/logging.h>
#include <algorithm>
#include <cstring>
#include <limits>

namespace lt {

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
            }
            if (request_block_) {
                constexpr int kReadAheadBlocks = 2;
                for (int ahead = 1; ahead <= kReadAheadBlocks; ++ahead) {
                    const int next_block = block_index + ahead;
                    const Frame next_start =
                        static_cast<Frame>(next_block) * cache_->block_frames();
                    if (next_start >= duration_frames_)
                        break;
                    request_block_(source_id_, next_block);
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

    for (std::size_t bucket = 0; bucket < bucket_count; ++bucket) {
        const Frame start = static_cast<Frame>(bucket) * bucket_width;
        const Frame end = std::min<Frame>(duration_frames_, start + bucket_width);
        float min_peak = std::numeric_limits<float>::max();
        float max_peak = std::numeric_limits<float>::lowest();

        for (Frame frame = start; frame < end; ++frame) {
            const float* src = samples_.data() + frame * channel_count_;
            float value = 0.f;
            for (int ch = 0; ch < channel_count_; ++ch)
                value += src[ch];
            value /= static_cast<float>(channel_count_);
            value = std::clamp(value, -1.f, 1.f);
            min_peak = std::min(min_peak, value);
            max_peak = std::max(max_peak, value);
        }

        overview.min_peaks[bucket] = min_peak == std::numeric_limits<float>::max() ? 0.f : min_peak;
        overview.max_peaks[bucket] = max_peak == std::numeric_limits<float>::lowest() ? 0.f : max_peak;
    }

    return overview;
}

} // namespace lt
