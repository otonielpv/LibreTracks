#pragma once

#include <lt_engine/sources/preparation_queue.h>
#include <atomic>
#include <chrono>
#include <filesystem>
#include <latch>
#include <stdexcept>
#include <thread>

// One control thread submits through the real preparation queue while its
// decode workers compete with playback. The gate only controls experiment
// start; no sleeps or artificial decode delays are injected into the engine.
class StreamingImportWorkload {
public:
    StreamingImportWorkload(lt::SourceManager& sources, const std::string& directory,
                            int count)
        : count_(count), pool_(1), queue_(&sources, &pool_, [](lt::EngineEvent) {}, 48000),
          control_([this, directory] {
              start_.wait();
              if (cancelled_.load()) return;
              active_.store(true);
              const auto began = std::chrono::steady_clock::now();
              try {
                  for (int i = 0; i < count_; ++i) {
                      const auto path = (std::filesystem::path(directory) /
                          ("import-" + std::to_string(i) + ".wav")).string();
                      queue_.enqueue_source(lt::Source{"import-source-" + std::to_string(i), path});
                  }
                  // Join after draining: wait_all() observes job status, which
                  // can become Completed before its on_done callback returns.
                  pool_.shutdown();
                  const auto states = queue_.preparation_states();
                  const auto jobs = pool_.all_jobs();
                  // A cache/native fast-path hit would invalidate the experiment.
                  if (states.size() != static_cast<std::size_t>(count_) || jobs.size() != states.size())
                      throw std::runtime_error("Import skipped decode: use fresh cache and 44.1 kHz fixtures");
                  for (const auto& state : states)
                      if (state.status != "ready" || !state.will_publish_peaks)
                          throw std::runtime_error("Import did not complete with decoded peaks");
                  completed_ = static_cast<int>(states.size());
              } catch (...) { failure_ = std::current_exception(); }
              elapsed_ms_ = std::chrono::duration<double, std::milli>(
                  std::chrono::steady_clock::now() - began).count();
              active_.store(false);
          }) {}

    ~StreamingImportWorkload() {
        if (!started_) { cancelled_.store(true); start_.count_down(); }
        if (control_.joinable()) control_.join();
        pool_.shutdown(); // Keep queue and SourceManager alive until callbacks end.
    }
    void start() { started_ = true; start_.count_down(); }
    bool active() const { return active_.load(); }
    void finish() {
        if (control_.joinable()) control_.join();
        if (failure_) std::rethrow_exception(failure_);
    }
    int completed() const { return completed_; } // Only after finish().
    double elapsed_ms() const { return elapsed_ms_; }

private:
    int count_;
    lt::DecodeWorkerPool pool_;
    lt::SourcePreparationQueue queue_;
    std::latch start_{1};
    std::atomic<bool> active_{false}, cancelled_{false};
    bool started_ = false;
    int completed_ = 0;
    double elapsed_ms_ = 0;
    std::exception_ptr failure_;
    std::thread control_;
};
