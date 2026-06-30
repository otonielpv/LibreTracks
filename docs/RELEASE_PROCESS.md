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

- ... (Spanish bullet — user-facing benefit, not implementation detail)

## What's New in v<NEW>

- ... (English mirror)
```

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
- Keep entries to 5–7 high-signal bullets. Group related commits.
- Lead each bullet with a single relevant emoji (e.g. 🍎 macOS, 🥁 metronome,
  🩺 diagnostics, 📊 meters, 🛠️ internal) so the in-app modal reads nicely.
  Emojis go on the bullet text only — NEVER in the `##` headings, which the
  parser regex-matches and would break. Use the SAME emoji for a given item in
  both the ES and EN sections.
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

## 6. Run sanity checks

```bash
# From apps/desktop:
npx tsc -p tsconfig.json --noEmit
npx vitest run
```

Don't block the release on a known flaky test — the
`timeline-tracks › pans the timeline by dragging over an empty lane`
test is flaky under parallelism but passes in isolation. Re-run it alone
to confirm it's not a real regression.

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

Triage before "fixing": some jobs are `continue-on-error: true` (e.g. the
`macos-15-intel` Intel validation build, `publish: false`) — those fail
red but DO NOT block the release, which still publishes. Also separate a
real code/workflow bug from a transient runner flake (DNS/network on a
download step reads as a code error but isn't ours). Prefer a structural
fix that removes the flaky work over a blind retry — e.g. the Intel runner
was pulling the arm64 Rust std it never compiles with; scoping the target
install per-runner deleted the download that flaked.

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

## 11. Hand back a Facebook announcement draft

End-user audience, natural language, minimal emojis, no version-bump
jargon. Lead with the most relatable improvement (loading speed, new
in-app behavior), not internals. Spanish by default unless told otherwise.
Do NOT post it anywhere; just hand back the text.

Use this exact template (matches the channel's voice):

```
Hola @todos!!
Hemos sacado una nueva versión v<NEW> estos han sido los cambios:
- <bullet 1 — most relatable improvement first>
- <bullet 2>
- <bullet 3>
- <bullet 4>
- <bullet 5 — optional, max ~5 bullets>

Puedes descargar la nueva versión aqui:
https://libretracks.pages.dev/es/download/
```

Notes:
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
