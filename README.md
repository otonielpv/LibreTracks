[🇪🇸 Leer en Español](./README.es.md)

# LibreTracks

![Tauri](https://img.shields.io/badge/Tauri-v2-24C8DB?logo=tauri&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=111827)
![Rust](https://img.shields.io/badge/Rust-stable-000000?logo=rust&logoColor=white)
![Node](https://img.shields.io/badge/Node-%3E%3D20-339933?logo=node.js&logoColor=white)

LibreTracks is a multitrack DAW and live playback workstation for desktop, built with a C++ Audio Engine v2 behind a React/Tauri shell. The current monorepo focuses on non-destructive arrangement, live section jumps, audio import, and a native engine boundary that keeps realtime audio concerns separate from UI concerns.

## Support LibreTracks

LibreTracks is free and maintained in personal time. If it is useful to you, you can make a voluntary donation to support maintenance, testing, documentation, releases, and ongoing development.

Donations do not unlock extra features, priority support, early access, roadmap commitments, or any other benefit. They are simply a way to support the project.

[Support LibreTracks on Ko-fi](https://ko-fi.com/otonielpv)

## Screenshots
| Screenshot | Screenshot |
| --- | --- |
| Startup<br>![Startup screen](./screenshots/Inicio.png) | Empty Session<br>![Empty session](./screenshots/Vacio.png) |
| Project View<br>![Project view](./screenshots/Proyecto.png) | Remote Connection<br>![Remote connection](./screenshots/Remote.png) |
| Remote Mixer<br>![Remote mixer](./screenshots/Remote_Mixer.png) |  |

## Architecture Overview

LibreTracks is split into two clear layers:

- `apps/desktop` is the desktop frontend. It uses React, Zustand state stores, and canvas-based timeline rendering for the arrangement view, ruler, markers, and waveform lanes.
- `apps/desktop/src-tauri` is the native bridge. It exposes Tauri commands, manages desktop state, applies audio settings, and connects the UI to the C++ Audio Engine v2 FFI layer.
- `crates/libretracks-core` contains the domain model and validation rules for songs, tracks, clips, markers, buses, and tempo data.
- `crates/libretracks-audio` contains the product-level transport rules used by the desktop session model. The realtime playback implementation now lives in the C++ engine.
- `crates/libretracks-project` handles project persistence, `song.json`, library assets, LibreTracks package import, and WAV probing/import through `symphonia`.
- `native/audio-engine-v2` contains the C++ playback engine, device layer, scheduler, renderer, source preparation, pitch pipeline, and diagnostics.

This separation matters: the frontend decides how to present and edit the session, Rust owns app/backend orchestration and persistence, and C++ owns realtime playback.

## Prerequisites

The desktop workflow assumes the following tools are installed:

- Node.js `>= 20`
- Rust stable toolchain with `cargo` and `rustc`
- On Linux (Debian/Ubuntu), install system packages for Tauri and the C++ audio engine:
  ```bash
  sudo apt install -y \
    cmake build-essential pkg-config \
    libasound2-dev \
    libwebkit2gtk-4.1-dev libgtk-3-dev \
    libayatana-appindicator3-dev librsvg2-dev patchelf
  ```
- Microsoft Visual C++ Build Tools on Windows
- Windows 10/11 SDK on Windows for MSVC linking
- LLVM/Clang with `libclang.dll` on Windows for bindgen-based crates

For Windows native desktop runs, `scripts/desktop-native.ps1` checks for the MSVC linker and SDK libraries. In practice, install Visual Studio Build Tools with the `Desktop development with C++` workload before running the native Tauri target. The root `npm run *:desktop:native` scripts now route to that Windows helper automatically and run directly on Linux/macOS.

If `cargo check` later reports that bindgen cannot find `libclang`, install LLVM and set `LIBCLANG_PATH` to the directory that contains `libclang.dll` (for example `C:\Program Files\LLVM\bin`). If `winget install -e --id LLVM.LLVM` does not complete on your machine, install LLVM manually from the official installer or use another package manager such as Chocolatey.

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
# Native Rust compile check through the cross-platform native launcher
npm run check:desktop:native

# Frontend tests and lint/typecheck
npm run test:desktop
npm run lint

# Headless desktop Rust tests
cargo test --locked -p libretracks-desktop -- --test-threads=1
```

The native desktop launcher builds `native/audio-engine-v2`, sets `LT_ENGINE_V2_LIB_DIR`, and then starts/checks/builds the Tauri app against the C++ v2 engine.

## Remote Control (Desktop + Mobile)

LibreTracks now includes an integrated remote access flow in the desktop UI:

1. Open `Remote` from the left navigation.
2. In the `Connect mobile remote` card, scan the QR code or open one of the generated URLs (`IP` or `.local hostname`) from your phone/tablet browser.
3. Keep desktop and mobile devices on the same network.

The remote web surface mirrors live actions from desktop and exposes transport controls, jump controls, and a dedicated mixer view for fast level/mute/solo adjustments during rehearsals and shows.

The remote also exposes the newer live controls: `Vamp`, marker jump settings, song jump settings, and song transition mode. Use it as a compact stage surface when the desktop operator needs to stay focused on the timeline.

Region transpose is also available per song region, and tracks expose a transpose enable toggle so pitch handling can be managed from the timeline without leaving the transport view.

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
