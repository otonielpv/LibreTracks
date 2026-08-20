# Testing

LibreTracks has a single entry point that runs every suite that does **not**
need the native C/C++ audio engine compiled:

```bash
npm test
```

This runs `scripts/test-all.mjs`, which executes each suite sequentially and
prints an aggregated PASS/FAIL summary. It is cross-platform (Windows / macOS /
Linux) and exits non-zero if any suite fails.

## Which command to run after a change

| You changed… | Run |
| --- | --- |
| Frontend (React/TS), shared, remote | `npm test` (+ `npm run lint`) |
| Rust session logic (`state.rs`, `models/`) | also `npm run test:native:nolink` |
| The C++ audio engine (`native/audio-engine-v2/`) | also `npm run test:native` |
| Everything, before a release | `npm run test:full` |

`npm run test:full` chains both tiers (fast suites + native engine) and prints
one combined summary — the single command for "check that nothing is broken".
Note: its native tier links the **real** engine, so the audio-device-dependent
Rust tests fail on a machine with no/busy sound card (they are informational —
see below). The 163 C++ DSP tests are the authoritative engine signal.

## What `npm test` covers

| Suite | Tool | Location |
| --- | --- | --- |
| `shared` | vitest (node) | `packages/shared/src/*.test.ts` |
| `desktop frontend` | vitest (jsdom) | `apps/desktop/src/**/*.test.{ts,tsx}` |
| `remote frontend` | vitest (jsdom) | `apps/remote/src/*.test.ts` |
| `rust crates` | cargo | `crates/{core,project,audio,remote}` |

You can run any suite on its own:

```bash
npm run test:shared
npm run test:desktop
npm run test:remote
cargo test -p libretracks-core   # or -project / -audio / -remote
```

## The native engine suite (separate)

The `libretracks-desktop` (src-tauri) crate and `lt-audio-engine-v2` link
against the compiled native audio engine via FFI. Their tests — the large
`state.rs` session suite, the engine bindings, and the C++ DSP doctest suite —
are intentionally **excluded** from `npm test` so the everyday/CI-light loop
stays fast and toolchain-independent.

There are two ways to run them:

### Real engine (most thorough)

```bash
npm run test:native
```

This drives `scripts/desktop-native.{ps1,mjs}` in `test` mode, which:

1. Builds the C++ engine **shared** library (CMake + vcpkg + JUCE),
2. Runs `cargo test -p libretracks-desktop -p lt-audio-engine-v2` against it
   (the full ~105-test `state.rs` suite + bindings, real engine linked),
3. Builds the C++ engine **static** test target and runs the DSP doctest
   suite via `ctest`.

Requires the native toolchain (Visual Studio + CMake + vcpkg, and Bungee for
warp). First run is slow (dependency build); later runs are incremental.

### Fast, no native toolchain (`no-link`)

```bash
npm run test:native:nolink
# == cargo test -p libretracks-desktop -p lt-audio-engine-v2 \
#      --features libretracks-desktop/no-link
```

The `no-link` feature swaps the engine FFI for an in-memory no-op stub (see
`crates/lt-audio-engine-v2/src/ffi.rs`): `create()` returns a valid handle,
commands succeed, and `get_snapshot()` returns a default-serialized
`EngineSnapshot`. This runs the Rust session-logic `state.rs` tests without
compiling any C++ (100 passed, 5 ignored).

A handful of `state.rs` cases assert on real engine output (playhead
estimate, playback drift, source peaks, waveform-cache counters) and are
`#[cfg_attr(feature = "no-link", ignore = "requires real engine output")]`,
so they are skipped here and run under `npm run test:native`. Those are
integration tests: with the real engine they additionally need an available
audio device.

See [`testing-engine-v2.md`](testing-engine-v2.md) for engine-specific notes.

## Conventions

- Tests live next to the code they cover (`foo.ts` -> `foo.test.ts`; Rust uses
  in-file `#[cfg(test)] mod tests`).
- Prefer testing pure logic directly; for module-level singletons (e.g. the
  update-check store) isolate state with `vi.resetModules()` + dynamic import.
- Rust filesystem tests use `tempfile::tempdir()`; audio tests synthesize WAVs
  with `hound` rather than committing fixtures.

## Android device bench (manual)

`scripts/android-bench.mjs` measures what the low-end Android plan
(`docs/plans/android-low-end/`) claims to improve: process memory, system
memory, disk consumed, and process kills from memory pressure. It is **run by
hand** with a phone on USB — never in CI (no device on the runner, and this repo
has a history of timing-dependent tests taking down releases).

```
node ./scripts/android-bench.mjs --list
node ./scripts/android-bench.mjs --scenario import-full --out baseline.json
```

The scenarios that drive the phone's UI print the exact steps to perform and
wait for you to press Enter at the start and end. The SAF file picker is a
system dialog and is deliberately **not** automated.

Useful flags: `--interval <ms>` (sampling period), `--max-seconds <s>` (auto-stop
so a crash doesn't hang the run), `--device <serial>`, `--adb <path>`,
`--outcome <text>` (force the recorded outcome, e.g. `system_restart`).

### Reading the output

| Field | Meaning |
| --- | --- |
| `memory.rss_peak_kb` | Highest sampled RSS |
| `memory.hwm_peak_kb` | `VmHWM` — the kernel's own peak, independent of sampling rate |
| `memory.available_min_kb` | Lowest system `MemAvailable` seen |
| `disk.consumed_kb` | `/data` used before vs after |
| `kills.libretracks` | Times the app itself was killed — **non-zero is a failure** |
| `kills.total` | System-wide kills; a cascade (>20) is the memory-pressure signature |
| `engine_logs.starvation_count` | `[LT_STARVATION]` events — likely audio dropouts |
| `ui.janky_percent` | Share of frames that missed their deadline (`dumpsys gfxinfo`) |
| `ui.p99_ms` | 99th-percentile frame time — the visible stutters |

Two caveats about how the numbers are obtained:

- `/proc/<pid>/io` is **not readable without root** on Android 10 (verified on
  the CPH1931), so written bytes are approximated by the `df` delta on `/data`.
  That measures net space consumed — what the user feels — but not overwritten
  writes or other apps' traffic.
- A full system restart cannot be observed from the script (it loses the
  device). Record it yourself with `--outcome system_restart`.

UI smoothness is measured separately from audio: an import can finish with
`starvation_count: 0` and still leave the app unusable. The baseline run on the
CPH1931 did exactly that — it completed, killed no LibreTracks process, and
still hit 53% janky frames with a p99 of 1950 ms. Frame counters are reset at
the start of each run, so the numbers cover the measured window only.
