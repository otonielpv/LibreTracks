#pragma once

#include <lt_engine/core/types.h>
#include <lt_engine/core/result.h>
#include <lt_engine/sources/block_cache.h>
#include <lt_engine/sources/decoded_source.h>
#include <atomic>
#include <condition_variable>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <queue>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

namespace lt {

struct SourceDiagnostics {
    Id          source_id;
    std::string file_path;
    std::string status;          // "unloaded" | "loading" | "ready" | "failed"
    std::string error_message;
    int         channel_count   = 0;
    int         sample_rate     = 0;
    Frame       duration_frames = 0;
    size_t      memory_bytes    = 0;
    size_t      cache_bytes     = 0;
    size_t      disk_cache_bytes = 0;
    std::string storage_kind;
};

using SourceReadyCallback = std::function<void(const Id&)>;
using SourceStoreProgressCallback = std::function<void(int progress_pct)>;

// ---------------------------------------------------------------------------
// Cache maintenance free functions — operate on the env-resolved PCM cache
// directory (honours $LIBRETRACKS_CACHE_DIR) without needing a live engine.
// ---------------------------------------------------------------------------

// The env-resolved directory the engine writes .rf64 cache files into.
std::string source_cache_directory();

// Total bytes occupied by .rf64 PCM cache files currently on disk.
unsigned long long source_cache_dir_size_bytes();

// Delete all .rf64 PCM cache files; returns bytes freed. Best-effort.
unsigned long long purge_source_cache();

// Decode an audio file directly and build peak buckets. This is used by the
// host UI for waveform generation so it follows the same native decoder stack
// as playback (FFmpeg/libav for compressed formats, fast native paths for WAV).
SourcePeakOverview analyze_file_peaks(const std::string& file_path,
                                      int resolution_frames);

// ---------------------------------------------------------------------------
// SourceManager — owns all DecodedSources for a session.
//
// Thread model (Phases 6-9): all operations are called from the main/command
// thread before playback begins.  Phase 10 adds worker-thread loading.
// ---------------------------------------------------------------------------
class SourceManager {
public:
    SourceManager();
    ~SourceManager();

    void set_source_ready_callback(SourceReadyCallback callback);

    // Register a source file.  Does not decode yet.
    void register_source(const Id& source_id, const std::string& file_path);

    // Synchronously decode and resample the source to engine sample rate.
    // Called from command thread only.
    Result<void> load_source(const Id& source_id, int engine_sample_rate);

    // Install a source that was decoded on a worker thread.
    Result<void> store_decoded_source(const Id& source_id,
                                      std::vector<float> samples,
                                      int channel_count,
                                      int sample_rate,
                                      Frame duration_frames,
                                      SourceStoreProgressCallback on_progress = {});

    // Streaming decode+resample+cache-write in chunks, WITHOUT materializing the
    // whole file (or a full resample copy) in RAM. Opens the source via the
    // decoder, pipes it through a stateful resampler to the RF64 PCM cache a
    // chunk at a time, fills the eager block-cache blocks, then installs the
    // streaming DecodedSource (status "cache_ready"). This is the import path;
    // it keeps the per-track peak footprint to a few MB so the working set
    // stops swinging and the audio callback no longer stalls during cold import.
    // Returns err if the file can't be decoded; callers may fall back.
    Result<void> decode_and_store_streaming(const Id& source_id,
                                            const std::string& file_path,
                                            int target_sample_rate,
                                            SourceStoreProgressCallback on_progress = {});

    // If a previously-written PCM cache file exists for this source, install
    // it as a streaming entry (status = "cache_ready") without re-decoding
    // and return true. Returns false if no usable cache is found — callers
    // should fall back to the normal decode-via-worker-pool path. The cache
    // key already encodes the source file's mtime+size, so a positive hit
    // means the original is byte-identical to when it was decoded.
    bool try_install_from_cache_file(const Id& source_id,
                                      int engine_sample_rate);

    // If the original source file is already a libsndfile-readable container
    // (WAV / AIFF / FLAC …) whose sample rate matches the engine and whose
    // channel count is supported (1 or 2), install it as a streaming entry
    // that reads blocks directly from the original file — skipping decode AND
    // skipping the .rf64 PCM cache entirely. Saves both CPU and disk for the
    // very common case of native-format WAV stems. Returns false when the
    // file's format requires the decode pipeline (compressed audio, mismatched
    // sample rate, etc.); callers fall through to the worker-pool path.
    bool try_install_native_file(const Id& source_id,
                                  int engine_sample_rate);

    void request_block(const Id& source_id, int block_index) const noexcept;
    void request_range(const Id& source_id, Frame source_frame, int frame_count) const noexcept;
    CacheDiagnostics cache_diagnostics() const;

    // Diagnostics (LIBRETRACKS_AUDIO_DIAG): pending fill requests and the
    // block-cache lock-contention stats (resets the latter on read).
    size_t fill_queue_depth() const noexcept;
    BlockCache::LockStats take_block_cache_lock_stats() noexcept {
        return block_cache_.take_lock_stats();
    }
    SourcePeakOverview source_peaks(const Id& source_id, int resolution_frames) const;

    // Get a loaded source.  Returns nullptr if not loaded.
    // Safe to call from audio thread (read-only once loaded).
    const DecodedSource* get(const Id& source_id) const noexcept;

    // Get a loaded source while retaining ownership for long-running control
    // work. Use this from async/prearm builders that may outlive a session
    // reload; `get()` is only a borrowed pointer.
    std::shared_ptr<const DecodedSource> get_shared(const Id& source_id) const noexcept;

    // Diagnostics for snapshot.
    std::vector<SourceDiagnostics> diagnostics() const;

    // Total frames played as silence across all streaming sources because a
    // block wasn't cached in time (prebuffer starvation). Nonzero is the
    // measurable form of the "silent until it catches up" symptom on slow
    // machines. Summed over the live sources; safe to read off the audio thread.
    Frame total_cache_miss_frames() const noexcept;

    // Unload all sources (e.g. session close).
    void clear();

private:
    struct Entry {
        std::string              file_path;
        std::string              cache_file_path;
        std::shared_ptr<DecodedSource> source;
        std::string              status;
        std::string              error_message;
        int                      channel_count = 0;
        int                      sample_rate = 0;
        Frame                    duration_frames = 0;
        size_t                   disk_cache_bytes = 0;
        // Waveform peaks computed in the SAME pass as the streaming decode (no
        // second full decode for the UI's waveform — Ableton-style). When set,
        // source_peaks() returns these directly instead of re-reading the cache.
        std::shared_ptr<const SourcePeakOverview> cached_peaks;
        // R5 progressive availability: while a streaming decode is in flight the
        // source is published as playable (status "streaming") with the cache
        // file still open for writing. This counts how many output frames have
        // actually been written so far. The fill worker must NOT read past it
        // from disk (the WAV header/data size isn't finalized until sf_close), so
        // tail blocks beyond it stay absent and play silence — exactly Ableton's
        // "decoded part plays, rest silent". shared_ptr so Entry stays copyable;
        // flips to a final value and status "cache_ready" when the decode ends.
        std::shared_ptr<std::atomic<Frame>> decoded_frames;
    };

    using EntryMap = std::unordered_map<Id, Entry>;

    mutable std::mutex              write_mutex_;
    // std::atomic<shared_ptr> (C++20), NOT the free std::atomic_load/store
    // helpers: on MSVC those use a GLOBAL spinlock pool shared across all
    // shared_ptrs, which causes priority inversion — the audio thread (high
    // priority) calling get() per clip spins waiting on the spinlock held by a
    // BELOW_NORMAL decode worker that got descheduled mid-import, stalling
    // playback for 100s of ms. The member atomic uses per-object wait/notify.
    // See microsoft/STL#86.
    // GCC 11/libstdc++ and Apple libc++ in CI reject std::atomic<shared_ptr>,
    // so non-MSVC builds use the standard shared_ptr atomic free functions via
    // the helpers below.
#if !defined(_MSC_VER)
    std::shared_ptr<const EntryMap> entries_;
#else
    std::atomic<std::shared_ptr<const EntryMap>> entries_;
#endif
    std::deque<std::shared_ptr<const EntryMap>> retired_entries_;
    SourceReadyCallback             source_ready_callback_;
    mutable BlockCache              block_cache_;
    mutable std::mutex              fill_mtx_;
    mutable std::condition_variable fill_cv_;
    mutable std::queue<CacheKey>    fill_queue_;
    mutable std::unordered_map<CacheKey, bool, CacheKeyHash> queued_blocks_;
    mutable bool                    fill_stop_ = false;
    // Pool of block-fill workers. A single worker can't repopulate evicted
    // blocks from the WAV cache fast enough on a modest CPU with several tracks
    // playing — the playhead outruns it and the audio thread plays silence
    // (starvation). Decoding/refilling concurrently across tracks mirrors how
    // Ableton keeps the streamed audio fed. Count is min(cores-1, kMaxFill) and
    // overridable via LIBRETRACKS_FILL_THREADS for A/B.
    mutable std::vector<std::thread> fill_threads_;

    void publish_locked(EntryMap entries);
    std::shared_ptr<const EntryMap> load_entries() const noexcept;
    void store_entries(std::shared_ptr<const EntryMap> entries) noexcept;
    void fill_worker_loop() const;
    void fill_blocks_from_disk(const Id& source_id, const std::vector<int>& block_indices) const;
    std::string cache_file_for(const Id& source_id, const std::string& file_path, int sample_rate) const;
};

} // namespace lt
