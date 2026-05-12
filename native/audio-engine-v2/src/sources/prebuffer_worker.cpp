#include <lt_engine/sources/prebuffer_worker.h>
#include <lt_engine/sources/audio_decoder.h>
#include <algorithm>
#include <cstring>
#include <vector>

namespace lt {

PrebufferWorker::PrebufferWorker(BlockCache* cache, int engine_sample_rate)
    : cache_(cache)
    , engine_sample_rate_(engine_sample_rate)
{
    running_.store(true, std::memory_order_release);
    thread_ = std::thread(&PrebufferWorker::worker_loop, this);
}

PrebufferWorker::~PrebufferWorker() {
    shutdown();
}

void PrebufferWorker::register_source(const Id& source_id,
                                       const std::string& file_path) {
    std::lock_guard<std::mutex> lk(sources_mtx_);
    sources_[source_id] = file_path;
}

void PrebufferWorker::push_request(const Id& source_id,
                                    int block_index,
                                    int priority) {
    {
        std::lock_guard<std::mutex> lk(queue_mtx_);
        // Skip if already cached.
        if (cache_->has_block(source_id, block_index)) return;
        queue_.push({ source_id, block_index, priority });
    }
    queue_cv_.notify_one();
}

void PrebufferWorker::set_playhead(const Id& source_id, Frame frame) {
    int base_block = cache_->block_index_for(frame);
    {
        std::lock_guard<std::mutex> lk(queue_mtx_);
        for (int i = 0; i < kLookaheadBlocks; ++i) {
            int blk = base_block + i;
            if (!cache_->has_block(source_id, blk))
                queue_.push({ source_id, blk, i });  // priority = lookahead distance
        }
    }
    queue_cv_.notify_one();
}

void PrebufferWorker::shutdown() {
    {
        std::lock_guard<std::mutex> lk(queue_mtx_);
        running_.store(false, std::memory_order_release);
    }
    queue_cv_.notify_all();
    if (thread_.joinable())
        thread_.join();
}

size_t PrebufferWorker::queue_depth() const noexcept {
    std::lock_guard<std::mutex> lk(queue_mtx_);
    return queue_.size();
}

// ---------------------------------------------------------------------------
// Worker loop
// ---------------------------------------------------------------------------
void PrebufferWorker::worker_loop() {
    while (running_.load(std::memory_order_acquire)) {
        PrebufferRequest req;
        {
            std::unique_lock<std::mutex> lk(queue_mtx_);
            queue_cv_.wait(lk, [this]{
                return !queue_.empty() || !running_.load(std::memory_order_acquire);
            });
            if (!running_.load(std::memory_order_acquire) && queue_.empty())
                break;
            if (queue_.empty()) continue;
            req = queue_.top();
            queue_.pop();
        }

        // Re-check after dequeue — another thread may have filled it.
        if (cache_->has_block(req.source_id, req.block_index)) continue;

        fill_block(req.source_id, req.block_index);
    }
}

void PrebufferWorker::fill_block(const Id& source_id, int block_index) {
    std::string file_path;
    {
        std::lock_guard<std::mutex> lk(sources_mtx_);
        auto it = sources_.find(source_id);
        if (it == sources_.end()) return;
        file_path = it->second;
    }

    auto decoder = make_decoder(file_path);
    if (!decoder) return;

    auto open_result = decoder->open(file_path);
    if (open_result.is_err()) return;

    auto info        = decoder->info();
    const int block_frames = cache_->block_frames();
    Frame start_frame      = static_cast<Frame>(block_index) * block_frames;

    // Seek to block start.
    if (decoder->seek(start_frame).is_err()) return;

    const int channels = info.channel_count;
    std::vector<float> interleaved(block_frames * channels, 0.f);

    int frames_read = decoder->read_frames(interleaved.data(), block_frames);
    if (frames_read <= 0) return;

    cache_->fill(source_id, block_index,
                 interleaved.data(), channels, frames_read);
}

} // namespace lt
