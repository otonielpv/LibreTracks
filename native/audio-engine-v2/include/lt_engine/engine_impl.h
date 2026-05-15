#pragma once

// ---------------------------------------------------------------------------
// EngineImpl — C++ implementation behind the C ABI.
//
// The C ABI functions in lt_engine.h hold a pointer to this class cast to
// opaque LtEngine*.  All public methods are called from the Rust/Tauri layer
// through the FFI wrapper.
// ---------------------------------------------------------------------------

#include <lt_engine/core/commands.h>
#include <lt_engine/core/events.h>
#include <lt_engine/core/snapshot.h>
#include <lt_engine/core/result.h>
#include <lt_engine/session/session.h>
#include <lt_engine/session/session_adapter.h>
#include <lt_engine/sources/source_manager.h>
#include <lt_engine/sources/worker_pool.h>
#include <lt_engine/sources/preparation_queue.h>
#include <lt_engine/render/mixer.h>
#include <lt_engine/pitch/pitch_cache.h>
#include <lt_engine/pitch/realtime_pitch_engine.h>
#include <lt_engine/devices/audio_device_manager.h>
#include <lt_engine/transport/transport_clock.h>
#include <lt_engine/scheduler/jump_scheduler.h>
#include <memory>
#include <atomic>
#include <chrono>
#include <mutex>
#include <string>

namespace lt {

class EngineImpl {
public:
    EngineImpl();
    ~EngineImpl();

    Result<void> initialize();
    Result<void> shutdown();

    std::string  version()      const;
    std::string  diagnostics()  const;

    Result<void> send_command(const std::string& json);
    void         service_control_thread_tasks();  // call once before command batches
    std::string  poll_event();           // returns "" when queue empty
    std::string  get_snapshot()  const;
    std::string  list_devices()  const;

private:
    // ── State machine ────────────────────────────────────────────────────
    enum class State { Created, Initialized, ShutDown };
    State state_ = State::Created;

    // ── Sub-systems ──────────────────────────────────────────────────────
    std::unique_ptr<AudioDeviceManager> device_manager_;
    std::unique_ptr<TransportClock>     clock_;
    std::unique_ptr<JumpScheduler>      scheduler_;
    std::unique_ptr<SourceManager>      source_manager_;
    std::unique_ptr<DecodeWorkerPool>   worker_pool_;
    std::unique_ptr<SourcePreparationQueue> prep_queue_;
    std::unique_ptr<PitchCache>         pitch_cache_;
    std::unique_ptr<RealtimePitchEngine> realtime_pitch_engine_;
    std::unique_ptr<Mixer>              mixer_;
    std::shared_ptr<const Session>      session_;
    DeviceOpenRequest                   current_device_request_;
    MetronomeConfig                     metronome_config_;
    std::atomic<uint64_t>               session_generation_{0};
    std::atomic<uint64_t>               pitch_prepare_on_source_ready_count_{0};
    std::atomic<uint64_t>               source_ready_pitch_prepare_count_{0};
    mutable std::atomic<Frame>          last_pitch_prepare_playhead_{-1};
    mutable std::mutex                  pitch_prepare_mutex_;
    mutable std::chrono::steady_clock::time_point last_pitch_prepare_time_{};

    // Cached snapshot string (rebuilt on snapshot request).
    mutable std::string snapshot_cache_;

    // Event queue — single-producer (engine internals) / single-consumer
    // (Rust poller).  For Phase 2 we use a simple mutex-protected queue;
    // a lock-free queue is introduced in later phases.
    struct EventQueue;
    std::unique_ptr<EventQueue> event_queue_;

    // ── Internal helpers ─────────────────────────────────────────────────
    void push_event(EngineEvent ev);
    Result<void> dispatch_command(const EngineCommand& cmd);
    void prepare_pitch_processors_for_session();
    std::size_t prepare_pitch_processors_for_session(const Session& session);
    std::size_t prepare_pitch_processors_for_source(const Id& source_id);
    std::size_t enqueue_pitch_window(const Session& session,
                                     Frame timeline_start,
                                     Frame frame_count,
                                     int priority,
                                     const std::string& reason) const;
    void maybe_enqueue_rolling_pitch_prepare() const;

    // Called from the control thread (not audio callback) to service any pending
    // pitch stream repair requests posted by render_pitched_clip().
    void service_pitch_repair_requests();

    // Called from the control thread to detect scheduled jumps that fired in the audio
    // callback and prepare pitch streams for the new position.
    void service_pending_scheduled_jump_pitch();

    // Silent audio render callback used during Phases 1-5.
    class SilentCallback;
    std::unique_ptr<SilentCallback> silent_callback_;
};

} // namespace lt
