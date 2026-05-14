#pragma once

#include <lt_engine/core/types.h>
#include <lt_engine/session/session.h>

namespace lt {

constexpr Semitones kMinSupportedPitchSemitones = -12;
constexpr Semitones kMaxSupportedPitchSemitones = 12;

Semitones clamp_supported_semitones(Semitones semitones) noexcept;
Semitones resolve_region_transpose(const Song& song, Frame timeline_frame) noexcept;
Semitones resolve_effective_semitones(const Track& track,
                                      const Clip& clip,
                                      const Song& song,
                                      Frame timeline_frame) noexcept;

// Canonical pitch resolution decision — call once per clip per render block.
// Encodes whether pitch processing is needed and which semitone value to use.
struct PitchRenderDecision {
    Semitones effective_semitones = 0;  // 0 = no pitch shift needed
    bool needs_pitch = false;           // true if this clip should go through pitch engine
    bool is_never_transpose = false;    // track has NeverTranspose behavior
};

// Returns the authoritative pitch decision for a clip at a given timeline position.
// Use this everywhere instead of calling resolve_effective_semitones directly so that
// TrackRenderer, Mixer, and RealtimePitchEngine always agree on the semitone key.
PitchRenderDecision resolve_pitch_render_decision(
    const Track& track, const Clip& clip, const Song& song, Frame timeline_frame) noexcept;

} // namespace lt
