---
title: Ambient Pads
description: Pack installation, key, volume, routing, continuous transitions, and control from Remote and automation.
---

**Ambient Pads** are long sustained audio beds for songs, transitions, and spoken moments. They behave as a global live voice like the metronome and voice guide: they are not a project track, and their level is independent from the song master.

## Installing And Managing Packs

Open **Pads** from the Desktop top bar. If no content is installed yet, LibreTracks shows the available pack catalog.

1. Download the pack you want to use.
2. Wait for preparation to finish; each pack contains audio for all 12 keys.
3. Select the pack and a key from C through B.
4. Enable the Pad, then set its volume and output.

Use **Manage packs** to download other sounds or delete packs you no longer need. Packs are not embedded in sessions or exports because they are user-installed resources and may consume substantial storage.

## Controls

- **Enable Pad**: starts or mutes the ambient voice with a short ramp to prevent clicks.
- **Pack**: selects a fully installed pack.
- **Key**: selects any of the 12 chromatic keys.
- **Volume**: uses the same musical dB scale as the other live faders.
- **Output**: routes the Pad to Master, Monitor, or an enabled physical output.

The Pad is mixed independently from the song master. This lets it remain underneath a song fade or transition, and allows routing it separately from playback when the rig requires it.

## Seamless Key And Pack Changes

LibreTracks prepares the replacement audio away from the playback thread while the current Pad keeps playing. Once ready:

1. The replacement enters at the equivalent loop time instead of replaying the recorded attack from the beginning.
2. The previous and replacement Pads play together through a short constant-power crossfade.
3. The previous audio is released after the overlap finishes.

The result behaves like a Legato change: there is no former silent midpoint between fade-out and fade-in. If the replacement file is missing or cannot be decoded, LibreTracks keeps the previous Pad audible instead of dropping the ambience.

## Remote Control

The default [Remote](/docs/remote-control/) layout includes a Pad widget in the **Tools** tab. It can enable the Pad, select pack and key, set volume, and change routing. The catalog comes from Desktop, so pack installation and deletion happen on the main computer.

The widget can also be placed on any tab, resized, or used to build a dedicated Pad and transition surface.

## Pad Automation

Add a **Control Pads** action to an [Automation](/docs/automation/) cue. The action stores the same state available manually:

- Enabled or disabled.
- Installed pack.
- Key.
- Volume on the fader/dB scale.
- Output routing.

When the cue fires, pack and key changes use the exact same loader, continuous position, and crossfade as manual control. This supports planned modulations, texture changes by section, or preparing the next song's Pad without another live operation.

## Preparing For A Show

- Download and test every pack before the show; do not rely on a live download.
- Verify the Pad output independently from click and guide outputs.
- Rehearse modulations and automation with the same pack and audio device used live.
- Keep level headroom: two textures overlap briefly during a crossfade.
