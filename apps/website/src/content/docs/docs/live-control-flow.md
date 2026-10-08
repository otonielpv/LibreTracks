---
title: Live control
description: Marker jumps, Vamp, song jumps, transitions, shortcuts, and remote control.
---

## Marker Jump Modes

LibreTracks supports three marker jump behaviors:

- `Immediate`: jump instantly.
- `At next marker`: wait until the next section boundary.
- `After X bars`: schedule the jump after the configured number of bars.

This is native transport behavior, so the same logic is available from desktop controls, keyboard shortcuts, MIDI mappings, and the remote.

![Marker jump modes](/screenshots/Marker-Jump-Modes.png)

When the [Voice Guide](/docs/voice-guide/) is enabled, an armed jump to a typed marker is announced and counted in before it fires, so the band hears the destination section and lands together on the downbeat.

## Vamp

`Vamp` keeps playback looping musically while the band, stage action, or speaker needs more time. `Vamp Mode` can repeat the current `Section` or a fixed number of `Bars`. Press `Vamp` again to leave the loop.

![Vamp configuration](/screenshots/Vamp-Config.png)

## Song Jumps And Transitions

Song jumps target song regions. They are useful when one session contains a full set, a rehearsal timeline, or several cues.

The trigger can be immediate, after a configured number of bars, at the end of the current song/region, or at the next section marker.

`Song Transition` controls how the current song hands off to the next one:

- `Clean cut`: switches directly.
- `Fade out`: fades current playback before the jump.

![Song jump configuration](/screenshots/Song-Jump-Config.png)

## Keyboard shortcuts

They can all be changed in **Settings › Shortcuts** (see
[Settings](/docs/interface/settings/#shortcuts)). The defaults:

| Key | Action |
| --- | --- |
| <kbd>Space</kbd> | Play / pause |
| <kbd>Shift</kbd>+<kbd>Space</kbd> | Stop (back to the start) |
| <kbd>Home</kbd> | Go to the start |
| <kbd>0</kbd> … <kbd>9</kbd> | Jump to the 1st … 10th marker in the session, in time order and counting cues too (the same key again cancels) |
| <kbd>Shift</kbd>+<kbd>0</kbd> … <kbd>9</kbd> | Jump to song no. 1 … 10 |
| <kbd>Esc</kbd> | Cancel a pending jump or clear the selection |
| <kbd>S</kbd> | Split the selected clips at the cursor |
| <kbd>Shift</kbd>+<kbd>S</kbd> | Split the song at the cursor |
| <kbd>Ctrl</kbd>+<kbd>C</kbd> / <kbd>Ctrl</kbd>+<kbd>V</kbd> | Copy / paste clips |
| <kbd>Ctrl</kbd>+<kbd>D</kbd> | Duplicate |
| <kbd>Del</kbd> or <kbd>Backspace</kbd> | Delete the selection (clips, tracks or song) |
| <kbd>F2</kbd> | Rename the selected song, track or marker |
| <kbd>Ctrl</kbd>+<kbd>Z</kbd> | Undo |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> or <kbd>Ctrl</kbd>+<kbd>Y</kbd> | Redo |
| <kbd>Ctrl</kbd>+<kbd>A</kbd> | Select all clips |
| <kbd>←</kbd> / <kbd>→</kbd> | Nudge the selected clips by one division |
| <kbd>Ctrl</kbd>+<kbd>S</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> | Save / save as |
| <kbd>Tab</kbd> / <kbd>Shift</kbd>+<kbd>Tab</kbd> | Switch view: DAW, Compact, Live (and back) |
| <kbd>Ctrl</kbd>+<kbd>+</kbd> / <kbd>Ctrl</kbd>+<kbd>-</kbd> / <kbd>Ctrl</kbd>+<kbd>0</kbd> | Enlarge, shrink or reset the interface |
| <kbd>B</kbd> | Video: instant black |

The video actions *fade to black*, *idle screen* and *turn output on* have no
default key; assign them yourself if you use them.

If you arm the wrong destination, press `Esc` immediately.

## Transpose And Warp In Live Use

`Region Transpose`, `Region Warp`, and the per-track `T` toggle decide how each clip sounds and how the timeline grid shifts. The interaction between these three is the same Ableton-style model — see [Pitch, Warp & The T Button](/docs/pitch-and-warp/) for the full decision table and grid behavior.

In live use, the rule of thumb is:

- Change the key between songs or with playback stopped when you can — retiming pitch mid-playback can cause brief CPU spikes on modest machines.
- Enable `Region Warp` when the band wants a tempo change without changing key, or when you need pitch changes that preserve clip length.
- Use the per-track `T` toggle only with warp on, to keep a click or guide track in its original key while the rest of the song transposes.

## Mobile Remote

Open `Remote` in the desktop app, then scan the QR code or open the displayed URL from a phone or tablet on the same local network.

![Remote connection panel](/screenshots/Remote.png)

The remote exposes transport, marker jumps, song jumps, Vamp controls, song transition mode, region navigation, transpose controls, and a mixer view for volume, pan, mute, and solo. Its editor builds custom tabs from responsive widgets for phones, tablets, and large screens; see [Custom Remote](/docs/remote-control/) for the complete workflow.

The mixer view now behaves more like a live utility surface: it keeps draft volume and pan changes responsive while you drag, shows per-track meters, offers a quick center action for pan, and mirrors folder color grouping so it is easier to identify groups from a phone.

![Remote mixer](/screenshots/Remote_Mixer.png)
