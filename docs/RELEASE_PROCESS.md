# Release Process

Repeatable steps to cut a new LibreTracks release (e.g. v0.0.X → v0.0.Y).
This is the authoritative checklist Claude should follow when the user
asks to "create a new version" or "tag vX.Y.Z".

## 0. Inputs to gather first

- Target version (e.g. `0.0.9`). Confirm with the user if not given.
- Scope of changes (use `git log <prev-tag>..HEAD` — do NOT trust memory).
- Whether to push and create the remote tag (releases pipeline triggers on tag push), or stop at local commits.
- Whether to bundle pending uncommitted work into a feature commit first.

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

`apps/remote/package.json` must be bumped to the new version string along
with the rest (it historically lagged, but it should now stay in lockstep).
Don't touch other crates' versions unless something forced a bump there.

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

## 5. Update web docs (only if user-visible behavior changed)

Files: `apps/website/src/content/docs/docs/index.md` and
`apps/website/src/content/docs/es/docs/index.md`.

Add or refine 1–2 lines about anything in the release that affects how
users perceive the app (new always-visible features, important behavior
changes). Skip pure refactors, internal perf, or features that aren't
user-discoverable yet.

Go through the release's user-facing commits one by one — it is easy to
document the headline feature and miss the four smaller ones. Both language
files must stay mirrored.

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

## 6. Run sanity checks

```bash
# From apps/desktop:
npx tsc -p tsconfig.json --noEmit
npx vitest run

# From the repo root — the EXACT command the `test` job runs. Running the
# crates piecemeal is not the same check and has missed real breakage.
cargo test --locked -p libretracks-core -p libretracks-project \
  -p libretracks-audio -p lt-audio-engine-v2 --features lt-audio-engine-v2/no-link
cargo check --all-targets
```

Don't block the release on a known flaky test — the
`timeline-tracks › pans the timeline by dragging over an empty lane`
test is flaky under parallelism but passes in isolation. Re-run it alone
to confirm it's not a real regression.

### The Android compile trap (bit v1.10.0)

`cargo check --all-targets` on desktop does **not** compile anything behind
`#[cfg(target_os = "android")]` (`platform/android_audio_devices.rs`,
`platform/mobile_files.rs`), and `build-android` only runs on a tag push. So an
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

The normal release flow is **commit → tag → push both**, not stopping at
local commits. Unless the user explicitly says "local only" / "don't push",
push `main` and the tag:

```bash
git push origin main
git push origin v<NEW>
```

Pushing the tag triggers the release pipeline (macOS bundle validation,
native lib linking, downloads counters). It's hard to undo a *published*
release, so the gate is: do the local commit + tag, and push as part of the
same release request unless told otherwise — don't ask again mid-flow once
the user has asked for a release.

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
job going red (e.g. the `macos-15-intel` validation build) does NOT fail the
release — don't cancel for those; let the run finish and publish.

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
| `build-release-assets` | Yes, except the `macos-15-intel` leg (`publish: false`). |
| `build-android` | Yes — signed APK. |
| `publish-release` | Needs all of the above green. |

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

Triage before "fixing": some jobs are `continue-on-error: true` (e.g. the
`macos-15-intel` Intel validation build, `publish: false`) — those fail
red but DO NOT block the release, which still publishes. Also separate a
real code/workflow bug from a transient runner flake (DNS/network on a
download step reads as a code error but isn't ours). Prefer a structural
fix that removes the flaky work over a blind retry — e.g. the Intel runner
was pulling the arm64 Rust std it never compiles with; scoping the target
install per-runner deleted the download that flaked.

Known, still open (seen twice in v1.10.0): `macos-15-intel` dies within a
second of `scripts/build-ffmpeg-universal.sh` starting, with
`curl: (35) Recv failure: Connection reset by peer` fetching
`https://ffmpeg.org/releases/ffmpeg-7.1.1.tar.xz`. The `macos-latest` leg runs
the same script over the same URL and is fine, so it looks specific to the
Intel runner's route to ffmpeg.org rather than to our code. It is
`continue-on-error` + `publish: false`, so it does NOT block publishing —
do not move the tag for it mid-release. If it becomes worth fixing, diagnose
before adding `curl --retry`: a blind retry would paper over whatever the
runner is actually hitting (rate limiting vs. no route), and the download is
cheap to mirror or cache instead.

Re-trigger after a fix: commit the fix, then MOVE the tag to the new
commit and force-push it (the pipeline keys on the tag). The release-create
step already deletes-then-recreates the GitHub release, so a moved tag
regenerates it cleanly:

```bash
git push origin main
git tag -f v<NEW>
git push origin v<NEW> --force
```

## 10. Update the knowledge graph

```bash
graphify update .
```

(AST-only, no API cost. Per the project CLAUDE.md, run this after touching
code so future sessions stay in sync.)

## 11. Make the release poster (mandatory, one per release)

Every release gets its own square announcement image, generated with the
poster tool and handed back together with the Facebook draft (step 12).

The layout is 1080x1080 but the capture runs at 2x, so the PNG lands at
2160x2160 (~1.2 MB). That density is for the SCREENSHOTS, not the type: an app
window is ~1900px wide and the poster shows it at ~860, so at 1x Chrome threw
away more than half of every UI label and the app photographed as mush. Pass
`--scale 1` only if something specifically needs a 1080x1080 file.

```bash
mkdir -p marketing/poster-<NEW>
cp <a real screenshot> marketing/poster-<NEW>/shot.png
# write marketing/poster-<NEW>/poster.json (see below), then:
node scripts/poster/make-poster.mjs --spec marketing/poster-<NEW>/poster.json
```

`marketing/` is gitignored, so the PNGs stay out of the repo; the generator
under `scripts/poster/` is versioned, so any release can be re-rendered.

### Every poster must look different

This is the point of the tool, not a nice-to-have: a feed of identical posters
stops being read. `scripts/poster/themes.mjs` holds six themes, each with its
own palette, background motif AND layout (`spotlight`, `bleed-right`, `split`,
`tilt`, `devices`, `list`). `pickTheme()` derives one from the version number —
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
  the same feature on every screen size. It reads the extra ones from the
  optional `shots` array in the spec, mid-size device first, phone second.

### The copy file

`poster.json` is the only thing written per release:

```json
{
  "version": "1.10.1",
  "badge": "GRATIS Y OPEN SOURCE",
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
  `artWidth`, `artCaption`, `artLabel`, `artStamp`, `headlineSize`, and
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
- Spanish, same voice as the Facebook post. Check the accents.

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
with the poster from step 11 — the post and the image go out as one piece,
so the poster's headline and the post's first bullet should agree.

Use this exact template (matches the channel's voice):

```
Hola @todos!!
Hemos sacado una nueva versión v<NEW> estos han sido los cambios:
- <emoji> <bullet 1 — most relatable improvement first>
- <emoji> <bullet 2>
- <emoji> <bullet 3>
- <emoji> <bullet 4>
- <emoji> <bullet 5 — optional, max ~5 bullets>

Puedes descargar la nueva versión aqui:
https://libretracks.com/es/download/
```

Notes:
- **Every bullet leads with an emoji.** Reuse the one the same item already
  carries in the Spanish section of `docs/releases/v<NEW>.md` so the post and
  the in-app modal stay visually consistent. This applies to the bullets only —
  the greeting, the closing line and the URL stay plain.
- Bullets are user-facing benefits, lifted from the Spanish section of
  `docs/releases/v<NEW>.md` but rewritten for a conversational tone.
- Keep accents on key words ("rápida", "más", "directo"), but it's OK to
  leave a few off — the original channel does too. Don't over-correct.
- Download URL is the localized Spanish page: `/es/download/`, not `/downloads`.
- No closing line, no signature, no hashtags. The template ends at the URL.

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
- Shipping a poster that repeats the previous release's look — the whole
  point of the theme rotation is that each announcement looks new. If the
  themes start feeling used up, add one (step 11).
- Publishing a poster without opening the PNG. Overlapping text, a cropped
  app window and a wrapped feature column all render fine and only show up
  when you look.

---

## macOS DMG (signing and notarization)

Setup and troubleshooting live in [APPLE_SIGNING.md](./APPLE_SIGNING.md). What
matters when cutting a release:

- **With the Apple secrets configured**, the macOS job signs with the Developer
  ID identity, notarizes, staples the DMG, and verifies Gatekeeper's own verdict
  before uploading. Any of those failing fails the release — on purpose.
- **Without them**, the DMG still builds but ships UNSIGNED and macOS blocks it
  on download. The job prints a warning instead of failing, and the download
  page shows a temporary first-launch note (`.platform-note`).
- A signed release means the note on the download page can go. It is marked as
  temporary in `GithubReleases.astro`.

---

## Android APK (distribution)

The download page (`GithubReleases.astro`) lists each GitHub Release's
assets, so distributing Android is: **attach the signed `.apk` to the
release** and the page shows it automatically (🤖 icon). No Google Play,
no store fee.

### Signing — back up the upload keystore

The Play Store AAB and distributable APK must be signed with a stable upload
key you own and must NOT be debuggable. Signing config lives in
`apps/desktop/src-tauri/gen/android/keystore.properties` (gitignored),
which points at a `.jks` kept OUTSIDE the repo
(`~/.libretracks/libretracks-release.jks`).

**Back up that .jks somewhere safe (not just this machine).** Enrol in Google
Play App Signing: Google then protects the app-signing key and this `.jks` is
the upload key. Play can reset a lost upload key, but APKs distributed directly
still need the same signing key for in-place updates.

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

### Build + verify + attach

```bash
# arm64 covers all modern phones/tablets. Add --target x86_64 only for the
# emulator; don't ship x86_64. The AAB goes to Play Console; the APK is for
# direct device testing/downloads.
cd apps/desktop && npx tauri android build --aab --apk --target aarch64 --ci

# Verify BEFORE attaching:
apksigner verify --print-certs <apk>   # Signer #1 DN must be CN=LibreTracks
aapt dump badging <apk> | grep debuggable   # must print nothing
keytool -printcert -jarfile <aab>      # Owner must be CN=LibreTracks
zipalign -c -P 16 -v 4 <apk>          # required for Android 15+ / Play

# Upload the .aab to Play Console. Attach the APK to the GitHub Release
# (renamed with the version so the download card reads clearly). versionCode
# must increase every release or devices refuse the update; it derives from
# tauri.android.versionCode.
```

Changing from a debug-signed test build to the release-signed APK requires
`adb uninstall` first (Android rejects an update with a different signature).
