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
- Bullets target end users, not developers. "Faster project loading" beats
  "PCM cache reused across sessions".
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

## 8. Push (only if user authorized it this session)

```bash
git push origin main
git push origin v<NEW>
```

Pushing the tag triggers the release pipeline (macOS bundle validation,
native lib linking, downloads counters). Confirm with the user before
pushing the tag — it's hard to undo a published release.

## 9. Update the knowledge graph

```bash
graphify update .
```

(AST-only, no API cost. Per the project CLAUDE.md, run this after touching
code so future sessions stay in sync.)

## 10. Hand back a Facebook announcement draft

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
