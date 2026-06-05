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
against the compiled native audio engine via FFI, so their tests — including
the large `state.rs` suite and the engine-v2 command/event/snapshot tests —
require the full native toolchain and a built engine. They are intentionally
**excluded** from `npm test` so the everyday/CI-light loop stays fast and
toolchain-independent.

Run them explicitly once the native engine is built:

```bash
npm run test:native
# == cargo test -p libretracks-desktop -p lt-audio-engine-v2
```

See [`testing-engine-v2.md`](testing-engine-v2.md) for engine-specific notes.

## Conventions

- Tests live next to the code they cover (`foo.ts` -> `foo.test.ts`; Rust uses
  in-file `#[cfg(test)] mod tests`).
- Prefer testing pure logic directly; for module-level singletons (e.g. the
  update-check store) isolate state with `vi.resetModules()` + dynamic import.
- Rust filesystem tests use `tempfile::tempdir()`; audio tests synthesize WAVs
  with `hound` rather than committing fixtures.
