---
title: Custom Remote
description: Phone and tablet connection, device-aware layouts, widgets, and touch editing for the Remote surface.
---

The **Remote** is a local web surface controlling the same transport, mix, and live settings as LibreTracks Desktop. The browser does not play audio: every change is sent to the main computer and resolved by the session engine.

## Connecting A Device

1. Open `Remote` in LibreTracks Desktop.
2. Connect the computer and phone or tablet to the same local network.
3. Scan the QR code or open one of the addresses shown by Desktop.
4. Keep LibreTracks and the Remote server open during rehearsal or performance.

If the device cannot connect, check that the network allows client-to-client traffic and that the computer firewall is not blocking LibreTracks.

![Remote connection panel](/screenshots/Remote.png)

## Device-Aware Layouts

The first launch uses a different layout for phones, tablets, and large screens. The default interface level is **1**; the `-` and `+` buttons change visual scale without rewriting saved widget positions.

The default layout has three tabs:

- **Controls**: playback information, transport, timeline, Vamp/jumps/transition, and markers.
- **Mixer**: full mixer with song filter, song master, and faders.
- **Tools**: metronome, voice guide, and ambient Pad settings.

Phone presets reduce timeline and transport height, keep markers visible before page scrolling, and stack tools into touch-friendly panels. Tablet presets use the available width for denser panels and columns.

## Editing The Layout

Press **Edit layout** to open an absolute 24-column grid inspired by Mixing Station. The editing canvas represents the real area where widgets remain after editing.

- Drag a widget by its header to move it.
- Drag the bottom-right corner grip to change width and height.
- Dragging a new widget from the panel shows its complete default rectangle before dropping. Pointer Events provide real touch dragging on phones and tablets.
- Press **Remove** in the editing header to delete an instance.
- Use **Hide widgets** when the component panel covers a resize grip underneath it.
- Add, rename, or remove tabs to separate controls by purpose.

The widget panel is grouped into **Information**, **Transport**, **Live control**, **Songs**, **Mixer**, **Tools**, and **Layout**.

When finished:

- **Done** keeps and applies the edited geometry.
- **Cancel** restores everything from before editing began.
- **Export** downloads the layout as JSON for another browser or device.
- **Import** validates and loads an exported layout, including compatible older layouts.
- **Reset layout** restores the preset for the current device family.

Layouts are stored locally by that browser. Export a copy before moving to another device or clearing browser data.

## Available Widgets

Use complete widgets or split a section into independent controls:

- Combined readouts or separate time, bar/beat, BPM, time signature, and song readouts.
- Combined transport or separate play, pause, stop, click, and guide buttons.
- Centered timeline, combined control deck, or separate Vamp, jump, transition, and song/transpose panels.
- Marker grid, next section/song, current key, and progress/countdown readouts.
- Full mixer or separate song filter, song master, and fader widgets.
- Compact song and clip view with **Active/All** scope. Every clip explicitly identifies its track. In **All**, songs always stay in one horizontally scrolling row; increasing the widget height enlarges the cards but never creates another row. Clip lists scroll independently, but vertical gestures continue scrolling the tab when a list reaches its edge. Playing a song starts transport from its beginning when stopped or paused; during playback it honours the configured global transition.
- Ambient Pads, metronome settings, and voice guide settings.
- **Layout** offers configurable titles and notes, invisible blank spaces, separators, and groups. In the editor, drag a widget completely inside the group area below its header: the frame highlights to confirm it will be associated when dropped. It then moves with the group; dragging it outside makes it independent again. Removing the group does not remove its controls.

Widgets adapt their content, typography, columns, and internal scrolling to their rectangle. A small box does not squeeze every marker or control until it becomes unreadable; long areas receive their own scroll.

The **Config** buttons for Vamp, jump, and transition open a floating panel above the layout. Its content neither increases the widget height nor gets clipped when the widget is small; the panel scrolls internally when needed and closes by pressing outside, its close button, or `Escape`.

## Live Tools

The Remote can change:

- **Metronome**: state, volume, output, accent, accent/beat sounds and pitch, subdivision, and subdivision level.
- **Voice guide**: state, volume, output, language, lead bars, and count-in.
- **Pads**: state, installed pack, key, volume, and routing.

Pad packs are installed and managed from Desktop; the Remote lists complete packs available on the main computer. See [Ambient Pads](/docs/ambient-pads/) for playback and automation behavior.

## Show Recommendations

- Design and test the layout using the same orientation and interface level planned for the show.
- Avoid page scrolling for essential controls; reserve internal scrolling for markers, faders, or secondary tools.
- Export the final layout before the show.
- Keep the Desktop computer wired to the network where possible and use a dedicated or stable Wi-Fi network for the Remote device.
