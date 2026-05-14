# Audio Engine v2 Realtime Pitch Architecture

`RealtimePitchStream` is the only official default pitched playback path. Prepared proxy, offline segment, persistent proxy, `RubberBandPitchProcessor`, and `SeekSafePitchStream` code is retained only as legacy or experimental support and must not be selected by the normal TrackRenderer/Mixer path.

## Rules

1. A pitch stream is persistent and stateful across audio callback blocks.
2. Rubber Band is never used as a stateless N-in/N-out block effect.
3. Rendering is pull-based from the output side: the mixer asks for N output frames, the stream checks its output FIFO, feeds Rubber Band with the required source frames, retrieves available output, and returns the requested timeline block when source data is ready.
4. `RealtimePitchStream` owns or references its `RubberBandStretcher`, fixed output ring buffer, scratch input buffers, source prebuffer state, timeline/source mapping, latency compensation, preroll state, reset generation, and diagnostics.
5. Pitch stream creation, destruction, configuration, and session snapshot publication happen outside the audio callback.
6. Active streams are prepared before playback or transport discontinuities become audible.
7. Emergency silence is a test failure for valid non-silent source ranges. Source misses are diagnostics, not a normal rendering strategy.

## Audio Callback Prohibitions

The audio callback must not allocate, lock, wait, decode compressed audio, perform disk I/O, create or destroy Rubber Band instances, mutate unordered maps or maps for pitch streams, clone or rebuild `Session`, reconfigure audio devices, call Tauri/frontend code, or spam logs.

Allowed callback work is reading atomics, reading immutable stream snapshots, consuming preallocated buffers, reading already-decoded/prebuffered source data, simple DSP, output mixing, and cheap realtime-safe diagnostic counters.

## Default Flow

Audio Callback -> Mixer -> TrackRenderer -> Pitched clip -> RealtimePitchEngine -> RealtimePitchStream -> RubberBandStretcher -> SourceReadAheadCache/DecodedSource -> input scratch -> output ring -> preroll/latency compensation -> timeline-frame mapping.

`TrackRenderer` only decides clip overlap and whether pitch is needed. It calls `RealtimePitchEngine::render_pitched_clip` for non-zero effective semitones and reads the original source directly for unpitched or do-not-transpose tracks.

## Discontinuities

All play, seek, jump, loop wrap, song/region changes, and sample-rate/device reopen preparation routes through `prepare_for_transport_discontinuity(target_frame, reason, session, sources)`. This function prebuffers the source window, resets affected streams to the source frame mapped from the target timeline frame, runs preroll outside the audio callback, primes the output ring, and leaves a short output ramp for the first audible block.

## Diagnostics

Realtime pitch diagnostics expose render path, reset count, prime count, underflow/source miss counts, preroll frames, start delay, discarded frames, latency compensation, and output ring availability/capacity. Default diagnostics must report `realtime_stream`, with prepared proxy counters at zero in normal playback.

Additional crash-safety diagnostics expose `active_stream_set_generation`, `stream_generation`, `stream_reset_thread_id`, `stream_render_thread_id`, `unsafe_cross_thread_reset_count`, `concurrent_stream_mutation_detected`, `active_stream_swap_count`, `long_seek_count`, `last_transport_discontinuity_reason`, and `last_transport_discontinuity_target_frame`.

## Windows Memory Diagnostics

Debug native builds should keep MSVC stack protection enabled and may enable runtime checks with `/GS`, `/sdl`, and `/RTC1` where compatible. AddressSanitizer can be attempted with:

```powershell
cmake -S native/audio-engine-v2 -B build-asan -DLT_ENGINE_BUILD_TESTS=ON -DLT_ENGINE_ENABLE_ASAN=ON
cmake --build build-asan --target lt_engine_tests --config Debug
```

For manual app crashes, use the pitch diagnostics above as crash breadcrumbs rather than logging from the audio callback.
