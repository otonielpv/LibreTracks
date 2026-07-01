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

## Import Reaper And Ableton Projects

Use `File` -> `Import Reaper/Ableton` to convert an external DAW project into LibreTracks instead of exporting every stem and rebuilding the set manually. LibreTracks currently accepts Reaper `.rpp` files and Ableton Live `.als` files.

When importing into an open session, the project is appended after the current setlist. From the empty start screen, `Import Reaper/Ableton` first asks for the external project, then asks where to save the new LibreTracks `.ltsession`.

You can also drag a single `.rpp` or `.als` from the operating system onto the timeline. The imported project tries to land at the drop position; if that would overlap an existing song, LibreTracks places it after the setlist. Dropping a Reaper/Ableton project onto the Compact View strip imports it as a new song at the end.

The conversion keeps the live-playback structure rather than every DAW-only detail:

- Reaper audio items become clips, tracks and folder tracks are recreated, basic track mix state is preserved, tempo and time-signature markers are imported, `REGION`s become LibreTracks songs, and Reaper `MARKER`s become section markers inside those songs.
- Ableton audio arrangement clips become clips on recreated tracks, locators become section markers, tempo and time-signature data are imported, and the arrangement becomes one LibreTracks song because Ableton locators are section markers rather than song boundaries.

## Export And Import Full Sessions

Where a `.ltpkg` package carries a single song that merges into the session you already have open, a `.ltset` file carries the **entire session** — every song, the library, automation, and waveforms — as one portable file. Use it to build a set on your home computer and open it unchanged on the machine you play live on, without configuring everything again.

To export the whole session, open the top `File` menu and choose `Export session…`. The dialog offers the same two modes as song export:

- **Full**: also bundles the audio used by your clips, so the set is self-contained and opens on another PC without the original files.
- **Light**: only the project and waveforms, referencing audio by path. Smaller, for reuse on the same machine.

A progress indicator shows how far the export has got — useful for a large full set, where bundling every audio file can take a while — and you can keep working while it runs.

To import a session, choose `Import session…` from the `File` menu, or use the **Import session** button on the start screen — you do not need a session open first. Pick the `.ltset`, choose where to save it, and LibreTracks creates a new project folder and opens it as a fresh session (it replaces what is loaded rather than merging into it).

## Session Templates

Use `File` -> `Save as template…` when the current session has a track layout you want to reuse. A `.lttemplate` keeps the organizational structure - tracks, folder hierarchy, names, colors, and routing - and deliberately removes clips, song regions, markers, tempo maps, and per-track mix values so the next project starts clean.

Create from a template with `File` -> `New from template…`, from the **Templates** area on the start screen, or by choosing a template file manually. Templates are useful for recurring rigs such as Sunday service stems, theatre cues, click/guide layouts, or any show where the routing stays stable while the songs change.

## File Types And Opening From Your Computer

LibreTracks registers its own file types so they are easy to recognize and open:

- `.ltsession` — a project/session you are working on.
- `.ltpkg` — a single exported song package.
- `.ltset` — a whole exported session.
- `.lttemplate` — a reusable session template.

After installing on Windows, these files show their own icons in Explorer instead of the blank generic file icon, so you can tell a song package from a full set at a glance. On macOS and Linux the types are registered as LibreTracks files, though they share the app icon there.

## Mobile Remote Architecture

The remote controls state; it does not play audio. Audio remains in the desktop runtime, keeping the live rig predictable and avoiding browser audio-device complexity.

Remote commands are sent to the desktop backend and resolved through the same session and transport logic used by the desktop UI, MIDI mappings, and keyboard shortcuts.

![Remote control surface](/screenshots/Remote.png)

## Recommended Live Workflow

Prepare audio in a production DAW, then either export stems or import a Reaper/Ableton project as a starting point. Organize the Library, build or refine the timeline, configure output routing, add song regions and markers, save a template if the rig should be reused, set transpose behavior where needed, rehearse jumps, connect MIDI, and use the mobile remote for transport or mixer control during rehearsal and show.
