#pragma once

// ---------------------------------------------------------------------------
// AudioSource — unified interface for all audio source types.
//
// The audio thread calls read() at callback time.
// All implementations must be realtime-safe in read() (no alloc, no lock
// that can block, no I/O inside read()).
// ---------------------------------------------------------------------------

#include <lt_engine/core/types.h>

namespace lt {

class AudioSource {
public:
    virtual ~AudioSource() = default;

    // Read `frame_count` frames starting at `timeline_offset` (absolute frame
    // position within the source).  Write to out[ch][0..frame_count-1].
    // Returns frames actually written.  Must never block.
    virtual int  read(Frame  offset_frames,
                      int    frame_count,
                      float** out,
                      int    num_channels) noexcept = 0;

    virtual int   channel_count()    const noexcept = 0;
    virtual int   sample_rate()      const noexcept = 0;
    virtual Frame duration_frames()  const noexcept = 0;
    virtual bool  is_ready()         const noexcept = 0;

    // Source type tag for diagnostics.
    virtual const char* type_name()  const noexcept = 0;
};

} // namespace lt
