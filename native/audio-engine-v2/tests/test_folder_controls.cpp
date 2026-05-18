#include "test_audio_fixtures.h"

#include <doctest/doctest.h>
#include <lt_engine/render/mixer.h>
#include <lt_engine/render/pitch_resolution.h>
#include <lt_engine/session/session_adapter.h>
#include <lt_engine/sources/source_manager.h>
#include <lt_engine/transport/transport_clock.h>
#include <lt_engine/scheduler/jump_scheduler.h>

#include <algorithm>
#include <cmath>
#include <vector>

using namespace lt;

namespace {

constexpr int kBlock = 512;
constexpr int kSR    = test::kFixtureSampleRate;

float peak(const std::vector<float>& s) {
    float p = 0.f;
    for (float v : s) p = std::max(p, std::abs(v));
    return p;
}

double rms(const std::vector<float>& s) {
    double sum = 0.0;
    for (float v : s) sum += static_cast<double>(v) * v;
    return std::sqrt(sum / std::max<std::size_t>(1, s.size()));
}

// Render N blocks, capturing only the last block's output.
void render_blocks(Mixer& mixer, TransportClock& clock, int n,
                   std::vector<float>& left, std::vector<float>& right) {
    left.assign(kBlock, 0.f);
    right.assign(kBlock, 0.f);
    float* out[2] = {left.data(), right.data()};
    for (int i = 0; i < n; ++i)
        mixer.render(out, 2, kBlock, clock.sample_rate());
}

void add_source(SourceManager& sources, const Id& id,
                float amplitude = 0.5f, Frame dur = kSR * 4) {
    sources.register_source(id, "");
    REQUIRE(sources.store_decoded_source(id,
        test::make_stereo_sine(dur, 440.0, amplitude),
        2, kSR, dur).is_ok());
}

// Build a session with a folder track and N audio children.
// The folder track id is "folder".
// Audio child ids are "child-0", "child-1", ...
Session folder_session(int num_children, bool pitched = false) {
    Session session;
    session.id = "session";
    session.sample_rate = kSR;

    Song song;
    song.id = "song";
    song.start_frame = 0;
    song.end_frame = kSR * 8;
    if (pitched)
        song.transpose_semitones = 2;

    // Folder track (no clips, no audio)
    Track folder;
    folder.id = "folder";
    folder.name = "Folder";
    folder.kind = TrackKind::Folder;
    song.tracks.push_back(folder);

    for (int i = 0; i < num_children; ++i) {
        const Id src_id  = "src-" + std::to_string(i);
        const Id child_id = "child-" + std::to_string(i);
        session.sources.push_back(Source{src_id, ""});

        Track child;
        child.id = child_id;
        child.name = "Child " + std::to_string(i);
        child.kind = TrackKind::Audio;
        child.parent_track_id = "folder";
        child.clips.push_back(Clip{
            "clip-" + std::to_string(i), src_id,
            0, 0, kSR * 8
        });
        song.tracks.push_back(child);
    }

    session.songs.push_back(song);
    return session;
}

} // namespace

// ---------------------------------------------------------------------------
// Folder volume scales child output
// ---------------------------------------------------------------------------
TEST_CASE("folder_volume_controls_child_audio") {
    SourceManager sources;
    add_source(sources, "src-0");
    auto session = std::make_shared<Session>(folder_session(1));
    TransportClock clock(kSR);
    JumpScheduler scheduler;
    Mixer mixer(session, &sources, &clock, &scheduler);
    clock.play();

    std::vector<float> left, right;
    render_blocks(mixer, clock, 20, left, right);
    const double baseline = rms(left);
    REQUIRE(baseline > 0.01);

    mixer.set_track_gain("folder", 0.25f);
    render_blocks(mixer, clock, 30, left, right);
    CHECK(rms(left) == doctest::Approx(baseline * 0.25).epsilon(0.25));
}

// ---------------------------------------------------------------------------
// Folder mute silences children
// ---------------------------------------------------------------------------
TEST_CASE("folder_mute_mutes_children") {
    SourceManager sources;
    add_source(sources, "src-0");
    add_source(sources, "src-1");
    auto session = std::make_shared<Session>(folder_session(2));
    TransportClock clock(kSR);
    JumpScheduler scheduler;
    Mixer mixer(session, &sources, &clock, &scheduler);
    clock.play();

    std::vector<float> left, right;
    render_blocks(mixer, clock, 10, left, right);
    REQUIRE(peak(left) > 0.01f);

    mixer.set_track_mute("folder", true);
    render_blocks(mixer, clock, 30, left, right);
    CHECK(peak(left) < 0.005f);
    CHECK(peak(right) < 0.005f);

    mixer.set_track_mute("folder", false);
    render_blocks(mixer, clock, 30, left, right);
    CHECK(peak(left) > 0.01f);
}

// ---------------------------------------------------------------------------
// Folder pan pans children
// ---------------------------------------------------------------------------
TEST_CASE("folder_pan_pans_children") {
    SourceManager sources;
    add_source(sources, "src-0");
    auto session = std::make_shared<Session>(folder_session(1));
    TransportClock clock(kSR);
    JumpScheduler scheduler;
    Mixer mixer(session, &sources, &clock, &scheduler);
    clock.play();

    std::vector<float> left, right;
    render_blocks(mixer, clock, 10, left, right);
    REQUIRE(peak(left) > 0.01f);
    REQUIRE(peak(right) > 0.01f);

    mixer.set_track_pan("folder", -1.0f);
    render_blocks(mixer, clock, 30, left, right);
    CHECK(peak(left) > 0.01f);
    CHECK(peak(right) < 0.005f);

    mixer.set_track_pan("folder", 1.0f);
    render_blocks(mixer, clock, 30, left, right);
    CHECK(peak(right) > 0.01f);
    CHECK(peak(left) < 0.005f);
}

// ---------------------------------------------------------------------------
// Parent + child gains multiply
// ---------------------------------------------------------------------------
TEST_CASE("parent_and_child_controls_multiply") {
    SourceManager sources;
    add_source(sources, "src-0");
    auto session = std::make_shared<Session>(folder_session(1));
    TransportClock clock(kSR);
    JumpScheduler scheduler;
    Mixer mixer(session, &sources, &clock, &scheduler);
    clock.play();

    std::vector<float> left, right;
    render_blocks(mixer, clock, 20, left, right);
    const double baseline = rms(left);
    REQUIRE(baseline > 0.01);

    mixer.set_track_gain("folder", 0.5f);
    mixer.set_track_gain("child-0", 0.5f);
    render_blocks(mixer, clock, 30, left, right);
    CHECK(rms(left) == doctest::Approx(baseline * 0.25).epsilon(0.30));
}

// ---------------------------------------------------------------------------
// Folder solo includes descendants
// ---------------------------------------------------------------------------
TEST_CASE("folder_solo_includes_descendants") {
    SourceManager sources;
    add_source(sources, "src-A0", 0.5f);
    add_source(sources, "src-B0", 0.5f);

    Session session;
    session.id = "session";
    session.sample_rate = kSR;
    Song song;
    song.id = "song";
    song.start_frame = 0;
    song.end_frame = kSR * 8;

    Track folderA; folderA.id = "folderA"; folderA.kind = TrackKind::Folder;
    Track childA; childA.id = "childA"; childA.kind = TrackKind::Audio;
    childA.parent_track_id = "folderA";
    childA.clips.push_back(Clip{"clipA", "src-A0", 0, 0, kSR * 8});

    Track folderB; folderB.id = "folderB"; folderB.kind = TrackKind::Folder;
    Track childB; childB.id = "childB"; childB.kind = TrackKind::Audio;
    childB.parent_track_id = "folderB";
    childB.clips.push_back(Clip{"clipB", "src-B0", 0, 0, kSR * 8});

    session.sources = {Source{"src-A0", ""}, Source{"src-B0", ""}};
    song.tracks = {folderA, childA, folderB, childB};
    session.songs.push_back(song);
    auto shared = std::make_shared<Session>(session);

    TransportClock clock(kSR);
    JumpScheduler scheduler;
    Mixer mixer(shared, &sources, &clock, &scheduler);
    clock.play();

    std::vector<float> left, right;
    render_blocks(mixer, clock, 10, left, right);
    REQUIRE(rms(left) > 0.05);

    // Solo folder A — only descendants of A should be heard.
    mixer.set_track_solo("folderA", true);
    render_blocks(mixer, clock, 30, left, right);
    const double solo_a_level = rms(left);
    CHECK(solo_a_level > 0.01); // childA is audible

    mixer.set_track_solo("folderA", false);
    render_blocks(mixer, clock, 30, left, right);
    const double both_level = rms(left);
    CHECK(both_level > solo_a_level); // both folders now heard
}

// ---------------------------------------------------------------------------
// Pitched child survives gain action on track
// ---------------------------------------------------------------------------
TEST_CASE("resolve_pitch_render_decision_matches_effective_semitones") {
    using namespace lt;
    Song song;
    song.id = "song"; song.start_frame = 0; song.end_frame = 48000;
    song.transpose_semitones = 2;
    Region region;
    region.id = "r"; region.start_frame = 1000; region.end_frame = 2000;
    region.transpose_semitones = -3; // clip.semitones=1, region=-3 → effective=-2 (needs_pitch=true)
    song.regions.push_back(region);

    Track track; track.id = "t"; track.transpose_behavior = TransposeBehavior::FollowsSongOrRegion;
    Clip clip; clip.id = "c"; clip.semitones = 1;

    // Outside region.
    {
        const auto dec = resolve_pitch_render_decision(track, clip, song, 500);
        CHECK(dec.needs_pitch == true);
        CHECK(dec.is_never_transpose == false);
        CHECK(dec.effective_semitones == resolve_effective_semitones(track, clip, song, 500));
    }
    // Inside region.
    {
        const auto dec = resolve_pitch_render_decision(track, clip, song, 1500);
        CHECK(dec.needs_pitch == true);
        CHECK(dec.effective_semitones == resolve_effective_semitones(track, clip, song, 1500));
    }
    // NeverTranspose.
    {
        Track nt_track; nt_track.id = "nt"; nt_track.transpose_behavior = TransposeBehavior::NeverTranspose;
        const auto dec = resolve_pitch_render_decision(nt_track, clip, song, 500);
        CHECK(dec.needs_pitch == false);
        CHECK(dec.is_never_transpose == true);
        CHECK(dec.effective_semitones == 0);
    }
}

// ---------------------------------------------------------------------------
// Session adapter: region with length_seconds is correctly parsed.
// ---------------------------------------------------------------------------
TEST_CASE("session_adapter_region_length_seconds_parsed") {
    auto result = session_from_project_json(R"({
      "id": "project",
      "songs": [{
        "id": "song",
        "duration_seconds": 10.0,
        "transposeSemitones": 0,
        "tracks": [],
        "regions": [{
          "id": "r1",
          "name": "Bridge",
          "startSeconds": 1.0,
          "lengthSeconds": 2.0,
          "transposeSemitones": 3
        }]
      }]
    })", 48000);

    REQUIRE(result.is_ok());
    auto session = result.take();
    REQUIRE(session.songs.size() == 1);
    const auto& song = session.songs[0];
    REQUIRE(song.regions.size() == 1);
    const auto& r = song.regions[0];
    CHECK(r.start_frame == 48000);                // 1.0s * 48000
    CHECK(r.end_frame   == 48000 * 3);            // (1.0 + 2.0)s * 48000
    CHECK(r.transpose_semitones == 3);
}

// ---------------------------------------------------------------------------
// Session adapter: malformed region (end_frame == start_frame) is dropped.
// ---------------------------------------------------------------------------
TEST_CASE("session_adapter_malformed_region_dropped") {
    // A region with no end info at all should not appear in song.regions.
    auto result = session_from_project_json(R"({
      "id": "project",
      "songs": [{
        "id": "song",
        "duration_seconds": 10.0,
        "tracks": [],
        "regions": [{
          "id": "r_bad",
          "startFrame": 0,
          "endFrame": 0,
          "transposeSemitones": 5
        }]
      }]
    })", 48000);

    REQUIRE(result.is_ok());
    auto session = result.take();
    REQUIRE(session.songs.size() == 1);
    // Malformed region (end_frame == start_frame == 0) must be dropped.
    CHECK(session.songs[0].regions.empty());
}

// ---------------------------------------------------------------------------
// Folder track is not rendered as audio (produces no output by itself)
// ---------------------------------------------------------------------------
TEST_CASE("folder_track_does_not_produce_audio") {
    SourceManager sources;
    Session session;
    session.id = "session"; session.sample_rate = kSR;
    Song song; song.id = "song"; song.start_frame = 0; song.end_frame = kSR * 4;
    // Only a folder track, no children.
    Track folder; folder.id = "folder"; folder.kind = TrackKind::Folder;
    folder.clips.push_back(Clip{"clip", "unused", 0, 0, kSR * 4}); // clips on folder — ignored
    song.tracks.push_back(folder);
    session.songs.push_back(song);
    auto shared = std::make_shared<Session>(session);

    TransportClock clock(kSR);
    JumpScheduler scheduler;
    Mixer mixer(shared, &sources, &clock, &scheduler);
    clock.play();

    std::vector<float> left(kBlock, 0.f), right(kBlock, 0.f);
    float* out[2] = {left.data(), right.data()};
    mixer.render(out, 2, kBlock, kSR);
    CHECK(peak(left) < 1.0e-7f);
}
