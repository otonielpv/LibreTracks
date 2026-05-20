# Audio Engine v2 Ableton-Style Playback Plan

## Goal

LibreTracks should keep the current live-performance contract: marker jumps,
scheduled jumps, and tested click jumps must remain instant and musically exact.
The playback architecture should move toward Ableton Live's public behavior:
disk streaming by default, selective RAM mode for risky clips/targets, and
prepared state for performance-critical discontinuities.

## Public Ableton Behaviors We Can Rely On

- Live streams samples directly from disk by default so large sets do not hit
  RAM limits.
- RAM Mode is selected per clip when disk streaming is not safe enough.
- Compressed sources are decoded into a cache instead of decoded repeatedly at
  playback time.
- Legato/instant clip switching can drop out if Live jumps to sample data it did
  not preload; Ableton recommends Clip RAM Mode for those clips.
- Clip launch timing is a musical contract. Launch quantization and Follow
  Actions decide when a jump happens; disk readiness should not move that event
  to an arbitrary frame.
- Warp mode is selected by material. A DAW-grade system does not force one pitch
  or time-stretch strategy onto every clip.

Sources:

- https://www.ableton.com/en/manual/managing-files-and-sets/
- https://www.ableton.com/en/manual/computer-audio-resources-and-strategies/
- https://help.ableton.com/hc/en-us/articles/115001041970-Avoiding-Disk-Overload
- https://www.ableton.com/en/manual/launching-clips/
- https://www.ableton.com/en/live-manual/11/audio-clips-tempo-and-warping/

## Product Contracts

### Guaranteed Jumps

These must be prepared before the UI or scheduler treats them as instant:

- marker jumps;
- scheduled marker jumps;
- region-end jumps;
- next-song or next-section transitions;
- click jumps to known musical targets if we have already prearmed them.

For a guaranteed jump, the first audible callback after the jump must have:

- PCM cache ready for every audible clip;
- pitch stream state ready for every transposed audible clip;
- no disk I/O;
- no allocation;
- no lock or wait;
- no pitch stream reset inside the audio callback;
- zero cache misses in the first audible block.

### Opportunistic Jumps

Arbitrary click jumps to non-prearmed positions may be slightly less instant.
They still must not block the audio callback. The control thread may wait or
repair briefly, but if the jump is quantized it must land on the musical frame,
not on the first frame that happens to become technically ready.

### RAM Mode

RAM Mode is not a global escape hatch. It is a per-clip or per-target policy:

- `streaming`: default, bounded RAM block cache;
- `ram_target`: pin enough blocks for the currently armed jump target;
- `ram_clip`: fully pin one clip when it is repeatedly used for instant
  legato-style jumps;
- `ram_song`: reserved for extreme live-show safety, not the default.

## Data Gates Before Motor Changes

Do not change pitch or streaming behavior unless the benchmark identifies the
failure mode. The minimum data set for every playback change is:

- live-readiness set: 3 songs with 12, 12, and 9 stems;
- large-set stress: 6 songs, 12 stems each, 5 minutes;
- real sample jump: `samples/ACUSTICA 1_01.wav`;
- dry vs transposed A/B with the same source;
- near and far prepared marker jumps;
- arbitrary click jump;
- source cache hits/misses;
- pitch voice rebuild/publish generation;
- first-block post-jump silence windows;
- first-block post-jump discontinuity and RMS error against direct render;
- audio RAM, PCM cache RAM, and disk cache bytes.

## Implementation Direction

The unpitched streaming path is currently the baseline: it has passed the user's
3-song live test with instant marker and click jumps. Preserve that behavior.

The next architectural change should be isolated to transposed clips:

1. Add diagnostics that can prove whether crackle comes from PCM cache, pitch
   stream underflow, short post-jump render spans, or stale async voice publish.
2. Replace direct block-by-block Bungee calls with a persistent
   `BungeeRealtimePitchStream`.
3. Give each stream a fixed-size output FIFO and input scratch buffers.
4. Feed Bungee in stable internal quanta; the mixer pulls exactly the requested
   timeline frames from the FIFO.
5. On prepared jumps, publish already-primed stream sets atomically.
6. Keep the current direct streaming renderer for unpitched clips.
7. Add RAM target/clip pinning only where benchmarks show streaming is not
   sufficient.

This mirrors the useful public Ableton behavior and the open Mixxx/RubberBand
shape without switching away from Bungee.

## Current Baseline Command

For the user's current 3-song shape:

```powershell
$env:LT_LIVE_READINESS_STEMS_BY_SONG = "12,12,9"
$env:LT_LIVE_READINESS_SECONDS = "300"
$env:LT_LIVE_READINESS_SIMULTANEOUS = "33"
$env:LT_LIVE_READINESS_BLOCKS = "2400"
.\native\audio-engine-v2\build-bungee-on-ffmpeg\Debug\bench_live_readiness.exe
```

The benchmark should report `prebuffer_ready=yes`, `underrun_free=yes`, exact
jump contracts, and a prepared payload when Bungee is enabled. Any pitch crackle
fix must improve the real-sample jump benchmark without regressing this one.
