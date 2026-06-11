# Third-Party Notices

LibreTracks is licensed under the **GNU Affero General Public License, version 3
or later (AGPL-3.0-or-later)**. See [LICENSE](./LICENSE) for the full text.

The distributed applications include, link against, or bundle the third-party
components listed below. Each remains under its own license; this file collects
the required notices, attributions, and source-availability offers. Full license
texts for the non-MIT components live in [`licenses/`](./licenses/).

---

## Bundled / linked native components

These ship inside the desktop application (`.app` / `.exe` / `.deb` / `.rpm` /
`.AppImage`) or are linked into the native audio engine.

### JUCE 8.0.4
- **License:** GNU AGPLv3 (used under JUCE's open-source licensing option).
- **Copyright:** © Raw Material Software Limited.
- **Source:** https://github.com/juce-framework/JUCE (tag `8.0.4`)
- **Modules used:** `juce_core`, `juce_audio_basics`, `juce_audio_devices`.
- **Notes:** LibreTracks uses JUCE under the AGPLv3 grant, which is why the
  combined work is distributed under AGPL-3.0-or-later. The JUCE splash screen
  and usage reporting are disabled, as permitted under the AGPLv3 option.

### Bungee 2.4.24
- **License:** Mozilla Public License 2.0 (MPL-2.0) — see
  [`licenses/MPL-2.0.txt`](./licenses/MPL-2.0.txt).
- **Copyright:** © Parabola Research Limited.
- **Source:** https://github.com/bungee-audio-stretch/bungee (release `v2.4.24`)
- **Notes:** Used as an unmodified prebuilt library. No changes were made to
  Bungee's own source files; per MPL-2.0, were any made, they would be published
  under MPL-2.0.

### FFmpeg 7.1.1 (libavformat, libavcodec, libavutil, libswresample)
- **License:** GNU LGPL-2.1-or-later — see
  [`licenses/LGPL-2.1.txt`](./licenses/LGPL-2.1.txt) (which references
  [`licenses/GPL-2.0.txt`](./licenses/GPL-2.0.txt)).
- **Copyright:** © the FFmpeg developers.
- **Source:** https://ffmpeg.org/releases/ffmpeg-7.1.1.tar.xz
- **Notes:** LibreTracks builds a **minimal, decoder-only, LGPL** FFmpeg — built
  WITHOUT `--enable-gpl` and without any GPL/nonfree external codec libraries
  (no x264/x265/libvpx/SVT-AV1/etc.). The exact, unmodified configuration is in
  [`scripts/build-ffmpeg-universal.sh`](./scripts/build-ffmpeg-universal.sh).
  FFmpeg is dynamically linked, so it can be replaced by the user (LGPL §6).

### libsndfile
- **License:** GNU LGPL-2.1-or-later — see
  [`licenses/LGPL-2.1.txt`](./licenses/LGPL-2.1.txt).
- **Copyright:** © Erik de Castro Lopo and contributors.
- **Source:** https://github.com/libsndfile/libsndfile
- **Notes:** Built without external libraries (`ENABLE_EXTERNAL_LIBS=OFF`).
  Because LibreTracks' own source is published under AGPLv3, the LGPL
  relinking requirement is satisfied: the complete corresponding source needed
  to rebuild and relink the engine is available (see the source offer below).

### r8brain-free-src
- **License:** MIT.
- **Copyright:** © Aleksey Vaneev.
- **Source:** https://github.com/avaneev/r8brain-free-src

### dr_libs (dr_mp3 / dr_wav / dr_flac)
- **License:** Public domain (Unlicense) or MIT-0, at your option.
- **Copyright:** David Reid.
- **Source:** https://github.com/mackron/dr_libs

### nlohmann/json 3.11.3
- **License:** MIT.
- **Copyright:** © Niels Lohmann.
- **Source:** https://github.com/nlohmann/json

---

## Application shell & frontend

### Tauri (and tao / wry)
- **License:** MIT or Apache-2.0, at your option.
- **Copyright:** © Tauri Programme within The Commons Conservancy.
- **Source:** https://github.com/tauri-apps/tauri

### Rust crates
The Rust workspace depends on many crates, predominantly under MIT and/or
Apache-2.0 (some BSD). The authoritative, version-exact list is generated from
the build; regenerate it with a license scanner, e.g.:

```
cargo install cargo-about
cargo about generate about.hbs > licenses/RUST-DEPENDENCIES.html
```

### npm packages
The JavaScript/TypeScript dependencies are predominantly MIT/Apache-2.0/ISC/BSD.
Regenerate the exact list with:

```
npx license-checker --production --summary
```

---

## Fonts

### Inter
- **License:** SIL Open Font License 1.1 (OFL-1.1) — see
  [`licenses/OFL-1.1.txt`](./licenses/OFL-1.1.txt).
- **Copyright:** © The Inter Project Authors (https://github.com/rsms/inter).

### Space Grotesk
- **License:** SIL Open Font License 1.1 (OFL-1.1) — see
  [`licenses/OFL-1.1.txt`](./licenses/OFL-1.1.txt).
- **Copyright:** © Florian Karsten (https://github.com/floriankarsten/space-grotesk).

---

## Written offer for source (LGPL components)

The complete corresponding source code for the LGPL-licensed libraries
distributed with LibreTracks — **FFmpeg** and **libsndfile** — is available from
their upstream projects at the exact versions linked above. LibreTracks ships
these libraries unmodified; the scripts used to fetch and build them are part of
this repository ([`scripts/build-ffmpeg-universal.sh`](./scripts/build-ffmpeg-universal.sh)
and the engine's CMake configuration). Because the FFmpeg libraries are linked
dynamically, an end user may rebuild them from that source and substitute their
own copy.

The complete corresponding source for LibreTracks itself (an AGPL-3.0 work) is
published at the project's public repository.
