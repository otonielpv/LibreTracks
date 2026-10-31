# Release Process

Repeatable steps to cut a new LibreTracks release (e.g. v0.0.X → v0.0.Y).
This is the authoritative checklist Claude should follow when the user
asks to "create a new version" or "tag vX.Y.Z".

## 0. Inputs to gather first

- Target version (e.g. `0.0.9`). Confirm with the user if not given.
- Scope of changes (use `git log <prev-tag>..HEAD` — do NOT trust memory).
- Whether to push and create the remote tag (releases pipeline triggers on tag push), or stop at local commits.
- Whether to bundle pending uncommitted work into a feature commit first.
- Which announcement piece this release gets (step 11): a **feature video**
  if it ships a new feature or another relevant user-visible change, a
  **poster** if it is fixes and polish only. Decide it from the release notes,
  and tell the user which one you picked.

## 1. Inspect what's actually changing

```bash
git status
git log <prev-tag>..HEAD --oneline                     # short list
git log <prev-tag>..HEAD --pretty=format:"=== %h %s ===" --stat   # detailed
git diff <prev-tag>..HEAD --stat                        # files touched
```

Cross-check against `docs/releases/<prev-tag>.md` — sometimes the prior
release notes already covered commits made before the actual tag commit.
The tag is the source of truth: anything in `git log <prev-tag>..HEAD`
is fair game for the new release notes.

**Features behind a flag.** `packages/shared/src/featureFlags.ts` lists
features that are built but hidden (no UI at all while their flag is
`false`). Check it every release: a feature planned for this version is
turned on here, together with the guard test next to it
(`featureFlags.test.ts`), in the release commit. Commits of a hidden feature
do NOT go in the release notes. As of 1.16.0 every flag is on:
`lyrics` and `songAnalysis` shipped in 1.15.0, `networkSessions`
(LibreTracks apps joining a host over the LAN) and `songTemplates` (songs
from a template, stems organised on drop, «one folder per song» layout) in
1.16.0.

## 2. Commit pending work (optional)

If there's uncommitted work that belongs in this release, commit it first
as a normal `feat:` / `fix:` / `perf:` commit. Keep the version-bump commit
clean and limited to release plumbing.

## 3. Write release notes

File: `docs/releases/v<NEW>.md`. Follow the existing structure:

```markdown
## Novedades de v<NEW>

- ... (Spanish bullet — cross-platform change, no label)
- 📱 Android: ... (only for phone/tablet-exclusive changes)
- 💻 Escritorio: ... (only for PC-exclusive changes — Windows + macOS + Linux)

## What's New in v<NEW>

- ... (English mirror)
- 📱 Android: ...
- 💻 Desktop: ...
```

### One unified list, tag only what's platform-exclusive

The in-app update modal now runs on **both** desktop and Android, but the notes
stay a **single list** per language (Ableton-style) — do NOT split into parallel
"Desktop" and "Android" blocks. A "no changes on your platform this release"
line only tells that user not to bother updating, and most releases share the
bulk of their changes across platforms anyway.

Instead, label a bullet **only when the change is exclusive to one side**:

- `📱 Android:` — phone/tablet-only (touch UI, storage picker, mobile audio).
- `💻 Escritorio:` / `💻 Desktop:` — PC-only, covering **all three desktop OSes**
  (Windows, macOS, Linux) — e.g. remote-control server, MIDI input.
- A change specific to one desktop OS keeps its own OS emoji as before
  (`🪟 Windows:`, `🍎 macOS:`) — that's a finer-grained case of a desktop-only
  bullet, not a reason to add a platform block.
- Cross-platform changes (most of them) get **no** platform label — they're the
  default and the reader assumes "everywhere".

Note: "Escritorio/Desktop" here means PC in general (the three OSes), **not**
Windows. Don't collapse it to Windows just because the installer bullet happens
to be Windows-specific.

The headings stay exactly `## Novedades de v<NEW>` / `## What's New in v<NEW>` —
no sub-headings anywhere in the file, because the parser
(`updateCheck.ts:extractReleaseNotesForLanguage`) captures from that heading up
to *the next heading of any level*; any `###` would truncate the modal body.

Rules:
- Bullets target end users, not developers. The reader is a musician, not a
  programmer: they do NOT know (and must not be told) what a thread pool, a
  block cache, a decoder, streaming starvation, an FFI boundary, or a worker
  is. Every bullet describes a change in **what the user feels**, never how it
  works under the hood.
- Translate the engineering change into the lived benefit. The pattern is:
  *"what annoying thing stops happening" / "what now works"* — not the fix.
  - "RAM+core-aware thread sizing for the fill pool" → "LibreTracks now adapts
    to your computer and runs smoother on modest PCs."
  - "pool of block-fill workers stops playback starvation" → "No more dropouts
    or silences during playback on slower machines."
  - "non-blocking .ltpkg import" → "Importing a song no longer freezes the app —
    you can keep working while it loads."
  - "batched track deletion" → "Deleting several tracks at once is now instant."
- Performance work especially must be reframed as a felt improvement. Never
  ship a bullet that names the mechanism (cache, pool, worker, decoder, meter
  internals). Say what the user now experiences: faster, smoother, no
  stutters, doesn't freeze, works well even on older/modest computers. When a
  change mainly helps lower-end hardware, say so in plain terms ("even on
  modest PCs" / "on older or slower computers") — it's a selling point users
  understand.
- If a commit has NO user-perceivable effect (pure refactor, internal
  diagnostics, dev-only logging), leave it OUT of the notes entirely. Don't
  invent a benefit for it. Diagnostics/telemetry that the user never sees is
  not a release-note item.
- "Faster project loading" beats "PCM cache reused across sessions".
- ES and EN sections MUST exist (the in-app update modal parses them by
  language — see `apps/desktop/src/shared/updateCheck.ts:SECTION_HEADINGS`).
- Headings must start with `## Novedades de v<NEW>` and `## What's New in v<NEW>` literally — the parser matches these.
- **A new feature says how to reach it, in one short clause.** Users read
  "Render a song's audio" and then cannot find it. After the benefit, add the
  path: `Cómo: clic derecho sobre la canción (mantén pulsado en el móvil) →
  "Renderizar audio…".` / `How: right-click the song (long-press on mobile) →
  "Render audio…".` Rules for that clause:
  - Very brief: the gesture and the path, nothing more. It is a signpost, not
    a tutorial — no step lists, no explanation of options.
  - Give the gesture for every platform the feature exists on, and check each
    one: mobile is NOT always "long-press = right-click". Songs open their menu
    with a long-press, but a selected track shows its actions in the bottom
    panel, behind the three dots ("Más acciones" /
    `mobile/MobileSelectionActionBar.tsx`) — v1.13.0 first shipped "Sumar a
    mono" as right-click only.
  - Quote menu items, settings and warnings **exactly as the app labels them**,
    in each language — check `apps/desktop/src/shared/i18n/es.ts` and `en.ts`
    rather than writing from memory. Settings are named as `Configuración →
    <pestaña>` / `Settings → <tab>`.
  - Verify the gesture in the code or the commit, not from what the feature is
    "probably" bound to (v1.13.0: render is a right-click, not a double-click).
  - Fixes and changes to existing behaviour need no "how"; only things the
    user has to go and find.
- Keep entries to 5–7 high-signal bullets total (one unified list, not per
  platform). Group related commits. State a shared change once, unlabeled —
  never duplicate it under a platform tag.
- Lead each bullet with a single relevant emoji (e.g. 🍎 macOS, 🥁 metronome,
  🩺 diagnostics, 📊 meters, 🛠️ internal) so the in-app modal reads nicely.
  For platform-exclusive bullets the leading emoji IS the platform marker
  (📱 Android, 💻 Escritorio/Desktop). Emojis go on the bullet text only —
  NEVER in the `##` headings, which the parser regex-matches and would break.
  Use the SAME emoji for a given item in both the ES and EN sections.
- Proofread the Spanish section for spelling and accents before moving on —
  the in-app update modal shows it verbatim to end users. Check tildes
  (sección, inglés, número, según, rápida, automático), `e` instead of `y`
  before words starting with "i"/"hi" (e.g. "español e inglés"), and ñ. Don't
  rely on it "looking right" — read each bullet once specifically for orthography.

## 4. Bump versions

Update ALL of these to the new version string (use Edit tool on each):

| File | Field |
|------|-------|
| `package.json` (root) | `"version"` |
| `apps/desktop/package.json` | `"version"` |
| `apps/website/package.json` | `"version"` |
| `packages/shared/package.json` | `"version"` |
| `apps/desktop/src-tauri/Cargo.toml` | `version = "..."` under `[package]` |
| `apps/desktop/src-tauri/tauri.conf.json` | `"version"` |
| `apps/remote/package.json` | `"version"` |
| `Cargo.lock` | the `libretracks-desktop` `[[package]]` entry's `version` |
| `apps/desktop/src-tauri/tauri.android.conf.json` | `"versionCode"` — **not** the version string, see below |

`apps/remote/package.json` must be bumped to the new version string along
with the rest (it historically lagged, but it should now stay in lockstep).
Don't touch other crates' versions unless something forced a bump there.

### Android's versionCode does not follow the version string

`autoIncrementVersionCode` is `false`, so the number is whatever is written in
`tauri.android.conf.json` and bumping `version` everywhere else does **not**
move it. Play rejects an AAB whose `versionCode` it has already seen, and the
rejection arrives at upload time, after the whole release is cut.

It reads as major · 1000000 + minor · 1000 + a counter: `1.11.1` shipped as
`1011002`, so `1.12.0` goes out as `1012000`. The only hard rule is that it
must strictly increase.

`android-release.yml` checks it against Play (`node scripts/google-play.mjs check`)
before the NDK build, so a forgotten bump fails in the first minute instead of
at upload. Locally the same check runs with the service-account key in
`PLAY_SERVICE_ACCOUNT_JSON`.

### iOS needs nothing here

`tauri.ios.conf.json` carries no version: `CFBundleShortVersionString` comes
from `tauri.conf.json` like everywhere else, and `CFBundleVersion` is the CI run
number, pinned by `ios-release.yml` at build time. So a release that is meant to
land on all three stores at the same number only has to get this table right —
iOS follows.

### Custom NSIS template (Windows)

`apps/desktop/src-tauri/installer/nsis-installer.nsi` is a **vendored copy** of
Tauri's official NSIS template with two local changes (search for `LibreTracks:`):
per-file-type icons (via `installer/nsis-hooks.nsh`) and skipping the
reinstall/uninstall page on a normal version upgrade (installs in place,
preserves user data). When bumping the Tauri CLI/bundler to a new minor, re-diff
this file against the upstream template for that version
(`crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi` in the
`tauri-apps/tauri` repo at the matching tag) and re-apply the two `LibreTracks:`
edits, so we don't drift from upstream installer fixes.

### libmpv (video output, Windows)

The Windows installer ships `libmpv-2.dll`, a prebuilt mpv from
[mpv-winbuild-cmake](https://github.com/shinchiro/mpv-winbuild-cmake) pinned by
tag, asset name and SHA-256 in `scripts/libmpv-fetch.mjs`. The release job runs
that script and `scripts/verify-libmpv.ps1`, which fails if the DLL is missing
from the installer or exports any FFmpeg symbol (its FFmpeg must stay static and
hidden, or it could collide with the engine's `avcodec-*.dll`).

Nothing to do on a normal release. To **bump mpv**: pick a newer
`mpv-dev-x86_64-*.7z` release, update `LIBMPV_WINDOWS` (tag, asset, sha256,
mpvCommit) in the fetch script, run it locally and
`scripts/verify-libmpv.ps1 vendor/bin/libmpv/windows/libmpv-2.dll`, then update
the mpv entry and the source offer in `THIRD-PARTY-NOTICES.md` (mpv commit,
FFmpeg version; `LIBRETRACKS_LIBMPV=... cargo run -p libretracks-video --example
spike -- info` prints both). Upstream deletes old releases: if the pinned asset
is gone and the CI cache is cold, upload the same `.7z` to a release of ours and
point `LT_LIBMPV_ARCHIVE` at it — the SHA-256 still has to match.

Linux uses the distro's libmpv (`recommends` in the .deb/.rpm), so it needs
nothing here.

### libmpv (video output, macOS)

The `.app` ships our own `libmpv.2.dylib` (universal, LGPL, macOS 12.0) in
`Contents/Frameworks`, built from pinned sources by `scripts/libmpv-macos.sh`.
The release job caches the result by that script's hash, so a normal release
reuses it; `scripts/libmpv-fetch.mjs` then runs `scripts/verify-libmpv-macos.sh`
(fails on a missing arch, a Homebrew/build-machine path, any exported symbol
that is not `mpv_*`, or a minimum macOS above 12.0) and the `.app` validation
checks it again inside the bundle.

Nothing to do on a normal release. A **cold cache** (the script changed, or the
cache expired) rebuilds FFmpeg, libplacebo, libass… for two architectures: the
macOS job then takes noticeably longer. To **bump a component**: change its
version and SHA-256 in the script (`shasum -a 256` of the tarball), build
locally on a Mac with `LT_LIBMPV_ARCH=arm64 node scripts/libmpv-fetch.mjs` or
the full universal build, run `cargo test -p libretracks-video` with
`LIBRETRACKS_LIBMPV` pointing at it, and update the macOS mpv entry in
`THIRD-PARTY-NOTICES.md`. On an mpv bump, check that the script's Swift-less
patch still applies (it fails loudly if not).

## 5. Update the user guide (mandatory when the UI changed)

The guide lives in `apps/website/src/content/docs/es/docs/` (Spanish) and
`apps/website/src/content/docs/docs/` (English, mirrored page for page). It is
a visual guide, button by button: every control is explained next to an
annotated screenshot of the real app, and gestures that are hard to describe
get a short clip. **A release that adds or changes something the user sees —
a new button, menu entry, panel, dialog, gesture, or a control that moved —
updates the guide in that same style.** A release whose new UI is not in the
guide is not finished.

Go through the release's user-facing commits one by one — it is easy to
document the headline feature and miss the four smaller ones. For each one:

1. **Find its page.** Toolbar, timeline, side nav/library, settings and the
   main screen live under `interface/`; workflows under `tasks/` and
   `start/`; features with their own page (pitch & warp, pads, voice guide,
   automation, remote, Live view, mobile) at the top level. A whole new
   feature gets its own page, linked from the sidebar and from `index.mdx`.
2. **Write the explanation** in the voice of the existing pages: what the
   control does, where it is, and the exact gesture for every platform it
   exists on (desktop click / right-click, mobile tap / long-press).
3. **Add annotated screenshots.** New captures go in the guide harnesses,
   never by hand, so the next re-shoot regenerates them:
   - Desktop: a step in `tests/e2e/specs/guide-shots.e2e.ts` (`shot()` with
     numbered boxes or a spotlight from `tests/e2e/utils/annotate.ts`,
     anchored on `data-lt-tour` targets from
     `features/tutorial/tourTargets.ts` — add a target if the new control has
     none). Output: `apps/website/public/guide/desktop/` and `desktop-en/`.
   - Mobile: a step in `tests/android/guide-shots/shots.ts`, on the Android
     emulator (AVD `LT_Midi_Test`, debug APK — see the header of that file).
     Output: `apps/website/public/guide/mobile/` and `mobile-en/`.
   - Crop to the area being explained: the guide column is ~720-900 px wide
     and a full window does not read there.
4. **Add a short clip (5–15 s, no narration) when a still cannot show it:**
   drags, gestures, anything that animates, a sequence of 2-3 clicks. Desktop
   clips with `Recorder` (`tests/e2e/utils/record.ts`, see `metronome-settings`
   or `marker-create` in guide-shots); mobile clips with the `screenrecord`
   helper in `shots.ts` (see `track-select-mix`). Embed them like the existing
   ones (`<video src="/guide/desktop/<name>.mp4" ...>`).
5. **Re-shoot what the change made stale.** A control that moved or was
   restyled leaves old images showing the old UI — grep the guide for the
   image names of the area you touched and re-run those steps too.
6. **Run both languages** (`LT_GUIDESHOTS_LANG=en` for the English set) and
   regenerate the Guides page cards with `node scripts/guide-cards.mjs` if a
   desktop image that has a card changed.

Name images and clips after the FEATURE, not the release, so a re-shoot
overwrites the same file and every page that references it stays current.
Both language trees must stay mirrored. Skip pure refactors, internal perf,
and features hidden behind a flag (step 1).

### Screenshots

Images live in `apps/website/public/screenshots/` and are committed. Capture
them from the REAL app with the harness at `tests/e2e/specs/doc-shots.e2e.ts`
(the docs sibling of the gitignored marketing-shots harness):

```bash
npm run build:desktop:native          # the harness drives the compiled binary
# Point it at a COPY of a real multi-song session — the bundled demo is one
# song and cannot show per-song columns or cue markers.
export LT_SHOTS_SESSION="/path/to/copy/song.ltsession"
LT_DOCSHOTS=1 npx wdio run tests/e2e/wdio.conf.ts \
  --spec tests/e2e/specs/doc-shots.e2e.ts
```

If the run dies in the `before` hook with `invalid session id`, the app did not
start: a previous run left an orphaned `libretracks-desktop` holding the
Remote's port 3030, and the real panic (`os error 10048`) is in
`%APPDATA%\com.libretracks.desktop\logs\errors.log`. Kill it and re-run:

```powershell
Get-Process libretracks-desktop -ErrorAction SilentlyContinue | Stop-Process -Force
```

It is opt-in (`LT_DOCSHOTS=1`) so a normal suite run skips it. Add a capture
when a release lands a feature the docs describe but cannot show, and name
files after the FEATURE, not the release, so a re-shoot overwrites the same
filename and every page referencing it stays current.

The two READMEs have their own harness, `tests/e2e/specs/readme-shots.e2e.ts`,
because those images are shot in BOTH languages from one session load — it
switches the app language through Settings > General between passes and puts
the original back afterwards:

```bash
LT_README_SHOTS=1 LT_SHOTS_SESSION="/path/to/copy/song.ltsession" \
  npx wdio run tests/e2e/wdio.conf.ts --spec tests/e2e/specs/readme-shots.e2e.ts
```

The Spanish set overwrites `screenshots/*.png` in place (README.es.md and both
user manuals already point there) and the English set lands in
`screenshots/en/` for README.md. The two Remote images come from headless
Chrome driven over CDP, because the Mixer sits behind a tab that has to be
pressed — Chrome's one-shot `--screenshot` flag can only ever photograph the
Controls tab.

Rules learned the hard way — a bad screenshot is worse than none:

- **Look at every image before committing it.** Several failure modes only
  show up visually: a settings control below the fold, a Remote layout
  clipping its columns at phone width, a session that reset between tests so
  the shot is of an empty app.
- **Never fabricate content for the shot.** Adding empty song regions to
  demo "resizable columns" photographs as an unfinished session, not a
  feature. If the local fixture cannot show the feature honestly, get a real
  session (`LT_SHOTS_SESSION=<a COPY of a .ltsession>`) or skip the image.
- **Watch for personal data.** The Settings panel shows the audio cache path,
  which contains the machine's account name. Check the frame before it ships.
- The harness writes to whatever session it opens — always point it at a copy.

## 6. Full local verification (mandatory before pushing)

**Nothing gets pushed until the whole local suite is green.** The tag triggers
the release pipeline, and a red pipeline on a pushed tag is an unfinished
release you then have to chase (step 9). Catching it here costs minutes;
catching it there costs a tag move plus ~40 minutes of CI.

This is not optional and it is not "whatever tests I touched": run **every**
tier, including the E2E, and read the summary lines at the end of each.

### 6.1 Types and lint

```bash
npm run lint                                   # desktop + remote + shared
npx tsc -p apps/desktop/tsconfig.json --noEmit
```

### 6.2 Every unit suite + the native engine

```bash
npm run test:full
```

`test:full` = `npm test` (shared, desktop frontend, remote frontend, the pure
Rust crates, and the desktop crate with `no-link`) **plus** the native tier
(`npm run test:native`: builds the real C++ engine and runs the DSP
doctest/ctest suite). Both tiers always run, so one pass shows the whole
picture; the exit code is non-zero if any tier failed.

### 6.3 The exact commands the CI `test` job runs

The orchestrator above is close to CI but not identical (CI adds `--locked` and
`lt-audio-engine-v2`). Run the real thing — running the crates piecemeal is not
the same check and has missed real breakage:

```bash
cargo test --locked -p libretracks-core -p libretracks-project \
  -p libretracks-audio -p lt-audio-engine-v2 --features lt-audio-engine-v2/no-link
cargo test --locked --lib -p libretracks-desktop --features libretracks-desktop/no-link
cargo check --all-targets
```

### 6.4 E2E against the real compiled app (Windows)

**This is the tier that matters most here, because CI does not run it.** The
`e2e-windows` job is disabled on release runs (`if: false` — see step 9), so a
local run is the *only* place the real, compiled, engine-linked app gets driven
before the tag goes out.

```powershell
# Build the binary the specs drive (the capture seam lets them read the mix).
$env:LIBRETRACKS_ENGINE_E2E_CAPTURE = "1"
npm run build:desktop:native

# From the repo root. ~20 specs, one app window at a time.
npm run test:e2e
```

Notes:

- **Windows only.** `tauri-driver` has no macOS support (WKWebView exposes no
  WebDriver), so on macOS/Linux this tier simply cannot run — say so in the
  release summary instead of pretending it passed.
- The screenshot harnesses (`doc-shots.e2e.ts`, `marketing-shots.e2e.ts`,
  `readme-shots.e2e.ts`) match the spec glob but skip themselves unless
  `LT_DOCSHOTS=1` / `LT_SHOTS=1` / `LT_README_SHOTS=1`. Seeing them skipped is
  correct.
- A single spec: `npx wdio run tests/e2e/wdio.conf.ts --spec tests/e2e/specs/<name>.e2e.ts`.
- **A leftover `libretracks-desktop.exe` breaks everything downstream.** An
  orphaned app process from an aborted run holds the binary (so
  `build:desktop:native` fails to link) and steals the WebDriver session. If a
  run dies oddly, check and kill it before re-running:

  ```powershell
  Get-Process libretracks-desktop -ErrorAction SilentlyContinue | Stop-Process -Force
  ```

- Full details, prerequisites and the per-spec inventory: `tests/e2e/README.md`.

### 6.5 Known flake

Don't block the release on a known flaky test — the
`timeline-tracks › pans the timeline by dragging over an empty lane`
test is flaky under parallelism but passes in isolation. Re-run it alone
to confirm it's not a real regression. Anything else red is a real failure:
fix it, or drop it from the release, before you tag.

### 6.6 The Android compile trap (bit v1.10.0)

`cargo check --all-targets` on desktop does **not** compile anything behind
`#[cfg(target_os = "android")]` (`platform/android_audio_devices.rs`,
`platform/mobile_files.rs`), and `android-release.yml` only runs by hand. So an
Android-only compile error is invisible until you are mid-release.

v1.10.0 hit exactly this: a field added to `DeviceInfo` was wired into the JUCE
path but not into the Android enumeration that builds the struct by hand →
`error[E0063]` after the tag was already pushed. **If a release touches a shared
struct or an FFI/snapshot type, grep for the other constructors before tagging:**

```bash
grep -rn "DeviceInfo {" --include=*.rs apps crates   # or whatever type changed
```

With the Android NDK installed you can check it properly; otherwise compare the
struct's fields against each hand-written initializer, field by field.

## 7. Commit and tag

```bash
git add -A   # OR add specific files; never rely on -A blindly
git commit -m "$(cat <<'EOF'
chore: release v<NEW>

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
git tag v<NEW>
```

Tag name format: `v<NEW>` (with the `v` prefix). The GitHub Releases page
and the in-app update check both rely on this format.

## 8. Push (the default end-to-end flow)

**Precondition: step 6 ran and everything was green.** Do not push a tag on a
suite you didn't run — the E2E in particular, since CI doesn't run it. If a
tier could not run at all (E2E on macOS/Linux), say so explicitly when handing
the release back instead of letting it read as passed.

The normal release flow is **commit → tag → push both**, not stopping at
local commits. Unless the user explicitly says "local only" / "don't push",
push `main` and the tag:

```bash
git push origin main
git push origin v<NEW>
```

Pushing the tag triggers the release pipeline (macOS bundle validation,
native lib linking, downloads counters). The pipeline ends in a **draft**
release, not a published one (see "Publishing the draft" below), so a green
run is not yet a release users can see. Gate: do the local commit + tag, and
push as part of the same release request unless told otherwise — don't ask
again mid-flow once the user has asked for a release.

### Publishing the draft (the user's step, not yours)

`publish-release` creates the GitHub release as a **draft** with every
installer attached. Nothing sees a draft: the in-app update check reads
`releases/latest` (drafts excluded) and the download page filters drafts out.
That lets the whole CI run while the App Store and Google Play reviews are
still pending.

The user publishes it when the stores approve: GitHub → Releases → the draft
→ "Publish release". That click is the go-live:

- the in-app update modal starts offering the version;
- `website-deploy.yml` fires on `release: published` and rebuilds the
  download page (it used to be the `notify-website` job at the end of
  `release.yml`).

Do not publish the draft yourself unless the user explicitly asks. Re-running
the pipeline (tag moved after a fix) replaces the previous draft, but it
refuses to touch a release that is already published.

Once the tag is pushed you own the pipeline until it's green: go straight to
step 9 and stay on it (monitor → fix → move tag → repeat) until CI passes.

## 9. Watch the CI and fix until it's green (mandatory)

Pushing the tag kicks off `.github/workflows/release.yml`. **This is not
fire-and-forget.** After pushing the tag you MUST monitor the run to
completion and keep iterating — fix the failure, move the tag, re-watch —
until the release pipeline goes green. A pushed tag with a red pipeline is an
unfinished release. The loop is:

1. Watch the run.
2. If a (non-`continue-on-error`) job fails, **cancel the whole run
   immediately** — don't wait for the sibling jobs to finish, they're now
   wasted minutes on a release that won't ship as-is. Then read the failed
   job's logs and fix the cause:

   ```bash
   gh run cancel <run-id>
   ```

3. Commit the fix, MOVE the tag to the new commit, force-push it (see below).
   That starts a fresh run.
4. Go back to step 1. Repeat until the pipeline succeeds.

Note: only cancel for a *real* failure on a blocking job. A `continue-on-error`
job going red does NOT fail the release — don't cancel for those; let the run
finish and publish. (Since v1.14.0 a tag runs no such leg: the `macos-15-intel`
validation build was dropped from releases, see below.)

Auth — the GitHub token lives in the Windows Credential Manager; pull it from
there. `gh auth login` may reject that token for missing the `read:org`
scope. Don't fight it — extract the token and pass it per-command via
`GH_TOKEN` instead (it skips scope validation):

```bash
export GH_TOKEN=$(printf "protocol=https\nhost=github.com\n\n" | git credential fill 2>/dev/null | sed -n 's/^password=//p')
gh run list --limit 5
gh run view <run-id>                 # per-job status; find the X
```

If `git credential fill` returns nothing, the token isn't cached under
`github.com`; fall back to whatever PAT the user provides, but the credential
manager is the default source — don't ask the user first, try it.

Reading logs of a job in an **in-progress** run: `gh run view --job
<id> --log-failed` refuses until the whole run finishes ("logs will be
available when it is complete"). Use the API endpoint instead, which
serves a completed job's log even while sibling jobs still run:

```bash
gh api repos/otonielpv/LibreTracks/actions/jobs/<job-id>/logs | grep -iE 'error|##\[error\]'
```

Jobs and what each one gates (as of v1.10.0):

| Job | Blocks the release? |
|-----|---------------------|
| `test` | Yes — unit suites (JS + Rust + native ctest) on all three OSes. |
| `e2e-windows` | **Disabled** (`if: false`) — see below. |
| `build-release-assets` | Yes. Windows, universal macOS and Linux; all three publish. FFmpeg (macOS/Linux), libmpv (macOS) and the vcpkg packages (Windows) come from caches that `warm-release-caches.yml` keeps on `main` — a tag can't reuse another tag's caches. A "Cache not found" on those steps means the warm run is missing or its keys drifted from release.yml. |
| `publish-release` | Needs `test` and the publishable `build-release-assets` legs green. Creates a **draft**; the user publishes it. |

`e2e-windows` is a **separate job on purpose**. It used to be two steps at the
end of `test`, both pinned behind `continue-on-error` because that job has no
vcpkg: `build:desktop:native` configures the engine with FFmpeg ON, CMake then
fails looking for PkgConfig, and the E2E never actually gated anything. The
standalone job replicates the release setup (vcpkg + ASIO SDK + Bungee
runtime), so the binary under test is the one users get. It only needs `test`,
so it runs in parallel with `build-release-assets` and does not lengthen the
path to the bundles. It uploads `e2e-windows-logs` (the app's `lt_*.log`) with
`if: always()` — grab that artifact before theorising. (`always()`, not
`failure()`: a job killed by `timeout-minutes` counts as cancelled, and the
first hang lost its logs to exactly that.)

**Current status (v1.10.0): builds fine, cannot run.** The 12 setup steps pass
— the engine compiles with FFmpeg ON, so the vcpkg problem is solved — but the
suite never gets a WebView session on the runner:

```
session not created: DevToolsActivePort file doesn't exist
```

Every spec retries 3× at 60s and moves on, so the step burns ~45 minutes and
runs zero tests.

**Ruled out, with evidence** (from `e2e-debug.yml`, run 31683837921):

- *Not the app, and not a headless runner.* Launching the binary directly with
  `Start-Process` prints `Still running after 25s — process survives`, and
  `[Environment]::UserInteractive` is `True`.
- *Not version skew.* The service downloads a matching msedgedriver; WebView2
  is 150.0.4078.105 on both sides.
- *Not `Binary Permissions: 666`.* That red line is a POSIX check the service
  prints on Windows, where it does not apply ("run chmod +x on Unix systems").

By elimination the fault is in the `tauri-driver` → `msedgedriver` → WebView2
attach, not in LibreTracks. Next hypothesis is WebView2 flags
(`--no-sandbox`, `--disable-gpu`), already wired as the debug workflow's
`extra_browser_args` input → `LT_E2E_BROWSER_ARGS` → `ms:edgeOptions.args`.

The job is therefore **disabled on release runs (`if: false`)**, not merely
non-blocking. Leaving it to run cost ~45 runner-minutes per release to validate
nothing, and — because a job killed by `timeout-minutes` counts as *cancelled*
— it marked the entire run red: v1.10.0 published all nine assets correctly and
still shows as cancelled in the run list.

To re-enable, **all three changes go together**: `if:` back to
`startsWith(github.ref, 'refs/tags/v')`, delete `continue-on-error`, and put
`e2e-windows` back in `publish-release`'s `needs`.

Triage before "fixing": separate a real code/workflow bug from a transient
runner flake (DNS/network on a download step reads as a code error but isn't
ours). Prefer a structural fix that removes the flaky work over a blind retry
— e.g. the Intel runner was pulling the arm64 Rust std it never compiles
with; scoping the target install per-runner deleted the download that flaked.

**The `macos-15-intel` leg is no longer part of a release** (dropped after
v1.14.0). It built an x86_64-only app that is never published — Intel Macs
get the universal DMG from `macos-latest`, whose bundled dylibs step 4c checks
for both slices — and it never launched it. It still cost ~27 minutes per
tag: the slowest runner, building FFmpeg + libmpv + the app cold (caches are
scoped to the tag ref, so no release ever reuses the previous one's), and the
draft waited for it. It also had runner-specific flakes of its own
(`curl: (35)` fetching ffmpeg.org, twice in v1.10.0). To check that the app
still builds on an Intel host, run the Release workflow by hand from Actions
with **macos_intel** ticked.

Re-trigger after a fix: commit the fix, then MOVE the tag to the new
commit and force-push it (the pipeline keys on the tag). The release-create
step already deletes-then-recreates the GitHub release, so a moved tag
regenerates it cleanly:

```bash
git push origin main
git tag -f v<NEW>
git push origin v<NEW> --force
```

### The iOS and Android builds are started by hand

The tag only starts `release.yml`. `ios-smoke.yml` (the unsigned AltStore
IPA), `ios-release.yml` (the signed App Store build) and `android-release.yml`
(the signed Play build) are `workflow_dispatch` only: run them from the tag,
`gh workflow run <file> --ref v<NEW>`. None of them blocks the desktop release:

- `ios-release.yml` **skips itself with a warning** when the Apple secrets are
  missing. With them it builds, verifies and validates the IPA, and its
  `upload` input (on by default) sends it to TestFlight. Setup lives in
  [APPLE_SIGNING.md](./APPLE_SIGNING.md).
- `android-release.yml` checks the `versionCode` against Play first, then
  builds the AAB and sends it to the chosen `track` (see step 14).

For a release that goes to the App Store, upload the build made **from the
tag**, not one from a later commit on `main`: the version App Store Connect
shows is the one compiled into that IPA, and it is what has to match the DMG
and the Play listing.

Watch them like any other job, but do not move the tag for an iOS failure
unless the release is meant to ship to the store: the desktop artifacts are
unaffected.

## 10. Update the knowledge graph

```bash
graphify update .
```

(AST-only, no API cost. Per the project CLAUDE.md, run this after touching
code so future sessions stay in sync.)

## 11. Make the announcement piece: feature video OR poster (mandatory)

Every release gets ONE announcement piece, chosen in step 0:

- **New feature or relevant user-visible change → a feature video** (11a),
  Spanish only for now. No poster for that release.
- **Fixes, performance and polish only → the posters** (11b), as before.

When in doubt, it is a video: a feature announced only with a picture gets
answered with "¿cómo se usa?".

### 11a. Feature video (Spanish)

A short narrated video that shows the new feature working in the real app
and explains how to use it: where it is, what to press, what happens. It is
the release's announcement, not a full tutorial — aim for 1–2 minutes, one
release headline (or two or three closely related ones), and nothing else.

**Which platforms it shows** follows where the feature exists — check the
platform tags of its bullets in `docs/releases/v<NEW>.md` and the code:

- Desktop and mobile → the **desktop part first, then the mobile part**,
  with a title card in between ("Y en el móvil").
- Only desktop → only desktop. Only mobile → only mobile.

Structure: intro card (feature name + one line of what it is for) → the
scenes, one action per scene, each with its sentence of narration → **fixes
card** → end card (`libretracks.com` + where to download).

The **fixes card** lists the release's user-visible fixes (the ones in the
"🔧 Y además" bullet and the Facebook post's "Correcciones" block), one short
line each, on screen long enough to read. The narration does not read them
out: one sentence for the whole card ("Y además, un buen montón de
correcciones…") is enough. The user wants them seen, not explained. In the
desktop recorder it is a `listCard()` fed by a `FIXES` list. The narration explains the HOW with
the same gestures as the release notes; on mobile it says tap / long-press,
not click.

It is built with the same pipeline as the "Primeros pasos" tutorial
(`scripts/tutorial-video/`, recorded scenes + edge-tts narration + burnt-in
subtitles), so it looks and sounds like the tutorials already on the site:

```bash
# 1. The script: one scene per action, ids in playback order (desktop scenes
#    first, then mobile). Voice es-ES-AlvaroNeural, like primeros-pasos.es.json.
#    Versioned next to the tutorial scripts:
#    scripts/tutorial-video/novedades-<NEW>.es.json
# 2. Narration (writes narration/<id>.mp3 + durations.json, which the
#    recorders read so each scene lasts at least as long as its sentence):
node scripts/tutorial-video/tts.mjs scripts/tutorial-video/novedades-<NEW>.es.json \
  marketing/video-<NEW>/narration
# 3a. Desktop scenes, from the compiled app (npm run build:desktop:native first):
LT_RELEASEVIDEO=1 LT_TUTORIAL_DIR=marketing/video-<NEW> LT_SHOTS_SESSION=<COPY of a real session> \
  npx wdio run tests/e2e/wdio.conf.ts --spec tests/e2e/specs/release-video.e2e.ts \
  --mochaOpts.timeout 1800000
# 3b. Mobile scenes, on the Android emulator (same AVD and debug APK as the
#     mobile tutorial and the guide shots):
LT_TUTORIAL_DIR=marketing/video-<NEW> node tests/android/release-video/record.ts
# 4. Join scenes + voice + app audio + subtitles:
node scripts/tutorial-video/compose.mjs scripts/tutorial-video/novedades-<NEW>.es.json \
  marketing/video-<NEW> marketing/video-<NEW>/novedades-<NEW>.mp4
# 5. Take out the dead air (mandatory): the recordings pad every scene to its
#    narration and hold after clicks and loads, which adds up to a minute of
#    silent, still picture. This cuts only where there is no sound AND nothing
#    moves, so no sentence or app sound is split. The .tight.mp4 is the one
#    that gets published.
node scripts/tutorial-video/tighten.mjs marketing/video-<NEW>/novedades-<NEW>.mp4 \
  marketing/video-<NEW>/novedades-<NEW>.tight.mp4
```

Both recorders write into the same `marketing/video-<NEW>/scenes/`, so one
script and one `compose.mjs` run produce the whole video in order.

Two things in the script JSON keep the voice and the subtitles right:

- **"display"**: write names and versions the way the voice should say them
  and map them back for the subtitles, e.g.
  `"display": { "Libre Tracks": "LibreTracks", "uno punto catorce punto cero": "1.14.0" }`.
  The voice mangles "LibreTracks" and reads "1.14" as "una catorce"; the
  version is always said and shown in full (1.14.0).
- **per scene "subtitles"**: `"top"` when the scene shows a panel at the
  bottom of the app (the arrangement editor), `"mobile"` for every phone
  scene, which puts them in the black band above the letterboxed phone instead
  of over its bottom bar.

Recorder traps already paid for: a pause after a click (`settleMs`) records no
frames, so a menu that must be read needs `rec.hold()`; a WebDriver click on a
menu item that opens a submenu can land on the submenu's first item (use a
plain DOM click); handles that capture the pointer (song fades, song edges)
need `rec.dragToCdp`; and a song with an arrangement applied refuses edits, so
demo other edits on a song without one.

A scene that waits for something slow (measuring songs, loading audio) still
records the whole wait, which is moving (a progress bar) and so survives
`tighten.mjs`. Trim that scene's MP4 by hand before `compose.mjs` (keep the
start and the result, drop the middle). In 1.14.0, «Nivelar canciones» went
from 97 s to 17 s that way.

**What the video covers.** Every user-visible novelty of the release, not
just the headline: go through the release notes bullet by bullet.

**Record the first-run state, not your machine's.** A one-time step that a
new user will meet (a download, a permission, a setup notice) must appear in
the video and be explained, including what happens if they skip it, even
though the development machine already went through it. In 1.15.0 the
speech recognition model for «Analizar canción» was already on disk, so the
recorder sets the model file aside in `before()`, the scene shows the
download notice, says what the model is for and what is lost without it,
downloads it on camera (the wait is cut), and `after()` puts the original
back if the download did not finish.

**A native `<select>` never shows its list in a frame**: WebView2 draws it
outside the page. To show the options, step through them with
`selectByIndex()` (each one shows in the field) and put the user's value back;
the app's own context submenus are DOM and do show.

**No debug APK? Record the phone layout from the desktop app.** The frontend
switches to its phone layout from an Android user agent, so CDP
`Emulation.setUserAgentOverride` + `setTouchEmulationEnabled` + a landscape
phone `setDeviceMetricsOverride` (915x412 @2.6), then a reload and the session
reopened, give the real phone UI on the desktop engine. Gestures that only
answer to touch (area selection) need `Input.dispatchTouchEvent`. Record that
scene LAST (it changes the page for good) and letterbox it to 16:9, with
`"subtitles": "mobile"`. 1.15.0 did this because whisper-rs-sys cannot be
cross-compiled for Android on Windows; desktop-only backends mean anything that
needs the phone's own storage or hardware still needs the emulator.

**Modifier clicks (Ctrl/Shift) go in ONE `performActions` call** with the key
and the pointer as two sources. `Recorder.clickAt()` ends with `perform()`,
which releases every key, so a Ctrl pressed before two `clickAt()` calls only
reaches the first click (1.15.0 selected two markers out of three). A feature
that exists on desktop AND mobile is shown once (desktop) unless the mobile
gesture is genuinely different; mobile-only features get their own mobile
scene. For a mobile feature that is only a menu away, a short scene saying
where it is beats walking through the whole flow. 1.14.0 ended at ~4 min
after the dead air was cut; that is fine for a release with many features.

The two recorders are **rewritten every release** for that release's feature
(git history keeps the previous ones). Build them from the tutorial
recorders, which already solve every hard part: `scene()`, `titleCard()` and
`listen()` (app audio through `loopback.py`) in
`tests/e2e/specs/tutorial-video.e2e.ts` and
`tests/android/tutorial-video/record.ts`; visible touches
(`setTouchRipple`) and the rest of the device handling in
`tests/android/lib/device.ts`. Keep their partial runs (`LT_TUTORIAL_SCENES`
on desktop; `--dry` and scene ids on mobile): get each scene right with them
before recording the lot.

Mobile traps already paid for (details in the headers of those files):

- The app runs **landscape** on the phone; record it that way.
- The emulator's own audio is unusable. If a mobile scene plays music, give
  it the desktop twin's recording with `scripts/tutorial-video/borrow-audio.mjs`
  (its `TWINS` table maps phone scene → desktop clip).
- `screenrecord` must be stopped on the device before the local adb, or the
  MP4 has no index.
- The app language is set with `cmd locale set-app-locales`, not through
  the settings.

The output stays in `marketing/video-<NEW>/` (gitignored). Same rules as the
poster: **watch the whole video before handing it back** (a scene that
recorded an empty app or a wrong state only shows up there), use a real
session — never fabricated content — and check no frame shows personal data
(paths with the account name, file dialogs).

Hand back the MP4 together with the Facebook draft (step 12). The video is
16:9; if a vertical cut for Reels is wanted, it is laid out with the 9:16
templates of the tutorial kit (`scripts/tutorial-kit/`).

### 11b. Posters (fixes-only releases, Spanish and English)

A release without a feature video gets two matching square announcement
images, generated with the poster tool: the Spanish one goes with the Facebook
draft (step 12), and the English one goes with the default Reddit draft (step
13). They share the same theme, screenshot and layout; only the visible copy
changes.

The layout is 1080x1080 but the capture runs at 2x, so the PNG lands at
2160x2160 (~1.2 MB). That density is for the SCREENSHOTS, not the type: an app
window is ~1900px wide and the poster shows it at ~860, so at 1x Chrome threw
away more than half of every UI label and the app photographed as mush. Pass
`--scale 1` only if something specifically needs a 1080x1080 file.

```bash
mkdir -p marketing/poster-<NEW>
cp <a real screenshot> marketing/poster-<NEW>/shot.png
# write marketing/poster-<NEW>/poster.json and poster-en.json (see below), then:
node scripts/poster/make-poster.mjs --spec marketing/poster-<NEW>/poster.json
node scripts/poster/make-poster.mjs --spec marketing/poster-<NEW>/poster-en.json
```

`marketing/` is gitignored, so the PNGs stay out of the repo; the generator
under `scripts/poster/` is versioned, so any release can be re-rendered.

### Every poster must look different

This is the point of the tool, not a nice-to-have: a feed of identical posters
stops being read. `scripts/poster/themes.mjs` holds seven themes, each with its
own palette, background motif AND layout (`spotlight`, `bleed-right`, `split`,
`tilt`, `devices`, `list`, `cover-top`). `pickTheme()` derives one from the version number —
weighted so consecutive releases never land on the same theme — so the default
already varies release to release and re-running for the same version reproduces
the same poster.

- Let the version pick the theme. Override with `--theme <id>` only when a
  release deserves a specific look (`--list-themes` shows them all).
- When they start feeling familiar, **add a new theme** rather than re-using
  one. A theme is a palette + a motif + a layout block in `render.mjs`; adding
  one is what keeps this from going stale. (Note that adding a theme reshuffles
  what `pickTheme()` returns for every version, since it indexes into the list.)
- `showcase` (layout `devices`) is the odd one out: it stacks THREE screenshots
  — desktop behind, tablet and phone in front — for a release whose headline is
  the same feature on every screen size.
- `aurora` (layout `cover-top`) is the only one that leads with the screenshot:
  a full-bleed band across the top, copy underneath, features in a 2x2 block.
  It is also the only layout that crops from the CENTRE, so give it a whole
  window with its subject in the middle — a dialog, the song being edited — not
  a strip cropped by hand. The copy column is half the usual width there: keep
  each feature `body` to ~16 characters and typeset the headline in three short
  lines, or they wrap. It reads the extra ones from the
  optional `shots` array in the spec, mid-size device first, phone second.

### The copy file

Write `poster.json` for Spanish, then copy it to `poster-en.json` and translate
the visible copy. Keep the same `theme`, `shot`, `shots`, layout and features;
set `out` on the English copy so it ends in `-en`.

```json
{
  "version": "1.10.1",
  "badge": "GRATIS Y OPEN SOURCE",
  "brandTag": "MULTITRACK PARA DIRECTO",
  "headline": "Mezcla varias
pistas a la vez",
  "headlineAccent": ".",
  "sub": "Selecciona, ajusta una, y todas te siguen.",
  "shot": "shot.png",
  "shots": ["tablet.png", "phone.png"],
  "features": [{ "title": "Mezcla en grupo", "body": "volumen, pan, mute, solo" }]
}
```

- `headline`: the release's ONE headline change, 2 short lines. `
` is a
  deliberate break — poster headlines are typeset by hand, not left to wrap.
- `shots`: optional, only read by the `devices` layout. Ignored elsewhere.
- `chip`: optional. Replaces the version pill with free text.
- `layout`: optional, overrides the theme's layout. The one layout that is
  NOT built around a screenshot is `art`, for posters that announce no
  feature at all — a donation drive, a store launch. A release poster shows
  the thing that changed; those have no such thing, and bolting a session
  screenshot onto them says nothing. An `art` spec omits `shot` and names
  `art` instead (a piece in `scripts/poster/art.mjs`), plus the optional
  `artWidth`, `artCaption`, `artLabel`, `artStamp`, `artStores`, `headlineSize`, and
  `badges`.
- `badges`: optional, only read by the art pieces. Third-party logos
  (Ko-fi, Google Play, App Store) sitting next to the spec, embedded exactly
  as downloaded from each brand's own page — never redrawn, recoloured or
  retyped, which is what their usage rules require. Each poster folder's
  README records where its badges came from.
- `features`: exactly 4, drawn from the Spanish bullets of
  `docs/releases/v<NEW>.md`. Keep each `body` to ~4 words AND each `title` to
  ~2 so the four columns stay on one line; a 2-line wrap in one column and not
  the others looks broken.
- Spanish uses the Facebook post's voice; check its accents. English mirrors
  its meaning in natural English for Reddit. Translate `badge`, `brandTag`,
  `headline`, `sub` and the feature copy; use
  `"out": "cartel-<NEW>-<theme>-en"` in `poster-en.json` so the Reddit
  generator can select it unambiguously.

Working examples of all of the above: `marketing/post-donaciones`,
`marketing/post-tiendas-moviles` and `marketing/post-testers-android`. All
three also set `theme` and `out` by hand, since with no version there is
nothing to derive them from.

An `art` poster is sized by the copy AND by the art: a piece drawn from its
own width can overflow the art box onto the feature strip below it. The
`testers` piece takes its height from the box for exactly that reason. If a new
piece is taller than it is wide, size it the same way rather than tuning
`artWidth` until it happens to fit.

### Look at the PNG before shipping it

Same rule as the docs screenshots, for the same reason — and the poster is the
more public of the two:

- **Open the image.** Layout bugs only show up visually: a headline overlapping
  the screenshot, the app cropped at its top edge, a column wrapping to 2 lines.
- **Never fabricate content.** Use a real session, like the docs shots do.
- **Watch for personal data** in the screenshot (paths with the account name).

The intermediate `.html` is kept next to the PNG on purpose: when a frame comes
out wrong, open it in a browser and fix the CSS rather than guessing.

## 12. Hand back a Facebook announcement draft

End-user audience, natural language, minimal emojis, no version-bump
jargon. Lead with the most relatable improvement (loading speed, new
in-app behavior), not internals. Spanish by default unless told otherwise.
Do NOT post it anywhere; just hand back the text. Hand it back together
with the piece from step 11 (the feature video or the Spanish poster) — the
post and the piece go out together, so the video's headline feature (or the
poster's headline) and the post's first bullet should agree.

Use this exact template (matches the channel's voice):

```
Hola @todos!!
Hemos sacado una nueva versión v<NEW> estos han sido los cambios:
- <emoji> <bullet 1 — most relatable improvement first>
- <emoji> <bullet 2>
- <emoji> <bullet 3>
- <emoji> <bullet 4>
- <emoji> <bullet 5 — optional, max ~5 bullets>

🔧 Correcciones:
- <fix 1 — one short line>
- <fix 2>
- <fix 3 — max ~5 fixes>

Puedes descargar la nueva versión aqui:
https://libretracks.com/es/download/
```

Notes:
- **Every change bullet leads with an emoji.** Reuse the one the same item already
  carries in the Spanish section of `docs/releases/v<NEW>.md` so the post and
  the in-app modal stay visually consistent. This applies to the change bullets only —
  the greeting, the fix lines, the closing line and the URL stay plain.
- Bullets are user-facing benefits, lifted from the Spanish section of
  `docs/releases/v<NEW>.md` but rewritten for a conversational tone.
- **Keep the "how" for new features**, shortened to fit the post: the same
  gesture and path as the release notes (e.g. `Clic derecho en la canción
  (mantener pulsado en el móvil) y "Renderizar audio…"`). A post that announces
  a feature without saying where it is gets answered with "¿dónde está?".
- Keep accents on key words ("rápida", "más", "directo"), but it's OK to
  leave a few off — the original channel does too. Don't over-correct.
- **Always include the "🔧 Correcciones" block** when the release fixed
  anything users could notice. Source: the bug fixes folded into the
  "🔧 Y además" item of `docs/releases/v<NEW>.md` plus `fix(...)` commits
  since the previous tag (`git log v<PREV>..v<NEW> --oneline | grep fix`).
  One short line per fix, no emoji (the block header carries it), no "how",
  no internals — say what the user notices now ("El botón Anterior vuelve a
  la canción anterior"), not what was wrong in the code. Pick the ~5 most
  noticeable; new small features from "Y además" do not go here. Call it
  "Correcciones", never "Arreglos" — that word is a feature name since 1.14.0.
  Omit the block only if the release has no user-visible fix.
- Download URL is the localized Spanish page: `/es/download/`, not `/downloads`.
- No closing line, no signature, no hashtags. The template ends at the URL.

### The store launch is a separate post

The desktop release and the Google Play / App Store listings do not go out on
the same day, and the release post must not pretend otherwise. Store review is
days of waiting — Play production access alone can take a week — and a post
that announces both holds the release hostage to whichever store is slowest.

So: the release post covers what is downloadable the minute it goes up
(Windows, macOS, Linux). The store post is its own piece, lives in
`marketing/post-tiendas-moviles/`, and goes out once **both** listings are
public. Two rules keep them from tangling:

- **Never announce a store that is still in review.** "Ya está en la App Store"
  with a listing under review is the one mistake this group notices.
- **The APK-migration warning belongs to the store post only.** It is the post
  that sends people to the Play listing, so it is the post that has to tell
  them to export their sessions first. Don't duplicate it in the release post,
  and don't drop it from the store post to save length.

The store post may mention the desktop release in passing, but the desktop
release announcement should not carry a store section — by the time the stores
are live, that release is old news and needs its own headline anyway.

### How to publish it in the group

The group composer is where the text gets damaged. These three rules each
exist because of a specific failure, not as a style preference:

- **No H1, no rich-text formatting.** Applying a heading stops the post being
  plain text and makes it a block-structured *formatted* post, and entity
  extraction — hashtags, URLs, mentions — goes down a different path there.
  The copy does not need it anyway: the first line already *is* the title, and
  the posts under `marketing/` make theirs stand out with UPPERCASE plus a
  leading emoji. That reads as a heading everywhere and stays on the plain
  path.
- **The download URL stays in the body, last line, with its `https://`.** A
  URL missing the scheme is not reliably linkified outside the desktop web.
  Keep it the last thing in the post so no other text can run into it.
- **Attach the poster as a file; don't paste the bitmap.** Pasting hands
  Facebook whatever the clipboard happens to hold, which depends on the app it
  was copied from; attaching hands it the PNG. Step 11 renders at 2x precisely
  so the app's UI text stays legible, and that is what an extra re-encode
  costs. A feature video is uploaded the same way: attach the MP4 file.

Order: attach the PNG → paste the body → publish. Nothing should need fixing
by hand afterwards.

If something still does, isolate it instead of guessing: post the same text
three ways in a throwaway group — plain, with H1, and with the hashtags typed
instead of pasted — and open all three on a phone. Note that the source files
are not the suspect; `marketing/*/publicacion-facebook.txt` were checked and
carry no non-breaking spaces, zero-width characters or smart quotes.

## 13. Hand back a Reddit announcement draft

Same rule as step 12: hand back the text, publish nothing. Generate it with

```bash
node scripts/announce/reddit-post.mjs --version <NEW>        # English
node scripts/announce/reddit-post.mjs --version <NEW> --lang es
node scripts/announce/reddit-post.mjs --version <NEW> --plain    # rich text editor
```

It prints the title, the poster to attach and the body. In a release that
got a feature video instead of posters (step 11a) there is no English poster
and the video is in Spanish: post the English draft as a text post with the
links and no media; attach the video only to a Spanish-language post
(`--lang es`). It has no network code
and no credentials: the post goes up by hand.

The generator itself is not in the repo — `scripts/announce/` is gitignored,
like `marketing/`, because it is marketing tooling rather than product code. If
this working copy is gone it gets rewritten from the release notes; the shape it
produces is described below.

Reddit is not the Facebook group and the copy does not carry over:

- **No emojis.** The release notes carry one per bullet for the in-app modal
  and the Facebook post. The generator strips the *leading* emoji off each
  bullet; anything that survives into the draft is an emoji mid-sentence, and
  that one comes out by hand.
- **No sales voice and no greeting.** Plain statements of what changed.
- **Markdown, not plain text** — unlike Facebook, Reddit renders it.
- **The "how" comes from the release notes.** The generator lifts the English
  bullets verbatim, so the `How: …` clause from step 3 carries over; if a
  bullet reached Reddit without it, fix the release notes, not the draft.
- English by default. The subreddit decides, not the release.

### Poster plus download links

The post is the step 11 poster plus the download links, and on Reddit that is
not a single format:

- An **image post** is a title and an image. It has no markdown body, so the
  links cannot ride along with it.
- A **text post** has the body, and therefore the links, but takes an inline
  image only if the community allows media in posts.

The poster goes inline in the text post, through the image button in the
formatting toolbar. If that button is not there, it is almost never the
subreddit. Check in order:

1. **The tab.** It is the *Post* tab, not *Image & Video*.
2. **The editor mode.** No formatting toolbar at all means Reddit has you in
   Markdown mode, and a *Switch to Fancy Pants Editor* button sits under the
   text box. That is a per-account preference, not a community setting, so it
   can be off in a sub that allows images perfectly well.
3. **Then** the community: Mod Tools → Content & Contribution → post types. The
   types are decoupled, so Text can be on while Images is off. Turn on Images
   (and galleries, for more than one).

Mind which body you paste. The rich text editor is the one with the image
button, and it does not necessarily interpret markdown pasted into it — you can
end up with literal `**` on screen. `--plain` emits the same text without the
emphasis for that case; the default output is for the markdown editor. Look at
the preview before submitting, either way.

## 14. Hand back the store release notes (Google Play and App Store)

Every release that goes to the stores needs its "What's new" text for both,
in Spanish and English. They go in `marketing/stores-<NEW>/` (gitignored) and
are handed back in the reply, ready to paste. They are NOT the release notes:
only what reaches phones and tablets (no Windows/macOS/Linux-only items, no
installer or desktop window changes) and much shorter.

**Google Play.** Limit **500 characters per language**, counted on the text
inside the tags. Play Console takes every language in one paste with its
locale tags, so hand it back in exactly this shape
(`marketing/stores-<NEW>/play-release-notes.txt`):

```
<es-ES>
Novedades de la <NEW>:
• ...
</es-ES>
<en-US>
What's new in <NEW>:
• ...
</en-US>
```

- One line per item, starting with `•`; no emojis, no markdown (Play shows it
  as plain text).
- The new features first, with the gesture when it is a menu away
  (`Mantén pulsada la canción → "Arreglo"`), labels exactly as the app shows
  them.
- Check the length before handing it back:
  `node -e "console.log([...require('fs').readFileSync(f,'utf8').trim()].length)"`
  on each language's text. A note over 500 is rejected by the console.
- If the listing gets more languages, add their block with Play's locale code
  (`<pt-BR>`, `<fr-FR>`…); a language without a block falls back to the
  default one.

**App Store.** Limit 4000 characters per language, entered separately per
localization in App Store Connect ("What's New in This Version"), so no tags:
`appstore-es.txt` and `appstore-en.txt`. There is room for one short paragraph
per feature with its "how"; mention iOS-specific changes (keeps playing when
minimized, Lightning adapter for video) and leave out Android-only ones.

**Mobile before desktop.** When the apps go to review before the desktop
release (review takes days), push `main` WITHOUT the tag and build the store
artifacts by hand: *Android Release* (`android-release.yml`) builds the signed
AAB and sends it to the chosen Play `track`, and *iOS Release*
(`ios-release.yml`) with `upload` sends the IPA to TestFlight. Neither is part
of `release.yml`, so the desktop release never waits for them.

The Play upload goes through `scripts/google-play.mjs` (service account
`github-play-upload@libretracks.iam.gserviceaccount.com`, secret
`PLAY_SERVICE_ACCOUNT_JSON`). The default `track: production` uploads the AAB
and creates the production release as a **draft** in Play Console: paste
`play-release-notes.txt` into it there. `library` only uploads the AAB (then
*Production → Create new release → Add from library* by hand), and a testing
track (`internal`, `alpha`, `beta`) creates a release that rolls out at once. Submitting for review in Play Console /
App Store Connect is done by hand.
When desktop ships, tag that same commit `v<NEW>` so the three platforms carry
the same build.

---

## Common pitfalls

- Forgetting `Cargo.lock` — the Rust crate version gets out of sync and
  `cargo build` will rewrite it on the next build.
- Forgetting one of the four `package.json` files — `getVersion()` from
  Tauri reads `tauri.conf.json`, but the in-app debug HUD and bundle
  metadata can disagree if any one is stale.
- Adding bullets to release notes that describe internal refactors —
  the in-app modal shows these to end users.
- Pushing the tag before the user confirms — the release pipeline is
  not idempotent for the version slot.
- Pushing with only the fast suites run. `npm test` is the everyday loop, not
  the release gate: it skips the native engine tier and the E2E, and the E2E
  is disabled in CI, so whatever you don't run locally nobody runs. Step 6 is
  the full list.
- Running the E2E against a stale binary. `npm run test:e2e` drives whatever
  sits at `target-desktop-native/release/libretracks-desktop.exe`; rebuild it
  after the version bump or you're testing the previous release.
- Shipping a poster that repeats the previous release's look — the whole
  point of the theme rotation is that each announcement looks new. If the
  themes start feeling used up, add one (step 11).
- Announcing a new feature with a poster. A feature release gets a video
  (step 11a), shown on every platform the feature exists on, desktop first.
- Shipping new UI with the guide still showing the old one. A new or moved
  control means new annotated screenshots and, if it moves, a clip (step 5).
- Publishing a poster without opening the PNG. Overlapping text, a cropped
  app window and a wrapped feature column all render fine and only show up
  when you look.
- Formatting the group post with H1 or any rich text. It turns the post into a
  block-structured one and that is where hashtags and URLs stop being detected;
  the symptom shows up on phones, not on the desktop web where it was written.

---

## macOS DMG (signing and notarization)

Setup and troubleshooting live in [APPLE_SIGNING.md](./APPLE_SIGNING.md). What
matters when cutting a release:

- **With the Apple secrets configured**, the macOS job signs with the Developer
  ID identity, notarizes, staples the DMG, and verifies Gatekeeper's own verdict
  before uploading. Any of those failing fails the release — on purpose.
- **Without them**, the DMG still builds but ships UNSIGNED and macOS blocks it
  on download. The job prints a warning instead of failing — and the download
  page no longer explains the block, because that note came out once releases
  were signed. An accidentally unsigned DMG is therefore a silent trap: read
  the job's warning.

---

## Android (distribution)

Android ships through **Google Play only**, and neither the APK nor the AAB is
attached to the GitHub Release. The download page lists whatever the release
carries, so an APK sitting there is a trap: Play App Signing re-signs the AAB
with Google's own key, the store build cannot update a hand-installed APK, and
moving to the store costs that user their sessions (see "Moving a user from the
GitHub APK to Google Play" below). Three places enforce it — the publish job
filters both extensions out of the asset list, `GithubReleases.astro` filters
them again so the older releases that still carry them stay off the page, and
the page shows an Android note pointing at Play instead.

Run the Android job explicitly from `workflow_dispatch` with **Build signed
Android AAB/APK artifacts** enabled. It builds, signs and verifies both files,
then uploads them as `libretracks-android-assets`. The **AAB** is what you
upload to Play Console; the **APK** is only for installing on a test device.

> **Play production access is not on the release's critical path.** A new
> developer account has to request it, and Google can take a week to grant it.
> Cut and announce the desktop release when it is ready; the store gets its own
> announcement once the listing is actually public (step 12).

### Signing — back up the upload keystore

The Play Store AAB and the hand-install APK must be signed with a stable upload
key you own and must NOT be debuggable. Signing config lives in
`apps/desktop/src-tauri/gen/android/keystore.properties` (gitignored),
which points at a `.jks` kept OUTSIDE the repo
(`~/.libretracks/libretracks-release.jks`).

**Back up that .jks somewhere safe (not just this machine).** Enrol in Google
Play App Signing: Google then protects the app-signing key and this `.jks` is
the upload key. Play can reset a lost upload key, but the APKs already out
there still need that same key for an in-place update.

`keystore.properties` format:
```
storeFile=C:/Users/<you>/.libretracks/libretracks-release.jks
storePassword=…
keyAlias=libretracks
keyPassword=…
```

When the file is absent (fresh clone, no keystore) the release build falls
back to debug signing + `isDebuggable=true` — those builds are for local
testing only, never for distribution.

### Build + verify + upload

```bash
# arm64 covers all modern phones/tablets. Add --target x86_64 only for the
# emulator; don't ship x86_64. The AAB goes to Play Console; the APK is for
# installing on a device by hand while testing.
cd apps/desktop && npx tauri android build --aab --apk --target aarch64 --ci

# Verify BEFORE uploading:
apksigner verify --print-certs <apk>   # Signer #1 DN must be CN=LibreTracks
aapt dump badging <apk> | grep debuggable   # must print nothing
keytool -printcert -jarfile <aab>      # Owner must be CN=LibreTracks
zipalign -c -P 16 -v 4 <apk>          # required for Android 15+ / Play

# Upload the .aab to Play Console. Neither file goes on the GitHub Release —
# see "Android (distribution)" above. versionCode must increase every release
# or Play refuses the upload; it derives from tauri.android.versionCode.
```

Changing from a debug-signed test build to the release-signed APK requires
`adb uninstall` first (Android rejects an update with a different signature).

### Moving a user from the GitHub APK to Google Play

The same signature rule bites users, not just the dev machine. Play App Signing
re-signs the AAB with Google's app-signing key, so the store build and the APKs
that earlier GitHub Releases carried have different certificates: **Android
refuses the in-place update and the user must uninstall first**. That
uninstall deletes `/Android/data/com.libretracks.app/files`, which is where
sessions live (`platform/android_storage.rs`) — so it takes their sessions with
it.

The APK is not published any more, so this is a closed population: whoever
installed one of the APKs that earlier releases attached. It does not grow, it
does not shrink by itself, and nothing in the app tells them any of this.

Two things follow, and both are easy to forget:

- **The app will not warn them.** The update modal is disabled on mobile on
  purpose (`App.tsx`: `enabled: … && !isMobileApp`), because the stores own
  updating there. Whoever installed the APK gets no in-app notice at all.
- **So the announcement has to carry the warning.** Any post that sends people
  to the Play listing must tell them to export every session they want to keep
  BEFORE uninstalling — "Archivo" > "Exportar sesión…" > **Completo**, saved
  outside the app (Downloads, Drive). A Ligero `.ltset` only references audio
  by path and those paths die with the uninstall, so it is an empty backup.
  The wording lives in `marketing/post-tiendas-moviles/` and
  `marketing/post-testers-android/`; keep it there.
