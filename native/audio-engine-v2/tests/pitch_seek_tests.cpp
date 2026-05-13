#include "test_audio_fixtures.h"

#include <doctest/doctest.h>
#include <lt_engine/render/track_renderer.h>
#include <lt_engine/sources/source_manager.h>

using namespace lt;

TEST_CASE("pitched render after seek resumes non-silent and aligned") {
    auto samples = test::make_stereo_click(96000, 50000, 1.0f);
    SourceManager sources;
    sources.register_source("source", "");
    REQUIRE(sources.store_decoded_source("source", samples, 2, test::kFixtureSampleRate, 96000).is_ok());

    Track track;
    track.id = "track";
    track.clips.push_back(Clip{"clip", "source", 0, 0, 96000});

    PitchCache cache;
    constexpr Frame seek_frame = 49000;
    constexpr int frames = 4096;
    PitchCacheKey key{"source", "track", "clip", 2.0, test::kFixtureSampleRate, 2, "prepared_proxy"};
    const DecodedSource* source = sources.get("source");
    REQUIRE(source != nullptr);
    cache.prefetch_range(key, *source, seek_frame, frames);

    float left[frames] = {};
    float right[frames] = {};
    float* out[2] = {left, right};
    TrackRenderer renderer;
    renderer.render(track, seek_frame, frames, out, 2, sources, &cache, test::kFixtureSampleRate, 2);

    std::vector<float> rendered(static_cast<std::size_t>(frames * 2), 0.0f);
    for (int f = 0; f < frames; ++f) {
        rendered[static_cast<std::size_t>(f * 2)] = left[f];
        rendered[static_cast<std::size_t>(f * 2 + 1)] = right[f];
    }
    Frame onset = test::first_onset_frame(rendered, 0.2f);
    REQUIRE(onset >= 0);
    CHECK(std::llabs(onset - (50000 - seek_frame)) <= 2);
}

TEST_CASE("seek into unprepared pitch reports missing proxy and renders no stale audio") {
    auto samples = test::make_stereo_click(96000, 50000, 1.0f);
    SourceManager sources;
    sources.register_source("source", "");
    REQUIRE(sources.store_decoded_source("source", samples, 2, test::kFixtureSampleRate, 96000).is_ok());

    Track track;
    track.id = "track";
    track.clips.push_back(Clip{"clip", "source", 0, 0, 96000});

    constexpr Frame seek_frame = 49000;
    constexpr int frames = 4096;
    float left[frames] = {};
    float right[frames] = {};
    float* out[2] = {left, right};
    PitchCache cache;
    TrackRenderer renderer;
    renderer.render(track, seek_frame, frames, out, 2, sources, &cache, test::kFixtureSampleRate, 2);

    CHECK(cache.diagnostics().proxy_blocks_missing > 0);
    for (int f = 0; f < frames; ++f) {
        CHECK(left[f] == doctest::Approx(0.0f));
        CHECK(right[f] == doctest::Approx(0.0f));
    }
}
