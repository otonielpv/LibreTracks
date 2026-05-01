---
title: Core Concepts
description: Library, tracks, clips, markers, meter changes, and song regions.
---

## Library And Assets

`Library` is the preparation area for show audio. Import one or more audio files, then drag them onto the timeline when you are ready to arrange.

![Import assets into the library](/screenshots/Library-Assets-Import.gif)

Virtual folders group assets by song, set, scene, section, or instrumentation without moving the original files. A practical live setup is one folder per song or show block.

![Virtual asset folders](/screenshots/Assets-Folder.gif)

## Audio Tracks And Folder Tracks

- `Audio track` holds clips and produces playback.
- `Folder track` organizes child tracks and provides grouped control.

Use folder tracks for related stems such as drums, band tracks, choirs, backing vocals, or auxiliary playback. Use audio tracks for lanes that contain clips.

![Tracks and folders](/screenshots/Tracks-Folder.gif)

## Clips And Timeline Editing

Clips are non-destructive timeline references to source audio. You can drag assets from the Library, move clips, duplicate repeated sections, and split clips at the cursor without rewriting the original WAV.

![Duplicate a clip](/screenshots/DuplicateTrack.png)

`Snap to Grid` keeps cursor movement, clips, and edits aligned to musical divisions. Disable it only when a free placement is needed.

![Snap to Grid control](/screenshots/Snap-To-Grid-Button.png)

## Song Regions

Song regions define named ranges on the timeline. They let one session hold several songs or show cues and are used by song jump controls.

Create a song region by selecting a region on the timeline, right-clicking it, and choosing `Create song from selection`.

![Create a song region](/screenshots/Create-Region.png)

## Markers And Meter Changes

Markers define musical destinations such as Intro, Verse, Chorus, Bridge, Vamp, and Outro. Create them from the ruler with `Create Marker`.

![Create a marker](/screenshots/Create-Marker.gif)

Time signature markers keep bar-based operations correct when a song changes meter. Create them from the timeline header with `Create Meter Marker`, then choose the new meter.

![Create a time signature change](/screenshots/Change-Time-Signature.png)
