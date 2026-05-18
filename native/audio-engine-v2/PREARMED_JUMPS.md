# Prearmed Jumps — Branch Summary

Branch: `feature/prearmed-jumps-mvp` (off `c++_audio_engine`).

## Goal

Near-instant pitch-shifted audio after predictable musical jumps (markers, regions, song starts). Eliminate both:
1. The ~80 ms control-thread cost of `BungeeVoiceManager::rebuild_for_seek` on every seek.
2. The ~85 ms structural Bungee latency window that produces silence after a cold seek.

## What ships on this branch

| Phase | Commit | Status |
|---|---|---|
| 1 MVP (scaffold) | `7225b88` | done |
| MVP (wiring + 4 tests) | `d288048` | done |
| 2A real-audio prefeed | `a0e3b07` | done |
| 1 ext (Region + Song targets) | `636393d` | done |
| 6 (pitch/device revisions) | `5b91546` | done |
| 7 (max_prepared_targets cap + FIFO eviction) | `de07b93` | done |
| 8 (diagnostics in EngineSnapshot) | `e2ef1d3` | done |
| 9 ext (device-reconfigure + rapid-jumps tests) | `0eea42d` | done |
| 2 (async worker thread) | `3480291` | done |
| 10 (prearm-vs-reactive benchmark) | `9aff527` | done |
| 6b (sync prepare-one for first-jump-after-change) | `23c75f2` | done |

## Architecture

```
COMMAND THREAD                                  WORKER THREAD                  AUDIO THREAD
──────────────                                  ─────────────                  ────────────
CmdLoadSession
  └─ prearm_revision_++
  └─ prearmed_jumps_                  ──post──► prepare_all_targets
       ->prepare_all_targets_async              (per target/clip:
                                                  configure voice
                                                  warm_voice_silence
                                                  prefeed real audio
                                                  arm_fade_in
                                                  store in prepared_map
                                                  FIFO-evict if over cap)

CmdJumpToMarker (or Region / Song)
  └─ build PrearmTargetKey
  └─ prearmed_jumps_->take_ready(key)
        ├─ HIT  ─► bvm.swap_in_prepared_voices ─atomic_store─► next voice_for()
        │         clock_->seek(target_frame)                    sees new map
        │         return                                        ↓
        │                                                        first render_block
        │                                                        emits target audio
        └─ MISS ─► prepare_target_now(this key)  [Phase 6b: ~13ms sync]
                ├─ HIT (built) ─► swap + seek + return (~13ms cost, instant audio)
                └─ MISS ─► bvm.rebuild_for_seek (sync)
                           scheduler->schedule_immediate (legacy fallback)

CmdSetSongTranspose / CmdSetRegionTranspose / CmdSetTrackTransposeEnabled
  └─ prearm_revision_++
  └─ prearmed_jumps_->prepare_all_targets_async (revision invalidates cache)

CmdSetOutputDevice / CmdSetSampleRate / CmdSetBufferSize
  └─ prearmed_jumps_->clear()
  └─ prearmed_jumps_->prepare(new_sr, new_bs)  (clears + reconfigures dims)
```

## Benchmark numbers

`bench_prearm_vs_reactive` (Debug, 480-frame block, 9 voices, hop=-1):

| Path | User-visible jump cost | First audible block | Silence the listener hears |
|---|---|---|---|
| Reactive (today) | 51 ms (synchronous `rebuild_for_seek`) | block 8 (~80 ms latency) | ~131 ms |
| Prearmed cache hit | <1 ms (atomic swap) | block 0 (prefeed delivered) | ~0 ms |
| Prearmed cache miss + sync prepare-one (Phase 6b) | ~13 ms (prepare 1 target) | block 0 (prefeed delivered) | ~13 ms |

Prearm build cost (paid ONCE at LoadSession, on worker thread): ~119 ms for 9 voices × 1 marker target.

**Why three rows**: the async worker is the common case. The middle row (cache hit) is what you get when the worker has had time to build the target. The bottom row (Phase 6b) covers the edge case where the user triggers a jump immediately after a pitch change, before the async worker repopulates the cache — sync prepare-one for THIS one target still beats the reactive path by ~4× and still emits audio in block 0 (prefeed always runs).

## Files

### New
- `include/lt_engine/pitch/prearmed_jump_manager.h` — manager API
- `src/pitch/prearmed_jump_manager.cpp` — implementation
- `tests/prearmed_jump_tests.cpp` — 13 tests, all pass
- `bench/bench_prearm_vs_reactive.cpp` — Phase 10 benchmark
- `PREARMED_JUMPS.md` — this doc

### Modified
- `include/lt_engine/pitch/bungee_voice_manager.h` — added `swap_in_prepared_voices`
- `src/pitch/bungee_voice_manager.cpp` — atomic swap impl (same publish pattern as rebuild)
- `src/pitch/CMakeLists.txt` — added prearm source
- `include/lt_engine/engine_impl.h` — owns `prearmed_jumps_` + `prearm_revision_`
- `src/ffi/engine_impl.cpp` — async prearm at all 4 invalidation sites + prearm-fast-path at all 3 jump kinds
- `include/lt_engine/core/snapshot.h` — added `prearmed_jumps` field
- `src/core/snapshot.cpp` — JSON serialisation
- `tests/CMakeLists.txt` — added test file
- `CMakeLists.txt` — bench target

## Diagnostics surfaced in EngineSnapshot

```json
"prearmed_jumps": {
  "ready_count": int,            // live prepared-set count
  "prepared_total": uint64,      // sets fully prepared since init
  "prepare_failed_total": uint64,// sets where any voice prime failed
  "take_hit_total": uint64,      // prearm fast path hit count
  "take_miss_total": uint64,     // prearm fast path miss → fallback rebuild
  "stale_discard_total": uint64, // sets dropped on revision bump
  "eviction_total": uint64,      // sets evicted by Phase 7 cap
  "max_prepared_targets": int    // current cap value
}
```

## Env flags

- `LIBRETRACKS_PREARM_LOG=1` — verbose logging: target prepared / prepare_failed / revision_changed / eviction / worker_start / worker_done
- `LIBRETRACKS_PREARM_MAX_TARGETS=N` — override default cap (8)

## Test coverage (13 cases, all pass)

1. Prepared marker jump produces audio after warmup (silence-warm path)
2. Prepared jump preserves alignment with unpitched track (silence-warm path)
3. take_ready rejects invalid set (transactional)
4. Fallback path renders audio when prearm missed
5. Prefeed: first post-jump block emits audio
6. Prefeed: pitched click onset aligned within 32 samples of unpitched
7. Region + Song targets prearmed alongside markers
8. Async: prepare_all_targets_async completes off-thread
9. Eviction: max_prepared_targets evicts oldest (FIFO)
10. Revision bump invalidates stale prepared sets
11. clear() drops all prepared sets
12. prepare() with new dims clears stale voices (device-change flow)
13. Rapid prepare+take cycles are safe (smoke test for ABA/double-free)
14. **prepare_target_now builds one set immediately** (Phase 6b sync miss path)

## Known limitations

1. **No vamps yet** (Phase 5 deferred). See "Why vamps are deferred" below.
2. **No priority scoring on eviction.** Spec proposes a weighted score (current vamp wrap, next region, MIDI-mapped > others); current impl is plain FIFO. Adequate for ≤8 targets per the default cap.
3. **No per-target memory accounting.** Cap is by set count, not MB. At ~2 MB / voice × 9 voices × 8 sets = ~144 MB max.
4. **Single combined `prearm_revision_`** rather than the spec's 5 separate revisions. Over-invalidates in edge cases (e.g. region transpose change clears unrelated song's marker sets). Acceptable since prearming is async and cheap.
5. **`take_ready` is a CONSUMING op.** A prepared set can only be used once. If the user double-triggers the same marker jump in rapid succession, the second jump misses and falls back to reactive rebuild. The next prearm pass repopulates.
6. **No frontend UI integration.** Diagnostics are in the snapshot but no Settings panel reads them yet.
7. **Bench is Debug-build.** Real numbers in Release will be smaller across the board; the relative win (prearmed faster than reactive) holds.

## What was deferred per the no-manual-test scope

- **Phase 5: Vamps** — see below.
- **Phase 11: UI/remote integration** — frontend changes need Tauri running.
- **Phase 12: Manual QA** — by definition manual.

## Why vamps are deferred

A vamp is a *loop region*. The transport plays from `vamp_start` to `vamp_end`,
then wraps back to `vamp_start` and plays again. The "jump" happens
automatically on every wrap, not on user input.

The MVP infrastructure (`PrearmedJumpManager`, `swap_in_prepared_voices`,
prefeed) all transfers directly. What's NEW for vamps is the lifecycle pattern:

```
Marker:  prepare ahead → user triggers jump → take_ready (consumes) → done
Vamp:    prepare ahead → transport wraps (auto) → take_ready (consumes)
         → IMMEDIATELY post a new prepare for next wrap
         → loop continues, repeat
```

What I want manual validation for before shipping vamps:

- **Wrap timing**: the wrap is triggered by the audio thread (transport
  reaches vamp_end). The swap has to happen in the SAME audio block as the
  wrap or you hear a one-block gap. Hard to validate without listening.
- **Re-prearm on wrap**: posting a new prepare from the audio thread is
  forbidden (allocates). Has to route through the command thread or a
  lock-free signal. Adds non-trivial complexity.
- **Loop drift**: 10 vamp wraps should produce sample-aligned audio. Easy to
  introduce a 1-sample drift per wrap that compounds. Detectable only with
  careful listening / FFT analysis.

Estimated effort once you can manual-test: ~4-6 hours implementation +
~2 hours debugging the wrap timing on real audio. The existing 14 tests
will all still pass; vamps need their own 3-4 tests.

## Why first-jump-after-pitch-change isn't silent (Phase 6b)

This was a real gap the user spotted. The flow that USED to happen:

1. `CmdSetSongTranspose` bumps `prearm_revision_` and posts the new revision
   to the async worker. Cache is invalidated.
2. User triggers a jump BEFORE the worker finishes (worker takes ~120ms for
   9 voices).
3. `take_ready(new_revision_key)` misses (worker hasn't inserted yet).
4. Falls back to `rebuild_for_seek` (51ms) + audio thread structural latency
   (80ms) = ~131ms silence. The whole point of prearming is defeated for
   this one jump.

Phase 6b adds `prepare_target_now`: a synchronous fast path that builds
ONE target's prepared set on the command thread (~13ms for 1 marker × 9
voices). The jump handler now does:

```
take_ready hit            → swap + seek + return  (no silence)
take_ready miss:
  prepare_target_now hit  → swap + seek + return  (~13ms, no silence)
  prepare_target_now miss → reactive rebuild      (legacy fallback)
```

The user-visible cost is now ~13ms instead of ~131ms for that edge case.
Subsequent jumps to other targets still hit the async cache as it
finishes building in the background.

`prepare_target_now` does NOT insert the set into the cache — it's a
one-shot consumed-immediately call. The async worker continues to populate
the cache in the background, so later jumps to the same marker hit the
fast path.

## Validation

14 prearm + 2 Bungee voice tests = 16 pass on `--test-case="PrearmedJump*,BungeeVoiceManager*,BungeePitchVoice*"`. No regression in prior passing tests.

Bench validates the architecture: prepared marker jumps deliver audio in block 0 at 9 voices, vs reactive's block 8.
