# Audio Runtime Ownership Contract

This document defines the authoritative boundary between Rust/Tauri and C++ for all
live audio runtime responsibilities. Any code that violates these rules is wrong by
definition — fix it, not this document.

> **Implementation status**: All phases complete (original 13 + second pass).
> Phase 1: this document. Phase 2/3: `Mixer::set_session(preserve_realtime_state)`,
> `sync_live_mix` removed from `persist_song_update_internal`.
> Phase 4: `AudioChangeImpact::MixerOnly` skips `LoadSession` when C++ already has state.
> Phase 5: `ensure_live_track` removed; `set_track_transpose_enabled_realtime` added;
> transpose toggle and region transpose now use `MixerOnly` + dedicated realtime command.
> Phase 6: folder/group hierarchy enforced as C++-only.
> Phase 7: Rust pitch-decision invariant documented.
> Phase 8: Fail-fast pitch backend confirmed.
> Phase 9: Section marker CRUD promoted to `MixerOnly`.
> Phase 10: `get_ownership_diagnostics` Tauri command added.
> Phase 11: 5 unit tests (section marker + transpose paths).
> Phase 12: Incremental migration.
> Phase 13: Manual validation checklist — see Section 11 below.
>
> **Second pass (strict thin-bridge enforcement)**:
> - `sync_live_mix` quarantined → renamed `legacy_sync_live_mix_for_session_load_only`;
>   made `pub(crate)`; accepts `LegacySyncReason` param; `legacy_sync_live_mix_count` counter.
> - `update_track_mix_live` Tauri command and `Session::update_track_mix_live` method removed.
>   `RemoteCommand::UpdateTrackMixLive` now calls `audio.update_live_track_mix` directly.
>   Frontend API `updateTrackMixLive` deleted from `desktopApi.ts`.
> - `Session::update_track_name_only` added for name-only changes (no audio command sent).
> - `AudioController::session_rebuild_count` counter added; incremented in `replace_song_buffers`.
>   `replace_song_buffers` now accepts a `reason: &str` arg recorded as `last_session_rebuild_reason`.
> - `RuntimeUpdateKind` enum added to `state.rs` — documents the A/B/C taxonomy in code.
> - `OwnershipDiagnostics` updated: `sync_live_mix_count` → `legacy_sync_live_mix_count`,
>   `session_rebuild_count`, `last_session_rebuild_reason` added.
> - 11 new unit tests covering: bridge-only invariants, commit paths, undo grouping,
>   name-only changes, legacy-sync counter, session_rebuild_count, folder track paths.
> - All test assertions updated to new field names.

---

## 1. What Rust/Tauri Owns

| Responsibility | Notes |
|---|---|
| Project model (Song, Track, Clip, Region) | Persisted state; source of truth for save/load/undo |
| User preferences and settings | Device selection, buffer size, sample rate |
| UI event dispatch | Tauri commands from frontend to backend |
| Session load sequencing | Decides when to call `LoadSession` on structural changes |
| Persistence and undo/redo | Disk I/O, history stack |
| Diagnostics collection | Polls C++ diagnostics; does not interpret audio behavior |
| File path resolution | Resolving source file paths for C++ to load |

Rust commits a **snapshot** of the project to C++ at load time and at structural
change points. After that, live audio state is C++'s domain.

---

## 2. What C++ Owns (Single Source of Truth at Runtime)

| Responsibility | Notes |
|---|---|
| Live gain / pan / mute / solo per track | Stored in `Mixer`; set via lightweight realtime commands |
| Effective pitch decisions during playback | `resolve_pitch_render_decision()` is canonical |
| Folder/group audio routing and gain hierarchy | `parent_control_index` chain in Mixer |
| Metronome enabled/volume/route | Set via `SetMetronomeEnabled`, `SetMetronomeVolume`, `SetMetronomeConfig` |
| Playback position and transport state | Audio clock is owned by the audio callback |
| RealtimePitchStream lifecycle | Control thread manages stream sets; audio thread only renders |
| Source loading and readiness | `SourceManager` tracks which sources are loaded |

C++ must **never** need Rust to commit a full project update for a volume, pan,
mute, solo, metronome, or transpose-enabled change to take effect at runtime.

---

## 3. Allowed Command Types

### Category A — Realtime Commands (lightweight, no session rebuild)
These must never trigger `LoadSession`, session clone, or pitch stream rebuild:

- `SetTrackGain` — atomic store in Mixer
- `SetTrackPan` — atomic store in Mixer
- `SetTrackMute` — atomic store in Mixer
- `SetTrackSolo` — atomic store in Mixer
- `SetTrackAudioRoute` — atomic store in Mixer
- `SetTrackTransposeEnabled` — atomic store; updates pitch resolution at next render
- `SetMetronomeEnabled` — atomic store
- `SetMetronomeVolume` — atomic store
- `Play` — start audio callback
- `Stop` — stop audio callback
- `SeekAbsolute` — post seek to control thread

### Category B — Commit Commands (session snapshot, may rebuild pitch streams)
These clone the session in C++ and may trigger `prepare_for_transport_discontinuity`:

- `LoadSession` — full session snapshot from Rust
- `SetSongTranspose` — clones session, triggers pitch stream rebuild
- `SetRegionTranspose` — clones session, triggers pitch stream rebuild

### Category C — Structural Commands (device/config level)
These rebuild the audio stream or device:

- `SetOutputDevice`
- `SetSampleRate`
- `SetBufferSize`
- `SetMetronomeConfig` — device-level metronome setup

---

## 4. Forbidden Cross-Layer Responsibilities

| Action | Why Forbidden |
|---|---|
| Rust calling `sync_live_mix` during slider drag | Sends 6 commands per track; latency; breaks realtime budget |
| Rust calling `LoadSession` for volume/pan/mute/solo change | Full session rebuild for a trivial mixer update |
| Rust calling `LoadSession` for metronome toggle/volume | Same — metronome has dedicated realtime commands |
| Rust calling `LoadSession` for transpose-enabled toggle | Same — `SetTrackTransposeEnabled` is sufficient |
| Audio callback calling Rust/Tauri/UI | No IPC from hot path |
| Audio callback allocating memory | No malloc in audio callback |
| Audio callback doing disk I/O | No file reads in audio callback |
| Audio callback calling `reset_for_seek` or `prime` | Those are control-thread-only operations |
| C++ calling into Rust/Tauri during render | Unidirectional: Rust→C++ commands only |
| Rust rebuilding/reloading the full session for track control changes | Use Category A commands instead |

---

## 5. Command Flow Paths

### Realtime Path (slider drag, mute/solo button, metronome toggle)
```
UI event
  └─> Tauri command (timeline.rs / transport.rs)
        └─> AudioController::update_live_track_mix()  [or set_metronome_*_realtime()]
              └─> EngineCommand::SetTrackGain / SetTrackMute / ...
                    └─> C++ Mixer::set_track_gain() [atomic store, no lock, no alloc]
```
- No project model mutation
- No `sync_live_mix`
- No `LoadSession`

### Commit / Pointer-Up Path (drag released, value committed to model)
```
UI pointer-up event
  └─> Tauri command
        └─> AppState::persist_song_update()
              └─> engine.load_song(song)              [Rust model update]
              └─> AudioController::update_live_track_mix()  [realtime command for the changed field only]
```
- Model is updated once on pointer-up
- Only changed fields are sent to C++ — NOT a full `sync_live_mix`

### Structural Change Path (clip moved, source added, region created)
```
Edit operation
  └─> AppState::persist_song_update(AudioChangeImpact::StructureRebuild)
        └─> AudioController::replace_song_buffers()  [LoadSession]
        └─> engine.load_song(song)                   [model update]
```
- `LoadSession` only for genuine structural changes

### Session Load Path (file open, project import)
```
load_song_from_path()
  └─> audio.stop()
  └─> audio.replace_song_buffers()                              [LoadSession for source paths]
  └─> engine.load_song(song)                                    [model update]
  └─> audio.legacy_sync_live_mix_for_session_load_only(song)   [one-time full mixer sync]
```
- `legacy_sync_live_mix_for_session_load_only` is acceptable exactly once at load.
  Not during live operation. `legacy_sync_live_mix_count` must stay at 0 during playback.

### Diagnostics Path
```
(polling timer, ~1Hz)
  └─> Tauri command get_diagnostics
        └─> AudioController::get_diagnostics()
              └─> C++ engine.get_diagnostics()        [read-only snapshot]
                    └─> emit to frontend
```

---

## 6. Pitch Backend Requirements

- `LT_ENGINE_REALTIME_STREAM_HAS_RB = 1` is the only acceptable runtime backend.
- If RubberBand is unavailable at runtime, the pitch stream must output **silence** for
  pitched tracks, never original un-pitched audio. The `stub_passthrough_blocked` counter
  must fire and be surfaced in diagnostics.
- `LT_ENGINE_ALLOW_RUNTIME_PITCH_STUB_PASSTHROUGH` must never be `1` in a release build.
- Effective semitones is computed by `resolve_pitch_render_decision()` in C++. Rust must
  not cache or recompute this value.
- Stub mode is for unit tests only (`LT_ENGINE_ALLOW_PITCH_STUB=ON`).

---

## 7. Folder / Group Track Ownership

- Folder tracks are `TrackKind::Folder` in the C++ Session.
- The C++ Mixer owns the `parent_control_index` chain traversal (up to 8 levels).
- Effective gain/pan/mute/solo for a child track is computed by walking the parent chain
  in the Mixer at render time — never precomputed by Rust.
- Rust sends `SetTrackGain` etc. for both folder tracks and child tracks. C++ resolves
  the effective value for audio output.
- Rust must not flatten or pre-multiply folder gain into child gains before sending.

---

## 8. Metronome Ownership

- Metronome enabled/volume/route is owned by C++ at runtime.
- Rust sends `SetMetronomeEnabled` / `SetMetronomeVolume` for live toggle/volume.
- `SetMetronomeConfig` is a structural command sent once at settings apply time.
- The metronome must never require a `LoadSession` to toggle or change volume.

---

## 9. Architecture Diagram

```
┌─────────────────────────────────────────────────────────┐
│  Frontend (TypeScript / SvelteKit)                      │
│  - Slider drag → realtime command                       │
│  - Pointer-up  → commit command                         │
│  - Button toggle → realtime command                     │
└────────────────────────┬────────────────────────────────┘
                         │ Tauri IPC
┌────────────────────────▼────────────────────────────────┐
│  Rust / Tauri (THIN BRIDGE)                             │
│                                                         │
│  Category A (realtime) ──────────────────────────────┐  │
│    AudioController::update_live_track_mix()           │  │
│    AudioController::set_metronome_*_realtime()        │  │
│                                                       │  │
│  Category B (commit) ──────────────────────────────┐  │  │
│    AudioController::replace_song_buffers()          │  │  │
│    (LoadSession, SetSongTranspose, etc.)            │  │  │
│                                                     │  │  │
│  Category C (structural) ────────────────────────┐  │  │  │
│    AudioController::apply_settings_with_rebuild() │  │  │  │
└───────────────────────────────────────────────────┼──┼──┼──┘
                         EngineCommand enum         │  │  │
┌───────────────────────────────────────────────────▼──▼──▼──┐
│  C++ lt_audio_engine_v2                                     │
│                                                             │
│  Mixer (atomic, lock-free)                                  │
│  ├─ set_track_gain/pan/mute/solo()  ◄── Category A          │
│  └─ parent_control_index chain (folder hierarchy)           │
│                                                             │
│  SessionManager                                             │
│  └─ swap session pointer (atomic)   ◄── Category B          │
│                                                             │
│  RealtimePitchEngine                                        │
│  └─ stream set (control thread)     ◄── Category B seek     │
│                                                             │
│  Audio Callback (hard realtime — NO alloc, NO IPC)          │
│  └─ reads Mixer atomics                                     │
│  └─ reads stream ring buffers                               │
│  └─ calls render_pitched_clip()                             │
└─────────────────────────────────────────────────────────────┘
```

---

## 10. Invariants That Must Never Be Broken

1. The audio callback must not allocate, lock a mutex, do disk I/O, or call into Rust.
2. `reset_for_seek` and `prime` are control-thread-only. Never call them from the audio callback.
3. `legacy_sync_live_mix_for_session_load_only` is acceptable only once per session load. Not during live operation. Use `update_live_track_mix` for all live audio state changes.
4. A volume/pan/mute/solo/metronome/transpose-enabled change must never require `LoadSession`.
5. Stub pitch passthrough is blocked in runtime builds — silence is the correct failure mode.
6. Folder gain hierarchy is resolved entirely in C++ Mixer. Rust sends raw values only.
7. Pitch decisions (`effective_semitones`, `needs_pitch`) are resolved in C++ only.
8. Every Category A command must complete in < 1µs on the calling thread (atomic store only).
9. Category A commands (realtime bridge) must never mutate the Rust project model.
10. Category A commands must never create an undo entry or increment `project_revision`.
11. `session_rebuild_count` must not increment for any Category A or commit-only operation.
12. `last_session_rebuild_reason` must be one of: `"session_load"`, `"structure_rebuild"`, `"timeline_window"`, `"restart_audio"`. Any other value is a bug.

---

## 11. Manual Validation Checklist (Phase 13)

To validate the refactor is working correctly during a live session:

### Realtime command path
- [ ] Drag a volume slider on a track — verify audio level changes immediately with no glitch.
- [ ] Drag a pan slider — verify pan changes immediately.
- [ ] Toggle mute on a playing track — verify silence is immediate (no 100ms+ delay).
- [ ] Toggle metronome while playing — verify immediate on/off with no click.
- [ ] Drag metronome volume — verify smooth, immediate level change.
- [ ] Toggle transpose-enabled on a track — verify the pitch engine switches without a seek glitch.

### Session rebuild path (must NOT fire on the above)
- Call `get_ownership_diagnostics` (via `DevTools → Tauri`) after each action above.
- `realtimeCommandCount` must increment; `legacySyncLiveMixCount` must stay at 0.
- `sessionRebuildCount` must not increment during slider drag or mute/solo/metronome actions.
- `lastSessionRebuildReason` after a project open must be `"session_load"`.

### Pitch backend health
- Open `get_ownership_diagnostics` with a pitched track loaded.
- `pitchBackend` must be `"rubberband"`.
- `pitchEngineAvailable` must be `true`.
- `pitchStubPassthroughBlockedCount` must be `0`.
- `pitchRequestedButBackendUnavailableCount` must be `0`.

### Section markers (MixerOnly)
- Create, rename, move, delete a section marker while playback is running.
- Verify playback continues uninterrupted (no seek glitch).
- If a marker jump is pending, verify it survives section marker edits.

### Seek latency (original bug)
- Load a long project.
- Click the timeline head at various positions — verify seek is near-instant (< 200ms perceived).
- No delayed position update or double-seek artifact.
