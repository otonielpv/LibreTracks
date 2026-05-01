---
title: LibreTracks Documentation
description: User and technical documentation for LibreTracks.
---

LibreTracks is a desktop multitrack playback workstation for live musicians, music directors, and playback engineers. It is built for preparing a show in advance, saving the session, and performing with predictable audio routing, markers, jumps, MIDI, and a mobile remote.

![LibreTracks project timeline](/screenshots/Proyecto.png)

## What LibreTracks Is For

Use LibreTracks when the show needs prepared audio files, a clear timeline, dedicated click or cue outputs, section markers, song regions, and live control from desktop, MIDI hardware, or a phone.

LibreTracks is not a production DAW. Produce and mix stems in Reaper, Ableton Live, Logic, Cubase, or another studio tool, then bring prepared audio into LibreTracks for the live playback rig.

## Core Live Workflow

1. Import audio into `Library`.
2. Organize assets with virtual folders.
3. Drag assets to the timeline and create audio or folder tracks.
4. Configure the audio device, hardware outputs, track routes, metronome, and MIDI input.
5. Create song regions, markers, and optional meter changes.
6. Rehearse marker jumps, Vamp, song jumps, transitions, keyboard shortcuts, MIDI mappings, and the mobile remote.
7. Export prepared songs or packages when you want to reuse them in future sessions.

![Library import workflow](/screenshots/Library-Assets-Import.gif)

## Live Safety Model

Editing is non-destructive. Splitting, moving, duplicating, or arranging clips changes timeline references; it does not rewrite the original audio file.

Transport behavior is also explicit. Marker jumps, song jumps, Vamp loops, metronome behavior, and remote commands are resolved through the same application state and Rust-side transport logic instead of temporary UI timers.

## Main Areas

- `Settings`: audio device, hardware outputs, metronome, and MIDI Learn.
- `Library`: imported audio assets and virtual folders.
- `Timeline`: audio tracks, folder tracks, clips, song regions, markers, time signatures, and grid editing.
- `Remote`: local web control surface for transport, jumps, Vamp, and mixer.
- `File`: import songs/packages and export prepared songs.
