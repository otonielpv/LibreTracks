# Audio preparation redesign — match Ableton's model

**Branch:** `fix/import-while-playing-glitches`
**Status:** PLAN (not yet started)
**Supersedes the patch attempts in:** HANDOFF_import_while_playing_glitches.md

---

## Why a redesign (stop patching)

After ~12 rounds of patches the import is still slow and stutters. The user
reverse-engineered Ableton and we measured the smoking gun:

| | LibreTracks | Ableton |
|---|---|---|
| Cache file size (same MP3) | **155 MB** | **71 MB** |
| Sample format | float32 (4 B/sample) | **int16 (2 B/sample)** |
| Sample rate | resampled to 48 k | **native 44.1 k (no resample)** |
| Playability | only after WHOLE file decodes | **progressive — decoded chunks play, rest silent** |
| Waveform | second full decode (re-decode) | same single decode |
| Parallelism | 2 decode threads for audio; **waveform on 1 SEQUENTIAL thread** | all files in parallel |
| Frontend | "Analyzing…" then the whole waveform pops in | **waveform paints progressively, tied to decode** |

### Measured / verified in code
- Cache file: `155,136,104 B` vs Ableton `71,278,728 B` → exactly 2× →
  `SF_FORMAT_FLOAT` (source_manager.cpp:681,829) = float32 (4 B) vs int16 (2 B).
- Ableton bytes ÷ (2ch × 2B) ÷ 44100 = 6.7 min = real file length → Ableton keeps
  **native 44.1 k**; we resample to 48 k (`TransportClock(48000)`).
- Source marked playable only at the END: `entry.status = "cache_ready"` at
  source_manager.cpp:1016 (after the whole decode loop).
- Decode pool = **2 threads** (worker_pool.cpp:219); the **waveform worker is a
  SINGLE thread** (state.rs:316) processing files one-by-one AND re-decoding
  (file_peaks) — the visible sequential bottleneck in the user's logs.
- Audio-thread reads float directly from the block cache (block_cache.cpp:81) →
  switching the cache to int16 means converting int16→float in read()/fill.

Our cache is **2× larger** → 2× disk I/O during playback (the stutter), 2× write
time during prep (the slowness), plus a wasted resample (CPU + latency) and a
redundant second decode for the waveform.

Three root problems, all architectural:
1. **float32 cache** instead of int16.
2. **Always resampling** to the engine rate instead of keeping native.
3. **All-or-nothing availability** instead of progressive.
(+ the waveform double-decode, which the same single-pass decode should feed.)

---

## Target architecture (Ableton-like)

### A. int16 PCM cache (half the size + I/O)
- Write the decode cache as **16-bit PCM** (`SF_FORMAT_PCM_16`) instead of
  `SF_FORMAT_FLOAT`. Halves file size, disk write time, and read bandwidth.
- The audio thread reads int16 and converts to float on the fly (a cheap
  multiply by 1/32768 in BlockCache::read / the block fill). This is what every
  DAW does; float in the cache is wasteful.
- Risk: int16 loses precision vs float32 source. Acceptable for playback (Ableton
  does it); keep a `LIBRETRACKS_CACHE_FLOAT=1` escape hatch if a user needs it.

### B. Keep native sample rate (no resample on import)
- Store the cache at the FILE's sample rate, not the engine's. Don't resample
  during prep at all.
- Resample at PLAY time per block in the renderer (or run the mixer at the file
  SR for single-rate sessions). The varispeed/Bungee path already resamples per
  block for pitch/warp, so a SR ratio is a natural extension.
- Removes: the import-time resample CPU, the resampler latency/alignment bugs we
  fought, and shrinks the cache further when files are 44.1 k.
- Risk: mixing files of different SRs needs per-source ratio at play time.
  Decide: (a) resample-at-play per source, or (b) resample only when SR differs
  from the device. Measure first.

### C. Progressive availability (decoded chunks play immediately)
- Today `decode_and_store_streaming` sets status `cache_ready` only at the END.
  Instead: **register the source as playable up front** and let the block cache
  fill progressively. The mixer's StreamingSource already returns silence for
  not-yet-filled blocks (`!hit` path), so partial playback already works — we
  just need to publish early and have the play gate not wait for the whole file.
- Each decoded chunk → write to cache + fill its blocks + (optionally) emit a
  "source progress" event so the UI paints the waveform up to that point, in
  lockstep with audio availability (exactly what the user saw in Ableton).
- The `wait_playback_audio_window_ready` gate should only wait for the playhead
  window's blocks, not the whole file (it mostly does — verify).

### D. Single-pass waveform (fix the still-broken wiring)
- Peaks are already computed in the streaming pass (Phase 4). The wiring to use
  them is broken by a PATH MISMATCH (`//?/C:/…` vs normalized) — source_is_known
  / source_peaks never match, so the waveform worker re-decodes every file.
- With the progressive model, emit peaks progressively too (per chunk) and write
  the global waveform cache from the engine peaks keyed correctly. No second
  decode, ever.

### E. Real parallelism (all files at once, like Ableton)
- Decode pool is 2 threads; Ableton decodes all dropped files concurrently.
  Raise the decode worker count toward hardware_concurrency (bounded), so N
  dropped files prepare in parallel, not in ceil(N/2) waves.
- Kill the SEPARATE single-threaded waveform worker entirely — once D removes the
  re-decode, the waveform comes from the same decode pass, so there's no second
  job to serialize.

### F. Progressive frontend (waveform paints as it decodes)
- Replace the "Analyzing…" placeholder → full-waveform-pop with progressive
  paint: as each source emits per-chunk peaks + availability, the UI fills the
  waveform up to the decoded point. The user sees exactly which part of each
  audio is ready (and audible) and which isn't — Ableton's behaviour, and it
  makes the progressive audio (C) legible instead of feeling like a bug.
- Needs: a per-source progress signal (frames decoded so far) emitted from the
  engine, consumed by the frontend to draw the partial waveform + a "preparing"
  region for the rest.

---

## Phased plan (ONE at a time, each shippable + measurable)

Order chosen so each phase is independently verifiable and de-risks the next.

### Phase R1 — int16 WAV cache  ✅ DONE + VERIFIED
- Cache now written as **WAV + 16-bit PCM** (was RF64 + float32), via
  `cache_sample_format()` / `cache_container_format()` helpers; RF64 only kicks
  in for payloads ≥ ~3.9 GB (WAV's 4 GB limit). `LIBRETRACKS_CACHE_FLOAT=1`
  keeps float32 for debug/AB.
- `cache_file_for`: key includes the format, extension is `.wav` (was `.rf64`),
  so switching format regenerates instead of reusing a mismatch.
- Cache cleanup/size/purge now match both `.wav` and legacy `.rf64`.
- libsndfile converts int16↔float transparently, so read/write code is unchanged
  (`sf_readf_float`/`sf_writef_float`); the RAM block cache stays float for now
  (a later optimization can make it int16 too).
- **Verified against Ableton** (user's MP3s, fresh cache):
  | | LibreTracks (R1) | Ableton |
  |---|---|---|
  | Container/format | WAV / PCM int16 | WAV / PCM int16 |
  | Channels | 2 | 2 |
  | Bits | 16 | 16 |
  | Sample rate | 48000 | 44100 |
  | File size | **74 MB** (was 155 MB) | 68 MB |
  Identical format now; the remaining 74 vs 68 MB is purely the 48k vs 44.1k
  resample (74/68 = 1.088 = 48000/44100) — removed by R4.
- 218 DSP tests pass (equivalence tolerance retuned to the int16 step 1/32768).

### Phase R2 — single-pass waveform, correct keying  ✅ DONE (needs user test)
- Root cause of the persistent re-decode: there are THREE enqueue sites and the
  drag-drop import uses `load_library_waveforms` (state.rs:1549) which I hadn't
  guarded; per-site guards were fragile.
- Fix at the SINGLE chokepoint: the waveform worker now holds the engine handle
  (`WaveformGenerationQueue.audio`, injected in `DesktopState::default`). In
  `process_waveform_job`, before the expensive `file_peaks` re-decode:
  1. disk cache → 2. **engine same-pass peaks** (`waveform_from_engine_peaks` →
  `source_peaks`, no decode, writes the global cache) → 3. if the engine HAS the
  source but peaks aren't ready, **bail (no re-decode)** so a later frontend
  retry hits → 4. only re-decode (file_peaks) for sources the engine doesn't
  have (library files not in the session) → 5. symphonia last resort.
- Path normalization (R-prev) keeps the source-id comparison correct.
- **Measure:** console should show NO `RE-DECODE` for in-session imports.
- Note: a temp `[LT_DIAG] source_is_known=false …` log prints the exact id
  strings if it still misses — removed in R6.

### Phase R3 — real parallelism  ⏳
- Raise decode pool toward hardware_concurrency (bounded, e.g. min(cores, 8)) so
  all dropped files prepare at once instead of in waves of 2.
- **Measure:** N files prepare in ~max(file_time) not ~ceil(N/2)×file_time.

### Phase R4 — native sample rate (no import resample)  ⏳
- Stop resampling on import; store native SR. Resample at PLAY only when source
  SR ≠ device SR (extend the varispeed path).
- **Measure:** cache shrinks more for 44.1 k files; import CPU drops; the
  resampler-latency bugs disappear.

### Phase R5 — progressive availability + progressive frontend  ⏳
- Engine: publish the source as playable before decode finishes; fill blocks as
  they land; play gate waits only for the playhead window; emit per-source
  "frames decoded" progress.
- Frontend: paint the waveform progressively up to the decoded point + show a
  "preparing" region for the rest (replaces the "Analyzing…" → pop). User sees
  which part of each audio is ready (and audible).
- **Measure:** time-to-first-audio ~instant; waveform tracks audio availability;
  no stutter (missing blocks play silence, like Ableton).

### Phase R6 — cleanup  ⏳
- Remove symptom patches (DecodeMemoryGate, working-set floor, MMCSS) + the
  LT_AUDIO_DIAG / LT_DIAG instrumentation. Consolidate commits; release notes.

---

## Open decisions to resolve before/at each phase
- R1: int16 vs int24? Ableton uses 16-bit per the measured size; 16-bit is fine.
- R2: resample-at-play vs run-mixer-at-file-SR. Needs a measurement on a
  mixed-SR session. Default: keep native, resample at play only when the source
  SR ≠ device SR.
- R3: how to publish "playable but incomplete" without the audio thread reading a
  block mid-write (the block cache fill is already atomic per block — verify).

## Verification harness
- `bench_import_while_playing` already measures peak WS / page faults / render
  time. Add: cache file size assertion, time-to-first-playable, and a re-decode
  counter (must stay at the import count, not 2×).
- 218 C++ DSP tests; the streaming equivalence test (retune tolerance for int16).
