#pragma once

// ---------------------------------------------------------------------------
// BungeeVoiceManager
//
// Owns one BungeePitchVoice per (clip_id × effective semitones) entry in the
// session. Control-thread methods build, replace, or destroy voices; the
// audio thread calls voice_for() to fetch a stable pointer for the current
// block. Lookups are lock-free via shared_ptr atomic swap on a small map.
//
// Compiled to a hollow stub when LT_ENGINE_HAVE_BUNGEE=0 so the engine
// still links cleanly without Bungee.
// ---------------------------------------------------------------------------

#include <lt_engine/core/types.h>
#include <lt_engine/pitch/bungee_pitch_voice.h>
#include <lt_engine/session/session.h>

#include <memory>
#include <vector>

namespace lt {

class SourceManager;

class BungeeVoiceManager {
public:
    BungeeVoiceManager();
    ~BungeeVoiceManager();

    BungeeVoiceManager(const BungeeVoiceManager&) = delete;
    BungeeVoiceManager& operator=(const BungeeVoiceManager&) = delete;

    // ── Control-thread lifecycle ─────────────────────────────────────────

    // Configure once at engine init. Must be called before any rebuild_*.
    // Returns true when Bungee is compiled in and parameters are valid.
    bool prepare(int sample_rate, int channel_count, int max_input_frames);

    // True when prepare() has succeeded AND Bungee is compiled in.
    bool is_available() const noexcept;

    // Build/replace voices for every transposed clip in the session at the
    // given playhead. Cheap when called repeatedly with the same session and
    // unchanged effective pitches — existing voices are reused.
    //
    // The Source pointer for each clip must be valid for the lifetime of the
    // voice (until the next rebuild_*). source_manager_ provides them.
    void rebuild_for_session(const Session& session,
                             const SourceManager& sources,
                             Frame playhead);

    // Destroy voices for clips whose effective pitch is non-zero at the new
    // playhead and rebuild them primed at that position. Bungee's reset
    // model (upstream issue #16) is destroy-and-reconstruct, which the
    // construction benchmark shows is ~1.5 ms for 9 voices.
    void rebuild_for_seek(Frame target_frame,
                          const Session& session,
                          const SourceManager& sources);

    // Drop all voices (e.g. session unload).
    void clear();

    // ── Audio-thread lookup (must not allocate) ──────────────────────────

    // Returns a non-owning pointer to the voice matching (clip_id, semitones).
    // Returns nullptr if no voice exists yet — the caller should fall back to
    // its legacy pitch path.
    //
    // Audio-thread safe: snapshots the current voice map via atomic_load.
    BungeePitchVoice* voice_for(const Id& clip_id, Semitones semitones) noexcept;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace lt
