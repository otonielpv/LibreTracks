#include <lt_engine/pitch/offline_pitch_segment_renderer.h>

#include <algorithm>
#include <cmath>

#if LT_ENGINE_USE_RUBBERBAND && __has_include(<rubberband/RubberBandStretcher.h>)
#  define LT_ENGINE_OFFLINE_HAS_RUBBERBAND 1
#  include <rubberband/RubberBandStretcher.h>
#elif LT_ENGINE_USE_RUBBERBAND && __has_include(<RubberBandStretcher.h>)
#  define LT_ENGINE_OFFLINE_HAS_RUBBERBAND 1
#  include <RubberBandStretcher.h>
#else
#  define LT_ENGINE_OFFLINE_HAS_RUBBERBAND 0
#endif

namespace lt {

namespace {

double pitch_scale(double semitones) {
    return std::pow(2.0, semitones / 12.0);
}

void read_source_interleaved(const DecodedSource& source,
                             Frame start,
                             int frames,
                             int channels,
                             std::vector<float>& out) {
    out.assign(static_cast<std::size_t>(frames * channels), 0.0f);
    if (frames <= 0)
        return;

    const int read_channels = std::min(2, std::max(1, channels));
    std::vector<float> left(static_cast<std::size_t>(frames), 0.0f);
    std::vector<float> right(static_cast<std::size_t>(frames), 0.0f);
    float* planar[2] = {left.data(), right.data()};
    const int read = source.read(start, frames, planar, read_channels);
    for (int f = 0; f < read; ++f) {
        for (int ch = 0; ch < channels; ++ch) {
            out[static_cast<std::size_t>(f * channels + ch)] =
                ch == 0 || read_channels == 1 ? left[static_cast<std::size_t>(f)]
                                               : right[static_cast<std::size_t>(f)];
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
    result.sample_rate = key.sample_rate > 0 ? key.sample_rate : source.sample_rate();
    result.latency_frames = 0;
    result.preroll_frames = PitchCache::kProxyBlockFrames;
    result.postroll_frames = PitchCache::kProxyBlockFrames;
    result.trimmed_frames = 0;
    result.interleaved_samples.assign(
        static_cast<std::size_t>(result.frame_count * result.channel_count), 0.0f);

    if (result.frame_count <= 0) {
        result.ok = true;
        return result;
    }

    const Frame source_duration = source.duration_frames();
    if (result.start_frame >= source_duration) {
        result.ok = true;
        return result;
    }

    if (key.semitones == 0.0) {
        read_source_interleaved(source, result.start_frame, static_cast<int>(result.frame_count),
                                result.channel_count, result.interleaved_samples);
        result.ok = true;
        return result;
    }

#if LT_ENGINE_OFFLINE_HAS_RUBBERBAND
    const Frame read_start = std::max<Frame>(0, result.start_frame - result.preroll_frames);
    const Frame requested_end = result.start_frame + result.frame_count;
    const Frame read_end = std::min<Frame>(source_duration, requested_end + result.postroll_frames);
    const int read_frames = static_cast<int>(std::max<Frame>(0, read_end - read_start));
    if (read_frames <= 0) {
        result.error = "source range empty";
        return result;
    }

    const int channels = result.channel_count;
    std::vector<std::vector<float>> input(static_cast<std::size_t>(channels));
    for (auto& channel : input)
        channel.assign(static_cast<std::size_t>(read_frames), 0.0f);

    const int read_channels = std::min(2, channels);
    float* read_planar[2] = {input[0].data(), input[std::min(1, channels - 1)].data()};
    const int read = source.read(read_start, read_frames, read_planar, read_channels);
    if (read <= 0) {
        result.error = "source read failed";
        return result;
    }
    if (read_channels == 1 && channels > 1) {
        for (int ch = 1; ch < channels; ++ch)
            std::copy(input[0].begin(), input[0].end(), input[static_cast<std::size_t>(ch)].begin());
    } else if (channels > 2) {
        for (int ch = 2; ch < channels; ++ch)
            std::copy(input[1].begin(), input[1].end(), input[static_cast<std::size_t>(ch)].begin());
    }

    std::vector<float*> in_ptrs(static_cast<std::size_t>(channels));
    for (int ch = 0; ch < channels; ++ch)
        in_ptrs[static_cast<std::size_t>(ch)] = input[static_cast<std::size_t>(ch)].data();

    using RBOption = RubberBand::RubberBandStretcher::Option;
    int options = RBOption::OptionProcessOffline
                | RBOption::OptionPitchHighConsistency
                | RBOption::OptionChannelsTogether;
    RubberBand::RubberBandStretcher rb(static_cast<size_t>(result.sample_rate),
                                       static_cast<size_t>(channels),
                                       options,
                                       1.0,
                                       pitch_scale(key.semitones));
    rb.setTimeRatio(1.0);
    rb.setPitchScale(pitch_scale(key.semitones));
    rb.study(in_ptrs.data(), static_cast<size_t>(read), true);
    rb.process(in_ptrs.data(), static_cast<size_t>(read), true);
    result.latency_frames = static_cast<int>(rb.getLatency());

    int available = static_cast<int>(rb.available());
    if (available < 0)
        available = 0;
    const int trim_start = static_cast<int>(result.start_frame - read_start);
    const int needed = trim_start + static_cast<int>(result.frame_count);
    const int retrieve_frames = std::max(available, needed);
    std::vector<std::vector<float>> processed(static_cast<std::size_t>(channels));
    for (auto& channel : processed)
        channel.assign(static_cast<std::size_t>(std::max(1, retrieve_frames)), 0.0f);
    std::vector<float*> out_ptrs(static_cast<std::size_t>(channels));
    for (int ch = 0; ch < channels; ++ch)
        out_ptrs[static_cast<std::size_t>(ch)] = processed[static_cast<std::size_t>(ch)].data();
    const int retrieved = available > 0
        ? static_cast<int>(rb.retrieve(out_ptrs.data(), static_cast<size_t>(available)))
        : 0;

    if (retrieved < needed) {
        result.error = "RubberBand returned fewer frames than requested window";
    }

    for (Frame f = 0; f < result.frame_count; ++f) {
        const int src = trim_start + static_cast<int>(f);
        if (src < 0 || src >= retrieved)
            continue;
        for (int ch = 0; ch < channels; ++ch) {
            result.interleaved_samples[static_cast<std::size_t>(f * channels + ch)] =
                processed[static_cast<std::size_t>(ch)][static_cast<std::size_t>(src)];
        }
    }
    result.trimmed_frames = trim_start;
    result.ok = true;
    return result;
#else
    read_source_interleaved(source, result.start_frame, static_cast<int>(result.frame_count),
                            result.channel_count, result.interleaved_samples);
    result.error = "RubberBand unavailable; returned duration-preserving bypass";
    result.ok = true;
    return result;
#endif
}

} // namespace lt
