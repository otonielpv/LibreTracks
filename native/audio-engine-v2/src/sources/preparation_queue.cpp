#include <lt_engine/sources/preparation_queue.h>
#include <lt_engine/sources/audio_decoder.h>
#include <algorithm>
#include <cstdlib>
#include <mutex>
#include <unordered_map>

namespace lt {

namespace {
// Streaming decode is on by default; set LIBRETRACKS_STREAMING_DECODE=0 to fall
// back to the whole-file decode path (for A/B and as an escape hatch).
bool streaming_decode_enabled() {
    static const bool on = [] {
        const char* v = std::getenv("LIBRETRACKS_STREAMING_DECODE");
        return !(v && v[0] == '0' && v[1] == '\0');
    }();
    return on;
}
} // namespace

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
    : impl_(std::make_shared<Impl>())
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

    auto mark_ready = [&] {
        {
            std::lock_guard lock(impl_->mtx);
            auto& info = impl_->states[source_id];
            info.status           = "ready";
            info.progress_percent = 100;
        }
        impl_->push_event(EvSourcePrepared{ source_id });
    };

    // Fast path 1: if a PCM cache from a previous session is still valid for
    // this file (matching mtime + size), reuse it and skip the decode worker
    // entirely.
    if (impl_->source_manager->try_install_from_cache_file(source_id, sr)) {
        mark_ready();
        return;
    }

    // Fast path 2: if the original file is already a libsndfile-readable
    // container at the engine sample rate, stream it in place — no decode,
    // no cache write. This is the common case for native WAV stems.
    if (impl_->source_manager->try_install_native_file(source_id, sr)) {
        mark_ready();
        return;
    }

    std::weak_ptr<Impl> weak_impl = impl_;
    impl_->pool->submit_decode(
        source_id,  // job_id == source_id for simplicity
        source_id,
        file_path,
        sr,
        [weak_impl, source_id](const Job& job) {
            auto impl = weak_impl.lock();
            if (!impl) {
                return;
            }
            std::lock_guard lock(impl->mtx);
            auto& info = impl->states[source_id];
            if (info.status != "ready" && info.status != "failed" && info.status != "cancelled") {
                info.status = "loading";
                info.progress_percent = std::max(
                    info.progress_percent,
                    std::clamp(job.progress_pct, 0, 99));
            }
        },
        [weak_impl, source_id](Job& job) {
            auto impl = weak_impl.lock();
            if (!impl) {
                return;
            }
            // Worker thread callback — marshal into engine event queue.
            if (job.status == JobStatus::Completed) {
                // Streaming path already installed the source inside the worker
                // (decoded_samples is empty); just mark ready. Whole-file path
                // hands the decoded buffer here to store now.
                Result<void> stored = Result<void>::ok();
                if (!job.decoded_samples.empty()) {
                    // MOVE the decoded buffer into the store (don't copy it): a
                    // multi-MB copy per import inflates the resident working set
                    // and pages out the audio thread, causing playback dropouts.
                    stored = impl->source_manager->store_decoded_source(
                        source_id,
                        std::move(job.decoded_samples),
                        job.channel_count,
                        job.sample_rate,
                        job.duration_frames,
                        [impl, source_id](int progress_pct) {
                            std::lock_guard lock(impl->mtx);
                            auto& info = impl->states[source_id];
                            if (info.status != "ready" && info.status != "failed" && info.status != "cancelled") {
                                info.status = "loading";
                                info.progress_percent = std::max(
                                    info.progress_percent,
                                    std::clamp(progress_pct, 0, 99));
                            }
                        });
                }
                {
                    std::lock_guard lock(impl->mtx);
                    auto& info = impl->states[source_id];
                    if (stored.is_ok()) {
                        info.status           = "ready";
                        info.progress_percent = 100;
                    } else {
                        info.status = "failed";
                        info.error_message = stored.error();
                    }
                }
                if (stored.is_ok()) {
                    impl->push_event(EvSourcePrepared{ source_id });
                } else {
                    impl->push_event(EvDiagnosticWarning{
                        "Source preparation failed [" + source_id + "]: " + stored.error()
                    });
                }
            } else if (job.status == JobStatus::Failed) {
                {
                    std::lock_guard lock(impl->mtx);
                auto& info = impl->states[source_id];
                info.status = "failed";
                info.error_message = job.error_message;
                }
                impl->push_event(EvDiagnosticWarning{
                    "Source decode failed [" + source_id + "]: " + job.error_message
                });
            }
        },
        // Streaming decode+store (default on; LIBRETRACKS_STREAMING_DECODE=0 to
        // use the old whole-file path). Pipes decode→resample→cache in chunks so
        // the per-track peak footprint is a few MB instead of ~380MB, which stops
        // the working set from swinging and stalling the audio thread on import.
        streaming_decode_enabled()
            ? StreamingStoreCallback(
                  [weak_impl](const Id& sid, const std::string& path, int target_sr,
                              const JobProgressCallback& prog) -> std::string {
                      auto impl = weak_impl.lock();
                      if (!impl)
                          return "preparation queue gone";
                      auto r = impl->source_manager->decode_and_store_streaming(
                          sid, path, target_sr,
                          [&prog, sid](int pct) {
                              if (prog) {
                                  Job j;
                                  j.source_id = sid;
                                  j.progress_pct = pct;
                                  prog(j);
                              }
                          });
                      return r.is_ok() ? std::string{} : r.error();
                  })
            : StreamingStoreCallback{}
    );

    // Update state to "loading" after submission.
    {
        std::lock_guard lock(impl_->mtx);
        auto& info = impl_->states[source_id];
        if (info.status == "queued")
            info.status = "loading";
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
