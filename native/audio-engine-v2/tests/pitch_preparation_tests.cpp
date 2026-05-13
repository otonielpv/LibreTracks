#include "test_audio_fixtures.h"

#include <doctest/doctest.h>
#include <lt_engine/render/track_renderer.h>
#include <lt_engine/sources/source_manager.h>

using namespace lt;

TEST_CASE("source ready callback fires after delayed decoded source is stored") {
    SourceManager sources;
    sources.register_source("source", "delayed.mp3");

    int ready_count = 0;
    Id ready_id;
    sources.set_source_ready_callback([&](const Id& source_id) {
        ++ready_count;
        ready_id = source_id;
    });

    auto samples = test::make_stereo_sine(4096, 440.0, 0.25f);
    REQUIRE(sources.store_decoded_source("source", samples, 2, test::kFixtureSampleRate, 4096).is_ok());

    CHECK(ready_count == 1);
    CHECK(ready_id == "source");
}

TEST_CASE("missing prepared pitch proxy renders no stale stem and records diagnostic") {
    SourceManager sources;
    sources.register_source("source", "");
    auto samples = test::make_stereo_click(4096, 1024, 1.0f);
    REQUIRE(sources.store_decoded_source("source", samples, 2, test::kFixtureSampleRate, 4096).is_ok());

    Track track;
    track.id = "track";
    track.gain = 1.0f;
    track.clips.push_back(Clip{"clip", "source", 0, 0, 4096});

    PitchCache cache;
    float left[4096] = {};
    float right[4096] = {};
    float* out[2] = {left, right};
    TrackRenderer renderer;
    renderer.render(track, 0, 4096, out, 2, sources, &cache, test::kFixtureSampleRate, 2);

    CHECK(cache.diagnostics().proxy_blocks_missing > 0);
    CHECK(left[1024] == doctest::Approx(0.0f));
    CHECK(right[1024] == doctest::Approx(0.0f));
}

TEST_CASE("prepared pitch proxy produces non-zero pitched audio") {
    SourceManager sources;
    sources.register_source("source", "");
    auto samples = test::make_stereo_sine(4096, 440.0, 0.25f);
    REQUIRE(sources.store_decoded_source("source", samples, 2, test::kFixtureSampleRate, 4096).is_ok());

    Track track;
    track.id = "track";
    track.gain = 1.0f;
    track.clips.push_back(Clip{"clip", "source", 0, 0, 4096});

    PitchCache cache;
    PitchCacheKey key{"source", "track", "clip", 2.0, test::kFixtureSampleRate, 2, "prepared_proxy"};
    const DecodedSource* source = sources.get("source");
    REQUIRE(source != nullptr);
    cache.prefetch_range(key, *source, 0, 4096);

    float left[4096] = {};
    float right[4096] = {};
    float* out[2] = {left, right};
    TrackRenderer renderer;
    renderer.render(track, 0, 4096, out, 2, sources, &cache, test::kFixtureSampleRate, 2);

    bool non_zero = false;
    for (int i = 0; i < 4096; ++i)
        non_zero = non_zero || left[i] != 0.0f || right[i] != 0.0f;
    CHECK(non_zero);
}
