#include <doctest/doctest.h>
#include <lt_engine/render/mixer.h>
#include <lt_engine/transport/transport_clock.h>
#include <lt_engine/scheduler/jump_scheduler.h>
#include "test_audio_fixtures.h"
#include <lt_engine/sources/source_manager.h>

#include <atomic>
#include <latch>
#include <memory>
#include <thread>
#include <vector>

using namespace lt;

namespace {
constexpr int kFrames = 512;
constexpr int kBlocks = 200;

void add_source(SourceManager& sources, const std::string& id) {
    sources.register_source(id, "");
    REQUIRE(sources.store_decoded_source(
        id, test::make_stereo_sine(kFrames * (kBlocks + 2), 220.0, 0.1f),
        2, 48000, kFrames * (kBlocks + 2)).is_ok());
}

std::shared_ptr<Session> hierarchy_session(int mode) {
    auto session = std::make_shared<Session>();
    session->sample_rate = 48000;
    Song song;
    song.id = "step04-song";
    song.end_frame = kFrames * (kBlocks + 1);
    if (mode == 0) {
        for (int i = 0; i < 3; ++i) {
            Track folder;
            folder.id = "folder-" + std::to_string(i);
            folder.kind = TrackKind::Folder;
            folder.parent_track_id = i == 0 ? "" : "folder-" + std::to_string(i - 1);
            song.tracks.push_back(std::move(folder));
        }
        for (int i = 0; i < 10; ++i) {
            Track leaf;
            leaf.id = "leaf-" + std::to_string(i);
            leaf.parent_track_id = "folder-2";
            leaf.gain = 0.5f + i * 0.01f;
            leaf.pan = (i % 3 - 1) * 0.25f;
            leaf.clips.push_back(Clip{"clip-" + std::to_string(i), "src", 0, 0, song.end_frame});
            song.tracks.push_back(std::move(leaf));
        }
    } else if (mode == 1) {
        Track non_folder;
        non_folder.id = "plain";
        non_folder.clips.push_back(Clip{"plain-clip", "src", 0, 0, song.end_frame});
        song.tracks.push_back(std::move(non_folder));
        Track orphan;
        orphan.id = "orphan";
        orphan.parent_track_id = "missing";
        orphan.clips.push_back(Clip{"orphan-clip", "src", 0, 0, song.end_frame});
        song.tracks.push_back(std::move(orphan));
        Track bad_parent;
        bad_parent.id = "bad-child";
        bad_parent.parent_track_id = "plain";
        bad_parent.clips.push_back(Clip{"bad-clip", "src", 0, 0, song.end_frame});
        song.tracks.push_back(std::move(bad_parent));
    } else {
        std::string parent;
        for (int i = 0; i < 10; ++i) {
            Track folder;
            folder.id = "deep-" + std::to_string(i);
            folder.kind = TrackKind::Folder;
            folder.parent_track_id = parent;
            parent = folder.id;
            song.tracks.push_back(std::move(folder));
        }
        Track leaf;
        leaf.id = "deep-leaf";
        leaf.parent_track_id = parent;
        leaf.clips.push_back(Clip{"deep-clip", "src", 0, 0, song.end_frame});
        song.tracks.push_back(std::move(leaf));
    }
    session->sources.push_back(Source{"src", ""});
    session->songs.push_back(std::move(song));
    return session;
}

std::vector<float> render_session(Mixer& mixer, TransportClock& clock, int blocks = kBlocks) {
    std::vector<float> output(static_cast<std::size_t>(2 * kFrames * blocks));
    float* channels[] = {output.data(), output.data() + kFrames * blocks};
    clock.play();
    clock.clear_pending_start();
    for (int block = 0; block < blocks; ++block) {
        channels[0] = output.data() + block * kFrames;
        channels[1] = output.data() + kFrames * blocks + block * kFrames;
        mixer.render(channels, 2, kFrames, 48000.0);
    }
    return output;
}
}

TEST_CASE("step04 normal render uses the published renderer slot index") {
    auto session = std::make_shared<Session>();
    session->sample_rate = 48000;
    Song song;
    song.id = "song";
    song.end_frame = 512 * 200;
    Track track;
    track.id = "track";
    song.tracks.push_back(track);
    session->songs.push_back(std::move(song));
    TransportClock clock(48000.0);
    JumpScheduler scheduler;
    Mixer mixer(session, nullptr, &clock, &scheduler);
    mixer.prepare_render_resources(512);
    // No active playback resources are needed: the empty source list makes the
    // track loop take its normal slot lookup before it reaches the renderer.
    std::vector<float> left(512), right(512);
    float* output[] = {left.data(), right.data()};
    clock.play();
    clock.clear_pending_start();
    for (int block = 0; block < 200; ++block)
        mixer.render(output, 2, 512, 48000.0);
    CHECK(mixer.take_control_index_lookup_count_for_test() == 0);
}

TEST_CASE("step04 folder peak accumulation keeps concurrent maximum") {
    auto session = std::make_shared<Session>();
    session->sample_rate = 48000;
    Mixer mixer(session, nullptr, nullptr, nullptr);
    std::latch ready(2);
    std::latch go(1);
    std::thread a([&] {
        ready.count_down(); go.wait();
        for (int i = 0; i < 10000; ++i) mixer.accumulate_folder_meter_for_test(0, static_cast<float>(i));
    });
    std::thread b([&] {
        ready.count_down(); go.wait();
        for (int i = 0; i < 10000; ++i) mixer.accumulate_folder_meter_for_test(0, static_cast<float>(i) + 0.5f);
    });
    ready.wait(); go.count_down();
    a.join(); b.join();
    CHECK(mixer.folder_meter_peak_for_test(0) == 9999.5f);
}

TEST_CASE("step04 fallback preserves gain pan mute and solo") {
    auto session = hierarchy_session(1);
    session->songs[0].tracks[1].gain = 0.25f;
    session->songs[0].tracks[1].pan = -0.75f;
    session->songs[0].tracks[1].mute = true;
    session->songs[0].tracks[2].solo = true;
    SourceManager sources;
    add_source(sources, "src");
    TransportClock clock_a(48000), clock_b(48000);
    JumpScheduler scheduler_a, scheduler_b;
    Mixer normal(session, &sources, &clock_a, &scheduler_a);
    Mixer fallback(session, &sources, &clock_b, &scheduler_b);
    normal.set_active_output_channels({0, 1});
    fallback.set_active_output_channels({0, 1});
    fallback.force_control_count_zero_for_test();
    const auto expected = render_session(normal, clock_a, 20);
    const auto actual = render_session(fallback, clock_b, 20);
    const std::size_t last = actual.size() - 2 * kFrames;
    bool fallback_has_audio = false;
    for (int i = 0; i < kFrames; ++i) {
        fallback_has_audio |= actual[last + static_cast<std::size_t>(i)] != 0.0f
            || actual[last + kFrames + static_cast<std::size_t>(i)] != 0.0f;
    }
    CHECK(fallback_has_audio);
    const bool expected_has_audio = expected[last] != 0.0f
        || expected[last + kFrames] != 0.0f;
    CHECK(expected_has_audio);
    // The fallback still exposes the same per-track meter values; the muted
    // track is therefore present in the source meter while its mixed output is
    // suppressed, and the soloed track remains audible.
    const auto meters = fallback.track_meters();
    CHECK(meters[1].left_peak == 0.1f);
    CHECK(meters[1].right_peak == 0.1f);
    const bool solo_has_audio = meters[2].left_peak != 0.0f
        || meters[2].right_peak != 0.0f;
    CHECK(solo_has_audio);
}

TEST_CASE("step04 fallback effective gain and pan are exact") {
    auto session = hierarchy_session(1);
    session->songs[0].tracks.resize(1);
    auto& track = session->songs[0].tracks[0];
    track.id = "single";
    track.parent_track_id.clear();
    track.gain = 0.25f;
    track.pan = -0.5f;
    track.mute = false;
    track.solo = false;
    track.clips[0].id = "single-clip";
    SourceManager sources;
    add_source(sources, "src");
    TransportClock clock_a(48000), clock_b(48000);
    JumpScheduler scheduler_a, scheduler_b;
    Mixer normal(session, &sources, &clock_a, &scheduler_a);
    Mixer fallback(session, &sources, &clock_b, &scheduler_b);
    fallback.force_control_count_zero_for_test();
    const auto expected = render_session(normal, clock_a, 1);
    const auto actual = render_session(fallback, clock_b, 1);
    for (std::size_t i = 0; i < expected.size(); ++i)
        CHECK(actual[i] == expected[i]);

    track.mute = true;
    track.solo = false;
    auto muted = std::make_shared<Session>(*session);
    TransportClock mute_clock(48000);
    JumpScheduler mute_scheduler;
    Mixer mute_mixer(muted, &sources, &mute_clock, &mute_scheduler);
    mute_mixer.force_control_count_zero_for_test();
    const auto muted_output = render_session(mute_mixer, mute_clock, 1);
    for (float sample : muted_output) CHECK(sample == 0.0f);

    track.mute = false;
    track.solo = true;
    auto solo = std::make_shared<Session>(*session);
    TransportClock solo_clock(48000);
    JumpScheduler solo_scheduler;
    Mixer solo_mixer(solo, &sources, &solo_clock, &solo_scheduler);
    solo_mixer.force_control_count_zero_for_test();
    const auto solo_output = render_session(solo_mixer, solo_clock, 1);
    bool solo_audible = false;
    for (float sample : solo_output) solo_audible |= sample != 0.0f;
    CHECK(solo_audible);
}

TEST_CASE("step04 folder meters are bit-exact for 200 blocks across three levels") {
    auto session = hierarchy_session(0);
    SourceManager sources;
    add_source(sources, "src");
    TransportClock clock_a(48000), clock_b(48000);
    JumpScheduler scheduler_a, scheduler_b;
    Mixer normal(session, &sources, &clock_a, &scheduler_a);
    Mixer fallback(session, &sources, &clock_b, &scheduler_b);
    normal.set_active_output_channels({0, 1});
    fallback.set_active_output_channels({0, 1});
    fallback.force_control_count_zero_for_test();
    std::vector<float> out_a(2 * kFrames), out_b(2 * kFrames);
    float* channels_a[] = {out_a.data(), out_a.data() + kFrames};
    float* channels_b[] = {out_b.data(), out_b.data() + kFrames};
    clock_a.play(); clock_a.clear_pending_start();
    clock_b.play(); clock_b.clear_pending_start();
    for (int block = 0; block < kBlocks; ++block) {
        normal.render(channels_a, 2, kFrames, 48000.0);
        fallback.render(channels_b, 2, kFrames, 48000.0);
        const auto meters_a = normal.track_meters();
        const auto meters_b = fallback.track_meters();
        REQUIRE(meters_a.size() == meters_b.size());
        for (std::size_t i = 0; i < meters_a.size(); ++i) {
            CHECK(meters_a[i].left_peak == meters_b[i].left_peak);
            CHECK(meters_a[i].right_peak == meters_b[i].right_peak);
            CHECK(meters_a[i].left_rms == meters_b[i].left_rms);
            CHECK(meters_a[i].right_rms == meters_b[i].right_rms);
        }
    }
}

TEST_CASE("step04 orphan and non-folder parent stop the meter chain") {
    auto session = hierarchy_session(1);
    SourceManager sources;
    add_source(sources, "src");
    TransportClock clock_a(48000), clock_b(48000);
    JumpScheduler scheduler_a, scheduler_b;
    Mixer normal(session, &sources, &clock_a, &scheduler_a);
    Mixer fallback(session, &sources, &clock_b, &scheduler_b);
    fallback.force_control_count_zero_for_test();
    render_session(normal, clock_a, 1);
    render_session(fallback, clock_b, 1);
    const auto a = normal.track_meters();
    const auto b = fallback.track_meters();
    REQUIRE(a.size() == b.size());
    CHECK(a[1].left_peak != 0.0f);
    CHECK(a[2].left_peak != 0.0f);
    CHECK(a[1].left_peak == b[1].left_peak);
    CHECK(a[2].left_peak == b[2].left_peak);
    for (std::size_t i = 0; i < a.size(); ++i) {
        CHECK(a[i].left_peak == b[i].left_peak);
        CHECK(a[i].right_peak == b[i].right_peak);
    }
}

TEST_CASE("step04 folder meter chain truncates beyond maximum depth") {
    auto session = hierarchy_session(2);
    SourceManager sources;
    add_source(sources, "src");
    TransportClock clock_a(48000), clock_b(48000);
    JumpScheduler scheduler_a, scheduler_b;
    Mixer normal(session, &sources, &clock_a, &scheduler_a);
    Mixer fallback(session, &sources, &clock_b, &scheduler_b);
    fallback.force_control_count_zero_for_test();
    render_session(normal, clock_a, 1);
    render_session(fallback, clock_b, 1);
    const auto a = normal.track_meters();
    const auto b = fallback.track_meters();
    REQUIRE(a.size() == b.size());
    for (int i = 2; i <= 9; ++i) CHECK(a[static_cast<std::size_t>(i)].left_peak != 0.0f);
    CHECK(a[1].left_peak == 0.0f);
    CHECK(a[1].left_peak == b[1].left_peak);
    for (std::size_t i = 0; i < a.size(); ++i)
        CHECK(a[i].left_peak == b[i].left_peak);
}

TEST_CASE("step04 fixed hierarchy output is bit-exact against fallback oracle") {
    auto session = hierarchy_session(0);
    SourceManager sources;
    add_source(sources, "src");
    TransportClock clock_a(48000), clock_b(48000);
    JumpScheduler scheduler_a, scheduler_b;
    Mixer optimized(session, &sources, &clock_a, &scheduler_a);
    Mixer legacy(session, &sources, &clock_b, &scheduler_b);
    legacy.force_control_count_zero_for_test();
    const auto a = render_session(optimized, clock_a);
    const auto b = render_session(legacy, clock_b);
    REQUIRE(a.size() == b.size());
    for (std::size_t i = 0; i < a.size(); ++i) CHECK(a[i] == b[i]);
}
