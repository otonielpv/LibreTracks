#include <lt_engine/sources/block_cache.h>
#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <thread>

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

BlockCache::BlockCache(int block_frames, size_t max_blocks,
                       size_t protected_recent_per_source)
    : block_frames_(block_frames)
    , max_blocks_(max_blocks)
    , protected_recent_per_source_(protected_recent_per_source)
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
        blk->last_used.store(clock_.fetch_add(1, std::memory_order_relaxed),
                             std::memory_order_relaxed);
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

    // Allocate and copy PCM before taking the mutex shared with the audio
    // thread. A default stereo block is ~32 KiB, so vector growth here must not
    // consume callback time.
    auto prepared = std::make_shared<CacheBlock>();
    prepared->key = key;
    prepared->channel_count = channel_count;
    prepared->block_frames = actual_frames;
    prepared->samples.assign(interleaved_samples,
                             interleaved_samples + actual_frames * channel_count);
    prepared->last_used.store(clock_.fetch_add(1, std::memory_order_relaxed),
                              std::memory_order_relaxed);
    prepared->ready.store(true, std::memory_order_release);

    const bool diag = diag_enabled();
    const uint64_t hold_start = diag ? now_us() : 0;
    std::shared_ptr<CacheBlock> replaced;
    {
        std::lock_guard<std::mutex> lk(mtx_);
        auto [it, inserted] = blocks_.try_emplace(key, prepared);
        if (inserted) {
            blocks_cached_.fetch_add(1, std::memory_order_relaxed);
            bytes_used_.fetch_add(prepared->samples.size() * sizeof(float),
                                  std::memory_order_relaxed);
        } else {
            replaced = std::move(it->second);
            it->second = prepared;
            const size_t old_bytes =
                replaced ? replaced->samples.size() * sizeof(float) : 0;
            const size_t new_bytes = prepared->samples.size() * sizeof(float);
            if (new_bytes >= old_bytes)
                bytes_used_.fetch_add(new_bytes - old_bytes, std::memory_order_relaxed);
            else
                bytes_used_.fetch_sub(old_bytes - new_bytes, std::memory_order_relaxed);
        }
    }
    if (diag)
        atomic_max(fill_hold_max_us_, now_us() - hold_start);

    // Release replaced PCM outside mtx_, then let at most one fill worker
    // prepare an eviction pass.
    replaced.reset();
    evict_if_needed();
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

CacheDiagnostics BlockCache::diagnostics() const noexcept {
    CacheDiagnostics d;
    // Snapshot polling runs several times per second. Publication and eviction
    // maintain counters so diagnostics never scans the whole cache under the
    // mutex shared with the audio callback.
    d.blocks_cached = blocks_cached_.load(std::memory_order_relaxed);
    d.bytes_used = bytes_used_.load(std::memory_order_relaxed);
    d.bytes_capacity = max_blocks_
                     * static_cast<size_t>(block_frames_)
                     * sizeof(float) * 2;  // assume stereo estimate
    d.blocks_hit  = hits_.load(std::memory_order_relaxed);
    d.blocks_miss = misses_.load(std::memory_order_relaxed);
    return d;
}

void BlockCache::evict_if_needed() {
    if (blocks_cached_.load(std::memory_order_relaxed) <= max_blocks_)
        return;

    // A fill worker must never queue behind another worker's global prune.
    // One prepares the plan; contenders keep publishing and a later fill
    // retries if this pass cannot reach the target.
    std::unique_lock<std::mutex> eviction_lk(eviction_mtx_, std::try_to_lock);
    if (!eviction_lk.owns_lock())
        return;

    const size_t target_blocks = max_blocks_ * 3 / 4;

    // Snapshot shared_ptrs under the realtime mutex. Keys and PCM remain in
    // CacheBlock, so this copies neither strings nor audio. All O(n) selection
    // work below happens after releasing mtx_.
    std::vector<std::shared_ptr<CacheBlock>> snapshot;
    snapshot.reserve(blocks_cached_.load(std::memory_order_relaxed) + 64);
    const bool diag = diag_enabled();
    const uint64_t snapshot_start = diag ? now_us() : 0;
    {
        std::lock_guard<std::mutex> lk(mtx_);
        if (blocks_.size() <= max_blocks_)
            return;
        for (const auto& [key, block] : blocks_) {
            if (block)
                snapshot.push_back(block);
        }
    }
    if (diag)
        atomic_max(fill_hold_max_us_, now_us() - snapshot_start);
    if (snapshot.size() <= target_blocks)
        return;

    const size_t to_remove = snapshot.size() - target_blocks;

    // Group ages outside the realtime mutex. The K freshest blocks per source
    // remain protected, preserving the 1.8.1 cross-source starvation fix.
    std::unordered_map<Id, std::vector<uint64_t>> ages_by_source;
    ages_by_source.reserve(snapshot.size());
    for (const auto& block : snapshot)
        ages_by_source[block->key.source_id].push_back(
            block->last_used.load(std::memory_order_relaxed));

    // Per source, the inclusive lower bound of last_used that stays protected.
    // A source with <= K blocks protects all of them (threshold 0).
    const size_t k = protected_recent_per_source_;
    std::unordered_map<Id, uint64_t> protect_threshold;
    protect_threshold.reserve(ages_by_source.size());
    for (auto& [sid, ages] : ages_by_source) {
        if (k == 0 || ages.size() <= k) {
            protect_threshold[sid] = 0ULL;  // protects nothing / everything
            continue;
        }
        // The K largest last_used values are protected. Partition so the
        // element at position (n-k) is the K-th largest; it is the threshold.
        const std::ptrdiff_t nth = static_cast<std::ptrdiff_t>(ages.size() - k);
        std::nth_element(ages.begin(), ages.begin() + nth, ages.end());
        protect_threshold[sid] = ages[static_cast<size_t>(nth)];
    }

    struct Candidate {
        uint64_t age;
        std::shared_ptr<CacheBlock> block;
    };
    std::vector<Candidate> aged;
    aged.reserve(snapshot.size());
    for (const auto& block : snapshot) {
        const uint64_t age = block->last_used.load(std::memory_order_relaxed);
        if (k != 0 && age >= protect_threshold[block->key.source_id])
            continue;
        aged.push_back(Candidate{age, block});
    }

    const size_t removable = std::min(to_remove, aged.size());
    if (removable == 0)
        return;

    if (removable < aged.size()) {
        std::nth_element(
            aged.begin(), aged.begin() + static_cast<std::ptrdiff_t>(removable),
            aged.end(),
            [](const Candidate& a, const Candidate& b) { return a.age < b.age; });
    }

    // Erase in bounded batches. Moving shared_ptrs out means the potentially
    // 256MB wave of PCM destruction occurs only after releasing mtx_.
    constexpr size_t kEraseBatch = 64;
    size_t removed = 0;
    for (size_t cursor = 0; cursor < removable; cursor += kEraseBatch) {
        std::vector<std::shared_ptr<CacheBlock>> retired;
        retired.reserve(std::min(kEraseBatch, removable - cursor));
        const uint64_t batch_start = diag ? now_us() : 0;
        {
            std::lock_guard<std::mutex> lk(mtx_);
            const size_t end = std::min(removable, cursor + kEraseBatch);
            for (size_t i = cursor; i < end; ++i) {
                const auto& candidate = aged[i];
                auto it = blocks_.find(candidate.block->key);
                if (it == blocks_.end() || it->second.get() != candidate.block.get())
                    continue;
                // A read after the snapshot made this block hot.
                if (candidate.block->last_used.load(std::memory_order_relaxed)
                    != candidate.age)
                    continue;
                const size_t block_bytes =
                    candidate.block->samples.size() * sizeof(float);
                retired.push_back(std::move(it->second));
                blocks_.erase(it);
                blocks_cached_.fetch_sub(1, std::memory_order_relaxed);
                bytes_used_.fetch_sub(block_bytes, std::memory_order_relaxed);
                ++removed;
            }
        }
        if (diag)
            atomic_max(fill_hold_max_us_, now_us() - batch_start);
        retired.clear();
        // Give a waiting realtime callback an explicit scheduling point before
        // the worker attempts the next short batch.
        std::this_thread::yield();
    }

    if (removed > 0)
        evict_count_.fetch_add(1, std::memory_order_relaxed);
}

void BlockCache::clear() {
    // Swap in O(1), then destroy all PCM after releasing the realtime mutex.
    decltype(blocks_) retired;
    {
        std::lock_guard<std::mutex> lk(mtx_);
        retired.swap(blocks_);
        blocks_cached_.store(0, std::memory_order_relaxed);
        bytes_used_.store(0, std::memory_order_relaxed);
    }
}

} // namespace lt
