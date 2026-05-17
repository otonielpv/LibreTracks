#pragma once

// ---------------------------------------------------------------------------
// PrearmedJumpManager — Phase 1 (MVP, marker targets only)
//
// Owns prepared `BungeePitchVoice` sets for known musical jump targets so the
// audio thread can switch to them in O(1) (atomic shared_ptr swap) instead of
// paying ~80 ms of control-thread voice construction at the moment of seek.
//
// Architecture (separation from BungeeVoiceManager):
//   * `BungeeVoiceManager` continues to own the *active* voice map for the
//     currently-playing playhead — reactive `rebuild_for_seek` is unchanged
//     and remains the fallback when no prepared set is available.
//   * `PrearmedJumpManager` owns a separate prepared-targets map, keyed by
//     `PrearmTargetKey`. When the user triggers a marker jump, the engine
//     asks this manager for the prepared set; if present and valid, the
//     engine swaps it into `BungeeVoiceManager` via the new
//     `swap_in_prepared_voices()` method and transport jumps. Otherwise we
//     fall through to the existing reactive seek path.
//
// MVP scope (deliberately narrow; everything else is Phase ≥2):
//   * Target kinds: Marker only.
//   * Priming: warm_voice silence loop (crash-safety; see
//     [[project-bungee-warm-voice]] memory) followed by real-audio prefeed of
//     ~maxInputFrameCount/2 frames so the first post-jump render block emits
//     true target audio instead of FFT-warm-up artefacts.
//   * Invalidation: session_revision only. Pitch / device / source revisions
//     follow in Phase 6.
//   * Eviction: none. We hold what we prepare for the lifetime of the
//     session_revision (Phase 7 adds budgets).
//
// Threading:
//   * All `prepare_*` methods run on the CONTROL thread (call sites: command
//     handler in engine_impl after session load / pitch change / etc).
//   * `take_ready()` runs on whatever thread handles the jump command (also
//     control thread in current engine); it removes the prepared set from the
//     map and returns it for atomic publish into BungeeVoiceManager.
//   * Audio thread never touches this class directly.
// ---------------------------------------------------------------------------

#include <lt_engine/core/types.h>
#include <lt_engine/pitch/bungee_pitch_voice.h>
#include <lt_engine/session/session.h>

#include <cstdint>
#include <memory>
#include <mutex>
#include <unordered_map>
#include <vector>

namespace lt {

class SourceManager;
class BungeeVoiceManager;

enum class PrearmTargetKind {
    Marker,
    RegionStart,
    SongStart,
    // Vamp, … — added in later phases.
};

// Identifies a prearmed target. session_revision invalidates the entire map
// when the user edits the project; the rest disambiguates which target.
//
// `target_id` is the marker_id / region_id / song_id depending on kind. For
// SongStart it's the song's own id (redundant with song_id but kept uniform).
struct PrearmTargetKey {
    PrearmTargetKind kind             = PrearmTargetKind::Marker;
    Id               song_id;
    Id               target_id;       // marker_id, region_id, or song_id
    Frame            timeline_frame   = 0;
    int              sample_rate      = 0;
    int              block_size       = 0;
    std::uint64_t    session_revision = 0;

    bool operator==(const PrearmTargetKey& o) const noexcept {
        return kind == o.kind
            && song_id == o.song_id
            && target_id == o.target_id
            && timeline_frame == o.timeline_frame
            && sample_rate == o.sample_rate
            && block_size == o.block_size
            && session_revision == o.session_revision;
    }
};

struct PrearmTargetKeyHash {
    std::size_t operator()(const PrearmTargetKey& k) const noexcept {
        // Cheap mix — collisions are tolerable, we only have ≤8 keys live.
        std::size_t h = std::hash<Id>{}(k.song_id);
        h ^= std::hash<Id>{}(k.target_id) + 0x9e3779b97f4a7c15ULL + (h << 6) + (h >> 2);
        h ^= std::hash<long long>{}(static_cast<long long>(k.timeline_frame))
             + 0x9e3779b97f4a7c15ULL + (h << 6) + (h >> 2);
        h ^= std::hash<std::uint64_t>{}(k.session_revision)
             + 0x9e3779b97f4a7c15ULL + (h << 6) + (h >> 2);
        h ^= std::hash<int>{}(static_cast<int>(k.kind))
             + 0x9e3779b97f4a7c15ULL + (h << 6) + (h >> 2);
        return h;
    }
};

// One prepared voice for one clip belonging to one prearmed target.
struct PreparedTrackVoice {
    Id    clip_id;
    std::shared_ptr<BungeePitchVoice> voice;   // already warmed + prefed
    Frame target_source_frame  = 0;            // source frame matching target_timeline_frame
    bool  ready                = false;        // priming finished without error
};

// A complete prepared set for a single jump target. Either all voices are
// `ready` (the set is `valid`) or the set must NOT be used — partial application
// would desync tracks.
struct PreparedJumpVoiceSet {
    PrearmTargetKey                 key;
    std::vector<PreparedTrackVoice> tracks;
    Frame                           target_timeline_frame = 0;
    bool                            valid                 = false;

    // Convenience: drop into a VoiceMap-shape (clip_id → voice) the caller
    // can hand to BungeeVoiceManager::swap_in_prepared_voices(). Voices are
    // moved out, so calling this consumes the set's `voice` pointers — the
    // set itself becomes unusable afterwards.
    std::unordered_map<Id, std::shared_ptr<BungeePitchVoice>>
    extract_voice_map();
};

class PrearmedJumpManager {
public:
    PrearmedJumpManager();
    ~PrearmedJumpManager();

    PrearmedJumpManager(const PrearmedJumpManager&) = delete;
    PrearmedJumpManager& operator=(const PrearmedJumpManager&) = delete;

    // Configure once at engine init. Same parameters as BungeeVoiceManager —
    // prepared voices must match the active voice configuration so the swap
    // is dimensionally compatible.
    bool prepare(int sample_rate, int channel_count, int max_input_frames);

    // Walk the session and prearm every supported target (markers, region
    // starts, song starts). Idempotent: targets already valid under the
    // current session_revision are skipped; stale targets discarded; new
    // targets built. Runs on the control thread.
    //
    // `session_revision` should be bumped by the caller on any structural
    // session change so this method invalidates the cache appropriately.
    void prepare_all_targets(const Session& session,
                              const SourceManager& sources,
                              std::uint64_t session_revision);

    // Backwards-compat alias for the MVP wiring. Same behaviour as
    // prepare_all_targets — kept so existing call sites and tests don't all
    // have to change in one commit. New callers should use prepare_all_targets.
    void prepare_all_markers(const Session& session,
                              const SourceManager& sources,
                              std::uint64_t session_revision) {
        prepare_all_targets(session, sources, session_revision);
    }

    // Lookup. Returns nullptr if no prepared set exists for the key OR if
    // the set is not valid (any voice not ready). Caller must check the
    // returned pointer's `valid` flag before swapping.
    //
    // `take_ready` removes the set from the map (caller takes ownership and
    // is responsible for the prepared voices' lifetimes via BungeeVoiceManager).
    std::unique_ptr<PreparedJumpVoiceSet>
    take_ready(const PrearmTargetKey& key);

    // Drop everything (e.g. session unload, sample-rate change).
    void clear();

    // Diagnostics counters, safe to read from any thread.
    struct Diagnostics {
        int           ready_count          = 0;
        std::uint64_t prepared_total       = 0; // sets fully prepared
        std::uint64_t prepare_failed_total = 0; // sets where any voice prime failed
        std::uint64_t take_hit_total       = 0; // take_ready returned a valid set
        std::uint64_t take_miss_total      = 0; // take_ready returned nullptr
        std::uint64_t stale_discard_total  = 0; // sets dropped on revision bump
    };
    Diagnostics diagnostics() const noexcept;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace lt
