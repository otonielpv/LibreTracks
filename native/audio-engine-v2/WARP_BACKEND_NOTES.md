# Warp backend notes

Warp (time-stretch) ships on **RubberBand R3 ("Finer")**. Bungee continues
to handle pitch shift; the two paths are independent.

## Why RubberBand and not the alternatives

The offline benchmark (`bench/warp-backends-2026`) measured Bungee Basic,
RubberBand R2, RubberBand R3, and Signalsmith Stretch processing a 20s
stereo WAV at ratios 0.85–1.5. Its conclusions were:

| Backend | CPU/cb | Latency | RMS | Verdict (offline) |
|---|---:|---:|---:|---|
| Bungee Basic (hop=0) | 111 µs | ~180 ms | 1.00 | metallic past ~1.05 |
| Bungee Basic (hop=-1) | 110 µs | ~95 ms | 0.99 | same metallic, lower latency |
| RubberBand R2 | ~135 µs | ~4 ms | ~0.78 | level drop ~25 %, unusable |
| **RubberBand R3** | ~547 µs | ~28 ms | 0.97 | best quality |
| Signalsmith Stretch | ~122 µs | ~85 ms | 0.99 | initially looked viable |

Signalsmith was the offline recommendation (MIT-licensed, low CPU). Engine
A/B testing with the same material proved otherwise: Signalsmith produces
audible periodic clicks at the ratios users actually edit (1.05–1.20) when
two or more polyphonic stems are mixed. The offline `worst_step < 0.4`
metric did not catch them. RubberBand R3 stayed clean under the same
conditions and is therefore the backend we ship.

The takeaway for future backend evaluations: an offline single-stream WAV
comparison is not enough — wire the candidate into the actual engine and
listen with two or more real stems active before deciding.

## Configuration

```cmake
-DLT_ENGINE_USE_RUBBERBAND=ON   # default
```

RubberBand comes from vcpkg via `native/audio-engine-v2/vcpkg.json`.

Turning it OFF compiles the engine without a warp backend; the warp UI
remains visible but no audio time-stretches (the renderer silences the
warp clips and bumps `warp_missing_stream_silence_count`). This mode is
only useful for a permissive build that explicitly cannot ship GPL code.

## CPU / latency in the engine

At 480-frame callbacks, RubberBand R3 measures ~547 µs per voice on the
hardware used for the bench. With two warped voices this lands at ~10 % of
the 10 ms audio budget — comfortable. For sessions with 8+ simultaneously
warped voices the CPU bill grows linearly; if that becomes the actual use
case, revisit either using fewer warped tracks (toggle warp per region) or
re-running the bench to see if a newer Signalsmith preset has improved.

## Source-cursor model

`WarpVoice` owns its own source cursor. The renderer reads it back every
block instead of recomputing `source_frame = timeline_offset * ratio`,
which under a fractional warp ratio produces ±1-frame drift that the
stretcher hears as a click. Bench results are reproducible only because
the offline test code feeds Bungee a contiguous stream — the engine has
to feed RubberBand the same shape, and the cursor-on-the-voice design is
what guarantees that.
