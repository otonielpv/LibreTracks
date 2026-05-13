#include "test_audio_fixtures.h"

#include <doctest/doctest.h>
#include <lt_engine/pitch/pitch_cache.h>

#include <cmath>

using namespace lt;

namespace {

double shifted_frequency(Semitones semitones) {
    auto samples = test::make_stereo_sine(96000, 440.0, 0.4f);
    std::vector<float> left(samples.size() / 2);
    std::vector<float> right(samples.size() / 2);
    for (std::size_t f = 0; f < left.size(); ++f) {
        left[f] = samples[f * 2];
        right[f] = samples[f * 2 + 1];
    }
    float* channels[2] = {left.data(), right.data()};
    PitchCache cache;
    auto* proc = cache.prepare_processor(
        PitchCacheKey{"source", "track", "clip", static_cast<double>(semitones),
                      test::kFixtureSampleRate, 2, "realtime"});
    for (std::size_t offset = 0; offset < left.size(); offset += 4096) {
        int frames = static_cast<int>(std::min<std::size_t>(4096, left.size() - offset));
        float* block[2] = {left.data() + offset, right.data() + offset};
        proc->process(block, 2, frames);
    }
    for (std::size_t f = 0; f < left.size(); ++f) {
        samples[f * 2] = left[f];
        samples[f * 2 + 1] = right[f];
    }
    return test::estimate_frequency_hz(samples, test::kFixtureSampleRate, 24000, 48000);
}

void check_frequency(Semitones semitones, double expected) {
    double actual = shifted_frequency(semitones);
    CHECK(actual == doctest::Approx(expected).epsilon(0.02));
}

}

#if LT_ENGINE_TEST_EXPECT_REAL_RUBBERBAND
TEST_CASE("RubberBand shifts 440 Hz to expected semitone frequencies") {
    check_frequency(12, 880.0);
    check_frequency(-12, 220.0);
    check_frequency(2, 493.88);
    check_frequency(-2, 392.00);
}
#else
TEST_CASE("RubberBand shifts 440 Hz to expected semitone frequencies" * doctest::skip()) {
    CHECK(true);
}
#endif
