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

TEST_CASE("playing clock advances by one block per render call") {
    // The mixer is the sole driver of clock_->advance() during playback:
    // each render call clears the pending-start gate (the audio thread
    // has emitted a block of output) and then bumps the clock by the
    // exact number of frames the host asked for. Two render calls →
    // two block advances → position has moved by 2 × block_frames.
    SourceManager sources;
    sources.register_source("source", "");
    REQUIRE(sources.store_decoded_source("source", test::make_stereo_click(8192, 128, 1.0f),
                                         2, test::kFixtureSampleRate, 8192).is_ok());

    auto session = std::make_shared<Session>(make_one_track_session(0));
    TransportClock clock(test::kFixtureSampleRate);
    JumpScheduler scheduler;
    auto mixer = std::make_unique<Mixer>(session, &sources, &clock, &scheduler);

    float left[256] = {};
    float right[256] = {};
    float* out[2] = {left, right};
    clock.play();
    Frame before = clock.position().frame;
    mixer->render(out, 2, 256, test::kFixtureSampleRate);
    CHECK(clock.position().frame == before + 256);
    mixer->render(out, 2, 256, test::kFixtureSampleRate);
    CHECK(clock.position().frame == before + 512);
}
