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

## Import Songs And Packages

Use `Import song` from the top `File` section when you want to bring another LibreTracks song or session package into the current session. This is useful for building a full show from prepared songs without recreating tracks, clips, routing, and markers by hand.

## Mobile Remote Architecture

The remote controls state; it does not play audio. Audio remains in the desktop runtime, keeping the live rig predictable and avoiding browser audio-device complexity.

Remote commands are sent to the desktop backend and resolved through the same session and transport logic used by the desktop UI, MIDI mappings, and keyboard shortcuts.

![Remote control surface](/screenshots/Remote.png)

## Recommended Live Workflow

Prepare audio in a production DAW, export stems, import them into LibreTracks, organize the Library, build the timeline, configure output routing, add song regions and markers, rehearse jumps, connect MIDI, and use the mobile remote for transport or mixer control during rehearsal and show.
