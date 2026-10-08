---
title: System Requirements
description: Minimum and recommended hardware, operating systems, and live-audio setup for running LibreTracks.
---

LibreTracks is a lightweight native app (Rust + Tauri) rather than a heavyweight studio DAW, so it runs comfortably on modest machines. The numbers below are practical guidance, not hard limits — the real bottleneck on stage is real‑time pitch/warp, which scales with how many tracks you shift at once.

## Operating Systems

| Platform | Minimum | Notes |
| --- | --- | --- |
| **Windows** | Windows 10 (64‑bit) | Needs the **WebView2** runtime, which is preinstalled on current Windows 10/11. |
| **macOS** | macOS 12 **Monterey** | Intel and Apple Silicon (universal app). |
| **Linux** | Ubuntu 22.04 / Fedora 36 or newer | Requires `webkit2gtk-4.1`, `gtk3` and ALSA. Provided as `.deb`, `.rpm` and `.AppImage`. |

The AppImage uses the host's WebKitGTK, GTK and Mesa stack, just like the `.deb`
and `.rpm` packages. This avoids mixing current graphics drivers with older
bundled libraries and improves Wayland compatibility on Bazzite, Arch and Fedora.

> **Why macOS 12?** The pitch and warp engine (Bungee) and the way audio is spread across CPU cores need system features that arrived with macOS 11 and 12. On older versions the app does not start.

## iPhone and iPad

LibreTracks is on the **App Store** for iPhone and iPad with **iOS / iPadOS 15
or newer**. It runs in landscape. What changes compared with the computer is
in [On a phone or tablet](/docs/interface/mobile/).

## Android

Android support is newer than the desktop builds, and phones are where the
limits bite first — usually on storage and patience rather than on memory.
For what works differently on a phone (saving sessions to an SD card or USB
drive, touch gestures, audio output), see
[LibreTracks on Mobile](/docs/mobile/).

| | Minimum | Comfortable | Notes |
| --- | --- | --- | --- |
| **Android** | 7.0 (API 24) | 10 or newer | 64-bit ARM (`arm64-v8a`); installed from Google Play |
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
| **Storage** | Room for your audio and the cache | SSD. Besides your audio files (played from wherever they are), each session keeps a cache of waveforms and prepared audio |
| **Display** | 1280×800 | 1440×900 or larger |

Real‑time pitch and warp are the heaviest part of the app. A single shifted track is light; running many shifted tracks simultaneously is what benefits from a faster CPU. On a typical modern quad‑core you can keep nine or more concurrent pitch‑shifted voices within the audio budget.

## Video

To project [video](/docs/tasks/video/) you need a **second screen**
(projector, TV or monitor) connected to the computer; with a single screen
the video can be shown in a window.

- **Windows and macOS**: the video player (libmpv) is built into the app.
- **Linux**: if **Settings → Video** says "Video unavailable", install your
  distribution's mpv library (`libmpv2` on Debian/Ubuntu, `mpv-libs` on
  Fedora).
- Hardware decoding uses the graphics card; a 1080p H.264 video plays fine on
  any current machine.
- On a **phone**, you need wired video out: USB‑C to HDMI (DisplayPort over
  USB‑C on Android) or the Lightning Digital AV adapter.

## Remote and cloud

- The [Remote](/docs/remote-control/) runs in the **browser** of any current
  phone or tablet (Chrome, Safari, Firefox, Edge), with nothing to install.
  The computer and the device have to be on the **same network**.
- The [cloud](/docs/integration-ecosystem/#the-cloud-your-google-drive) needs a
  (free) **Google account** and an internet connection while uploading or
  downloading. The space is that of your Google Drive.

## Live Audio Setup

For rehearsal you can use the built‑in output, but for **stage use a dedicated audio interface is strongly recommended**:

- **Windows** — an **ASIO** driver gives the lowest, most stable latency and exposes every hardware channel (two for a stereo interface, eight for a MOTU, thirty‑two for an X32 over USB).
- **macOS** — **Core Audio** with a class‑compliant or vendor interface.
- **Buffer size** — lower buffers reduce latency but cost CPU. Find the smallest buffer that runs without dropouts on your machine.

Real‑time pitch shifting adds inherent latency (roughly ~108 ms with the shipping engine), so when timing is critical, prefer pre‑warped/pre‑shifted material over live shifting where you can.

See [Audio Routing & Metronome](/docs/audio-routing-metronome/) for how to enable physical outputs and the Apply/Discard channel flow.
