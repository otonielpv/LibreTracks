#include "test_audio_fixtures.h"

#include <doctest/doctest.h>
#include <lt_engine/pitch/offline_pitch_segment_renderer.h>
#include <lt_engine/render/track_renderer.h>
#include <lt_engine/sources/source_manager.h>

#include <cmath>

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

TEST_CASE("far seek with pitch renders through realtime seek-safe path when proxy is missing") {
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

    bool has_audio = false;
    for (int f = 0; f < frames; ++f) {
        CHECK(std::isfinite(left[f]));
        CHECK(std::isfinite(right[f]));
        has_audio = has_audio || std::abs(left[f]) > 0.0001f || std::abs(right[f]) > 0.0001f;
    }
    CHECK(has_audio);
    CHECK(cache.diagnostics().active_pitch_render_path == "realtime_seek_safe");
    CHECK(cache.diagnostics().emergency_silence_render_count == 0);
}

TEST_CASE("missing proxy does not alternate proxy and silence block by block during playback") {
    constexpr Frame duration = 32768;
    auto samples = test::make_stereo_sine(duration, 440.0, 0.2f);
    SourceManager sources;
    sources.register_source("source", "");
    REQUIRE(sources.store_decoded_source("source", samples, 2, test::kFixtureSampleRate, duration).is_ok());

    Track track;
    track.id = "track";
    track.clips.push_back(Clip{"clip", "source", 0, 0, duration});

    PitchCache cache;
    PitchCacheKey key{"source", "track", "clip", 2.0, test::kFixtureSampleRate, 2, "prepared_proxy"};
    const DecodedSource* source = sources.get("source");
    REQUIRE(source != nullptr);
    cache.prefetch_range(key, *source, 0, PitchCache::kProxyBlockFrames);

    float left[PitchCache::kProxyBlockFrames * 2] = {};
    float right[PitchCache::kProxyBlockFrames * 2] = {};
    float* out[2] = {left, right};
    TrackRenderer renderer;
    renderer.render(track, 0, PitchCache::kProxyBlockFrames * 2, out, 2,
                    sources, &cache, test::kFixtureSampleRate, 2);

    CHECK(cache.diagnostics().active_pitch_render_path == "realtime_seek_safe");
    CHECK(cache.diagnostics().emergency_silence_render_count == 0);
    for (int f = 0; f < PitchCache::kProxyBlockFrames * 2; ++f) {
        CHECK(std::isfinite(left[f]));
        CHECK(std::isfinite(right[f]));
    }
}

TEST_CASE("prepared pitch proxy does not ratio-scale absolute source position") {
    constexpr Frame requested_start = 480000;
    constexpr Frame impulse_frame = requested_start + 1024;
    constexpr Frame frames = 520000;
    auto samples = test::make_stereo_click(frames, impulse_frame, 1.0f);
    DecodedSource source(samples, 2, test::kFixtureSampleRate, frames);
    PitchCacheKey key{"source", "track", "clip", 2.0, test::kFixtureSampleRate, 2, "prepared_proxy"};

    OfflinePitchSegmentRenderer renderer;
    auto segment = renderer.render_segment(key, source, requested_start, 4096);
    REQUIRE(segment.ok);
    REQUIRE(segment.start_frame == requested_start);
    REQUIRE(segment.frame_count == 4096);
    REQUIRE(segment.interleaved_samples.size() == static_cast<std::size_t>(4096 * 2));
    const Frame onset = test::first_onset_frame(segment.interleaved_samples, 0.2f);
    REQUIRE(onset >= 0);
    CHECK(std::llabs(onset - 1024) <= 2);
}

TEST_CASE("far seek pitched and unpitched duplicate tracks stay aligned") {
    constexpr Frame duration = 1000000;
    std::vector<float> samples(static_cast<std::size_t>(duration * 2), 0.0f);
    for (Frame frame : {Frame{48000}, Frame{240000}, Frame{480000}, Frame{960000}}) {
        samples[static_cast<std::size_t>(frame * 2)] = 1.0f;
        samples[static_cast<std::size_t>(frame * 2 + 1)] = 1.0f;
    }
    SourceManager sources;
    sources.register_source("source", "");
    REQUIRE(sources.store_decoded_source("source", samples, 2, test::kFixtureSampleRate, duration).is_ok());

    Track unpitched;
    unpitched.id = "unpitched";
    unpitched.clips.push_back(Clip{"clip_a", "source", 0, 0, duration});
    Track pitched;
    pitched.id = "pitched";
    pitched.clips.push_back(Clip{"clip_b", "source", 0, 0, duration});

    constexpr Frame seek_frame = 480000 - 2048;
    constexpr int render_frames = 4096;
    PitchCache cache;
    PitchCacheKey key{"source", "pitched", "clip_b", 2.0, test::kFixtureSampleRate, 2, "prepared_proxy"};
    cache.prefetch_range(key, *sources.get("source"), seek_frame, render_frames);

    float a_l[render_frames] = {};
    float a_r[render_frames] = {};
    float b_l[render_frames] = {};
    float b_r[render_frames] = {};
    float* a_out[2] = {a_l, a_r};
    float* b_out[2] = {b_l, b_r};
    TrackRenderer renderer;
    renderer.render(unpitched, seek_frame, render_frames, a_out, 2, sources, nullptr, test::kFixtureSampleRate, 0);
    renderer.render(pitched, seek_frame, render_frames, b_out, 2, sources, &cache, test::kFixtureSampleRate, 2);

    std::vector<float> a(static_cast<std::size_t>(render_frames * 2), 0.0f);
    std::vector<float> b(static_cast<std::size_t>(render_frames * 2), 0.0f);
    for (int f = 0; f < render_frames; ++f) {
        a[static_cast<std::size_t>(f * 2)] = a_l[f];
        a[static_cast<std::size_t>(f * 2 + 1)] = a_r[f];
        b[static_cast<std::size_t>(f * 2)] = b_l[f];
        b[static_cast<std::size_t>(f * 2 + 1)] = b_r[f];
    }
    REQUIRE(test::first_onset_frame(a, 0.2f) >= 0);
    REQUIRE(test::first_onset_frame(b, 0.2f) >= 0);
    CHECK(std::llabs(test::first_onset_frame(a, 0.2f) - test::first_onset_frame(b, 0.2f)) <= 2);
}

TEST_CASE("far pitch seeks do not produce invalid or stuck high-energy output") {
    constexpr Frame duration = 1000000;
    auto samples = test::make_stereo_sine(duration, 440.0, 0.2f);
    SourceManager sources;
    sources.register_source("source", "");
    REQUIRE(sources.store_decoded_source("source", samples, 2, test::kFixtureSampleRate, duration).is_ok());

    Track track;
    track.id = "track";
    track.clips.push_back(Clip{"clip", "source", 0, 0, duration});
    PitchCache cache;
    PitchCacheKey key{"source", "track", "clip", 2.0, test::kFixtureSampleRate, 2, "prepared_proxy"};
    TrackRenderer renderer;

    std::vector<float> previous;
    for (Frame seek_frame : {Frame{1000}, Frame{480000}, Frame{240000}, Frame{960000 - 4096}, Frame{48000}}) {
        cache.prefetch_range(key, *sources.get("source"), seek_frame, 4096);
        float left[4096] = {};
        float right[4096] = {};
        float* out[2] = {left, right};
        renderer.render(track, seek_frame, 4096, out, 2, sources, &cache, test::kFixtureSampleRate, 2);
        double dc = 0.0;
        double energy = 0.0;
        std::vector<float> current(4096, 0.0f);
        for (int f = 0; f < 4096; ++f) {
            REQUIRE(std::isfinite(left[f]));
            REQUIRE(std::isfinite(right[f]));
            CHECK(std::abs(left[f]) < 4.0f);
            dc += left[f];
            energy += static_cast<double>(left[f]) * left[f];
            current[static_cast<std::size_t>(f)] = left[f];
        }
        dc /= 4096.0;
        CHECK(std::abs(dc) < 0.1);
        CHECK(energy > 0.0);
        if (!previous.empty())
            CHECK(current != previous);
        previous = std::move(current);
    }
}

TEST_CASE("unpitched render does not require pitch cache") {
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
    TrackRenderer renderer;
    renderer.render(track, seek_frame, frames, out, 2, sources, nullptr, test::kFixtureSampleRate, 0);

    std::vector<float> rendered(static_cast<std::size_t>(frames * 2), 0.0f);
    for (int f = 0; f < frames; ++f) {
        rendered[static_cast<std::size_t>(f * 2)] = left[f];
        rendered[static_cast<std::size_t>(f * 2 + 1)] = right[f];
    }
    CHECK(test::first_onset_frame(rendered, 0.2f) == 1000);
}
