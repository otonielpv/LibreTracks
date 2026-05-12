# Audio Engine v2 — Full Development Plan

C++ replacement for the Rust audio engine.  
Target: professional, clean, maintainable, optimized multitrack live-playback engine.

Legend: ✅ Done · 🔄 In progress · ⬜ Pending

---

## Phase 1 — Native C++ Engine Foundation ✅

**Goal:** Create the C++ project and integrate it into the build without replacing the old engine.

- ✅ `native/audio-engine-v2/` directory created
- ✅ CMakeLists.txt with full module assembly
- ✅ `cmake/options.cmake` — feature flags (JUCE, RubberBand, FFmpeg/libsndfile, r8brain/libsamplerate)
- ✅ `cmake/dependencies.cmake` — FetchContent for all deps (JUCE 8.0.4, RubberBand 3.3.0, libsndfile 1.2.2, r8brain, nlohmann/json)
- ✅ `DEPENDENCIES.md` — decision rationale for every library
- ✅ Module structure: core / transport / scheduler / session / render / sources / pitch / devices / diagnostics / ffi
- ✅ Minimal engine: `initialize()`, `shutdown()`, `getVersion()`, `getDiagnostics()`
- ✅ Build scripts: `scripts/build.ps1`, `scripts/build.sh`

**Acceptance criteria:**
- ✅ C++ engine compiles
- ✅ Library/dependency decision documented
- ✅ No playback yet

---

## Phase 2 — Engine Command / Event / Snapshot API ✅

**Goal:** Stable API between Tauri/Rust/frontend and the C++ engine.

- ✅ `EngineCommand` — 28 variants (Play, Pause, Stop, Seek, all Jump types, track/pitch/device controls)
- ✅ `EngineEvent` — 14 variants (playback, seek, jumps, device, source, pitch cache, diagnostics)
- ✅ `EngineSnapshot` — current frame/seconds, playback state, song/region/marker context, pending jumps, device info, CPU diagnostics, meters, source preparation state
- ✅ JSON serialization via nlohmann/json (stable C ABI safe)
- ✅ C ABI: `lt_audio_engine_send_command()`, `lt_audio_engine_poll_event()`, `lt_audio_engine_get_snapshot()`

**Acceptance criteria:**
- ✅ Rust can send commands
- ✅ Rust can poll events
- ✅ Rust can read snapshot
- ✅ No real audio yet

---

## Phase 3 — Session Model V2 ✅

**Goal:** Clean engine session model for live multitrack playback.

- ✅ `Session` — id, name, sample_rate, songs[], sources[]
- ✅ `Song` — id, name, start_frame, end_frame, transpose_semitones, tracks[], markers[], regions[]
- ✅ `Track` — id, name, gain, mute, solo, transpose_behavior, role, clips[]
- ✅ `Clip` — id, source_id, timeline_start_frame, source_start_frame, length_frames, gain, fade_in/out_frames
- ✅ `Source` — id, file_path, original_sample_rate, channel_count, duration_frames, decode_status, cache_status
- ✅ `TrackRole` — Normal / Click / Guide / Cue / Backing / Other
- ✅ `TransposeBehavior` — FollowsSongOrRegion / NeverTranspose
- ✅ Full validation (unique IDs, clip/source refs, marker/region bounds, transpose range, etc.)
- ✅ `session_from_project_json()` — adapter from libretracks-project JSON → Session V2

**Acceptance criteria:**
- ✅ Existing project can be mapped to Session V2
- ✅ Track transpose opt-out is explicit (not name-based)
- ✅ Invalid sessions produce clear errors

---

## Phase 4 — JUCE Device Layer Prototype ✅

**Goal:** Use JUCE to open audio devices and output silence safely.

- ✅ JUCE modules: `juce_core`, `juce_audio_basics`, `juce_audio_devices`
- ✅ `AudioDeviceManager` — listDevices(), open/close device, start/stop
- ✅ `AudioRenderCallback` interface — decouples render from JUCE types
- ✅ `JuceCallbackAdaptor` — bridges callback with realtime-safe rules
- ✅ Silent audio callback (SilentCallback) for Phases 1–5
- ✅ Diagnostics: device name, backend, sample_rate, buffer_size, callback duration EMA, underrun count
- ✅ Non-JUCE stub fallback when `LT_ENGINE_USE_JUCE=OFF`
- ✅ Realtime callback rules enforced: no alloc, no lock, no I/O, no Rust/Tauri calls

**Acceptance criteria:**
- ✅ C++ engine can open default output
- ✅ Device list visible from Rust/Tauri
- ✅ Device diagnostics in snapshot
- ✅ No playback yet

---

## Phase 5 — Transport and Jump Scheduler ✅

**Goal:** Core live-performance behavior before decoding complexity.

- ✅ `TransportClock` — sample-frame based, play/pause/stop/seek/advance, resolve_context (song/region/marker)
- ✅ `JumpScheduler` — full implementation:
  - ✅ Immediate, AtRegionEnd, AtSongEnd, AtFrame triggers
  - ✅ Marker / Region / Song / NextSong / PreviousSong / Frame targets
  - ✅ schedule / cancel / cancel_all / replace
  - ✅ Jump status lifecycle: Pending → Armed → Executed / Failed / Cancelled
  - ✅ Per-jump: id, target, trigger, status, created_frame, executed_frame, cancelled_frame, failure_reason
  - ✅ Lock-free design: command thread writes to mutex queue; audio thread drains at block start
  - ✅ `resolve_jump_target()` — pure function, callable from both threads
- ✅ Integrated with EngineCommand/Event/Snapshot

**Acceptance criteria:**
- ✅ Scheduler works with simulated transport
- ✅ Pending jumps can be cancelled
- ✅ Replaced jumps behave correctly
- ✅ Remote/UI can inspect pending jump state
- ✅ No audio playback yet

---

## Rust FFI Boundary ✅

**Goal:** Connect C++ engine to the Tauri app behind an env flag.

- ✅ `crates/lt-audio-engine-v2/` — safe Rust wrapper crate
  - ✅ `ffi.rs` — raw `extern "C"` declarations
  - ✅ `lib.rs` — safe `Engine` wrapper (Send, no Sync)
  - ✅ `commands.rs` — Rust `EngineCommand` with serde matching C++ JSON schema
  - ✅ `events.rs` — Rust `EngineEvent` enum
  - ✅ `snapshot.rs` — Rust `EngineSnapshot` and sub-structs
  - ✅ `build.rs` — links `.dll`/`.so` from `LT_ENGINE_V2_LIB_DIR` or default CMake path
- ✅ `commands/engine_v2.rs` — 8 Tauri commands behind `#[cfg(feature = "audio-engine-v2")]`
- ✅ `LIBRETRACKS_AUDIO_ENGINE=cpp-v2` env flag wired in `main.rs`
- ✅ `audio-engine-v2` Cargo feature gate — old engine untouched
- ✅ Both `cargo check` pass clean (Rust crate + desktop app)

---

## Phase 6 — Basic WAV/PCM Playback ✅

**Goal:** Play multiple WAV stems with sample-accurate sync.

- ✅ `DecodedSource` — float32 internal, engine sample rate, channel count, duration frames; mono→stereo dup; safe read at EOF
- ✅ `SourceManager` — register/load_source (sync, Phase 10 makes async)/get/diagnostics/clear
- ✅ `TrackRenderer` — active clips per block, timeline/source offset, fade-in/out, gain; stack scratch buffers (no alloc in render)
- ✅ `Mixer` — mix tracks, gain/mute/solo (atomic overrides), stereo output, peak meters, callback duration EMA
- ✅ Mixer installed as `AudioRenderCallback` on `CmdLoadSession`; SilentCallback used before session is loaded
- ✅ Decoding via libsndfile (WAV/FLAC/OGG) and dr_mp3 (MP3)
- ✅ `CmdLoadSession` — parses project JSON, registers+loads sources, constructs Mixer, replaces device callback
- ✅ `engine_v2_load_session` Tauri command added

**Acceptance criteria:**
- ✅ 10–15 WAV stems play simultaneously
- ✅ Tracks remain aligned
- ✅ Play/pause/stop/seek works
- ✅ No pitch yet / no streaming yet

---

## Phase 7 — Click-Free Seek and Jump Rendering ✅

**Goal:** Smooth seeks and jumps — no pops or clicks.

- ✅ `FadeProcessor` — configurable ramp (default 256 samples), fade-out+fade-in pair triggered atomically from command thread, processed in audio thread in-place
- ✅ Jump execution on exact render frame: `JumpScheduler::check_due()` called at top of audio block; `mark_executed()` after clock seek; `trigger_crossfade()` immediately after
- ✅ Source cursor is implicit: `DecodedSource::read()` takes an absolute frame offset — no stale read head; seek just changes the clock frame used in `render_clip()`
- ✅ `FadeProcessor` embedded in `Mixer` — single crossfade instance, single trigger point, no duplicate fade logic

**Acceptance criteria:**
- ✅ Immediate seeks smooth (crossfade applied)
- ✅ Marker/scheduled jumps smooth (same path)
- ✅ No aggressive pop/click
- ✅ Jump cancellation still works

---

## Phase 8 — Multi-Format Decoding ✅

**Goal:** Support real-world audio formats.

- ✅ `AudioDecoder` abstraction — open / read_frames / seek / info / close
- ✅ `SndfileDecoder` — handles WAV, FLAC, OGG/Vorbis, AIFF via libsndfile
- ✅ `DrMp3Decoder` — MP3 via dr_mp3 single-header
- ✅ `make_decoder()` factory — routes by file extension
- ✅ `decode_file_to_float32()` — convenience one-call decode+resample
- ✅ Resampling inside decode pipeline: r8brain (per-channel sinc) or libsamplerate (SRC_SINC_BEST_QUALITY)
- ✅ dr_libs fetched via FetchContent (no manual download required)
- ✅ FFmpeg alternative available via `-DLT_ENGINE_USE_FFMPEG=ON`

**Acceptance criteria:**
- ✅ WAV, FLAC, OGG, MP3 load
- ✅ Unsupported files fail with clear error
- ✅ No decoder work in audio callback (all decoding in load_source / command thread)

---

## Phase 9 — Resampling Pipeline ✅

**Goal:** All sources match engine sample rate without desync.

- ✅ `resample_if_needed()` helper — integrated into `decode_file_to_float32()`; skipped when rates match
- ✅ r8brain backend — per-channel non-interleaved CDSPResampler24 (high-quality sinc)
- ✅ libsamplerate backend — SRC_SINC_BEST_QUALITY via `src_simple()` (alternative, `-DLT_ENGINE_USE_LIBSAMPLERATE=ON`)
- ✅ All decoded sources arrive at `DecodedSource` already at engine sample rate
- ⬜ Dedicated `Resampler` abstraction class (current inline helper sufficient; refactor in Phase 17 if needed)
- ⬜ Automated alignment tests (Phase 13)

**Acceptance criteria:**
- ✅ Mixed sample-rate sources resample to engine rate before storage
- ✅ Device sample rate does not cause drift (all sources pre-converted)
- ✅ No decoder work in audio callback

---

## Phase 10 — Worker Threads, Import and Preparation ⬜

**Goal:** All heavy work off UI and audio threads.

- ⬜ `DecodeWorkerPool`
- ⬜ `SourcePreparationQueue`
- ⬜ Background jobs: decode, resample, waveform handoff, pitch cache gen, prebuffering
- ⬜ Job states: queued / running / completed / failed / cancelled
- ⬜ Progress surfaced through EngineEvent/Snapshot

**Acceptance criteria:**
- ⬜ Import does not block UI
- ⬜ Play does not synchronously decode
- ⬜ Audio callback never waits for workers
- ⬜ Missing prepared source → silence + diagnostic (not noise)

---

## Phase 11 — Streaming and Block Cache ⬜

**Goal:** Handle large sessions efficiently.

- ⬜ `CachedSource`, `StreamingSource`, `PreparedSource` types
- ⬜ Block cache — fixed-size audio blocks, bounded memory, eviction policy
- ⬜ Cache hit/miss diagnostics
- ⬜ Prebuffering — current playhead, next song, scheduled jump target, selected marker
- ⬜ Starvation handling — return silence, emit `EvSourceStarved`, never corrupt audio

**Acceptance criteria:**
- ⬜ Long files do not require full RAM load
- ⬜ Scheduled jump targets can prebuffer
- ⬜ No disk I/O in audio callback
- ⬜ No metallic/white-noise playback corruption

---

## Phase 12 — RubberBand Pitch Pipeline ⬜

**Goal:** Professional transpose — per song, per region, per track opt-out.

- ⬜ `PitchProcessor` abstraction
- ⬜ `RubberBandPitchProcessor` — realtime mode with latency reporting
- ⬜ `BypassPitchProcessor` — zero cost for transpose=0 or NeverTranspose tracks
- ⬜ `PitchCache` — keyed by (source_id, semitones, sample_rate, channel_count)
- ⬜ Strategy priority: zero-transpose → NeverTranspose → cache hit → realtime fallback
- ⬜ Centralized latency compensation — one place, no hidden trims
- ⬜ Diagnostics: pitch mode, cache hit/miss, RubberBand latency, effective latency, fallback usage

**Acceptance criteria:**
- ⬜ Pitch works from first play (no silence until seek)
- ⬜ Transposed and non-transposed tracks remain aligned
- ⬜ No double processing
- ⬜ Seeks/jumps with pitch are smooth
- ⬜ CPU lower than current always-realtime path

---

## Phase 13 — Pitch Alignment Test Suite ⬜

**Goal:** Prevent regressions in the most critical area.

- ⬜ Audio dump mode — mix, per stem, pre-pitch, post-pitch, metronome/reference
- ⬜ Automated A/B tests: original vs ±2/±12, after play/seek/marker jump/scheduled jump
- ⬜ Measures: onset offset, drift, silence detection, click spike around jump

**Acceptance criteria:**
- ⬜ Alignment within acceptable sample threshold
- ⬜ No silence in pitched track
- ⬜ No large pop/click around jumps
- ⬜ Tests fail if alignment regresses

---

## Phase 14 — Device Switching and ASIO/WASAPI Robustness ⬜

**Goal:** Reliable device selection across Windows backends.

- ⬜ Safe device switch: stop → preserve transport → close old → open new → rebuild buffers → restart
- ⬜ Diagnostics: requested/actual device, backend, sample_rate, buffer_size, last error
- ⬜ Windows: WASAPI stable first, then ASIO after WASAPI is reliable
- ⬜ No hardcoded device names

**Acceptance criteria:**
- ⬜ Device change does not leave engine dead
- ⬜ Failed switch recovers gracefully
- ⬜ WASAPI/ASIO alignment is consistent

---

## Phase 15 — Remote Control Integration ⬜

**Goal:** Preserve and improve app remote behavior.

- ⬜ Route all remote commands → `EngineCommand`
- ⬜ Expose full `EngineSnapshot` to remote: song, position, marker, region, pending jumps, meters, device
- ⬜ Cancel scheduled jump from remote
- ⬜ Desktop and remote stay synchronized

**Acceptance criteria:**
- ⬜ Remote can control C++ engine
- ⬜ Pending jumps visible remotely
- ⬜ Cancel scheduled jump works from remote

---

## Phase 16 — UI and Project Integration ⬜

**Goal:** Connect frontend/backend to Engine v2 cleanly.

- ⬜ Replace old direct audio calls with `EngineCommand`
- ⬜ Replace scattered audio state with `EngineSnapshot`
- ⬜ Keep Tauri/React UI intact
- ⬜ Simplify transport UI
- ⬜ Update project save/load for: transpose, track role, transpose behavior, markers, regions, clips, sources

**Acceptance criteria:**
- ⬜ UI works with C++ engine
- ⬜ No UI blocking
- ⬜ Project data maps cleanly to Session V2
- ⬜ Export/import preserves pitch and track opt-out

---

## Phase 17 — Performance Optimization ⬜

**Goal:** C++ engine measurably better than the old Rust engine.

- ⬜ Profile: callback duration, CPU per source, CPU per pitched source, cache hit/miss, memory, underruns, starvation
- ⬜ Optimize: mixing loop, memory layout, block size, pitch cache strategy, prebuffer strategy, resampling, avoid copies
- ⬜ Stress tests: 15 stems, 30 stems if possible, pitch on several tracks, rapid seeks, remote jumps, mixed formats

**Acceptance criteria:**
- ⬜ CPU significantly lower than current StreamingReader + realtime pitch
- ⬜ UI remains responsive
- ⬜ No corrupted audio

---

## Phase 18 — Cross-Platform Validation ⬜

**Goal:** Professional behavior on all platforms.

- ⬜ Windows: WASAPI, ASIO, 44.1kHz, 48kHz, buffers 128/256/512/1024
- ⬜ macOS: CoreAudio
- ⬜ Linux: ALSA/Pulse/PipeWire/JACK
- ⬜ Manual checklist: play/pause/stop/seek, marker jump, scheduled jump, cancel scheduled jump, pitch A/B, import-then-play, device switch, remote control

**Acceptance criteria:**
- ⬜ No platform-specific desync
- ⬜ Device differences do not change timing
- ⬜ Issues isolated to device backend

---

## Phase 19 — Remove Old Rust Engine ⬜

**Goal:** Delete legacy engine only after C++ v2 is stable.

- ⬜ Remove `apps/desktop/src-tauri/src/audio_runtime/` (mixer.rs, mod.rs, pitch.rs, source.rs, backend.rs, etc.)
- ⬜ Remove old Cargo deps: cpal, symphonia, rubberband crate, hound, rtrb, memmap2
- ⬜ Remove `crates/rubberband/` wrapper
- ⬜ Remove obsolete debug flags and duplicate playback strategies
- ⬜ Keep Rust only as app/backend/FFI layer
- ⬜ Update docs

**Acceptance criteria:**
- ⬜ One clean C++ audio engine
- ⬜ No hidden old paths
- ⬜ App builds and runs
- ⬜ All tests pass

---

## Non-Negotiable Realtime Rules (apply to every phase)

**Never in the audio callback:**
- allocation · mutex lock · file I/O · decode · resample setup
- RubberBand creation · logging · Rust/Tauri/UI calls · waiting for workers

**Always:**
- one transport clock · one scheduler · one source manager · one pitch pipeline
- explicit latency compensation · pitch/non-pitch aligned · jumps click-free
- diagnostics exposed · device-specific code isolated

---

## Architecture Reference

```
Tauri/React UI
     │  Tauri IPC (invoke)
     ▼
Rust command thread (engine_v2.rs Tauri commands)
     │  lt_audio_engine_send_command() — C ABI
     ▼
EngineImpl (C++)
     ├─ JumpScheduler  ←── command thread writes
     │       │               audio thread drains
     │       ▼
     ├─ TransportClock ←── audio thread advances
     │
     ├─ SourceManager  ←── worker threads fill
     │
     ├─ Mixer ──────────── audio callback hot path
     │   └─ TrackRenderer → PitchProcessor → FadeProcessor
     │
     └─ AudioDeviceManager (JUCE)
             └─ AudioRenderCallback → Mixer.render()
```

## Current library integration

| Library | Version | Integration | Status |
|---------|---------|-------------|--------|
| JUCE | 8.0.4 | FetchContent | ✅ CMake ready |
| RubberBand | 3.3.0 | find_package + FetchContent | ✅ CMake ready |
| libsndfile | 1.2.2 | find_package + FetchContent | ✅ CMake ready |
| dr_mp3/dr_flac | latest | bundled headers | ✅ placeholder |
| r8brain | latest | FetchContent | ✅ CMake ready |
| nlohmann/json | 3.11.3 | FetchContent | ✅ CMake ready |

---

## Phase 10-16 implementation audit (2026-05-12)

Phase 10 is implemented for the C++ route: `DecodeWorkerPool` and `SourcePreparationQueue` move decode/resample work off the UI and audio threads, expose queued/running/completed/failed/cancelled states, update EngineSnapshot source preparation state, and install prepared sources asynchronously when worker jobs complete.

Phase 11 is structurally in place: `AudioSource`, `PreparedSource`, `StreamingSource`, `SilentSource`, `BlockCache`, and `PrebufferWorker` exist, cache misses return silence, and cache hit/miss diagnostics are available. Remaining route item: make SourceManager choose streaming for long files by policy and wire scheduled-jump/selected-marker prebuffer priorities into the active mixer path.

Phase 12 is scaffolded but guarded: `PitchProcessor`, `BypassPitchProcessor`, `RubberBandPitchProcessor`, and `PitchCache` compile. Mixer playback still keeps pitch disabled until Phase 13 alignment coverage is added, so the route is ready but not accepted as active production pitch.

Phase 13 remains pending. The current code has no automated audio dump / A-B alignment suite yet.

Phase 14 is partially implemented: device switches now reopen using the active mixer callback when loaded, preserve transport state, emit device diagnostics/errors, and avoid hardcoded device names. WASAPI/ASIO alignment still needs hardware validation.

Phase 15 is partially implemented: EngineCommand dispatch now covers transport, jumps, schedule/cancel/replace, gain/mute/solo, transpose, and device/sample-rate/buffer-size commands, and EngineSnapshot exposes pending jumps/meters/device/source state. The existing remote bridge still targets the legacy DesktopState path until the app is switched to the v2 command surface.

Phase 16 is partially implemented: v2 Tauri commands expose EngineCommand/EngineSnapshot and the project adapter maps transpose, track role, transpose behavior, markers, regions, clips, and sources into Session V2. The React transport store still uses the legacy transport commands by default, so full UI replacement is still on the route.
