#include <lt_engine/render/pitch_resolution.h>
#include <algorithm>
#include <cmath>

namespace lt {

namespace {

// Effective BPM at a frame: latest tempo marker at-or-before frame, else
// song.bpm. Matches the Rust-side `effective_bpm_at` semantics so the warp
// ratio is consistent across the FFI boundary.
double effective_bpm_at_frame(const Song& song, Frame frame) noexcept {
    double bpm = song.bpm;
    Frame best = std::numeric_limits<Frame>::min();
    for (const auto& marker : song.tempo_markers) {
        if (marker.frame <= frame && marker.frame > best) {
            best = marker.frame;
            bpm = marker.bpm;
        }
    }
    return bpm;
}

} // namespace

const Region* region_at_frame(const Song& song, Frame frame) noexcept {
    for (const auto& r : song.regions) {
        if (frame >= r.start_frame && frame < r.end_frame)
            return &r;
    }
    return nullptr;
}

Semitones clamp_supported_semitones(Semitones semitones) noexcept {
    return std::max(kMinSupportedPitchSemitones,
                    std::min(kMaxSupportedPitchSemitones, semitones));
}

Semitones resolve_region_transpose(const Song& song, Frame timeline_frame) noexcept {
    for (const auto& region : song.regions) {
        if (timeline_frame >= region.start_frame && timeline_frame < region.end_frame)
            return region.transpose_semitones;
    }
    return song.transpose_semitones;
}

Semitones resolve_effective_semitones(const Track& track,
                                      const Clip& clip,
                                      const Song& song,
                                      Frame timeline_frame) noexcept {
    if (track.transpose_behavior == TransposeBehavior::NeverTranspose)
        return 0;
    return clamp_supported_semitones(resolve_region_transpose(song, timeline_frame) + clip.semitones);
}

PitchRenderDecision resolve_pitch_render_decision(
    const Track& track, const Clip& clip, const Song& song, Frame timeline_frame) noexcept {
    PitchRenderDecision d;
    const bool never_transpose =
        track.transpose_behavior == TransposeBehavior::NeverTranspose;
    if (never_transpose) {
        d.is_never_transpose = true;
        // Pitch stays at 0 (NeverTranspose tracks ignore the song/region
        // transpose), but warp is a song-level concept: enabling warp on a
        // region must time-stretch every overlapping clip regardless of
        // whether the track lets the user pitch it. Fall through to compute
        // warp_active below with effective_semitones still 0.
    } else {
        d.effective_semitones = clamp_supported_semitones(
            resolve_region_transpose(song, timeline_frame) + clip.semitones);
        d.needs_pitch = (d.effective_semitones != 0);
    }

    const double ratio = resolve_warp_time_ratio(song, timeline_frame);
    if (ratio > 0.0 && ratio != 1.0) {
        d.warp_active = true;
        d.warp_time_ratio = ratio;
    }

    // Resolve the rendering path. The four cases are mutually exclusive.
    if (d.warp_active && d.needs_pitch)
        d.path = ClipPathKind::Cascade;
    else if (d.warp_active)
        d.path = ClipPathKind::Warp;
    else if (d.needs_pitch)
        d.path = ClipPathKind::Pitch;
    else
        d.path = ClipPathKind::Direct;
    return d;
}

double resolve_warp_time_ratio(const Song& song, Frame timeline_frame) noexcept {
    const Region* region = region_at_frame(song, timeline_frame);
    if (!region) return 1.0;
    if (!region->warp_enabled) return 1.0;
    const double source = region->warp_source_bpm;
    if (!(source > 0.0) || !std::isfinite(source)) return 1.0;
    const double target = effective_bpm_at_frame(song, region->start_frame);
    if (!(target > 0.0) || !std::isfinite(target)) return 1.0;
    return target / source;
}

} // namespace lt
