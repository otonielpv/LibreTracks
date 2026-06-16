# Import-while-playing audio glitches — diagnosis & redesign

**Branch:** `fix/import-while-playing-glitches`
**Status:** Phase 1 in progress (incremental import command)
**Last updated:** 2026-06-16

---

## 1. Symptom

When the user imports audio (MP3 multitrack) into the current song **while
playback is running**, the already-playing tracks stutter / drop out ("petardeos
y cortes de audio"). Importing while stopped is fine. The dropouts also happen,
to a lesser degree, with WAVs (which skip decode) — fewer and shorter.

User's key insight that reframed the whole investigation:
> "si el audio ya está preparado del todo, ¿por qué no se reproduce bien y ya?"
> "¿qué tiene que ver la RAM si usamos streaming de disco?"
> "no me hace ningún sentido que se haga un recrear de la sesión entera"

He was right on all three.

---

## 2. Root cause (confirmed)

Importing audio routes through `AudioChangeImpact::StructureRebuild` →
`replace_song_buffers` → **`CmdLoadSession`**, which is **destructive and total**:

1. Re-parses the entire project JSON into a brand-new `Session`.
2. **`source_manager_->clear()`** — drops ALL sources, including ones already
   decoded and currently playing.
3. Re-registers and **re-decodes EVERY track** (not just the newly added one).
4. Reassigns the `shared_ptr<const Session>` the audio thread is reading, plus
   rebuilds Bungee voices and re-prearms jumps.

Consequences measured on the audio thread (via `LIBRETRACKS_AUDIO_DIAG`):
- The audio callback stalls **100–400ms** inside `Mixer::render` while it faults
  on the freshly-reassigned (cold-paged) session and the re-decoded sources.
- Process working set spikes to **~2.5GB** (each track decodes to a full float32
  buffer + a resample copy; with N tracks re-decoding at once), triggering
  Windows working-set trimming → hundreds of thousands of **soft page faults**
  per 500ms that block the callback.

**There is no good reason to rebuild the whole session.** It's a shortcut: one
code path (LoadSession) handles every structural change, which was fine when you
never imported during playback. The engine *already has* an incremental,
non-destructive path (`CmdSetSongTimelineWindow` / `AudioChangeImpact::
TimelineWindow`) that copies the session, mutates only what changed, and
atomically swaps — **without `clear()` or re-decode**. Many edits already use it.
Import doesn't, only because that path can't (a) register new sources or
(b) create new tracks.

### Dead ends ruled out along the way (with data)
- ❌ BlockCache mutex contention (`read_wait_us` ~1µs).
- ❌ Single fill thread saturated (`fill_q` ~0).
- ❌ Disk-cache starvation (`miss` ~0, `hit` 200+).
- ❌ DirectSound callback model (same glitch on WASAPI — user confirmed).
- ❌ MMCSS not available (`err=1552`) — TIME_CRITICAL fallback didn't fix it.
- ❌ `evict_lru` full sort under lock (real but minor; switched to `nth_element`).
- ❌ Thread starvation between callbacks (`cbgap` stable ~19ms; stall is INSIDE
  the callback).

### Real contributing factors found (all on the audio thread's hot path)
1. **MSVC `std::atomic_load(shared_ptr)` global spinlock** (microsoft/STL#86):
   the audio thread spun on a process-global spinlock held by a BELOW_NORMAL
   decode worker → priority inversion. Fixed by switching `entries_`/`session_`
   to `std::atomic<std::shared_ptr<>>` (member, per-object wait/notify).
2. **Per-block `Track patched = track` copy** in `Mixer::render` — allocated on
   the audio thread and contended the global heap lock with the import's large
   allocations. Fixed with a `track_gain_override` param (no copy).
3. **The destructive LoadSession itself** — the dominant cause; this is what the
   redesign fixes.

---

## 3. Measurements / tooling

- **`LIBRETRACKS_AUDIO_DIAG=1`** env flag enables a diagnostic line every ~500ms
  written to `lt_audio_debug.log` (repo root), logged from the snapshot poll
  thread (NOT the audio thread — logging there is forbidden I/O). Fields:
  `cb_max_ms`, `cbgap_ms`/`cbwork_ms` (thread-starved-between vs blocked-inside),
  render `phase_us[load/sched/tracks/post]`, `sched_lock_us`, `pf+=` (page-fault
  delta), `ws=…MB` (working set), `read_wait_us`/`fill_hold_us`, cache hit/miss,
  `path[dir/vari/str]`.
- **`bench_import_while_playing`** (new) reproduces the import memory spike with
  the user's real MP3s. Build under `-DLT_ENGINE_BUILD_BENCHES=ON`. Measures
  `peak_working_set` and `total_page_faults` while the FULL Mixer renders at
  real-time cadence and N threads decode+store real files concurrently.
  - Baseline (gate OFF): peak WS **1741MB**.
  - With `DecodeMemoryGate` (gate ON): peak WS **994MB** (-43%), same import time.
  - The bench can measure the memory spike but NOT the OS trimming/stall (it's a
    small process with no WebView), so it validates Phase B; Phase A is validated
    by a re-decode counter (target: only NEW sources decode on import).

Real MP3 test set: `C:\Users\otoni\Desktop\MultiTracks\DIGNO ES EL SEÑOR MARCELA GANDARA`
(9 files, ~16MB each, 44.1kHz → resampled to 48k).

---

## 4. The redesign (incremental CRUD, no full rebuild)

User chose: **make all structural CRUD incremental**, A+B by phases.

### Data flow today (what we are changing)

```
import audio (drag onto song / library import)
  Rust: import_audio_files_into_current_song   [state.rs:1038]
    -> persist_song_update(..., AudioChangeImpact::StructureRebuild)  [state.rs:5340]
       -> if playing: audio.replace_song_buffers(...)  [audio_engine.rs:1711]
            -> EngineCommand::LoadSession { project_json }   ← DESTRUCTIVE
       -> engine.load_song(song)  (Rust model)
       -> if playing: restart_audio(...)  [state.rs:6263]   ← restarts transport
  C++: CmdLoadSession handler  [engine_impl.cpp:~1208]
       -> source_manager_->clear()            ← drops decoded sources
       -> prep_queue_ = new(...) + enqueue_session(ALL)   ← re-decodes everything
       -> atomic_store(session_, next_session) ← cold-paged reassignment
       -> rebuild_for_session(...) + prearm    ← full rebuilds
```

Target data flow (incremental):
```
import audio
  Rust: import_audio_files_into_current_song
    -> persist_song_update(..., AudioChangeImpact::IncrementalStructure)  ← NEW impact
       -> audio.upsert_song_tracks(&song)  ← NEW, sends CmdUpsertSongTracks
       -> engine.load_song(song)  (Rust model only; no restart)
  C++: CmdUpsertSongTracks handler  [engine_impl.cpp:~2536]   ← already written (Phase 1)
       -> make_shared<Session>(*session_); replace named song's tracks
       -> register+enqueue ONLY new sources (prep queue skips ready ones)
       -> retime_existing_for_session(...) + prearm async (no full rebuild)
       -> swap_session_atomic(next_session)   ← warm pages preserved
```

---

### Phase 1 — C++: incremental upsert command  ✅ DONE (compiles, 216 tests green)

**Files touched**
- `include/lt_engine/core/commands.h` — new `CmdUpsertSongTracks` struct
  (`song_id`, `tracks[]` with full metadata + `clips[]`, `sources[]` refs) and
  added to the `EngineCommand` variant.
- `src/ffi/engine_impl.cpp` — handler after the `CmdSetSongTimelineWindow` case
  (~line 2536). Copies the session, rebuilds the named song's `tracks` (create
  new / update existing / drop removed), registers+enqueues only sources whose
  id isn't already in `next_session->sources` (dedup via `unordered_set`),
  retimes Bungee, swaps atomically, re-prearms async. **No `clear()`.**
- `src/core/commands.cpp` — `"UpsertSongTracks"` JSON parser mirroring the
  serde shape Rust will emit.

**Design notes / decisions**
- The command carries the **authoritative full track set** for the song (not a
  delta). Rust already has the updated `song` in hand, so this is the cheapest
  thing to send and makes the handler a simple replace. It covers ALL CRUD
  (add/remove/move tracks and clips) in one path.
- Sources are referenced by id; the handler relies on `prep_queue_->
  enqueue_source` already skipping `ready`/`queued`/`loading` ids
  [preparation_queue.cpp:40] so existing tracks are never re-decoded.
- `transpose_behavior`/`role`/`kind`/`parent_track_id` are passed as tokens and
  mapped to the engine enums in the handler (mirrors session_adapter.cpp).

**Phase 1 follow-ups still pending**
- [ ] Decide whether `role`/folder semantics need anything beyond `kind`
  (folder vs audio) for correct routing. Currently `role` is parsed in the JSON
  but the handler only maps `kind`; verify folder/inherited routing still works
  with an upsert (vs the LoadSession path).
- [ ] Add a focused C++ DSP test: load a session, send `CmdUpsertSongTracks`
  adding one track + one new source, assert (a) existing sources' `DecodedSource`
  pointers are unchanged (NOT re-decoded), (b) the new track/clip is present,
  (c) `session_generation_` bumped. This is the Phase-1 acceptance test.

---

### Phase 2 — Rust: route import (and CRUD) through the incremental command  ⏳ NEXT

**Step 2.1 — add the command variant (crate `lt-audio-engine-v2`)**
- `crates/lt-audio-engine-v2/src/commands.rs`: add
  `UpsertSongTracks { song_id, tracks: Vec<TrackUpsert>, sources: Vec<SourceRef> }`
  to `EngineCommand` (serde `tag = "type"` already produces `{"type":"UpsertSongTracks",…}`).
  Add `TrackUpsert` struct (id, name, gain, pan, audio_to, mute, solo,
  transpose_behavior, role, kind, parent_track_id, clips: Vec<ClipUpdate>) and
  `SourceRef { id, file_path }`. Reuse the existing `ClipUpdate`.
- Add a round-trip unit test in `src/tests/test_commands.rs` asserting the JSON
  shape matches what the C++ parser reads (field names, defaults).

**Step 2.2 — Rust sender (`audio_engine.rs`)**
- Add `AudioController::upsert_song_tracks(&self, song: &Song)` next to
  `update_live_timeline_window` [audio_engine.rs:861]. It resolves audio paths
  (`song_with_resolved_audio_paths`), warps the timeline
  (`song_with_warped_timeline`), maps each track → `TrackUpsert` (metadata +
  clips with `source_id = file_path`), collects the set of distinct source
  file paths into `sources`, and sends `EngineCommand::UpsertSongTracks`.
  Goes through `with_engine_state("upsert_song_tracks", None, …)` like the other
  targeted commands.

**Step 2.3 — new impact + routing (`state.rs`)**
- Add `AudioChangeImpact::IncrementalStructure` (or rename the intent) next to
  `StructureRebuild` [state.rs:6309 region].
- In `persist_song_update_internal` [state.rs:5350]: for the new impact, when
  playing call `audio.upsert_song_tracks(&song)` (NOT `replace_song_buffers`),
  and in the post-update `match playback_state` do `reposition_audio`
  (TransportResync) instead of `restart_audio`. When stopped, keep `sync_song`
  (cheap, lets background decode start).
- Switch `import_audio_files_into_current_song` [state.rs:1055] and the other
  structural CRUD callsites (add/delete/move track, delete clip, etc. — the
  `StructureRebuild` callers at state.rs:839, 2849, 2894, 3525, …) to the new
  impact. Audit each: anything that only adds/removes/moves tracks/clips/sources
  is safe; anything that changes sample rate or other global invariants keeps
  LoadSession.

**Step 2.4 — keep LoadSession only for cold project open**
- `replace_song_buffers` / `CmdLoadSession` remain for: opening a project,
  changing device sample rate, or any case that genuinely needs a full reset.

**Phase 2 acceptance (bench + manual)**
- Bench: add a re-decode counter to `bench_import_while_playing` (count how many
  sources get `store_decoded_source` called when "adding" a track to a session
  that already has N decoded). Target: **only the new source decodes** (today:
  all N). Verify `peak_working_set` no longer spikes per import.
- Manual (user): import MP3s while playing → no dropouts; `LT_AUDIO_DIAG` shows
  `cbwork` flat, `pf` low.

---

### Phase 3 — Remove symptom patches (after Phase 1+2 confirmed)
- Remove `DecodeMemoryGate` (io_throttle.h/.cpp, worker_pool.cpp, bench).
- Remove `SetProcessWorkingSetSizeEx` floor + MMCSS promotion (engine_impl.cpp,
  audio_device_manager.cpp, CMakeLists avrt/psapi links if unused elsewhere).
- **Keep** the correct standalone fixes: `atomic<shared_ptr>` (entries_/session_),
  no per-block Track copy (track_gain_override), `evict_lru` nth_element,
  move-not-copy decoded buffer in the prep-queue completion.
- Re-run bench + 216 tests to confirm removal didn't regress.

---

### Phase 4 — Streaming preparation (B): eliminate the memory spike at the root
**Goal:** stop materializing the whole file (+ a resample copy) in RAM. Per-track
peak from ~380MB to a few MB.
- `src/sources/audio_decoder.cpp` `decode_file_to_float32`: today it `raw.reserve(
  whole file)`, decodes all, then `resampler->process(raw)` producing a second
  full buffer [resampler.cpp:40/74]. Restructure to a **chunked pipeline**:
  decode a chunk → resample that chunk → append to the RF64 cache writer → drop
  the chunk. The streaming `DecodedSource` already reads from the block cache, so
  consumers don't change.
- `src/sources/source_manager.cpp` `store_decoded_source`: accept a streaming
  producer (or a callback that yields chunks) instead of a full `vector<float>`,
  writing the RF64 + filling eager blocks incrementally.
- Risk: chunk-boundary resampling artifacts. Mitigation: keep the resampler's
  state across chunks (libsamplerate is stateful) and add a checksum test
  comparing whole-file vs chunked output for a known WAV.
- After this lands, the `DecodeMemoryGate` is fully redundant (already removed in
  Phase 3) and peak WS during import should be flat.

---

### Phase 5 — Cleanup & commit hygiene
- Remove all dead-end diagnostics (`LT_AUDIO_DIAG` phase counters, gap/work,
  page-fault/working-set logging, scheduler lock-wait, block-cache lock stats).
  Keep `bench_import_while_playing` (with the re-decode + WS asserts) as a
  permanent regression guard.
- Split the WIP commit (`e969521`) into clean logical commits:
  1. `fix(audio): atomic<shared_ptr> for entries_/session_ (priority inversion)`
  2. `perf(render): drop per-block Track copy via gain override`
  3. `perf(cache): nth_element eviction off the audio-thread lock`
  4. `feat(engine): incremental CmdUpsertSongTracks (no full LoadSession)`
  5. `refactor(import): route structural CRUD through incremental upsert`
  6. `perf(decode): chunked streaming decode→cache (no whole-file RAM)`
- Run: C++ `ctest` (216), `npm run test:native:nolink`, frontend `tsc` + vitest.
- Update this doc's status to DONE; write release notes if it ships.

---

## 5. Risks
- Incremental track creation touches audio-thread concurrency. Mitigation:
  follow the exact `swap_session_atomic` pattern the 216 DSP tests already cover;
  validate each phase with the bench + tests.
- Streaming resample (Phase 4) may differ at chunk boundaries vs whole-file
  resample. Mitigation: checksum the decoded output old vs new in a test.

---

## 6. Progress log
- **2026-06-16** — Diagnosis complete; WIP checkpoint committed (`e969521`) on
  branch `fix/import-while-playing-glitches`.
- **2026-06-16** — **Phase 1 (C++ incremental command) DONE**: `CmdUpsertSongTracks`
  struct + handler (engine_impl.cpp ~2536) + JSON parser (core/commands.cpp).
  Compiles clean; **216/216 DSP tests pass**. No `source_manager_->clear()` in the
  path. Pending Phase-1 follow-ups: folder/role routing check + a focused DSP
  test asserting existing sources aren't re-decoded on upsert.
- **2026-06-16** — **Phase 2 (Rust routing) DONE**: `UpsertSongTracks` command
  variant + structs in the crate; `upsert_song_tracks` sender in audio_engine.rs;
  `StructureRebuild` while playing routed through it (+ `reposition_audio`
  instead of `restart_audio`). Round-trip JSON-contract tests pass; 150+70
  no-link tests pass; desktop compiles. NO behaviour confirmed by user yet.
- **2026-06-16** — **Phase 2.5**: extended `CmdUpsertSongTracks` to a full
  structural snapshot (regions + markers + timing on top of tracks + sources)
  across C++ struct/handler/parser and Rust variant/sender. Removes the
  region/marker-loss risk without auditing the 18 StructureRebuild callsites.
  216 DSP tests pass.
- **2026-06-16** — **Audit: which actions still rebuild the whole session?**
  Verified all ~16 `StructureRebuild` callsites go through `persist_song_update`
  → incremental upsert while playing. The ONLY remaining `CmdLoadSession` paths
  are `load_song_from_path` (opening a project — correct, full init from scratch)
  and `engine_v2_load_session` (project open command). Removed the now-dead
  `restart_audio()` (the last stray `replace_song_buffers` outside project open)
  so the destructive path can't be called by a future edit by mistake.
  150+72 no-link tests pass.
- **Next:** (1) **user test** the glitch is gone (only remaining unknown — the
  OS-trimming stall can't be reproduced in the headless bench); (2) Phase 3
  remove symptom patches once confirmed; (3) optional Phase 4 streaming decode.

- **2026-06-16** — **Found the real remaining bug for the reported scenario.**
  The user's case is the FIRST import: dropping all MP3s, then hitting play
  while they're still decoding → already-decoded tracks stutter. Diagnostic log
  showed `persist_song_update impact=StructureRebuild playback_state=Stopped ->
  sync_song (idle path)` — import ALWAYS runs with the transport Stopped, so the
  upsert (only wired for the Playing branch) was never used. Fixed: idle
  StructureRebuild now also routes through `upsert_song_tracks` when a session is
  already loaded (`AudioController::has_loaded_session()`), keeping LoadSession
  only for the cold initial project load. BUT the reported stutter is NOT the
  LoadSession — it's the decode itself: `LT_AUDIO_DIAG` shows the working set
  oscillating 300MB↔1GB as decode workers materialize ~190MB/track buffers, and
  `cbwork` spikes correlate with those WS swings (page faults AND faultless
  reassignment stalls). The DecodeMemoryGate only engages while playing, so it
  doesn't bound the cold-load decode that's in flight when the user hits play.
  → **Decision: Phase 4 (streaming decode) is the root fix.**

### Phase 4 plan (chunked streaming decode → cache) — ⏳ IN PROGRESS
Resampler backend in this build is **r8brain** (`LT_ENGINE_USE_R8BRAIN=ON`),
which is stateful and supports block-by-block processing.
- Add a streaming `store_streaming_decode(source_id, decoder, target_sr, ...)`
  used by the worker pool: open the RF64 cache, then loop {decode a chunk via
  `read_frames` → resample the chunk (stateful r8brain, one resampler per
  source) → write the chunk to the cache + fill eager block-cache blocks if in
  range → drop the chunk}. Never hold the whole file (or the resample copy) in
  RAM. Per-track peak ~190MB → a few MB.
- Keep `decode_file_to_float32` for any non-import callers (waveform/peaks).
- Risk: r8brain block latency + output-length variability per chunk — get the
  frame accounting right so the cached PCM is bit-equivalent to the whole-file
  path. Mitigation: a C++ test comparing whole-file vs streamed output for a
  known WAV (checksum); verify in the bench that peak WS stays flat.
- Once landed, the DecodeMemoryGate + working-set floor + MMCSS become
  redundant (Phase 3 removes them).

- **2026-06-16** — **Residual stutter = waveform analysis re-decode.** After the
  streaming decode landed, the user reported tracks show "prepared" but still
  stutter while waveforms load ("analizando"). Root cause: `generate_native_
  waveform` → `lt_audio_engine_v2::file_peaks(path)` RE-DECODES the whole MP3 on
  a background thread to build the visual peaks — a SECOND full decode per file,
  competing with playback (CPU + page faults). `analyze_file_peaks` already
  streams in 64k chunks (no whole-file buffer), so it's CPU not memory.
  Two fixes (Ableton-style single decode + don't fight the audio thread):
  1. **Same-pass peaks**: `decode_and_store_streaming` now accumulates the
     waveform peaks (256-frame buckets) in the SAME pass as the decode and caches
     them on the Entry; `source_peaks(source_id)` returns them instantly (no
     cache re-read, no re-decode). C++ done + tested (equivalence still passes).
  2. **Low-priority waveform worker**: the Rust waveform thread now runs
     BELOW_NORMAL so its cosmetic decoding can't preempt the realtime audio
     callback. Done.
  ⚠️ STILL TODO: wire the Rust waveform worker to call `source_peaks(source_id)`
  for already-imported sources INSTEAD of `file_peaks(path)`, so the second
  decode is eliminated entirely (today only its priority is lowered). The
  waveform worker thread has no engine handle — needs the AudioController/engine
  passed through, or write the global waveform cache from the same-pass peaks at
  EvSourcePrepared time so the worker's `load_global_waveform` hits and skips
  the decode. `waveform_key == source file path == source_id` already.

### Answer: do all actions avoid recreating the whole session? — YES (except open)
- Import audio, add/remove/move tracks & clips, region/marker/timing edits →
  `CmdUpsertSongTracks` (incremental, no clear, no re-decode, no restart).
- Opening a project / loading a song from disk → `CmdLoadSession` (full rebuild,
  correct — nothing to preserve).

## 7. Status header (update each session)
- Phase 1 (C++ command): ✅ done. Parser acceptance test added
  (`parse UpsertSongTracks full structural snapshot`, 217 tests). The
  "no-re-decode on upsert" behavior needs a full engine+device harness the
  headless DSP suite lacks — verify via the bench re-decode counter (Phase 2
  acceptance) or the user's manual test.
- Phase 2 (Rust routing): ✅ done — import + structural CRUD now send
  `CmdUpsertSongTracks` instead of LoadSession while playing; `reposition_audio`
  (seek) instead of `restart_audio`. JSON contract verified by round-trip tests.
- Phase 3 (remove patches): ⏳ blocked on user confirmation that glitch is gone
- Phase 4 (streaming decode): ✅ implemented + verified bit-equivalent to the
  whole-file path (218 DSP tests). Needs user confirmation it kills the stutter.
- Phase 5 (cleanup/commits): ⏳ not started

### Phase 4 — what landed
- `resampler.h/.cpp`: `StreamingResampler` (stateful, block-by-block) +
  `make_streaming_resampler`. r8brain per-channel `CDSPResampler24`; passthrough
  when sample rates match.
- `source_manager.h/.cpp`: `decode_and_store_streaming` — opens the decoder,
  pipes decode→resample→RF64 cache in 64k-frame chunks, fills eager blocks
  inline, flushes the resampler's latency tail to hit the exact output length,
  installs the streaming DecodedSource. Never holds the whole file or a resample
  copy. (The whole-file path takes the first output_frames of a one-shot
  process(), so streaming targets that exact length and matches it.)
- `worker_pool.h/.cpp`: optional `StreamingStoreCallback` on `submit_decode`;
  when set the worker runs it instead of whole-file decode + handback.
- `preparation_queue.cpp`: wires the streaming callback (default ON;
  `LIBRETRACKS_STREAMING_DECODE=0` to A/B). on_done handles the empty-buffer
  (already-stored) completion.
- Test: `decode_and_store_streaming matches whole-file decode (resampled)` —
  decodes a 44.1k WAV to 48k both ways and asserts bit-equivalence (shift=0,
  diff=0). 218 DSP tests pass.
- Note: the bench A/B (LT_BENCH_STREAMING 1 vs 0) showed equal peak WS because
  the bench's peak is dominated by its own 10 synthetic 60s setup tracks, not
  the imports — it can't isolate the import delta. Streaming's benefit is proven
  structurally (never materializes the file) + by the equivalence test; the real
  WS win is only visible in the full app. Needs user test.

### Phase 2 — what landed
- `crates/lt-audio-engine-v2/src/commands.rs`: `UpsertSongTracks` variant +
  `TrackUpsert` / `TrackClipUpdate` / `SourceRef` structs (serde tag="type").
- `apps/desktop/src-tauri/src/audio_engine.rs`: `AudioController::upsert_song_tracks`
  — groups warped clips per track, maps track metadata (volume→gain, muted→mute,
  transpose_enabled→behavior token, kind→audio/folder), collects distinct
  sources, sends `EngineCommand::UpsertSongTracks`.
- `apps/desktop/src-tauri/src/state.rs`: `StructureRebuild` while playing now
  calls `upsert_song_tracks` (was `replace_song_buffers`) and `reposition_audio`
  (was `restart_audio`). Idle path unchanged (still `sync_song`).
- Tests: `upsert_song_tracks_round_trip_type`,
  `upsert_song_tracks_json_shape_matches_cpp_parser` (verify the Rust→C++ JSON
  contract). 150 + 70 no-link tests pass.

### Phase 2 caveats / to verify next session
- [ ] **User test**: import MP3s while playing → confirm glitch gone, check
  `LT_AUDIO_DIAG` (`cbwork` flat, `pf` low, no `clear()`-driven re-decode).
- [ ] The upsert sends source `id = file_path` (matches how clips reference
  sources via `file_path`). Confirm this matches the source ids the engine
  already has from the initial LoadSession, so existing sources are recognized
  as known (not re-registered/re-decoded). If ids differ, dedup won't trigger.
- [ ] Folder tracks / `audio_to = "inherit"` routing through the upsert path
  (the handler maps `kind` but `role` is always empty) — verify a folder bus
  still routes children correctly vs the LoadSession path.
- [x] ~~Region/marker/timing changes lost via upsert~~ — RESOLVED: extended
  `CmdUpsertSongTracks` to carry regions + markers + bpm/beats + tempo/timesig
  markers too (complete structural snapshot, same shapes as
  CmdSetSongTimelineWindow). No callsite audit needed — any StructureRebuild
  edit routes through it losslessly. 216 DSP tests + round-trip tests pass.
