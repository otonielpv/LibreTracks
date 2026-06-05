# Testing

LibreTracks has a single entry point that runs every suite that does **not**
need the native C/C++ audio engine compiled:

```bash
npm test
```

This runs `scripts/test-all.mjs`, which executes each suite sequentially and
prints an aggregated PASS/FAIL summary. It is cross-platform (Windows / macOS /
Linux) and exits non-zero if any suite fails.

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
`crates/lt-audio-engine-v2/src/ffi.rs`). This runs the Rust session-logic
tests that don't depend on real engine output (~88 of the `state.rs` cases)
without compiling any C++. Tests that assert on real playback position,
post-seek/jump snapshots, or source peaks only pass under the real engine
(`npm run test:native`).

See [`testing-engine-v2.md`](testing-engine-v2.md) for engine-specific notes.

## Conventions

- Tests live next to the code they cover (`foo.ts` -> `foo.test.ts`; Rust uses
  in-file `#[cfg(test)] mod tests`).
- Prefer testing pure logic directly; for module-level singletons (e.g. the
  update-check store) isolate state with `vi.resetModules()` + dynamic import.
- Rust filesystem tests use `tempfile::tempdir()`; audio tests synthesize WAVs
  with `hound` rather than committing fixtures.
