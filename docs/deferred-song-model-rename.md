# Deferred rename: `Song` → `ProjectSession`, `SongRegion` → `Song`

## Status

**Deferred.** Decided to ship per-song master, per-song track overrides, "insert song at end", and the compact view first, then apply this rename as an isolated cosmetic PR. No functional code depends on doing the rename first.

## Why this rename exists

Today's model uses these names:

| Concept in product language | Today's code |
|---|---|
| Project (the file the user opens) | `Song` |
| A song inside the project (with a name, master, transpose, warp) | `SongRegion` |
| Range on the timeline | also `SongRegion` |

The product is moving to "a project contains multiple songs, each exportable and reusable". Per-song master and per-track overrides per song are being added on top of `SongRegion`. After those features land, the naming gap will be much more confusing than it is today — `SongRegion.master`, `SongRegion.track_overrides`, `delete_song_region(...)` will all read as "a region has a master?".

The rename closes that gap. It is purely cosmetic; no behavior changes, no on-disk format changes.

## Scope

**In scope (rename targets):**
- Rust crates: `libretracks-core`, `libretracks-project`, `libretracks-audio`, `libretracks-remote`, `lt-audio-engine-v2`
- Rust desktop bridge: `apps/desktop/src-tauri/`
- Frontend TypeScript: `apps/desktop/src/`, `packages/shared/`
- Tests at every layer (Rust unit/integration, frontend Vitest, snapshot fixtures)

**Out of scope (intentionally left alone):**
- C++ engine (`native/audio-engine-v2/`) — already uses `Session`, no `Song`/`SongRegion` types
- On-disk file name `song.ltsession` — users would see breakage; keep the filename, rename only types in code
- Documentation (`docs/*.md`, `apps/website/**`) — update at release time, not as part of the rename
- CSS class names and i18n string keys (`createSongRegionFromSelection`, etc.) — visible to users via translations; update alongside compact view UI work
- The `song.ltsession` JSON schema fields — they are camelCase keys controlled by `#[serde(rename_all = "camelCase")]` so the on-disk shape stays identical even after Rust type renames

## Pre-flight: the `Project` residual

`libretracks_core::Project` exists today (`crates/libretracks-core/src/model.rs:17`) but is unused at runtime. It declares `songs: Vec<Song>` and was the original direction before the runtime collapsed to a single-song model. **Delete it as part of this rename** — its existence will collide with the new `ProjectSession` name otherwise.

Files referencing the residual `Project`:
- `crates/libretracks-core/src/lib.rs` — `pub use model::Project`
- `crates/libretracks-core/src/model.rs` — `pub struct Project { ... }`
- `crates/libretracks-core/src/warp.rs:62` — a doc comment, not a type reference

`DesktopError::Project(ProjectError)` and the `projectCreated*` i18n keys are **different types** — they belong to `libretracks_project::ProjectError` (the error enum) and frontend status strings. Leave those alone.

## The type-level mapping

| Old | New |
|---|---|
| `libretracks_core::Song` | `libretracks_core::ProjectSession` |
| `libretracks_core::SongRegion` | `libretracks_core::Song` |
| `libretracks_core::Project` (residual) | **DELETE** |
| `validate_song(&Song)` | `validate_project_session(&ProjectSession)` |
| `region_warp_ratio(&SongRegion, ...)` | `song_warp_ratio(&Song, ...)` |
| `region_warp_ratio_in_song(&SongRegion, &Song)` | `song_warp_ratio_in_session(&Song, &ProjectSession)` |
| `source_seconds_at_view(&Song, ...)` | `source_seconds_at_view(&ProjectSession, ...)` (signature change only) |

## The error-variant mapping (`DomainError` in `crates/libretracks-core/src/validation.rs`)

| Old variant | New variant |
|---|---|
| `MissingTitle` | unchanged |
| `InvalidDuration` | unchanged |
| `InvalidRegionBounds { region_id }` | `InvalidSongBounds { song_id }` |
| `RegionsOutOfOrder { previous_region_id, region_id }` | `SongsOutOfOrder { previous_song_id, song_id }` |
| `InvalidRegionTranspose { region_id, ... }` | `InvalidSongTranspose { song_id, ... }` |
| `WarpEnabledWithoutSourceBpm { region_id }` | `WarpEnabledWithoutSourceBpm { song_id }` |
| `InvalidWarpSourceBpm { region_id, ... }` | `InvalidWarpSourceBpm { song_id, ... }` |

Note: error variants are serialized into Tauri command failure strings. The exact message text changes ("region" → "song") will be user-visible in error toasts. That is desired — it is part of the point.

## Tauri command mapping (`apps/desktop/src-tauri/src/commands/timeline.rs`)

| Old command | New command |
|---|---|
| `create_song_region` | `create_song` |
| `update_song_region` | `update_song` |
| `update_song_region_transpose` | `update_song_transpose` |
| `update_song_region_warp` | `update_song_warp` |
| `delete_song_region` | `delete_song` |

Parameter `region_id: String` → `song_id: String` everywhere.

State-layer methods in `apps/desktop/src-tauri/src/state.rs` follow the same pattern (e.g. `create_song_region` → `create_song`).

Registration in `apps/desktop/src-tauri/src/main.rs:157` must be updated to the new command names.

## Frontend mapping (`packages/shared/src/desktopApi.ts` and consumers)

| Old | New |
|---|---|
| `createSongRegion` | `createSong` |
| `updateSongRegion` | `updateSong` |
| `updateSongRegionTranspose` | `updateSongTranspose` |
| `updateSongRegionWarp` | `updateSongWarp` |
| `deleteSongRegion` | `deleteSong` |
| `regionId: string` (param) | `songId: string` |
| `SongRegion` (TS type in `packages/shared/src/models.ts`) | `Song` |
| `Song` (TS type — the current container) | `ProjectSession` |
| `selectedRegionId` state, `setSelectedRegionId` setter | `selectedSongId`, `setSelectedSongId` |

Test mocks: `apps/desktop/src/app/testDesktopApiMock.ts` and `apps/desktop/src/test/testUtils.tsx` need the same renames.

## i18n keys (defer to compact view UI work)

Translation **values** ("Crear Cancion desde seleccion") are already correct in product language. The **keys** still say `createSongRegionFromSelection`. Rename keys when the compact view ships (already touching i18n then). Files: `apps/desktop/src/shared/i18n/{en,es}.ts`.

## On-disk format compatibility

`song.ltsession` v5 (current) uses these JSON field names:
- `regions: [{ id, name, startSeconds, endSeconds, transposeSemitones, warpEnabled, warpSourceBpm }]`

After the rename, the Rust struct will be `pub regions: Vec<Song>` (was `Vec<SongRegion>`). The serialized JSON shape is **unchanged** because `regions` is the field name, not the type name. **No format version bump needed for the rename alone.**

(Format bumps WILL be needed for steps 2 and 3 of the plan — master field and track overrides. Those should happen on their own commits, independent of this rename.)

## Execution order

Do this rename as **one large mechanical PR** — do not split. Splitting forces intermediate states that don't compile. Order within the PR:

1. **Delete the `Project` residual** in `model.rs` + `lib.rs` re-export.
2. **Rename types in `libretracks-core`**: `SongRegion` → `Song`, `Song` → `ProjectSession`. Update `model.rs`, `validation.rs`, `warp.rs`, `lib.rs`, internal tests.
3. **Rename `DomainError` variants** and their references.
4. **Rename function names** (`validate_song` → `validate_project_session`, `region_warp_ratio*` → `song_warp_ratio*`).
5. **Propagate through `libretracks-project`** (`song_store.rs`, `importer.rs`, `package.rs`).
6. **Propagate through `libretracks-audio`, `libretracks-remote`, `lt-audio-engine-v2`** (these only consume types, mostly find-replace).
7. **Propagate through `apps/desktop/src-tauri`**: `state.rs`, `audio_engine.rs`, `commands/timeline.rs`, `commands/project.rs`, `models/view.rs`, `error.rs`, `main.rs` registration.
8. **Propagate through frontend**: `packages/shared/src/models.ts`, `packages/shared/src/desktopApi.ts`, `apps/desktop/src/features/transport/**`, `apps/desktop/src/app/testDesktopApiMock.ts`, tests.
9. **Run `cargo build -p libretracks-desktop` and `pnpm -F desktop test`** to verify nothing was missed.

Estimated work: 2–4 hours focused, with ~80 files touched.

## What NOT to do

- Do not change the on-disk JSON field names. Schema stays at v5.
- Do not touch C++ engine code or `Session` naming there.
- Do not rename `ProjectError`, `DesktopError::Project`, or `projectCreated*` strings — different `Project` concepts.
- Do not split into multiple PRs.
- Do not bundle this with the master/overrides/compact-view feature work. This is a pure rename.

## Verification checklist before merging

- [ ] `cargo build --workspace` clean, no warnings about unused imports or dead code beyond what existed before
- [ ] `cargo test --workspace` passes
- [ ] `pnpm -F desktop test` passes
- [ ] Loading an existing `song.ltsession` v5 file works without migration
- [ ] Saving and re-loading produces a byte-identical file (modulo timestamps if any)
- [ ] `grep -ri "SongRegion" crates/ apps/desktop/src-tauri/ apps/desktop/src/ packages/` returns zero hits (excluding `docs/`, `apps/website/`, generated files)
- [ ] `grep -ri "region_id" crates/libretracks-core/ apps/desktop/src-tauri/ packages/shared/` returns zero hits in renamed APIs
