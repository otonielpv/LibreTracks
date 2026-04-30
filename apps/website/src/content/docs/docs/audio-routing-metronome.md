---
title: Audio Routing & Metronome
description: Master routing, external outputs, and the internal metronome.
---

## Routing Strings

Tracks store their destination in `audioTo`. The core parser resolves common routes:

- `master` and `main` route to the main stereo pair.
- `monitor` routes to channels 2-3 when at least four hardware channels are available, otherwise it falls back to the main pair.
- `ext:0` routes to physical channel 0.
- `ext:2-3` routes to a stereo physical pair using zero-based external channel indexes.

The parser also accepts hardware-style output names such as `out 1` or `out_1`, converting them to the matching zero-based channel internally.

## Master Vs. Physical Outputs

Use `Master` for musical playback that should follow the main mix. Use external outputs for material that must bypass the main mix, such as click, count-ins, spoken cues, or guide stems.

The desktop settings panel controls which output channels are enabled. Track headers can then choose the route.

## Metronome

LibreTracks includes a synthesized metronome. It does not require a separate imported audio file.

The settings model stores:

- Whether the metronome is enabled.
- Metronome volume.
- Metronome output route.

The audio runtime applies metronome settings independently from regular clip playback, which lets click routing remain separate from the Master bus.

## Live Routing Pattern

A typical live setup is:

- Playback stems to `Master`.
- Click and cue tracks to an external output such as `ext:2-3`.
- Metronome to the same cue output or another dedicated channel.

Always rehearse with the same interface and channel map that will be used on stage.
