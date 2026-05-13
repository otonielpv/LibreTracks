#include "test_audio_fixtures.h"

#include <doctest/doctest.h>
#include <lt_engine/pitch/pitch_cache.h>

#include <chrono>
#include <cmath>
#include <thread>

using namespace lt;

namespace {

bool wait_ready(PitchCache& cache, const PitchCacheKey& key, int first, int last) {
    for (int attempt = 0; attempt < 200; ++attempt) {
        bool ready = true;
        for (int block = first; block <= last; ++block)
            ready = ready && cache.is_block_ready(key, block);
        if (ready)
            return true;
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }
    return false;
}

std::vector<float> render_proxy(PitchCache& cache, const PitchCacheKey& key, Frame frames) {
    std::vector<float> left(static_cast<std::size_t>(frames), 0.0f);
    std::vector<float> right(static_cast<std::size_t>(frames), 0.0f);
    for (Frame offset = 0; offset < frames; offset += PitchCache::kProxyBlockFrames) {
        const int chunk = static_cast<int>(std::min<Frame>(PitchCache::kProxyBlockFrames, frames - offset));
        float* out[2] = {
            left.data() + static_cast<std::size_t>(offset),
            right.data() + static_cast<std::size_t>(offset),
        };
        REQUIRE(cache.get_block_if_ready(key, cache.block_index_for(offset),
                                         cache.offset_in_block(offset), chunk, out, 2));
    }
    std::vector<float> interleaved(static_cast<std::size_t>(frames * 2), 0.0f);
    for (Frame f = 0; f < frames; ++f) {
        interleaved[static_cast<std::size_t>(f * 2)] = left[static_cast<std::size_t>(f)];
        interleaved[static_cast<std::size_t>(f * 2 + 1)] = right[static_cast<std::size_t>(f)];
    }
    return interleaved;
}

void check_frequency(double semitones, double expected_hz) {
#if !LT_ENGINE_TEST_EXPECT_REAL_RUBBERBAND
    (void)semitones;
    (void)expected_hz;
    return;
#else
    constexpr Frame frames = 48000 * 3;
    DecodedSource source(test::make_stereo_sine(frames, 440.0, 0.25f), 2,
                         test::kFixtureSampleRate, frames);
    PitchCache cache;
    PitchCacheKey key{"source", "track", "clip", semitones,
                      test::kFixtureSampleRate, 2, "prepared_proxy"};
    cache.enqueue_range(key, source, 0, frames, 0, 1, "frequency");
    REQUIRE(wait_ready(cache, key, 0, cache.block_index_for(frames - 1)));
    auto rendered = render_proxy(cache, key, frames);
    double actual = test::estimate_frequency_hz(rendered, test::kFixtureSampleRate, 12000, 48000);
    CHECK(actual == doctest::Approx(expected_hz).epsilon(0.02));
#endif
}

}

TEST_CASE("prepared pitch proxy has no large block-boundary discontinuity") {
    constexpr Frame frames = PitchCache::kProxyBlockFrames * 4;
    DecodedSource source(test::make_stereo_sine(frames * 2, 440.0, 0.25f), 2,
                         test::kFixtureSampleRate, frames * 2);
    PitchCache cache;
    PitchCacheKey key{"source", "track", "clip", 2.0,
                      test::kFixtureSampleRate, 2, "prepared_proxy"};

    cache.enqueue_range(key, source, 0, frames, 0, 1, "continuity");
    REQUIRE(wait_ready(cache, key, 0, 3));
    auto rendered = render_proxy(cache, key, frames);

    float max_delta = 0.0f;
    for (Frame f = 1; f < frames; ++f) {
        float prev = rendered[static_cast<std::size_t>((f - 1) * 2)];
        float curr = rendered[static_cast<std::size_t>(f * 2)];
        max_delta = std::max(max_delta, std::abs(curr - prev));
    }
    CHECK(max_delta < 0.08f);
}

TEST_CASE("prepared pitch proxy frequency is shifted and duration preserved") {
    check_frequency(2.0, 493.88);
    check_frequency(12.0, 880.0);
    check_frequency(-12.0, 220.0);
}
