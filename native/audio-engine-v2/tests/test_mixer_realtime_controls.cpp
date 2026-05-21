#include "test_audio_fixtures.h"

#include <doctest/doctest.h>
#include <lt_engine/pitch/bungee_voice_manager.h>
#include <lt_engine/render/mixer.h>
#include <lt_engine/render/track_renderer.h>
#include <lt_engine/sources/source_manager.h>
#include <lt_engine/transport/transport_clock.h>
#include <lt_engine/scheduler/jump_scheduler.h>

#include <algorithm>
#include <cmath>
#include <vector>

using namespace lt;

#ifndef LT_ENGINE_HAVE_BUNGEE
#define LT_ENGINE_HAVE_BUNGEE 0
#endif

namespace {

constexpr int kBlock = 512;

float peak(const std::vector<float>& samples) {
    float p = 0.0f;
    for (float s : samples) {
        CHECK(std::isfinite(s));
        p = std::max(p, std::abs(s));
    }
    return p;
}

double rms(const std::vector<float>& samples) {
    double sum = 0.0;
    for (float s : samples) {
        CHECK(std::isfinite(s));
        sum += static_cast<double>(s) * s;
    }
    return std::sqrt(sum / std::max<std::size_t>(1, samples.size()));
}

void render_blocks(Mixer& mixer,
                   TransportClock& clock,
                   int blocks,
                   std::vector<float>& left,
                   std::vector<float>& right) {
    left.assign(kBlock, 0.0f);
    right.assign(kBlock, 0.0f);
    float* out[2] = {left.data(), right.data()};
    for (int i = 0; i < blocks; ++i)
        mixer.render(out, 2, kBlock, clock.sample_rate());
}

Session one_track_session(Frame start = 0, Frame duration = 48000, const Id& track_id = "track") {
    Session session;
    session.id = "session";
    session.sample_rate = test::kFixtureSampleRate;
    session.sources.push_back(Source{"source", ""});
    Song song;
    song.id = "song";
    song.start_frame = start;
    song.end_frame = start + duration;
    Track track;
    track.id = track_id;
    track.clips.push_back(Clip{"clip", "source", start, 0, duration});
    song.tracks.push_back(track);
    session.songs.push_back(song);
    return session;
}

void add_source(SourceManager& sources, const Id& id, float amplitude = 0.5f, Frame duration = 48000 * 4) {
    sources.register_source(id, "");
    REQUIRE(sources.store_decoded_source(id,
        test::make_stereo_sine(duration, 440.0, amplitude),
        2, test::kFixtureSampleRate, duration).is_ok());
}

JumpTarget frame_target(Frame frame) {
    JumpTarget target;
    target.kind = JumpTarget::Kind::Frame;
    target.frame = frame;
    return target;
}

} // namespace

#if LT_ENGINE_HAVE_BUNGEE
TEST_CASE("scheduled jump without prepared voices clears stale Bungee voice and latches repair target") {
    constexpr Frame kDuration = 48000 * 90;
    constexpr Frame kTrigger = 48000 * 10 + 325;
    constexpr Frame kTarget = 48000 * 44 + 117;

    SourceManager sources;
    sources.register_source("source", "");
    REQUIRE(sources.store_decoded_source(
        "source",
        test::make_stereo_sine(kDuration, 440.0, 0.5f),
        2,
        test::kFixtureSampleRate,
        kDuration).is_ok());

    auto session = std::make_shared<Session>();
    session->id = "ab";
    session->sample_rate = test::kFixtureSampleRate;
    Song song;
    song.id = "song";
    song.start_frame = 0;
    song.end_frame = kDuration;
    song.transpose_semitones = -2;
    song.markers.push_back(Marker{"target", "Target", kTarget});

    Track unpitched;
    unpitched.id = "unpitched";
    unpitched.transpose_behavior = TransposeBehavior::NeverTranspose;
    unpitched.clips.push_back(Clip{"clip-u", "source", 0, 0, kDuration});
    song.tracks.push_back(unpitched);

    Track pitched;
    pitched.id = "pitched";
    pitched.transpose_behavior = TransposeBehavior::FollowsSongOrRegion;
    pitched.clips.push_back(Clip{"clip-p", "source", 0, 0, kDuration});
    song.tracks.push_back(pitched);
    session->songs.push_back(song);

    TransportClock clock(test::kFixtureSampleRate);
    JumpScheduler scheduler;
    Mixer mixer(session, &sources, &clock, &scheduler);
    mixer.prepare_render_resources(kBlock);

    BungeeVoiceManager bvm;
    REQUIRE(bvm.prepare(test::kFixtureSampleRate, 2, kBlock));
    bvm.rebuild_for_session(*session, sources, 0);
    REQUIRE(bvm.voice_for("clip-p") != nullptr);
    mixer.set_bungee_voice_manager(&bvm);

    clock.seek(kTrigger - 325);
    clock.play();
    clock.clear_pending_start();

    ScheduledJump jump;
    jump.jump_id = "jump-unprepared";
    jump.target = frame_target(kTarget);
    jump.trigger = JumpTrigger::AtFrame;
    jump.status = JumpStatus::Pending;
    jump.trigger_frame = kTrigger;
    jump.suppress_seek_fade = true;
    REQUIRE(scheduler.schedule(jump).is_ok());

    std::vector<float> left(kBlock, 0.0f);
    std::vector<float> right(kBlock, 0.0f);
    float* out[2] = {left.data(), right.data()};
    mixer.render(out, 2, kBlock, test::kFixtureSampleRate);

    CHECK(mixer.scheduled_jump_executed_count() == 1);
    CHECK(mixer.take_pending_scheduled_jump() == kTarget);
    CHECK(bvm.voice_for("clip-p") == nullptr);

    bvm.rebuild_for_seek(kTarget, *session, sources);
    CHECK(bvm.voice_for("clip-p") != nullptr);
}
#endif

TEST_CASE("mixer_gain_override_changes_rendered_level") {
    SourceManager sources;
    add_source(sources, "source");
    auto session = std::make_shared<Session>(one_track_session());
    TransportClock clock(test::kFixtureSampleRate);
    JumpScheduler scheduler;
    Mixer mixer(session, &sources, &clock, &scheduler);
    clock.play();

    std::vector<float> left, right;
    render_blocks(mixer, clock, 8, left, right);
    const double baseline = rms(left);
    REQUIRE(baseline > 0.01);

    mixer.set_track_gain("track", 0.25f);
    render_blocks(mixer, clock, 20, left, right);
    CHECK(rms(left) == doctest::Approx(baseline * 0.25).epsilon(0.20));
    CHECK(clock.position().state == TransportState::Playing);
}

TEST_CASE("mixer_pan_override_changes_output_balance") {
    SourceManager sources;
    add_source(sources, "source");
    auto session = std::make_shared<Session>(one_track_session());
    TransportClock clock(test::kFixtureSampleRate);
    JumpScheduler scheduler;
    Mixer mixer(session, &sources, &clock, &scheduler);
    clock.play();

    std::vector<float> left, right;
    render_blocks(mixer, clock, 8, left, right);
    REQUIRE(peak(left) > 0.01f);
    REQUIRE(peak(right) > 0.01f);

    mixer.set_track_pan("track", -1.0f);
    render_blocks(mixer, clock, 20, left, right);
    CHECK(peak(left) > 0.01f);
    CHECK(peak(right) < 0.001f);

    mixer.set_track_pan("track", 1.0f);
    render_blocks(mixer, clock, 20, left, right);
    CHECK(peak(right) > 0.01f);
    CHECK(peak(left) < 0.001f);
}

TEST_CASE("mixer_mute_override_mutes_track") {
    SourceManager sources;
    add_source(sources, "source");
    auto session = std::make_shared<Session>(one_track_session());
    TransportClock clock(test::kFixtureSampleRate);
    JumpScheduler scheduler;
    Mixer mixer(session, &sources, &clock, &scheduler);
    clock.play();

    std::vector<float> left, right;
    render_blocks(mixer, clock, 8, left, right);
    REQUIRE(peak(left) > 0.01f);

    mixer.set_track_mute("track", true);
    render_blocks(mixer, clock, 30, left, right);
    CHECK(peak(left) < 0.001f);
    CHECK(peak(right) < 0.001f);

    mixer.set_track_mute("track", false);
    render_blocks(mixer, clock, 30, left, right);
    CHECK(peak(left) > 0.01f);
}

TEST_CASE("mixer_solo_override_isolates_track") {
    SourceManager sources;
    sources.register_source("a", "");
    sources.register_source("b", "");
    REQUIRE(sources.store_decoded_source("a", test::make_stereo_sine(48000 * 4, 220.0, 0.25f),
                                         2, test::kFixtureSampleRate, 48000 * 4).is_ok());
    REQUIRE(sources.store_decoded_source("b", test::make_stereo_sine(48000 * 4, 880.0, 0.25f),
                                         2, test::kFixtureSampleRate, 48000 * 4).is_ok());
    Session session;
    session.id = "session";
    session.sample_rate = test::kFixtureSampleRate;
    Song song;
    song.id = "song";
    song.end_frame = 48000 * 4;
    Track a;
    a.id = "a";
    a.clips.push_back(Clip{"clip-a", "a", 0, 0, 48000 * 4});
    Track b;
    b.id = "b";
    b.clips.push_back(Clip{"clip-b", "b", 0, 0, 48000 * 4});
    song.tracks = {a, b};
    session.songs.push_back(song);
    auto shared = std::make_shared<Session>(session);

    TransportClock clock(test::kFixtureSampleRate);
    JumpScheduler scheduler;
    Mixer mixer(shared, &sources, &clock, &scheduler);
    clock.play();
    std::vector<float> left, right;
    render_blocks(mixer, clock, 8, left, right);
    const double both = rms(left);
    REQUIRE(both > 0.1);

    mixer.set_track_solo("a", true);
    render_blocks(mixer, clock, 30, left, right);
    const double solo_a = rms(left);
    CHECK(solo_a < both);
    CHECK(solo_a > 0.05);

    mixer.set_track_solo("a", false);
    mixer.set_track_solo("b", true);
    render_blocks(mixer, clock, 30, left, right);
    const double solo_b = rms(left);
    CHECK(solo_b < both);
    CHECK(solo_b > 0.05);

    mixer.set_track_solo("b", false);
    render_blocks(mixer, clock, 30, left, right);
    CHECK(rms(left) > solo_b);
}

TEST_CASE("mixer_controls_are_track_id_based_not_index_based") {
    SourceManager sources;
    add_source(sources, "source", 0.5f, 48000 * 8);
    Session session;
    session.id = "session";
    session.sample_rate = test::kFixtureSampleRate;
    session.sources.push_back(Source{"source", ""});
    session.songs.push_back(one_track_session(0, 48000 * 2, "A").songs[0]);
    session.songs[0].id = "song-a";
    session.songs.push_back(one_track_session(48000 * 4, 48000 * 2, "B").songs[0]);
    session.songs[1].id = "song-b";
    auto shared = std::make_shared<Session>(session);
    TransportClock clock(test::kFixtureSampleRate);
    JumpScheduler scheduler;
    Mixer mixer(shared, &sources, &clock, &scheduler);
    clock.play();

    std::vector<float> left, right;
    mixer.set_track_gain("B", 0.25f);
    clock.seek(48000 * 4);
    render_blocks(mixer, clock, 30, left, right);
    const double b_level = rms(left);

    clock.seek(0);
    render_blocks(mixer, clock, 30, left, right);
    const double a_level = rms(left);
    CHECK(b_level < a_level * 0.45);
    CHECK(a_level > 0.1);
}

TEST_CASE("mixer_control_spam_no_clicks_or_callback_spikes") {
    SourceManager sources;
    add_source(sources, "source");
    auto session = std::make_shared<Session>(one_track_session());
    TransportClock clock(test::kFixtureSampleRate);
    JumpScheduler scheduler;
    Mixer mixer(session, &sources, &clock, &scheduler);
    clock.play();
    std::vector<float> left, right;
    float last = 0.0f;
    float max_jump = 0.0f;
    for (int i = 0; i < 100; ++i) {
        mixer.set_track_gain("track", (i % 10) / 10.0f);
        mixer.set_track_pan("track", (i % 2) ? -1.0f : 1.0f);
        mixer.set_track_mute("track", i % 17 == 0);
        render_blocks(mixer, clock, 1, left, right);
        for (float sample : left) {
            CHECK(std::isfinite(sample));
            max_jump = std::max(max_jump, std::abs(sample - last));
            last = sample;
        }
    }
    CHECK(max_jump < 1.0f);
    CHECK(mixer.callback_duration_ms() < 10.0);
}

TEST_CASE("track_renderer_no_scratch_allocation_in_render") {
    TrackRenderer::reset_diagnostics();
    SourceManager sources;
    add_source(sources, "source");
    auto session = one_track_session();
    TrackRenderer renderer;
    renderer.prepare(kBlock);
    const auto before = TrackRenderer::diagnostics();

    float left[kBlock] = {};
    float right[kBlock] = {};
    float* out[2] = {left, right};
    renderer.render(session.songs[0].tracks[0], 0, kBlock, out, 2, sources, nullptr,
                    test::kFixtureSampleRate, 0, &session.songs[0]);
    const auto after = TrackRenderer::diagnostics();

    CHECK(after.prepare_count == before.prepare_count);
    CHECK(after.scratch_resize_in_audio_thread_count == before.scratch_resize_in_audio_thread_count);
    CHECK(after.block_too_large_count == 0);
}

TEST_CASE("metronome_toggle_does_not_stop_existing_audio") {
    SourceManager sources;
    add_source(sources, "source");
    auto session = std::make_shared<Session>(one_track_session());
    TransportClock clock(test::kFixtureSampleRate);
    JumpScheduler scheduler;
    Mixer mixer(session, &sources, &clock, &scheduler);
    clock.play();
    mixer.set_metronome_config({true, 0.75f, "master", true});

    std::vector<float> left, right;
    render_blocks(mixer, clock, 8, left, right);
    const auto before_frame = clock.position().frame;
    mixer.set_metronome_config({false, 0.75f, "master", true});
    render_blocks(mixer, clock, 8, left, right);

    CHECK(clock.position().frame > before_frame);
    CHECK(peak(left) > 0.01f);
    CHECK(peak(right) > 0.01f);
}

TEST_CASE("scheduled region-end jump splits render block at exact trigger frame") {
    SourceManager sources;
    add_source(sources, "source", 0.5f, 48000 * 4);
    auto session = std::make_shared<Session>(one_track_session(0, 48000 * 4));
    session->songs[0].regions.push_back(
        Region{"region-a", "A", 0, 96000, 0});

    TransportClock clock(test::kFixtureSampleRate);
    JumpScheduler scheduler;
    Mixer mixer(session, &sources, &clock, &scheduler);

    ScheduledJump jump;
    jump.jump_id = "region-end";
    JumpTarget target;
    target.kind = JumpTarget::Kind::Frame;
    target.frame = 1234;
    jump.target = target;
    jump.trigger = JumpTrigger::AtRegionEnd;
    jump.status = JumpStatus::Pending;
    REQUIRE(scheduler.schedule(jump).is_ok());

    clock.seek(95600);
    clock.play();

    std::vector<float> left(kBlock, 0.0f), right(kBlock, 0.0f);
    float* out[2] = {left.data(), right.data()};
    mixer.render(out, 2, kBlock, clock.sample_rate());

    CHECK(clock.position().frame == 1234 + (kBlock - 400));
    CHECK(mixer.scheduled_jump_executed_count() == 1);
}

TEST_CASE("scheduled jump can suppress seek fade for external fade transitions") {
    SourceManager sources;
    add_source(sources, "source", 0.5f, 48000 * 4);
    auto session = std::make_shared<Session>(one_track_session(0, 48000 * 4));
    session->songs[0].regions.push_back(
        Region{"region-a", "A", 0, 96000, 0});

    TransportClock clock(test::kFixtureSampleRate);
    JumpScheduler scheduler;
    Mixer mixer(session, &sources, &clock, &scheduler);

    ScheduledJump jump;
    jump.jump_id = "region-end";
    JumpTarget target;
    target.kind = JumpTarget::Kind::Frame;
    target.frame = 1234;
    jump.target = target;
    jump.trigger = JumpTrigger::AtRegionEnd;
    jump.status = JumpStatus::Pending;
    jump.suppress_seek_fade = true;
    REQUIRE(scheduler.schedule(jump).is_ok());

    clock.seek(95600);
    clock.play();

    std::vector<float> left(kBlock, 0.0f), right(kBlock, 0.0f);
    float* out[2] = {left.data(), right.data()};
    mixer.render(out, 2, kBlock, clock.sample_rate());

    CHECK(clock.position().frame == 1234 + (kBlock - 400));
    CHECK(mixer.scheduled_jump_executed_count() == 1);
    CHECK(mixer.take_pending_scheduled_jump() == 1234);
}

TEST_CASE("scheduled jump suppress_seek_fade leaves first post-jump sample untouched") {
    constexpr Frame kDuration = 48000 * 2;
    constexpr Frame kTrigger = 300;
    constexpr Frame kTarget = 24000;

    std::vector<float> pcm(static_cast<std::size_t>(kDuration * 2), 0.0f);
    for (Frame f = 0; f < kDuration; ++f) {
        const float value = f < kTarget ? 0.25f : 0.75f;
        pcm[static_cast<std::size_t>(f * 2)] = value;
        pcm[static_cast<std::size_t>(f * 2 + 1)] = value;
    }

    SourceManager sources;
    sources.register_source("source", "");
    REQUIRE(sources.store_decoded_source("source", pcm, 2,
        test::kFixtureSampleRate, kDuration).is_ok());

    auto session = std::make_shared<Session>(one_track_session(0, kDuration));
    TransportClock clock(test::kFixtureSampleRate);
    JumpScheduler scheduler;
    Mixer mixer(session, &sources, &clock, &scheduler);

    ScheduledJump jump;
    jump.jump_id = "marker-instant";
    jump.target = frame_target(kTarget);
    jump.trigger = JumpTrigger::AtFrame;
    jump.status = JumpStatus::Pending;
    jump.trigger_frame = kTrigger;
    jump.suppress_seek_fade = true;
    REQUIRE(scheduler.schedule(jump).is_ok());

    clock.seek(0);
    clock.play();

    std::vector<float> left(kBlock, 0.0f), right(kBlock, 0.0f);
    float* out[2] = {left.data(), right.data()};
    mixer.render(out, 2, kBlock, clock.sample_rate());

    CHECK(mixer.scheduled_jump_executed_count() == 1);
    CHECK(left[static_cast<std::size_t>(kTrigger)] == doctest::Approx(0.75f));
}

TEST_CASE("prepared scheduled jump still de-clicks the post-jump boundary") {
    constexpr Frame kDuration = 48000 * 2;
    constexpr Frame kTrigger = 300;
    constexpr Frame kTarget = 24000;

    std::vector<float> pcm(static_cast<std::size_t>(kDuration * 2), 0.0f);
    for (Frame f = 0; f < kDuration; ++f) {
        const float value = f < kTarget ? 0.25f : 0.75f;
        pcm[static_cast<std::size_t>(f * 2)] = value;
        pcm[static_cast<std::size_t>(f * 2 + 1)] = value;
    }

    SourceManager sources;
    sources.register_source("source", "");
    REQUIRE(sources.store_decoded_source("source", pcm, 2,
        test::kFixtureSampleRate, kDuration).is_ok());

    auto session = std::make_shared<Session>(one_track_session(0, kDuration));
    TransportClock clock(test::kFixtureSampleRate);
    JumpScheduler scheduler;
    Mixer mixer(session, &sources, &clock, &scheduler);

    ScheduledJump jump;
    jump.jump_id = "prepared-marker";
    jump.target = frame_target(kTarget);
    jump.trigger = JumpTrigger::AtFrame;
    jump.status = JumpStatus::Pending;
    jump.trigger_frame = kTrigger;
    jump.suppress_seek_fade = true;
    jump.prepared_voice_map = std::make_shared<PreparedVoiceMap>();
    REQUIRE(scheduler.schedule(jump).is_ok());

    clock.seek(0);
    clock.play();

    std::vector<float> left(kBlock, 0.0f), right(kBlock, 0.0f);
    float* out[2] = {left.data(), right.data()};
    mixer.render(out, 2, kBlock, clock.sample_rate());

    CHECK(mixer.scheduled_jump_executed_count() == 1);
    CHECK(left[static_cast<std::size_t>(kTrigger)] == doctest::Approx(0.25f));
    CHECK(left[static_cast<std::size_t>(kTrigger + 127)] == doctest::Approx(0.75f));
}

TEST_CASE("master fade ramps output gain in the audio callback") {
    SourceManager sources;
    add_source(sources, "source", 0.5f, 48000 * 4);
    auto session = std::make_shared<Session>(one_track_session(0, 48000 * 4));

    TransportClock clock(test::kFixtureSampleRate);
    JumpScheduler scheduler;
    Mixer mixer(session, &sources, &clock, &scheduler);

    clock.play();
    mixer.start_master_fade(0.0f, static_cast<double>(kBlock) / clock.sample_rate());

    std::vector<float> left(kBlock, 0.0f), right(kBlock, 0.0f);
    float* out[2] = {left.data(), right.data()};
    mixer.render(out, 2, kBlock, clock.sample_rate());

    const std::vector<float> left_head(left.begin(), left.begin() + kBlock / 4);
    const std::vector<float> left_tail(left.end() - kBlock / 4, left.end());
    const std::vector<float> right_head(right.begin(), right.begin() + kBlock / 4);
    const std::vector<float> right_tail(right.end() - kBlock / 4, right.end());
    CHECK(rms(left_head) > rms(left_tail));
    CHECK(rms(right_head) > rms(right_tail));
}
