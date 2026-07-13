# Ambient pads

Ambient pads are long (~15 min) looping audio beds, one file per musical key,
that play under a song as a global "voice" (like the metronome or voice guide —
they are **not** tracks in the project and are never saved into a session).

Because a single pad pack is large (~500 MB: 12 keys × ~15 min), pads are **never
bundled with the app**. They are downloaded on demand from a host-agnostic
manifest and installed under the user's app data directory.

## Where things live

- **Installed pads (per user):**
  `app_local_data_dir()/pads/<pad_id>/<key>.<ext>`
  e.g. `.../pads/warm/C.mp3`, `.../pads/warm/Cs.mp3`, … `.../pads/warm/B.mp3`
- **The catalog manifest:** a small `manifest.json` fetched from
  `PADS_MANIFEST_URL` (a constant in
  [`apps/desktop/src-tauri/src/commands/pads.rs`](../apps/desktop/src-tauri/src/commands/pads.rs)).
- **Key file naming — the 12 stems (sharp spelling, no `#` in filenames):**
  `C, Cs, D, Ds, E, F, Fs, G, Gs, A, As, B` (indices `0..11`). This mapping is
  duplicated in `pad_renderer.cpp` (`key_stem`) and `pads.rs` (`KEY_STEMS`) — keep
  the two in sync.
- **Accepted audio formats (first match wins):** `.wav .flac .mp3 .ogg .m4a .aac`.
  MP3 is fine but slower to decode; a `.wav` re-encode decodes faster if disk
  space allows.

## The manifest format

```json
{
  "version": 1,
  "pads": [
    {
      "id": "warm",
      "name": "Warm Pad",
      "description": "Cálido, cuerdas suaves",
      "sizeBytes": 512000000,
      "sha256": "optional-hex-digest-of-the-zip",
      "downloadUrl": "https://<host>/warm.zip"
    }
  ]
}
```

- `id` — the folder name a pad installs into; must be filesystem-safe.
- `downloadUrl` — where the pad's `.zip` lives. **This is the host-agnostic
  hinge:** the app never hardcodes where the audio is, only where the manifest
  is. Point `downloadUrl` at a GitHub release asset today, a Cloudflare R2 /
  S3 bucket tomorrow — no app rebuild, just edit the manifest.
- `sizeBytes` — used for the progress bar when the server doesn't send a
  `Content-Length`, and to show the download size in the UI.
- `sha256` — optional; reserved for integrity verification (not enforced yet).

## The `.zip` layout

The archive may either put the 12 key files at the root, **or** wrap them in a
single folder (commonly named after the pad id). Both are accepted:

```
warm.zip
└── warm/            (optional wrapping folder)
    ├── C.mp3
    ├── Cs.mp3
    ├── …
    └── B.mp3
```

Only recognised `<stem>.<ext>` files are copied into the install dir; other
archive contents are ignored.

## Publishing a new pad (recommended: a separate host)

To keep the app's version releases and the download website clean, host pad
content **separately** from the app repo — e.g. a dedicated `libretracks-pads`
GitHub repo (its own releases/tags), or a Cloudflare R2 bucket. The app's
auto-updater and download page only look at the main repo, so they never see
pad assets.

1. Encode the pad to 12 files named `C … B` (sharp stems) and zip them.
2. Upload the `.zip` to your host and note its direct download URL.
3. Add an entry to `manifest.json` (host it anywhere static — a raw file in the
   pads repo, an R2 object, …) and make sure `PADS_MANIFEST_URL` points at it.
4. That's it — the app picks up the new pad on the next catalog fetch.

### Cloudflare R2 note

R2 is effectively free for this use case: **egress (downloads) is always $0**,
storage is free up to 10 GB, and it has no per-asset size cap. It only requires
a card on file to activate. Since the app is host-agnostic, you can start on
GitHub and migrate to R2 later by editing `downloadUrl` in the manifest.

## Runtime behaviour

- Only the **currently selected key** is normally decoded into RAM (~300 MB for
  15 min stereo) — decoding all 12 at once would be prohibitive. During a live
  key/pack change the old and new clips coexist only for the 12 ms crossfade.
- Replacement audio is decoded off the playback thread while the old Pad keeps
  playing. Once ready, the new clip inherits the equivalent loop frame and both
  voices overlap with a constant-power crossfade; there is no fade-to-silence
  midpoint and the recorded attack is not replayed. A failed replacement leaves
  the current Pad audible.
- The pad loops continuously while enabled, with a short (~20 ms) crossfade at
  the loop seam so the wrap is click-free.
- The pad is mixed **after** the song master gain, alongside the metronome and
  voice guide — lowering the song master does not attenuate the pad.
- Like the metronome/voice-guide, the pad currently sounds only while the
  transport is **playing**. (Playing while stopped would be a future option.)
- On Android the audio engine is still a silent stub, so downloads/UI work but
  the pad won't be audible until the NDK engine port lands.
