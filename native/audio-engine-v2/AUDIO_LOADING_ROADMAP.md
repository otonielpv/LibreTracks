# Audio loading roadmap

Two improvements to the audio loading pipeline that are NOT shipped yet but
have been agreed on. Listed in priority order. Each section is meant to be
self-contained enough to pick up cold.

Status as of `dae0e60` (2026-05-18):

- ✅ Pre-load sessions into engine on clip add (`dae0e60`) — covers the
  "first play is slow because nothing is decoded yet" problem.
- ✅ Native waveform generation from already-loaded engine sources (`worktree`, 2026-05-18).
- ⏳ libav-based decoder (this doc, section 2).

---

## 1. Native (C++) waveform generation

### Why

Today the frontend decodes audio files a second time via Web Audio API to
generate the waveform peaks shown on the timeline. The C++ engine also
decodes the same files (now eagerly via the pre-load fix). That's two full
decode passes per source — wasted CPU, wasted RAM, and on MP3 it's
particularly slow because dr_mp3 isn't fast.

DAWs like Ableton do this in one pass: decode the source, write samples
to disk in a flat format (`.asd`), and compute peaks (`.asdpeaks`) at the
same time. The frontend just loads the peaks file.

### Scope

- **C++**: `DecodedSource::peaks()` returns a downsampled overview of the
  audio. Format: `[(min, max)]` per pixel, optionally per channel.
- **FFI**: new command `GetSourcePeaks { source_id, resolution }` returns
  bytes. Or push as an event when decode completes.
- **Rust (Tauri)**: command wrapper.
- **Frontend**: replace the Web Audio API path with a Tauri invoke that
  asks the engine for peaks. Cache result keyed by `(file_path, mtime)`.

### Decisions to make before implementing

- **Format**: pixel-per-sample (variable) vs fixed buckets (e.g. 256
  samples/peak). Ableton uses ~256 samples/peak which gives a 174 KB peak
  file for a 3-minute stereo 44.1k track — manageable.
- **Storage**: in-memory only, or persist to disk like Ableton's `.asd`?
  Disk cache means startup of already-imported projects is instant.
  Suggest: persist next to the audio file as `<file>.peaks` in a small
  binary format.
- **Multi-resolution**: store one resolution and downsample for zoom
  levels, or pre-compute multiple resolutions? Single resolution +
  client-side downsampling is simpler; the timeline already has zoom
  logic so this is probably fine.
- **Stereo vs mono**: stereo peaks double the storage but allow showing
  L/R separately. Most DAWs collapse to mono for the timeline (cheaper
  and the user rarely needs per-channel peaks at overview zoom).

### Effort estimate

3–4 hours of focused work:
- 1h: peaks computation in `DecodedSource` (just a downsample loop after
  decode).
- 1h: FFI command + Rust wrapper.
- 1h: frontend refactor — find the Web Audio API code, replace with
  invoke call, handle async loading.
- 30min: disk cache (optional, can ship in a follow-up).
- 30min: testing across formats.

### Risks

- The frontend's waveform code might have non-trivial caching/rendering
  assumptions tied to Web Audio. Audit it before estimating.
- File mtime is unreliable on Windows for cache invalidation; consider
  hashing file size + first/last 64KB instead.

### Files that'll change

- `native/audio-engine-v2/src/sources/decoded_source.cpp` (add peaks()).
- `native/audio-engine-v2/src/sources/decoded_source.h` (header).
- `native/audio-engine-v2/src/ffi/lt_engine_ffi.cpp` + matching header
  (new FFI entry point).
- `crates/lt-audio-engine-v2/src/lib.rs` (Rust binding).
- `apps/desktop/src-tauri/src/commands/library.rs` or similar (new Tauri
  command).
- Find waveform-generation code in `apps/desktop/src/features/transport/`
  (search for `decodeAudioData`, `AudioContext`, `getChannelData`,
  `getPeaks`) and replace.

---

## 2. libav-based decoder (replace dr_mp3 + add wide format support)

### Why

Current state:

- **WAV / FLAC**: libsndfile (fast, seek-friendly, memory-mappable).
- **MP3**: dr_mp3 (single-header, decodes the whole file to memory in
  one pass — slow for long files).
- **Everything else** (M4A, AAC, OGG Vorbis, Opus, etc.): not supported.
- **ffmpeg CLI**: there's a code path for shelling out to `ffmpeg.exe`
  (`audio_decoder.cpp:267 decode_with_ffmpeg_cli`), but it's disabled
  (`LT_ENGINE_USE_FFMPEG=OFF`) and shelling out has process-spawn
  overhead and requires the user to have ffmpeg installed.

Ableton/Bitwig/Reaper all link libav directly. Replacing dr_mp3 with libav
gives:

- 2-3x faster MP3 decode (libavcodec MP3 is heavily SIMD-optimized).
- Support for M4A / AAC / OGG / Opus / WMA / virtually anything.
- Streaming-friendly API (decode-on-seek for huge files later).

### Scope

- Add libav libraries to vcpkg manifest (`libavcodec`, `libavformat`,
  `libavutil`, `libswresample`).
- New `LibavDecoder` class in `native/audio-engine-v2/src/sources/` that
  implements the same `AudioDecoder` interface as the existing dr_mp3
  / libsndfile decoders.
- Route MP3/M4A/OGG/etc to LibavDecoder in `audio_decoder.cpp` factory.
- Keep libsndfile for WAV/FLAC (it's already fast and avoids loading
  libav for the common case if we want a "lite" build flag).
- Bundle the libav DLLs in the Tauri installer (Windows: tauri.conf.json
  externalBin or sidecar pattern).

### Decisions to make before implementing

- **License**: libav has LGPL components (always OK) and GPL components
  (only if compiled with `--enable-gpl`, includes x264 etc.). For audio
  decode we don't need any GPL pieces — LGPL is fine, but the build must
  explicitly NOT enable GPL. Document this in CMakeLists.
- **Distribution**: ship our own libav DLLs (large: ~10-20 MB added to
  the bundle) or require system ffmpeg (smaller bundle but bad UX on
  Windows where users don't have ffmpeg). Suggest: ship our own,
  consistent UX wins over bundle size.
- **vcpkg vs prebuilt**: vcpkg's libav builds are reproducible but slow
  to build first time (~30 min). Prebuilt binaries from BtbN's GitHub
  releases are faster but pinned to specific configs. Suggest: vcpkg
  for consistency with the rest of the deps.
- **Decode-to-memory vs streaming**: short-term, mirror the existing
  decoder interface (decode the whole file to memory). Streaming
  (decode-on-seek for huge files) is a separate later improvement.

### Effort estimate

1-2 days of focused work, depending on how vcpkg/Windows behaves:

- 4h: vcpkg + CMake integration (this is the hard part on Windows;
  libavutil needs special handling for the C99 inline issue, and the
  link order matters: libavformat → libavcodec → libavutil →
  libswresample → m, dl, pthread on Linux; Windows needs ws2_32, etc.).
- 3h: LibavDecoder implementation (open file, find audio stream, decode
  packets, convert via libswresample to float planar, write into the
  same buffer shape decoded_source expects).
- 2h: factory routing + format detection (libav's `avformat_open_input`
  handles format sniffing natively; just check the input MIME or
  extension).
- 2h: bundling DLLs in tauri.conf.json + testing the produced bundle
  actually loads them.
- 3h: testing matrix across formats (mp3 various bitrates, m4a, ogg,
  opus, etc.) and verifying no regression on WAV/FLAC.

### Risks

- vcpkg + libav on Windows is notoriously fragile. Be ready to fall back
  to prebuilt binaries if vcpkg burns more than a day.
- License compliance: NEVER ship libav binaries compiled with
  `--enable-gpl` or `--enable-nonfree`. Verify with `ffmpeg -version`
  that the output says "libavcodec ... LGPL".
- Code signing on Windows: bundled DLLs need to either be signed by us
  or excluded from the signature manifest. Test the installer end-to-end.

### Files that'll change

- `vcpkg.json` (manifest).
- `native/audio-engine-v2/CMakeLists.txt` (find_package + link).
- `native/audio-engine-v2/src/sources/audio_decoder.cpp` (factory + new
  branch for libav-decoded formats).
- New file: `native/audio-engine-v2/src/sources/libav_decoder.cpp`.
- `apps/desktop/src-tauri/tauri.conf.json` (sidecar DLLs for Windows
  installer).
- Delete: the existing ffmpeg-CLI code path in `audio_decoder.cpp`
  (lines 182, 238-296) — superseded by linking libav directly.

### Order matters

Do **Section 1 (waveform native) BEFORE Section 2 (libav)**. Waveform
work touches the decode pipeline; if you swap the decoder first, you'll
have to redo the waveform integration on the new decoder.

---

## What NOT to do (for the record)

- **Streaming decode** (decode-on-seek): rejected for now. For typical
  song lengths (5-10 min × 7 tracks at 44.1k stereo float = ~1 GB worst
  case in RAM) decode-to-memory is fine. Streaming is the right answer
  for >100 MB files but adds significant complexity (thread-safe decoder,
  block cache, predictive prefetch). Revisit if users start importing
  film-length audio.

- **Wasm-based decoders in the frontend**: ruled out — duplicates the
  C++ decoder which we already trust.

- **Per-clip async LoadSession**: rejected. The session is the unit of
  decode dispatch in the C++ engine; trying to LoadSession one clip at
  a time would mean N round trips and N session rebuilds. Single
  LoadSession with all clips lets the engine batch-decode in its worker
  pool, which is what we want.
