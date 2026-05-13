#include <lt_engine/render/track_renderer.h>
#include <lt_engine/render/pitch_resolution.h>
#include <algorithm>
#include <cstring>
#include <cmath>

namespace lt {

bool TrackRenderer::ensure_scratch_capacity(int frames) noexcept {
    if (frames < 0)
        return false;
    try {
        if (static_cast<int>(scratch_l_.size()) < frames)
            scratch_l_.resize(static_cast<std::size_t>(frames), 0.0f);
        if (static_cast<int>(scratch_r_.size()) < frames)
            scratch_r_.resize(static_cast<std::size_t>(frames), 0.0f);
    } catch (...) {
        scratch_[0] = nullptr;
        scratch_[1] = nullptr;
        return false;
    }
    scratch_[0] = scratch_l_.data();
    scratch_[1] = scratch_r_.data();
    return true;
}

void TrackRenderer::render(const Track&         track,
                            Frame                timeline_frame,
                            int                  block_frames,
                            float**              out,
                            int                  num_out_channels,
                            const SourceManager& sources,
                            PitchCache*          pitch_cache,
                            int                  engine_sample_rate,
                            Semitones            effective_semitones,
                            const Song*          active_song) noexcept {
    if (track.mute) return;

    // Callers set active_semitones to 0 if the track should not be transposed.
    // TrackRenderer itself no longer looks up the active song/region here —
    // that's the Mixer's responsibility; it passes active_semitones down.
    // For now render() has no active_semitones parameter yet; it is forwarded
    // via the existing render() overload below.
    for (const auto& clip : track.clips) {
        Semitones clip_semitones = active_song
            ? resolve_effective_semitones(track, clip, *active_song, timeline_frame)
            : effective_semitones;
        render_clip(clip, timeline_frame, block_frames,
                    track.gain, out, num_out_channels,
                    sources, pitch_cache, engine_sample_rate,
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
                                 PitchCache*          pitch_cache,
                                 int                  engine_sample_rate,
                                 const Id&            track_id,
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
        PitchCacheKey key{clip.source_id, track_id, clip.id,
                          static_cast<double>(effective_semitones),
                          engine_sample_rate, src->channel_count(), "prepared_proxy"};
        if (!pitch_cache) return;

        const Frame proxy_window = std::max<Frame>(
            frames_to_read, static_cast<Frame>(engine_sample_rate / 2));
        const Frame source_remaining = std::max<Frame>(0, src->duration_frames() - source_frame);
        const Frame ready_window = std::min(proxy_window, source_remaining);
        const bool prepared_proxy_can_switch_without_crossfade = false;
        if (prepared_proxy_can_switch_without_crossfade
            && pitch_cache->is_range_ready(key, source_frame, ready_window)) {
            int copied = 0;
            while (copied < frames_to_read) {
                const Frame absolute = source_frame + copied;
                const int block_index = pitch_cache->block_index_for(absolute);
                const int offset = pitch_cache->offset_in_block(absolute);
                const int chunk = std::min(frames_to_read - copied,
                                           PitchCache::kProxyBlockFrames - offset);
                float* chunk_out[2] = {scratch_l_.data() + copied, scratch_r_.data() + copied};
                if (!pitch_cache->get_block_if_ready(key, block_index, offset, chunk, chunk_out, 2)) {
                    const int rendered = pitch_cache->render_realtime_seek_safe(
                        PitchCacheKey{clip.source_id, track_id, clip.id,
                                      static_cast<double>(effective_semitones),
                                      engine_sample_rate, src->channel_count(), "realtime_seek_safe"},
                        *src, absolute, chunk, chunk_out, 2);
                    if (rendered <= 0) {
                        pitch_cache->note_emergency_silence_used();
                        std::fill(chunk_out[0], chunk_out[0] + chunk, 0.0f);
                        std::fill(chunk_out[1], chunk_out[1] + chunk, 0.0f);
                    }
                }
                copied += chunk;
            }
        } else {
            const int rendered = pitch_cache->render_realtime_seek_safe(
                PitchCacheKey{clip.source_id, track_id, clip.id,
                              static_cast<double>(effective_semitones),
                              engine_sample_rate, src->channel_count(), "realtime_seek_safe"},
                *src, source_frame, frames_to_read, scratch_, 2);
            if (rendered <= 0) {
                pitch_cache->note_emergency_silence_used();
                std::fill(scratch_l_.begin(), scratch_l_.begin() + frames_to_read, 0.0f);
                std::fill(scratch_r_.begin(), scratch_r_.begin() + frames_to_read, 0.0f);
            }
        }
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
