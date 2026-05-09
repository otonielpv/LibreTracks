#include <lt_engine/sources/decoded_source.h>
#include <algorithm>
#include <cstring>

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

int DecodedSource::read(Frame offset_frames, int frame_count,
                         float** out, int out_channels) const noexcept {
    if (!is_loaded() || offset_frames >= duration_frames_)
        return 0;

    int readable = static_cast<int>(
        std::min<Frame>(frame_count, duration_frames_ - offset_frames));

    int ch_copy = std::min(out_channels, channel_count_);

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

} // namespace lt
