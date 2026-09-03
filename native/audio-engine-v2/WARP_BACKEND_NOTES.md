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

> **Histórico (2026, fecha exacta no registrada).** El target
> `bench_bungee_warp_backends` que produjo la tabla de abajo **ya no existe en
> el árbol**, así que estas cifras no son reproducibles tal cual. Se conservan
> porque documentan la decisión de backend, no como línea base.
>
> Los bancos vivos son:
>
> ```powershell
> cmake -S native/audio-engine-v2 -B native/audio-engine-v2/build-bench `
>       -DLT_ENGINE_USE_BUNGEE=ON -DLT_BUNGEE_DIR=<release> -DLT_ENGINE_BUILD_BENCHES=ON
> cmake --build native/audio-engine-v2/build-bench --config Release
> ```
>
> | Target | Qué mide |
> | --- | --- |
> | `bench_bungee_voice_cost` | coste de N voces Bungee por bloque |
> | `bench_bungee_thread_scaling` | speedup al repartir esas voces entre hilos |
> | `bench_render_callback` | `Mixer::render` entera, con desglose por fases |
>
> La línea base medida está en
> `docs/plans/audio-thread-parallelism/baseline.md`.

Cifras históricas: 44,1 kHz, ratio `1.213`, 3 voces:

| Backend | CPU avg | CPU p95 | Latency |
|---|---:|---:|---:|
| Bungee hop=-1 | ~340 us | ~375 us | ~114 ms |
| Bungee hop=0 | ~350 us | ~392 us | ~228 ms |
| Bungee hop=1 | ~375 us | ~771 us | ~456 ms |
| RubberBand R2 | ~358 us | ~419 us | ~12 ms |

`hop=-1` was the best standalone Bungee warp test: it had the lowest Bungee
latency and was not audibly worse in the sample A/B.

### Latency by hop, measured directly against the library

Bungee 2.4.24 Basic, 44.1 kHz, measured with a standalone harness linked
straight against `bungee.lib` rather than through the engine:

| hop | latency | | stabilises after |
|---|---:|---:|---:|
| `0`  | 9728 frames | 220.6 ms | ~2048 input frames |
| `-1` | 4864 frames | 110.3 ms | ~2048 input frames |

Exactly a factor of two. That latency is the floor on how quickly a jump can
speak, how much material a seek must prefeed, and how long the engine stays in
an inconsistent state after a warp toggle.

`BungeePitchVoice` shipped with `hop=0` for a period after the warp and pitch
voices were merged into it — the argument was lost in the merge and the
doubled latency went unnoticed because nothing tested it. `Warp[0]: the voice
runs at the low-latency hop setting` now pins it.

Related: `is_warm()` used to compare latency against `max_input_frames`
(one block x 4). Since latency rests far above that at either hop, the
predicate was false for every voice that ever existed, and the warm loops that
consult it always ran to their frame budget instead of stopping on time. It now
tests for latency *convergence*, which is what those callers want and which
holds at any hop.

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

## How position works (and why there is no cursor)

The renderer derives the source read position from the timeline on every block:

```
required_fed_through = clip.source_start
                     + round((timeline_offset + block) * ratio)
                     + feed_lead
feed                 = required_fed_through - voice.fed_through()
```

`fed_through` is a contiguity pointer, not a position estimate: it says where
the last feed stopped so the next one abuts it. `feed_lead` is the constant
head start Bungee needs over its own output, captured once when the voice is
anchored.

Two things follow, and both were bugs before:

- **Nothing accumulates.** The warp path used to integrate a cursor, which
  turned a fraction of a frame of per-block rounding into a track running ahead
  of the click by the last chorus. `warp_timing_tests.cpp` measures the
  delivered ratio against the requested one and holds it under 0.01%.
- **The live `latency()` never reaches a read address.** Its resting value
  moves with the ratio — measured at 255 frames between 1.0 and 0.8333 — and
  folding a moving number into a read address tore the source feed at exactly
  the moment the user toggled warp.

### The anchor is read out of Bungee, not predicted

After the prefeed, `Stream::outputPosition()` gives the input-frame position of
the next sample the voice will emit. Every frame fed was one source frame read
contiguously, so that converts to a source frame directly. Predicting it
instead — from a latency sampled before the prefeed — is what
`alignment_compensation_frames()` existed to paper over.

That function is gone. It returned `sample_rate * 0.032 * (1/pitch - 1)`, a
hand-tuned constant with no derivation, and measurement showed it *was* the
error rather than the correction: with the anchor derived and the pitch
consistent, a click lands within 5 frames of its unpitched position across the
whole ±7 semitone range, and adding the constant back displaces it by exactly
the constant.

Warm the voice at the pitch it will run at. Warming at 1.0 and switching later
displaces the pipeline by -383 frames at -7 semitones and +255 at +7.
