#include <doctest/doctest.h>
#include <lt_engine/render/fade_processor.h>

#include <algorithm>
#include <cmath>
#include <vector>

using namespace lt;

TEST_CASE("seek fade starts near zero and rises monotonically") {
    FadeProcessor fade(128);
    std::vector<float> left(160, 1.0f);
    float* channels[] = { left.data() };

    fade.trigger_fade_in();
    fade.process(channels, 1, static_cast<int>(left.size()));

    CHECK(left.front() == doctest::Approx(0.0f));
    CHECK(left[127] == doctest::Approx(1.0f));
    for (int i = 1; i < 128; ++i) {
        CHECK(left[i] >= left[i - 1]);
        CHECK(left[i] <= 1.0f);
        CHECK(std::isfinite(left[i]));
    }
    CHECK(left[128] == doctest::Approx(1.0f));
}

TEST_CASE("seek fade keeps the same anchor across callback boundaries") {
    FadeProcessor fade(4);
    float previous[] = {0.25f};
    float* previous_channels[] = {previous};
    fade.capture_previous_sample(previous_channels, 1, 0);

    std::vector<float> first(2, 1.0f);
    std::vector<float> second(2, 1.0f);
    float* first_channels[] = {first.data()};
    float* second_channels[] = {second.data()};

    fade.trigger_fade_in();
    fade.process(first_channels, 1, static_cast<int>(first.size()));
    fade.process(second_channels, 1, static_cast<int>(second.size()));

    CHECK(first[0] == doctest::Approx(0.25f));
    CHECK(first[1] == doctest::Approx(0.444444f));
    CHECK(second[0] == doctest::Approx(0.805556f));
    CHECK(second[1] == doctest::Approx(1.0f));
}

TEST_CASE("repeated seeks restart fade without sudden second-phase drop") {
    FadeProcessor fade(64);
    std::vector<float> left(96, 1.0f);
    float* channels[] = { left.data() };

    fade.trigger_fade_in();
    fade.process(channels, 1, 16);
    fade.trigger_fade_in();
    fade.process(channels, 1, 96);

    const float first_after_restart = left[0];
    CHECK(first_after_restart > 0.0f);
    for (int i = 1; i < 16; ++i)
        CHECK(left[i] >= first_after_restart * 0.9f);
    for (int i = 16; i < 64; ++i)
        CHECK(left[i] >= left[i - 1]);
    CHECK(left[63] == doctest::Approx(1.0f));
    CHECK(left[64] == doctest::Approx(1.0f));
}

TEST_CASE("paused seek state can be cleared deterministically") {
    FadeProcessor fade(64);
    fade.trigger_fade_in();
    CHECK(fade.is_active());
    fade.clear();
    CHECK_FALSE(fade.is_active());

    std::vector<float> left(8, 1.0f);
    float* channels[] = { left.data() };
    fade.process(channels, 1, 8);
    CHECK(std::all_of(left.begin(), left.end(), [](float v) { return v == 1.0f; }));
}
