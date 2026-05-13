#pragma once

#include <lt_engine/core/types.h>
#include <lt_engine/session/session.h>
#include <lt_engine/sources/source_manager.h>
#include <lt_engine/sources/original_source_cache.h>
#include <lt_engine/pitch/pitch_cache.h>
#include <vector>

namespace lt {

// ---------------------------------------------------------------------------
// TrackRenderer — renders one track's worth of audio for a single block.
//
// Called from the audio thread.  No allocation, no locks.
// ---------------------------------------------------------------------------
class TrackRenderer {
public:
    // Render `block_frames` frames of `track` starting at `timeline_frame`
    // into `out[0..num_out_channels-1]`, each buffer of length block_frames.
    // Accumulates into out (does not zero first).
    // `pitch_cache` may be nullptr — pitch shifting is skipped in that case.
    void render(const Track&          track,
                Frame                 timeline_frame,
                int                   block_frames,
                float**               out,
                int                   num_out_channels,
                const SourceManager&  sources,
                PitchCache*           pitch_cache,
                int                   engine_sample_rate,
                Semitones             effective_semitones = 0,
                const Song*           active_song = nullptr) noexcept;

private:
    // Render one clip's contribution for this block.
    void render_clip(const Clip&           clip,
                     Frame                 timeline_frame,
                     int                   block_frames,
                     float                 track_gain,
                     float**               out,
                     int                   num_out_channels,
                     const SourceManager&  sources,
                     PitchCache*           pitch_cache,
                     int                   engine_sample_rate,
                     const Id&             track_id,
                     Semitones             effective_semitones) noexcept;

    // Scratch buffer for reading from source (avoids per-block heap alloc by
    // reusing a fixed-size stack buffer up to kMaxBlockFrames).
    static constexpr int kMaxBlockFrames = 8192;
    float scratch_l_[kMaxBlockFrames] = {};
    float scratch_r_[kMaxBlockFrames] = {};
    float* scratch_[2] = { scratch_l_, scratch_r_ };
    OriginalSourceCache original_cache_;
};

} // namespace lt
