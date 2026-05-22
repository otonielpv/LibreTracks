---
title: Live Control Flow
description: Marker jumps, Vamp, song jumps, transitions, shortcuts, and remote control.
---

## Marker Jump Modes

LibreTracks supports three marker jump behaviors:

- `Immediate`: jump instantly.
- `At next marker`: wait until the next section boundary.
- `After X bars`: schedule the jump after the configured number of bars.

This is native transport behavior, so the same logic is available from desktop controls, keyboard shortcuts, MIDI mappings, and the remote.

![Marker jump modes](/screenshots/Marker-Jump-Modes.png)

## Vamp

`Vamp` keeps playback looping musically while the band, stage action, or speaker needs more time. `Vamp Mode` can repeat the current `Section` or a fixed number of `Bars`. Press `Vamp` again to leave the loop.

![Vamp configuration](/screenshots/Vamp-Config.png)

## Song Jumps And Transitions

Song jumps target song regions. They are useful when one session contains a full set, a rehearsal timeline, or several cues.

The trigger can be immediate, after a configured number of bars, or at the end of the current song/region.

`Song Transition` controls how the current song hands off to the next one:

- `Clean cut`: switches directly.
- `Fade out`: fades current playback before the jump.

![Song jump configuration](/screenshots/Song-Jump-Config.png)

## Shortcuts

- `Space`: toggle `Play` / `Pause`
- `Esc`: cancel a pending jump
- `0-9`: arm a jump to the corresponding marker
- `Shift + 0-9`: arm a jump to the selected song region

If you arm the wrong destination, press `Esc` immediately.

## Transpose In Live Use

LibreTracks can change pitch at two levels during rehearsal or show prep:

- `Region Transpose` changes the key for the selected song region.
- Track transpose enable lets you decide which tracks should follow that pitch change and which ones should stay untouched.

This is useful when guide tracks, click-related material, or fixed references should remain in place while musical stems move with the song.

:::caution[Change pitch before playback when possible]
Whenever you can, set the transpose **before pressing Play**. Changing pitch while a song is already playing forces LibreTracks to rebuild the pitch-engine voices in the background, and on modest CPUs that can cause brief audio dropouts or interference for a few seconds until the engine finishes preparing. In a live show, switch the key between songs or with playback stopped.
:::

## Mobile Remote

Open `Remote` in the desktop app, then scan the QR code or open the displayed URL from a phone or tablet on the same local network.

![Remote connection panel](/screenshots/Remote.png)

The remote exposes transport, marker jumps, song jumps, Vamp controls, song transition mode, region navigation, transpose controls, and a mixer view for volume, pan, mute, and solo.

![Remote mixer](/screenshots/Remote_Mixer.png)
