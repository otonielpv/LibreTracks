#include <lt_engine/render/track_renderer.h>
#include <lt_engine/render/pitch_resolution.h>
#include <lt_engine/pitch/bungee_voice_manager.h>
#include <lt_engine/pitch/warp_voice_manager.h>
#include <lt_engine/pitch/warp_voice.h>
#include <lt_engine/debug/logging.h>
#include <algorithm>
#include <cstring>
#include <cmath>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <cctype>
#include <string>

namespace lt {

namespace {

bool jump_debug_enabled_for_track_renderer() {
    static const bool on = [] {
        const char* raw = std::getenv("LIBRETRACKS_JUMP_DEBUG");
        if (!raw) raw = std::getenv("LIBRETRACKS_AUDIO_DEBUG");
        if (!raw) return false;
        std::string value = raw;
        std::transform(value.begin(), value.end(), value.begin(),
                       [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
        return value == "1" || value == "true" || value == "yes" || value == "on";
    }();
    return on;
}

void track_jump_debug_log(const char* fmt, ...) {
    if (!jump_debug_enabled_for_track_renderer()) return;
    va_list args;
    va_start(args, fmt);
    lt_debug_vlog(fmt, args);
    va_end(args);
}

} // namespace

std::atomic<std::uint64_t> TrackRenderer::prepare_count_{0};
std::atomic<std::uint64_t> TrackRenderer::scratch_resize_count_{0};
std::atomic<std::uint64_t> TrackRenderer::scratch_resize_in_audio_thread_count_{0};
std::atomic<std::uint64_t> TrackRenderer::block_too_large_count_{0};
std::atomic<int> TrackRenderer::max_scratch_capacity_frames_{0};
std::atomic<std::uint64_t> TrackRenderer::pitch_missing_stream_silence_count_{0};
std::atomic<std::uint64_t> TrackRenderer::warp_missing_stream_silence_count_{0};

void TrackRenderer::prepare(int max_block_frames) noexcept {
    if (max_block_frames <= 0)
        return;
    try {
        if (static_cast<int>(scratch_l_.size()) < max_block_frames) {
            scratch_l_.resize(static_cast<std::size_t>(max_block_frames), 0.0f);
            scratch_resize_count_.fetch_add(1, std::memory_order_relaxed);
        }
        if (static_cast<int>(scratch_r_.size()) < max_block_frames) {
            scratch_r_.resize(static_cast<std::size_t>(max_block_frames), 0.0f);
            scratch_resize_count_.fetch_add(1, std::memory_order_relaxed);
        }
        // Input scratch for the DSP backends. Sized 4x the output block so
        // the warp path can feed `ceil(block * ratio)` input frames per call
        // (ratios clamped upstream to [0.25, 4.0]). The pitch path only ever
        // reads `block_frames` so the headroom is harmless there.
        const int max_in = max_block_frames * 4;
        if (static_cast<int>(bungee_in_l_.size()) < max_in)
            bungee_in_l_.resize(static_cast<std::size_t>(max_in), 0.0f);
        if (static_cast<int>(bungee_in_r_.size()) < max_in)
            bungee_in_r_.resize(static_cast<std::size_t>(max_in), 0.0f);
        // Cascade intermediate buffer (Bungee output → RubberBand input).
        // Sized like bungee_in_* so Bungee can write up to one warp-scaled
        // block worth of frames into it.
        if (static_cast<int>(cascade_mid_l_.size()) < max_in)
            cascade_mid_l_.resize(static_cast<std::size_t>(max_in), 0.0f);
        if (static_cast<int>(cascade_mid_r_.size()) < max_in)
            cascade_mid_r_.resize(static_cast<std::size_t>(max_in), 0.0f);
        scratch_capacity_frames_ = std::min(static_cast<int>(scratch_l_.size()),
                                            static_cast<int>(scratch_r_.size()));
        scratch_[0] = scratch_l_.data();
        scratch_[1] = scratch_r_.data();
        prepare_count_.fetch_add(1, std::memory_order_relaxed);
        int observed = max_scratch_capacity_frames_.load(std::memory_order_relaxed);
        while (scratch_capacity_frames_ > observed
               && !max_scratch_capacity_frames_.compare_exchange_weak(
                   observed, scratch_capacity_frames_, std::memory_order_relaxed)) {}
    } catch (...) {
        scratch_capacity_frames_ = 0;
        scratch_[0] = nullptr;
        scratch_[1] = nullptr;
    }
}

TrackRendererDiagnostics TrackRenderer::diagnostics() noexcept {
    return TrackRendererDiagnostics{
        prepare_count_.load(std::memory_order_relaxed),
        scratch_resize_count_.load(std::memory_order_relaxed),
        scratch_resize_in_audio_thread_count_.load(std::memory_order_relaxed),
        block_too_large_count_.load(std::memory_order_relaxed),
        max_scratch_capacity_frames_.load(std::memory_order_relaxed),
        pitch_missing_stream_silence_count_.load(std::memory_order_relaxed),
        warp_missing_stream_silence_count_.load(std::memory_order_relaxed)};
}

void TrackRenderer::reset_diagnostics() noexcept {
    prepare_count_.store(0, std::memory_order_relaxed);
    scratch_resize_count_.store(0, std::memory_order_relaxed);
    scratch_resize_in_audio_thread_count_.store(0, std::memory_order_relaxed);
    block_too_large_count_.store(0, std::memory_order_relaxed);
    max_scratch_capacity_frames_.store(0, std::memory_order_relaxed);
    pitch_missing_stream_silence_count_.store(0, std::memory_order_relaxed);
    warp_missing_stream_silence_count_.store(0, std::memory_order_relaxed);
}

bool TrackRenderer::ensure_scratch_capacity(int frames) noexcept {
    if (frames < 0)
        return false;
    if (scratch_capacity_frames_ >= frames && scratch_[0] && scratch_[1])
        return true;
    if (scratch_capacity_frames_ > 0) {
        block_too_large_count_.fetch_add(1, std::memory_order_relaxed);
        return false;
    }
    scratch_resize_in_audio_thread_count_.fetch_add(1, std::memory_order_relaxed);
    prepare(frames);
    return scratch_capacity_frames_ >= frames && scratch_[0] && scratch_[1];
}

// ────────────────────────────────────────────────────────────────────────────
// Public entry — iterate clips, resolve their per-block decision, dispatch.
// ────────────────────────────────────────────────────────────────────────────

void TrackRenderer::render(const Track&         track,
                            Frame                timeline_frame,
                            int                  block_frames,
                            float**              out,
                            int                  num_out_channels,
                            const SourceManager& sources,
                            BungeeVoiceManager*  bungee_voices,
                            int                  engine_sample_rate,
                            Semitones            effective_semitones,
                            const Song*          active_song,
                            WarpVoiceManager*    warp_voices) noexcept {
    if (track.mute) return;
    (void)engine_sample_rate;

    for (const auto& clip : track.clips) {
        // Per-clip path decision. When the caller doesn't supply the song
        // (legacy code path) we fall back to the bare effective_semitones
        // value — no warp, no path enum, identical to the pre-warp engine.
        ClipPathKind path = ClipPathKind::Direct;
        Semitones    clip_semitones = effective_semitones;
        double       clip_warp_ratio = 1.0;
        if (active_song) {
            const auto decision = resolve_pitch_render_decision(
                track, clip, *active_song, timeline_frame);
            path             = decision.path;
            clip_semitones   = decision.effective_semitones;
            clip_warp_ratio  = decision.warp_time_ratio;
        } else if (clip_semitones != 0) {
            path = ClipPathKind::Pitch;
        }

        ClipBlock cb;
        if (!prepare_clip_block(clip, timeline_frame, block_frames,
                                 track.gain, sources, cb)) {
            continue;
        }

        // No timeline→source scaling here for warp/cascade — the voice
        // manager primed the voice's source cursor when it was built, and
        // SignalsmithWarpVoice advances that cursor by exactly the input
        // it was fed in the previous call. The renderer reads the cursor
        // back via wv->source_cursor() inside render_path_warp().

        // Reset scratch for this clip.
        std::fill(scratch_l_.begin(),
                  scratch_l_.begin() + cb.frames_to_read, 0.f);
        std::fill(scratch_r_.begin(),
                  scratch_r_.begin() + cb.frames_to_read, 0.f);

        int written = 0;
        switch (path) {
            case ClipPathKind::Direct:
                written = render_path_direct(cb);
                break;
            case ClipPathKind::Pitch:
                written = render_path_pitch(cb, bungee_voices,
                                             clip_semitones, track.id);
                break;
            case ClipPathKind::Warp:
                written = render_path_warp(cb, warp_voices,
                                            clip_warp_ratio, track.id);
                break;
            case ClipPathKind::Cascade:
                written = render_path_cascade(cb, bungee_voices, warp_voices,
                                               clip_semitones, clip_warp_ratio,
                                               track.id);
                break;
        }

        if (written > 0)
            finalise_clip_block(cb, written, out, num_out_channels);
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

bool TrackRenderer::prepare_clip_block(const Clip&          clip,
                                        Frame                timeline_frame,
                                        int                  block_frames,
                                        float                track_gain,
                                        const SourceManager& sources,
                                        ClipBlock&           out_block) noexcept {
    const Frame clip_end = clip.timeline_start_frame + clip.length_frames;
    if (timeline_frame >= clip_end) return false;
    if (timeline_frame + block_frames <= clip.timeline_start_frame) return false;

    const DecodedSource* src = sources.get(clip.source_id);
    if (!src || !src->is_loaded()) return false;

    int block_offset = 0;
    Frame source_frame = clip.source_start_frame;
    if (timeline_frame < clip.timeline_start_frame) {
        block_offset = static_cast<int>(clip.timeline_start_frame - timeline_frame);
    } else {
        source_frame = clip.source_start_frame
            + (timeline_frame - clip.timeline_start_frame);
    }

    int frames_to_read = block_frames - block_offset;
    frames_to_read = std::min(frames_to_read,
        static_cast<int>(clip_end - (timeline_frame + block_offset)));
    if (frames_to_read <= 0) return false;
    if (!ensure_scratch_capacity(frames_to_read)) return false;

    out_block.clip          = &clip;
    out_block.src           = src;
    out_block.clip_end      = clip_end;
    out_block.block_offset  = block_offset;
    out_block.source_frame  = source_frame;
    out_block.frames_to_read = frames_to_read;
    out_block.effective_gain = track_gain * clip.gain;
    return true;
}

// ────────────────────────────────────────────────────────────────────────────
// Path: Direct — read source as-is, no DSP.
// ────────────────────────────────────────────────────────────────────────────

int TrackRenderer::render_path_direct(const ClipBlock& cb) noexcept {
    float* read_into[2] = { scratch_l_.data(), scratch_r_.data() };
    const int copied = cb.src->read(cb.source_frame, cb.frames_to_read,
                                     read_into, 2);
    if (copied <= 0) return 0;
    if (copied < cb.frames_to_read) {
        std::fill(scratch_l_.begin() + copied,
                  scratch_l_.begin() + cb.frames_to_read, 0.0f);
        std::fill(scratch_r_.begin() + copied,
                  scratch_r_.begin() + cb.frames_to_read, 0.0f);
    }
    return cb.frames_to_read;
}

// ────────────────────────────────────────────────────────────────────────────
// Path: Pitch — Bungee at unity speed with a non-1 pitch_scale.
// ────────────────────────────────────────────────────────────────────────────

int TrackRenderer::render_path_pitch(const ClipBlock&     cb,
                                      BungeeVoiceManager*  bungee_voices,
                                      Semitones            effective_semitones,
                                      const Id&            track_id) noexcept {
    auto bv = bungee_voices ? bungee_voices->voice_for_shared(cb.clip->id)
                            : nullptr;
    if (!bv) {
        pitch_missing_stream_silence_count_.fetch_add(1, std::memory_order_relaxed);
        return 0;
    }

    const int queued = bv->queued_output_frames();
    const int bungee_in_capacity = std::min(
        static_cast<int>(bungee_in_l_.size()),
        static_cast<int>(bungee_in_r_.size()));
    // Pitch path always feeds `frames_to_read` (one output block) input
    // frames at speed=1.0. Skipping the feed when the FIFO already has the
    // block lets Bungee drain its earlier prefeed cleanly.
    int feed_frames = queued >= cb.frames_to_read ? 0
                                                  : cb.frames_to_read;
    feed_frames = std::min(feed_frames, bungee_in_capacity);

    const double pitch_scale = std::pow(2.0,
        static_cast<double>(effective_semitones) / 12.0);
    const long long latency = static_cast<long long>(bv->latency_frames());
    const int compensation = bv->alignment_compensation_frames(pitch_scale);
    const Frame read_from = cb.source_frame
        + static_cast<Frame>(latency)
        + static_cast<Frame>(compensation)
        + static_cast<Frame>(queued);
    const Frame src_end = cb.src->duration_frames();

    if (feed_frames > 0) {
        std::fill(bungee_in_l_.begin(), bungee_in_l_.begin() + feed_frames, 0.0f);
        std::fill(bungee_in_r_.begin(), bungee_in_r_.begin() + feed_frames, 0.0f);
    }
    const int dst_offset = read_from < 0
        ? static_cast<int>(std::min<Frame>(feed_frames, -read_from))
        : 0;
    const Frame read_start = std::max<Frame>(0, read_from);
    const int available = (dst_offset >= feed_frames || read_start >= src_end)
        ? 0
        : static_cast<int>(std::min<long long>(
            feed_frames - dst_offset,
            static_cast<long long>(src_end - read_start)));
    float* read_into[2] = {
        bungee_in_l_.data() + dst_offset,
        bungee_in_r_.data() + dst_offset };
    int got = 0;
    if (available > 0) {
        got = cb.src->read(read_start, available, read_into,
                            std::min(2, cb.src->channel_count()));
        if (got > 0 && cb.src->channel_count() == 1) {
            std::copy_n(bungee_in_l_.begin() + dst_offset, got,
                        bungee_in_r_.begin() + dst_offset);
        }
    }
    if (dst_offset + got < feed_frames) {
        std::fill(bungee_in_l_.begin() + std::max(0, dst_offset + got),
                  bungee_in_l_.begin() + feed_frames, 0.0f);
        std::fill(bungee_in_r_.begin() + std::max(0, dst_offset + got),
                  bungee_in_r_.begin() + feed_frames, 0.0f);
    }
    const float* in_ptrs[2] = { bungee_in_l_.data(), bungee_in_r_.data() };
    const int produced = bv->render_block(
        in_ptrs, feed_frames, scratch_, cb.frames_to_read, pitch_scale,
        /*time_ratio*/ 1.0);
    const int queued_after = bv->queued_output_frames();
    if (queued > 0 || cb.frames_to_read < feed_frames) {
        track_jump_debug_log(
            "[LT_JUMP_DEBUG][track-renderer] pitch track=%s clip=%s source_frame=%lld frames=%d queued_before=%d feed_frames=%d produced=%d queued_after=%d read_from=%lld latency=%lld compensation=%d pitch_scale=%.9f got=%d available=%d\n",
            track_id.c_str(), cb.clip->id.c_str(),
            static_cast<long long>(cb.source_frame),
            cb.frames_to_read, queued, feed_frames, produced, queued_after,
            static_cast<long long>(read_from), latency, compensation,
            pitch_scale, got, available);
    }

    // Bungee may return fewer frames than requested during its warm-up
    // window; pad the tail with zeros so the mix bus stays aligned.
    if (produced < cb.frames_to_read) {
        std::fill(scratch_l_.begin() + std::max(0, produced),
                  scratch_l_.begin() + cb.frames_to_read, 0.0f);
        std::fill(scratch_r_.begin() + std::max(0, produced),
                  scratch_r_.begin() + cb.frames_to_read, 0.0f);
    }
    return cb.frames_to_read;
}

// ────────────────────────────────────────────────────────────────────────────
// Path: Warp — Signalsmith Stretch at pitch=1, time_ratio=ratio.
// ────────────────────────────────────────────────────────────────────────────

int TrackRenderer::render_path_warp(const ClipBlock&   cb,
                                     WarpVoiceManager*  warp_voices,
                                     double             warp_time_ratio,
                                     const Id&          track_id) noexcept {
    auto wv = warp_voices ? warp_voices->voice_for_shared(cb.clip->id)
                          : nullptr;
    if (!wv) {
        warp_missing_stream_silence_count_.fetch_add(1, std::memory_order_relaxed);
        return 0;
    }

    const int bungee_in_capacity = std::min(
        static_cast<int>(bungee_in_l_.size()),
        static_cast<int>(bungee_in_r_.size()));
    const int input_to_feed = std::min(
        bungee_in_capacity,
        static_cast<int>(std::ceil(
            static_cast<double>(cb.frames_to_read) * warp_time_ratio)));
    if (input_to_feed <= 0) {
        warp_missing_stream_silence_count_.fetch_add(1, std::memory_order_relaxed);
        return 0;
    }

    // Read from where the voice last left off. The voice tracks its own
    // source cursor — re-deriving it from the timeline every block produces
    // ±1-frame overlaps under fractional warp ratios and Signalsmith
    // surfaces those as audible crackles.
    const long long cursor = wv->source_cursor();
    const Frame src_end = cb.src->duration_frames();
    std::fill(bungee_in_l_.begin(), bungee_in_l_.begin() + input_to_feed, 0.0f);
    std::fill(bungee_in_r_.begin(), bungee_in_r_.begin() + input_to_feed, 0.0f);
    const int dst_offset = cursor < 0
        ? static_cast<int>(std::min<long long>(input_to_feed, -cursor))
        : 0;
    const Frame read_start = static_cast<Frame>(std::max<long long>(0, cursor));
    const int available = (dst_offset >= input_to_feed || read_start >= src_end)
        ? 0
        : static_cast<int>(std::min<long long>(
            input_to_feed - dst_offset,
            static_cast<long long>(src_end - read_start)));
    if (available > 0) {
        float* read_into[2] = {
            bungee_in_l_.data() + dst_offset,
            bungee_in_r_.data() + dst_offset };
        const int got = cb.src->read(read_start, available, read_into,
                                      std::min(2, cb.src->channel_count()));
        if (got > 0 && cb.src->channel_count() == 1) {
            std::copy_n(bungee_in_l_.begin() + dst_offset, got,
                        bungee_in_r_.begin() + dst_offset);
        }
    }

    // Read what we got count BEFORE process() so we can log the actual
    // amount of real source frames (vs zero-padded tail).
    int got_input = 0;
    if (available > 0) {
        got_input = static_cast<int>(std::min<long long>(available,
                                                          src_end - read_start));
    }

    const float* in_ptrs[2] = { bungee_in_l_.data(), bungee_in_r_.data() };
    const int produced = wv->render_block(
        in_ptrs, input_to_feed, scratch_, cb.frames_to_read, warp_time_ratio);

    // Detect first/last sample of the scratch — useful for spotting clicks.
    // We log them every block under LIBRETRACKS_AUDIO_DEBUG so the user can
    // grep "warp track=" and see the per-block trace.
    const float first_l = produced > 0 ? scratch_l_[0] : 0.f;
    const float last_l  = produced > 0
        ? scratch_l_[static_cast<size_t>(produced - 1)]
        : 0.f;
    track_jump_debug_log(
        "[LT_JUMP_DEBUG][track-renderer] warp track=%s clip=%s cursor=%lld src_end=%lld input_to_feed=%d got_input=%d dst_offset=%d frames_to_read=%d produced=%d ratio=%.6f first_l=%.6f last_l=%.6f\n",
        track_id.c_str(), cb.clip->id.c_str(),
        cursor, static_cast<long long>(src_end),
        input_to_feed, got_input, dst_offset,
        cb.frames_to_read, produced, warp_time_ratio,
        first_l, last_l);

    if (produced < cb.frames_to_read) {
        std::fill(scratch_l_.begin() + std::max(0, produced),
                  scratch_l_.begin() + cb.frames_to_read, 0.0f);
        std::fill(scratch_r_.begin() + std::max(0, produced),
                  scratch_r_.begin() + cb.frames_to_read, 0.0f);
    }
    return cb.frames_to_read;
}

// ────────────────────────────────────────────────────────────────────────────
// Path: Cascade — Bungee (pitch, speed=1) → intermediate buffer → WarpVoice
// (time-stretch, pitch=1). Used when a clip has both transpose and warp.
//
// Frame math:
//   - WarpVoice wants `ceil(frames_to_read * ratio)` input per call to
//     produce `frames_to_read` output.
//   - Bungee runs at speed=1, so it produces 1 frame of output per frame of
//     input. We therefore ask Bungee to produce `ceil(frames_to_read * ratio)`
//     pitched frames, which means we read that many source frames and feed
//     them to Bungee.
//   - Bungee's own latency (~3-10k frames) shifts where in the source we
//     have to read from; we add latency + compensation just like the Pitch
//     path does. The warp cursor lives on the WarpVoice and advances in
//     lockstep with the input we hand it.
// ────────────────────────────────────────────────────────────────────────────

int TrackRenderer::render_path_cascade(const ClipBlock&     cb,
                                        BungeeVoiceManager*  bungee_voices,
                                        WarpVoiceManager*    warp_voices,
                                        Semitones            effective_semitones,
                                        double               warp_time_ratio,
                                        const Id&            track_id) noexcept {
    auto bv = bungee_voices ? bungee_voices->voice_for_shared(cb.clip->id)
                            : nullptr;
    auto wv = warp_voices ? warp_voices->voice_for_shared(cb.clip->id)
                          : nullptr;
    if (!bv) {
        pitch_missing_stream_silence_count_.fetch_add(1, std::memory_order_relaxed);
        return 0;
    }
    if (!wv) {
        warp_missing_stream_silence_count_.fetch_add(1, std::memory_order_relaxed);
        return 0;
    }

    const int bungee_in_capacity = std::min(
        static_cast<int>(bungee_in_l_.size()),
        static_cast<int>(bungee_in_r_.size()));
    const int mid_capacity = std::min(
        static_cast<int>(cascade_mid_l_.size()),
        static_cast<int>(cascade_mid_r_.size()));
    // RubberBand consumes ceil(out * ratio) input per call.
    const int rb_input_needed = std::min(
        mid_capacity,
        static_cast<int>(std::ceil(
            static_cast<double>(cb.frames_to_read) * warp_time_ratio)));
    if (rb_input_needed <= 0) {
        warp_missing_stream_silence_count_.fetch_add(1, std::memory_order_relaxed);
        return 0;
    }

    // Bungee feed: same size as what RubberBand will consume, because Bungee
    // runs at speed=1 (1 input frame → 1 output frame). Skip the feed when
    // Bungee's own FIFO already has enough — drain it first like the Pitch
    // path does.
    const int bungee_queued = bv->queued_output_frames();
    int bungee_feed_frames = bungee_queued >= rb_input_needed
        ? 0
        : std::min(rb_input_needed, bungee_in_capacity);

    const double pitch_scale = std::pow(2.0,
        static_cast<double>(effective_semitones) / 12.0);
    const long long latency = static_cast<long long>(bv->latency_frames());
    const int compensation = bv->alignment_compensation_frames(pitch_scale);
    // The WarpVoice has its own source cursor — use it as the authoritative
    // read position. Bungee's latency / compensation shift forward from
    // there because Bungee output lags its input by that much.
    const long long cursor = wv->source_cursor();
    const Frame read_from = static_cast<Frame>(cursor
        + latency + compensation + bungee_queued);
    const Frame src_end = cb.src->duration_frames();

    // Read source into bungee_in_*.
    if (bungee_feed_frames > 0) {
        std::fill(bungee_in_l_.begin(),
                  bungee_in_l_.begin() + bungee_feed_frames, 0.0f);
        std::fill(bungee_in_r_.begin(),
                  bungee_in_r_.begin() + bungee_feed_frames, 0.0f);
    }
    const int src_dst_offset = read_from < 0
        ? static_cast<int>(std::min<Frame>(bungee_feed_frames, -read_from))
        : 0;
    const Frame read_start = std::max<Frame>(0, read_from);
    const int src_available =
        (src_dst_offset >= bungee_feed_frames || read_start >= src_end)
            ? 0
            : static_cast<int>(std::min<long long>(
                bungee_feed_frames - src_dst_offset,
                static_cast<long long>(src_end - read_start)));
    if (src_available > 0) {
        float* read_into[2] = {
            bungee_in_l_.data() + src_dst_offset,
            bungee_in_r_.data() + src_dst_offset };
        const int got = cb.src->read(read_start, src_available, read_into,
                                      std::min(2, cb.src->channel_count()));
        if (got > 0 && cb.src->channel_count() == 1) {
            std::copy_n(bungee_in_l_.begin() + src_dst_offset, got,
                        bungee_in_r_.begin() + src_dst_offset);
        }
    }

    // Bungee process: pitch-shift, speed=1. Output goes to cascade_mid_*.
    float* mid_ptrs[2] = { cascade_mid_l_.data(), cascade_mid_r_.data() };
    const float* bungee_in_ptrs[2] = {
        bungee_in_l_.data(), bungee_in_r_.data() };
    const int pitched = bv->render_block(
        bungee_in_ptrs, bungee_feed_frames,
        mid_ptrs, rb_input_needed,
        pitch_scale,
        /*time_ratio*/ 1.0);
    // If Bungee fell short (warmup), zero-pad the tail so RubberBand gets
    // exactly rb_input_needed frames of pitched audio.
    if (pitched < rb_input_needed) {
        std::fill(cascade_mid_l_.begin() + std::max(0, pitched),
                  cascade_mid_l_.begin() + rb_input_needed, 0.0f);
        std::fill(cascade_mid_r_.begin() + std::max(0, pitched),
                  cascade_mid_r_.begin() + rb_input_needed, 0.0f);
    }

    // RubberBand process: time-stretch the pitched audio at warp_time_ratio.
    const float* rb_in_ptrs[2] = {
        cascade_mid_l_.data(), cascade_mid_r_.data() };
    const int produced = wv->render_block(
        rb_in_ptrs, rb_input_needed,
        scratch_, cb.frames_to_read, warp_time_ratio);
    if (produced < cb.frames_to_read) {
        std::fill(scratch_l_.begin() + std::max(0, produced),
                  scratch_l_.begin() + cb.frames_to_read, 0.0f);
        std::fill(scratch_r_.begin() + std::max(0, produced),
                  scratch_r_.begin() + cb.frames_to_read, 0.0f);
    }

    // First/last sample of the output so we can spot silence, NaN, or
    // gross discontinuities at block boundaries.
    const float out_first_l = produced > 0 ? scratch_l_[0] : 0.f;
    const float out_last_l  = produced > 0
        ? scratch_l_[static_cast<std::size_t>(produced - 1)]
        : 0.f;
    const float mid_first_l = pitched > 0 ? cascade_mid_l_[0] : 0.f;
    const float mid_last_l  = pitched > 0
        ? cascade_mid_l_[static_cast<std::size_t>(pitched - 1)]
        : 0.f;
    track_jump_debug_log(
        "[LT_JUMP_DEBUG][track-renderer] cascade track=%s clip=%s cursor=%lld read_from=%lld bungee_feed=%d pitched=%d rb_input=%d produced=%d pitch_scale=%.6f ratio=%.6f mid_first=%.6f mid_last=%.6f out_first=%.6f out_last=%.6f\n",
        track_id.c_str(), cb.clip->id.c_str(),
        cursor, static_cast<long long>(read_from),
        bungee_feed_frames, pitched, rb_input_needed, produced,
        pitch_scale, warp_time_ratio,
        mid_first_l, mid_last_l, out_first_l, out_last_l);
    return cb.frames_to_read;
}

// ────────────────────────────────────────────────────────────────────────────
// Apply fades + accumulate into the mix bus.
// ────────────────────────────────────────────────────────────────────────────

void TrackRenderer::finalise_clip_block(const ClipBlock& cb,
                                          int               frames_written,
                                          float**           out,
                                          int               num_out_channels) noexcept {
    const Clip& clip = *cb.clip;
    const int read = frames_written;

    if (clip.fade_in_frames > 0) {
        Frame played = cb.source_frame - clip.source_start_frame;
        for (int f = 0; f < read; ++f) {
            Frame pos = played + f;
            if (pos < clip.fade_in_frames) {
                const float g = static_cast<float>(pos) / clip.fade_in_frames;
                scratch_l_[static_cast<std::size_t>(f)] *= g;
                scratch_r_[static_cast<std::size_t>(f)] *= g;
            }
        }
    }
    if (clip.fade_out_frames > 0) {
        Frame played = cb.source_frame - clip.source_start_frame;
        for (int f = 0; f < read; ++f) {
            Frame pos = played + f;
            Frame from_end = clip.length_frames - pos;
            if (from_end < clip.fade_out_frames && from_end >= 0) {
                const float g = static_cast<float>(from_end) / clip.fade_out_frames;
                scratch_l_[static_cast<std::size_t>(f)] *= g;
                scratch_r_[static_cast<std::size_t>(f)] *= g;
            }
        }
    }

    float* dst_l = out[0] + cb.block_offset;
    float* dst_r = (num_out_channels >= 2) ? out[1] + cb.block_offset : nullptr;
    for (int f = 0; f < read; ++f) {
        dst_l[f] += scratch_l_[static_cast<std::size_t>(f)] * cb.effective_gain;
        if (dst_r)
            dst_r[f] += scratch_r_[static_cast<std::size_t>(f)] * cb.effective_gain;
    }
}

} // namespace lt
