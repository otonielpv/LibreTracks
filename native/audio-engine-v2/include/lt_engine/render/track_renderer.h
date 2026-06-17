#pragma once

#include <lt_engine/core/types.h>
#include <lt_engine/session/session.h>
#include <lt_engine/sources/source_manager.h>
#include <lt_engine/sources/original_source_cache.h>
#include <vector>
#include <atomic>
#include <cstdint>
#include <limits>

namespace lt {
class BungeeVoiceManager;
}

namespace lt {

struct TrackRendererDiagnostics {
    std::uint64_t prepare_count = 0;
    std::uint64_t scratch_resize_count = 0;
    std::uint64_t scratch_resize_in_audio_thread_count = 0;
    std::uint64_t block_too_large_count = 0;
    int scratch_capacity_frames = 0;
    // Number of times a stretched clip had no Bungee voice to render through.
    // Non-zero means pitch/warp was needed but no voice existed — the clip
    // was silenced.
    std::uint64_t pitch_missing_stream_silence_count = 0;
    // Per-path block counters. Incremented once per clip per render call.
    std::uint64_t path_direct_count = 0;
    std::uint64_t path_varispeed_count = 0;
    std::uint64_t path_stretched_count = 0;
    // Direct-path reads that came back SHORT (source returned fewer frames than
    // requested → the tail was zero-filled = an audible gap). Spikes during a
    // clip drag mean the block cache is starving on the rapidly-changing source
    // offsets the drag reads — the prime suspect for the "trrrr" on big moves.
    std::uint64_t direct_short_read_count = 0;
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
    // Each clip is routed through one of three paths (decided per-block by
    // resolve_pitch_render_decision):
    //   - Direct:    read source as-is.
    //   - Varispeed: warp off + pitch != 0. Linear-interpolated resample;
    //                changes pitch AND duration (no Bungee voice).
    //   - Stretched: warp on. BungeeVoiceManager (single voice processes
    //                pitch and warp in the same grain pipeline via
    //                render_block's pitch_scale + time_ratio parameters).
    //
    // `track_is_silent` (default false): when true the renderer skips the
    // stretcher work and advances the voice's source cursor so its timeline
    // position stays aligned for when the track un-mutes. Direct path still
    // renders. Used by the mixer to keep CPU bounded when several stretched
    // tracks are muted.
    //
    // `track_gain_override` (default NaN = use track.gain): lets the caller
    // supply the gain WITHOUT copying the whole Track just to neutralize three
    // scalars. The mixer applies track gain/pan/mute itself downstream, so it
    // passes 1.0f here. Copying the Track (with its std::vector<Clip>) per block
    // allocated on the audio thread and contended the global heap lock with the
    // import's large allocations — a measured cause of playback dropouts.
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
                bool                  track_is_silent = false,
                float                 track_gain_override =
                    std::numeric_limits<float>::quiet_NaN()) noexcept;

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
    // Varispeed: pitch != 0 with warp OFF. Reads `ceil(frames_to_read *
    // pitch_scale)` source frames and linearly interpolates them down/up to
    // the output. Source cursor is derived from the timeline position so the
    // path is stateless across blocks.
    int render_path_varispeed(const ClipBlock& cb,
                              double           pitch_scale) noexcept;
    int render_path_stretched(const ClipBlock&     cb,
                               BungeeVoiceManager*  bungee_voices,
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
    // pointers). Sized to max_block_frames * 4 in prepare() so the warp path
    // can feed `ceil(block * ratio)` input frames per call (ratios clamped
    // upstream to [0.25, 4.0]).
    std::vector<float> bungee_in_l_;
    std::vector<float> bungee_in_r_;
    OriginalSourceCache original_cache_;

    static std::atomic<std::uint64_t> prepare_count_;
    static std::atomic<std::uint64_t> scratch_resize_count_;
    static std::atomic<std::uint64_t> scratch_resize_in_audio_thread_count_;
    static std::atomic<std::uint64_t> block_too_large_count_;
    static std::atomic<int> max_scratch_capacity_frames_;
    static std::atomic<std::uint64_t> pitch_missing_stream_silence_count_;
    static std::atomic<std::uint64_t> path_direct_count_;
    static std::atomic<std::uint64_t> path_varispeed_count_;
    static std::atomic<std::uint64_t> path_stretched_count_;
    static std::atomic<std::uint64_t> direct_short_read_count_;
};

} // namespace lt
