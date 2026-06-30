---
title: Integration & Ecosystem
description: Song packages, import/export workflow, remote architecture, and recommended live setup.
---

## Song Export

After creating a song region, export it when you want to reuse the configuration in future sessions.

1. Create a song from a selected timeline region.
2. Right-click the created region.
3. Choose `Export Song`.

![Export a song](/screenshots/Export-Song.png)

The export dialog lets you choose whether to include the audio files in the `.ltpkg`. Include audio when you need a self-contained package for another machine. Leave audio out when you only want to share the song structure, clips, routing, markers, and region settings while keeping the package lightweight.

## Import Songs And Packages

Use `Import song` from the top `File` section when you want to bring another LibreTracks song or session package into the current session. This is useful for building a full show from prepared songs without recreating tracks, clips, routing, markers, and song-region setup by hand.

For day-to-day prep, the session can also accept external drops more directly: audio files can be imported into the arrangement flow, while library folders help keep assets organized by song or show block.

## Export And Import Full Sessions

Where a `.ltpkg` package carries a single song that merges into the session you already have open, a `.ltset` file carries the **entire session** — every song, the library, automation, and waveforms — as one portable file. Use it to build a set on your home computer and open it unchanged on the machine you play live on, without configuring everything again.

To export the whole session, open the top `File` menu and choose `Export session…`. The dialog offers the same two modes as song export:

- **Full**: also bundles the audio used by your clips, so the set is self-contained and opens on another PC without the original files.
- **Light**: only the project and waveforms, referencing audio by path. Smaller, for reuse on the same machine.

A progress indicator shows how far the export has got — useful for a large full set, where bundling every audio file can take a while — and you can keep working while it runs.

To import a session, choose `Import session…` from the `File` menu, or use the **Import session** button on the start screen — you do not need a session open first. Pick the `.ltset`, choose where to save it, and LibreTracks creates a new project folder and opens it as a fresh session (it replaces what is loaded rather than merging into it).

## File Types And Opening From Your Computer

LibreTracks registers its own file types so they are easy to recognize and open:

- `.ltsession` — a project/session you are working on.
- `.ltpkg` — a single exported song package.
- `.ltset` — a whole exported session.

After installing on Windows, these files show their own icons in Explorer instead of the blank generic file icon, so you can tell a song package from a full set at a glance. On macOS and Linux the types are registered as LibreTracks files, though they share the app icon there.

## Mobile Remote Architecture

The remote controls state; it does not play audio. Audio remains in the desktop runtime, keeping the live rig predictable and avoiding browser audio-device complexity.

Remote commands are sent to the desktop backend and resolved through the same session and transport logic used by the desktop UI, MIDI mappings, and keyboard shortcuts.

![Remote control surface](/screenshots/Remote.png)

## Recommended Live Workflow

Prepare audio in a production DAW, export stems, import them into LibreTracks, organize the Library, build the timeline, configure output routing, add song regions and markers, set transpose behavior where needed, rehearse jumps, connect MIDI, and use the mobile remote for transport or mixer control during rehearsal and show.
