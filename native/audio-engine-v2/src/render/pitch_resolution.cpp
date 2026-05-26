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
    const Semitones full = clamp_supported_semitones(
        resolve_region_transpose(song, timeline_frame) + clip.semitones);
    // NeverTranspose suppresses pitch whenever the region is in warp mode,
    // even if the current BPM makes the ratio exactly 1.0. Warp mode
    // decouples pitch from duration, so the track can ignore the semitone
    // shift while still following the shared timeline.
    if (track.transpose_behavior == TransposeBehavior::NeverTranspose) {
        const Region* region = region_at_frame(song, timeline_frame);
        if (region && region->warp_enabled && region->warp_source_bpm > 0.0)
            return 0;
    }
    return full;
}

PitchRenderDecision resolve_pitch_render_decision(
    const Track& track, const Clip& clip, const Song& song, Frame timeline_frame) noexcept {
    PitchRenderDecision d;

    const Region* region = region_at_frame(song, timeline_frame);
    const bool warp_mode_active =
        region && region->warp_enabled && region->warp_source_bpm > 0.0;
    const double ratio = resolve_warp_time_ratio(song, timeline_frame);
    if (warp_mode_active) {
        d.warp_active = true;
        d.warp_time_ratio = ratio > 0.0 && std::isfinite(ratio) ? ratio : 1.0;
    }

    const bool never_transpose =
        track.transpose_behavior == TransposeBehavior::NeverTranspose;
    d.is_never_transpose = never_transpose;

    // Pitch is ignored only when NeverTranspose AND warp is active. Under
    // varispeed (no warp), NeverTranspose tracks still time-stretch so the
    // grid stays aligned — they just don't gain a pitch shift on top, but
    // since varispeed *is* time-stretch driven by pitch_scale, the duration
    // matches even when the audible pitch is preserved by reading the source
    // at the same advance rate without semitone shift would desync. The
    // simplest coherent behaviour: under no-warp, NeverTranspose follows the
    // region's transpose like everyone else.
    if (never_transpose && d.warp_active) {
        // Warp absorbs duration; ignore pitch safely.
        d.effective_semitones = 0;
        d.needs_pitch = false;
    } else {
        d.effective_semitones = clamp_supported_semitones(
            resolve_region_transpose(song, timeline_frame) + clip.semitones);
        d.needs_pitch = (d.effective_semitones != 0);
    }

    d.pitch_scale = std::pow(2.0,
        static_cast<double>(d.effective_semitones) / 12.0);

    // Ableton-style selection:
    //   - warp on → Bungee (preserves duration, decouples pitch from speed)
    //   - warp off + pitch → Varispeed (pitch changes speed; no Bungee voice)
    //   - otherwise → Direct
    if (d.warp_active) {
        d.path = ClipPathKind::Stretched;
    } else if (d.needs_pitch) {
        d.path = ClipPathKind::Varispeed;
    } else {
        d.path = ClipPathKind::Direct;
    }
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
