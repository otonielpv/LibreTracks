#include <doctest/doctest.h>
#include <lt_engine/render/pitch_resolution.h>

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
}

TEST_CASE("region transpose overrides song transpose at timeline position") {
    auto song = make_song(2);
    song.regions.push_back(Region{"region", "Bridge", 100, 200, -3});
    CHECK(resolve_effective_semitones(make_track(), make_clip(1), song, 50) == 3);
    CHECK(resolve_effective_semitones(make_track(), make_clip(1), song, 150) == -2);
}
