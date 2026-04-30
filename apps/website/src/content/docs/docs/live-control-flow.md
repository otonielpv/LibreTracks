---
title: Live Control Flow
description: Jump logic, Vamp mode, song transitions, MIDI, and remote control.
---

## Marker Jump Logic

LibreTracks supports three marker jump triggers:

- `Immediate` jumps as soon as the command is accepted.
- `Next Marker` waits until the next section marker boundary.
- `After X Bars` schedules the jump on a musical bar boundary using tempo and time signature data.

This is the main difference from configuring a traditional DAW with action chains or macros. Jump behavior is native transport behavior, available to desktop controls, MIDI mappings, keyboard shortcuts, and remote commands.

Pending jumps can be cancelled before they execute.

## Vamp Mode

Vamp keeps playback looping while the band, stage action, or speaker needs more time.

LibreTracks supports two Vamp modes:

- `Section` loops the current section.
- `Bars` loops a fixed number of bars.

Pressing Vamp again leaves the loop. The active Vamp state is part of the playback snapshot so desktop and remote views can stay aligned.

## Song Jumps

Song jumps target song regions. They are useful when one timeline contains a full set, a rehearsal session, or multiple show cues.

The current controls support immediate song jumps, jumps after a configured number of bars, and jumps at the end of the current song region.

## Song Transitions

Song transition mode controls how playback moves between song regions:

- `Clean cut` switches directly.
- `Fade out` fades the current playback before the transition.

Use clean cuts for rehearsed hard stops or theatrical cues. Use fade-outs when the next region should enter after a smoother handoff.

## MIDI Learn

MIDI Learn maps incoming notes or CC messages to live actions. Practical mappings include Play, Stop, marker jumps, song jumps, Vamp, global jump mode, song transition mode, and bar-count adjustments.

The desktop settings store the selected MIDI input device and mappings so the live rig can be prepared before rehearsal.
