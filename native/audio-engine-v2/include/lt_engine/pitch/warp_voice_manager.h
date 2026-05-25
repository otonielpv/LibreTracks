#pragma once

// ---------------------------------------------------------------------------
// WarpVoiceManager
//
// Owns one WarpVoice per warp-active clip in the session. Same
// thread model as BungeeVoiceManager: control-thread methods build/replace
// voices, audio-thread voice_for() returns a stable shared_ptr for the
// current block. Voice lookups are lock-free via shared_ptr atomic swap.
//
// Bungee handles pitch shift; this manager handles time-stretch (warp).
// A clip with pitch + warp goes through both in cascade; a clip with warp
// only routes through this manager only.
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

    // For diagnostics.
    const char* active_backend_name() const noexcept;

    void rebuild_for_session(const Session& session,
                              const SourceManager& sources,
                              Frame playhead);

    void rebuild_for_seek(const Session& session,
                          const SourceManager& sources,
                          Frame playhead);

    // Cheap retime for BPM/source-BPM edits while playback is running. Keeps
    // existing DSP instances warm and only moves their source cursors to the
    // new timeline mapping.
    void retime_existing_for_session(const Session& session,
                                     const SourceManager& sources,
                                     Frame playhead);

    // Realtime-safe variant used inside the audio callback on scheduled jumps:
    // no allocation, no lock, only resets cursors for already-existing voices.
    void retime_existing_realtime(const Session& session,
                                  Frame playhead) noexcept;

    // Audio-thread safe: install a pre-built voice map (one warp voice per
    // clip_id) atomically. Used by the mixer when a scheduled jump's
    // PrearmedJumpManager set carries warp voices pre-fed to the target.
    // The pointer must be built on the control thread; this method only
    // does an atomic_store.
    void publish_prepared_voice_map_realtime(
        std::shared_ptr<const VoiceMap> prepared_voices) noexcept;

    // Build a shared_ptr<const VoiceMap> from a moved-in map. Convenience
    // for the engine command thread before publish_prepared_voice_map_realtime.
    std::shared_ptr<const VoiceMap>
    build_prepared_voice_map(VoiceMap prepared_voices) const;

    // Build (but don't install) a fresh WarpVoice using the same backend
    // selection logic the manager itself uses. Used by PrearmedJumpManager
    // to construct warp voices for prepared jump targets without going
    // through the active voice map. The returned voice is configured but
    // its source cursor is at 0 and its internal analysis is empty —
    // callers should reset_source_cursor + prefeed to warm the stretcher
    // before publishing it as the active voice for a jump target.
    std::shared_ptr<WarpVoice> make_voice_for_clip() const;

    // Build a fresh prepared voice map for `target_frame` and return it
    // ready to publish. Each warp-active clip at the target gets a new
    // WarpVoice with its cursor positioned and `input_latency_frames()` of
    // source audio pre-fed through the stretcher, so the very first
    // post-publish render_block emits non-silent audio. Mirrors what
    // `BungeeVoiceManager::build_seek_voice_map` does for pitched voices.
    //
    // Use this from seek command handlers (CmdSeek, JumpToMarker fallback,
    // etc.) in place of `rebuild_for_seek` when you want the warp tracks
    // to come back instantly instead of waiting ~100 ms of stretcher
    // analysis silence at 48 k.
    std::shared_ptr<const VoiceMap>
    build_seek_voice_map(Frame target_frame,
                          const Session& session,
                          const SourceManager& sources) const;

    void clear();

    std::shared_ptr<WarpVoice> voice_for_shared(const Id& clip_id) noexcept;

    WarpVoiceManagerDiagnostics diagnostics() const noexcept;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace lt
