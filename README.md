[🇪🇸 Leer en Español](./README.es.md)

# LibreTracks

![Tauri](https://img.shields.io/badge/Tauri-v2-24C8DB?logo=tauri&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=111827)
![Rust](https://img.shields.io/badge/Rust-stable-000000?logo=rust&logoColor=white)
![Node](https://img.shields.io/badge/Node-%3E%3D20-339933?logo=node.js&logoColor=white)

LibreTracks is a multitrack DAW and live playback workstation for desktop, built with a Rust audio stack and a React/Tauri shell. The current monorepo focuses on non-destructive arrangement, live section jumps, WAV import, and a desktop runtime that keeps audio concerns separate from UI concerns.

## Screenshots
| Screenshot | Screenshot |
| --- | --- |
| Startup<br>![Startup screen](./screenshots/Inicio.png) | Empty Session<br>![Empty session](./screenshots/Vacio.png) |
| Project View<br>![Project view](./screenshots/Proyecto.png) | Remote Connection<br>![Remote connection](./screenshots/Remote.png) |
| Remote Mixer<br>![Remote mixer](./screenshots/Remote_Mixer.png) |  |

## Architecture Overview

LibreTracks is split into two clear layers:

- `apps/desktop` is the desktop frontend. It uses React, Zustand state stores, and canvas-based timeline rendering for the arrangement view, ruler, markers, and waveform lanes.
- `apps/desktop/src-tauri` is the native bridge. It exposes Tauri commands, manages desktop state, applies audio settings, and connects the UI to the Rust runtime.
- `crates/libretracks-core` contains the domain model and validation rules for songs, tracks, clips, markers, buses, and tempo data.
- `crates/libretracks-audio` contains the transport and mixing logic. It resolves active clips, effective track gain, play/pause/seek, and musical jump behavior.
- `crates/libretracks-project` handles project persistence, `song.json`, library assets, and WAV probing/import through `symphonia`.
- The native desktop audio path uses `cpal` for output device I/O. WAV decoding and metadata probing are handled through `symphonia` in the project/import layer.

This separation matters: the frontend decides how to present and edit the session, while the Rust side owns transport rules, persistence, validation, and audio behavior.

## Prerequisites

The desktop workflow assumes the following tools are installed:

- Node.js `>= 20`
- Rust stable toolchain with `cargo` and `rustc`
- Microsoft Visual C++ Build Tools on Windows
- Windows 10/11 SDK on Windows for MSVC linking

For Windows native desktop runs, `scripts/desktop-native.ps1` checks for the MSVC linker and SDK libraries. In practice, install Visual Studio Build Tools with the `Desktop development with C++` workload before running the native Tauri target.

## Getting Started

Install workspace dependencies from the repository root:

```bash
npm install
```

Useful root-level commands:

```bash
# Desktop UI in Vite dev mode
npm run dev:desktop

# Full native desktop app through Tauri + Rust
npm run dev:desktop:native

# Production frontend bundle for the desktop app
npm run build:desktop

# Rust tests across the workspace
cargo test
```

Additional commands that are useful during development:

```bash
# Native Rust compile check through the Windows helper script
npm run check:desktop:native

# Frontend tests and lint/typecheck
npm run test:desktop
npm run lint

# Headless desktop Rust tests on Windows CI or machines without audio hardware
LIBRETRACKS_DUMMY_AUDIO=1 cargo test --locked -p libretracks-desktop -- --test-threads=1
```

When `LIBRETRACKS_DUMMY_AUDIO` is set to `1` or `true`, the desktop audio runtime skips `cpal` device discovery and falls back to the existing null playback backend. This is intended for headless Windows CI, where WASAPI initialization can fail without audio hardware.

The desktop Rust test command above also forces `--test-threads=1`. That keeps tests deterministic when temporary WAV fixtures are backed by `memmap2`, so mapped files are released predictably before Windows tears down the temp directory.

## Remote Control (Desktop + Mobile)

LibreTracks now includes an integrated remote access flow in the desktop UI:

1. Open `Remote` from the left navigation.
2. In the `Connect mobile remote` card, scan the QR code or open one of the generated URLs (`IP` or `.local hostname`) from your phone/tablet browser.
3. Keep desktop and mobile devices on the same network.

The remote web surface mirrors live actions from desktop and exposes transport controls, jump controls, and a dedicated mixer view for fast level/mute/solo adjustments during rehearsals and shows.

## Project Structure

```txt
.
├─ apps/
│  ├─ desktop/            React + Tauri desktop application
│  │  ├─ src/             UI, Zustand stores, i18n, timeline canvas rendering
│  │  └─ src-tauri/       Native Tauri host, commands, audio runtime, CPAL wiring
│  └─ remote/             Web remote client for secondary control surfaces
├─ crates/
│  ├─ libretracks-core/   Shared domain model, validation, transport-facing types
│  ├─ libretracks-project/ Project I/O, song persistence, WAV import, Symphonia-based probing
│  ├─ libretracks-audio/  Audio engine logic, transport, clip activation, jump scheduling
│  └─ libretracks-remote/ Remote control protocol and backend-facing helpers
├─ docs/                  Architecture notes, debugging docs, roadmap
├─ samples/               Example song assets and demo material
├─ scripts/               Development helpers, including Windows native bootstrap
├─ tests/                 End-to-end and integration-oriented test surfaces
├─ Cargo.toml             Rust workspace manifest
└─ package.json           JavaScript workspace manifest and root scripts
```

## Notes for Contributors

- The app is currently WAV-first by design.
- Track routing starts from the `main` and `monitor` buses.
- The transport supports immediate jumps, next-marker jumps, and quantized bar-based jumps.
- UI labels are localized from `apps/desktop/src/shared/i18n/en.ts` and `es.ts`; documentation should follow those exact strings when describing the interface.
