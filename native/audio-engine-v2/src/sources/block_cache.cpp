#include <lt_engine/sources/block_cache.h>
#include <algorithm>
#include <cstring>

namespace lt {

BlockCache::BlockCache(int block_frames, size_t max_blocks)
    : block_frames_(block_frames)
    , max_blocks_(max_blocks)
{}

bool BlockCache::read(const Id&  source_id,
                      int        block_index,
                      int        frame_offset_in_block,
                      int        frames_needed,
                      float**    out,
                      int        num_channels) noexcept {
    CacheKey key{ source_id, block_index };

    std::shared_ptr<CacheBlock> blk;
    {
        std::lock_guard<std::mutex> lk(mtx_);
        auto it = blocks_.find(key);
        if (it == blocks_.end() || !it->second->ready.load(std::memory_order_acquire)) {
            misses_.fetch_add(1, std::memory_order_relaxed);
            return false;
        }
        blk = it->second;
        blk->last_used = clock_.fetch_add(1, std::memory_order_relaxed);
        hits_.fetch_add(1, std::memory_order_relaxed);
    }

    // Copy interleaved samples → planar output.
    const int src_channels = blk->channel_count;
    const int avail_frames = blk->block_frames - frame_offset_in_block;
    const int copy_frames  = std::min(frames_needed, std::max(avail_frames, 0));
    if (copy_frames <= 0) return false;

    const float* src = blk->samples.data() + frame_offset_in_block * src_channels;

    for (int f = 0; f < copy_frames; ++f) {
        for (int ch = 0; ch < num_channels; ++ch) {
            int src_ch = (src_channels > 0) ? std::min(ch, src_channels - 1) : 0;
            out[ch][f] = src[f * src_channels + src_ch];
        }
    }

    // Zero-pad if fewer frames were available.
    if (copy_frames < frames_needed) {
        for (int ch = 0; ch < num_channels; ++ch)
            std::fill(out[ch] + copy_frames, out[ch] + frames_needed, 0.f);
    }

    return true;
}

void BlockCache::fill(const Id&    source_id,
                      int          block_index,
                      const float* interleaved_samples,
                      int          channel_count,
                      int          actual_frames) {
    CacheKey key{ source_id, block_index };

    std::lock_guard<std::mutex> lk(mtx_);

    // Evict if at capacity.
    if (blocks_.size() >= max_blocks_)
        evict_lru(max_blocks_ * 3 / 4);  // trim to 75%

    auto& blk       = blocks_[key];
    if (!blk) blk   = std::make_shared<CacheBlock>();

    blk->channel_count = channel_count;
    blk->block_frames  = actual_frames;
    blk->samples.assign(interleaved_samples,
                        interleaved_samples + actual_frames * channel_count);
    blk->last_used = clock_.fetch_add(1, std::memory_order_relaxed);
    blk->ready.store(true, std::memory_order_release);
}

bool BlockCache::has_block(const Id& source_id, int block_index) const {
    CacheKey key{ source_id, block_index };
    std::lock_guard<std::mutex> lk(mtx_);
    auto it = blocks_.find(key);
    if (it == blocks_.end()) return false;
    return it->second->ready.load(std::memory_order_acquire);
}

CacheDiagnostics BlockCache::diagnostics() const {
    CacheDiagnostics d;
    {
        std::lock_guard<std::mutex> lk(mtx_);
        d.blocks_cached = blocks_.size();
        for (const auto& [k, b] : blocks_)
            if (b) d.bytes_used += b->samples.size() * sizeof(float);
        d.bytes_capacity = max_blocks_
                         * static_cast<size_t>(block_frames_)
                         * sizeof(float) * 2;  // assume stereo estimate
    }
    d.blocks_hit  = hits_.load(std::memory_order_relaxed);
    d.blocks_miss = misses_.load(std::memory_order_relaxed);
    return d;
}

void BlockCache::evict_lru(size_t target_blocks) {
    // Caller holds mtx_.
    if (blocks_.size() <= target_blocks) return;

    // Collect (last_used, key) pairs, sort ascending, erase oldest.
    std::vector<std::pair<uint64_t, CacheKey>> aged;
    aged.reserve(blocks_.size());
    for (const auto& [k, b] : blocks_)
        aged.emplace_back(b ? b->last_used : 0ULL, k);

    std::sort(aged.begin(), aged.end(),
              [](const auto& a, const auto& b){ return a.first < b.first; });

    size_t to_remove = blocks_.size() - target_blocks;
    for (size_t i = 0; i < to_remove && i < aged.size(); ++i)
        blocks_.erase(aged[i].second);
}

} // namespace lt
