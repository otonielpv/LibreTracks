#include <lt_engine/render/pitch_resolution.h>
#include <algorithm>

namespace lt {

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

} // namespace lt
