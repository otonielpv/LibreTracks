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
#include <cstdint>
#include <cstring>

namespace lt {

inline float clamp_pan(float pan) noexcept {
    return std::max(-1.0f, std::min(1.0f, pan));
}

// Balance law: the side the pan points away from is attenuated linearly and
// the other stays at unity, so a centred track keeps its level.
inline float pan_left_gain(float pan) noexcept { return pan > 0.0f ? 1.0f - pan : 1.0f; }
inline float pan_right_gain(float pan) noexcept { return pan < 0.0f ? 1.0f + pan : 1.0f; }

// Transparent below 0.98, then a soft knee that never exceeds 0.999.
//
// NaN and ±Inf come out as 0. Before, both went straight to the device:
// NaN fails `ax <= threshold`, and std::min(NaN, ceiling) returns NaN (Inf
// turned into NaN via inf/inf). Depending on the driver that is silence or a
// full-scale bang in the musicians' in-ears. The check lives on the slow branch
// only, so a normal sample pays nothing for it.
inline float soft_limit_output(float x) noexcept {
    constexpr float threshold = 0.98f;
    constexpr float ceiling = 0.999f;
    const float ax = std::abs(x);
    if (ax <= threshold)
        return x;
    if (!std::isfinite(x))
        return 0.0f;
    const float over = ax - threshold;
    const float shaped = threshold
        + (ceiling - threshold) * (over / (over + (ceiling - threshold)));
    return std::copysign(std::min(shaped, ceiling), x);
}

// Zeroes a track buffer that contains any NaN or ±Inf and returns true; leaves
// a healthy buffer untouched (bit for bit) and returns false.
//
// One bad sample summed into the bus makes the whole mix NaN, and a NaN in a
// meter or a folder accumulator sticks. LMMS sanitises each effect and bus the
// same way. The test reads the exponent bits (all ones = NaN or Inf) and ORs
// them, an integer reduction the compiler vectorises without fast-math, so the
// healthy case costs one pass over a buffer that is already in cache.
inline bool has_non_finite(const float* buffer, int frames) noexcept {
    if (!buffer || frames <= 0)
        return false;
    std::uint32_t bad = 0;
    for (int i = 0; i < frames; ++i) {
        std::uint32_t bits;
        std::memcpy(&bits, &buffer[i], sizeof bits);
        bad |= static_cast<std::uint32_t>((bits & 0x7f800000u) == 0x7f800000u);
    }
    return bad != 0;
}

inline bool sanitize_non_finite(float* buffer, int frames) noexcept {
    if (!has_non_finite(buffer, frames))
        return false;
    std::fill(buffer, buffer + frames, 0.0f);
    return true;
}

} // namespace lt
