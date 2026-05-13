#include "test_audio_fixtures.h"

#include <doctest/doctest.h>
#include <lt_engine/engine_impl.h>
#include <lt_engine/pitch/pitch_cache.h>

#include <chrono>
#include <thread>

using namespace lt;

namespace {

PitchCacheKey async_key(double semitones) {
    return PitchCacheKey{"source", "track", "clip", semitones,
                         test::kFixtureSampleRate, 2, "prepared_proxy"};
}

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

std::string two_song_project_json() {
    return R"({
      "id": "project",
      "songs": [{
        "id": "song-a",
        "duration_seconds": 30.0,
        "transposeSemitones": 0,
        "tracks": [{
          "id": "track-a",
          "clips": [{"id":"clip-a","sourceId":"source-a","filePath":"missing-a.wav","duration_seconds":30.0}]
        }]
      }, {
        "id": "song-b",
        "duration_seconds": 30.0,
        "transposeSemitones": 2,
        "tracks": [{
          "id": "track-b1",
          "clips": [{"id":"clip-b1","sourceId":"source-b1","filePath":"missing-b1.wav","duration_seconds":30.0}]
        }, {
          "id": "track-b2",
          "clips": [{"id":"clip-b2","sourceId":"source-b2","filePath":"missing-b2.wav","duration_seconds":30.0}]
        }]
      }]
    })";
}

std::string json_escape(const std::string& value) {
    std::string out;
    out.reserve(value.size() + 16);
    for (char c : value) {
        if (c == '\\' || c == '"')
            out.push_back('\\');
        if (c == '\n') {
            out += "\\n";
        } else if (c == '\r') {
            out += "\\r";
        } else {
            out.push_back(c);
        }
    }
    return out;
}

}

TEST_CASE("pitch proxy range request returns before background job completes") {
    DecodedSource source(test::make_stereo_sine(480000, 440.0, 0.25f), 2,
                         test::kFixtureSampleRate, 480000);
    PitchCache cache;
    auto key = async_key(2.0);

    auto t0 = std::chrono::steady_clock::now();
    cache.enqueue_range(key, source, 0, 480000, 0, 1, "test_async");
    auto elapsed = std::chrono::duration<double, std::milli>(
        std::chrono::steady_clock::now() - t0).count();

    CHECK(elapsed < 20.0);
    CHECK(cache.diagnostics().prepare_sync_count == 0);
    CHECK(cache.diagnostics().jobs_queued >= 1);
    CHECK(cache.diagnostics().jobs_pending
          + cache.diagnostics().jobs_running
          + cache.diagnostics().jobs_completed
          + cache.diagnostics().jobs_failed >= 1);
    CHECK(wait_ready(cache, key, 0, 0));
}

TEST_CASE("project load with transposed song returns without full pitch pre-render") {
    EngineImpl engine;
    REQUIRE(engine.initialize().is_ok());

    auto t0 = std::chrono::steady_clock::now();
    auto result = engine.send_command(std::string("{\"type\":\"LoadSession\",\"project_json\":\"")
                                      + json_escape(two_song_project_json()) + "\"}");
    auto elapsed = std::chrono::duration<double, std::milli>(
        std::chrono::steady_clock::now() - t0).count();

    CHECK(result.is_ok());
    CHECK(elapsed < 100.0);
    CHECK(engine.shutdown().is_ok());
}
