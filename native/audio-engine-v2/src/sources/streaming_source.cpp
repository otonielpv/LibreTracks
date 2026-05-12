#include <lt_engine/sources/streaming_source.h>
#include <algorithm>
#include <cstring>

namespace lt {

// ---------------------------------------------------------------------------
// StreamingSource
// ---------------------------------------------------------------------------
StreamingSource::StreamingSource(Id                  source_id,
                                  int                 channel_count,
                                  int                 sample_rate,
                                  Frame               duration_frames,
                                  BlockCache*         cache,
                                  StarvationCallback  on_starve)
    : source_id_(std::move(source_id))
    , channel_count_(channel_count)
    , sample_rate_(sample_rate)
    , duration_frames_(duration_frames)
    , cache_(cache)
    , on_starve_(std::move(on_starve))
{}

int StreamingSource::read(Frame   offset_frames,
                           int     frame_count,
                           float** out,
                           int     num_channels) noexcept {
    if (!cache_ || frame_count <= 0) {
        for (int ch = 0; ch < num_channels; ++ch)
            std::fill(out[ch], out[ch] + frame_count, 0.f);
        return frame_count;
    }

    int frames_written = 0;

    while (frames_written < frame_count) {
        Frame  current_frame = offset_frames + frames_written;
        int    block_index   = cache_->block_index_for(current_frame);
        int    block_offset  = cache_->offset_in_block(current_frame);
        int    remaining     = frame_count - frames_written;

        // Offset output pointers to current write position.
        float* shifted[32];
        int    out_ch = std::min(num_channels, 32);
        for (int ch = 0; ch < out_ch; ++ch)
            shifted[ch] = out[ch] + frames_written;

        bool hit = cache_->read(source_id_,
                                block_index,
                                block_offset,
                                remaining,
                                shifted,
                                out_ch);

        int this_block_max = cache_->block_frames() - block_offset;
        int this_step      = std::min(remaining, this_block_max);

        if (!hit) {
            // Fill silence for this block's portion.
            for (int ch = 0; ch < num_channels; ++ch)
                std::fill(out[ch] + frames_written,
                          out[ch] + frames_written + this_step, 0.f);

            starvation_count_.fetch_add(1, std::memory_order_relaxed);
            if (on_starve_)
                on_starve_(source_id_, block_index);
        }

        frames_written += this_step;
    }

    return frame_count;
}

// ---------------------------------------------------------------------------
// PreparedSource
// ---------------------------------------------------------------------------
PreparedSource::PreparedSource(Id                id,
                                std::vector<float> samples,
                                int               channel_count,
                                int               sample_rate,
                                Frame             duration_frames)
    : id_(std::move(id))
    , samples_(std::move(samples))
    , channel_count_(channel_count)
    , sample_rate_(sample_rate)
    , duration_frames_(duration_frames)
{}

int PreparedSource::read(Frame   offset_frames,
                          int     frame_count,
                          float** out,
                          int     num_channels) noexcept {
    const int src_ch   = channel_count_;
    const Frame total  = duration_frames_;

    for (int f = 0; f < frame_count; ++f) {
        Frame src_frame = offset_frames + f;
        if (src_frame < 0 || src_frame >= total) {
            for (int ch = 0; ch < num_channels; ++ch)
                out[ch][f] = 0.f;
        } else {
            const float* row = samples_.data() + src_frame * src_ch;
            for (int ch = 0; ch < num_channels; ++ch) {
                int src_c  = (src_ch > 0) ? std::min(ch, src_ch - 1) : 0;
                out[ch][f] = row[src_c];
            }
        }
    }
    return frame_count;
}

// ---------------------------------------------------------------------------
// SilentSource
// ---------------------------------------------------------------------------
SilentSource::SilentSource(int channel_count, int sample_rate, Frame duration_frames)
    : channel_count_(channel_count)
    , sample_rate_(sample_rate)
    , duration_frames_(duration_frames)
{}

int SilentSource::read(Frame, int frame_count, float** out, int num_channels) noexcept {
    for (int ch = 0; ch < num_channels; ++ch)
        std::fill(out[ch], out[ch] + frame_count, 0.f);
    return frame_count;
}

} // namespace lt
