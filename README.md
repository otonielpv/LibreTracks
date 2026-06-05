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
- On macOS, install the build tools via [Homebrew](https://brew.sh). CoreAudio ships with the OS, so no extra audio packages are needed:
  ```bash
  brew install cmake pkg-config ffmpeg
  ```
  Xcode Command Line Tools (`xcode-select --install`) provide the Apple Clang compiler. FFmpeg is enabled by default on macOS (it adds M4A/AAC import); see the macOS note below if you prefer to skip it.
- Microsoft Visual C++ Build Tools on Windows
- Windows 10/11 SDK on Windows for MSVC linking
- LLVM/Clang with `libclang.dll` on Windows for bindgen-based crates

For Windows native desktop runs, `scripts/desktop-native.ps1` checks for the MSVC linker and SDK libraries. In practice, install Visual Studio Build Tools with the `Desktop development with C++` workload before running the native Tauri target. The root `npm run *:desktop:native` scripts now route to that Windows helper automatically and run directly on Linux/macOS.

If `cargo check` later reports that bindgen cannot find `libclang`, install LLVM and set `LIBCLANG_PATH` to the directory that contains `libclang.dll` (for example `C:\Program Files\LLVM\bin`). If `winget install -e --id LLVM.LLVM` does not complete on your machine, install LLVM manually from the official installer or use another package manager such as Chocolatey.

### Bungee pitch backend (SDK download)

[Bungee](https://github.com/bungee-audio-stretch/bungee) (MPL-2.0) is the pitch/warp backend used for tempo and key changes. It is **not vendored in the repo** — you download the prebuilt SDK once and unpack it into `vendor/bungee/`. The native launcher requests it by default (`LIBRETRACKS_ENGINE_V2_BUNGEE=1`), and on macOS the Tauri bundle references `bungee.framework` explicitly, so **a fresh clone will not build on macOS until the SDK is in place**.

Download release `v2.4.24` and unpack it so that `vendor/bungee/include/bungee/Bungee.h` and your platform's binary folder exist:

```bash
mkdir -p vendor/bungee
curl -fSL -o /tmp/bungee.tgz \
  https://github.com/bungee-audio-stretch/bungee/releases/download/v2.4.24/bungee-v2.4.24.tgz
tar -xzf /tmp/bungee.tgz -C vendor/bungee
```

The archive ships every platform (`apple-mac/bungee.framework`, `linux-x86_64/libbungee.so`, `linux-aarch64/libbungee.so`, `windows-x86_64/bungee.dll`, etc.); the launcher picks the right one. The macOS framework is a universal binary (x86_64 + arm64). Alternatively, point `LT_BUNGEE_DIR` at an SDK unpacked elsewhere, or place it in `~/Downloads/bungee-v2.4.24`.

To build **without** Bungee (pitch/warp voices compile to no-op stubs), set `LIBRETRACKS_ENGINE_V2_BUNGEE=0`. Note that on macOS you must also remove the `bungee.framework` entry from `apps/desktop/src-tauri/tauri.conf.json` (`bundle.macOS.frameworks`), since it is referenced unconditionally there.

### macOS architecture note (Intel vs Apple Silicon)

The native launcher builds the C++ engine as a universal binary (`x86_64;arm64`) by default. On an **Intel-only Mac**, the `arm64` slice fails to link because Homebrew installs FFmpeg only for your native architecture (`x86_64`), producing errors like:

```
ld: warning: ignoring file '.../ffmpeg/.../libavformat.dylib': found architecture 'x86_64', required architecture 'arm64'
ld: symbol(s) not found for architecture arm64
```

Force a single-architecture build that matches your machine by setting `CMAKE_OSX_ARCHITECTURES` before running the native target:

```bash
# Intel Macs
CMAKE_OSX_ARCHITECTURES=x86_64 npm run dev:desktop:native

# Apple Silicon Macs
CMAKE_OSX_ARCHITECTURES=arm64 npm run dev:desktop:native
```

To make it permanent, add the matching line to your shell profile (e.g. `~/.zshrc`):

```bash
echo 'export CMAKE_OSX_ARCHITECTURES=x86_64' >> ~/.zshrc   # use arm64 on Apple Silicon
```

If you changed the architecture after a failed build, delete the stale build directory first so CMake reconfigures cleanly:

```bash
rm -rf native/audio-engine-v2/build-bungee-on-ffmpeg
```

Alternatively, skip FFmpeg entirely (drops M4A/AAC import; keeps WAV/FLAC/MP3/OGG via libsndfile + dr_libs) — this also removes the `pkg-config`/`ffmpeg` requirement:

```bash
LIBRETRACKS_ENGINE_V2_FFMPEG=0 npm run dev:desktop:native
```

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
