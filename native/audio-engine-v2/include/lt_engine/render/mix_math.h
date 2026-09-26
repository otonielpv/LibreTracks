#pragma once

// ---------------------------------------------------------------------------
// mix_math — the per-sample rules of the master bus, shared by the realtime
// Mixer and the offline renderer.
//
// A rendered file has to sound like playback. If the pan law or the limiter
// knee lived in two places they would drift, and nobody would hear it until a
// musician compared an export against the live mix.
// ---------------------------------------------------------------------------

#include <algorithm>
#include <cmath>

namespace lt {

inline float clamp_pan(float pan) noexcept {
    return std::max(-1.0f, std::min(1.0f, pan));
}

// Balance law: the side the pan points away from is attenuated linearly and
// the other stays at unity, so a centred track keeps its level.
inline float pan_left_gain(float pan) noexcept { return pan > 0.0f ? 1.0f - pan : 1.0f; }
inline float pan_right_gain(float pan) noexcept { return pan < 0.0f ? 1.0f + pan : 1.0f; }

// Transparent below 0.98, then a soft knee that never exceeds 0.999.
inline float soft_limit_output(float x) noexcept {
    constexpr float threshold = 0.98f;
    constexpr float ceiling = 0.999f;
    const float ax = std::abs(x);
    if (ax <= threshold)
        return x;
    const float over = ax - threshold;
    const float shaped = threshold
        + (ceiling - threshold) * (over / (over + (ceiling - threshold)));
    return std::copysign(std::min(shaped, ceiling), x);
}

} // namespace lt
