#include <lt_engine/render/track_renderer.h>
#include <lt_engine/render/pitch_resolution.h>
#include <lt_engine/pitch/bungee_voice_manager.h>
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
        // Bungee planar input scratch. Sized 4x the output block to give
        // warp room to feed Bungee `ceil(block * ratio)` input frames per
        // call without truncation. The warp ratio is clamped to [0.25, 4.0]
        // upstream so this is sufficient.
        const int max_bungee_in = max_block_frames * 4;
        if (static_cast<int>(bungee_in_l_.size()) < max_bungee_in)
            bungee_in_l_.resize(static_cast<std::size_t>(max_bungee_in), 0.0f);
        if (static_cast<int>(bungee_in_r_.size()) < max_bungee_in)
            bungee_in_r_.resize(static_cast<std::size_t>(max_bungee_in), 0.0f);
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
        pitch_missing_stream_silence_count_.load(std::memory_order_relaxed)};
}

void TrackRenderer::reset_diagnostics() noexcept {
    prepare_count_.store(0, std::memory_order_relaxed);
    scratch_resize_count_.store(0, std::memory_order_relaxed);
    scratch_resize_in_audio_thread_count_.store(0, std::memory_order_relaxed);
    block_too_large_count_.store(0, std::memory_order_relaxed);
    max_scratch_capacity_frames_.store(0, std::memory_order_relaxed);
    pitch_missing_stream_silence_count_.store(0, std::memory_order_relaxed);
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

void TrackRenderer::render(const Track&         track,
                            Frame                timeline_frame,
                            int                  block_frames,
                            float**              out,
                            int                  num_out_channels,
                            const SourceManager& sources,
                            BungeeVoiceManager*  bungee_voices,
                            int                  engine_sample_rate,
                            Semitones            effective_semitones,
                            const Song*          active_song) noexcept {
    if (track.mute) return;

    // Compute the authoritative pitch decision per clip using the canonical helper.
    // When active_song is provided, the per-clip decision is resolved from it;
    // otherwise fall back to the caller-provided effective_semitones value.
    for (const auto& clip : track.clips) {
        Semitones clip_semitones;
        bool clip_warp_active = false;
        double clip_warp_ratio = 1.0;
        if (active_song) {
            const auto decision = resolve_pitch_render_decision(track, clip, *active_song, timeline_frame);
            clip_semitones = decision.effective_semitones;
            clip_warp_active = decision.warp_active;
            clip_warp_ratio = decision.warp_time_ratio;
        } else {
            clip_semitones = effective_semitones;
        }
        render_clip(clip, timeline_frame, block_frames,
                    track.gain, out, num_out_channels,
                    sources, bungee_voices, engine_sample_rate,
                    track.id, clip_semitones,
                    clip_warp_active, clip_warp_ratio);
    }
}

void TrackRenderer::render_clip(const Clip&          clip,
                                 Frame                timeline_frame,
                                 int                  block_frames,
                                 float                track_gain,
                                 float**              out,
                                 int                  num_out_channels,
                                 const SourceManager& sources,
                                 BungeeVoiceManager*  bungee_voices,
                                 int                  engine_sample_rate,
                                 const Id&            track_id,
                                 Semitones            effective_semitones,
                                 bool                 warp_active,
                                 double               warp_time_ratio) noexcept {
    // Does this clip overlap the current block?
    Frame clip_end = clip.timeline_start_frame + clip.length_frames;
    if (timeline_frame >= clip_end)                        return;
    if (timeline_frame + block_frames <= clip.timeline_start_frame) return;

    const DecodedSource* src = sources.get(clip.source_id);
    if (!src || !src->is_loaded()) return;

    // Clamp to the portion of this block that overlaps the clip.
    int block_offset = 0;
    Frame source_frame = clip.source_start_frame;

    const bool warp_enabled = warp_active && warp_time_ratio > 0.0
                              && warp_time_ratio != 1.0;
    const double effective_ratio = warp_enabled ? warp_time_ratio : 1.0;

    if (timeline_frame < clip.timeline_start_frame) {
        block_offset  = static_cast<int>(clip.timeline_start_frame - timeline_frame);
        source_frame  = clip.source_start_frame;
    } else {
        // Under warp the source cursor advances `ratio` times faster (or
        // slower) than the timeline. Bungee consumes `ceil(out * ratio)`
        // input frames per block (set below via render_block's time_ratio),
        // so the source pointer we hand it must advance in lockstep — else
        // we re-read frames Bungee already consumed and the audio appears
        // unchanged in speed even though Bungee is internally stretching.
        const Frame timeline_offset = timeline_frame - clip.timeline_start_frame;
        const Frame source_offset = warp_enabled
            ? static_cast<Frame>(static_cast<double>(timeline_offset) * effective_ratio)
            : timeline_offset;
        source_frame = clip.source_start_frame + source_offset;
    }

    int frames_to_read = block_frames - block_offset;
    frames_to_read = std::min(frames_to_read,
                               static_cast<int>(clip_end - (timeline_frame + block_offset)));
    if (frames_to_read <= 0) return;
    if (!ensure_scratch_capacity(frames_to_read)) return;

    // Read into scratch (always 2-ch).
    std::fill(scratch_l_.begin(), scratch_l_.begin() + frames_to_read, 0.f);
    std::fill(scratch_r_.begin(), scratch_r_.begin() + frames_to_read, 0.f);

    if (effective_semitones != 0 || warp_enabled) {
        // Pitch processing required — NEVER fall back to original audio on failure.
        // Instead, count the miss and return silence for this block. Bungee is
        // the sole pitch backend; voices are keyed per-clip and persist across
        // pitch changes, with the current effective semitones driving Bungee's
        // per-grain Request::pitch parameter so live transpose changes are
        // gapless. When no voice exists for the clip (e.g. control thread
        // hasn't built one yet, track is NeverTranspose, Bungee unavailable),
        // we silence the block and bump the miss counter — the control thread
        // path that builds voices is responsible for healing this.
        int rendered = 0;

        std::shared_ptr<BungeePitchVoice> bv;
        if (bungee_voices)
            bv = bungee_voices->voice_for_shared(clip.id);
        if (bv) {
            // Fetch planar source audio into the Bungee input scratch.
            // The render scratch (scratch_l_/scratch_r_) is reserved for output.
            const int queued = bv->queued_output_frames();
            const int bungee_in_capacity = std::min(
                static_cast<int>(bungee_in_l_.size()),
                static_cast<int>(bungee_in_r_.size()));
            // Legacy behaviour without warp: feed exactly `frames_to_read`
            // (one block). With warp we feed `ceil(out * ratio)` so Bungee's
            // input cursor advances `ratio` times the output it produces.
            //
            // Earlier we capped at scratch_capacity_frames_, which inflated
            // the feed size for the no-warp pitch path and confused Bungee's
            // analysis pipeline (a single 4096-frame feed every 4 callbacks
            // instead of 512 per callback). Stick to the legacy size when
            // warp is inactive.
            int desired_feed = warp_enabled
                ? static_cast<int>(std::ceil(
                    static_cast<double>(frames_to_read) * effective_ratio))
                : frames_to_read;
            desired_feed = std::min(desired_feed, bungee_in_capacity);
            const int max_feed = desired_feed;
            const int feed_frames = queued >= frames_to_read ? 0 : max_feed;
            // Per Bungee issue #38: the output we get back from process()
            // corresponds to input frame outputPosition() == inputPosition()
            // - latency(). To make the listener hear audio that aligns to
            // `source_frame` we have to feed input from source_frame +
            // latency() plus Bungee's residual transient compensation forward.
            // Both values are reported in input-rate frames; at speed=1 that
            // is just source-frame units. queued_output_frames() is already
            // future output produced from earlier input, so new source reads
            // start after that queued audio to keep partial post-jump renders
            // continuous.
            const double pitch_scale = std::pow(2.0,
                static_cast<double>(effective_semitones) / 12.0);
            const long long latency = static_cast<long long>(bv->latency_frames());
            const int compensation = bv->alignment_compensation_frames(pitch_scale);
            const Frame read_from = source_frame
                + static_cast<Frame>(latency)
                + static_cast<Frame>(compensation)
                + static_cast<Frame>(queued);
            const Frame src_end   = src->duration_frames();
            // How many of `feed_frames` frames are actually available in the source
            // starting at `read_from`? Anything past src_end is padded with
            // silence (clip end / past end of file).
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
                bungee_in_r_.data() + dst_offset};
            int got = 0;
            if (available > 0) {
                got = src->read(read_start, available, read_into,
                                std::min(2, src->channel_count()));
                if (got > 0 && src->channel_count() == 1) {
                    // Mono source: mirror L into R so Bungee gets stereo.
                    std::copy_n(bungee_in_l_.begin() + dst_offset, got,
                                bungee_in_r_.begin() + dst_offset);
                }
            }
            // Pad any short read or tail-after-source-end with zeros so we
            // always feed Bungee exactly `feed_frames` input frames per call.
            // this keeps Bungee's inputPosition advancing in lockstep with
            // the audio thread's frame counter regardless of clip bounds.
            if (dst_offset + got < feed_frames) {
                std::fill(bungee_in_l_.begin() + std::max(0, dst_offset + got),
                          bungee_in_l_.begin() + feed_frames, 0.0f);
                std::fill(bungee_in_r_.begin() + std::max(0, dst_offset + got),
                          bungee_in_r_.begin() + feed_frames, 0.0f);
            }
            const float* in_ptrs[2] = {bungee_in_l_.data(), bungee_in_r_.data()};
            const int produced = bv->render_block(
                in_ptrs, feed_frames, scratch_, frames_to_read, pitch_scale,
                effective_ratio);
            const int queued_after = bv->queued_output_frames();
            if (queued > 0 || frames_to_read < max_feed) {
                track_jump_debug_log(
                    "[LT_JUMP_DEBUG][track-renderer] pitched track=%s clip=%s source_frame=%lld frames=%d queued_before=%d feed_frames=%d produced=%d queued_after=%d read_from=%lld latency=%lld compensation=%d pitch_scale=%.9f got=%d available=%d\n",
                    track_id.c_str(),
                    clip.id.c_str(),
                    static_cast<long long>(source_frame),
                    frames_to_read,
                    queued,
                    feed_frames,
                    produced,
                    queued_after,
                    static_cast<long long>(read_from),
                    latency,
                    compensation,
                    pitch_scale,
                    got,
                    available);
            }

            // CRITICAL: the audio thread always advances by `frames_to_read` frames
            // per callback. Bungee's Stream::process may return fewer output
            // frames than requested (e.g. during the analysis-pipeline warm-up
            // window, or whenever grain boundaries don't line up). If we
            // reported the actual `produced` count downstream, the transposed
            // clip would write fewer frames into the mix bus while the timeline
            // still advances by `frames_to_read`, causing transposed tracks to lag
            // non-transposed ones by the accumulated gap. To keep timeline
            // alignment we zero-pad the tail and report `frames_to_read` instead.
            if (produced < frames_to_read) {
                std::fill(scratch_l_.begin() + std::max(0, produced),
                          scratch_l_.begin() + frames_to_read, 0.0f);
                std::fill(scratch_r_.begin() + std::max(0, produced),
                          scratch_r_.begin() + frames_to_read, 0.0f);
            }
            rendered = frames_to_read;
        } else {
            // No Bungee voice available for this clip — count as missing
            // and return silence. The control-thread voice-build path
            // (BungeeVoiceManager::rebuild_for_session / rebuild_for_seek)
            // is responsible for healing this on subsequent blocks.
            pitch_missing_stream_silence_count_.fetch_add(1, std::memory_order_relaxed);
            return;
        }
        if (rendered <= 0) {
            pitch_missing_stream_silence_count_.fetch_add(1, std::memory_order_relaxed);
            return;
        }
        frames_to_read = rendered;
        (void)engine_sample_rate;
    } else {
        float* read_into[2] = {scratch_l_.data(), scratch_r_.data()};
        const int copied = src->read(source_frame, frames_to_read, read_into, 2);
        if (copied <= 0)
            return;
        if (copied < frames_to_read) {
            std::fill(scratch_l_.begin() + copied,
                      scratch_l_.begin() + frames_to_read, 0.0f);
            std::fill(scratch_r_.begin() + copied,
                      scratch_r_.begin() + frames_to_read, 0.0f);
        }
    }
    int read = frames_to_read;

    float effective_gain = track_gain * clip.gain;

    // Apply fade-in.
    if (clip.fade_in_frames > 0) {
        Frame played = source_frame - clip.source_start_frame;
        for (int f = 0; f < read; ++f) {
            Frame pos = played + f;
            if (pos < clip.fade_in_frames) {
                float g = static_cast<float>(pos) / clip.fade_in_frames;
                scratch_l_[static_cast<std::size_t>(f)] *= g;
                scratch_r_[static_cast<std::size_t>(f)] *= g;
            }
        }
    }

    // Apply fade-out.
    if (clip.fade_out_frames > 0) {
        Frame played = source_frame - clip.source_start_frame;
        for (int f = 0; f < read; ++f) {
            Frame pos = played + f;
            Frame from_end = clip.length_frames - pos;
            if (from_end < clip.fade_out_frames && from_end >= 0) {
                float g = static_cast<float>(from_end) / clip.fade_out_frames;
                scratch_l_[static_cast<std::size_t>(f)] *= g;
                scratch_r_[static_cast<std::size_t>(f)] *= g;
            }
        }
    }

    // Accumulate into output mix bus.
    float* dst_l = out[0] + block_offset;
    float* dst_r = (num_out_channels >= 2) ? out[1] + block_offset : nullptr;

    for (int f = 0; f < read; ++f) {
        dst_l[f] += scratch_l_[static_cast<std::size_t>(f)] * effective_gain;
        if (dst_r) dst_r[f] += scratch_r_[static_cast<std::size_t>(f)] * effective_gain;
    }
}

} // namespace lt
