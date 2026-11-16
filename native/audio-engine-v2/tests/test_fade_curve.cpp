#include <doctest/doctest.h>

#include <lt_engine/render/fade_curve.h>

#include <utility>

using lt::render::fade_curve_gain;

TEST_CASE("a straight clip fade is the ramp it always was") {
    CHECK(fade_curve_gain(0.0f, 0.5f, 0.5f) == 0.0f);
    CHECK(fade_curve_gain(0.25f, 0.5f, 0.5f) == doctest::Approx(0.25f));
    CHECK(fade_curve_gain(1.0f, 0.5f, 0.5f) == 1.0f);
    // A control point on the diagonal is also a straight line.
    CHECK(fade_curve_gain(0.3f, 0.2f, 0.2f) == doctest::Approx(0.3f).epsilon(0.001));
}

TEST_CASE("the control point bends the fade but keeps its ends") {
    for (auto [cx, cy] : {std::pair{0.0f, 1.0f}, {1.0f, 0.0f}, {0.2f, 0.6f}, {0.9f, 0.4f}}) {
        CHECK(fade_curve_gain(0.0f, cx, cy) == doctest::Approx(0.0f));
        CHECK(fade_curve_gain(1.0f, cx, cy) == doctest::Approx(1.0f));
    }
    // Up and to the left comes up fast; down and to the right comes up late.
    CHECK(fade_curve_gain(0.5f, 0.0f, 1.0f) > 0.7f);
    CHECK(fade_curve_gain(0.5f, 1.0f, 0.0f) < 0.3f);
    // Same height, leaning towards the start vs the end: x moves the shape.
    CHECK(fade_curve_gain(0.25f, 0.1f, 0.8f) > fade_curve_gain(0.25f, 0.6f, 0.8f));
}

TEST_CASE("a fade never turns back down, wherever the point is dragged") {
    for (float cx = 0.0f; cx <= 1.0f; cx += 0.25f) {
        for (float cy = 0.0f; cy <= 1.0f; cy += 0.25f) {
            float previous = 0.0f;
            for (int i = 0; i <= 64; ++i) {
                const float g = fade_curve_gain(static_cast<float>(i) / 64.0f, cx, cy);
                CHECK(g >= previous - 1e-5f);
                previous = g;
            }
        }
    }
}

TEST_CASE("out-of-range input is clamped, not extrapolated") {
    CHECK(fade_curve_gain(-0.5f, 0.2f, 0.7f) == 0.0f);
    CHECK(fade_curve_gain(2.0f, 0.2f, 0.7f) == doctest::Approx(1.0f));
    CHECK(fade_curve_gain(0.5f, -3.0f, 4.0f) == doctest::Approx(fade_curve_gain(0.5f, 0.0f, 1.0f)));
}
