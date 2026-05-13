#include "test_audio_fixtures.h"

#include <doctest/doctest.h>
#include <lt_engine/render/track_renderer.h>
#include <lt_engine/render/pitch_resolution.h>
#include <lt_engine/sources/source_manager.h>

#include <vector>

using namespace lt;

namespace {

std::vector<float> render_track(const std::vector<float>& samples,
                                Semitones effective,
                                TransposeBehavior behavior = TransposeBehavior::FollowsSongOrRegion) {
    SourceManager sources;
    sources.register_source("source", "");
    REQUIRE(sources.store_decoded_source("source", samples, 2, test::kFixtureSampleRate,
                                         static_cast<Frame>(samples.size() / 2)).is_ok());

    Track track;
    track.id = behavior == TransposeBehavior::NeverTranspose ? "track-never" : "track";
    track.gain = 1.0f;
    track.transpose_behavior = behavior;
    track.clips.push_back(Clip{"clip", "source", 0, 0, static_cast<Frame>(samples.size() / 2)});

    PitchCache cache;
    if (effective != 0) {
        PitchCacheKey key{"source", track.id, "clip", static_cast<double>(effective),
                          test::kFixtureSampleRate, 2, "realtime"};
        cache.prepare_processor(key);
    }

    std::vector<float> left(static_cast<std::size_t>(samples.size() / 2), 0.0f);
    std::vector<float> right(left.size(), 0.0f);
    float* out[2] = {left.data(), right.data()};
    TrackRenderer renderer;
    renderer.render(track, 0, static_cast<int>(left.size()), out, 2, sources,
                    effective == 0 ? nullptr : &cache, test::kFixtureSampleRate, effective);

    std::vector<float> rendered(samples.size(), 0.0f);
    for (std::size_t i = 0; i < left.size(); ++i) {
        rendered[i * 2] = left[i];
        rendered[i * 2 + 1] = right[i];
    }
    return rendered;
}

}

TEST_CASE("pitched and unpitched click onsets remain aligned") {
    auto click = test::make_stereo_click(4096, 1024, 1.0f);
    auto unpitched = render_track(click, 0);
    auto pitched = render_track(click, 2);
    Frame a = test::first_onset_frame(unpitched, 0.2f);
    Frame b = test::first_onset_frame(pitched, 0.2f);
    REQUIRE(a >= 0);
    REQUIRE(b >= 0);
    CHECK(std::llabs(a - b) <= 2);
}

TEST_CASE("NeverTranspose remains unpitched and aligned under song transpose") {
    auto click = test::make_stereo_click(4096, 1024, 1.0f);
    auto normal = render_track(click, 2);
    auto never = render_track(click, 0, TransposeBehavior::NeverTranspose);
    Frame normal_onset = test::first_onset_frame(normal, 0.2f);
    Frame never_onset = test::first_onset_frame(never, 0.2f);
    if (normal_onset >= 0)
        CHECK(std::llabs(normal_onset - never_onset) <= 2);
    CHECK(never_onset == 1024);
}
