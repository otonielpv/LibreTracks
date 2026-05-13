#include "test_audio_fixtures.h"

#include <doctest/doctest.h>
#include <lt_engine/render/mixer.h>
#include <lt_engine/sources/source_manager.h>

#include <memory>

using namespace lt;

namespace {

Session make_one_track_session(Semitones song_transpose) {
    Session session;
    Song song;
    song.id = "song";
    song.start_frame = 0;
    song.end_frame = 8192;
    song.transpose_semitones = song_transpose;

    Track track;
    track.id = "track";
    track.gain = 1.0f;
    track.clips.push_back(Clip{"clip", "source", 0, 0, 8192});
    song.tracks.push_back(track);
    session.songs.push_back(song);
    return session;
}

}

TEST_CASE("committed audio playhead advances only after successful render") {
    SourceManager sources;
    sources.register_source("source", "");
    REQUIRE(sources.store_decoded_source("source", test::make_stereo_click(8192, 128, 1.0f),
                                         2, test::kFixtureSampleRate, 8192).is_ok());

    auto session = std::make_shared<Session>(make_one_track_session(0));
    TransportClock clock(test::kFixtureSampleRate);
    JumpScheduler scheduler;
    PitchCache cache;
    auto mixer = std::make_unique<Mixer>(session, &sources, &clock, &scheduler, &cache);

    float left[256] = {};
    float right[256] = {};
    float* out[2] = {left, right};
    clock.play();
    Frame before = clock.position().frame;
    mixer->render(out, 2, 256, test::kFixtureSampleRate);
    CHECK(clock.position().frame == before + 256);
}

TEST_CASE("missing pitch proxy does not prevent transport advancement") {
    SourceManager sources;
    sources.register_source("source", "");
    REQUIRE(sources.store_decoded_source("source", test::make_stereo_click(8192, 128, 1.0f),
                                         2, test::kFixtureSampleRate, 8192).is_ok());

    auto session = std::make_shared<Session>(make_one_track_session(2));
    TransportClock clock(test::kFixtureSampleRate);
    JumpScheduler scheduler;
    PitchCache cache;
    auto mixer = std::make_unique<Mixer>(session, &sources, &clock, &scheduler, &cache);

    float left[256] = {};
    float right[256] = {};
    float* out[2] = {left, right};
    clock.play();
    Frame before = clock.position().frame;
    mixer->render(out, 2, 256, test::kFixtureSampleRate);
    CHECK(cache.diagnostics().proxy_blocks_missing > 0);
    CHECK(clock.position().frame == before + 256);
}
