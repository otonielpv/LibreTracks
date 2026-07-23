#pragma once

// ---------------------------------------------------------------------------
// BlockCache — bounded LRU cache of fixed-size decoded audio blocks.
//
// Design:
//   - Block size: kBlockFrames frames (configurable at construction).
//   - Max blocks: configurable (default ~512 MB / block_size / channels / 4).
//   - Key: (source_id, block_index).
//   - Workers fill blocks off the audio thread.
//   - Audio thread reads; on miss it returns silence and marks the block
//     needed (starvation diagnostic).
//   - Eviction: LRU when at capacity.
//
// Thread model:
//   - read():  audio thread — short mutex lookup, then lock-free PCM copy.
//   - fill():  worker thread — writes a block into the cache.
//   - evict(): worker thread — called periodically to prune old blocks.
// ---------------------------------------------------------------------------

#include <lt_engine/core/types.h>
#include <array>
#include <atomic>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

namespace lt {

static constexpr int kDefaultBlockFrames = 4096;

struct CacheKey {
    Id  source_id;
    int block_index = 0;

    bool operator==(const CacheKey& o) const noexcept {
        return source_id == o.source_id && block_index == o.block_index;
    }
};

struct CacheKeyHash {
    std::size_t operator()(const CacheKey& k) const noexcept {
        std::size_t h = std::hash<std::string>{}(k.source_id);
        h ^= std::hash<int>{}(k.block_index) + 0x9e3779b9u + (h << 6) + (h >> 2);
        return h;
    }
};

struct CacheBlock {
    CacheKey            key;
    std::vector<float> samples;   // interleaved, block_frames * channels
    int                channel_count = 0;
    int                block_frames  = 0;
    std::atomic<bool>  ready{false};
    std::atomic<uint64_t> last_used{0};  // monotonic counter
};

struct CacheDiagnostics {
    size_t blocks_cached  = 0;
    size_t blocks_hit     = 0;
    size_t blocks_miss    = 0;
    size_t bytes_used     = 0;
    size_t bytes_capacity = 0;
};

class BlockCache {
public:
    // `protected_recent_per_source` is the number of most-recently-used blocks
    // PER source_id that eviction will never prune. It guards each active
    // track's read-ahead window from being evicted just because another track
    // was served more recently — the global-LRU failure that starved playback
    // when several songs/tracks shared the cache. ~48 blocks ≈ 4 s at 48 kHz.
    explicit BlockCache(int block_frames   = kDefaultBlockFrames,
                        size_t max_blocks  = 2048,
                        size_t protected_recent_per_source = 48);
    ~BlockCache() = default;

    // Audio thread — returns true and fills out on cache hit.
    // Returns false (miss) without blocking on miss.
    bool read(const Id&  source_id,
              int        block_index,
              int        frame_offset_in_block,
              int        frames_needed,
              float**    out,
              int        num_channels) noexcept;

    // Worker thread — write a fully decoded block into the cache.
    void fill(const Id&          source_id,
              int                block_index,
              const float*       interleaved_samples,
              int                channel_count,
              int                actual_frames);

    // Check whether a block is cached (worker thread decision).
    bool has_block(const Id& source_id, int block_index) const;
    void append_missing_blocks(const Id& source_id,
                               int first_block,
                               int last_block,
                               std::vector<int>& out) const;
    void append_missing_blocks(const Id& source_id,
                               const std::vector<int>& block_indices,
                               std::vector<int>& out) const;

    int    block_frames()  const noexcept { return block_frames_; }
    int    block_index_for(Frame frame) const noexcept {
        return static_cast<int>(frame / block_frames_);
    }
    int    offset_in_block(Frame frame) const noexcept {
        return static_cast<int>(frame % block_frames_);
    }

    CacheDiagnostics diagnostics() const noexcept;

    // Drop ALL cached blocks. Used when decoded sources are invalidated
    // wholesale — e.g. a device sample-rate change re-decodes every source at
    // the new rate, so blocks cached at the OLD rate (keyed only by
    // source_id+block_index, NOT by sample rate) must be purged or the audio
    // thread keeps serving stale samples → sudden speed-up / slow-down on
    // already-buffered regions. Takes mtx_, so it is safe against the audio
    // thread's read(); call it from the control thread.
    void             clear();

    // --- Lock-contention diagnostics (LIBRETRACKS_AUDIO_DIAG) ---------------
    // Worst-case microseconds the audio thread (read) spent BLOCKED acquiring
    // mtx_, and the worst-case time a worker (fill/evict) HELD it. If the read
    // wait is high, the single cache mutex is the dropout cause. Reset on read.
    struct LockStats {
        uint64_t read_wait_max_us = 0;
        uint64_t fill_hold_max_us = 0;
        uint64_t read_wait_count  = 0;  // reads that waited > ~50us
        uint64_t evict_count      = 0;  // LRU evictions since last read
    };
    LockStats take_lock_stats() noexcept;

private:
    void evict_if_needed();

    int    block_frames_;
    size_t max_blocks_;
    size_t protected_recent_per_source_;

    mutable std::mutex                                     mtx_;
    // Only one fill worker prepares an eviction plan at a time. Contenders use
    // try_lock and keep publishing blocks instead of queueing behind a global
    // prune. The audio thread never touches this mutex.
    std::mutex                                             eviction_mtx_;
    std::unordered_map<CacheKey, std::shared_ptr<CacheBlock>, CacheKeyHash> blocks_;
    std::atomic<uint64_t> clock_{0};

    mutable std::atomic<size_t> hits_{0};
    mutable std::atomic<size_t> misses_{0};
    std::atomic<size_t> blocks_cached_{0};
    std::atomic<size_t> bytes_used_{0};

    mutable std::atomic<uint64_t> read_wait_max_us_{0};
    mutable std::atomic<uint64_t> fill_hold_max_us_{0};
    mutable std::atomic<uint64_t> read_wait_count_{0};
    std::atomic<uint64_t> evict_count_{0};
    static bool diag_enabled() noexcept;
};

} // namespace lt
