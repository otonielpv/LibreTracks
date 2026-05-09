#pragma once

#include <lt_engine/core/types.h>
#include <lt_engine/session/session.h>
#include <lt_engine/sources/source_manager.h>
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
    void render(const Track&          track,
                Frame                 timeline_frame,
                int                   block_frames,
                float**               out,
                int                   num_out_channels,
                const SourceManager&  sources) noexcept;

private:
    // Render one clip's contribution for this block.
    void render_clip(const Clip&           clip,
                     Frame                 timeline_frame,
                     int                   block_frames,
                     float                 track_gain,
                     float**               out,
                     int                   num_out_channels,
                     const SourceManager&  sources) noexcept;

    // Scratch buffer for reading from source (avoids per-block heap alloc by
    // reusing a fixed-size stack buffer up to kMaxBlockFrames).
    static constexpr int kMaxBlockFrames = 4096;
    float scratch_l_[kMaxBlockFrames] = {};
    float scratch_r_[kMaxBlockFrames] = {};
    float* scratch_[2] = { scratch_l_, scratch_r_ };
};

} // namespace lt
