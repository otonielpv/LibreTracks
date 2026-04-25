# LibreTracks User Manual

LibreTracks is designed for music directors, playback engineers, and performers who need a desktop multitrack rig that is predictable on stage. The app keeps editing non-destructive and the audio engine separate from the React UI, so arranging, saving, and performing do not depend on fragile in-place audio edits.

> ⚠️ Live tip: build your show in advance, save the project, and rehearse your jump flow with the same output device you will use on stage.

## 1. Introduction

LibreTracks lets you import WAV files, organize them into a song timeline, and trigger musical jumps between sections during playback.

Why it is safe for live use:

- Editing is non-destructive. Your original WAV files are not rewritten when you move or split clips.
- The desktop runtime keeps the audio engine separate from the UI layer.
- Transport behavior such as `Immediate`, `At next marker`, and `After X bars` is resolved by Rust-side logic instead of ad-hoc UI timing.

## 2. Audio Setup

### Open `Settings`

1. Open `Settings` from the desktop shell.
2. In the audio panel, choose the correct `Audio device`.
3. Confirm the output before rehearsal and before doors open.

If `Audio device` is left on `System Default`, LibreTracks follows the operating system default output. For a live rig, a dedicated interface is usually safer than the system default.

### Use `Split Stereo Mode (Monitor L / Main R)`

This is the key live-playback feature.

When `Split Stereo Mode (Monitor L / Main R)` is enabled:

- Everything routed to the `Monitor` bus is forced to the left channel.
- Everything routed to the `Main` bus is forced to the right channel.
- Regular pan behavior is preserved when the mode is off.

Typical stage use:

- Put click, count-ins, spoken cues, or guide tracks on `Monitor`.
- Put stems, tracks, or musical playback on `Main`.
- Send the left channel to the MD / drummer cue feed and the right channel to FOH or a playback rack input.

> 🎛️ Practical result: one stereo pair becomes a simple live split, with cue material on the left and show material on the right.

## 3. Project Organization

### `Library`

Use `Library` as the preparation area for your show assets.

1. Open `Library`.
2. Click `Import audio`.
3. Select one or more WAV files.
4. Drag those assets onto the timeline when you are ready to arrange them.

`Create virtual folder` helps you group assets by set, scene, song section, or instrumentation without changing the original source files. A practical setup is one virtual folder per song or per show segment.

### `Audio track` vs `Folder track`

- `Audio track` is where clips live and play back.
- `Folder track` is for organization and grouped control of child tracks.

Use `Folder track` when you want to keep stems together, such as drums, band tracks, choirs, or background vocals. Use `Audio track` when you need a lane that actually holds clips.

## 4. Basic Editing (Timeline)

LibreTracks keeps the timeline direct and performance-oriented.

### Add and move clips

- Drag assets from `Library` to the timeline.
- On an empty arrangement, dropping from `Library` creates the first `Audio track` automatically.
- Move a clip by dragging it to a new timeline position.

### Duplicate clips

- Right-click a clip.
- Choose `Duplicate`.

This is useful for loops, repeated hits, and backing parts that need to come back later in the song.

### Split clips

1. Move the playhead or cursor to the split point.
2. Right-click the clip.
3. Choose `Split At Cursor`.

This is the fastest way to trim arrangement structure without touching the source WAV.

### Use `Snap to Grid`

Keep `Snap to Grid` enabled when you want clips, cursor moves, and edits to land on musical divisions. Turn it off only when you need a free placement that ignores the current rhythmic grid.

## 5. Live Control: Navigation and Jumps

### `Markers`

Create section markers from the ruler:

1. Right-click the ruler.
2. Choose `Create Marker`.
3. Rename the marker if needed.

LibreTracks can display markers with a numeric prefix such as `1. Intro`. In the current desktop build, the `0-9` jump shortcuts are resolved by marker order on the timeline: `0` targets the first marker, `1` the second, and so on. The data model already includes per-marker digit metadata, but a dedicated digit-assignment control is not exposed in the current UI.

### `Jump` modes

Set the global jump behavior from `Jump`:

- `Immediate`: jump right now.
- `At next marker`: wait for the current section boundary and jump at the next marker.
- `After X bars`: quantize the jump so it happens after the configured number of bars.

This lets you recover in real time if the band extends a chorus, skips a bridge, or needs to repeat a section.

### Shortcuts

- `Space`: toggle `Play` / `Pause`
- `Esc`: cancel a pending jump
- `0-9`: arm a jump to the corresponding marker slot

If you arm the wrong section, press `Esc` immediately. If no marker exists for that slot, LibreTracks reports that no marker is available for that digit.