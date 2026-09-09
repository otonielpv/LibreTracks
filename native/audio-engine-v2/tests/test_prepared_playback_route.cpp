// Playing a prepared track: the file already carries warp and pitch, so the
// renderer must take the direct path over it.
//
// Getting this wrong is not a small mistake. Running the stretcher over audio
// that was already stretched applies the ratio twice, and the track walks away
// from the click — the exact failure the whole feature exists to avoid.
#include <doctest/doctest.h>

#include <lt_engine/core/commands.h>
#include <lt_engine/render/pitch_resolution.h>
#include <lt_engine/session/session.h>

#include <variant>

using namespace lt;

namespace {

constexpr int kSR = 48000;

Song warped_song(bool prepared, Semitones semitones = 0) {
    Song song;
    song.id = "song";
    song.start_frame = 0;
    song.end_frame = kSR * 60;
    song.bpm = 120.0;

    Region region;
    region.id = "region";
    region.start_frame = 0;
    region.end_frame = song.end_frame;
    region.warp_enabled = true;
    region.warp_source_bpm = 100.0;  // ratio 1.2
    region.transpose_semitones = semitones;
    song.regions.push_back(region);

    Track track;
    track.id = "trk";
    track.kind = TrackKind::Audio;
    track.prepared_render = prepared;
    track.clips.push_back(Clip{"clip", "src", 0, 0, kSR * 30});
    song.tracks.push_back(std::move(track));
    return song;
}

} // namespace

TEST_CASE("a prepared track takes the direct path even inside a warped region") {
    const Song warped = warped_song(/*prepared=*/false);
    const auto live = resolve_pitch_render_decision(warped.tracks[0], warped.tracks[0].clips[0],
                                                    warped, 0);
    REQUIRE(live.path == ClipPathKind::Stretched);
    CHECK(live.warp_active);
    CHECK(live.warp_time_ratio == doctest::Approx(1.2));

    const Song prepared = warped_song(/*prepared=*/true);
    const auto decision = resolve_pitch_render_decision(
        prepared.tracks[0], prepared.tracks[0].clips[0], prepared, 0);
    CHECK(decision.path == ClipPathKind::Direct);
    // Not just the path: a ratio left in place would stretch the file again.
    CHECK_FALSE(decision.warp_active);
    CHECK(decision.warp_time_ratio == doctest::Approx(1.0));
}

TEST_CASE("a prepared track is not transposed a second time either") {
    const Song transposed = warped_song(/*prepared=*/false, 3);
    const auto live = resolve_pitch_render_decision(
        transposed.tracks[0], transposed.tracks[0].clips[0], transposed, 0);
    // Warp absorbs the pitch for a normal track, but the ratio is still live.
    CHECK(live.warp_active);

    Song prepared = warped_song(/*prepared=*/true, 3);
    prepared.tracks[0].transpose_behavior = TransposeBehavior::FollowsSongOrRegion;
    const auto decision = resolve_pitch_render_decision(
        prepared.tracks[0], prepared.tracks[0].clips[0], prepared, 0);
    CHECK(decision.path == ClipPathKind::Direct);
    CHECK(decision.effective_semitones == 0);
    CHECK_FALSE(decision.needs_pitch);
    CHECK(decision.pitch_scale == doctest::Approx(1.0));
}

TEST_CASE("a varispeed region does not stretch a prepared track either") {
    // No warp, only transposition: a normal track goes varispeed. A prepared
    // one already has that baked in.
    Song song = warped_song(/*prepared=*/false, 3);
    song.regions[0].warp_enabled = false;
    const auto live =
        resolve_pitch_render_decision(song.tracks[0], song.tracks[0].clips[0], song, 0);
    REQUIRE(live.path == ClipPathKind::Varispeed);

    song.tracks[0].prepared_render = true;
    const auto decision =
        resolve_pitch_render_decision(song.tracks[0], song.tracks[0].clips[0], song, 0);
    CHECK(decision.path == ClipPathKind::Direct);
}

TEST_CASE("a hot track edit does not clear the prepared flag") {
    // Every place that parses a track has to carry this field. The region
    // parsers already shipped this bug once: one of three sites omitted a
    // field, and editing while playing silently reset engine state. Here the
    // cost would be a prepared track warped twice, mid-performance.
    const std::string json = R"({
        "type": "UpsertSongTracks",
        "song_id": "song",
        "tracks": [{
            "id": "trk",
            "name": "Track",
            "prepared_render": true,
            "clips": []
        }],
        "sources": []
    })";
    const auto parsed = command_from_json(json);
    REQUIRE(std::holds_alternative<CmdUpsertSongTracks>(parsed));
    const auto& command = std::get<CmdUpsertSongTracks>(parsed);
    REQUIRE(command.tracks.size() == 1);
    CHECK(command.tracks[0].prepared_render);

    // And the default is false, so a session that knows nothing about prepared
    // audio keeps playing through the stretcher.
    const std::string plain = R"({
        "type": "UpsertSongTracks",
        "song_id": "song",
        "tracks": [{"id": "trk", "name": "Track", "clips": []}],
        "sources": []
    })";
    const auto plain_parsed = command_from_json(plain);
    REQUIRE(std::holds_alternative<CmdUpsertSongTracks>(plain_parsed));
    CHECK_FALSE(std::get<CmdUpsertSongTracks>(plain_parsed).tracks[0].prepared_render);
}
