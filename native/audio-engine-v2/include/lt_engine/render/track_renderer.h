#pragma once

#include <lt_engine/core/types.h>
#include <lt_engine/session/session.h>
#include <lt_engine/sources/source_manager.h>
#include <lt_engine/sources/original_source_cache.h>
#include <vector>
#include <atomic>
#include <cstdint>

namespace lt {
class BungeeVoiceManager;
class WarpVoiceManager;
}

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
    // Same for warp: number of blocks where the warp path could not find a
    // warp voice and silenced output.
    std::uint64_t warp_missing_stream_silence_count = 0;
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
    // Each clip is routed through one of four paths (decided per-block by
    // resolve_pitch_render_decision):
    //   - Direct:  read source as-is
    //   - Pitch:   BungeeVoiceManager (pitch_scale != 1, time_ratio = 1)
    //   - Warp:    WarpVoiceManager (pitch = 1, time_ratio != 1)
    //   - Cascade: pitch first, then warp
    //
    // `warp_voices` may be nullptr; clips that resolve to Warp/Cascade then
    // silence and bump warp_missing_stream_silence_count.
    // `track_is_silent` (default false): when true, warp/cascade voices
    // skip their stretcher work and just advance the source cursor so the
    // voice stays timeline-aligned for when the track un-mutes. Direct and
    // pitch paths still render — only the expensive RubberBand stages are
    // gated. Used by the mixer to keep CPU bounded when several warp tracks
    // exist but most are muted.
    void render(const Track&          track,
                Frame                 timeline_frame,
                int                   block_frames,
                float**               out,
                int                   num_out_channels,
                const SourceManager&  sources,
                BungeeVoiceManager*   bungee_voices,
                int                   engine_sample_rate,
                Semitones             effective_semitones = 0,
                const Song*           active_song = nullptr,
                WarpVoiceManager*     warp_voices = nullptr,
                bool                  track_is_silent = false) noexcept;

private:
    struct ClipBlock {
        const Clip* clip;
        const DecodedSource* src;
        Frame  clip_end;
        int    block_offset;     // first frame of this block that's inside the clip
        Frame  source_frame;     // source frame the first scratch[0] sample maps to
        int    frames_to_read;   // valid frames after block_offset
        float  effective_gain;   // pre-multiplied gain (track * clip)
    };

    // Decide the slice of this block that overlaps `clip` and prepare the
    // source pointer + bounds. Returns false when the block is outside the
    // clip, when the source isn't loaded, or when scratch can't grow to fit.
    bool prepare_clip_block(const Clip&            clip,
                             Frame                  timeline_frame,
                             int                    block_frames,
                             float                  track_gain,
                             const SourceManager&   sources,
                             ClipBlock&             out_block) noexcept;

    // Per-path renderers. Each writes `frames_to_read` frames into
    // scratch_l_/scratch_r_ starting at index 0 and returns how many were
    // actually written (== frames_to_read on success, 0 on miss).
    int render_path_direct(const ClipBlock& cb) noexcept;
    int render_path_pitch(const ClipBlock&     cb,
                          BungeeVoiceManager*  bungee_voices,
                          Semitones            effective_semitones,
                          const Id&            track_id) noexcept;
    int render_path_warp(const ClipBlock&    cb,
                         WarpVoiceManager*   warp_voices,
                         double              warp_time_ratio,
                         const Id&           track_id,
                         bool                track_is_silent) noexcept;
    int render_path_cascade(const ClipBlock&     cb,
                            BungeeVoiceManager*  bungee_voices,
                            WarpVoiceManager*    warp_voices,
                            Semitones            effective_semitones,
                            double               warp_time_ratio,
                            const Id&            track_id,
                            bool                 track_is_silent) noexcept;

    // Apply fades and accumulate into the output mix bus.
    void finalise_clip_block(const ClipBlock& cb,
                              int               frames_written,
                              float**           out,
                              int               num_out_channels) noexcept;

    bool ensure_scratch_capacity(int frames) noexcept;

    std::vector<float> scratch_l_;
    std::vector<float> scratch_r_;
    int scratch_capacity_frames_ = 0;
    float* scratch_[2] = { nullptr, nullptr };
    // Planar input scratch used to feed BungeePitchVoice (which wants planar
    // pointers). Sized to match scratch_l_/scratch_r_ during prepare().
    std::vector<float> bungee_in_l_;
    std::vector<float> bungee_in_r_;
    // Intermediate buffer used by the Cascade path to hold pitch-shifted
    // audio coming out of Bungee on its way into the warp backend.
    std::vector<float> cascade_mid_l_;
    std::vector<float> cascade_mid_r_;
    OriginalSourceCache original_cache_;

    static std::atomic<std::uint64_t> prepare_count_;
    static std::atomic<std::uint64_t> scratch_resize_count_;
    static std::atomic<std::uint64_t> scratch_resize_in_audio_thread_count_;
    static std::atomic<std::uint64_t> block_too_large_count_;
    static std::atomic<int> max_scratch_capacity_frames_;
    static std::atomic<std::uint64_t> pitch_missing_stream_silence_count_;
    static std::atomic<std::uint64_t> warp_missing_stream_silence_count_;
};

} // namespace lt
