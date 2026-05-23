#pragma once

#include <lt_engine/core/types.h>
#include <lt_engine/session/session.h>
#include <lt_engine/sources/source_manager.h>
#include <lt_engine/sources/original_source_cache.h>
#include <vector>
#include <atomic>
#include <cstdint>

namespace lt { class BungeeVoiceManager; }

namespace lt {

struct TrackRendererDiagnostics {
    std::uint64_t prepare_count = 0;
    std::uint64_t scratch_resize_count = 0;
    std::uint64_t scratch_resize_in_audio_thread_count = 0;
    std::uint64_t block_too_large_count = 0;
    int scratch_capacity_frames = 0;
    // Number of times a pitched clip had no Bungee voice to render through.
    // Non-zero means pitch was needed but no voice existed — the clip was silenced.
    std::uint64_t pitch_missing_stream_silence_count = 0;
};

// ---------------------------------------------------------------------------
// TrackRenderer — renders one track's worth of audio for a single block.
//
// Called from the audio thread.  No allocation, no locks.
// ---------------------------------------------------------------------------
class TrackRenderer {
public:
    void prepare(int max_block_frames) noexcept;
    static TrackRendererDiagnostics diagnostics() noexcept;
    static void reset_diagnostics() noexcept;

    // Render `block_frames` frames of `track` starting at `timeline_frame`
    // into `out[0..num_out_channels-1]`, each buffer of length block_frames.
    // Accumulates into out (does not zero first).
    //
    // When `effective_semitones != 0`, the clip is routed through the
    // BungeeVoiceManager. If no voice exists for the clip the block is
    // silenced (and pitch_missing_stream_silence_count is incremented).
    void render(const Track&          track,
                Frame                 timeline_frame,
                int                   block_frames,
                float**               out,
                int                   num_out_channels,
                const SourceManager&  sources,
                BungeeVoiceManager*   bungee_voices,
                int                   engine_sample_rate,
                Semitones             effective_semitones = 0,
                const Song*           active_song = nullptr) noexcept;

private:
    // Render one clip's contribution for this block.
    // `warp_active` / `warp_time_ratio` come from the per-clip
    // PitchRenderDecision computed in render(). When `warp_active` is true
    // the clip is routed through Bungee with `time_ratio = warp_time_ratio`,
    // even when `effective_semitones == 0` (pure time-stretch).
    void render_clip(const Clip&           clip,
                     Frame                 timeline_frame,
                     int                   block_frames,
                     float                 track_gain,
                     float**               out,
                     int                   num_out_channels,
                     const SourceManager&  sources,
                     BungeeVoiceManager*   bungee_voices,
                     int                   engine_sample_rate,
                     const Id&             track_id,
                     Semitones             effective_semitones,
                     bool                  warp_active = false,
                     double                warp_time_ratio = 1.0) noexcept;

    bool ensure_scratch_capacity(int frames) noexcept;

    std::vector<float> scratch_l_;
    std::vector<float> scratch_r_;
    int scratch_capacity_frames_ = 0;
    float* scratch_[2] = { nullptr, nullptr };
    // Planar input scratch used to feed BungeePitchVoice (which wants planar
    // pointers). Sized to match scratch_l_/scratch_r_ during prepare().
    std::vector<float> bungee_in_l_;
    std::vector<float> bungee_in_r_;
    OriginalSourceCache original_cache_;

    static std::atomic<std::uint64_t> prepare_count_;
    static std::atomic<std::uint64_t> scratch_resize_count_;
    static std::atomic<std::uint64_t> scratch_resize_in_audio_thread_count_;
    static std::atomic<std::uint64_t> block_too_large_count_;
    static std::atomic<int> max_scratch_capacity_frames_;
    static std::atomic<std::uint64_t> pitch_missing_stream_silence_count_;
};

} // namespace lt
