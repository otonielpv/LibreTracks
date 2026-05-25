#pragma once

// ---------------------------------------------------------------------------
// WarpVoice (abstract)
//
// Common interface for time-stretch backends used by the warp path. Concrete
// implementations:
//   - BungeeWarpVoice      (MPL-2.0, preferred when Bungee is available)
//   - RubberBandWarpVoice  (GPL v2, fallback)
//
// One instance per warp-active clip. The voice owns its own source cursor
// so the renderer doesn't have to re-derive it from a fractional ratio
// every block (which would introduce ±1-frame drift the stretcher hears
// as audible crackles).
// ---------------------------------------------------------------------------

#include <lt_engine/core/types.h>

namespace lt {

class WarpVoice {
public:
    virtual ~WarpVoice() = default;

    // Control thread.
    virtual bool        is_ready()                   const noexcept = 0;
    virtual const char* backend_name()               const noexcept = 0;
    virtual int         input_latency_frames()       const noexcept = 0;
    virtual int         output_latency_frames()      const noexcept = 0;
    virtual bool        needs_source_latency_compensation() const noexcept {
        return false;
    }

    // Source-cursor tracking. The renderer reads source_cursor() each block
    // to decide where in the file to read, then calls render_block() with
    // that audio; the implementation advances the cursor by the actual
    // input_frames it consumed.
    virtual void      reset_source_cursor(long long source_frame) noexcept = 0;
    virtual long long source_cursor()                  const noexcept = 0;

    // Audio thread (no allocations). Returns the number of output frames
    // actually written (== output_frames on success, 0 on failure).
    virtual int render_block(const float* const* input,
                              int                 input_frames,
                              float* const*       output,
                              int                 output_frames,
                              double              time_ratio) noexcept = 0;

    // Audio thread. Advance the source cursor by `input_frames` without
    // running the stretcher — used to keep a muted/silent track's voice
    // timeline-aligned so when it un-mutes the read position is correct.
    // Default implementation just updates the cursor via reset.
    virtual void advance_silent(int input_frames) noexcept {
        if (input_frames <= 0) return;
        reset_source_cursor(source_cursor() + input_frames);
    }
};

} // namespace lt
