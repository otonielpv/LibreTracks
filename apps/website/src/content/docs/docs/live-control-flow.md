---
title: Live control
description: "How to move around the setlist live with LibreTracks: jumps to markers and songs, when they happen, Vamp, transitions, keyboard shortcuts, MIDI pedal and the Remote."
---

Live, almost everything comes down to three questions: **where** you jump,
**when** the jump happens and **how** the change sounds. LibreTracks answers
all three the same way from the keyboard, [Live View](/docs/live-view/), a MIDI
pedal or the [Remote](/docs/remote-control/): they all schedule the same jump.

## Jumping to a marker

A click on a section marker (or its number key) **schedules** the jump. The
*Marker Jump* setting in the toolbar decides when it happens:

![The marker jump settings](/guide/desktop-en/toolbar-marker-jump-panel.png)

- **Immediate**: right away.
- **After X bars**: once the bars you set have gone by.
- **At next marker**: when the next section arrives, so the change lands at the
  start of a phrase.

While it waits, **Cancel jump** lights up; <kbd>Esc</kbd> or a click on the same
marker calls it off. With the [voice guide](/docs/voice-guide/) on, the band
hears the destination section and the count-in before the jump.

## Vamp: repeat until it is time

**Vamp** loops a stretch while the band stretches an ending, someone speaks or
more time is needed. Choose what repeats:

![The Vamp settings](/guide/desktop-en/toolbar-vamp-panel.png)

- **Section**: the section the cursor is in.
- **Bars**: the number of bars you set.

Press **Vamp** again to leave; the song carries on from there.

## Moving to another song

The **Previous** and **Next** buttons, <kbd>Shift</kbd>+number, Live View or the
Remote jump between songs. *Song Transition* decides when and how:

![The song transition settings](/guide/desktop-en/toolbar-song-jump-panel.png)

- **When**: immediately, at the end of the song, after a few bars or at the
  next marker.
- **How**: **Clean cut** or **Fade out** of the song that is playing.

If you would rather playback stopped between songs, turn on *Pause at the end
of each song* in Settings › General.

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

If you schedule the wrong jump, press <kbd>Esc</kbd> straight away.

## With a MIDI pedal

Any action on this page can be assigned to a pedal or a button on your
controller: jump to marker 3, next song, Vamp, cancel jump… See
[MIDI](/docs/tasks/midi/).

## From the phone: the Remote

Open **Remote** in the side bar, scan the QR code with the phone or tablet
(same Wi‑Fi) and the band has transport, jumps, Vamp, pitch and the mix in
their hands. See [Custom Remote](/docs/remote-control/).

## Changing key live

Make pitch changes **before pressing Play** or between songs: changing it
while it plays makes the engine rearrange its voices and, on modest computers,
can cause small dropouts. How pitch, warp and the **T** button combine is in
[Pitch, warp and the T button](/docs/pitch-and-warp/).
