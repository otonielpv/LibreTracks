#pragma once

// ---------------------------------------------------------------------------
// WarpVoiceManager
//
// Owns one WarpVoice (Signalsmith or RubberBand) per warp-active clip in
// the session. Same thread model as BungeeVoiceManager: control-thread
// methods build/replace voices, audio-thread voice_for() returns a stable
// shared_ptr for the current block. Voice lookups are lock-free via
// shared_ptr atomic swap.
//
// Bungee handles pitch shift; this manager handles time-stretch (warp). A
// clip with pitch + warp goes through both in cascade — see TrackRenderer
// for the routing. A clip with warp only routes through this manager only.
//
// The active backend is selected at prepare() time via env var
// LT_WARP_BACKEND={signalsmith,rubberband}, defaulting to signalsmith.
// Whichever backends are compiled in via CMake bound the selector.
// ---------------------------------------------------------------------------

#include <lt_engine/core/types.h>
#include <lt_engine/pitch/warp_voice.h>
#include <lt_engine/session/session.h>

#include <cstdint>
#include <memory>
#include <unordered_map>

namespace lt {

class SourceManager;

enum class WarpBackend {
    Signalsmith,
    RubberBandR3,
};

struct WarpVoiceManagerDiagnostics {
    int           active_voice_count = 0;
    std::uint64_t voices_built_total = 0;
    std::uint64_t rebuilds_total     = 0;
    std::uint64_t voice_lookups_hit  = 0;
    std::uint64_t voice_lookups_miss = 0;
    WarpBackend   backend            = WarpBackend::Signalsmith;
};

class WarpVoiceManager {
public:
    using VoiceMap = std::unordered_map<Id, std::shared_ptr<WarpVoice>>;

    WarpVoiceManager();
    ~WarpVoiceManager();

    WarpVoiceManager(const WarpVoiceManager&) = delete;
    WarpVoiceManager& operator=(const WarpVoiceManager&) = delete;

    bool prepare(int sample_rate, int channel_count, int max_input_frames);
    bool is_available() const noexcept;

    // Currently selected backend (resolved by prepare from env var or
    // compile-time fallback).
    WarpBackend active_backend() const noexcept;
    const char* active_backend_name() const noexcept;

    void rebuild_for_session(const Session& session,
                              const SourceManager& sources,
                              Frame playhead);

    void clear();

    std::shared_ptr<WarpVoice> voice_for_shared(const Id& clip_id) noexcept;

    WarpVoiceManagerDiagnostics diagnostics() const noexcept;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace lt
