#include <lt_engine/render/track_renderer.h>
#include <algorithm>
#include <cstring>
#include <cmath>

namespace lt {

void TrackRenderer::render(const Track&         track,
                            Frame                timeline_frame,
                            int                  block_frames,
                            float**              out,
                            int                  num_out_channels,
                            const SourceManager& sources,
                            PitchCache*          pitch_cache,
                            int                  engine_sample_rate) noexcept {
    if (track.mute) return;

    // Callers set active_semitones to 0 if the track should not be transposed.
    // TrackRenderer itself no longer looks up the active song/region here —
    // that's the Mixer's responsibility; it passes active_semitones down.
    // For now render() has no active_semitones parameter yet; it is forwarded
    // via the existing render() overload below.
    for (const auto& clip : track.clips) {
        render_clip(clip, timeline_frame, block_frames,
                    track.gain, out, num_out_channels,
                    sources, pitch_cache, engine_sample_rate);
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
                                 int                  engine_sample_rate) noexcept {
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

    // Read into scratch (always 2-ch).
    std::fill(scratch_l_, scratch_l_ + frames_to_read, 0.f);
    std::fill(scratch_r_, scratch_r_ + frames_to_read, 0.f);

    int read = src->read(source_frame, frames_to_read, scratch_, 2);
    if (read <= 0) return;

    // Apply pitch shifting if a cache is provided and the clip has a non-zero pitch.
    // The active semitones are stored on the clip (resolved by the session adapter
    // from Song/Region transpose_semitones before the session is handed to the engine).
    if (pitch_cache && clip.semitones != 0.0) {
        PitchProcessor* proc = pitch_cache->get_or_create(
            clip.source_id, clip.semitones,
            engine_sample_rate, src->channel_count());
        if (proc) {
            // Latency compensation: source was read shifted back by latency_frames()
            // already (handled in the read offset below if proc is available).
            proc->process(scratch_, 2, read);
        }
    }

    float effective_gain = track_gain * clip.gain;

    // Apply fade-in.
    if (clip.fade_in_frames > 0) {
        Frame played = source_frame - clip.source_start_frame;
        for (int f = 0; f < read; ++f) {
            Frame pos = played + f;
            if (pos < clip.fade_in_frames) {
                float g = static_cast<float>(pos) / clip.fade_in_frames;
                scratch_l_[f] *= g;
                scratch_r_[f] *= g;
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
                scratch_l_[f] *= g;
                scratch_r_[f] *= g;
            }
        }
    }

    // Accumulate into output mix bus.
    float* dst_l = out[0] + block_offset;
    float* dst_r = (num_out_channels >= 2) ? out[1] + block_offset : nullptr;

    for (int f = 0; f < read; ++f) {
        dst_l[f] += scratch_l_[f] * effective_gain;
        if (dst_r) dst_r[f] += scratch_r_[f] * effective_gain;
    }
}

} // namespace lt
