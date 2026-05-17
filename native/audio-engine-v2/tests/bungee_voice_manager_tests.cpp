// bungee_voice_manager_tests.cpp
//
// Phase 2 tests: the voice manager correctly builds, finds, and rebuilds
// voices in response to session/seek/transpose events.

#include "test_audio_fixtures.h"

#include <doctest/doctest.h>
#include <lt_engine/pitch/bungee_voice_manager.h>
#include <lt_engine/session/session.h>
#include <lt_engine/sources/source_manager.h>

#include <vector>

using namespace lt;

namespace {

constexpr int kSR       = test::kFixtureSampleRate;
constexpr int kChannels = 2;
constexpr int kBlock    = 480;

Session make_one_transposed_clip_session(Semitones semitones) {
    Session s;
    s.id          = "s";
    s.sample_rate = kSR;
    Source src;
    src.id        = "src1";
    src.file_path = "";
    s.sources.push_back(src);
    Song song;
    song.id          = "song1";
    song.name        = "song";
    song.start_frame = 0;
    song.end_frame   = kSR * 4;
    song.transpose_semitones = semitones;
    Track track;
    track.id   = "trk1";
    track.kind = TrackKind::Audio;
    track.transpose_behavior = TransposeBehavior::FollowsSongOrRegion;
    track.clips.push_back(Clip{"clip1", "src1", /*tl*/0, /*src*/0, kSR * 4});
    song.tracks.push_back(track);
    s.songs.push_back(song);
    return s;
}

bool register_loaded_source(SourceManager& sm, const Id& id, Frame frames) {
    sm.register_source(id, "");
    auto pcm = test::make_stereo_sine(frames, 440.0, 0.5f);
    return sm.store_decoded_source(id, std::move(pcm), kChannels, kSR, frames).is_ok();
}

} // namespace

TEST_CASE("BungeeVoiceManager prepares cleanly") {
    BungeeVoiceManager mgr;
    const bool ok = mgr.prepare(kSR, kChannels, kBlock);
#if LT_ENGINE_HAVE_BUNGEE
    CHECK(ok);
    CHECK(mgr.is_available());
#else
    CHECK_FALSE(ok);
    CHECK_FALSE(mgr.is_available());
#endif
}

TEST_CASE("rebuild_for_session creates a voice for a transposed clip") {
    BungeeVoiceManager mgr;
    if (!mgr.prepare(kSR, kChannels, kBlock)) return;  // stub build path

    SourceManager sm;
    REQUIRE(register_loaded_source(sm, "src1", kSR * 4));

    auto session = make_one_transposed_clip_session(/*semitones=*/-2);
    mgr.rebuild_for_session(session, sm, /*playhead=*/0);

    BungeePitchVoice* v = mgr.voice_for("clip1");
#if LT_ENGINE_HAVE_BUNGEE
    CHECK(v != nullptr);
    if (v) CHECK(v->is_ready());
#endif
    // Wrong clip id — no voice.
    CHECK(mgr.voice_for("clip_other") == nullptr);
}

TEST_CASE("voice pointer survives a transpose change (no rebuild)") {
    // Voices are keyed per-clip, not per-(clip, semitones). A pitch change
    // must NOT recreate the voice — the audio thread passes the new pitch
    // via Bungee's per-grain pitch_scale parameter instead. This test
    // protects against re-introducing the ~200 ms silence on transpose.
    BungeeVoiceManager mgr;
    if (!mgr.prepare(kSR, kChannels, kBlock)) return;

    SourceManager sm;
    REQUIRE(register_loaded_source(sm, "src1", kSR * 4));

    auto session = make_one_transposed_clip_session(/*semitones=*/-2);
    mgr.rebuild_for_session(session, sm, /*playhead=*/0);
    BungeePitchVoice* before = mgr.voice_for("clip1");

    // Mutate the session's transpose (simulating a region transpose change)
    // and rebuild_for_session at the same playhead. The voice for "clip1"
    // must be the same pointer — pitch parameter is handled at render time.
    session.songs[0].transpose_semitones = +3;
    mgr.rebuild_for_session(session, sm, /*playhead=*/0);
    BungeePitchVoice* after = mgr.voice_for("clip1");

#if LT_ENGINE_HAVE_BUNGEE
    CHECK(before != nullptr);
    CHECK(after  != nullptr);
    CHECK(before == after);
#endif
}

TEST_CASE("rebuild_for_seek replaces voices at the new playhead") {
    BungeeVoiceManager mgr;
    if (!mgr.prepare(kSR, kChannels, kBlock)) return;

    SourceManager sm;
    REQUIRE(register_loaded_source(sm, "src1", kSR * 4));

    auto session = make_one_transposed_clip_session(/*semitones=*/-2);
    mgr.rebuild_for_session(session, sm, /*playhead=*/0);
    BungeePitchVoice* before = mgr.voice_for("clip1");

    // Seek to 1 second into the clip.
    mgr.rebuild_for_seek(/*target*/kSR * 1, session, sm);
    BungeePitchVoice* after = mgr.voice_for("clip1");

#if LT_ENGINE_HAVE_BUNGEE
    CHECK(before != nullptr);
    CHECK(after  != nullptr);
    // rebuild_for_seek per Bungee issue #16 destroys and reconstructs voices,
    // so the pointer must differ.
    CHECK(before != after);
#else
    CHECK(before == nullptr);
    CHECK(after  == nullptr);
#endif
}

TEST_CASE("rebuild_for_session keeps the same voice pointer when clip is unchanged") {
    BungeeVoiceManager mgr;
    if (!mgr.prepare(kSR, kChannels, kBlock)) return;

    SourceManager sm;
    REQUIRE(register_loaded_source(sm, "src1", kSR * 4));

    auto session = make_one_transposed_clip_session(/*semitones=*/-2);
    mgr.rebuild_for_session(session, sm, /*playhead=*/0);
    BungeePitchVoice* before = mgr.voice_for("clip1");

    // Same session on the next rebuild — voice should be reused, not recreated.
    mgr.rebuild_for_session(session, sm, /*playhead=*/0);
    BungeePitchVoice* after = mgr.voice_for("clip1");

#if LT_ENGINE_HAVE_BUNGEE
    CHECK(before != nullptr);
    CHECK(after  != nullptr);
    CHECK(before == after);
#endif
}

TEST_CASE("clear() drops all voices") {
    BungeeVoiceManager mgr;
    if (!mgr.prepare(kSR, kChannels, kBlock)) return;

    SourceManager sm;
    REQUIRE(register_loaded_source(sm, "src1", kSR * 4));

    auto session = make_one_transposed_clip_session(-2);
    mgr.rebuild_for_session(session, sm, 0);
#if LT_ENGINE_HAVE_BUNGEE
    REQUIRE(mgr.voice_for("clip1") != nullptr);
#endif

    mgr.clear();
    CHECK(mgr.voice_for("clip1") == nullptr);
}
