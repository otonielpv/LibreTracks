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
// Encodes whether pitch processing is needed and which semitone value to use,
// plus whether the region's warp engine should be applied. A clip routes
// through Bungee when `needs_pitch || warp_active` is true.
struct PitchRenderDecision {
    Semitones effective_semitones = 0;  // 0 = no pitch shift needed
    bool needs_pitch = false;           // true if this clip should go through pitch engine
    bool is_never_transpose = false;    // track has NeverTranspose behavior
    // Warp: when true, the clip is inside a region whose warp_enabled is set
    // and whose source/target BPMs produce a non-unity ratio. The renderer
    // must route the clip through Bungee with the given time_ratio even when
    // effective_semitones is 0.
    bool   warp_active = false;
    double warp_time_ratio = 1.0;
};

// Returns the authoritative pitch decision for a clip at a given timeline position.
// Use this everywhere instead of calling resolve_effective_semitones directly so that
// TrackRenderer, Mixer, and RealtimePitchEngine always agree on the semitone key.
PitchRenderDecision resolve_pitch_render_decision(
    const Track& track, const Clip& clip, const Song& song, Frame timeline_frame) noexcept;

// Compute the time_ratio Bungee should use for a clip at `timeline_frame`
// based on the region's warp settings and the song's effective tempo at the
// region start. Returns 1.0 (= no warp) when warp is disabled, when the
// source BPM is missing/invalid, or when no region covers `timeline_frame`.
double resolve_warp_time_ratio(const Song& song, Frame timeline_frame) noexcept;

// First region in `song` whose [start_frame, end_frame) contains `frame`,
// or nullptr if no region covers it. Linear scan — regions are typically a
// handful per song. Used by the voice manager to find every clip that needs
// a Bungee voice prepared because it sits inside the same warp-active
// region as the playhead.
const Region* region_at_frame(const Song& song, Frame frame) noexcept;

} // namespace lt
