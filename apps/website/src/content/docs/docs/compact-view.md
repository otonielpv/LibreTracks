---
title: Compact View
description: LibreTracks' Ableton Session-style projection — songs as columns, shared mixer, drag-and-drop, .ltpkg import/export, multi-selection and track reorder.
---

The **Compact View** is a second projection of the same project. The DAW view (linear timeline) and the compact view share one underlying model: anything you change in one shows up immediately in the other. Toggle between them with `Tab` or with the `view_module` / `view_timeline` button in the toolbar.

## When To Use Each View

- `DAW view`: edit the arrangement, align waveforms, place markers, tweak fades, mix with everything visible at once.
- `Compact view`: rehearse the set, jump between songs, adjust the mix during the show, see at a glance which song every clip belongs to, and quickly import or export songs.

## The Song As The Primary Object

In this model, **a song (song region) is the primary container of the project**, not the track. Every clip lives inside exactly one song; if you drag it past the boundary of its region, the engine rejects the move to preserve the invariant. Practical consequences:

- Songs can be **reordered, renamed, exported and deleted** as a unit. Deleting a song also deletes the clips that lived inside it and the tempo markers placed in its range.
- A song's **effective BPM** is the value of the closest preceding tempo marker at its start position; with no marker, the global project BPM applies. Creating a new song automatically pins a tempo marker at its `start` so it doesn't inherit the previous song's tempo.
- Tracks are still the vertical lane where clips live, but they can now be **auto-created** when an asset lands in the compact view, and removed automatically when they go empty (see below).

## Zones In The Compact View

The compact view is split into two clearly separated vertical zones:

### 1) Top Strip — Songs

Each song in the project is a horizontal **column**. The column has three parts:

- `Header` with the song name, effective BPM, Play button, and a per-song Master fader + meter.
- `Clip stack` ordered vertically by track position in the project — reading top to bottom matches what the DAW view will show when the playhead enters that song. Each cell shows the clip name and the track it belongs to.
- `Left edge` with a pulsing amber ribbon when the playhead is in that song (independent of selection).

#### Selecting a song

Clicking anywhere on the header (except Play or the fader) **selects the region**. That binds the `Region Transposition` and `Region Warp` groups in the top toolbar to that song. You'll see a full teal border around the header. The amber playhead ribbon and the teal selection border are intentionally visually distinct: amber means "playing here", teal means "this song is the one the region controls are bound to".

> The `Master` control in the top toolbar **does not appear in compact view** because every column already has its own Master fader with meter. It's still available from the DAW view.

#### Song context menu

Right-click the header opens a menu with:

- `Rename song`
- `Change BPM…` — inserts or replaces the tempo marker at the start of the region. It does **not** touch the project's global BPM.
- `Export song` — saves a `.ltpkg` package, identical to the equivalent right-click in the DAW view.
- `Delete song` — destructive. Removes the region, its clips, tempo markers in its range, and prunes auto-created tracks that go empty.

#### Creating or importing songs

At the end of the strip there are two buttons:

- `+ New song` — creates an empty song at the end of the project, anchored to the global BPM.
- `Import .ltpkg` — opens the file dialog filtered to `.ltpkg` and appends the imported song at the end.

You can also **drag a `.ltpkg` from the OS file explorer** anywhere over the strip. While dragging you'll see a **dashed teal ghost column** to the right showing where the import will land, plus a subtle highlight on the whole strip. If the file is unsupported (wrong extension or mixed types), no feedback is painted and the drop is rejected with a status message.

### 2) Bottom Strip — Compact Mixer

A horizontal mixer with one column per project track: name, M/S/T toggles, vertical teal fader with post-fader meter, blue pan slider, and routing selector. `folder` tracks get a darker background and a thicker left accent; child tracks show a `↳ Folder name` hint below the name and a thin ribbon in the parent's colour — Reaper-style. If a track has an assigned colour, that colour is used as the strip accent.

#### Selecting tracks (multi-selection)

Clicking on the strip name or the `↳ parent hint` selects the track. Same convention as the DAW track header:

- `Click` — selects only that track.
- `Ctrl + Click` (or `Cmd + Click`) — adds / removes that track from the current selection.
- `Shift + Click` — selects the range between the last anchor track and this one.

Clicking on controls (M/S/T, fader, pan, routing) does **not** select — those controls keep their own semantics.

Selection is shared with the DAW view: if you pick a track in the compact mixer and switch back to the DAW view, that track is still selected on the header.

#### Reordering tracks with drag-and-drop

Drag from the strip's header (name or parent hint) to move one or more tracks. While dragging:

- The dragged strip fades to ~55% opacity and translates horizontally under the pointer.
- The target strip shows a **vertical teal line** on the **left** (drop before) or **right** (drop after).
- If the target strip is a **folder** and you hover over the central zone (30%–70% of its width), the whole strip lights up teal: dropping there moves the tracks **into** that folder.

If multiple tracks are selected and you drag one of them, all selected tracks move together in a single operation (one snapshot, one history entry).

> The same multi-select + drag works in the DAW track header pane, but vertically. The reorder backend (`moveTrack`) is shared by both views.

#### Track context menu

Right-clicking a strip opens the same track menu the DAW view uses (rename, colour, insert, delete, move in/out of folder, etc.). Anything you change here is reflected immediately in the other view.

## Auto-Created Tracks And Automatic Cleanup

When you drag audio onto a song column (from the Library or from the OS), **each file creates its own clip and its own track** if there's no existing track to drop it on. These tracks carry an internal `auto_created: true` flag that distinguishes them from tracks the user created manually.

Automatic cleanup works like this:

- An auto-created track is deleted **the moment it goes empty**, regardless of what emptied it: deleting the clip, moving the clip to another track, or deleting the song that contained it.
- Manually-created tracks are never deleted on their own, even when empty.

This prevents residual tracks from piling up while you experiment with rapid drops in the compact view. If you want to keep an empty track for future clips, create it manually from the track menu instead of letting one auto-generate.

## Drop Targets And Visual Feedback

The compact view accepts three drop origins:

| Origin | Where accepted | What happens |
|---|---|---|
| Library (internal drag) | Onto a song column | Creates clips + auto-tracks inside that song |
| OS file explorer (audio) | Onto a song column | Creates clips + auto-tracks inside that song |
| OS file explorer (`.ltpkg`) | Anywhere over the strip | Imports the song at the end of the project |
| Any unsupported file | — | Drop rejected with a status message |

During dragover you'll see different feedback depending on the case:

- **Audio over a song column**: as many dashed teal placeholders as files you're about to drop, inside the column's clip stack. The stack background tints light teal.
- **`.ltpkg` over the strip**: a ghost column appears at the end with a `library_music` icon and the text "Import here".
- **Unsupported file**: nothing is painted (the system knows the drop will be rejected).

## Snap, Magnet And Shortcuts

The `Snap to Grid` button in the toolbar now uses a **magnet icon**, visually distinct from the compact-view toggle icon. When snap is off, the magnet is crossed out with a diagonal slash.

Related shortcuts:

- `Tab` — toggle between DAW and compact view.
- `Shift + number` — jump to a song (respects the project-wide transition mode).
- The transposition / warp toolbar bars target the song you've selected in the compact view (or the playhead song if no explicit selection).

## Status Banner

The status banner in the bottom-right corner now auto-hides ~5 seconds after each action. If you need to re-read a message, hover the area before it fades.

## Library: Persistent Folder State

The expanded / collapsed state of Library folders is preserved across sessions. If you close and reopen the Library panel, folders you had collapsed stay collapsed. New folders are created expanded by default.

## Important Invariants

Keep these in mind when designing your workflow:

- A clip belongs to exactly one song region and never crosses the end of its region.
- Deleting a song deletes its clips and the tempo markers in the same range.
- An auto-created track is removed when it loses its last clip. A manual track is not.
- A drop on a song column always creates clips inside that song. A `.ltpkg` always creates a new song at the end.
- Faders, pan, M/S/T and routing on the compact mixer are the **same** mix the DAW view and the remote see: every change propagates instantly.
