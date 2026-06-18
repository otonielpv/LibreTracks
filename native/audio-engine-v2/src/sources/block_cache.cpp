#include <lt_engine/sources/block_cache.h>
#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <cstring>

namespace lt {

namespace {
inline uint64_t now_us() {
    return static_cast<uint64_t>(
        std::chrono::duration_cast<std::chrono::microseconds>(
            std::chrono::steady_clock::now().time_since_epoch())
            .count());
}
inline void atomic_max(std::atomic<uint64_t>& slot, uint64_t value) {
    uint64_t prev = slot.load(std::memory_order_relaxed);
    while (value > prev &&
           !slot.compare_exchange_weak(prev, value, std::memory_order_relaxed)) {
    }
}
} // namespace

bool BlockCache::diag_enabled() noexcept {
    static const bool on = [] {
        const char* v = std::getenv("LIBRETRACKS_AUDIO_DIAG");
        return v && *v && !(v[0] == '0' && v[1] == '\0');
    }();
    return on;
}

BlockCache::BlockCache(int block_frames, size_t max_blocks)
    : block_frames_(block_frames)
    , max_blocks_(max_blocks)
{}

BlockCache::LockStats BlockCache::take_lock_stats() noexcept {
    LockStats s;
    s.read_wait_max_us = read_wait_max_us_.exchange(0, std::memory_order_relaxed);
    s.fill_hold_max_us = fill_hold_max_us_.exchange(0, std::memory_order_relaxed);
    s.read_wait_count  = read_wait_count_.exchange(0, std::memory_order_relaxed);
    s.evict_count      = evict_count_.exchange(0, std::memory_order_relaxed);
    return s;
}

bool BlockCache::read(const Id&  source_id,
                      int        block_index,
                      int        frame_offset_in_block,
                      int        frames_needed,
                      float**    out,
                      int        num_channels) noexcept {
    CacheKey key{ source_id, block_index };

    std::shared_ptr<CacheBlock> blk;
    {
        const bool diag = diag_enabled();
        const uint64_t wait_start = diag ? now_us() : 0;
        std::lock_guard<std::mutex> lk(mtx_);
        if (diag) {
            const uint64_t waited = now_us() - wait_start;
            atomic_max(read_wait_max_us_, waited);
            if (waited > 50)
                read_wait_count_.fetch_add(1, std::memory_order_relaxed);
        }
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

    if (num_channels == 2 && src_channels == 2) {
        float* out_l = out[0];
        float* out_r = out[1];
        for (int f = 0; f < copy_frames; ++f) {
            out_l[f] = src[f * 2];
            out_r[f] = src[f * 2 + 1];
        }
    } else if (num_channels == 2 && src_channels == 1) {
        float* out_l = out[0];
        float* out_r = out[1];
        for (int f = 0; f < copy_frames; ++f) {
            const float sample = src[f];
            out_l[f] = sample;
            out_r[f] = sample;
        }
    } else if (num_channels == 1 && src_channels >= 1) {
        float* out_l = out[0];
        for (int f = 0; f < copy_frames; ++f)
            out_l[f] = src[f * src_channels];
    } else {
        for (int f = 0; f < copy_frames; ++f) {
            for (int ch = 0; ch < num_channels; ++ch) {
                int src_ch = (src_channels > 0) ? std::min(ch, src_channels - 1) : 0;
                out[ch][f] = src[f * src_channels + src_ch];
            }
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

    const bool diag = diag_enabled();
    const uint64_t hold_start = diag ? now_us() : 0;
    {
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
    if (diag)
        atomic_max(fill_hold_max_us_, now_us() - hold_start);
}

bool BlockCache::has_block(const Id& source_id, int block_index) const {
    CacheKey key{ source_id, block_index };
    std::lock_guard<std::mutex> lk(mtx_);
    auto it = blocks_.find(key);
    if (it == blocks_.end()) return false;
    return it->second->ready.load(std::memory_order_acquire);
}

void BlockCache::append_missing_blocks(const Id& source_id,
                                       int first_block,
                                       int last_block,
                                       std::vector<int>& out) const {
    if (last_block < first_block)
        return;
    std::lock_guard<std::mutex> lk(mtx_);
    for (int block = std::max(0, first_block); block <= last_block; ++block) {
        CacheKey key{ source_id, block };
        auto it = blocks_.find(key);
        if (it == blocks_.end() ||
            !it->second->ready.load(std::memory_order_acquire)) {
            out.push_back(block);
        }
    }
}

void BlockCache::append_missing_blocks(const Id& source_id,
                                       const std::vector<int>& block_indices,
                                       std::vector<int>& out) const {
    std::lock_guard<std::mutex> lk(mtx_);
    for (int block : block_indices) {
        if (block < 0)
            continue;
        CacheKey key{ source_id, block };
        auto it = blocks_.find(key);
        if (it == blocks_.end() ||
            !it->second->ready.load(std::memory_order_acquire)) {
            out.push_back(block);
        }
    }
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
    // Caller holds mtx_. This runs on a worker thread (fill) but shares mtx_
    // with the audio thread's read(), so it must be cheap: a full std::sort of
    // the whole cache (~16k blocks at the 512MB default) held the lock for tens
    // of ms and stalled playback (see LT_AUDIO_DIAG fill_hold_us spikes).
    //
    // We only need the `to_remove` oldest entries, not a total order, so
    // nth_element partitions in O(n) instead of O(n log n) — and we no longer
    // sort the kept majority at all.
    if (blocks_.size() <= target_blocks) return;

    const size_t to_remove = blocks_.size() - target_blocks;

    std::vector<std::pair<uint64_t, CacheKey>> aged;
    aged.reserve(blocks_.size());
    for (const auto& [k, b] : blocks_)
        aged.emplace_back(b ? b->last_used : 0ULL, k);

    // Partition so the `to_remove` smallest last_used values sit at the front.
    std::nth_element(
        aged.begin(), aged.begin() + static_cast<std::ptrdiff_t>(to_remove),
        aged.end(),
        [](const auto& a, const auto& b) { return a.first < b.first; });

    for (size_t i = 0; i < to_remove; ++i)
        blocks_.erase(aged[i].second);

    evict_count_.fetch_add(1, std::memory_order_relaxed);
}

void BlockCache::clear() {
    std::lock_guard<std::mutex> lk(mtx_);
    blocks_.clear();
}

} // namespace lt
