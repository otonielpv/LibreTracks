#pragma once

// ---------------------------------------------------------------------------
// PreparedTrackRenderer — renders one track through warp and pitch, offline,
// to a WAV file that playback can read instead of running the stretcher.
//
// Why offline rather than a faster real-time path: the cost of warp is ~1 % of
// the audio callback's budget PER TRACK, so a session with a dozen warped
// tracks spends most of its block on the stretcher. Measured, replacing that
// with a file read takes the p95 of a twelve-track block from 4,73 ms to
// 0,43 ms and the CPU of a pass from 1,484 s to 0,188 s. See
// docs/plans/audio-engine-performance/06-audio-preparado.md.
//
// ── What it renders, and what it deliberately does not ────────────────────
//
// It renders exactly what TrackRenderer produces: clip gain, fades, offsets,
// warp and transposition. It stops there. Track gain, pan, mute, solo and the
// region master are applied by the Mixer AFTER this, and baking them here would
// turn live controls into dead ones — measured to still act identically on a
// prepared file, and that property is the whole point of the boundary. See
// docs/plans/audio-engine-performance/09-controles-en-vivo.md.
//
// ── Where the audio comes from ────────────────────────────────────────────
//
// The session the live engine already holds. Rendering from a separately parsed
// copy of the model would let the two drift, and the one thing a prepared file
// must be is what live DSP would have produced at that position.
//
// ── Not the audio thread ──────────────────────────────────────────────────
//
// This allocates, opens files, blocks on reads and takes as long as it takes.
// It runs on a caller-provided thread and owns its own voices and renderer, so
// it never touches the live engine's render state.
//
// It does share the engine's SourceManager, on purpose. A private one would
// decode every source a second time and then evict the live cache to hold the
// copy — paying twice to make playback worse. The manager is already read
// concurrently by the audio thread while fill workers write into it; this is
// one more reader.
//
// Sources are made fully resident before rendering rather than streamed behind
// the read head. The stretched path cannot re-render a step that came up short
// — the stretcher has already consumed its input and advanced — so "wait and
// retry" is not available, and residency is the only way to guarantee the step
// sees its audio. One track at a time keeps that bounded: the measured peak for
// a preparation is 112 MiB.
// ---------------------------------------------------------------------------

#include <cstdint>
#include <memory>
#include <string>

#include <lt_engine/session/session.h>
#include <lt_engine/sources/source_manager.h>

namespace lt {

// Sample format written to disk. PCM16 is what the decode cache already uses
// (half the disk, quantization 80 dB under the programme) but it has a ceiling
// and warp raises peaks, so `clipped_samples` below is not decoration.
enum class PreparedSampleFormat { Pcm16, Float32 };

struct PreparedRenderRequest {
    const Session* session = nullptr;
    // The engine's own manager, with the session's sources already installed.
    SourceManager* sources = nullptr;
    Id song_id;
    Id track_id;
    std::string output_path;
    PreparedSampleFormat format = PreparedSampleFormat::Pcm16;
    // Frames rendered per step between progress reports. Smaller means the
    // cancel flag is honoured sooner and progress moves more smoothly.
    int block_frames = 4096;
};

struct PreparedRenderResult {
    bool ok = false;
    std::string error;
    // Where the rendered span begins on the timeline. The file covers the
    // track's own clips, not the whole song.
    Frame timeline_start_frame = 0;
    Frame frames = 0;
    std::uint64_t output_bytes = 0;
    // Samples the format's ceiling had to clamp. Non-zero means the file
    // carries distortion, not just quantization noise.
    std::uint64_t clipped_samples = 0;
    bool cancelled = false;
};

// Returns false to cancel. Called between render steps, never from audio.
using PreparedRenderProgressFn = bool (*)(void* ctx, Frame rendered, Frame total);

// Renders `request` and writes the file. On cancellation or failure the output
// is removed, so a partial file can never be mistaken for a finished one.
PreparedRenderResult render_prepared_track(const PreparedRenderRequest& request,
                                           PreparedRenderProgressFn on_progress,
                                           void* progress_ctx);

} // namespace lt
