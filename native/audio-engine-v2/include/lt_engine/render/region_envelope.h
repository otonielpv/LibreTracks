#pragma once

// Song-master envelope: the per-song master gain times the song's fade in and
// fade out, sample by sample.
//
// Shared by the real-time mixer and the offline renderer so a render sounds
// exactly like playback. Header-only, no allocation, no locks: safe on the
// audio thread.
//
// The fades are positional, like clip fades: the gain depends on where the
// timeline frame sits inside the region, not on when playback started. A jump
// into the middle of a song is past the fade in and plays at full level;
// starting right at the song's first frame plays the fade in. Linear, the same
// curve as clip fades.

#include <algorithm>
#include <cmath>

#include <lt_engine/session/session.h>

namespace lt {

/// Frames processed per envelope chunk. Callers keep a scratch buffer of this
/// size and walk longer blocks chunk by chunk.
inline constexpr int kRegionEnvelopeChunk = 256;

/// The region whose [start, end) contains `frame`, or nullptr in a gap.
inline const Region* region_at_frame(const Session& session, Frame frame) noexcept {
    for (const auto& song : session.songs)
        for (const auto& region : song.regions)
            if (frame >= region.start_frame && frame < region.end_frame)
                return &region;
    return nullptr;
}

/// Envelope value at `frame` inside `region`.
inline float region_gain_at_frame(const Region& region, Frame frame) noexcept {
    float gain = region.master_gain;
    if (region.fade_in_frames > 0) {
        const Frame from_start = frame - region.start_frame;
        if (from_start < region.fade_in_frames)
            gain *= static_cast<float>(std::max<Frame>(0, from_start))
                / static_cast<float>(region.fade_in_frames);
    }
    if (region.fade_out_frames > 0) {
        // Distance to the region's last frame, so the final sample lands on 0.
        const Frame to_end = region.end_frame - 1 - frame;
        if (to_end < region.fade_out_frames)
            gain *= static_cast<float>(std::max<Frame>(0, to_end))
                / static_cast<float>(region.fade_out_frames);
    }
    return gain;
}

/// Fill `gains[0..count)` with the envelope from `start_frame` on. `count` must
/// be <= kRegionEnvelopeChunk. Frames outside every region get unity. Returns
/// true when every value is unity, so the caller can skip the multiply.
inline bool fill_region_envelope(const Session& session,
                                 Frame start_frame,
                                 int count,
                                 float* gains) noexcept {
    bool unity = true;
    const Region* region = region_at_frame(session, start_frame);
    for (int f = 0; f < count; ++f) {
        const Frame frame = start_frame + f;
        // Re-resolve only on crossing a region boundary (or leaving a gap).
        if (!region || frame >= region->end_frame || frame < region->start_frame)
            region = region_at_frame(session, frame);
        const float gain = region ? region_gain_at_frame(*region, frame) : 1.0f;
        gains[f] = gain;
        if (std::abs(gain - 1.0f) > 0.000001f)
            unity = false;
    }
    return unity;
}

} // namespace lt
