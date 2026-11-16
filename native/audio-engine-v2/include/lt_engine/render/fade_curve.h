#pragma once

#include <algorithm>
#include <cmath>

namespace lt::render {

// Gain of a clip fade at `x` (0 = the silent edge, 1 = full level), shaped
// like Ableton Live's fade curve handle: the gain line is a quadratic Bézier
// from (0, 0) to (1, 1) whose control point (cx, cy) the user drags freely
// inside the fade, so it can bow up or down AND lean towards either end.
//
//   (0.5, 0.5)  straight ramp: what the engine always did;
//   (0, 1)      strongest convex: up fast, then settles;
//   (1, 0)      strongest concave: stays low, rises at the end;
//   (0.2, 0.5)  same height, leaning early, and so on.
//
// A fade out uses the same function with x measured from the clip's end, so
// its shape is the mirror image of the same control point.
//
// The control point is clamped to the unit square, which keeps the curve
// monotonic in x: the gain never goes back down inside a fade in.
// Called per sample only inside a fade region; the straight case is free.
inline float fade_curve_gain(float x, float cx, float cy) noexcept {
    x = std::clamp(x, 0.0f, 1.0f);
    cx = std::clamp(cx, 0.0f, 1.0f);
    cy = std::clamp(cy, 0.0f, 1.0f);
    if (cx == 0.5f && cy == 0.5f) return x;
    // x(t) = (1 - 2cx) t^2 + 2cx t. Solve for t in [0, 1].
    const float a = 1.0f - 2.0f * cx;
    const float b = 2.0f * cx;
    float t;
    if (std::fabs(a) < 1e-6f) {
        t = x;   // cx == 0.5: x is linear in t
    } else {
        const float disc = std::max(0.0f, b * b + 4.0f * a * x);
        t = (-b + std::sqrt(disc)) / (2.0f * a);
    }
    t = std::clamp(t, 0.0f, 1.0f);
    return std::clamp((1.0f - 2.0f * cy) * t * t + 2.0f * cy * t, 0.0f, 1.0f);
}

}  // namespace lt::render
