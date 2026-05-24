#pragma once

// ---------------------------------------------------------------------------
// WarpVoiceManager
//
// Owns one RubberBandWarpVoice per warp-active clip in the session. Same
// thread model as BungeeVoiceManager: control-thread methods build/replace
// voices, audio-thread voice_for() returns a stable shared_ptr for the
// current block. Voice lookups are lock-free via shared_ptr atomic swap.
//
// Bungee handles pitch shift; this manager handles time-stretch (warp).
// A clip with pitch + warp will go through both in cascade (TODO — see
// TrackRenderer::render_path_cascade); a clip with warp only routes
// through this manager only.
// ---------------------------------------------------------------------------

#include <lt_engine/core/types.h>
#include <lt_engine/pitch/warp_voice.h>
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
    using VoiceMap = std::unordered_map<Id, std::shared_ptr<WarpVoice>>;

    WarpVoiceManager();
    ~WarpVoiceManager();

    WarpVoiceManager(const WarpVoiceManager&) = delete;
    WarpVoiceManager& operator=(const WarpVoiceManager&) = delete;

    bool prepare(int sample_rate, int channel_count, int max_input_frames);
    bool is_available() const noexcept;

    // For diagnostics. Always returns the same string in this build —
    // future backends (or a Bungee fallback) can switch on it.
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
