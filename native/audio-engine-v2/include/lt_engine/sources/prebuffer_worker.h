#pragma once

// ---------------------------------------------------------------------------
// PrebufferWorker — background thread that fills the BlockCache ahead of the
// playhead.
//
// Design:
//   - Listens to starvation signals from StreamingSource (via push_request).
//   - Also called periodically with the current playhead frame so it can
//     prefetch blocks before they are needed.
//   - Uses the AudioDecoder + BlockCache directly — no dependency on
//     SourceManager's synchronous load path.
//   - One worker thread per engine instance (can be extended to a pool).
// ---------------------------------------------------------------------------

#include <lt_engine/core/types.h>
#include <lt_engine/sources/block_cache.h>
#include <atomic>
#include <condition_variable>
#include <functional>
#include <memory>
#include <mutex>
#include <queue>
#include <string>
#include <thread>
#include <unordered_map>

namespace lt {

struct PrebufferRequest {
    Id    source_id;
    int   block_index = 0;
    int   priority    = 0;  // lower = more urgent
};

// Maps source_id → file path, used by the worker to open decoders on demand.
using SourceFileMap = std::unordered_map<Id, std::string>;

class PrebufferWorker {
public:
    PrebufferWorker(BlockCache* cache, int engine_sample_rate);
    ~PrebufferWorker();

    // Register a source file so the worker can decode it.
    void register_source(const Id& source_id, const std::string& file_path);

    // Enqueue a fill request (called from audio thread starvation callback or
    // from the command thread to prefetch around the playhead).
    // Thread-safe.
    void push_request(const Id& source_id, int block_index, int priority = 0);

    // Advance playhead hint — worker prefetches kLookaheadBlocks blocks ahead.
    void set_playhead(const Id& source_id, Frame frame);

    // Stop the worker thread (called from shutdown).
    void shutdown();

    // Diagnostics.
    size_t queue_depth() const noexcept;

private:
    static constexpr int kLookaheadBlocks = 8;

    void worker_loop();
    void fill_block(const Id& source_id, int block_index);

    BlockCache*  cache_;
    int          engine_sample_rate_;

    mutable std::mutex    sources_mtx_;
    SourceFileMap         sources_;

    mutable std::mutex          queue_mtx_;
    std::condition_variable     queue_cv_;

    struct RequestCmp {
        bool operator()(const PrebufferRequest& a, const PrebufferRequest& b) const {
            return a.priority > b.priority;  // min-heap by priority
        }
    };
    std::priority_queue<PrebufferRequest,
                        std::vector<PrebufferRequest>,
                        RequestCmp>  queue_;

    std::atomic<bool> running_{false};
    std::thread       thread_;
};

} // namespace lt
