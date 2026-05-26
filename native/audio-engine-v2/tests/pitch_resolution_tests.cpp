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

TEST_CASE("NeverTranspose only suppresses pitch when warp is active") {
    // Under no-warp pitch IS time-stretch, so a NeverTranspose track must
    // still follow the region's varispeed to stay aligned with the rest of
    // the song. NeverTranspose only takes effect under warp, where Bungee
    // decouples pitch from duration and the track can ignore the semitone
    // shift while still following warp's time-stretch.
    auto track = make_track(TransposeBehavior::NeverTranspose);
    // Without warp: NeverTranspose is ignored, the song transpose applies.
    CHECK(resolve_effective_semitones(track, make_clip(), make_song(2), 0) == 2);
    CHECK(resolve_effective_semitones(track, make_clip(5), make_song(2), 0) == 7);

    // With warp active: NeverTranspose takes effect, pitch is suppressed.
    auto song_warp = make_song(2);
    song_warp.bpm = 120.0;
    Region region;
    region.id = "r";
    region.start_frame = 0;
    region.end_frame = 48000;
    region.warp_enabled = true;
    region.warp_source_bpm = 100.0;
    song_warp.regions.push_back(region);
    CHECK(resolve_effective_semitones(track, make_clip(), song_warp, 0) == 0);
    CHECK(resolve_effective_semitones(track, make_clip(5), song_warp, 0) == 0);

    // Warp mode still suppresses pitch for NeverTranspose tracks when the
    // ratio is exactly 1.0; the UI toggle means "preserve pitch", not only
    // "use a non-identity time stretch".
    song_warp.regions[0].warp_source_bpm = 120.0;
    CHECK(resolve_effective_semitones(track, make_clip(), song_warp, 0) == 0);
    CHECK(resolve_effective_semitones(track, make_clip(5), song_warp, 0) == 0);
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

TEST_CASE("path decision: no warp + no pitch -> Direct") {
    auto song = make_song(0);
    auto track = make_track();
    auto clip = make_clip(0);
    const auto d = resolve_pitch_render_decision(track, clip, song, 0);
    CHECK(d.path == ClipPathKind::Direct);
    CHECK(d.effective_semitones == 0);
    CHECK(d.warp_active == false);
    CHECK(d.pitch_scale == doctest::Approx(1.0));
}

TEST_CASE("path decision: no warp + pitch -> Varispeed") {
    auto song = make_song(3);
    auto track = make_track();
    auto clip = make_clip(0);
    const auto d = resolve_pitch_render_decision(track, clip, song, 0);
    CHECK(d.path == ClipPathKind::Varispeed);
    CHECK(d.effective_semitones == 3);
    CHECK(d.warp_active == false);
    CHECK(d.pitch_scale > 1.0);
}

TEST_CASE("path decision: warp + no pitch -> Stretched") {
    auto song = make_song(0);
    song.bpm = 120.0;
    Region region;
    region.id = "r";
    region.start_frame = 0;
    region.end_frame = 48000;
    region.warp_enabled = true;
    region.warp_source_bpm = 100.0;
    song.regions.push_back(region);
    auto track = make_track();
    auto clip = make_clip(0);
    const auto d = resolve_pitch_render_decision(track, clip, song, 0);
    CHECK(d.path == ClipPathKind::Stretched);
    CHECK(d.warp_active == true);
    CHECK(d.warp_time_ratio == doctest::Approx(1.2));
}

TEST_CASE("path decision: warp + pitch -> Stretched (Bungee handles both)") {
    auto song = make_song(0);
    song.bpm = 120.0;
    Region region;
    region.id = "r";
    region.start_frame = 0;
    region.end_frame = 48000;
    region.warp_enabled = true;
    region.warp_source_bpm = 100.0;
    region.transpose_semitones = 5;
    song.regions.push_back(region);
    auto track = make_track();
    auto clip = make_clip(0);
    const auto d = resolve_pitch_render_decision(track, clip, song, 0);
    CHECK(d.path == ClipPathKind::Stretched);
    CHECK(d.warp_active == true);
    CHECK(d.effective_semitones == 5);
}

TEST_CASE("path decision: NeverTranspose + warp -> Stretched even though pitch is 0") {
    auto song = make_song(7);
    song.bpm = 120.0;
    Region region;
    region.id = "r";
    region.start_frame = 0;
    region.end_frame = 48000;
    region.warp_enabled = true;
    region.warp_source_bpm = 90.0;
    song.regions.push_back(region);
    auto track = make_track(TransposeBehavior::NeverTranspose);
    auto clip = make_clip(0);
    const auto d = resolve_pitch_render_decision(track, clip, song, 0);
    CHECK(d.path == ClipPathKind::Stretched);
    CHECK(d.effective_semitones == 0);
    CHECK(d.warp_active == true);
}

TEST_CASE("path decision: NeverTranspose + unity-ratio warp suppresses pitch") {
    auto song = make_song(7);
    song.bpm = 120.0;
    Region region;
    region.id = "r";
    region.start_frame = 0;
    region.end_frame = 48000;
    region.warp_enabled = true;
    region.warp_source_bpm = 120.0;
    song.regions.push_back(region);
    auto track = make_track(TransposeBehavior::NeverTranspose);
    auto clip = make_clip(0);
    const auto d = resolve_pitch_render_decision(track, clip, song, 0);
    CHECK(d.path == ClipPathKind::Stretched);
    CHECK(d.effective_semitones == 0);
    CHECK(d.warp_active == true);
    CHECK(d.warp_time_ratio == doctest::Approx(1.0));
    CHECK(d.pitch_scale == doctest::Approx(1.0));
}

TEST_CASE("path decision: NeverTranspose + no warp + region pitch -> Varispeed (track follows)") {
    // Without warp, pitch IS time-stretch (varispeed). A NeverTranspose track
    // that opted out would render at original duration and slip out of sync
    // with the rest of the song, so we deliberately ignore NeverTranspose
    // here — the track follows the region's varispeed.
    auto song = make_song(0);
    song.regions.push_back(Region{"r", "r", 0, 48000, 5});
    auto track = make_track(TransposeBehavior::NeverTranspose);
    auto clip = make_clip(0);
    const auto d = resolve_pitch_render_decision(track, clip, song, 0);
    CHECK(d.path == ClipPathKind::Varispeed);
    CHECK(d.effective_semitones == 5);
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
