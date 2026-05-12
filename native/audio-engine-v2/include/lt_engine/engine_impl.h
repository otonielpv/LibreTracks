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
#include <lt_engine/devices/audio_device_manager.h>
#include <lt_engine/transport/transport_clock.h>
#include <lt_engine/scheduler/jump_scheduler.h>
#include <memory>
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
    std::unique_ptr<Mixer>              mixer_;
    std::optional<Session>              session_;
    DeviceOpenRequest                   current_device_request_;

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

    // Silent audio render callback used during Phases 1-5.
    class SilentCallback;
    std::unique_ptr<SilentCallback> silent_callback_;
};

} // namespace lt
