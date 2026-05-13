#include "test_audio_fixtures.h"

#include <doctest/doctest.h>
#include <lt_engine/pitch/pitch_cache.h>
#include <lt_engine/sources/original_source_cache.h>

using namespace lt;

TEST_CASE("OriginalSourceCache reads decoded source blocks") {
    DecodedSource source(test::make_stereo_click(8192, 1234, 1.0f), 2,
                         test::kFixtureSampleRate, 8192);
    OriginalSourceCache cache;
    CHECK_FALSE(cache.is_block_ready("source", 0));
    CHECK(cache.request_block("source", source, 0));
    CHECK(cache.is_block_ready("source", 0));

    float left[256] = {};
    float right[256] = {};
    float* out[2] = {left, right};
    CHECK(cache.get_block_if_ready("source", 0, 1200, 256, out, 2));
    CHECK(left[34] == doctest::Approx(1.0f));
    CHECK(right[34] == doctest::Approx(1.0f));
}

TEST_CASE("OriginalSourceCache missing block reports not ready") {
    OriginalSourceCache cache;
    float left[16] = {};
    float right[16] = {};
    float* out[2] = {left, right};
    CHECK_FALSE(cache.get_block_if_ready("missing", 0, 0, 16, out, 2));
    CHECK(cache.diagnostics().original_blocks_missing == 1);
}

TEST_CASE("PitchProxyCache deduplicates repeated block requests") {
    DecodedSource source(test::make_stereo_sine(8192, 440.0, 0.25f), 2,
                         test::kFixtureSampleRate, 8192);
    PitchCache cache;
    PitchCacheKey key{"source", "track", "clip", 2.0, test::kFixtureSampleRate, 2, "prepared_proxy"};
    CHECK(cache.request_block(key, source, 0));
    CHECK(cache.request_block(key, source, 0));
    auto d = cache.diagnostics();
    CHECK(d.proxy_blocks_ready == 1);
    CHECK(d.duplicate_proxy_request_count >= 1);
}

TEST_CASE("PitchProxyCache prepared block is timeline-addressed") {
    DecodedSource source(test::make_stereo_click(8192, 4096, 1.0f), 2,
                         test::kFixtureSampleRate, 8192);
    PitchCache cache;
    PitchCacheKey key{"source", "track", "clip", 12.0, test::kFixtureSampleRate, 2, "prepared_proxy"};
    CHECK(cache.request_block(key, source, 1));

    float left[256] = {};
    float right[256] = {};
    float* out[2] = {left, right};
    CHECK(cache.get_block_if_ready(key, 1, 0, 256, out, 2));
    CHECK(left[0] == doctest::Approx(1.0f));
    CHECK(right[0] == doctest::Approx(1.0f));
}
