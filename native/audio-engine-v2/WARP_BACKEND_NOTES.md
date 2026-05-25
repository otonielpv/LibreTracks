# Warp Backend Notes

Warp (time-stretch) now runs through the same **Bungee Basic
`Bungee::Stream` voice** as pitch shift when `LT_ENGINE_USE_BUNGEE=ON`.
The renderer has only two live paths: direct source read, or one Bungee voice
fed with both `pitch_scale` and `time_ratio`.

## Why Bungee Again

The first Bungee warp tests were too synthetic and made the quality look worse
than it sounded in real material. Re-running the comparison with
`samples/ACUSTICA 1_01.wav` showed Bungee and RubberBand R2 were close enough
to A/B directly, and Bungee was preferred by ear.

The current bench target is:

```powershell
cmake --build native\audio-engine-v2\build-bungee-on-ffmpeg --config Release --target bench_bungee_warp_backends
native\audio-engine-v2\build-bungee-on-ffmpeg\Release\bench_bungee_warp_backends.exe
```

It writes comparison WAVs under:

```text
bench-out/warp-bungee-samples/ACUSTICA_1_01
```

On the 44.1 kHz sample, ratio `1.213`, 3 voices:

| Backend | CPU avg | CPU p95 | Latency |
|---|---:|---:|---:|
| Bungee hop=-1 | ~340 us | ~375 us | ~114 ms |
| Bungee hop=0 | ~350 us | ~392 us | ~228 ms |
| Bungee hop=1 | ~375 us | ~771 us | ~456 ms |
| RubberBand R2 | ~358 us | ~419 us | ~12 ms |

`hop=-1` was the best standalone Bungee warp test: it had the lowest Bungee
latency and was not audibly worse in the sample A/B.

## Engine Integration

`BungeeVoiceManager` owns one `BungeePitchVoice` per clip that needs pitch,
warp, or both. `TrackRenderer` calls:

```cpp
BungeePitchVoice::render_block(input, input_frames, output, output_frames,
                               pitch_scale, time_ratio)
```

This replaces the old cascade (`BungeePitchVoice` -> `WarpVoiceManager`) and
keeps pitch shift and time stretch inside one grain pipeline. Prepared jumps
also carry a single prepared Bungee voice map; there is no separate prepared
warp map to publish at jump time.

## Build Flags

```cmake
-DLT_ENGINE_USE_BUNGEE=ON
-DLT_BUNGEE_DIR=<unpacked-bungee-release>
```
