# Testing the Audio Engine v2

Two independent layers, each testable on its own.

---

## Layer 1 — Rust serialization tests (no C++ build needed)

Tests all `EngineCommand`, `EngineEvent`, and `EngineSnapshot` JSON round-trips.  
Runs in seconds. No audio device, no JUCE, no CMake.

```powershell
cargo test -p lt-audio-engine-v2 --features no-link
```

Expected output: `46 passed; 0 failed`

### What's tested
| File | Coverage |
|------|----------|
| `src/tests/test_commands.rs` | All 20+ command variants serialize with the correct `"type"` field and round-trip cleanly |
| `src/tests/test_events.rs`   | All 14 event variants serialize with the correct `"type"` field and preserve all fields |
| `src/tests/test_snapshot.rs` | EngineSnapshot with pending jumps, device info, CPU, meters, source states |

---

## Layer 2 — C++ unit tests (requires CMake build)

Tests session validation, TransportClock, JumpScheduler, and command/event JSON parsing.

### Prerequisites
- Visual Studio 2022 (already installed)
- CMake 3.25+ (already installed)
- Git (for FetchContent — downloads JUCE, RubberBand, libsndfile, r8brain, nlohmann/json, doctest)
- Internet connection on first build (~500 MB download, cached after)

### Step 1 — Build the C++ engine and tests

```powershell
cd native\audio-engine-v2
.\scripts\build.ps1
```

First build: ~5–10 minutes (dependency download + compile).  
Subsequent builds: ~30 seconds.

### Step 2 — Run the C++ tests

```powershell
cd native\audio-engine-v2\build
ctest -C Release --output-on-failure
```

Or run the executable directly for more detail:

```powershell
.\Release\lt_engine_tests.exe --reporters=console --duration=true
```

### What's tested
| File | Coverage |
|------|----------|
| `tests/test_session_validation.cpp` | 15 cases: valid session, empty ID, bad sample rate, end≤start, unknown source, bad clip length, duplicate IDs, marker/region out of bounds, transpose range, NeverTranspose, no-song session, multi-song |
| `tests/test_transport_clock.cpp`    | 14 cases: initial state, play/pause/stop, seek accuracy, advance while stopped/paused/playing, seconds calculation, context resolution (song/region/marker), between-songs clears context |
| `tests/test_jump_scheduler.cpp`     | 17 cases: resolve Frame/Marker/Region/NextSong/PreviousSong targets, schedule→drain→list, cancel, cancel_all, replace, check_due armed jump, mark_executed, cancelled jump not due, schedule_immediate |
| `tests/test_command_json.cpp`       | 20+ cases: parse every command type from JSON, error on unknown type, error on malformed JSON, event_to_json produces correct fields, snapshot_to_json has required keys |

---

## Layer 3 — Run the Tauri app with the v2 engine

After the C++ build succeeds:

```powershell
# From the repo root, build/load C++ v2 and start Tauri
npm run dev:desktop:native
```

At this point the engine will:
- Open the default audio device via JUCE
- Output silence (no session loaded yet)
- Respond to `engine_v2_initialize`, `engine_v2_get_snapshot`, `engine_v2_list_devices` from the frontend

To verify it works, open the browser DevTools console in Tauri and call:

```js
await __TAURI__.core.invoke("engine_v2_initialize")
// → "0.1.0"

await __TAURI__.core.invoke("engine_v2_get_snapshot")
// → JSON with playback_state: "Stopped", device info, etc.

await __TAURI__.core.invoke("engine_v2_list_devices")
// → JSON array of output devices
```

---

## Quick reference

| What | Command | Needs C++ build? |
|------|---------|-----------------|
| Rust JSON tests | `cargo test -p lt-audio-engine-v2 --features no-link` | No |
| Rust type check | `cargo check -p lt-audio-engine-v2` | No |
| Desktop type check | `npm run check:desktop:native` | Yes |
| C++ build | `cd native\audio-engine-v2 && .\scripts\build.ps1` | — |
| C++ tests | `cd native\audio-engine-v2\build && ctest -C Release` | Yes |
| Tauri dev (v2) | `npm run dev:desktop:native` | Yes |
