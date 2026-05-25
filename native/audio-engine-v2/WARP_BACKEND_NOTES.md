# Warp Backend Notes

Warp (time-stretch) now prefers **Bungee Basic via `Bungee::Stream`** when
`LT_ENGINE_USE_BUNGEE=ON`. RubberBand R2 remains compiled as a fallback when
`LT_ENGINE_USE_RUBBERBAND=ON`, but it is no longer the first choice in Bungee
builds.

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

`hop=-1` is the default for `BungeeWarpVoice`: it has the lowest Bungee latency
and was not audibly worse in the sample A/B.

## Engine Integration

`WarpVoiceManager` chooses backends in this order:

1. `BungeeWarpVoice`, when `LT_ENGINE_HAVE_BUNGEE=1`.
2. `RubberBandWarpVoice`, when Bungee is unavailable and RubberBand is linked.
3. No warp backend.

For quick A/B in the real app, set `LIBRETRACKS_WARP_BACKEND=rubberband` to
force the RubberBand R2 fallback even in a Bungee-enabled build.

`BungeeWarpVoice` uses the same upstream streaming API as `BungeePitchVoice`.
It owns the warp source cursor and locks pitch to `1.0`. Because Bungee has a
larger analysis delay than RubberBand, the renderer applies source-side latency
compensation for backends that request it, so warped and unwarped tracks stay
timeline-aligned.

For clips that are both transposed and warped, the current path is still a
cascade: `BungeePitchVoice` for pitch, then `WarpVoiceManager` for the tempo
stage. In Bungee builds that means Bungee handles both stages, with separate
stream instances. A future simplification can collapse pitch + warp into a
single `BungeePitchVoice::render_block(..., pitch_scale, time_ratio)` path.

## Build Flags

```cmake
-DLT_ENGINE_USE_BUNGEE=ON
-DLT_BUNGEE_DIR=<unpacked-bungee-release>
-DLT_ENGINE_USE_RUBBERBAND=ON   # optional fallback, GPL v2
```

If Bungee is off, the engine falls back to RubberBand R2 when available.
