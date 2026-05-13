#include "test_audio_fixtures.h"

#include <doctest/doctest.h>
#include <lt_engine/pitch/pitch_cache.h>
#include <lt_engine/pitch/persistent_pitch_proxy_cache.h>

#include <chrono>
#include <filesystem>
#include <thread>

using namespace lt;

namespace {

bool wait_ready(PitchCache& cache, const PitchCacheKey& key, int block) {
    for (int attempt = 0; attempt < 200; ++attempt) {
        if (cache.is_block_ready(key, block))
            return true;
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }
    return false;
}

}

TEST_CASE("persistent pitch proxy cache stores and reloads a prepared block") {
    auto dir = std::filesystem::temp_directory_path() / "libretracks_pitch_proxy_test";
    std::filesystem::remove_all(dir);

    PitchCacheKey key{"source", "track", "clip", 2.0, test::kFixtureSampleRate, 2, "prepared_proxy"};
    DecodedSource source(test::make_stereo_sine(8192, 440.0, 0.25f), 2,
                         test::kFixtureSampleRate, 8192);

    {
        PitchCache cache;
        cache.set_persistent_cache_dir(dir);
        cache.set_persistent_cache_enabled(true);
        cache.enqueue_range(key, source, 0, 4096, 0, 1, "persistent_test");
        REQUIRE(wait_ready(cache, key, 0));
        CHECK(cache.disk_cache_diagnostics().writes >= 1);
    }

    {
        PitchCache cache;
        cache.set_persistent_cache_dir(dir);
        cache.set_persistent_cache_enabled(true);
        float left[128] = {};
        float right[128] = {};
        float* out[2] = {left, right};
        CHECK_FALSE(cache.get_block_if_ready(key, 0, 0, 128, out, 2));
        CHECK(cache.disk_cache_diagnostics().hits == 0);

        cache.enqueue_range(key, source, 0, 4096, 0, 1, "persistent_reload");
        REQUIRE(wait_ready(cache, key, 0));
        CHECK(cache.get_block_if_ready(key, 0, 0, 128, out, 2));
        CHECK(cache.disk_cache_diagnostics().hits >= 1);
    }

    std::filesystem::remove_all(dir);
}

TEST_CASE("persistent pitch proxy cache ignores incomplete files") {
    auto dir = std::filesystem::temp_directory_path() / "libretracks_pitch_proxy_incomplete_test";
    std::filesystem::remove_all(dir);
    std::filesystem::create_directories(dir);

    PitchCache cache;
    cache.set_persistent_cache_dir(dir);
    cache.set_persistent_cache_enabled(true);
    PitchCacheKey key{"source", "track", "clip", 2.0, test::kFixtureSampleRate, 2, "prepared_proxy"};

    float left[128] = {};
    float right[128] = {};
    float* out[2] = {left, right};
    CHECK_FALSE(cache.get_block_if_ready(key, 0, 0, 128, out, 2));
    CHECK(cache.disk_cache_diagnostics().misses == 0);

    std::filesystem::remove_all(dir);
}

TEST_CASE("get_block_if_ready does not load disk cache from render path") {
    auto dir = std::filesystem::temp_directory_path() / "libretracks_pitch_proxy_no_audio_io_test";
    std::filesystem::remove_all(dir);

    PitchCacheKey key{"source", "track", "clip", 2.0, test::kFixtureSampleRate, 2, "prepared_proxy"};
    DecodedSource source(test::make_stereo_sine(8192, 440.0, 0.25f), 2,
                         test::kFixtureSampleRate, 8192);

    {
        PitchCache cache;
        cache.set_persistent_cache_dir(dir);
        cache.set_persistent_cache_enabled(true);
        cache.enqueue_range(key, source, 0, 4096, 0, 1, "persistent_test");
        REQUIRE(wait_ready(cache, key, 0));
        CHECK(cache.disk_cache_diagnostics().writes >= 1);
    }

    PitchCache cache;
    cache.set_persistent_cache_dir(dir);
    cache.set_persistent_cache_enabled(true);
    float left[128] = {};
    float right[128] = {};
    float* out[2] = {left, right};
    CHECK_FALSE(cache.get_block_if_ready(key, 0, 0, 128, out, 2));
    CHECK(cache.disk_cache_diagnostics().hits == 0);
    CHECK(cache.diagnostics().disk_cache_audio_thread_load_attempts == 0);

    std::filesystem::remove_all(dir);
}
