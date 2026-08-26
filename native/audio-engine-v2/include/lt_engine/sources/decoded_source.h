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
    std::vector<float> min_peaks_right;
    std::vector<float> max_peaks_right;
};

// Exact min/max envelope for a bounded source interval. Unlike
// SourcePeakOverview this is requested in display-sized buckets, so maximum
// zoom never has to stretch the persisted 256-frame overview.
struct SourcePeakWindow {
    int sample_rate = 0;
    Frame start_frame = 0;
    Frame end_frame = 0;
    int bucket_count = 0;
    std::vector<float> min_peaks;
    std::vector<float> max_peaks;
    std::vector<float> min_peaks_right;
    std::vector<float> max_peaks_right;
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
                  std::function<void(const Id&, int, int, bool)> request_blocks);

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

    // Total frames that were played as silence because the requested block
    // wasn't in the cache yet (streaming starvation). Nonzero means the
    // prebuffer couldn't keep up with playback for this source — the audible
    // "silent until it catches up" symptom. Monotonic; read off the audio
    // thread via the snapshot poll. Always tracked (no debug gate) so it shows
    // up in release diagnostics.
    Frame cache_miss_frames() const noexcept {
        return cache_miss_frames_.load(std::memory_order_relaxed);
    }

private:
    Id                 source_id_;
    std::vector<float> samples_;
    BlockCache*        cache_ = nullptr;
    // (source_id, first_block, block_count, urgent). `urgent` marks the block
    // the audio thread is silencing right now, so the fill workers serve it
    // before any read-ahead. See SourceManager::request_blocks.
    std::function<void(const Id&, int, int, bool)> request_blocks_;
    // Furthest block already covered by read-ahead. Advancing playback only
    // exposes one new edge block; requesting the whole overlapping window on
    // every block generated hundreds of thousands of redundant queue entries.
    mutable std::atomic<int> read_ahead_until_block_{-1};
    // The block this source is starving on right now, and for how many
    // callbacks. Re-issuing the urgent request (and the read-ahead burst behind
    // it) on EVERY silenced callback is what turns a transient shortfall into a
    // permanent one: each request takes the cache mutex the audio thread also
    // reads under, takes the fill-queue mutex the workers need to pull work
    // from, and wakes a worker. At 27 stems x 188 callbacks/s x 25 requests
    // that is ~127k lock pairs per second issued FROM the audio thread, so the
    // fill workers never hold the queue long enough to deliver a block and the
    // starvation feeds itself. The block is already queued after the first
    // request; re-ask only occasionally, in case a fill was dropped (a short
    // read, or a range the decode has not reached yet).
    mutable std::atomic<int> starving_block_{-1};
    mutable std::atomic<int> starving_repeats_{0};
    mutable std::atomic<Frame> cache_miss_frames_{0};
    int    channel_count_   = 0;
    int    sample_rate_      = 0;
    Frame  duration_frames_  = 0;
};

} // namespace lt
