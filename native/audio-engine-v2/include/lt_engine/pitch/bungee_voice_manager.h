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
#include <lt_engine/pitch/prepared_voice_map.h>
#include <lt_engine/session/session.h>

#include <cstdint>
#include <memory>
#include <unordered_map>
#include <vector>

namespace lt {

class SourceManager;

// Snapshot of voice-manager counters, safe to read from any thread.
// Useful for confirming whether the audio thread is actually consuming
// Bungee voices or silently falling back to the legacy pitch engine.
struct BungeeVoiceManagerDiagnostics {
    int           active_voice_count   = 0;
    std::uint64_t voices_built_total   = 0;   // construct + prime calls
    std::uint64_t rebuilds_for_session = 0;
    std::uint64_t rebuilds_for_seek    = 0;
    std::uint64_t voice_lookups_hit    = 0;   // voice_for() returned non-null
    std::uint64_t voice_lookups_miss   = 0;   // voice_for() returned nullptr
};

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

    // Same as rebuild_for_seek but runs the build (~600 ms warm + prefeed)
    // on a dedicated worker thread. The previous voice map stays active so
    // the audio thread keeps rendering without a gap; the new map is
    // published via atomic_store the moment it's ready.
    //
    // Safe to use ONLY when the previous voice map is still musically
    // correct for `target_frame` — i.e. play after pause, or the no-op
    // seek the UI sends as part of its play sequence. For a real seek to
    // a different position the previous voices play the wrong audio for
    // the build duration; use the synchronous variant instead.
    //
    // Captures a copy of the Session so callers can mutate session state
    // without racing the worker.
    void rebuild_for_seek_async(Frame target_frame,
                                const Session& session,
                                const SourceManager& sources);

    // Drop all voices (e.g. session unload).
    void clear();

    // Atomically replace the active voice map with `prepared_voices`. Used by
    // PrearmedJumpManager when the user triggers a marker/region/song/vamp
    // jump and a fully prepared voice set is available — the audio thread's
    // next voice_for() lookup sees the new map (or the old, never partial).
    //
    // Semantics:
    //   - The full set is published in one atomic_store; no partial state is
    //     ever visible. Either every voice in `prepared_voices` becomes
    //     active or none does (if the manager isn't prepared).
    //   - The previous active map's voices are released when their last
    //     shared_ptr referent drops. The audio thread may still hold a
    //     snapshot from before the swap for one block — that's fine, those
    //     voices stay alive until the snapshot releases.
    //   - Bumps `rebuilds_for_seek` so diagnostics counts this as a seek-
    //     equivalent event (audio thread will start using new voices on the
    //     next block).
    //
    // Caller must ensure every voice in `prepared_voices` was configured for
    // the same (sample_rate, channel_count, max_input_frames) this manager
    // was prepared with — otherwise audio thread behaviour is undefined.
    void swap_in_prepared_voices(PreparedVoiceMap prepared_voices);

    std::shared_ptr<const PreparedVoiceMap>
    build_prepared_voice_map(PreparedVoiceMap prepared_voices) const;

    void publish_prepared_voice_map_realtime(
        std::shared_ptr<const PreparedVoiceMap> prepared_voices) noexcept;

    // Audio-thread safe: publish the preallocated empty voice map so pitched
    // tracks do not keep rendering stale voices after an unprepared jump.
    void publish_empty_voice_map_realtime() noexcept;

    // ── Audio-thread lookup (must not allocate) ──────────────────────────

    // Returns a non-owning pointer to the voice owning this clip. Returns
    // nullptr if no voice exists yet — the caller should fall back to its
    // legacy pitch path.
    //
    // Voices are keyed per-clip, NOT per-(clip, semitones), because Bungee's
    // Request::pitch parameter is updated on every audio block. Live pitch
    // changes do not require rebuilding the voice; only the playhead moving
    // to a different position does (handled by rebuild_for_seek).
    //
    // Audio-thread safe: snapshots the current voice map via atomic_load.
    std::shared_ptr<BungeePitchVoice> voice_for_shared(const Id& clip_id) noexcept;
    BungeePitchVoice* voice_for(const Id& clip_id) noexcept;

    // ── Diagnostics (any thread) ─────────────────────────────────────────
    BungeeVoiceManagerDiagnostics diagnostics() const noexcept;

private:
    struct Impl;
    void rebuild_for_seek_guarded(Frame target_frame,
                                  const Session& session,
                                  const SourceManager& sources,
                                  std::uint64_t expected_generation);
    std::unique_ptr<Impl> impl_;
};

} // namespace lt
