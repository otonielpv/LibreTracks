---
title: System Requirements
description: Minimum and recommended hardware, operating systems, and live-audio setup for running LibreTracks.
---

LibreTracks is a lightweight native app (Rust + Tauri) rather than a heavyweight studio DAW, so it runs comfortably on modest machines. The numbers below are practical guidance, not hard limits — the real bottleneck on stage is real‑time pitch/warp, which scales with how many tracks you shift at once.

## Operating Systems

| Platform | Minimum | Notes |
| --- | --- | --- |
| **Windows** | Windows 10 (64‑bit) | Needs the **WebView2** runtime, which is preinstalled on current Windows 10/11. |
| **macOS** | macOS 10.15 **Catalina** | Intel and Apple Silicon. On Catalina, keep **Safari updated to 15.6.1** — the in‑app UI uses the system WebView, and older Safari builds render parts of the interface incorrectly. |
| **Linux** | Ubuntu 22.04 / Fedora 36 or newer | Requires `webkit2gtk-4.1`, `gtk3` and ALSA. Provided as `.deb`, `.rpm` and `.AppImage`. |

> **Why macOS 10.15+?** The desktop UI runs inside the operating system's WebView. macOS releases before Catalina ship a WebKit too old to render modern CSS, which leaves the interface black or misaligned. Catalina is the oldest version that can run a recent enough Safari/WebView.

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
