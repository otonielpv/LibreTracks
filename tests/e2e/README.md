# End-to-end tests (real app)

These specs drive the **real, compiled LibreTracks desktop app** — native audio
engine included — through Tauri's official WebDriver bridge. They are not a
browser-mocked frontend: `tauri-driver` launches the actual `.exe`, WebView2
hosts the window, and WebdriverIO pilots the live DOM.

```
WebdriverIO  ->  @wdio/tauri-service  ->  tauri-driver  ->  msedgedriver  ->  WebView2 (the app)
```

## Platform

**Windows only.** `tauri-driver` supports Windows and Linux; macOS's WKWebView
does not expose WebDriver, so these specs cannot run on macOS. The config throws
a clear error on non-Windows platforms via the service's own guards.

## Prerequisites

1. **Rust toolchain** (`cargo`) — already required to build the app. The service
   runs `cargo install tauri-driver` automatically the first time
   (`autoInstallTauriDriver: true`).
2. **WebView2 runtime** — ships with Windows 11 / modern Edge. The service
   detects its version and auto-downloads a matching `msedgedriver`
   (`autoDownloadEdgeDriver: true`), so you do **not** vendor a driver.
3. **A built app binary** at
   `target-desktop-native/release/libretracks-desktop.exe`. Build it with:

   ```bash
   npm run build:desktop:native
   ```

   Override the path with `LT_E2E_APP_BINARY=/abs/path/to/app.exe` if needed.

## Running

From the repo root:

```bash
npm run test:e2e
```

Run a single spec:

```bash
npx wdio run tests/e2e/wdio.conf.ts --spec tests/e2e/specs/app-launch.e2e.ts
```

The first run installs `tauri-driver` and downloads `msedgedriver`, so it is
slower. Launching the app also initialises the audio engine, which takes a few
seconds — timeouts are set generously (`startTimeout` 90 s, per-test 120 s).

## Layout

- `wdio.conf.ts` — runner config. Uses `@wdio/tauri-service` with
  `driverProvider: 'external'` (cargo-installed `tauri-driver`), which keeps the
  Rust app source untouched. (The default `'embedded'` provider would require
  compiling `tauri-plugin-wdio-webdriver` into the app.)
- `tsconfig.json` — standalone CommonJS/Node config for ts-node; deliberately
  separate from the app's ESM/JSX Vite tsconfig.
- `pageobjects/` — Page Objects. Locators prefer role / `aria-label` over CSS
  classes. The app's transport buttons are labelled in Spanish ("Reproducir",
  "Detener", "Metronomo", ...).
- `specs/` — `*.e2e.ts` test files:
  - `app-launch.e2e.ts` — smoke: the WebView boots and React renders.
  - `landing.e2e.ts` — the create/open-session landing renders, offers its four
    entry-point actions, shows the templates/recents columns, transport is
    disabled with no session, and the Settings panel opens.
  - `side-nav.e2e.ts` — the three side-nav panels (Biblioteca, Remote,
    Configuracion) exist and are enabled without a session, and each toggles its
    panel/modal open.
  - `settings.e2e.ts` — the Settings modal's six desktop tabs render, tab
    switching drives `aria-selected` and the visible panel, and the "Atajos"
    (shortcuts) tab lists actions, filters live from its search box, and exposes
    reset-all.
  - `library.e2e.ts` — the Library panel renders its header, its import and
    create-folder actions are disabled with no session (canImport is false), and
    it shows its empty-state note.
  - `session.e2e.ts` — creates a session and covers the with-session flows:
    timeline mount, track creation, WAV import into the enabled library,
    library-to-timeline placement and clip deletion, mute verified against the
    native rendered-track meter, explicit save plus switch/reopen persistence,
    and
    track rename/delete plus clip split/duplicate operations. Ruler seek,
    Ctrl+wheel zoom and horizontal-wheel pan are checked against the engine
    snapshot and committed timeline view. Space/Shift+Space shortcuts are
    checked against native playback and post-mix signal, including suppression
    while typing. Solo, zero/unity volume and full-left/full-right pan are
    measured on the native output bus. Transport and metronome also round-trip
    to the real backend/engine; virtual-folder and asset mutations are checked
    against the native library manifest. Section markers and song regions are
    created from the ruler context menu and verified against
    `song.sectionMarkers` / `song.regions`, a region's musical key is set
    and cleared from its context menu (verified against `region.key`), and a
    region transpose of +12 semitones is verified by capturing the real mixed
    output and confirming an FFT of the 440 Hz tone fixture shifts up an octave.
    Warp is verified the same way: with warp on and a 2x source-BPM stretch the
    pitch stays ~440 Hz (time/pitch decoupled, unlike vari-speed). The per-track
    transpose enable ("T") is verified under warp: with the region transposed
    +12, a track with T on renders ~880 Hz while a track with T off stays
    ~440 Hz, each isolated by solo and measured by FFT. The automation lane is
    covered too: adding the automation track, creating a cue, and creating a mix
    scene, each verified against `song.automationTrack` / `automationCues` /
    `mixScenes`. A user pad assigned the tone fixture is enabled and its
    ~440 Hz output confirmed by FFT (pads sound without play), and the voice
    guide toggle round-trips `settings.voiceGuideEnabled`. See "Session flows"
    below.
  - `timeline-edits.e2e.ts` — the edit-operation edge cases the happy path
    doesn't reach, run against their **own clean session** (a separate spec file
    relaunches the app, so the song starts pristine with a single region — see
    "Why a separate spec" below). Covers moving a single clip, clamping a clip
    dragged before t=0, a clip dragged past its region's end reshaping the
    region to cover it (the backend auto-extends, it does NOT reject), moving
    multiple clips in one batch and reassigning a clip to another track,
    extending a region's end, the backend REFUSING to shrink a region so a clip
    would dangle outside it, the "regions can't cross" invariant (a leftward
    move that would overlap the preceding region is rejected; a rightward move
    cascade-pushes the following region), trimming a clip window inside its
    source while a window past the decoded source is rejected, splitting a
    region and deleting the tail, moving/deleting a section marker, and a
    multi-selection clip delete. It also covers **undo/redo** against the
    backend history stack: a clip move undone then redone, a region creation
    undone (it disappears) then redone (it comes back), and the redo branch
    being cleared when a fresh edit follows an undo (a subsequent redo is a
    no-op). Each runs the SAME shared command a canvas drag/resize gesture (or
    the Ctrl+Z / Ctrl+Y shortcut) invokes and is asserted against the song
    model. Its flow module lives at `session/timelineEdits.flows.ts`
    (parameterised by the same `SessionFixture` contract) and builds/tears down
    its own disposable tracks/clips/regions.
  - `tempo.e2e.ts` — song tempo + time-signature edge cases, also in their own
    clean session (default 120 BPM / 4/4, no warp, no audio needed). Sets the
    base tempo and rejects a BPM outside 20..300, sets the base time signature
    and rejects an invalid string, and creates/deletes positional tempo and
    time-signature markers (asserting the backend rule that an upsert at
    startSeconds ~= 0 changes the BASE value rather than adding a marker). Flow
    module: `session/tempo.flows.ts`.
  - `templates.e2e.ts` — session template round-trip, in its own clean session.
    Builds a session with two named tracks, saves it as a `.lttemplate` at an
    explicit path (via the test-only `save_session_as_template_at` command,
    which bypasses the native save dialog), then creates a NEW session from that
    template and asserts the tracks survive by name while all clips are dropped
    (`strip_song_to_template` keeps structure/routing only). The create side
    uses the production `start_create_song_from_template_named_at`, which already
    accepts an explicit folder — note that folder must exist first (the backend
    does not mkdir the destination).
  - `track-structure.e2e.ts` — track structure edits, in their own clean
    session: reordering tracks (`move_track` with insertBefore), nesting an
    audio track inside a folder track (reparent via `parentTrackId`, asserted on
    `parentTrackId` + `depth`), and setting/clearing a track's and a clip's
    colour. All pure song-model edits asserted on `song.tracks` / `song.clips`
    (order = array position; `parentTrackId` / `depth` / `color` now exposed on
    the E2E song view). Note the backend upper-cases hex colours (`#RRGGBB`).
  - `section-markers.e2e.ts` — section-marker attribute edits, in their own
    clean session: setting a marker's kind + numbered variant, setting and
    clearing a colour override, and the EXCLUSIVE quick-jump digit assignment
    (giving a digit already held by another marker steals it from that marker).
    Section markers are pure Rust-model metadata, so these assert against
    `song.sectionMarkers` (kind/variant/color/digit now exposed on the E2E song
    view).
  - `export.e2e.ts` — region (song) `.ltpkg` export → re-import round trip, in
    its own clean session. A clip auto-creates a region; the flow exports it
    both metadata-only and with bundled audio (asserting a non-empty package
    each time, the audio-bundled one at least as large), then re-imports the
    audio-bundled `.ltpkg` back into the SAME session as a new song and asserts
    a new region + clip appear with the clip's audio resolving (not missing).
    Export uses the test-only `export_region_as_package_at` command (explicit
    path, no dialog); the re-import uses the production
    `start_import_song_package_from_path` (already path-based, no dialog).
  - `session-package.e2e.ts` — the whole-session `.ltset` export → import round
    trip ("build it at home, open it at the venue"), in its own clean session.
    Builds a one-track/one-clip/one-region session, exports it as a `.ltset`
    with bundled audio, then imports it into a brand-new folder and asserts the
    imported session is a genuinely new project carrying the track (by name),
    the clip and the region — with the clip's audio resolving (not missing),
    since it travelled inside the package. Uses the test-only
    `export_session_package_at` / `import_session_package_at` commands (explicit
    paths, no dialogs); the import ends with the same `project:load-complete`
    event as a real import.
  - `missing-file.e2e.ts` — the "locate a missing audio file" flow, in its own
    clean session. Creates a clip pointing at a real WAV, deletes that WAV from
    disk (so `getSongView` recomputes `isMissing = true` on the clip), writes a
    replacement WAV elsewhere, and calls `resolveMissingFile(old, new)` — then
    asserts the clip repoints to the new path and its `isMissing` flag clears.
  - `session/*.flows.ts` — domain modules registered by `session.e2e.ts`
    against the same native session. Add new open-session cases to the closest
    flow module (or create another one); keep `session.e2e.ts` limited to
    fixture lifecycle and registration order. Shared WAV/gesture helpers and
    the mutable fixture contract live in `session/support.ts`.

### Why a separate spec for timeline edits

The edit cases assert against an exact region/clip topology they build
themselves. Running them inside `session.e2e.ts` made them brittle: the ~25
flows before them leave the shared project with an unpredictable multi-region
layout (a single region can end up spanning tens of seconds), so a fixed clip
placement could land inside a pre-existing region and a move could straddle a
boundary that wasn't there on a previous run. A separate spec file gets a fresh
WebDriver session and native window, so the project starts with a pristine,
single-region song the flow fully controls. The flow still anchors its clip
placement to `max(regionEnd, clipEnd) + margin` read live, never a hardcoded
position.

## Session flows (window.__ltE2E)

Creating or opening a session normally opens a **native file dialog** (`rfd`)
that WebDriver cannot pilot. To drive session flows without it, the app exposes
a tiny automation seam on `window.__ltE2E` — but **only** under WebDriver
(`navigator.webdriver === true`), so it never exists in a real user session. It
is wired by `apps/desktop/src/features/transport/hooks/useE2ETestHooks.ts` and
exposes:

- `createSessionNamed(name, parentDir)` — create a session in a real folder.
- `openSessionFromPath(songFile)` — open an existing `.ltsession`.
- `importLibraryAudioFromPaths(paths)` — bypass only the native audio picker,
  then run the same placeholder/import/refresh pipeline as "Importar audio".
- `getSongView()`, `getTransportSnapshot()`, `getSettings()` and
  `getTimelineView()` — read-only backend observations used to prove commands
  completed beyond the DOM.
- `getTrackMeters()` — the latest native per-track peaks, used to assert
  rendered track activity and mute/solo suppression. These meters are pre-pan.
- `getAudioOutputMeter()` — final left/right output peaks after track mix,
  routing, pan and master gain; used when a test must measure the audible stereo
  result rather than the pre-pan track meter.
- `getLibraryState()` — assets and virtual folders read from the native
  library manifest after organization and deletion flows.
- `activatePadWithTone(path)` / `deactivatePad(id)` — create a user pad from an
  audio file, assign it to key C, and enable it through the production
  createUserPad → assignPadKey → loadPadKey → setPadConfigRealtime path (pads
  normally need a downloaded pack; a user pad needs none). Pads are
  transport-decoupled, so the pad sounds without play — the pad flow FFTs the
  captured output to confirm it renders the ~440 Hz tone.
- `createAudioTracksWithClips(requests)` / `createSongRegion(start, end)` /
  `createSectionMarker(at)` / `deleteTracks(ids)` — fixture builders so an edit
  flow can stand up its own disposable tracks/clips/regions/markers and tear
  them down without touching the canonical song. `createAudioTracksWithClips`
  returns the new clip ids and `createSectionMarker` the new marker id.
- `moveClip(id, seconds)` / `moveClipsBatch(moves)` /
  `updateClipWindow(id, tl, src, dur)` / `deleteClips(ids)` /
  `moveSongRegion(id, delta)` / `updateSongRegion(id, name, start, end)` /
  `deleteSongRegion(id)` / `splitSongRegion(id, at)` /
  `updateSectionMarker(id, name, at)` / `deleteSectionMarker(id)` — the SAME
  shared commands a canvas drag or resize handle invokes. The canvas
  hit-testing isn't piloted (WebDriver can't drive a `<canvas>`), but the
  backend edit and its invariants are. Each resolves to void; a backend
  rejection (a region collision, an out-of-source clip window) propagates so a
  spec can assert the negative case with `expect(...).rejects`.
- `undoAction()` / `redoAction()` — drive the backend undo/redo history stack
  (the same commands Ctrl+Z / Ctrl+Y invoke). Each resolves to void and is a
  no-op on an empty stack; the edit flow asserts the reverted/re-applied song
  model via `getSongView()`.
- `updateSongTempo(bpm)` / `updateSongTimeSignature(sig)` /
  `upsertSongTempoMarker(at, bpm)` / `deleteSongTempoMarker(id)` /
  `upsertSongTimeSignatureMarker(at, sig)` /
  `deleteSongTimeSignatureMarker(id)` — song tempo/time-signature commands. The
  base setters reject an out-of-range BPM (20..300) or an invalid signature
  ("N/D", both > 0); an upsert at `startSeconds ~= 0` sets the base value
  instead of creating a marker. Asserted against `song.bpm` /
  `song.timeSignature` / `song.tempoMarkers` / `song.timeSignatureMarkers`.
- `resolveMissingFile(oldPath, newPath)` — the "locate a missing audio file"
  command: repoint every clip (and library manifest entry) whose path is
  `oldPath` to `newPath`. Asserted against `clip.filePath` / `clip.isMissing`
  (both now exposed on the E2E song view).
- `saveSessionAsTemplateAt(path)` / `listSessionTemplates()` /
  `createSessionFromTemplate(templatePath, name, parentDir)` — the session
  template round trip without native dialogs. `saveSessionAsTemplateAt` is a
  test-only backend command (`save_session_as_template_at`) mirroring the
  dialog save; the create side is the production
  `start_create_song_from_template_named_at`.
- `exportRegionAsPackageAt(regionId, writePath, includeAudio)` — export a
  region (song) as a `.ltpkg` to an explicit path (test-only
  `export_region_as_package_at`, mirroring the dialog export). Resolves true on
  success.
- `setSectionMarkerKind(id, kind, variant)` / `setSectionMarkerColor(id, color)`
  / `assignSectionMarkerDigit(id, digit)` — section-marker attribute commands.
  Digit assignment is exclusive (steals the digit from any prior holder); a null
  colour/digit clears it. Asserted against `song.sectionMarkers`.
- `exportSessionPackageAt(writePath, includeAudio)` /
  `importSessionPackageAt(packagePath, targetSongDir)` — the whole-session
  `.ltset` export/import round trip without dialogs (test-only
  `export_session_package_at` / `import_session_package_at`). The import opens a
  new session via the production `project:load-complete` flow; its
  `targetSongDir` must NOT already exist (the import creates it).
- `createTrack(args)` / `moveTrack(args)` / `updateTrackColor(id, color)` /
  `updateClipColor(id, color)` — track structure commands (all pre-existing).
  `createTrack` makes an audio or folder track (with optional parent/after);
  `moveTrack` reorders/reparents; the colour setters take a `#RRGGBB` hex (the
  backend upper-cases it) or null to clear. Asserted against `song.tracks` /
  `song.clips`.
- `importSongPackageFromPath(packagePath, insertAtSeconds)` — import a `.ltpkg`
  song package into the OPEN session at a timeline position (adds a new song),
  via the production progress-worker flow (`start_import_song_package_from_path`,
  path-based, no dialog). Fire-and-forget; the flow ends on
  `project:load-complete`, so the caller waits on the model.
- `getAudioOutputCapture()` — the most recent ~0.5 s of final mixed stereo
  output (sample rate + L/R arrays), captured by a lock-free ring buffer in the
  C++ mixer's hot path. Used to FFT the rendered signal and prove an
  audio-affecting edit (e.g. transpose) actually changed the audio, not just a
  label. Metadata edits are asserted against the song model; anything that
  modifies audio is measured on the real output.

The mutating calls use the **same frontend handlers a user click invokes**;
the read-only calls only observe the resulting backend state. The flow
(invoke → `project:load-complete` event → snapshot applied to React state) runs
exactly as in production. `session.e2e.ts` creates its session inside a temp
folder it owns and deletes afterwards, so the app's data directory and the
user’s disk stay untouched. Because the seam lives in the frontend bundle, the
E2E binary must be rebuilt (`npm run build:desktop:native`) after changing it.

The open-session flow modules intentionally are not separate `*.e2e.ts` specs:
they build on one canonical project in a declared order. WDIO only collects the
top-level `session.e2e.ts`; its imported `registerSession*Flows` functions keep
domain code separate without repeating fixture setup or hiding cross-flow state
transitions.

  Specs run against **one long-lived app instance** with no reload between them
  (alphabetical order: `app-launch` → `landing` → `side-nav`). A panel one spec
  opens is still open when the next starts, so specs that open panels call
  `AppPage.resetShell()` in `before`/`after` to stay self-contained.

## Gotchas

- **Clearing a `type="search"` input** — neither `setValue("")` nor
  `clearValue()` reliably empties one in this WebView (the value survives and
  React's `onChange` never fires). Use select-all + Backspace via
  `browser.keys(["Control", "a"])` then `browser.keys(["Backspace"])`, which
  emits the input events React listens for. See the shortcuts filter test in
  `settings.e2e.ts`.

- **`__name is not defined` inside `browser.execute()`** — do not put *named*
  nested functions inside an `execute()` callback. ts-node/esbuild rewrites them
  with a `__name()` helper that is undefined in the WebView. Keep `execute()`
  bodies to plain expressions and anonymous arrows.
- **`captureFrontendLogs` is off** — the service's console-forwarding shim hits
  the `__name` issue above and floods the report. The app's own logs already go
  to `lt_*.log`.
- **Benign warnings** — "Tauri plugin not available" comes from the service's
  optional window-introspection features (`@wdio/tauri-plugin`), which we don't
  ship. `logLevel: 'error'` on the service keeps them quiet; they don't affect
  results.
- **One instance at a time** (`maxInstances: 1`) — the engine grabs audio
  devices, so parallel native windows would contend for them.
- **The `beforeCommand` window-probe patch** — before `$`, `findElement`,
  `elementClick`, `getTitle`, etc. the service runs an "ensure active window
  focus" check that `invoke`s `plugin:wdio|get_window_states`. We don't ship the
  plugin that answers it, so that invoke sits ~13 s until it times out **on
  every such command** — a spec touching a dozen elements took ~2.5 min. The
  `beforeCommand` hook in `wdio.conf.ts` short-circuits just that one probe to an
  empty result (the service reads it as "no window info, skip focus"), which
  brings the suite from ~2.5 min back to a few seconds. Remove the patch only if
  you add `tauri-plugin-wdio-webdriver` to the app (then the probe answers
  instantly on its own).
