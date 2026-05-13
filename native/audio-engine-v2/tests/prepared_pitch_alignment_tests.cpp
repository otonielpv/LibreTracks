#include "test_audio_fixtures.h"

#include <doctest/doctest.h>
#include <lt_engine/render/track_renderer.h>
#include <lt_engine/sources/source_manager.h>

using namespace lt;

namespace {

std::vector<float> render_prepared(Semitones semitones, TransposeBehavior behavior) {
    auto samples = test::make_stereo_click(8192, 2048, 1.0f);
    SourceManager sources;
    sources.register_source("source", "");
    REQUIRE(sources.store_decoded_source("source", samples, 2, test::kFixtureSampleRate, 8192).is_ok());

    Track track;
    track.id = behavior == TransposeBehavior::NeverTranspose ? "guide" : "music";
    track.transpose_behavior = behavior;
    track.gain = 1.0f;
    track.clips.push_back(Clip{"clip", "source", 0, 0, 8192});

    PitchCache cache;
    PitchCache* cache_ptr = nullptr;
    if (semitones != 0) {
        PitchCacheKey key{"source", track.id, "clip", static_cast<double>(semitones),
                          test::kFixtureSampleRate, 2, "prepared_proxy"};
        cache.prefetch_range(key, *sources.get("source"), 0, 8192);
        cache_ptr = &cache;
    }

    std::vector<float> left(8192, 0.0f);
    std::vector<float> right(8192, 0.0f);
    float* out[2] = {left.data(), right.data()};
    TrackRenderer renderer;
    renderer.render(track, 0, 8192, out, 2, sources, cache_ptr, test::kFixtureSampleRate, semitones);

    std::vector<float> interleaved(8192 * 2, 0.0f);
    for (int f = 0; f < 8192; ++f) {
        interleaved[static_cast<std::size_t>(f * 2)] = left[static_cast<std::size_t>(f)];
        interleaved[static_cast<std::size_t>(f * 2 + 1)] = right[static_cast<std::size_t>(f)];
    }
    return interleaved;
}

}

TEST_CASE("prepared pitch AB transient alignment") {
    auto a = render_prepared(0, TransposeBehavior::FollowsSongOrRegion);
    auto b = render_prepared(2, TransposeBehavior::FollowsSongOrRegion);
    CHECK(std::llabs(test::first_onset_frame(a, 0.2f) - test::first_onset_frame(b, 0.2f)) <= 2);
}

TEST_CASE("NeverTranspose uses original cache path and remains aligned") {
    auto music = render_prepared(2, TransposeBehavior::FollowsSongOrRegion);
    auto guide = render_prepared(0, TransposeBehavior::NeverTranspose);
    CHECK(test::first_onset_frame(guide, 0.2f) == 2048);
    CHECK(std::llabs(test::first_onset_frame(music, 0.2f) - test::first_onset_frame(guide, 0.2f)) <= 2);
}
