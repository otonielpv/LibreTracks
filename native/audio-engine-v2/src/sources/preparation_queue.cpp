#include <lt_engine/sources/preparation_queue.h>
#include <lt_engine/sources/audio_decoder.h>
#include <algorithm>
#include <mutex>
#include <unordered_map>

namespace lt {

struct SourcePreparationQueue::Impl {
    SourceManager*    source_manager;
    DecodeWorkerPool* pool;
    EventPushCallback push_event;
    int               engine_sample_rate;

    mutable std::mutex                          mtx;
    std::unordered_map<Id, SourcePreparationInfo> states;
};

SourcePreparationQueue::SourcePreparationQueue(SourceManager*    source_manager,
                                                DecodeWorkerPool* pool,
                                                EventPushCallback push_event,
                                                int               engine_sample_rate)
    : impl_(std::make_unique<Impl>())
{
    impl_->source_manager    = source_manager;
    impl_->pool              = pool;
    impl_->push_event        = std::move(push_event);
    impl_->engine_sample_rate = engine_sample_rate;
}

SourcePreparationQueue::~SourcePreparationQueue() {
    cancel_all();
}

void SourcePreparationQueue::enqueue_source(const Source& source) {
    // Skip if already loaded or queued.
    {
        std::lock_guard lock(impl_->mtx);
        auto it = impl_->states.find(source.id);
        if (it != impl_->states.end()) {
            const auto& s = it->second.status;
            if (s == "ready" || s == "queued" || s == "loading") return;
        }

        SourcePreparationInfo info;
        info.source_id        = source.id;
        info.status           = "queued";
        info.progress_percent = 0;
        impl_->states[source.id] = info;
    }

    // Register in SourceManager (idempotent).
    impl_->source_manager->register_source(source.id, source.file_path);

    std::string file_path = source.file_path;
    Id          source_id = source.id;
    int         sr        = impl_->engine_sample_rate;

    impl_->pool->submit_decode(
        source_id,  // job_id == source_id for simplicity
        source_id,
        file_path,
        sr,
        [this, source_id](const Job& job) {
            // Worker thread callback — marshal into engine event queue.
            if (job.status == JobStatus::Completed) {
                auto stored = impl_->source_manager->store_decoded_source(
                    source_id,
                    job.decoded_samples,
                    job.channel_count,
                    job.sample_rate,
                    job.duration_frames);
                {
                    std::lock_guard lock(impl_->mtx);
                    auto& info = impl_->states[source_id];
                    if (stored.is_ok()) {
                        info.status           = "ready";
                        info.progress_percent = 100;
                    } else {
                        info.status = "failed";
                    }
                }
                if (stored.is_ok()) {
                    impl_->push_event(EvSourcePrepared{ source_id });
                } else {
                    impl_->push_event(EvDiagnosticWarning{
                        "Source preparation failed [" + source_id + "]: " + stored.error()
                    });
                }
            } else if (job.status == JobStatus::Failed) {
                {
                    std::lock_guard lock(impl_->mtx);
                    auto& info = impl_->states[source_id];
                    info.status = "failed";
                }
                impl_->push_event(EvDiagnosticWarning{
                    "Source decode failed [" + source_id + "]: " + job.error_message
                });
            }
        }
    );

    // Update state to "loading" after submission.
    {
        std::lock_guard lock(impl_->mtx);
        impl_->states[source_id].status = "loading";
    }
}

void SourcePreparationQueue::enqueue_session(const std::vector<Source>& sources,
                                              Frame playhead_frame) {
    // Sort sources by distance to playhead before enqueueing.
    std::vector<const Source*> sorted;
    sorted.reserve(sources.size());
    for (const auto& s : sources) sorted.push_back(&s);

    // A simple heuristic: sources whose clips start near the playhead first.
    // Since we don't have clip data here, we enqueue in order and let the
    // pool's FIFO handle it. Phase 11 adds smarter prioritization.
    for (const auto* s : sorted)
        enqueue_source(*s);
}

void SourcePreparationQueue::cancel_all() {
    std::lock_guard lock(impl_->mtx);
    for (auto& [id, info] : impl_->states) {
        if (info.status == "queued" || info.status == "loading") {
            impl_->pool->cancel(id);
            info.status = "cancelled";
        }
    }
}

std::vector<SourcePreparationInfo> SourcePreparationQueue::preparation_states() const {
    std::lock_guard lock(impl_->mtx);
    std::vector<SourcePreparationInfo> out;
    out.reserve(impl_->states.size());
    for (const auto& [id, info] : impl_->states)
        out.push_back(info);
    return out;
}

} // namespace lt
