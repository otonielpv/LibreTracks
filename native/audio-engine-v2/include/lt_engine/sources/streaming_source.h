#pragma once

// ---------------------------------------------------------------------------
// StreamingSource — AudioSource backed by the BlockCache.
//
// Audio thread reads from cache (fast path, no I/O).
// On cache miss it returns silence and emits a starvation signal that the
// PrebufferWorker watches to schedule a fill job.
// ---------------------------------------------------------------------------

#include <lt_engine/sources/audio_source.h>
#include <lt_engine/sources/block_cache.h>
#include <lt_engine/core/events.h>
#include <atomic>
#include <functional>
#include <string>

namespace lt {

using StarvationCallback = std::function<void(const Id& source_id, int block_index)>;

class StreamingSource : public AudioSource {
public:
    StreamingSource(Id                  source_id,
                    int                 channel_count,
                    int                 sample_rate,
                    Frame               duration_frames,
                    BlockCache*         cache,
                    StarvationCallback  on_starve = nullptr);

    int  read(Frame  offset_frames,
              int    frame_count,
              float** out,
              int    num_channels) noexcept override;

    int    channel_count()   const noexcept override { return channel_count_; }
    int    sample_rate()     const noexcept override { return sample_rate_; }
    Frame  duration_frames() const noexcept override { return duration_frames_; }
    bool   is_ready()        const noexcept override { return true; }  // always serves (silence on miss)
    const char* type_name()  const noexcept override { return "streaming"; }

    // Starvation counter — how many cache misses have occurred.
    int starvation_count() const noexcept { return starvation_count_.load(std::memory_order_relaxed); }

private:
    Id                  source_id_;
    int                 channel_count_;
    int                 sample_rate_;
    Frame               duration_frames_;
    BlockCache*         cache_;
    StarvationCallback  on_starve_;
    std::atomic<int>    starvation_count_{0};
};

// ---------------------------------------------------------------------------
// PreparedSource — AudioSource wrapping an already fully-decoded DecodedSource.
// Used when sources fit in RAM (Phases 6-9) or when a pitch-shifted copy
// has been pre-rendered.
// ---------------------------------------------------------------------------
class PreparedSource : public AudioSource {
public:
    // Takes ownership of the samples vector.
    PreparedSource(Id                id,
                   std::vector<float> samples,
                   int               channel_count,
                   int               sample_rate,
                   Frame             duration_frames);

    int  read(Frame  offset_frames,
              int    frame_count,
              float** out,
              int    num_channels) noexcept override;

    int    channel_count()   const noexcept override { return channel_count_; }
    int    sample_rate()     const noexcept override { return sample_rate_; }
    Frame  duration_frames() const noexcept override { return duration_frames_; }
    bool   is_ready()        const noexcept override { return true; }
    const char* type_name()  const noexcept override { return "prepared"; }

private:
    Id                  id_;
    std::vector<float>  samples_;
    int                 channel_count_;
    int                 sample_rate_;
    Frame               duration_frames_;
};

// ---------------------------------------------------------------------------
// SilentSource — always returns silence; used as safe fallback.
// ---------------------------------------------------------------------------
class SilentSource : public AudioSource {
public:
    SilentSource(int channel_count, int sample_rate, Frame duration_frames);

    int  read(Frame, int frame_count, float** out, int num_channels) noexcept override;
    int    channel_count()   const noexcept override { return channel_count_; }
    int    sample_rate()     const noexcept override { return sample_rate_; }
    Frame  duration_frames() const noexcept override { return duration_frames_; }
    bool   is_ready()        const noexcept override { return true; }
    const char* type_name()  const noexcept override { return "silent"; }

private:
    int   channel_count_;
    int   sample_rate_;
    Frame duration_frames_;
};

} // namespace lt
