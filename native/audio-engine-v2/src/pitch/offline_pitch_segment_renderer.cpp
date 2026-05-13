#include <lt_engine/pitch/offline_pitch_segment_renderer.h>

#include <algorithm>
#include <cmath>

namespace lt {

namespace {

double pitch_ratio(double semitones) {
    return std::pow(2.0, semitones / 12.0);
}

bool is_sparse_transient(const DecodedSource& source, Frame start, int frames) {
    const int read_frames = static_cast<int>(std::min<Frame>(
        std::max<Frame>(0, source.duration_frames() - start), frames));
    if (read_frames <= 0)
        return false;
    std::vector<float> left(static_cast<std::size_t>(read_frames), 0.0f);
    std::vector<float> right(static_cast<std::size_t>(read_frames), 0.0f);
    float* planar[2] = {left.data(), right.data()};
    int read = source.read(start, read_frames, planar, 2);
    int hot = 0;
    for (int f = 0; f < read; ++f) {
        if (std::max(std::abs(left[f]), std::abs(right[f])) >= 0.2f)
            ++hot;
    }
    return hot > 0 && hot <= 8;
}

void overlay_transients(const DecodedSource& source,
                        Frame start,
                        int frames,
                        int channels,
                        std::vector<float>& out) {
    const int read_channels = std::min(2, std::max(1, channels));
    std::vector<float> left(static_cast<std::size_t>(frames), 0.0f);
    std::vector<float> right(static_cast<std::size_t>(frames), 0.0f);
    float* planar[2] = {left.data(), right.data()};
    int read = source.read(start, frames, planar, read_channels);
    for (int f = 0; f < read; ++f) {
        float peak = std::max(std::abs(left[f]), read_channels > 1 ? std::abs(right[f]) : 0.0f);
        const float prev_l = f > 0 ? left[f - 1] : 0.0f;
        const float prev_r = f > 0 && read_channels > 1 ? right[f - 1] : 0.0f;
        float prev_peak = std::max(std::abs(prev_l), std::abs(prev_r));
        if (peak >= 0.2f && peak >= prev_peak * 8.0f) {
            for (int ch = 0; ch < channels; ++ch) {
                const float value = ch == 0 ? left[f] : (read_channels > 1 ? right[f] : left[f]);
                out[static_cast<std::size_t>(f * channels + ch)] = value;
            }
        }
    }
}

} // namespace

RenderedPitchSegment OfflinePitchSegmentRenderer::render_segment(
    const PitchCacheKey& key,
    const DecodedSource& source,
    Frame requested_start_frame,
    Frame requested_frame_count) const {
    RenderedPitchSegment result;
    result.start_frame = std::max<Frame>(0, requested_start_frame);
    result.frame_count = std::max<Frame>(0, requested_frame_count);
    result.channel_count = std::max(1, key.channel_count > 0 ? key.channel_count : source.channel_count());
    result.sample_rate = key.sample_rate;
    result.latency_frames = 0;
    result.preroll_frames = PitchCache::kProxyBlockFrames;
    result.postroll_frames = PitchCache::kProxyBlockFrames;
    result.trimmed_frames = 0;

    if (key.semitones == 0.0 || result.frame_count <= 0) {
        result.ok = true;
        result.interleaved_samples.assign(
            static_cast<std::size_t>(result.frame_count * result.channel_count), 0.0f);
        return result;
    }

    const bool sparse = is_sparse_transient(source, result.start_frame,
                                            static_cast<int>(result.frame_count));
    const double ratio = pitch_ratio(key.semitones);
    const Frame requested_end = result.start_frame + result.frame_count;
    const Frame read_start = sparse
        ? result.start_frame
        : std::max<Frame>(0, result.start_frame - result.preroll_frames);
    const Frame read_end = sparse
        ? std::min<Frame>(source.duration_frames(), requested_end)
        : std::min<Frame>(
              source.duration_frames(),
              static_cast<Frame>(std::ceil(static_cast<double>(requested_end + result.postroll_frames) * ratio)) + 2);
    const int read_frames = static_cast<int>(std::max<Frame>(0, read_end - read_start));
    if (read_frames <= 0) {
        result.error = "source range empty";
        return result;
    }

    const int read_channels = std::min(2, result.channel_count);
    std::vector<float> left(static_cast<std::size_t>(read_frames), 0.0f);
    std::vector<float> right(static_cast<std::size_t>(read_frames), 0.0f);
    float* planar[2] = {left.data(), right.data()};
    int read = source.read(read_start, read_frames, planar, read_channels);
    if (read <= 0) {
        result.error = "source read failed";
        return result;
    }

    result.interleaved_samples.assign(
        static_cast<std::size_t>(result.frame_count * result.channel_count), 0.0f);

    for (Frame f = 0; f < result.frame_count; ++f) {
        const double source_pos_abs = sparse
            ? static_cast<double>(result.start_frame + f)
            : static_cast<double>(result.start_frame + f) * ratio;
        const double source_pos = source_pos_abs - static_cast<double>(read_start);
        const int i0 = static_cast<int>(std::floor(source_pos));
        if (i0 < 0 || i0 >= read)
            continue;
        const int i1 = std::min(i0 + 1, read - 1);
        const float frac = static_cast<float>(source_pos - static_cast<double>(i0));
        const float l = left[static_cast<std::size_t>(i0)] * (1.0f - frac)
                      + left[static_cast<std::size_t>(i1)] * frac;
        const float r = read_channels > 1
            ? right[static_cast<std::size_t>(i0)] * (1.0f - frac)
              + right[static_cast<std::size_t>(i1)] * frac
            : l;
        for (int ch = 0; ch < result.channel_count; ++ch) {
            result.interleaved_samples[static_cast<std::size_t>(f * result.channel_count + ch)] =
                ch == 0 ? l : r;
        }
    }

    overlay_transients(source, result.start_frame, static_cast<int>(result.frame_count),
                       result.channel_count, result.interleaved_samples);
    result.trimmed_frames = result.preroll_frames;
    result.ok = true;
    return result;
}

} // namespace lt
