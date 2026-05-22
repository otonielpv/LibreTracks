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
                                      Frame duration_frames);

    void request_block(const Id& source_id, int block_index) const noexcept;
    void request_range(const Id& source_id, Frame source_frame, int frame_count) const noexcept;
    CacheDiagnostics cache_diagnostics() const;
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
    };

    using EntryMap = std::unordered_map<Id, Entry>;

    mutable std::mutex              write_mutex_;
    std::shared_ptr<const EntryMap> entries_;
    std::deque<std::shared_ptr<const EntryMap>> retired_entries_;
    SourceReadyCallback             source_ready_callback_;
    mutable BlockCache              block_cache_;
    mutable std::mutex              fill_mtx_;
    mutable std::condition_variable fill_cv_;
    mutable std::queue<CacheKey>    fill_queue_;
    mutable std::unordered_map<CacheKey, bool, CacheKeyHash> queued_blocks_;
    mutable bool                    fill_stop_ = false;
    mutable std::thread             fill_thread_;

    void publish_locked(EntryMap entries);
    void fill_worker_loop() const;
    void fill_block_from_disk(const CacheKey& key) const;
    std::string cache_file_for(const Id& source_id, const std::string& file_path, int sample_rate) const;
};

} // namespace lt
