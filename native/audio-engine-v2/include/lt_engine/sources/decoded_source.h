#pragma once

#include <lt_engine/core/types.h>
#include <lt_engine/session/session.h>
#include <lt_engine/sources/block_cache.h>
#include <atomic>
#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace lt {

struct SourcePeakOverview {
    int sample_rate = 0;
    Frame duration_frames = 0;
    int resolution_frames = 0;
    std::vector<float> min_peaks;
    std::vector<float> max_peaks;
};

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

    DecodedSource(Id                 source_id,
                  int                channel_count,
                  int                sample_rate,
                  Frame              duration_frames,
                  BlockCache*        cache,
                  std::function<void(const Id&, int)> request_block);

    // Read `frame_count` frames starting at `offset_frames` into `out`.
    // `out` is pre-allocated: out[ch] points to a buffer of frame_count floats.
    // Returns the number of frames actually read (may be < frame_count at EOF).
    int read(Frame offset_frames, int frame_count,
             float** out, int out_channels) const noexcept;

    int    channel_count()   const noexcept { return channel_count_; }
    int    sample_rate()     const noexcept { return sample_rate_; }
    Frame  duration_frames() const noexcept { return duration_frames_; }
    bool   is_loaded()       const noexcept { return !samples_.empty() || cache_ != nullptr; }
    bool   is_streaming()    const noexcept { return cache_ != nullptr; }
    size_t memory_bytes()    const noexcept { return samples_.size() * sizeof(float); }
    bool   is_range_ready(Frame offset_frames, int frame_count) const noexcept;

    SourcePeakOverview peaks(int resolution_frames) const;

private:
    Id                 source_id_;
    std::vector<float> samples_;
    BlockCache*        cache_ = nullptr;
    std::function<void(const Id&, int)> request_block_;
    mutable std::atomic<int> read_ahead_anchor_block_{-1};
    int    channel_count_   = 0;
    int    sample_rate_      = 0;
    Frame  duration_frames_  = 0;
};

} // namespace lt
