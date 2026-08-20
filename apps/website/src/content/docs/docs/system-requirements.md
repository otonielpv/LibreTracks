---
title: System Requirements
description: Minimum and recommended hardware, operating systems, and live-audio setup for running LibreTracks.
---

LibreTracks is a lightweight native app (Rust + Tauri) rather than a heavyweight studio DAW, so it runs comfortably on modest machines. The numbers below are practical guidance, not hard limits — the real bottleneck on stage is real‑time pitch/warp, which scales with how many tracks you shift at once.

## Operating Systems

| Platform | Minimum | Notes |
| --- | --- | --- |
| **Windows** | Windows 10 (64‑bit) | Needs the **WebView2** runtime, which is preinstalled on current Windows 10/11. |
| **macOS** | macOS 10.15 **Catalina** | Intel and Apple Silicon. Keep the system up to date — the in‑app UI uses the system WebView, and an old WebKit can render parts of the interface incorrectly. |
| **Linux** | Ubuntu 22.04 / Fedora 36 or newer | Requires `webkit2gtk-4.1`, `gtk3` and ALSA. Provided as `.deb`, `.rpm` and `.AppImage`. |

> **Why macOS 10.15+?** The desktop UI runs inside the operating system's WebView. LibreTracks ships CSS down‑levelled for the WebKit in Catalina's Safari 13, and the audio engine bundles its own FFmpeg/codec libraries inside the app, so it launches without any system‑wide dependencies. Older macOS releases ship a WebKit too old to render the interface and miss symbols the app needs at launch.

## Android

Android support is newer than the desktop builds, and phones are where the
limits bite first — usually on storage and patience rather than on memory.

| | Minimum | Comfortable | Notes |
| --- | --- | --- | --- |
| **Android** | 8.0 (API 26) | 10 or newer | 64-bit ARM (`arm64-v8a`) |
| **RAM** | 2 GB | 3 GB+ | LibreTracks sizes its buffers to the device |
| **Free storage** | 2x your session size | 3x | Importing unpacks the session and prepares its audio |

Playback streams from storage rather than loading songs into memory, so track
count is limited far more by how fast the phone reads and decodes than by how
much RAM it has. A 2.5 GB phone runs a 36-track session; what it cannot do is
import one quickly.

### Space during import

Importing a `.ltset` needs room for more than the file itself: the package is
unpacked, and its audio is prepared for playback. Budget roughly **twice the
package size**, and leave a gigabyte spare. A 2 GB set wants around 5 GB free.

LibreTracks refuses an import that clearly will not fit rather than filling the
device and failing halfway through.

### Making a big session load faster

Importing a large set on a modest phone takes minutes, and that is storage
speed, not a bug. To cut it down, export from the desktop in a lighter form:

- **Optimized** export ships audio already prepared for playback, so the phone
  skips decoding entirely — the session opens without a preparation step and
  writes nothing to the audio cache. The package is larger to transfer, and it
  does not change how many tracks play at once; it changes how long you wait.
- **Light** export leaves the audio behind altogether, for when the files are
  already on the device.
- **Splitting a set into shorter songs** keeps each import small, which is the
  most reliable option on an older phone.

## Audio Formats

The audio engine bundles FFmpeg on **all three platforms**, so the same formats load everywhere — WAV, AIFF, FLAC, MP3, and AAC/M4A among them. There is no separate codec install: on macOS the codec libraries travel inside the `.app`, and on Windows and Linux they ship alongside the app.

## Hardware

| | Minimum | Recommended |
| --- | --- | --- |
| **CPU** | Modern 64‑bit dual‑core | Quad‑core or better — needed for several pitch/warp tracks at once |
| **RAM** | 4 GB | 8 GB+ |
| **Storage** | SSD with room for your sessions and audio | SSD; sessions keep audio + peak caches alongside the project |
| **Display** | 1280×800 | 1440×900 or larger |

Real‑time pitch and warp are the heaviest part of the app. A single shifted track is light; running many shifted tracks simultaneously is what benefits from a faster CPU. On a typical modern quad‑core you can keep nine or more concurrent pitch‑shifted voices within the audio budget.

## Live Audio Setup

For rehearsal you can use the built‑in output, but for **stage use a dedicated audio interface is strongly recommended**:

- **Windows** — an **ASIO** driver gives the lowest, most stable latency and exposes every hardware channel (two for a stereo interface, eight for a MOTU, thirty‑two for an X32 over USB).
- **macOS** — **Core Audio** with a class‑compliant or vendor interface.
- **Buffer size** — lower buffers reduce latency but cost CPU. Find the smallest buffer that runs without dropouts on your machine.

Real‑time pitch shifting adds inherent latency (roughly ~108 ms with the shipping engine), so when timing is critical, prefer pre‑warped/pre‑shifted material over live shifting where you can.

See [Audio Routing & Metronome](/docs/audio-routing-metronome/) for how to enable physical outputs and the Apply/Discard channel flow.
