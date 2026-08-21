#pragma once

// ---------------------------------------------------------------------------
// voice_priming — bringing a fresh BungeePitchVoice to a usable state.
//
// Two steps, in order, both on the control thread:
//
//   warm()             fills Bungee's analysis pipeline with silence, so the
//                      first real process() call does not fault and latency()
//                      reports a meaningful number.
//   align_on_source()  pushes real source audio through until the voice is
//                      emitting the frame the caller asked for.
//
// This lived twice — once in BungeeVoiceManager and once in
// PrearmedJumpManager, duplicated on purpose so the prearm MVP stayed
// revertible. The copies then drifted, and the drift was not cosmetic: they
// disagreed on what counted as "warp active" (|ratio - 1| > 1e-6 in one, the
// session's own warp_enabled flag in the other), which is the gap the prearm
// tests fell into for years. Fixing the timing model meant making the same
// correction twice, in two files, with nothing enforcing that they matched.
//
// One implementation removes that whole class of bug.
// ---------------------------------------------------------------------------

#include <lt_engine/core/types.h>

namespace lt {

class BungeePitchVoice;
class DecodedSource;

namespace voice_priming {

// Feed silence until Bungee's latency converges.
//
// Mandatory before any real audio: skipping it faults on the audio thread's
// first Stream::process call, because Bungee's outputPosition() dereferences a
// grain that does not exist yet.
//
// `pitch_scale` must be the pitch the voice will actually run at. Warming at
// 1.0 and switching afterwards displaces the pipeline — measured against
// Bungee 2.4.24 at -383 frames for -7 semitones and +255 for +7, in proportion
// to the transpose. That displacement is what the old 32 ms alignment constant
// was hiding; warming at the right pitch removes the cause.
//
// `time_ratio` is expressed the only way Bungee reads a ratio: as the
// proportion between the input and output frame counts of each call.
void warm(BungeePitchVoice& voice,
          int sample_rate,
          int channel_count,
          int max_in_frames,
          double time_ratio = 1.0,
          double pitch_scale = 1.0);

// Where a primed voice sits, in absolute source frames.
struct Alignment {
    // The source frame the voice will emit NEXT.
    Frame anchor = 0;
    // The source frame input has been fed up to. The difference from `anchor`
    // is the pipeline lead — the head start Bungee needs over its own output —
    // and the renderer holds it constant from here on.
    Frame fed_through = 0;
};

// Push real source through a warm voice until it is emitting
// `target_source_frame`, discarding the output (which belongs to earlier
// positions — it is the flush of the warm silence).
//
// Both returned values come out of Bungee's own accounting rather than being
// predicted from a latency sampled beforehand. The pipeline delay moves with
// pitch and with ratio, so predicting it left pitched jumps landing up to 116
// frames off the beat.
//
// Returns {target, target} when there is nothing to do (voice not ready, or
// not warm enough to report a latency).
Alignment align_on_source(BungeePitchVoice& voice,
                          const DecodedSource& source,
                          Frame target_source_frame,
                          int channel_count,
                          int max_in_frames,
                          double pitch_scale,
                          double time_ratio = 1.0);

} // namespace voice_priming
} // namespace lt
