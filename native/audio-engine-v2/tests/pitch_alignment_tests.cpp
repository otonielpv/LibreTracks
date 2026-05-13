#include "test_audio_fixtures.h"

#include <doctest/doctest.h>
#include <lt_engine/render/track_renderer.h>
#include <lt_engine/render/pitch_resolution.h>
#include <lt_engine/pitch/seek_safe_pitch_stream.h>
#include <lt_engine/sources/source_manager.h>

#include <memory>
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
                          test::kFixtureSampleRate, 2, "prepared_proxy"};
        const DecodedSource* source = sources.get("source");
        REQUIRE(source != nullptr);
        cache.prefetch_range(key, *source, 0, static_cast<Frame>(samples.size() / 2));
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
    INFO("unpitched=", a, " pitched=", b);
    REQUIRE(a >= 0);
    REQUIRE(b >= 0);
    CHECK(std::llabs(a - b) <= 2);
}

TEST_CASE("pitched and unpitched duplicate tracks are sample aligned") {
    for (Semitones semitones : {2, -2, 12, -12}) {
        INFO("semitones=", semitones);
        constexpr Frame frames = 16384;
        constexpr Frame onset = 4096;
        auto samples = test::make_stereo_click(frames, onset, 1.0f);
        DecodedSource source(samples, 2, test::kFixtureSampleRate, frames);

        std::vector<float> unpitched(static_cast<std::size_t>(frames * 2), 0.0f);
        std::vector<float> left(static_cast<std::size_t>(frames), 0.0f);
        std::vector<float> right(static_cast<std::size_t>(frames), 0.0f);
        float* original_out[2] = {left.data(), right.data()};
        REQUIRE(source.read(0, static_cast<int>(frames), original_out, 2) == frames);
        for (Frame f = 0; f < frames; ++f) {
            unpitched[static_cast<std::size_t>(f * 2)] = left[static_cast<std::size_t>(f)];
            unpitched[static_cast<std::size_t>(f * 2 + 1)] = right[static_cast<std::size_t>(f)];
        }

        auto pitch_stream = std::make_unique<SeekSafePitchStream>();
        pitch_stream->configure({test::kFixtureSampleRate, 2, static_cast<double>(semitones)});
        pitch_stream->reset_for_seek(source, 0);
        std::fill(left.begin(), left.end(), 0.0f);
        std::fill(right.begin(), right.end(), 0.0f);
        float* pitched_out[2] = {left.data(), right.data()};
        const int rendered = pitch_stream->render_aligned(source, 0, static_cast<int>(frames), pitched_out, 2);
        REQUIRE(rendered > onset);

        std::vector<float> pitched(static_cast<std::size_t>(frames * 2), 0.0f);
        for (Frame f = 0; f < frames; ++f) {
            pitched[static_cast<std::size_t>(f * 2)] = left[static_cast<std::size_t>(f)];
            pitched[static_cast<std::size_t>(f * 2 + 1)] = right[static_cast<std::size_t>(f)];
        }

        const Frame a = test::first_onset_frame(unpitched, 0.2f);
        const Frame b = test::first_onset_frame(pitched, 0.2f);
        INFO("a=", a, " b=", b);
        REQUIRE(a >= 0);
        REQUIRE(b >= 0);
        CHECK(std::llabs(a - b) <= 2);
    }
}

TEST_CASE("prepared pitch click onsets stay aligned at extreme semitones") {
    for (Semitones semitones : {12, -12, -2}) {
        auto click = test::make_stereo_click(8192, 2048, 1.0f);
        auto unpitched = render_track(click, 0);
        auto pitched = render_track(click, semitones);
        Frame a = test::first_onset_frame(unpitched, 0.2f);
        Frame b = test::first_onset_frame(pitched, 0.2f);
        REQUIRE(a >= 0);
        REQUIRE(b >= 0);
        CHECK(std::llabs(a - b) <= 2);
    }
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
