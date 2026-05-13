#include <doctest/doctest.h>
#include <lt_engine/render/pitch_resolution.h>
#include <lt_engine/session/session_adapter.h>

using namespace lt;

namespace {

Song make_song(Semitones song_transpose = 0) {
    Song song;
    song.id = "song";
    song.start_frame = 0;
    song.end_frame = 48000;
    song.transpose_semitones = song_transpose;
    return song;
}

Track make_track(TransposeBehavior behavior = TransposeBehavior::FollowsSongOrRegion) {
    Track track;
    track.id = "track";
    track.transpose_behavior = behavior;
    return track;
}

Clip make_clip(Semitones semitones = 0) {
    Clip clip;
    clip.id = "clip";
    clip.source_id = "source";
    clip.length_frames = 48000;
    clip.semitones = semitones;
    return clip;
}

}

TEST_CASE("pitch resolution combines song and clip transpose") {
    CHECK(resolve_effective_semitones(make_track(), make_clip(), make_song(2), 0) == 2);
    CHECK(resolve_effective_semitones(make_track(), make_clip(1), make_song(2), 0) == 3);
}

TEST_CASE("NeverTranspose forces zero regardless of song or clip transpose") {
    auto track = make_track(TransposeBehavior::NeverTranspose);
    CHECK(resolve_effective_semitones(track, make_clip(), make_song(2), 0) == 0);
    CHECK(resolve_effective_semitones(track, make_clip(5), make_song(2), 0) == 0);
}

TEST_CASE("pitch resolution clamps to product range") {
    CHECK(resolve_effective_semitones(make_track(), make_clip(8), make_song(12), 0) == 12);
    CHECK(resolve_effective_semitones(make_track(), make_clip(-8), make_song(-12), 0) == -12);
    CHECK(resolve_effective_semitones(make_track(), make_clip(20), make_song(), 0) == 12);
    CHECK(resolve_effective_semitones(make_track(), make_clip(-20), make_song(), 0) == -12);
}

TEST_CASE("region transpose overrides song transpose at timeline position") {
    auto song = make_song(2);
    song.regions.push_back(Region{"region", "Bridge", 100, 200, -3});
    CHECK(resolve_effective_semitones(make_track(), make_clip(1), song, 50) == 3);
    CHECK(resolve_effective_semitones(make_track(), make_clip(1), song, 150) == -2);
}

TEST_CASE("session adapter treats missing clip semitones as local zero") {
    auto result = session_from_project_json(R"({
      "id": "project",
      "songs": [{
        "id": "song",
        "duration_seconds": 1.0,
        "transposeSemitones": 2,
        "tracks": [{
          "id": "track",
          "clips": [{
            "id": "clip",
            "sourceId": "source",
            "filePath": "source.wav",
            "duration_seconds": 1.0
          }]
        }]
      }]
    })", 48000);

    REQUIRE(result.is_ok());
    auto session = result.take();
    REQUIRE(session.songs.size() == 1);
    REQUIRE(session.songs[0].tracks.size() == 1);
    REQUIRE(session.songs[0].tracks[0].clips.size() == 1);
    const auto& song = session.songs[0];
    const auto& track = song.tracks[0];
    const auto& clip = track.clips[0];
    CHECK(clip.semitones == 0);
    CHECK(resolve_effective_semitones(track, clip, song, 0) == 2);
}

TEST_CASE("session adapter keeps explicit clip semitones as local offset") {
    auto result = session_from_project_json(R"({
      "id": "project",
      "songs": [{
        "id": "song",
        "duration_seconds": 1.0,
        "transposeSemitones": 2,
        "tracks": [{
          "id": "track",
          "clips": [{
            "id": "clip",
            "sourceId": "source",
            "filePath": "source.wav",
            "duration_seconds": 1.0,
            "semitones": 1
          }]
        }]
      }]
    })", 48000);

    REQUIRE(result.is_ok());
    auto session = result.take();
    const auto& song = session.songs[0];
    const auto& track = song.tracks[0];
    const auto& clip = track.clips[0];
    CHECK(clip.semitones == 1);
    CHECK(resolve_effective_semitones(track, clip, song, 0) == 3);
}
