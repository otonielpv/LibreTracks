#include <lt_engine/sources/worker_pool.h>
#include <lt_engine/sources/audio_decoder.h>

#include <atomic>
#include <condition_variable>
#include <cstdlib>
#include <deque>
#include <mutex>
#include <thread>
#include <unordered_map>
#include <vector>

namespace lt {

// ---------------------------------------------------------------------------
struct DecodeTask {
    Id                    job_id;
    Id                    source_id;
    std::string           file_path;
    int                   target_sample_rate;
    JobCompletionCallback on_done;
    std::atomic<bool>     cancelled{false};
};

struct DecodeWorkerPool::Impl {
    std::vector<std::thread>             threads;
    std::deque<std::shared_ptr<DecodeTask>> queue;
    mutable std::mutex                   mtx;
    std::condition_variable              cv;
    bool                                 stopping = false;

    mutable std::mutex                   jobs_mtx;
    std::unordered_map<Id, Job>          jobs;

    void worker_loop() {
        while (true) {
            std::shared_ptr<DecodeTask> task;
            {
                std::unique_lock lock(mtx);
                cv.wait(lock, [this]{ return stopping || !queue.empty(); });
                if (stopping && queue.empty()) return;
                task = std::move(queue.front());
                queue.pop_front();
            }

            // Update status to Running.
            {
                std::lock_guard lock(jobs_mtx);
                auto it = jobs.find(task->job_id);
                if (it != jobs.end()) it->second.status = JobStatus::Running;
            }

            if (task->cancelled.load(std::memory_order_relaxed)) {
                finish_job(task->job_id, JobStatus::Cancelled, "", task->on_done, task);
                continue;
            }

            // Decode.
            int   channel_count   = 0;
            Frame duration_frames = 0;
            auto  result = decode_file_to_float32(
                task->file_path, task->target_sample_rate,
                &channel_count, &duration_frames);

            if (task->cancelled.load(std::memory_order_relaxed)) {
                finish_job(task->job_id, JobStatus::Cancelled, "", task->on_done, task);
                continue;
            }

            if (result.is_err()) {
                finish_job(task->job_id, JobStatus::Failed, result.error(), task->on_done, task);
            } else {
                // Store decoded samples back through the job completion callback.
                // The callback (in SourcePreparationQueue) writes to SourceManager.
                {
                    std::lock_guard lock(jobs_mtx);
                    auto it = jobs.find(task->job_id);
                    if (it != jobs.end()) {
                        it->second.status       = JobStatus::Completed;
                        it->second.progress_pct = 100;
                    }
                }
                if (task->on_done) {
                    Job j;
                    j.job_id          = task->job_id;
                    j.source_id       = task->source_id;
                    j.status          = JobStatus::Completed;
                    j.progress_pct    = 100;
                    j.decoded_samples = result.take();
                    j.channel_count   = channel_count;
                    j.sample_rate     = task->target_sample_rate;
                    j.duration_frames = duration_frames;
                    task->on_done(j);
                }
            }
        }
    }

    void finish_job(const Id& job_id, JobStatus status, const std::string& err,
                    const JobCompletionCallback& on_done,
                    const std::shared_ptr<DecodeTask>& task) {
        {
            std::lock_guard lock(jobs_mtx);
            auto it = jobs.find(job_id);
            if (it != jobs.end()) {
                it->second.status        = status;
                it->second.error_message = err;
            }
        }
        if (on_done) {
            Job j;
            j.job_id        = job_id;
            j.source_id     = task->source_id;
            j.status        = status;
            j.error_message = err;
            on_done(j);
        }
    }
};

// ---------------------------------------------------------------------------
DecodeWorkerPool::DecodeWorkerPool(int num_threads)
    : impl_(std::make_unique<Impl>())
{
    if (num_threads <= 0) {
        if (const char* raw = std::getenv("LIBRETRACKS_DECODE_WORKERS")) {
            const int parsed = std::atoi(raw);
            if (parsed > 0 && parsed <= 16)
                num_threads = parsed;
        }
        if (num_threads <= 0)
            num_threads = 2;
    }
    for (int i = 0; i < num_threads; ++i) {
        impl_->threads.emplace_back([this]{ impl_->worker_loop(); });
    }
}

DecodeWorkerPool::~DecodeWorkerPool() {
    shutdown();
}

void DecodeWorkerPool::submit_decode(const Id& job_id,
                                      const Id& source_id,
                                      const std::string& file_path,
                                      int target_sample_rate,
                                      JobCompletionCallback on_done) {
    auto task = std::make_shared<DecodeTask>();
    task->job_id             = job_id;
    task->source_id          = source_id;
    task->file_path          = file_path;
    task->target_sample_rate = target_sample_rate;
    task->on_done            = std::move(on_done);

    {
        std::lock_guard lock(impl_->jobs_mtx);
        Job j;
        j.job_id      = job_id;
        j.source_id   = source_id;
        j.description = file_path;
        j.status      = JobStatus::Queued;
        impl_->jobs[job_id] = std::move(j);
    }

    {
        std::lock_guard lock(impl_->mtx);
        impl_->queue.push_back(task);
    }
    impl_->cv.notify_one();
}

void DecodeWorkerPool::cancel(const Id& job_id) {
    std::lock_guard lock(impl_->mtx);
    for (auto& task : impl_->queue) {
        if (task->job_id == job_id)
            task->cancelled.store(true, std::memory_order_relaxed);
    }
}

std::vector<Job> DecodeWorkerPool::all_jobs() const {
    std::lock_guard lock(impl_->jobs_mtx);
    std::vector<Job> out;
    out.reserve(impl_->jobs.size());
    for (const auto& [id, j] : impl_->jobs)
        out.push_back(j);
    return out;
}

void DecodeWorkerPool::wait_all() {
    // Poll until queue is empty and no job is Running.
    while (true) {
        {
            std::lock_guard lock(impl_->mtx);
            if (impl_->queue.empty()) {
                std::lock_guard jl(impl_->jobs_mtx);
                bool any_running = false;
                for (const auto& [id, j] : impl_->jobs)
                    if (j.status == JobStatus::Running) { any_running = true; break; }
                if (!any_running) return;
            }
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }
}

void DecodeWorkerPool::shutdown() {
    {
        std::lock_guard lock(impl_->mtx);
        impl_->stopping = true;
    }
    impl_->cv.notify_all();
    for (auto& t : impl_->threads)
        if (t.joinable()) t.join();
    impl_->threads.clear();
}

} // namespace lt
