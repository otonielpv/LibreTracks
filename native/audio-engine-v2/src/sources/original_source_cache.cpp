#include <lt_engine/sources/original_source_cache.h>

#include <algorithm>
#include <vector>

namespace lt {

OriginalSourceCache::OriginalSourceCache(int block_frames, std::size_t max_blocks)
    : cache_(block_frames, max_blocks) {}

bool OriginalSourceCache::request_block(const Id& source_id,
                                        const DecodedSource& source,
                                        int block_index) {
    if (cache_.has_block(source_id, block_index))
        return true;

    const int block_frames = cache_.block_frames();
    const Frame start = static_cast<Frame>(block_index) * block_frames;
    if (start >= source.duration_frames())
        return false;

    const int frames = static_cast<int>(
        std::min<Frame>(block_frames, source.duration_frames() - start));
    const int channels = std::max(1, source.channel_count());

    std::vector<float> planar_l(static_cast<std::size_t>(frames), 0.0f);
    std::vector<float> planar_r(static_cast<std::size_t>(frames), 0.0f);
    float* planar[2] = {planar_l.data(), planar_r.data()};
    const int read = source.read(start, frames, planar, std::min(2, channels));
    if (read <= 0)
        return false;

    std::vector<float> interleaved(static_cast<std::size_t>(read * channels), 0.0f);
    for (int f = 0; f < read; ++f) {
        for (int ch = 0; ch < channels; ++ch) {
            const float* plane = ch == 0 ? planar_l.data() : planar_r.data();
            interleaved[static_cast<std::size_t>(f * channels + ch)] = plane[f];
        }
    }

    cache_.fill(source_id, block_index, interleaved.data(), channels, read);
    return true;
}

bool OriginalSourceCache::get_block_if_ready(const Id& source_id,
                                             int block_index,
                                             int frame_offset_in_block,
                                             int frames_needed,
                                             float** out,
                                             int num_channels) noexcept {
    return cache_.read(source_id, block_index, frame_offset_in_block,
                       frames_needed, out, num_channels);
}

bool OriginalSourceCache::is_block_ready(const Id& source_id, int block_index) const {
    return cache_.has_block(source_id, block_index);
}

void OriginalSourceCache::prefetch_range(const Id& source_id,
                                         const DecodedSource& source,
                                         Frame start_frame,
                                         Frame frame_count) {
    if (frame_count <= 0)
        return;
    const int first = cache_.block_index_for(std::max<Frame>(0, start_frame));
    const int last = cache_.block_index_for(std::max<Frame>(0, start_frame + frame_count - 1));
    for (int block = first; block <= last; ++block)
        request_block(source_id, source, block);
}

OriginalSourceCacheDiagnostics OriginalSourceCache::diagnostics() const {
    auto base = cache_.diagnostics();
    OriginalSourceCacheDiagnostics d;
    d.original_blocks_ready = base.blocks_cached;
    d.original_blocks_missing = base.blocks_miss;
    d.source_cache_hit_count = base.blocks_hit;
    d.source_cache_miss_count = base.blocks_miss;
    return d;
}

} // namespace lt
