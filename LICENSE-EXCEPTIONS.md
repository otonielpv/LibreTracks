# Additional permissions and terms

Copyright © 2026 Otoniel Pérez Velarde.

LibreTracks is licensed under the GNU Affero General Public License v3.0 or
later; see [LICENSE](./LICENSE) for the full text. This file adds two things
under section 7 of that license:

- an **additional permission** for application stores, which grants rights and
  never takes any away. If you distribute LibreTracks outside an application
  store, it does not apply to you;
- an **attribution requirement** under section 7(b), which applies to anyone
  who conveys LibreTracks or a work based on it, including a renamed fork.

## Author attribution (section 7(b))

As an additional term under section 7(b) of the GNU Affero General Public
License version 3, anyone who conveys LibreTracks, or a work based on it
(modified or not, under this name or another), must preserve the following
author attribution:

> Based on LibreTracks by Otoniel Pérez Velarde
> https://github.com/otonielpv/LibreTracks

The attribution must be preserved:

1. in the project's README or equivalent top-level documentation, and
2. in the Appropriate Legal Notices of any interactive user interface (for
   example an "About" screen, a credits page or a legal notices dialog), if the
   work displays them, as section 5(d) of the license requires.

It may be translated and restyled to fit the work, as long as it stays legible
and names both LibreTracks and its author. It does not require that a modified
work carry the LibreTracks name or logo, and it does not grant permission to use
them: the name "LibreTracks" may not be used in a way that suggests a modified
version is the original or is endorsed by its author.

This term applies to versions of LibreTracks published from the date it was
added to this file onward.

## App store distribution exception

Application stores impose terms on the people who download from them — a limit
on the number of devices, a prohibition on redistributing the binary — that
would otherwise count as "further restrictions" the AGPL does not permit
downstream. That is why GPL-licensed software has historically been pulled from
Apple's App Store rather than accepted.

As an additional permission under section 7 of the GNU Affero General Public
License version 3, **Otoniel Pérez Velarde**, the copyright holder of
LibreTracks, grants permission to distribute — and to have distributed on the
copyright holder's behalf — binary copies of LibreTracks through Apple's App
Store, Google Play, or a comparable application distribution platform,
notwithstanding the additional restrictions that such a platform's terms of
service impose on the recipients of those copies.

Scope of this permission:

- It covers **the binary as distributed through such a platform**. It changes
  nothing about the source code, which remains AGPL-3.0-or-later.
- It does **not** reduce anyone's rights under the AGPL. The complete
  corresponding source stays published at the project's public repository, and
  anyone may obtain, study, modify and redistribute it under the AGPL, build
  their own copy, and run it on as many devices as they like.
- It does **not** extend to third-party components, which are governed by their
  own licenses. See [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md).

## Why the third-party components are not a problem for a store build

- **JUCE** (AGPLv3) is the one bundled component whose license carries the same
  App Store conflict, and it is **not part of the mobile builds**. iOS uses its
  own CoreAudio/RemoteIO device backend and Android uses Oboe; JUCE is compiled
  out entirely (`LT_ENGINE_USE_JUCE=OFF`, verified in CI). It ships only in the
  desktop builds, which are distributed outside any store.
- **FFmpeg** and **libsndfile** (LGPL-2.1-or-later) impose no store-incompatible
  restriction. They are linked statically on mobile, so the relinking right in
  LGPL section 6 matters: it is satisfied because the complete corresponding
  source of LibreTracks itself is published under the AGPL, which lets anyone
  rebuild the application against their own copy of those libraries. See the
  written offer in [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md).
- **Bungee** (MPL-2.0) is file-level copyleft with no restriction on how the
  resulting binary is distributed.
- The remaining components are MIT, Apache-2.0, BSD or OFL-1.1, none of which
  restrict store distribution.
