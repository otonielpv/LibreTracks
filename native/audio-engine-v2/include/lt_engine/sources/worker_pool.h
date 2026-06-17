#pragma once

// ---------------------------------------------------------------------------
// DecodeWorkerPool — thread pool for background source decode/resample jobs.
//
// Contract:
//   - All heavy work (decode, resample, pitch cache) runs here.
//   - Audio callback never touches this.
//   - UI / command thread submits jobs and polls progress via EngineSnapshot.
// ---------------------------------------------------------------------------

#include <lt_engine/core/types.h>
#include <lt_engine/core/events.h>
#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace lt {

enum class JobStatus { Queued, Running, Completed, Failed, Cancelled };

struct Job {
    Id          job_id;
    Id          source_id;
    std::string description;
    JobStatus   status          = JobStatus::Queued;
    int         progress_pct    = 0;
    std::string error_message;
    std::vector<float> decoded_samples;
    int         channel_count   = 0;
    int         sample_rate     = 0;
    Frame       duration_frames = 0;
};

// Fired on the worker thread when a job finishes (success or failure).
// Must be fast and non-blocking — will be marshalled to the event queue.
// Takes Job& (not const&) so the handler can MOVE the (large) decoded_samples
// buffer out instead of copying it — copying a multi-MB decode per import is a
// major source of memory pressure that evicts the audio thread's working set.
using JobCompletionCallback = std::function<void(Job&)>;
using JobProgressCallback = std::function<void(const Job&)>;

// Optional streaming decode+store, run on the worker thread INSTEAD of the
// whole-file decode_file_to_float32 + on_done handback. When set, the worker
// calls this (which pipes decode→resample→cache in chunks, never holding the
// whole file in RAM) and reports success/failure via on_done with an empty
// decoded_samples. Lets the prep queue keep the SourceManager dependency.
// Returns an error string on failure, empty on success.
using StreamingStoreCallback =
    std::function<std::string(const Id& source_id, const std::string& file_path,
                              int target_sample_rate,
                              const JobProgressCallback& on_progress)>;

class DecodeWorkerPool {
public:
    // num_threads = 0 → hardware_concurrency / 2, min 1.
    explicit DecodeWorkerPool(int num_threads = 0);
    ~DecodeWorkerPool();

    // Submit a decode+resample job for a source file.
    // Calls `on_done` on the worker thread when complete.
    // If `streaming_store` is set, the worker runs IT (chunked decode→cache)
    // instead of the whole-file decode + on_done handback, then signals
    // completion via on_done with an empty decoded_samples buffer.
    void submit_decode(const Id&          job_id,
                       const Id&          source_id,
                       const std::string& file_path,
                       int                target_sample_rate,
                       JobProgressCallback on_progress,
                       JobCompletionCallback on_done,
                       StreamingStoreCallback streaming_store = {});

    // Cancel a pending or running job.  No-op if already complete.
    void cancel(const Id& job_id);

    // Snapshot of all known jobs (safe to call from any thread).
    std::vector<Job> all_jobs() const;

    // Block until all queued+running jobs finish (for clean shutdown).
    void wait_all();

    // Stop accepting new jobs and drain the pool.
    void shutdown();

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace lt
