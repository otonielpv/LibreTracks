# Audio Engine v2 — Dependency Decisions

## Integration method: CMake FetchContent (default) + find_package fallback

All dependencies are fetched by CMake's `FetchContent` mechanism unless a
compatible system installation is already present (`find_package` is tried
first where applicable).  This means:

- No git submodules are needed for the core build.
- CI and fresh developer machines build without manual setup steps.
- System packages (vcpkg, Homebrew, apt) are transparently preferred when
  present, so packagers can override without touching the CMake files.
- The ASIO SDK (Windows only, proprietary) is the sole exception — it must be
  supplied separately (set `LT_ASIO_SDK_DIR`).

---

## 1. JUCE

| Decision        | Value |
|-----------------|-------|
| Version         | 8.0.4 |
| Integration     | FetchContent (GIT_TAG 8.0.4, GIT_SHALLOW) |
| Modules used    | `juce_core`, `juce_audio_basics`, `juce_audio_devices` |
| ASIO            | Optional — requires Steinberg ASIO SDK (set `LT_ASIO_SDK_DIR`) |
| UI modules      | **Not used** — Tauri/React remains the UI layer |
| License         | GPLv3 / JUCE commercial licence |

**Why JUCE for devices?**
JUCE provides the most mature cross-platform audio device abstraction (WASAPI,
CoreAudio, ALSA/PipeWire, DirectSound, ASIO).  Writing our own WASAPI/
CoreAudio/JACK wrappers would take weeks and be less reliable.

We use only the three audio modules, not the full JUCE application framework,
so JUCE does not affect the UI architecture.

---

## 2. Bungee (pitch shift + warp)

| Decision    | Value |
|-------------|-------|
| Integration | Prebuilt upstream release, `-DLT_BUNGEE_DIR=<path>`; fetched into `vendor/bungee/` by `scripts/fetch-bungee.mjs` (version pinned there and in the CI workflows) |
| License     | MPL-2.0 |

**Why Bungee?**
- Single grain pipeline drives both pitch shift and warp (time-stretch), so one
  voice per clip covers both (see `WARP_BACKEND_NOTES.md`).
- Much lower per-voice CPU than the previous RubberBand path — the only backend
  that sustains 9+ concurrent voices within the audio budget on our target CPU.
- Preferred by ear in engine-level A/B testing on real polyphonic material.

RubberBand was previously kept as a fallback warp backend but has been removed:
nothing in the engine links a separate warp backend any more.

---

## 3. Decoder backend: libsndfile (default) + dr_libs headers

| Decision    | Value |
|-------------|-------|
| libsndfile  | 1.2.2, `find_package` → FetchContent |
| dr_mp3      | bundled single-header in `vendor/dr_libs/` |
| dr_flac     | bundled single-header in `vendor/dr_libs/` |
| License     | libsndfile: LGPL-2.1 |

**Why libsndfile over FFmpeg?**
- libsndfile covers WAV and FLAC — the most common stems in LibreTracks.
- FFmpeg is significantly harder to build cross-platform and from source.
- dr_mp3 / dr_flac fill in MP3 and supplemental FLAC support as single-file
  headers with zero build overhead.
- FFmpeg can be selected instead by setting `-DLT_ENGINE_USE_FFMPEG=ON` and
  providing it via system packages or vcpkg.

**Supported formats with this stack:**
WAV, AIFF, FLAC, OGG/Vorbis (via libsndfile), MP3 (via dr_mp3).
M4A/AAC requires switching to the FFmpeg backend.

---

## 4. Resampler: r8brain-free-src (default)

| Decision    | Value |
|-------------|-------|
| Version     | latest master (stable header-only library) |
| Integration | FetchContent (GIT_SHALLOW) |
| License     | MIT |

**Why r8brain over libsamplerate?**
- Higher quality (sinc interpolation designed for audio mastering quality).
- Header-only + one `.cpp` file — zero additional build friction.
- Lower CPU than libsamplerate at equivalent quality settings.
- libsamplerate is available as an alternative via `-DLT_ENGINE_USE_LIBSAMPLERATE=ON`.

---

## 5. JSON serialization: nlohmann/json

| Decision    | Value |
|-------------|-------|
| Version     | 3.11.3 |
| Integration | FetchContent |
| License     | MIT |

Used only at the C++/Rust FFI boundary (command/event/snapshot strings).
Not used in the audio callback hot path.

---

## 6. Per-track EQ filters: signalsmith-dsp

| Decision    | Value |
|-------------|-------|
| Version     | 1.7.3 (commit ca390d28c41ea5108a528e2e81faa4088f2f8ac8; the header still says 1.7.0) |
| Integration | Bundled headers in `vendor/signalsmith-dsp/include/signalsmith-dsp/` (`filters.h`, `fft.h` and what they include: `common.h`, `perf.h`) |
| License     | MIT (`vendor/signalsmith-dsp/LICENSE.txt`) |

Header-only, no dependencies, no allocation or locking when coefficients
change. `fft.h` is the FFT of the EQ editor's spectrum analyzer
(`render/spectrum_analyzer.cpp`), which runs off the audio thread. The filters
are used only by `render/track_eq.h/.cpp`, the single EQ DSP shared by the
live mixer and the offline renderer. Peak and notch use the `vicanek` design
(matched to the analogue prototype, no cramping near Nyquist), shelves
`oneSided`, cuts `bilinear` Butterworth. Upgrading it changes the curve the UI
draws: regenerate the golden table with `LT_WRITE_EQ_GOLDEN=1` (see
`tests/test_track_eq.cpp`). Not added to the root include path on purpose:
`vendor/nlohmann/` is a placeholder that would shadow the real json header.

---

## Summary table

| Library           | Role                | Integration         | Licence   |
|-------------------|---------------------|---------------------|-----------|
| JUCE 8.0.4        | Audio device I/O    | FetchContent        | GPL3/comm |
| Bungee            | Pitch shift + warp  | prebuilt (LT_BUNGEE_DIR) | MPL-2.0 |
| libsndfile 1.2.2  | WAV/FLAC/OGG decode | find_package + FC   | LGPL-2.1  |
| dr_mp3/dr_flac    | MP3/FLAC decode     | bundled headers     | MIT/0-BSD |
| r8brain           | Resampling          | FetchContent        | MIT       |
| nlohmann/json     | JSON serialization  | FetchContent        | MIT       |
| signalsmith-dsp 1.7.3 | Per-track EQ biquads | bundled headers | MIT       |
