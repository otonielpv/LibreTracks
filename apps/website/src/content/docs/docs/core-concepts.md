---
title: Core Concepts
description: Tracks, markers, tempo, time signatures, and song regions in LibreTracks.
---

## Audio Tracks And Folder Tracks

LibreTracks has two track kinds in the core model:

- `Audio` tracks hold clips and produce playback.
- `Folder` tracks organize child tracks and provide grouped control.

Use audio tracks for stems, cues, count-ins, and playback files. Use folder tracks when a set of tracks belongs together, such as drums, band stems, choir, backing vocals, or show cues.

Folder tracks are part of the effective mix calculation. Parent/child relationships let the app resolve grouped gain, mute, and solo behavior without forcing the UI to own audio rules.

## Clips And Non-Destructive Editing

Each clip points to a source file path and stores timeline placement, source offset, duration, gain, and optional fades. A split creates new timeline references into the same source WAV. A move changes placement. A duplicate creates another clip reference.

The source WAV is not rewritten by split, move, or duplicate operations.

## Section Markers

Section markers define musical destinations on the timeline: Intro, Verse, Chorus, Bridge, Vamp, Outro, and similar points. The model supports an optional `digit` field for numeric marker shortcuts.

In the current desktop build, `0-9` jump shortcuts are resolved by marker order on the timeline. The data model already supports explicit marker digits, but the UI does not yet expose a dedicated digit assignment control.

## Tempo Markers

A song has a base BPM and can also contain tempo markers. Tempo data lets transport logic calculate bar boundaries for quantized jumps and Vamp behavior.

Tempo changes are stored as marker data instead of being inferred from clip content at playback time.

## Time Signature Markers

Songs also have a base time signature and optional time signature markers. These markers affect musical grid calculations and make bar-based live operations behave correctly when a song changes meter.

## Song Regions

Song regions define named ranges in a single timeline. This lets one session contain several songs or show sections without forcing every song into a separate project.

Song regions are used by song jump controls, including moving to another song region immediately, after a bar count, or at the current region end.
