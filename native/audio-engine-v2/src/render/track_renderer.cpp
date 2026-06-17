#include <lt_engine/render/track_renderer.h>
#include <lt_engine/render/pitch_resolution.h>
#include <lt_engine/pitch/bungee_voice_manager.h>
#include <lt_engine/debug/logging.h>
#include <algorithm>
#include <chrono>
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
std::atomic<std::uint64_t> TrackRenderer::path_direct_count_{0};
std::atomic<std::uint64_t> TrackRenderer::path_varispeed_count_{0};
std::atomic<std::uint64_t> TrackRenderer::path_stretched_count_{0};
std::atomic<std::uint64_t> TrackRenderer::direct_short_read_count_{0};

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
        // Input scratch for Bungee. Sized 4x the output block so the warp
        // path can feed `ceil(block * ratio)` input frames per call (ratios
        // clamped upstream to [0.25, 4.0]). The pitch-only path only reads
        // `block_frames` so the headroom is harmless there.
        const int max_in = max_block_frames * 4;
        if (static_cast<int>(bungee_in_l_.size()) < max_in)
            bungee_in_l_.resize(static_cast<std::size_t>(max_in), 0.0f);
        if (static_cast<int>(bungee_in_r_.size()) < max_in)
            bungee_in_r_.resize(static_cast<std::size_t>(max_in), 0.0f);
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
        path_direct_count_.load(std::memory_order_relaxed),
        path_varispeed_count_.load(std::memory_order_relaxed),
        path_stretched_count_.load(std::memory_order_relaxed),
        direct_short_read_count_.load(std::memory_order_relaxed)};
}

void TrackRenderer::reset_diagnostics() noexcept {
    prepare_count_.store(0, std::memory_order_relaxed);
    scratch_resize_count_.store(0, std::memory_order_relaxed);
    scratch_resize_in_audio_thread_count_.store(0, std::memory_order_relaxed);
    block_too_large_count_.store(0, std::memory_order_relaxed);
    max_scratch_capacity_frames_.store(0, std::memory_order_relaxed);
    pitch_missing_stream_silence_count_.store(0, std::memory_order_relaxed);
    path_direct_count_.store(0, std::memory_order_relaxed);
    path_varispeed_count_.store(0, std::memory_order_relaxed);
    path_stretched_count_.store(0, std::memory_order_relaxed);
    direct_short_read_count_.store(0, std::memory_order_relaxed);
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
                            bool                 track_is_silent,
                            float                track_gain_override) noexcept {
    // When the caller supplies a gain override it also owns mute handling (the
    // mixer applies mute via its own gain ramp and still wants the renderer to
    // run so the source cursor / Bungee voice stay aligned). Only honour the
    // track's own mute flag on the legacy no-override path.
    const bool has_override = !std::isnan(track_gain_override);
    if (!has_override && track.mute) return;
    (void)engine_sample_rate;

    // Use the override when supplied (mixer passes 1.0f to avoid copying the
    // whole Track just to neutralize gain); otherwise the track's own gain.
    const float track_gain = has_override ? track_gain_override : track.gain;

    for (const auto& clip : track.clips) {
        // Per-clip path decision. When the caller doesn't supply the song
        // (legacy code path) we fall back to the bare effective_semitones
        // value — identical to the pre-warp engine, but now mapped through
        // the Varispeed path when pitch is non-zero and warp is absent.
        ClipPathKind path = ClipPathKind::Direct;
        Semitones    clip_semitones = effective_semitones;
        double       clip_warp_ratio = 1.0;
        double       clip_pitch_scale = 1.0;
        if (active_song) {
            const auto decision = resolve_pitch_render_decision(
                track, clip, *active_song, timeline_frame);
            path             = decision.path;
            clip_semitones   = decision.effective_semitones;
            clip_warp_ratio  = decision.warp_time_ratio;
            clip_pitch_scale = decision.pitch_scale;
        } else if (clip_semitones != 0) {
            // Legacy callers (tests, direct invocations) pass a non-null bvm
            // and no song context; keep them on the Bungee path so their
            // bvm setup is exercised. The Phase-4 Varispeed routing requires
            // the song to decide pitch_scale vs warp, and runtime always
            // plumbs the song through, so this branch only ever fires for
            // legacy test paths.
            path = ClipPathKind::Stretched;
        }

        ClipBlock cb;
        if (!prepare_clip_block(clip, timeline_frame, block_frames,
                                 track_gain, sources, cb)) {
            continue;
        }

        int written = 0;
        switch (path) {
            case ClipPathKind::Direct:
                path_direct_count_.fetch_add(1, std::memory_order_relaxed);
                written = render_path_direct(cb);
                break;
            case ClipPathKind::Varispeed:
                path_varispeed_count_.fetch_add(1, std::memory_order_relaxed);
                written = render_path_varispeed(cb, clip_pitch_scale);
                track_jump_debug_log(
                    "[LT_JUMP_DEBUG][track-renderer] varispeed track=%s clip=%s timeline=%lld runtime_start=%lld runtime_len=%lld source_frame=%lld frames=%d pitch_scale=%.6f written=%d\n",
                    track.id.c_str(),
                    clip.id.c_str(),
                    static_cast<long long>(timeline_frame),
                    static_cast<long long>(clip.timeline_start_frame),
                    static_cast<long long>(clip.length_frames),
                    static_cast<long long>(cb.source_frame),
                    cb.frames_to_read,
                    clip_pitch_scale,
                    written);
                break;
            case ClipPathKind::Stretched:
                path_stretched_count_.fetch_add(1, std::memory_order_relaxed);
                written = render_path_stretched(cb, bungee_voices,
                                                clip_semitones,
                                                clip_warp_ratio,
                                                track.id,
                                                track_is_silent);
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
        direct_short_read_count_.fetch_add(1, std::memory_order_relaxed);
    }
    return cb.frames_to_read;
}

// ────────────────────────────────────────────────────────────────────────────
// Path: Varispeed — linear-interpolated resample. Used when pitch != 0 and
// warp is off. Reads ~ceil(N * pitch_scale) source frames and interpolates
// them down/up to N output frames. The clip's runtime length_frames is
// expected to already be shrunk/expanded by the front-end's timeline
// mapping, so `frames_to_read` reflects the audible length; we just need to
// stream source samples `pitch_scale`× as fast as the timeline.
// ────────────────────────────────────────────────────────────────────────────

int TrackRenderer::render_path_varispeed(const ClipBlock& cb,
                                          double           pitch_scale) noexcept {
    if (!(pitch_scale > 0.0) || !std::isfinite(pitch_scale)) return 0;
    if (cb.frames_to_read <= 0) return 0;

    // Source position of the FIRST output frame in this block. The runtime
    // timeline_start_frame and source_start_frame already encode the clip's
    // boundary; the per-block offset (timeline_frame - timeline_start_frame)
    // is measured in audible frames, so we scale it by pitch_scale to get
    // the matching source frame.
    const long long timeline_offset_in_clip =
        static_cast<long long>(cb.source_frame - cb.clip->source_start_frame);
    const double source_start = static_cast<double>(cb.clip->source_start_frame)
        + static_cast<double>(timeline_offset_in_clip) * pitch_scale;

    // We need ceil(N * scale) + 1 source samples to interpolate N output
    // samples. +1 for the right-hand neighbour of the last fractional index.
    const int input_capacity = std::min(
        static_cast<int>(bungee_in_l_.size()),
        static_cast<int>(bungee_in_r_.size()));
    const int frames_needed = static_cast<int>(std::ceil(
        static_cast<double>(cb.frames_to_read) * pitch_scale)) + 1;
    if (frames_needed > input_capacity || frames_needed <= 0) return 0;

    // Clamp source read to the source's available range; fill any tail with
    // zeros so the interpolation reads valid memory.
    const Frame src_end = cb.src->duration_frames();
    const Frame read_start_floor = static_cast<Frame>(std::floor(source_start));
    const Frame read_start = std::max<Frame>(0, read_start_floor);
    const int leading_zeros = static_cast<int>(read_start - read_start_floor);
    const int after_leading = frames_needed - leading_zeros;
    const int available = (after_leading <= 0 || read_start >= src_end)
        ? 0
        : static_cast<int>(std::min<long long>(
            after_leading, static_cast<long long>(src_end - read_start)));

    if (leading_zeros > 0) {
        std::fill(bungee_in_l_.begin(),
                  bungee_in_l_.begin() + leading_zeros, 0.0f);
        std::fill(bungee_in_r_.begin(),
                  bungee_in_r_.begin() + leading_zeros, 0.0f);
    }

    int got = 0;
    if (available > 0) {
        float* read_into[2] = {
            bungee_in_l_.data() + leading_zeros,
            bungee_in_r_.data() + leading_zeros };
        got = cb.src->read(read_start, available, read_into,
                           std::min(2, cb.src->channel_count()));
        if (got > 0 && cb.src->channel_count() == 1) {
            std::copy_n(bungee_in_l_.begin() + leading_zeros, got,
                        bungee_in_r_.begin() + leading_zeros);
        }
    }
    const int tail_start = leading_zeros + std::max(0, got);
    if (tail_start < frames_needed) {
        std::fill(bungee_in_l_.begin() + tail_start,
                  bungee_in_l_.begin() + frames_needed, 0.0f);
        std::fill(bungee_in_r_.begin() + tail_start,
                  bungee_in_r_.begin() + frames_needed, 0.0f);
    }

    // Fractional cursor inside the input buffer for output sample 0.
    const double cursor0 = source_start - static_cast<double>(read_start_floor);
    for (int i = 0; i < cb.frames_to_read; ++i) {
        const double pos = cursor0 + static_cast<double>(i) * pitch_scale;
        const int idx0 = static_cast<int>(std::floor(pos));
        if (idx0 < 0 || idx0 + 1 >= frames_needed) {
            scratch_l_[static_cast<std::size_t>(i)] = 0.0f;
            scratch_r_[static_cast<std::size_t>(i)] = 0.0f;
            continue;
        }
        const float frac = static_cast<float>(pos - static_cast<double>(idx0));
        const float l0 = bungee_in_l_[static_cast<std::size_t>(idx0)];
        const float l1 = bungee_in_l_[static_cast<std::size_t>(idx0 + 1)];
        const float r0 = bungee_in_r_[static_cast<std::size_t>(idx0)];
        const float r1 = bungee_in_r_[static_cast<std::size_t>(idx0 + 1)];
        scratch_l_[static_cast<std::size_t>(i)] = l0 + (l1 - l0) * frac;
        scratch_r_[static_cast<std::size_t>(i)] = r0 + (r1 - r0) * frac;
    }
    return cb.frames_to_read;
}

// ────────────────────────────────────────────────────────────────────────────
// Path: Stretched — Bungee with pitch_scale and time_ratio in a single voice.
// Replaces the old separate Pitch / Warp / Cascade paths; Bungee::Stream
// handles pitch + warp simultaneously in the same grain pipeline.
// ────────────────────────────────────────────────────────────────────────────

int TrackRenderer::render_path_stretched(const ClipBlock&     cb,
                                          BungeeVoiceManager*  bungee_voices,
                                          Semitones            effective_semitones,
                                          double               warp_time_ratio,
                                          const Id&            track_id,
                                          bool                 track_is_silent) noexcept {
    auto bv = bungee_voices ? bungee_voices->voice_for_shared(cb.clip->id)
                            : nullptr;
    if (!bv) {
        pitch_missing_stream_silence_count_.fetch_add(1, std::memory_order_relaxed);
        return 0;
    }

    const int bungee_in_capacity = std::min(
        static_cast<int>(bungee_in_l_.size()),
        static_cast<int>(bungee_in_r_.size()));
    const double safe_ratio = warp_time_ratio > 0.0 ? warp_time_ratio : 1.0;

    // Bungee consumes ~ceil(output_frames * ratio) input frames per call to
    // produce output_frames of stretched output. For pitch-only (ratio=1)
    // this equals frames_to_read, matching the old pitch-path behaviour.
    const int input_to_feed = std::min(
        bungee_in_capacity,
        static_cast<int>(std::ceil(
            static_cast<double>(cb.frames_to_read) * safe_ratio)));
    if (input_to_feed <= 0) {
        pitch_missing_stream_silence_count_.fetch_add(1, std::memory_order_relaxed);
        return 0;
    }

    // Silent-track gate: keep the voice's source cursor in sync with the
    // timeline (so un-mute resumes at the right position) but skip the
    // expensive grain synthesis.
    if (track_is_silent) {
        bv->reset_source_cursor(bv->source_cursor() + input_to_feed);
        std::fill(scratch_l_.begin(),
                  scratch_l_.begin() + cb.frames_to_read, 0.0f);
        std::fill(scratch_r_.begin(),
                  scratch_r_.begin() + cb.frames_to_read, 0.0f);
        return cb.frames_to_read;
    }

    const int queued = bv->queued_output_frames();
    int feed_frames = queued >= cb.frames_to_read ? 0 : input_to_feed;
    feed_frames = std::min(feed_frames, bungee_in_capacity);

    const double pitch_scale = std::pow(2.0,
        static_cast<double>(effective_semitones) / 12.0);
    const long long latency = static_cast<long long>(bv->latency_frames());
    const int compensation = bv->alignment_compensation_frames(pitch_scale);
    // Read from where the voice last left off. The voice tracks its own
    // source cursor so warp ratios that don't advance the timeline 1:1 stay
    // in sync without the renderer having to re-derive the offset.
    const long long cursor = bv->source_cursor();
    const Frame queued_source_frames = static_cast<Frame>(std::ceil(
        static_cast<double>(queued) * safe_ratio));
    const Frame read_from = static_cast<Frame>(cursor
        + latency + compensation + queued_source_frames);
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
    const auto dsp_t0 = std::chrono::steady_clock::now();
    const int produced = bv->render_block(
        in_ptrs, feed_frames, scratch_, cb.frames_to_read, pitch_scale,
        safe_ratio);
    const auto dsp_us = std::chrono::duration_cast<std::chrono::microseconds>(
        std::chrono::steady_clock::now() - dsp_t0).count();
    const int queued_after = bv->queued_output_frames();

    if (queued > 0 || cb.frames_to_read < feed_frames || safe_ratio != 1.0) {
        track_jump_debug_log(
            "[LT_JUMP_DEBUG][track-renderer] stretched track=%s clip=%s cursor=%lld frames=%d queued_before=%d queued_source=%lld feed=%d input=%d produced=%d queued_after=%d read_from=%lld latency=%lld compensation=%d pitch=%.6f ratio=%.6f dsp_us=%lld\n",
            track_id.c_str(), cb.clip->id.c_str(),
            cursor, cb.frames_to_read, queued,
            static_cast<long long>(queued_source_frames), feed_frames,
            input_to_feed, produced, queued_after,
            static_cast<long long>(read_from), latency, compensation,
            pitch_scale, safe_ratio,
            static_cast<long long>(dsp_us));
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
