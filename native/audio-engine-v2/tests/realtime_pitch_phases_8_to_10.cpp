// Tests for phases 8-10 of the realtime pitch redesign:
//   Phase 8  — End-to-end Mixer integration
//   Phase 9  — Diagnostics completeness
//   Phase 10 — Acceptance criteria sweep

#include "test_audio_fixtures.h"

#include <doctest/doctest.h>
#include <lt_engine/core/snapshot.h>
#include <lt_engine/pitch/realtime_pitch_engine.h>
#include <lt_engine/pitch/realtime_pitch_stream.h>
#include <lt_engine/render/mixer.h>
#include <lt_engine/render/track_renderer.h>
#include <lt_engine/scheduler/jump_scheduler.h>
#include <lt_engine/session/session.h>
#include <lt_engine/sources/source_manager.h>
#include <lt_engine/transport/transport_clock.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <memory>
#include <thread>
#include <vector>

using namespace lt;

namespace {

constexpr int  kSR    = test::kFixtureSampleRate;
constexpr int  kBlock = 512;
constexpr Frame kDur  = kSR * 8;

void add_source(SourceManager& sources, const Id& id,
                Frame dur = kDur, float amp = 0.4f, double freq = 440.0) {
    sources.register_source(id, "");
    REQUIRE(sources.store_decoded_source(
        id, test::make_stereo_sine(dur, freq, amp), 2, kSR, dur).is_ok());
}

void add_click_source(SourceManager& sources, const Id& id,
                      Frame dur, Frame click_at) {
    sources.register_source(id, "");
    REQUIRE(sources.store_decoded_source(
        id, test::make_stereo_click(dur, click_at, 1.0f), 2, kSR, dur).is_ok());
}

// Build a minimal pitched session and the full Mixer stack.
struct PitchedMixerFixture {
    SourceManager              sources;
    std::shared_ptr<Session>   session;
    TransportClock             clock{kSR};
    JumpScheduler              scheduler;
    RealtimePitchEngine        pitch;
    std::unique_ptr<Mixer>     mixer;

    std::vector<float> out_l = std::vector<float>(kBlock, 0.f);
    std::vector<float> out_r = std::vector<float>(kBlock, 0.f);
    float* out[2];

    explicit PitchedMixerFixture(Semitones semitones, Frame dur = kDur) : out{out_l.data(), out_r.data()} {
        add_source(sources, "src", dur);

        session = std::make_shared<Session>();
        session->sample_rate = kSR;
        session->sources = {Source{"src", ""}};
        Song song; song.id = "song"; song.start_frame = 0; song.end_frame = dur;
        song.transpose_semitones = semitones;
        Track track; track.id = "t"; track.kind = TrackKind::Audio;
        track.clips.push_back(Clip{"clip", "src", 0, 0, dur});
        song.tracks.push_back(track);
        session->songs.push_back(song);

        pitch.prepare_for_session(*session, sources, kSR);
        pitch.prepare_for_play(0, *session, sources);

        mixer = std::make_unique<Mixer>(session, &sources, &clock, &scheduler, nullptr, &pitch);
        mixer->prepare_render_resources(kBlock);
    }

    void render(int n = 1) {
        for (int i = 0; i < n; ++i) {
            std::fill(out_l.begin(), out_l.end(), 0.f);
            std::fill(out_r.begin(), out_r.end(), 0.f);
            mixer->render(out, 2, kBlock, kSR);
        }
    }

    void play() { clock.play(); }
};

} // namespace

// =============================================================================
// Phase 8 — End-to-end Mixer integration
// =============================================================================

// ---------------------------------------------------------------------------
// 8-A: Mixer renders pitched audio through full stack without silence or NaN.
// ---------------------------------------------------------------------------
TEST_CASE("mixer_pitched_playback_is_non_silent_and_finite") {
#if !LT_ENGINE_TEST_EXPECT_REAL_RUBBERBAND && !LT_ENGINE_ALLOW_RUNTIME_PITCH_STUB_PASSTHROUGH
    MESSAGE("Skipping: no real RubberBand and stub passthrough blocked.");
    return;
#endif
    PitchedMixerFixture f(3);
    f.play();
    f.render(32);  // 32 blocks to clear startup latency

    float peak = 0.f;
    for (float v : f.out_l) {
        CHECK(std::isfinite(v));
        peak = std::max(peak, std::abs(v));
    }
    CHECK(peak > 0.001f);
    CHECK(f.pitch.diagnostics().emergency_silence_count == 0);
    CHECK(f.pitch.diagnostics().unsafe_cross_thread_reset_count == 0);
}

// ---------------------------------------------------------------------------
// 8-B: Mixer seek triggers pitch realignment — first block after seek must be
//      finite and produce no mismatch increments compared to before the seek.
// ---------------------------------------------------------------------------
TEST_CASE("mixer_seek_triggers_pitch_realignment_no_mismatch") {
    PitchedMixerFixture f(2);
    f.play();
    f.render(8);

    // Seek to 3 s and immediately rebuild pitch.
    const Frame seek_target = kSR * 3;
    f.clock.seek(seek_target);
    f.pitch.prepare_for_transport_discontinuity(seek_target, "seek_absolute", *f.session, f.sources);
    f.mixer->trigger_crossfade();

    const auto before = f.pitch.diagnostics();
    f.render(1);
    const auto after = f.pitch.diagnostics();

    // First block post-seek: stream uses the primed-sentinel, so no mismatch.
    CHECK(after.pitch_timeline_mismatch_count == before.pitch_timeline_mismatch_count);
    CHECK(after.unsafe_cross_thread_reset_count == 0);
}

// ---------------------------------------------------------------------------
// 8-C: take_pending_scheduled_jump returns kNoJumpPending when Mixer hasn't
//      fired a scheduled jump yet, and is idempotent (multiple polls safe).
// ---------------------------------------------------------------------------
TEST_CASE("mixer_take_pending_jump_idempotent_when_no_jump") {
    PitchedMixerFixture f(0);  // unpitched — simpler, no RubberBand needed

    // Before any render, no jump can be pending.
    CHECK(f.mixer->take_pending_scheduled_jump() == Mixer::kNoJumpPending);
    CHECK(f.mixer->take_pending_scheduled_jump() == Mixer::kNoJumpPending);

    // After rendering without a scheduled jump, still none.
    f.play();
    f.render(4);
    CHECK(f.mixer->take_pending_scheduled_jump() == Mixer::kNoJumpPending);
}

// ---------------------------------------------------------------------------
// 8-D: scheduled_jump_executed_count stays 0 without any scheduled jumps,
//      and pending_scheduled_jump_frame_ stays at kNoJumpPending.
// ---------------------------------------------------------------------------
TEST_CASE("mixer_scheduled_jump_count_zero_without_jumps") {
    PitchedMixerFixture f(0);
    f.play();
    f.render(16);

    CHECK(f.mixer->scheduled_jump_executed_count() == 0);
    CHECK(f.mixer->take_pending_scheduled_jump() == Mixer::kNoJumpPending);
}

// ---------------------------------------------------------------------------
// 8-E: T-button (transpose_behavior toggle) rebuild increments stream swap
//      count and produces no unsafe mutation.
// ---------------------------------------------------------------------------
TEST_CASE("mixer_transpose_toggle_increments_stream_swap_no_unsafe_mutation") {
    PitchedMixerFixture f(3);
    f.play();
    f.render(4);

    const auto before_swaps = f.pitch.diagnostics().active_stream_swap_count;

    // Simulate the T-button toggle: new session with NeverTranspose, then rebuild pitch.
    auto next_session = std::make_shared<Session>(*f.session);
    next_session->songs[0].tracks[0].transpose_behavior = TransposeBehavior::NeverTranspose;
    f.pitch.prepare_for_transport_discontinuity(
        f.clock.position().frame, "set_transpose_enabled", *next_session, f.sources);
    f.mixer->set_session(next_session, true);
    f.mixer->trigger_crossfade();

    f.render(4);

    const auto after = f.pitch.diagnostics();
    CHECK(after.active_stream_swap_count > before_swaps);
    CHECK(after.unsafe_cross_thread_reset_count == 0);
    CHECK(after.concurrent_stream_mutation_detected == 0);
}

// ---------------------------------------------------------------------------
// 8-F: Pitched + unpitched tracks through Mixer: both render without NaN.
//      Verifies that the Mixer correctly handles mixed pitched/unpitched state.
// ---------------------------------------------------------------------------
TEST_CASE("mixer_pitched_and_unpitched_tracks_both_finite") {
    SourceManager sources;
    add_source(sources, "src_pitched", kDur, 0.3f);
    add_source(sources, "src_plain",   kDur, 0.3f, 330.0);

    auto session = std::make_shared<Session>();
    session->sample_rate = kSR;
    session->sources = {Source{"src_pitched", ""}, Source{"src_plain", ""}};
    Song song; song.id = "song"; song.start_frame = 0; song.end_frame = kDur;
    song.transpose_semitones = 3;

    Track t1; t1.id = "t1"; t1.kind = TrackKind::Audio;
    t1.transpose_behavior = TransposeBehavior::FollowsSongOrRegion;
    t1.clips.push_back(Clip{"c1", "src_pitched", 0, 0, kDur});

    Track t2; t2.id = "t2"; t2.kind = TrackKind::Audio;
    t2.transpose_behavior = TransposeBehavior::NeverTranspose;
    t2.clips.push_back(Clip{"c2", "src_plain", 0, 0, kDur});

    song.tracks.push_back(t1);
    song.tracks.push_back(t2);
    session->songs.push_back(song);

    TransportClock clock(kSR);
    JumpScheduler scheduler;
    RealtimePitchEngine pitch;
    pitch.prepare_for_session(*session, sources, kSR);
    pitch.prepare_for_play(0, *session, sources);

    Mixer mixer(session, &sources, &clock, &scheduler, nullptr, &pitch);
    mixer.prepare_render_resources(kBlock);
    clock.play();

    std::vector<float> out_l(kBlock, 0.f), out_r(kBlock, 0.f);
    float* out[2] = { out_l.data(), out_r.data() };

    for (int i = 0; i < 16; ++i) {
        std::fill(out_l.begin(), out_l.end(), 0.f);
        std::fill(out_r.begin(), out_r.end(), 0.f);
        mixer.render(out, 2, kBlock, kSR);
        for (float v : out_l) CHECK(std::isfinite(v));
        for (float v : out_r) CHECK(std::isfinite(v));
    }
    CHECK(pitch.diagnostics().unsafe_cross_thread_reset_count == 0);
}

// =============================================================================
// Phase 9 — Diagnostics completeness
// =============================================================================

// ---------------------------------------------------------------------------
// 9-A: After a pitch repair cycle, pitch_repair_requested_count and
//      pitch_repair_completed_count are both nonzero and equal.
// ---------------------------------------------------------------------------
TEST_CASE("diagnostics_repair_counts_reflect_repair_cycle") {
    constexpr Frame dur = kSR * 4;
    SourceManager sources;
    add_source(sources, "src", dur);

    Session session;
    session.sample_rate = kSR;
    session.sources = {Source{"src", ""}};
    Song song; song.id = "song"; song.start_frame = 0; song.end_frame = dur;
    song.transpose_semitones = 2;
    Track track; track.id = "t"; track.kind = TrackKind::Audio;
    track.clips.push_back(Clip{"clip", "src", 0, 0, dur});
    song.tracks.push_back(track);
    session.songs.push_back(song);

    RealtimePitchEngine engine;
    engine.prepare_for_session(session, sources, kSR);
    engine.prepare_for_play(0, session, sources);

    const auto& t = session.songs[0].tracks[0];
    const auto& c = t.clips[0];
    const auto* src = sources.get("src");
    REQUIRE(src != nullptr);

    float out_l[kBlock] = {}, out_r[kBlock] = {};
    float* out[2] = { out_l, out_r };

    // Consume primed-sentinel.
    engine.render_pitched_clip(c, t.id, *src, 0, 0, kBlock, 2.0, out, 2);

    // Force mismatches past the repair threshold.
    const Frame bad = kSR * 3;
    for (int i = 0; i <= kPitchMismatchRepairThreshold + 2; ++i)
        engine.render_pitched_clip(c, t.id, *src, bad, bad, kBlock, 2.0, out, 2);

    Frame repair_frame = -1;
    REQUIRE(engine.take_repair_request(repair_frame));
    engine.prepare_for_pitch_repair(repair_frame, session, sources);

    const auto d = engine.diagnostics();
    CHECK(d.pitch_repair_requested_count >= 1);
    CHECK(d.pitch_repair_completed_count >= 1);
    CHECK(d.pitch_repair_completed_count == d.pitch_repair_requested_count);
}

// ---------------------------------------------------------------------------
// 9-B: active_stream_swap_count increments once per publish, visible in
//      diagnostics on the engine (rounds trips through the atomic correctly).
// ---------------------------------------------------------------------------
TEST_CASE("diagnostics_active_stream_swap_count_visible_after_discontinuity") {
    constexpr Frame dur = kSR * 4;
    SourceManager sources;
    add_source(sources, "src", dur);

    Session session;
    session.sample_rate = kSR;
    session.sources = {Source{"src", ""}};
    Song song; song.id = "song"; song.start_frame = 0; song.end_frame = dur;
    song.transpose_semitones = 3;
    Track track; track.id = "t"; track.kind = TrackKind::Audio;
    track.clips.push_back(Clip{"clip", "src", 0, 0, dur});
    song.tracks.push_back(track);
    session.songs.push_back(song);

    RealtimePitchEngine engine;
    engine.prepare_for_session(session, sources, kSR);      // publish 1

    const auto gen0 = engine.diagnostics().active_stream_swap_count;
    engine.prepare_for_play(0, session, sources);           // publish 2
    const auto gen1 = engine.diagnostics().active_stream_swap_count;
    engine.prepare_for_transport_discontinuity(kSR, "seek", session, sources);  // publish 3
    const auto gen2 = engine.diagnostics().active_stream_swap_count;

    CHECK(gen1 == gen0 + 1);
    CHECK(gen2 == gen1 + 1);
}

// ---------------------------------------------------------------------------
// 9-C: unsafe_cross_thread_reset_count stays 0 throughout normal operations
//      (session load, play, seek). Any nonzero value is a crash risk.
// ---------------------------------------------------------------------------
TEST_CASE("diagnostics_unsafe_cross_thread_reset_stays_zero_normal_ops") {
    constexpr Frame dur = kSR * 4;
    SourceManager sources;
    add_source(sources, "src", dur);

    auto session = std::make_shared<Session>();
    session->sample_rate = kSR;
    session->sources = {Source{"src", ""}};
    Song song; song.id = "song"; song.start_frame = 0; song.end_frame = dur;
    song.transpose_semitones = 2;
    Track track; track.id = "t"; track.kind = TrackKind::Audio;
    track.clips.push_back(Clip{"clip", "src", 0, 0, dur});
    song.tracks.push_back(track);
    session->songs.push_back(song);

    TransportClock clock(kSR);
    JumpScheduler scheduler;
    RealtimePitchEngine pitch;
    pitch.prepare_for_session(*session, sources, kSR);
    pitch.prepare_for_play(0, *session, sources);

    Mixer mixer(session, &sources, &clock, &scheduler, nullptr, &pitch);
    mixer.prepare_render_resources(kBlock);
    clock.play();

    std::vector<float> out_l(kBlock, 0.f), out_r(kBlock, 0.f);
    float* out[2] = { out_l.data(), out_r.data() };

    for (int i = 0; i < 16; ++i)
        mixer.render(out, 2, kBlock, kSR);

    // Seek and rebuild.
    clock.seek(kSR * 2);
    pitch.prepare_for_transport_discontinuity(kSR * 2, "seek", *session, sources);
    mixer.trigger_crossfade();

    for (int i = 0; i < 16; ++i)
        mixer.render(out, 2, kBlock, kSR);

    // Load a new session.
    auto next = std::make_shared<Session>(*session);
    mixer.set_session(next, false);
    pitch.prepare_for_session(*next, sources, kSR);

    for (int i = 0; i < 8; ++i)
        mixer.render(out, 2, kBlock, kSR);

    CHECK(pitch.diagnostics().unsafe_cross_thread_reset_count == 0);
    CHECK(pitch.diagnostics().concurrent_stream_mutation_detected == 0);
}

// =============================================================================
// Phase 10 — Acceptance criteria sweep
// =============================================================================

// AC-1: No crash or corruption from concurrent seek+render (stream immutability).
//       Covered by 7-B. This AC-named alias makes the intent explicit in the report.
TEST_CASE("AC1_no_crash_from_concurrent_seek_and_render") {
    constexpr Frame dur = kSR * 20;
    auto samples = test::make_stereo_sine(dur, 440.0, 0.2f);
    SourceManager sources;
    sources.register_source("src", "");
    REQUIRE(sources.store_decoded_source("src", samples, 2, kSR, dur).is_ok());
    auto session = [&] {
        Session s; s.sample_rate = kSR; s.sources = {Source{"src", ""}};
        Song song; song.id = "song"; song.start_frame = 0; song.end_frame = dur;
        song.transpose_semitones = 2;
        Track t; t.id = "t"; t.kind = TrackKind::Audio;
        t.clips.push_back(Clip{"c", "src", 0, 0, dur});
        song.tracks.push_back(t); s.songs.push_back(song); return s;
    }();

    RealtimePitchEngine engine;
    engine.prepare_for_session(session, sources, kSR);
    engine.prepare_for_play(0, session, sources);

    std::atomic<bool> stop{false}, had_nan{false};
    std::thread audio([&] {
        const auto& t = session.songs[0].tracks[0];
        const auto& c = t.clips[0];
        const auto* src = sources.get("src");
        float ol[kBlock] = {}, or_[kBlock] = {};
        float* out[2] = { ol, or_ };
        Frame f = 0;
        while (!stop.load(std::memory_order_acquire)) {
            engine.render_pitched_clip(c, t.id, *src, f, f, kBlock, 2.0, out, 2);
            for (int i = 0; i < kBlock; ++i)
                if (!std::isfinite(ol[i]) || !std::isfinite(or_[i]))
                    had_nan.store(true, std::memory_order_release);
            f = (f + kBlock) % (dur - kBlock);
        }
    });
    for (int i = 0; i < 80; ++i)
        engine.prepare_for_transport_discontinuity(
            static_cast<Frame>((i * 48007) % (dur - kSR)), "seek", session, sources);
    stop.store(true, std::memory_order_release);
    audio.join();

    CHECK_FALSE(had_nan.load());
    CHECK(engine.diagnostics().unsafe_cross_thread_reset_count == 0);
    CHECK(engine.diagnostics().concurrent_stream_mutation_detected == 0);
}

// AC-2: No fade-in after scheduled jump — stream is primed at the jump target
//       before the first audible block. Verified via mismatch count staying 0.
TEST_CASE("AC2_no_mismatch_after_scheduled_jump_pitch_repair") {
    constexpr Frame dur = kSR * 8;
    SourceManager sources;
    add_source(sources, "src", dur);

    Session session;
    session.sample_rate = kSR;
    session.sources = {Source{"src", ""}};
    Song song; song.id = "song"; song.start_frame = 0; song.end_frame = dur;
    song.transpose_semitones = 3;
    Track track; track.id = "t"; track.kind = TrackKind::Audio;
    track.clips.push_back(Clip{"c", "src", 0, 0, dur});
    song.tracks.push_back(track);
    session.songs.push_back(song);

    RealtimePitchEngine engine;
    engine.prepare_for_session(session, sources, kSR);
    engine.prepare_for_play(0, session, sources);

    const auto& t = session.songs[0].tracks[0];
    const auto& c = t.clips[0];
    const auto* src = sources.get("src");
    REQUIRE(src != nullptr);
    float ol[kBlock] = {}, or_[kBlock] = {};
    float* out[2] = { ol, or_ };

    // Simulate 4 blocks of normal playback at frame 0.
    for (int i = 0; i < 4; ++i)
        engine.render_pitched_clip(c, t.id, *src,
            static_cast<Frame>(i * kBlock), static_cast<Frame>(i * kBlock),
            kBlock, 3.0, out, 2);

    // Simulate scheduled jump: control thread receives jump frame and rebuilds.
    const Frame jump_target = kSR * 5;
    engine.prepare_for_transport_discontinuity(jump_target, "scheduled_jump", session, sources);

    const auto mismatch_before = engine.diagnostics().pitch_timeline_mismatch_count;

    // First render at the jump target — must not be a mismatch.
    engine.render_pitched_clip(c, t.id, *src, jump_target, jump_target, kBlock, 3.0, out, 2);

    const auto mismatch_after = engine.diagnostics().pitch_timeline_mismatch_count;
    CHECK(mismatch_after == mismatch_before);
    CHECK(engine.diagnostics().unsafe_cross_thread_reset_count == 0);
}

// AC-3: T-button toggle must not crash, silence, or produce NaN output.
TEST_CASE("AC3_T_button_toggle_no_crash_no_nan") {
    constexpr Frame dur = kSR * 4;
    SourceManager sources;
    add_source(sources, "src", dur, 0.4f);

    auto session = std::make_shared<Session>();
    session->sample_rate = kSR;
    session->sources = {Source{"src", ""}};
    Song song; song.id = "song"; song.start_frame = 0; song.end_frame = dur;
    song.transpose_semitones = 3;
    Track track; track.id = "t"; track.kind = TrackKind::Audio;
    track.transpose_behavior = TransposeBehavior::FollowsSongOrRegion;
    track.clips.push_back(Clip{"c", "src", 0, 0, dur});
    song.tracks.push_back(track);
    session->songs.push_back(song);

    TransportClock clock(kSR);
    JumpScheduler scheduler;
    RealtimePitchEngine pitch;
    pitch.prepare_for_session(*session, sources, kSR);
    pitch.prepare_for_play(0, *session, sources);

    Mixer mixer(session, &sources, &clock, &scheduler, nullptr, &pitch);
    mixer.prepare_render_resources(kBlock);
    clock.play();

    std::vector<float> ol(kBlock, 0.f), or_(kBlock, 0.f);
    float* out[2] = { ol.data(), or_.data() };

    auto do_render_check = [&](int n) {
        for (int i = 0; i < n; ++i) {
            std::fill(ol.begin(), ol.end(), 0.f);
            std::fill(or_.begin(), or_.end(), 0.f);
            mixer.render(out, 2, kBlock, kSR);
            for (float v : ol) CHECK(std::isfinite(v));
            for (float v : or_) CHECK(std::isfinite(v));
        }
    };

    do_render_check(8);

    // Toggle T off (NeverTranspose).
    {
        auto next = std::make_shared<Session>(*session);
        next->songs[0].tracks[0].transpose_behavior = TransposeBehavior::NeverTranspose;
        pitch.prepare_for_transport_discontinuity(
            clock.position().frame, "set_transpose_enabled", *next, sources);
        mixer.set_session(next, true);
        mixer.trigger_crossfade();
    }
    do_render_check(8);

    // Toggle T back on.
    {
        auto next = std::make_shared<Session>(*session);
        next->songs[0].tracks[0].transpose_behavior = TransposeBehavior::FollowsSongOrRegion;
        pitch.prepare_for_transport_discontinuity(
            clock.position().frame, "set_transpose_enabled", *next, sources);
        mixer.set_session(next, true);
        mixer.trigger_crossfade();
    }
    do_render_check(8);

    CHECK(pitch.diagnostics().unsafe_cross_thread_reset_count == 0);
}

// AC-4: audio_thread_reset_count and audio_thread_prime_count stay 0 through
//       normal seek+play cycles — audio thread never touches stream state.
TEST_CASE("AC4_audio_thread_never_resets_or_primes_through_seek_play") {
    constexpr Frame dur = kSR * 4;
    SourceManager sources;
    add_source(sources, "src", dur);

    Session session;
    session.sample_rate = kSR;
    session.sources = {Source{"src", ""}};
    Song song; song.id = "song"; song.start_frame = 0; song.end_frame = dur;
    song.transpose_semitones = 2;
    Track track; track.id = "t"; track.kind = TrackKind::Audio;
    track.clips.push_back(Clip{"c", "src", 0, 0, dur});
    song.tracks.push_back(track);
    session.songs.push_back(song);

    RealtimePitchEngine engine;
    engine.prepare_for_session(session, sources, kSR);
    engine.prepare_for_play(0, session, sources);

    const auto& t = session.songs[0].tracks[0];
    const auto& c = t.clips[0];
    const auto* src = sources.get("src");
    REQUIRE(src != nullptr);
    float ol[kBlock] = {}, or_[kBlock] = {};
    float* out[2] = { ol, or_ };

    for (int i = 0; i < 32; ++i)
        engine.render_pitched_clip(c, t.id, *src,
            static_cast<Frame>(i * kBlock), static_cast<Frame>(i * kBlock),
            kBlock, 2.0, out, 2);

    engine.prepare_for_transport_discontinuity(kSR * 2, "seek", session, sources);

    for (int i = 0; i < 32; ++i) {
        const Frame f = static_cast<Frame>(kSR * 2 + i * kBlock);
        engine.render_pitched_clip(c, t.id, *src, f, f, kBlock, 2.0, out, 2);
    }

    auto d = engine.diagnostics();
    CHECK(d.pitch_audio_thread_reset_count == 0);
    CHECK(d.pitch_audio_thread_prime_count == 0);
    CHECK(d.unsafe_cross_thread_reset_count == 0);
}

// AC-5: scratch_resize_in_audio_thread_count == 0 after prepare_render_resources
//       is called before playback. The pre-allocation must cover all block sizes.
TEST_CASE("AC5_no_scratch_resize_in_audio_thread_after_prepare") {
    constexpr Frame dur = kSR * 4;
    SourceManager sources;
    add_source(sources, "src", dur);

    auto session = std::make_shared<Session>();
    session->sample_rate = kSR;
    session->sources = {Source{"src", ""}};
    Song song; song.id = "song"; song.start_frame = 0; song.end_frame = dur;
    song.transpose_semitones = 3;
    Track track; track.id = "t"; track.kind = TrackKind::Audio;
    track.clips.push_back(Clip{"c", "src", 0, 0, dur});
    song.tracks.push_back(track);
    session->songs.push_back(song);

    TransportClock clock(kSR);
    JumpScheduler scheduler;
    RealtimePitchEngine pitch;
    pitch.prepare_for_session(*session, sources, kSR);
    pitch.prepare_for_play(0, *session, sources);

    Mixer mixer(session, &sources, &clock, &scheduler, nullptr, &pitch);
    mixer.prepare_render_resources(kBlock);  // pre-allocate
    clock.play();

    TrackRenderer::reset_diagnostics();

    std::vector<float> ol(kBlock, 0.f), or_(kBlock, 0.f);
    float* out[2] = { ol.data(), or_.data() };
    for (int i = 0; i < 64; ++i)
        mixer.render(out, 2, kBlock, kSR);

    CHECK(TrackRenderer::diagnostics().scratch_resize_in_audio_thread_count == 0);
}

// AC-6: Mismatch repair — after kPitchMismatchRepairThreshold consecutive
//       mismatches, take_repair_request() must return true exactly once,
//       and prepare_for_pitch_repair must increment repair_completed_count.
TEST_CASE("AC6_mismatch_repair_fires_and_clears_exactly_once") {
    constexpr Frame dur = kSR * 4;
    SourceManager sources;
    add_source(sources, "src", dur);

    Session session;
    session.sample_rate = kSR;
    session.sources = {Source{"src", ""}};
    Song song; song.id = "song"; song.start_frame = 0; song.end_frame = dur;
    song.transpose_semitones = 2;
    Track track; track.id = "t"; track.kind = TrackKind::Audio;
    track.clips.push_back(Clip{"c", "src", 0, 0, dur});
    song.tracks.push_back(track);
    session.songs.push_back(song);

    RealtimePitchEngine engine;
    engine.prepare_for_session(session, sources, kSR);
    engine.prepare_for_play(0, session, sources);

    const auto& t = session.songs[0].tracks[0];
    const auto& c = t.clips[0];
    const auto* src = sources.get("src");
    REQUIRE(src != nullptr);
    float ol[kBlock] = {}, or_[kBlock] = {};
    float* out[2] = { ol, or_ };

    engine.render_pitched_clip(c, t.id, *src, 0, 0, kBlock, 2.0, out, 2);

    const Frame bad = kSR * 3;
    for (int i = 0; i <= kPitchMismatchRepairThreshold + 2; ++i)
        engine.render_pitched_clip(c, t.id, *src, bad, bad, kBlock, 2.0, out, 2);

    Frame repair_frame = -1;
    const bool fired = engine.take_repair_request(repair_frame);
    REQUIRE(fired);
    CHECK(repair_frame == bad);

    // Second take must return false — flag was cleared.
    Frame second = -1;
    CHECK_FALSE(engine.take_repair_request(second));

    const auto before_fix = engine.diagnostics();
    engine.prepare_for_pitch_repair(repair_frame, session, sources);
    const auto after_fix = engine.diagnostics();

    CHECK(after_fix.pitch_repair_completed_count == before_fix.pitch_repair_completed_count + 1);
    CHECK(after_fix.unsafe_cross_thread_reset_count == 0);
}

// ---------------------------------------------------------------------------
// AC-7: Rolling extend — streams for clips outside the initial 2-second
//       seek window are added by extend_for_playhead() before the audio
//       thread reaches them. Verifies that seeks "far away" don't leave
//       upcoming clips without pitch streams.
// ---------------------------------------------------------------------------
TEST_CASE("AC7_rolling_extend_adds_streams_for_clips_entering_lookahead_window") {
    // Song: 10 seconds total.
    //   clip A: [0s, 4s) — always pitched at 3 semitones
    //   clip B: [5s, 9s) — always pitched at 3 semitones (same source, different clip slot)
    // After a seek to frame 0, the 2-second window [0, 2s) does NOT include clip B.
    // After the playhead advances to 3s, extend_for_playhead(3s) makes window [3s, 5s).
    // Clip B starts at 5s — just at the edge. At playhead 3s+1 frame, window is [3s+1, 5s+1)
    // which does include clip B. We use playhead = 3s exactly so window_end = 5s == clip B start.
    // To guarantee inclusion use playhead = 3s + 1 sample.

    constexpr Frame kDur10 = kSR * 10;
    SourceManager sources;
    add_source(sources, "srcA", kDur10);
    add_source(sources, "srcB", kDur10);

    Session session;
    session.sample_rate = kSR;
    session.sources = {Source{"srcA", ""}, Source{"srcB", ""}};

    Song song; song.id = "song"; song.start_frame = 0; song.end_frame = kDur10;
    song.transpose_semitones = 3;

    Track track; track.id = "t"; track.kind = TrackKind::Audio;
    // Clip A: [0s, 4s)
    Clip clipA{"cA", "srcA", 0, 0, static_cast<Frame>(kSR * 4)};
    // Clip B: [5s, 9s)
    Clip clipB{"cB", "srcB", static_cast<Frame>(kSR * 5), 0, static_cast<Frame>(kSR * 4)};
    track.clips.push_back(clipA);
    track.clips.push_back(clipB);
    song.tracks.push_back(track);
    session.songs.push_back(song);

    RealtimePitchEngine engine;
    engine.prepare_for_session(session, sources, kSR);
    // Seek to frame 0: builds window [0, 2s). Only clip A is in range.
    engine.prepare_for_play(0, session, sources);

    const auto after_play = engine.diagnostics();
    // Clip A should have a stream; clip B (starts at 5s) is outside [0, 2s).
    CHECK(after_play.active_pitch_stream_count >= 1);

    const Frame stream_count_at_seek = after_play.active_pitch_stream_count;

    // Simulate playhead advancing to 3s (past clip A's stream but before clip B).
    // The retrigger threshold is 1s, so 3s > 0s + 1s → extend fires.
    const Frame playhead_3s = static_cast<Frame>(kSR * 3) + 1;
    const int added = engine.extend_for_playhead(playhead_3s, session, sources);

    const auto after_extend = engine.diagnostics();

    // extend_for_playhead must have added clip B's stream (window [3s+1, 5s+1) includes [5s, 9s)).
    CHECK(added >= 1);
    CHECK(after_extend.active_pitch_stream_count > stream_count_at_seek);

    // Existing clip A stream must still be there (total >= 2).
    CHECK(after_extend.active_pitch_stream_count >= 2);

    // Rendering at clip B's start must not produce a missing_stream_count increment.
    const auto* srcB = sources.get("srcB");
    REQUIRE(srcB != nullptr);
    float ol[kBlock] = {}, or_[kBlock] = {};
    float* out2[2] = { ol, or_ };

    engine.reset_diagnostics();
    const Frame clipB_start = static_cast<Frame>(kSR * 5);
    engine.render_pitched_clip(clipB, "t", *srcB, 0, clipB_start, kBlock, 3.0, out2, 2);

    CHECK(engine.diagnostics().missing_stream_count == 0);
}

// ---------------------------------------------------------------------------
// AC-8: Seeking to a position far from frame 0 (e.g., 30 seconds into a
//       60-second clip) produces a valid stream with no missing_stream count
//       on the first render. Verifies the long-seek priming path.
// ---------------------------------------------------------------------------
TEST_CASE("AC8_far_seek_produces_valid_stream_no_missing_on_first_render") {
    // 60-second clip — seek to 30 seconds in.
    constexpr Frame kDur60 = static_cast<Frame>(kSR) * 60;
    SourceManager sources;
    add_source(sources, "src", kDur60);

    Session session;
    session.sample_rate = kSR;
    session.sources = {Source{"src", ""}};
    Song song; song.id = "song"; song.start_frame = 0; song.end_frame = kDur60;
    song.transpose_semitones = 2;
    Track track; track.id = "t"; track.kind = TrackKind::Audio;
    track.clips.push_back(Clip{"c", "src", 0, 0, kDur60});
    song.tracks.push_back(track);
    session.songs.push_back(song);

    RealtimePitchEngine engine;
    engine.prepare_for_session(session, sources, kSR);

    // Seek to 30 seconds in — well outside the 2-second initial window.
    const Frame far_frame = static_cast<Frame>(kSR) * 30;
    engine.prepare_for_transport_discontinuity(far_frame, "seek_absolute", session, sources);

    const auto after_seek = engine.diagnostics();
    CHECK(after_seek.active_pitch_stream_count >= 1);

    const auto& t = session.songs[0].tracks[0];
    const auto& c = t.clips[0];
    const auto* src = sources.get("src");
    REQUIRE(src != nullptr);
    float ol[kBlock] = {}, or_[kBlock] = {};
    float* out2[2] = { ol, or_ };

    engine.reset_diagnostics();
    engine.render_pitched_clip(c, t.id, *src, far_frame, far_frame, kBlock, 2.0, out2, 2);

    // Stream was primed at far_frame — first block must not be missing.
    CHECK(engine.diagnostics().missing_stream_count == 0);
    // Output must be finite (not uninitialized memory).
    for (int i = 0; i < kBlock; ++i) CHECK(std::isfinite(ol[i]));
}
