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

## Stream Immutability Invariant

Published pitch stream sets are immutable. `build_stream_set_for_target` always creates fresh `RealtimePitchStream` instances — it never reuses streams from the live (published) set. This eliminates the data race between `reset_for_seek`/`prime` on the control thread and `render` on the audio thread. The audio thread reads the active set via `atomic_load`; the control thread replaces it atomically via `atomic_store` after building a complete new set. `set_pitch_ratio_or_reset` has been removed (it was the only caller that violated this invariant).

## Discontinuities

All play, seek, jump, loop wrap, song/region changes, and sample-rate/device reopen preparation routes through `prepare_for_transport_discontinuity(target_frame, reason, session, sources)`. This function prebuffers the source window, builds a fresh immutable stream set primed at the target frame, and publishes it atomically. A short output ramp (`apply_reset_ramp`) smooths the first audible block.

### Scheduled Jumps

When a scheduled jump fires inside `Mixer::render()` (the audio callback), the Mixer writes the target frame to `pending_scheduled_jump_frame_` (atomic, sentinel = -1). The control thread polls this via `take_pending_scheduled_jump()` inside `service_control_thread_tasks()` and calls `prepare_for_transport_discontinuity` for the jump frame before the next pitch render block becomes audible. This is the mechanism that prevents the "audio disappears and fades in after a jump" symptom without any locking or allocation in the audio callback.

## Mismatch Repair

During normal playback, `render_pitched_clip` compares `timeline_frame` with the stream's `expected_timeline_frame`. A mismatch means the stream drifted or was seeked without being rebuilt. The engine counts consecutive per-slot mismatches; after `kPitchMismatchRepairThreshold` (64) blocks, it sets `repair_pending_` and `repair_target_frame_`. The control thread polls via `take_repair_request()` and calls `prepare_for_pitch_repair()` to rebuild and prime at the drifted frame. A `kPostSeekRepairSuppressionBlocks` (64) grace window after any seek/discontinuity suppresses repair requests so normal post-seek frame transitions don't trigger false repairs.

## Diagnostics

Realtime pitch diagnostics expose render path, reset count, prime count, underflow/source miss counts, preroll frames, start delay, discarded frames, latency compensation, and output ring availability/capacity. Default diagnostics must report `realtime_stream`, with prepared proxy counters at zero in normal playback.

Additional crash-safety diagnostics expose `active_stream_set_generation`, `stream_generation`, `stream_reset_thread_id`, `stream_render_thread_id`, `unsafe_cross_thread_reset_count`, `concurrent_stream_mutation_detected`, `active_stream_swap_count`, `long_seek_count`, `last_transport_discontinuity_reason`, and `last_transport_discontinuity_target_frame`.

Key counters:
- `unsafe_cross_thread_reset_count`: non-zero = live stream mutation from wrong thread (data race)
- `pitch_timeline_mismatch_count`: accumulated mismatches; triggers repair after threshold
- `pitch_repair_requested_count` / `pitch_repair_completed_count`: repair cycle health
- `scheduled_jump_executed_count`: jumps fired in the audio callback (from `Mixer`)

## Windows Memory Diagnostics

Debug native builds should keep MSVC stack protection enabled and may enable runtime checks with `/GS`, `/sdl`, and `/RTC1` where compatible. AddressSanitizer can be attempted with:

```powershell
cmake -S native/audio-engine-v2 -B build-asan -DLT_ENGINE_BUILD_TESTS=ON -DLT_ENGINE_ENABLE_ASAN=ON
cmake --build build-asan --target lt_engine_tests --config Debug
```

For manual app crashes, use the pitch diagnostics above as crash breadcrumbs rather than logging from the audio callback.
