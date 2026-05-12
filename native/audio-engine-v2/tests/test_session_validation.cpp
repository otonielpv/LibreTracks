#include <doctest/doctest.h>
#include <lt_engine/session/session.h>
#include <lt_engine/session/session_adapter.h>

using namespace lt;

// ── Helpers ─────────────────────────────────────────────────────────────────

static Source make_source(Id id, const std::string& path = "/audio/stem.wav") {
    Source s;
    s.id                    = std::move(id);
    s.file_path             = path;
    s.original_sample_rate  = 48000;
    s.channel_count         = 2;
    s.duration_frames       = 480000;
    return s;
}

static Clip make_clip(Id id, Id source_id, Frame start, Frame len) {
    Clip c;
    c.id                   = std::move(id);
    c.source_id            = std::move(source_id);
    c.timeline_start_frame = start;
    c.source_start_frame   = 0;
    c.length_frames        = len;
    c.gain                 = 1.0f;
    return c;
}

static Track make_track(Id id, std::vector<Clip> clips = {}) {
    Track t;
    t.id    = std::move(id);
    t.name  = "Track";
    t.clips = std::move(clips);
    return t;
}

static Song make_song(Id id, Frame start, Frame end) {
    Song s;
    s.id          = std::move(id);
    s.name        = "Song";
    s.start_frame = start;
    s.end_frame   = end;
    return s;
}

static Session make_valid_session() {
    Session sess;
    sess.id          = "session-1";
    sess.name        = "Test";
    sess.sample_rate = 48000;
    sess.sources.push_back(make_source("src-1"));

    Song song = make_song("song-1", 0, 480000);
    song.tracks.push_back(make_track("track-1", { make_clip("clip-1", "src-1", 0, 480000) }));

    Marker m; m.id = "m1"; m.name = "Intro"; m.frame = 1000;
    song.markers.push_back(m);

    Region r; r.id = "r1"; r.name = "Verse"; r.start_frame = 0; r.end_frame = 96000; r.transpose_semitones = 0;
    song.regions.push_back(r);

    sess.songs.push_back(std::move(song));
    return sess;
}

// ── Tests ────────────────────────────────────────────────────────────────────

TEST_CASE("valid session passes validation") {
    auto sess = make_valid_session();
    auto r = validate_session(sess);
    CHECK(r.is_ok());
}

TEST_CASE("empty session id fails") {
    auto sess = make_valid_session();
    sess.id = "";
    CHECK(validate_session(sess).is_err());
}

TEST_CASE("sample_rate zero fails") {
    auto sess = make_valid_session();
    sess.sample_rate = 0;
    CHECK(validate_session(sess).is_err());
}

TEST_CASE("song end_frame <= start_frame fails") {
    auto sess = make_valid_session();
    sess.songs[0].end_frame = sess.songs[0].start_frame;
    CHECK(validate_session(sess).is_err());
}

TEST_CASE("clip references unknown source") {
    auto sess = make_valid_session();
    sess.songs[0].tracks[0].clips[0].source_id = "nonexistent";
    CHECK(validate_session(sess).is_err());
}

TEST_CASE("clip length_frames zero fails") {
    auto sess = make_valid_session();
    sess.songs[0].tracks[0].clips[0].length_frames = 0;
    CHECK(validate_session(sess).is_err());
}

TEST_CASE("duplicate IDs fail") {
    auto sess = make_valid_session();
    // Give the track the same id as the song.
    sess.songs[0].tracks[0].id = "song-1";
    CHECK(validate_session(sess).is_err());
}

TEST_CASE("marker outside song bounds fails") {
    auto sess = make_valid_session();
    sess.songs[0].markers[0].frame = 999999;   // beyond song end
    CHECK(validate_session(sess).is_err());
}

TEST_CASE("region outside song bounds fails") {
    auto sess = make_valid_session();
    sess.songs[0].regions[0].end_frame = 999999;
    CHECK(validate_session(sess).is_err());
}

TEST_CASE("region end <= start fails") {
    auto sess = make_valid_session();
    sess.songs[0].regions[0].end_frame = sess.songs[0].regions[0].start_frame;
    CHECK(validate_session(sess).is_err());
}

TEST_CASE("transpose outside [-12,12] fails") {
    auto sess = make_valid_session();
    sess.songs[0].transpose_semitones = 13;
    CHECK(validate_session(sess).is_err());

    sess.songs[0].transpose_semitones = -13;
    CHECK(validate_session(sess).is_err());
}

TEST_CASE("transpose at boundary values passes") {
    auto sess = make_valid_session();
    sess.songs[0].transpose_semitones = 12;
    CHECK(validate_session(sess).is_ok());
    sess.songs[0].transpose_semitones = -12;
    CHECK(validate_session(sess).is_ok());
}

TEST_CASE("track never_transpose is valid") {
    auto sess = make_valid_session();
    sess.songs[0].tracks[0].transpose_behavior = TransposeBehavior::NeverTranspose;
    CHECK(validate_session(sess).is_ok());
}

TEST_CASE("session with no songs is valid") {
    Session sess;
    sess.id          = "empty";
    sess.sample_rate = 48000;
    CHECK(validate_session(sess).is_ok());
}

TEST_CASE("multiple songs with unique IDs passes") {
    auto sess = make_valid_session();
    Song song2 = make_song("song-2", 480000, 960000);
    song2.tracks.push_back(make_track("track-2"));
    sess.songs.push_back(std::move(song2));
    CHECK(validate_session(sess).is_ok());
}

TEST_CASE("session adapter maps LibreTracks camelCase song JSON") {
    const char* raw = R"json({
      "id": "song-1",
      "title": "Adapter Song",
      "durationSeconds": 10.0,
      "regions": [
        { "id": "region-1", "name": "Verse", "startSeconds": 1.0, "endSeconds": 4.0, "transposeSemitones": 2 }
      ],
      "sectionMarkers": [
        { "id": "marker-1", "name": "Intro", "startSeconds": 2.0 }
      ],
      "tracks": [
        { "id": "track-1", "name": "Stem", "kind": "audio", "volume": 0.75, "muted": false, "solo": false, "transposeEnabled": false }
      ],
      "clips": [
        { "id": "clip-1", "trackId": "track-1", "filePath": "audio/stem.wav", "timelineStartSeconds": 0.5, "sourceStartSeconds": 0.25, "durationSeconds": 3.0, "gain": 0.8 }
      ]
    })json";

    auto result = session_from_project_json(raw, 48000);
    REQUIRE(result.is_ok());
    auto session = result.take();

    REQUIRE(session.songs.size() == 1);
    CHECK(session.songs[0].end_frame == 480000);
    REQUIRE(session.songs[0].tracks.size() == 1);
    CHECK(session.songs[0].tracks[0].transpose_behavior == TransposeBehavior::NeverTranspose);
    REQUIRE(session.songs[0].tracks[0].clips.size() == 1);
    CHECK(session.songs[0].tracks[0].clips[0].source_id == "audio/stem.wav");
    CHECK(session.songs[0].tracks[0].clips[0].timeline_start_frame == 24000);
    CHECK(session.songs[0].tracks[0].clips[0].source_start_frame == 12000);
    CHECK(session.songs[0].regions[0].transpose_semitones == 2);
    CHECK(session.songs[0].markers[0].frame == 96000);
}
