#include <doctest/doctest.h>
#include <lt_engine/transport/transport_clock.h>
#include <lt_engine/session/session.h>

using namespace lt;

static Session make_two_song_session() {
    Session sess;
    sess.id          = "s";
    sess.sample_rate = 48000;

    {
        Song a; a.id = "song-a"; a.start_frame = 0; a.end_frame = 48000; a.name = "A";
        Marker m; m.id = "m1"; m.name = "Start"; m.frame = 0;
        a.markers.push_back(m);
        Region r; r.id = "r1"; r.name = "Verse"; r.start_frame = 0; r.end_frame = 24000; r.transpose_semitones = 0;
        a.regions.push_back(r);
        sess.songs.push_back(std::move(a));
    }
    {
        Song b; b.id = "song-b"; b.start_frame = 48000; b.end_frame = 96000; b.name = "B";
        sess.songs.push_back(std::move(b));
    }
    return sess;
}

// ── Initial state ────────────────────────────────────────────────────────────

TEST_CASE("clock starts stopped at frame 0") {
    TransportClock clock(48000);
    auto pos = clock.position();
    CHECK(pos.frame   == 0);
    CHECK(pos.seconds == doctest::Approx(0.0));
    CHECK(pos.state   == TransportState::Stopped);
}

// ── Play / pause / stop ──────────────────────────────────────────────────────

TEST_CASE("play changes state to Playing") {
    TransportClock clock(48000);
    clock.play();
    CHECK(clock.position().state == TransportState::Playing);
}

TEST_CASE("pause changes state to Paused") {
    TransportClock clock(48000);
    clock.play();
    clock.pause();
    CHECK(clock.position().state == TransportState::Paused);
}

TEST_CASE("stop resets frame and state") {
    TransportClock clock(48000);
    clock.play();
    clock.seek(12000);
    clock.stop();
    auto pos = clock.position();
    CHECK(pos.frame == 0);
    CHECK(pos.seconds == doctest::Approx(0.0));
    CHECK(pos.state == TransportState::Stopped);
}

// ── Seek ─────────────────────────────────────────────────────────────────────

TEST_CASE("seek sets frame and seconds correctly") {
    TransportClock clock(48000);
    clock.seek(96000);
    auto pos = clock.position();
    CHECK(pos.frame   == 96000);
    CHECK(pos.seconds == doctest::Approx(2.0));
}

// ── Advance ──────────────────────────────────────────────────────────────────

TEST_CASE("advance does not move clock when stopped") {
    TransportClock clock(48000);
    clock.advance(512);
    CHECK(clock.position().frame == 0);
}

TEST_CASE("advance does not move clock when paused") {
    TransportClock clock(48000);
    clock.play();
    clock.pause();
    clock.advance(512);
    CHECK(clock.position().frame == 0);
}

TEST_CASE("advance moves clock when playing") {
    TransportClock clock(48000);
    clock.play();
    CHECK(clock.pending_start());
    clock.clear_pending_start();
    clock.advance(512);
    CHECK(clock.position().frame == 512);
    clock.advance(512);
    CHECK(clock.position().frame == 1024);
}

TEST_CASE("seconds are correct after advance") {
    TransportClock clock(48000);
    clock.play();
    clock.clear_pending_start();
    clock.advance(48000);
    CHECK(clock.position().seconds == doctest::Approx(1.0));
}

TEST_CASE("play holds clock until first audible block is confirmed") {
    TransportClock clock(48000);
    clock.play();
    clock.advance(512);
    CHECK(clock.position().frame == 0);
    clock.clear_pending_start();
    clock.advance(512);
    CHECK(clock.position().frame == 512);
}

// ── Context resolution ───────────────────────────────────────────────────────

TEST_CASE("resolve_context finds song at frame 0") {
    TransportClock clock(48000);
    auto sess = make_two_song_session();
    clock.resolve_context(sess);
    CHECK(clock.position().song_id.has_value());
    CHECK(clock.position().song_id.value() == "song-a");
}

TEST_CASE("resolve_context finds song-b when in range") {
    TransportClock clock(48000);
    clock.seek(50000);
    auto sess = make_two_song_session();
    clock.resolve_context(sess);
    CHECK(clock.position().song_id.value() == "song-b");
    CHECK_FALSE(clock.position().region_id.has_value());
}

TEST_CASE("resolve_context finds region inside song") {
    TransportClock clock(48000);
    clock.seek(10000);
    auto sess = make_two_song_session();
    clock.resolve_context(sess);
    CHECK(clock.position().region_id.has_value());
    CHECK(clock.position().region_id.value() == "r1");
}

TEST_CASE("resolve_context clears context when between songs") {
    TransportClock clock(48000);
    clock.seek(200000);  // beyond all songs
    auto sess = make_two_song_session();
    clock.resolve_context(sess);
    CHECK_FALSE(clock.position().song_id.has_value());
    CHECK_FALSE(clock.position().region_id.has_value());
}

TEST_CASE("resolve_context finds nearest marker") {
    TransportClock clock(48000);
    clock.seek(5000);
    auto sess = make_two_song_session();
    clock.resolve_context(sess);
    CHECK(clock.position().marker_id.has_value());
    CHECK(clock.position().marker_id.value() == "m1");
}
