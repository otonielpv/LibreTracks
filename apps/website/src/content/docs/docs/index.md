---
title: LibreTracks Documentation
description: Technical and user documentation for LibreTracks.
---

LibreTracks is a desktop multitrack playback workstation for live musicians, musical directors, and playback engineers. It is built around a Rust audio stack, a React/Tauri desktop shell, and a local web remote.

The important design rule is separation: React presents the session and editing tools, while Rust owns transport behavior, audio routing, persistence, validation, remote commands, and live jump scheduling.

## What LibreTracks Is For

LibreTracks is for playback and live interaction. It helps you prepare WAV assets, arrange clips on a timeline, route stems and click tracks, create section markers, define song regions, and adapt the show in real time.

It is not meant to replace a production DAW for composing, recording, plug-in chains, or mixing records. Use Reaper, Ableton Live, Logic, Cubase, or another studio DAW for production, then bring the prepared WAV playback material into LibreTracks for the live rig.

## Codebase Map

- `apps/desktop` contains the React desktop UI, timeline canvas, Zustand stores, localization, and Tauri command calls.
- `apps/desktop/src-tauri` hosts the native desktop bridge, app state, settings, MIDI, remote server, and audio runtime coordination.
- `crates/libretracks-core` defines projects, songs, tracks, clips, markers, tempo markers, time signature markers, song regions, routing strings, and validation.
- `crates/libretracks-audio` resolves transport state, active clips, effective gains, jump scheduling, Vamp loops, song transitions, and metronome behavior.
- `crates/libretracks-project` handles `song.json`, library assets, package import/export, and WAV metadata probing.
- `crates/libretracks-remote` defines the remote protocol and serves state/control messages for the mobile browser remote.

## Current Format Bias

The project is WAV-first. The importer and playback documentation assume WAV assets as the reliable live-performance format.

## Live Safety Model

Edits are non-destructive. Splitting, moving, and duplicating clips changes timeline references such as `timelineStartSeconds`, `sourceStartSeconds`, and `durationSeconds`; it does not rewrite the original audio file.

Live control is also explicit. Jump behavior is represented as transport state, not as a UI timer, so the same concepts are available from desktop, MIDI Learn, and the remote.
