#pragma once

#include <lt_engine/core/types.h>
#include <lt_engine/sources/block_cache.h>
#include <lt_engine/sources/decoded_source.h>

#include <cstddef>

namespace lt {

struct OriginalSourceCacheDiagnostics {
    std::size_t original_blocks_ready = 0;
    std::size_t original_blocks_missing = 0;
    std::size_t source_cache_hit_count = 0;
    std::size_t source_cache_miss_count = 0;
};

class OriginalSourceCache {
public:
    explicit OriginalSourceCache(int block_frames = kDefaultBlockFrames,
                                 std::size_t max_blocks = 2048);

    bool request_block(const Id& source_id,
                       const DecodedSource& source,
                       int block_index);

    bool get_block_if_ready(const Id& source_id,
                            int block_index,
                            int frame_offset_in_block,
                            int frames_needed,
                            float** out,
                            int num_channels) noexcept;

    bool is_block_ready(const Id& source_id, int block_index) const;

    void prefetch_range(const Id& source_id,
                        const DecodedSource& source,
                        Frame start_frame,
                        Frame frame_count);

    int block_frames() const noexcept { return cache_.block_frames(); }
    int block_index_for(Frame frame) const noexcept { return cache_.block_index_for(frame); }
    int offset_in_block(Frame frame) const noexcept { return cache_.offset_in_block(frame); }

    OriginalSourceCacheDiagnostics diagnostics() const;

private:
    BlockCache cache_;
};

} // namespace lt
