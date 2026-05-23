#pragma once

// ---------------------------------------------------------------------------
// WarpVoiceManager
//
// Owns one SignalsmithWarpVoice per warp-active clip in the session. Same
// thread model as BungeeVoiceManager: control-thread methods build/replace
// voices, audio-thread voice_for() returns a stable shared_ptr for the
// current block. Voice lookups are lock-free via shared_ptr atomic swap.
//
// Bungee handles pitch shift; this manager handles time-stretch (warp). A
// clip with pitch + warp goes through both in cascade — see TrackRenderer
// for the routing. A clip with warp only routes through this manager only.
//
// Compiled to a hollow stub when LT_ENGINE_HAVE_SIGNALSMITH=0 so the engine
// still links cleanly without Signalsmith.
// ---------------------------------------------------------------------------

#include <lt_engine/core/types.h>
#include <lt_engine/pitch/signalsmith_warp_voice.h>
#include <lt_engine/session/session.h>

#include <cstdint>
#include <memory>
#include <unordered_map>

namespace lt {

class SourceManager;

struct WarpVoiceManagerDiagnostics {
    int           active_voice_count = 0;
    std::uint64_t voices_built_total = 0;
    std::uint64_t rebuilds_total     = 0;
    std::uint64_t voice_lookups_hit  = 0;
    std::uint64_t voice_lookups_miss = 0;
};

class WarpVoiceManager {
public:
    using VoiceMap = std::unordered_map<Id, std::shared_ptr<SignalsmithWarpVoice>>;

    WarpVoiceManager();
    ~WarpVoiceManager();

    WarpVoiceManager(const WarpVoiceManager&) = delete;
    WarpVoiceManager& operator=(const WarpVoiceManager&) = delete;

    // Configure once at engine init. Must be called before any rebuild_*.
    // Returns true when Signalsmith is compiled in and parameters are valid.
    bool prepare(int sample_rate, int channel_count, int max_input_frames);

    bool is_available() const noexcept;

    // Build/replace voices for every warp-active clip in the session. Existing
    // voices for clips that still need warp are REUSED (Signalsmith is stateful;
    // destroying and reconstructing produces audible discontinuities). Only
    // clips that newly need warp get fresh voices.
    void rebuild_for_session(const Session& session,
                              const SourceManager& sources);

    void clear();

    // Audio-thread lookup. Returns nullptr if no voice exists for this clip.
    std::shared_ptr<SignalsmithWarpVoice> voice_for_shared(const Id& clip_id) noexcept;

    WarpVoiceManagerDiagnostics diagnostics() const noexcept;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace lt
