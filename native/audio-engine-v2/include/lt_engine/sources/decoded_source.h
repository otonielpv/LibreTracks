#pragma once

#include <lt_engine/core/types.h>
#include <lt_engine/session/session.h>
#include <memory>
#include <vector>

namespace lt {

// ---------------------------------------------------------------------------
// DecodedSource — fully decoded, resampled, float32 audio in engine memory.
//
// All samples are interleaved by channel: [L0 R0 L1 R1 ...].
// Sample rate matches the engine sample rate.
// This is the pre-Phase-11 in-memory representation; replaced by
// CachedSource/StreamingSource in Phase 11.
// ---------------------------------------------------------------------------
class DecodedSource {
public:
    DecodedSource() = default;

    DecodedSource(std::vector<float> samples,
                  int                channel_count,
                  int                sample_rate,
                  Frame              duration_frames);

    // Read `frame_count` frames starting at `offset_frames` into `out`.
    // `out` is pre-allocated: out[ch] points to a buffer of frame_count floats.
    // Returns the number of frames actually read (may be < frame_count at EOF).
    int read(Frame offset_frames, int frame_count,
             float** out, int out_channels) const noexcept;

    int    channel_count()   const noexcept { return channel_count_; }
    int    sample_rate()     const noexcept { return sample_rate_; }
    Frame  duration_frames() const noexcept { return duration_frames_; }
    bool   is_loaded()       const noexcept { return !samples_.empty(); }

private:
    std::vector<float> samples_;
    int    channel_count_   = 0;
    int    sample_rate_      = 0;
    Frame  duration_frames_  = 0;
};

} // namespace lt
