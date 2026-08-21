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
#include <unordered_set>
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
    // Never evicted while set. Used for the preload set — the handful of blocks
    // that must be resident so playback can start without touching the disk.
    std::atomic<bool>  pinned{false};
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

    // Hand memory back under pressure, keeping each source's `keep_per_source`
    // freshest blocks — the read-ahead window the audio thread is about to
    // need. Unlike clear(), playback in progress survives this (it may glitch;
    // it will not stop). Returns bytes freed.
    //
    // For Android's onTrimMemory: the alternative to giving memory back when
    // the system asks is being killed. Safe to call from any non-audio thread.
    size_t           release_unprotected(size_t keep_per_source);

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

    // ── Preload set ──────────────────────────────────────────────────────
    //
    // Blocks that stay resident regardless of how long ago they were used, so a
    // cold start does not have to reach the disk for them.
    //
    // Measured on a 39-track session: a block read with the OS cache bypassed
    // costs 4.4 ms (median, p95 5.3), against 0.196 ms once it is resident —
    // 22x. Multiplied by every track needing its first block at once, that is
    // the few hundred milliseconds of silence the engine logs after loading a
    // session.
    //
    // Deliberately NOT used for jump targets. Pinning the neighbourhood of all
    // 58 markers in that session would cost 72-216 MB, and it would buy little:
    // the urgent fill lane already serves a cold jump's blocks before any
    // read-ahead. Clip heads alone cost 1.2 MB and cover the case that is
    // actually still broken. If a symptom ever justifies more, pin a rolling
    // window of the next few markers (~6 MB) rather than all of them.
    //
    // `pin` records the intent; the block becomes resident when a fill worker
    // delivers it. Control thread only.
    void pin(const Id& source_id, int block_index);
    // Forget every pinned block (song change / session unload). Already-loaded
    // blocks stay cached but become evictable again.
    void unpin_all();
    size_t pinned_count() const noexcept;

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
    // Keys that must stay resident. Kept separately from the blocks themselves
    // so a block can be pinned before it has been loaded.
    std::unordered_set<CacheKey, CacheKeyHash>                              pinned_keys_;
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
