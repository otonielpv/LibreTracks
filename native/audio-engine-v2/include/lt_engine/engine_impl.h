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
#include <lt_engine/pitch/bungee_voice_manager.h>
#include <lt_engine/pitch/prearmed_jump_manager.h>
#include <lt_engine/devices/audio_device_manager.h>
#include <lt_engine/transport/transport_clock.h>
#include <lt_engine/scheduler/jump_scheduler.h>
#include <memory>
#include <mutex>
#include <atomic>
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
    std::string  list_devices(bool force_rescan = false)  const;
    std::string  get_source_peaks(const std::string& source_id,
                                  int resolution_frames) const;
    // E2E: JSON snapshot of the most recent final stereo output for spectral
    // analysis ({ ok, sample_rate, frames, left[], right[] }).
    std::string  capture_output_samples() const;

    // Decode a pad key from disk and swap it into the renderer, RIGHT NOW, on
    // the calling thread. Bypasses the command queue so the (multi-second) MP3
    // decode of a ~15-min pad does NOT run under the caller's engine lock — the
    // Rust side calls this WITHOUT holding its state lock, so playback/snapshots
    // never stall. The swap itself is a realtime-safe atomic shared_ptr store.
    // `sample_rate <= 0` uses the current device rate.
    void load_pad_clip_now(const std::string& pads_dir,
                           const std::string& pad_id,
                           int key,
                           int sample_rate);

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
    std::unique_ptr<BungeeVoiceManager> bungee_voices_;
    std::unique_ptr<PrearmedJumpManager> prearmed_jumps_;
    // Bumped on ANY change that could invalidate a prearmed voice set:
    //   - LoadSession (structural session change)
    //   - SetSongTranspose / SetRegionTranspose / SetTrackTransposeEnabled
    //     (pitch changes — voices need rebuild with new effective semitones)
    //   - SetOutputDevice / SetSampleRate / SetBufferSize
    //     (voice dimensions change — also force clear()).
    //
    // Phase 6 implementation: single combined revision counter. The spec
    // proposes 5 separate revisions (session/pitch/source/device/audio_graph);
    // we use one for simplicity and accept the over-invalidation tradeoff —
    // e.g. a song transpose change invalidates ALL prepared sets, not just
    // those for the changed song. Acceptable since prearming is async and
    // re-population is cheap.
    std::atomic<std::uint64_t>          prearm_revision_{0};
    std::unique_ptr<Mixer>              mixer_;
    std::shared_ptr<const Session>      session_;
    DeviceOpenRequest                   current_device_request_;
    MetronomeConfig                     metronome_config_;
    VoiceGuideConfig                    voice_guide_config_;
    // Voice-guide bank source params, remembered so the bank can be re-decoded
    // at the new rate when the device sample rate changes. The bank's clips are
    // decoded to a fixed rate; if the device later runs at a different rate the
    // spoken count/section drifts out of sync with the beat grid (the bank is at
    // 44.1k while render is at 48k, or vice-versa). Empty until a bank is loaded.
    std::string                         voice_guide_voices_dir_;
    std::string                         voice_guide_lang_;
    // Ambient-pad config + the source params of the currently loaded key, kept
    // so the active key can be re-decoded at the new rate on a device SR change
    // (same reasoning as the voice-guide bank above). pad_loaded_key_ == -1
    // until a key is loaded.
    PadConfig                           pad_config_;
    std::string                         pad_pads_dir_;
    std::string                         pad_loaded_pad_id_;
    int                                 pad_loaded_key_ = -1;
    // The raw project JSON of the currently loaded session, kept so the whole
    // timeline can be re-parsed at a new sample rate when the device changes.
    // Markers/clips/regions/tempo are baked from seconds → frames using the SR
    // active at load time (session_from_project_json); a later SR change would
    // otherwise leave every timeline frame in the OLD rate's scale while render
    // runs at the new rate, so anything that must land on a beat (voice-guide
    // count, metronome, jumps) drifts. Empty when no session is loaded.
    std::string                         current_project_json_;
    std::atomic<uint64_t>               session_generation_{0};

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

    // Re-decode all loaded sources for a new sample rate. Called from device
    // / sample-rate / buffer-size command handlers when the negotiated rate
    // changes. Sources stored at the old rate would otherwise play back at
    // the wrong speed (~9% slow when switching 48k → 44.1k device). Also
    // re-prepares Bungee + prearmed-jumps managers with the new dimensions.
    void resample_sources_for_new_sample_rate();

    // Re-decode the voice-guide clip bank at the engine's current sample rate.
    // No-op if no bank was ever loaded. Called on SR changes so the spoken
    // count-in/section stays aligned with the beat grid after a device switch.
    void reload_voice_guide_bank_for_new_sample_rate();

    // Re-decode the currently loaded ambient-pad key at the device sample rate.
    // No-op if no key was ever loaded. Called on SR changes alongside the voice
    // guide reload.
    void reload_pad_clip_for_new_sample_rate();

    // Re-parse the loaded session's timeline (markers/clips/regions/tempo) at the
    // engine's current sample rate from the saved project JSON, preserving the
    // playhead's wall-clock position across the rate change. No-op if no session
    // JSON is stored. `old_sr` is the rate the timeline was last baked at.
    void rescale_session_for_new_sample_rate(int old_sr);

    // Silent audio render callback used during Phases 1-5.
    class SilentCallback;
    std::unique_ptr<SilentCallback> silent_callback_;

    // Last error returned by send_command(). The FFI collapses all
    // command-side errors to LT_ERR_INVALID_COMMAND and discards the
    // textual reason; the Rust layer pulls this string from the
    // snapshot to surface the actual cause to the user. Cleared at the
    // start of every send_command so callers can distinguish a fresh
    // failure from a stale one.
    mutable std::mutex last_command_error_mtx_;
    std::string last_command_error_;
};

} // namespace lt
