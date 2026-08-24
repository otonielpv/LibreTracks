---
title: LibreTracks Documentation
description: User and technical documentation for LibreTracks.
---

LibreTracks is a multitrack playback workstation for live musicians, music directors, and playback engineers. It is built for preparing a show in advance, saving or templating the session, and performing with predictable audio routing, markers, jumps, transposition controls, color-coded timelines, MIDI, customizable shortcuts, and a mobile remote.

LibreTracks runs on desktop (Windows, macOS, Linux) and is now available on Android as an early beta — you can install it on a phone or tablet, open recent sessions, create new sessions from reusable templates, and work with real playback, audio import, and touch control of the timeline. The Android build is still in testing, so use it with care and don't rely on it for an important show yet.

![LibreTracks project timeline](/screenshots/Proyecto.png)

## What LibreTracks Is For

Use LibreTracks when the show needs prepared audio files, a clear timeline, dedicated click or cue outputs, section markers, song regions, and live control from desktop, MIDI hardware, or a phone.

LibreTracks is not a production DAW. Produce and mix stems in Reaper, Ableton Live, Logic, Cubase, or another studio tool, then bring prepared audio into LibreTracks for the live playback rig. Reaper `.rpp` and Ableton `.als` projects can also be imported as a starting point when you want LibreTracks to recreate the live arrangement structure.

The project model is **song-first**: songs (song regions) are the primary container, with clips and tracks living inside them. The app offers three equivalent projections of that model — the linear [DAW timeline](/docs/core-concepts/) for arranging, the [Compact View](/docs/compact-view/) for rehearsing and for quickly importing or exporting songs, `.ltpkg` packages and external project starting points, and the [Live View](/docs/live-view/) for the show itself.

## Core Live Workflow

1. Import WAV, AIFF, MP3, FLAC, or other supported audio into `Library`, or import a Reaper/Ableton project to seed the arrangement.
2. Organize assets with virtual folders.
3. Drag audio files, song packages, or external project files into the session, then organize assets with the Library and timeline. Dragging a whole Library folder onto the timeline places all of its audio at once, wrapped in a song named after the folder — each file on its own track, or chained onto a single track with Ctrl/Cmd.
4. Configure the audio device, sample rate, buffer size, hardware outputs, track routes, metronome, and MIDI input.
5. Create song regions, markers, optional meter changes, and region-based transpose changes. Give markers a section type to drive the [Voice Guide](/docs/voice-guide/).
6. Rehearse marker jumps, Vamp, song jumps, transitions, keyboard shortcuts, MIDI mappings, track transpose enable states, and the [custom Remote](/docs/remote-control/). Add an [automation track](/docs/automation/) to fire jumps, mute/solo, fader moves, mix scenes, and [Pad](/docs/ambient-pads/) states automatically at exact points.
7. Export prepared songs, a full `.ltset`, or a reusable `.lttemplate` when you want to reuse work in future sessions.

![Library import workflow](/screenshots/Library-Assets-Import.gif)

## Live Safety Model

Editing is non-destructive. Splitting, moving, duplicating, or arranging clips changes timeline references; it does not rewrite the original audio file.

Transport behavior is also explicit. Marker jumps, song jumps, Vamp loops, metronome behavior, and remote commands are resolved through the same application state and Rust-side transport logic instead of temporary UI timers.

Large imported sources are prepared for disk-backed playback. LibreTracks keeps a bounded RAM cache and reads ahead from the project cache on disk, so larger multitrack sessions can load without requiring every decoded source to stay resident in memory. Audio preparation runs in the background, waveforms load lazily, the PCM cache is reused across sessions when the source file is unchanged, and native-format files can stream in place without going through the cache when possible, so re-opening big projects is much faster. After an update that changes audio processing, the first open may take longer while LibreTracks rebuilds the cache; after that one-time preparation, the saved cache is reused. You can review and clear the decoding cache from `Settings` when you need to free disk space.

Playback never blocks on preparation: pressing play starts the transport immediately, and any track whose audio is still decoding stays silent and joins in on its own the moment it is ready, so already-prepared tracks are never held back by a slow new source. Opening a session does not wait either: the timeline appears right away while audio keeps being prepared in the background, with a non-modal indicator for as long as it lasts. When opening a project LibreTracks also profiles the sample rate of its audio and, if the device supports it, aligns to that rate to avoid converting every file; a sample rate chosen by hand in `Settings` is always respected.

The open session is saved automatically at a regular interval (every 5 minutes by default, configurable in `Settings - General`), so an unexpected failure does not cost you your work. Auto-save never writes while you are playing back, nor when there are no pending changes.

![Automatic session saving in Settings](/screenshots/Settings-General-Autosave.png)

Each song region can independently change tempo and key. Region Warp time-stretches the audio to the timeline BPM while keeping pitch intact, and Region Transpose shifts pitch with or without changing duration depending on whether warp is on. Every song can also carry its own musical key, set from the region's context menu ("Note"), which is shown on the timeline and transposes together with the region's pitch change. See [Pitch, Warp & The T Button](/docs/pitch-and-warp/) for the full decision table.

Clip editing supports Ableton-style flows: Ctrl/Cmd+click and Shift+click for multi-selection, group drag with batched IPC, and Ctrl-during-drag magnets that snap clip edges to the playhead, markers, regions, and other clip edges. Clips can also be dragged vertically to move them onto another track, with the target validated as you drag. Tracks and clips can also be color-coded from the context menu, which makes dense sessions easier to scan.

Folder tracks can act as grouped route owners: child tracks may leave their output on `Inherited (Folder)` so the whole group follows the folder bus automatically while keeping the same visual grouping in the desktop timeline and remote mixer.

Mixing also supports Ableton-style multi-selection: with several tracks selected, acting on any one of them applies the change to all. Mute, solo, transpose and routing match the state of the track you clicked, while volume and pan move relatively (the volume delta in dB), preserving the mix balance. Acting on a track outside the selection is still a single-track edit.

The top bar shows a live resource meter with current CPU and memory usage, so you can tell at a glance when a large session starts to push your machine.

LibreTracks also notifies you in-app when a new version is published, with the changelog in the active app language and a shortcut to the downloads page. The check can be triggered manually from `Settings → General`.

## Main Areas

- `Settings`: audio device, sample rate, buffer size, hardware outputs, metronome, MIDI Learn, customizable keyboard shortcuts, automatic session saving, whether importing songs merges tracks that share a name, and decoding cache management.
- `Library`: imported audio assets, including FLAC files and audio pulled in by Reaper/Ableton imports, plus virtual folders. Collapsed-folder state persists across sessions.
- `Timeline (DAW view)`: audio, folder, and MIDI output tracks; clips; song regions; per-region transpose; markers; time signatures; grid editing; [automation cues](/docs/automation/); and color-coded organization. MIDI clips can send timed notes, controls, program changes, and curves to external show hardware or software. The whole interface can be zoomed and fit to small displays, and the timeline can follow the playhead during playback.
- `Live View`: performance projection of the same model — every marker in the song as a large button with its colour, countdown and cue warnings, the setlist with per-song progress beside it, and the marker jump, song jump and vamp settings always in reach. It adapts from a desktop screen down to a phone, and edits nothing. See [Live View](/docs/live-view/).
- `Compact View`: Session-style projection of the same model — one column per song with its own master fader, a shared horizontal mixer at the bottom, drag-and-drop assets / `.ltpkg` packages / `.rpp` and `.als` projects, and multi-select track reordering. Song columns can be resized by dragging their right edge and the width is saved with the project; a column never becomes narrower than its own header. Track and mixer faders use a decibel (dB) scale like Ableton and Reaper, starting at 0 dB, for precise volume control; the per-song master only affects that song's tracks and never the metronome or voice guide. See [Compact View](/docs/compact-view/).
- `Remote`: local web surface customized with tabs and responsive widgets for transport, jumps, Vamp, markers, songs, mixing, metronome, guide, and Pads. Both section markers and cue markers are shown and can be jumped to, and "Jump to song" is a freely placeable widget of its own. It includes different defaults for phones, tablets, and large screens, and it needs no internet connection — everything is served from your own machine. See [Custom Remote](/docs/remote-control/).
- `File`: reopen recent sessions, create from `.lttemplate`, import songs/packages, import Reaper/Ableton projects, import or export a whole session as a portable `.ltset`, save templates, and export prepared songs. See [Integration & Ecosystem](/docs/integration-ecosystem/).

![Compact View song columns](/screenshots/Compact-View-Song-Columns.png)

![Section and cue markers on the Remote](/screenshots/Remote-Markers-Tablet.png)
