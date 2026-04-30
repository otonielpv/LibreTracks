---
title: Integration & Ecosystem
description: Remote control, packages, project portability, and workflow.
---

## Mobile Remote

LibreTracks desktop can publish a local web remote for phones and tablets.

Open `Remote` in the desktop app and scan the QR code. The desktop app also shows local URLs by IP address and `.local` hostname. The phone or tablet must be on the same local network as the desktop machine.

The remote exposes transport, marker jump controls, Vamp controls, song transition controls, and a mixer view for level, pan, mute, and solo.

## Remote Architecture

The remote controls state. It does not play audio. Audio remains in the desktop runtime, which keeps the live rig predictable and avoids browser audio-device complexity.

Remote commands are sent to the desktop backend, where they are resolved through the same session and transport logic used by the desktop UI.

## LibreTracks Packages

LibreTracks supports `.ltpkg` packages for moving songs or prepared sessions between contexts.

Use packages when you want to:

- Bring another prepared song into the current session.
- Share a song setup between rehearsal and show machines.
- Build a full show timeline from already prepared material.

The project layer handles package import and keeps song persistence in `song.json` with related library assets.

## Recommended Workflow

Prepare audio in a production DAW, export WAV stems, import them into LibreTracks, create section markers and song regions, configure routing, rehearse jump behavior, then connect MIDI and the mobile remote for show control.
