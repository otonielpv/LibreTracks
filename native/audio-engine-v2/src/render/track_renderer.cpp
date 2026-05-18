#include <lt_engine/render/track_renderer.h>
#include <lt_engine/render/pitch_resolution.h>
#include <lt_engine/pitch/bungee_voice_manager.h>
#include <algorithm>
#include <cstring>
#include <cmath>

namespace lt {

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
        // Bungee planar input scratch, sized to match the output scratch.
        if (static_cast<int>(bungee_in_l_.size()) < max_block_frames)
            bungee_in_l_.resize(static_cast<std::size_t>(max_block_frames), 0.0f);
        if (static_cast<int>(bungee_in_r_.size()) < max_block_frames)
            bungee_in_r_.resize(static_cast<std::size_t>(max_block_frames), 0.0f);
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
        if (active_song) {
            const auto decision = resolve_pitch_render_decision(track, clip, *active_song, timeline_frame);
            clip_semitones = decision.effective_semitones;
        } else {
            clip_semitones = effective_semitones;
        }
        render_clip(clip, timeline_frame, block_frames,
                    track.gain, out, num_out_channels,
                    sources, bungee_voices, engine_sample_rate,
                    track.id, clip_semitones);
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
                                 const Id&            /*track_id*/,
                                 Semitones            effective_semitones) noexcept {
    // Does this clip overlap the current block?
    Frame clip_end = clip.timeline_start_frame + clip.length_frames;
    if (timeline_frame >= clip_end)                        return;
    if (timeline_frame + block_frames <= clip.timeline_start_frame) return;

    const DecodedSource* src = sources.get(clip.source_id);
    if (!src || !src->is_loaded()) return;

    // Clamp to the portion of this block that overlaps the clip.
    int block_offset = 0;
    Frame source_frame = clip.source_start_frame;

    if (timeline_frame < clip.timeline_start_frame) {
        block_offset  = static_cast<int>(clip.timeline_start_frame - timeline_frame);
        source_frame  = clip.source_start_frame;
    } else {
        source_frame  = clip.source_start_frame + (timeline_frame - clip.timeline_start_frame);
    }

    int frames_to_read = block_frames - block_offset;
    frames_to_read = std::min(frames_to_read,
                               static_cast<int>(clip_end - (timeline_frame + block_offset)));
    if (frames_to_read <= 0) return;
    if (!ensure_scratch_capacity(frames_to_read)) return;

    // Read into scratch (always 2-ch).
    std::fill(scratch_l_.begin(), scratch_l_.begin() + frames_to_read, 0.f);
    std::fill(scratch_r_.begin(), scratch_r_.begin() + frames_to_read, 0.f);

    if (effective_semitones != 0) {
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
            const int max_in = std::min({frames_to_read,
                                         static_cast<int>(bungee_in_l_.size()),
                                         static_cast<int>(bungee_in_r_.size())});
            // Per Bungee issue #38: the output we get back from process()
            // corresponds to input frame outputPosition() == inputPosition()
            // - latency(). To make the listener hear audio that aligns to
            // `source_frame` we have to feed input from source_frame +
            // latency() forward. Latency is reported in input-rate frames; at
            // speed=1 that is just source-frame units.
            const long long latency = static_cast<long long>(bv->latency_frames());
            const Frame read_from = source_frame + static_cast<Frame>(latency);
            const Frame src_end   = src->duration_frames();
            // How many of `max_in` frames are actually available in the source
            // starting at `read_from`? Anything past src_end is padded with
            // silence (clip end / past end of file).
            const int available = (read_from >= src_end)
                ? 0
                : static_cast<int>(std::min<long long>(
                                       max_in,
                                       static_cast<long long>(src_end - read_from)));
            float* read_into[2] = {bungee_in_l_.data(), bungee_in_r_.data()};
            int got = 0;
            if (available > 0) {
                got = src->read(read_from, available, read_into,
                                std::min(2, src->channel_count()));
                if (got > 0 && src->channel_count() == 1) {
                    // Mono source: mirror L into R so Bungee gets stereo.
                    std::copy_n(bungee_in_l_.begin(), got, bungee_in_r_.begin());
                }
            }
            // Pad any short read or tail-after-source-end with zeros so we
            // always feed Bungee exactly `max_in` input frames per call —
            // this keeps Bungee's inputPosition advancing in lockstep with
            // the audio thread's frame counter regardless of clip bounds.
            if (got < max_in) {
                std::fill(bungee_in_l_.begin() + std::max(0, got),
                          bungee_in_l_.begin() + max_in, 0.0f);
                std::fill(bungee_in_r_.begin() + std::max(0, got),
                          bungee_in_r_.begin() + max_in, 0.0f);
            }
            const float* in_ptrs[2] = {bungee_in_l_.data(), bungee_in_r_.data()};
            const double pitch_scale = std::pow(2.0,
                static_cast<double>(effective_semitones) / 12.0);
            const int produced = bv->render_block(
                in_ptrs, max_in, scratch_, max_in, pitch_scale);

            // CRITICAL: the audio thread always advances by `max_in` frames
            // per callback. Bungee's Stream::process may return fewer output
            // frames than requested (e.g. during the analysis-pipeline warm-up
            // window, or whenever grain boundaries don't line up). If we
            // reported the actual `produced` count downstream, the transposed
            // clip would write fewer frames into the mix bus while the timeline
            // still advances by `max_in`, causing transposed tracks to lag
            // non-transposed ones by the accumulated gap. To keep timeline
            // alignment we zero-pad the tail and report `max_in` instead.
            if (produced < max_in) {
                std::fill(scratch_l_.begin() + std::max(0, produced),
                          scratch_l_.begin() + max_in, 0.0f);
                std::fill(scratch_r_.begin() + std::max(0, produced),
                          scratch_r_.begin() + max_in, 0.0f);
            }
            rendered = max_in;
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
        int copied = 0;
        while (copied < frames_to_read) {
            const Frame absolute = source_frame + copied;
            const int block_index = original_cache_.block_index_for(absolute);
            const int offset = original_cache_.offset_in_block(absolute);
            const int chunk = std::min(frames_to_read - copied,
                                       original_cache_.block_frames() - offset);
            if (!original_cache_.is_block_ready(clip.source_id, block_index))
                original_cache_.request_block(clip.source_id, *src, block_index);
            float* chunk_out[2] = {scratch_l_.data() + copied, scratch_r_.data() + copied};
            if (!original_cache_.get_block_if_ready(clip.source_id, block_index, offset, chunk, chunk_out, 2))
                return;
            copied += chunk;
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
