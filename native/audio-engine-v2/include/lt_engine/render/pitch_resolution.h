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

} // namespace lt
