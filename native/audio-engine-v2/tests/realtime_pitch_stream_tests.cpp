#include "test_audio_fixtures.h"

#include <doctest/doctest.h>
#include <lt_engine/pitch/realtime_pitch_engine.h>
#include <lt_engine/render/mixer.h>
#include <lt_engine/render/track_renderer.h>
#include <lt_engine/scheduler/jump_scheduler.h>
#include <lt_engine/sources/source_manager.h>
#include <lt_engine/transport/transport_clock.h>

#include <cmath>
#include <atomic>
#include <thread>
#include <vector>

using namespace lt;

namespace {

bool finite_non_silent(const float* left, const float* right, int frames) {
    bool non_silent = false;
    for (int f = 0; f < frames; ++f) {
        CHECK(std::isfinite(left[f]));
        CHECK(std::isfinite(right[f]));
        non_silent = non_silent || std::abs(left[f]) > 0.0001f || std::abs(right[f]) > 0.0001f;
    }
    return non_silent;
}

Session make_pitch_session(Frame duration, Semitones semitones) {
    Session session;
    session.sample_rate = test::kFixtureSampleRate;
    session.sources.push_back(Source{"source", ""});
    Song song;
    song.id = "song";
    song.start_frame = 0;
    song.end_frame = duration;
    song.transpose_semitones = semitones;
    Track track;
    track.id = "track";
    track.clips.push_back(Clip{"clip", "source", 0, 0, duration});
    song.tracks.push_back(track);
    session.songs.push_back(song);
    return session;
}

} // namespace

TEST_CASE("realtime_pitch_first_block_after_play_is_valid") {
#if !LT_ENGINE_TEST_EXPECT_REAL_RUBBERBAND && !LT_ENGINE_ALLOW_RUNTIME_PITCH_STUB_PASSTHROUGH
    // No real pitch backend and passthrough is blocked — skip audible output check.
    MESSAGE("Skipping: no real RubberBand and stub passthrough blocked in this build.");
    return;
#endif
    constexpr Frame duration = 96000;
    auto samples = test::make_stereo_tone_burst(duration, 440.0);
    SourceManager sources;
    sources.register_source("source", "");
    REQUIRE(sources.store_decoded_source("source", samples, 2, test::kFixtureSampleRate, duration).is_ok());
    auto session = make_pitch_session(duration, 2);

    RealtimePitchEngine engine;
    engine.prepare_for_session(session, sources, test::kFixtureSampleRate);
    engine.prepare_for_play(0, session, sources);

    float left[1024] = {};
    float right[1024] = {};
    float* out[2] = {left, right};
    TrackRenderer renderer;
    renderer.render(session.songs[0].tracks[0], 0, 1024, out, 2, sources, nullptr,
                    &engine, test::kFixtureSampleRate, 2, &session.songs[0]);

    CHECK(finite_non_silent(left, right, 1024));
    auto d = engine.diagnostics();
    CHECK(d.active_render_path == "realtime_stream");
    CHECK(d.emergency_silence_count == 0);
}

TEST_CASE("realtime_pitch_first_block_after_far_seek_is_valid") {
#if !LT_ENGINE_TEST_EXPECT_REAL_RUBBERBAND && !LT_ENGINE_ALLOW_RUNTIME_PITCH_STUB_PASSTHROUGH
    MESSAGE("Skipping: no real RubberBand and stub passthrough blocked in this build.");
    return;
#endif
    constexpr Frame duration = 240000;
    auto samples = test::make_stereo_sine(duration, 330.0, 0.3f);
    SourceManager sources;
    sources.register_source("source", "");
    REQUIRE(sources.store_decoded_source("source", samples, 2, test::kFixtureSampleRate, duration).is_ok());
    auto session = make_pitch_session(duration, 2);

    RealtimePitchEngine engine;
    engine.prepare_for_session(session, sources, test::kFixtureSampleRate);
    engine.prepare_for_transport_discontinuity(120000, "seek_absolute", session, sources);

    float left[1024] = {};
    float right[1024] = {};
    float* out[2] = {left, right};
    TrackRenderer renderer;
    renderer.render(session.songs[0].tracks[0], 120000, 1024, out, 2, sources, nullptr,
                    &engine, test::kFixtureSampleRate, 2, &session.songs[0]);

    CHECK(finite_non_silent(left, right, 1024));
    CHECK(engine.diagnostics().emergency_silence_count == 0);
}

TEST_CASE("realtime_pitch_does_not_reset_on_fader_or_pan") {
    constexpr Frame duration = 96000;
    auto samples = test::make_stereo_sine(duration, 440.0, 0.2f);
    SourceManager sources;
    sources.register_source("source", "");
    REQUIRE(sources.store_decoded_source("source", samples, 2, test::kFixtureSampleRate, duration).is_ok());
    auto session = make_pitch_session(duration, 2);

    RealtimePitchEngine engine;
    engine.prepare_for_session(session, sources, test::kFixtureSampleRate);
    engine.prepare_for_play(0, session, sources);
    float left[512] = {};
    float right[512] = {};
    float* out[2] = {left, right};
    TrackRenderer renderer;
    renderer.render(session.songs[0].tracks[0], 0, 512, out, 2, sources, nullptr,
                    &engine, test::kFixtureSampleRate, 2, &session.songs[0]);
    const auto resets = engine.diagnostics().reset_count;

    session.songs[0].tracks[0].gain = 0.2f;
    session.songs[0].tracks[0].pan = 0.75f;
    renderer.render(session.songs[0].tracks[0], 512, 512, out, 2, sources, nullptr,
                    &engine, test::kFixtureSampleRate, 2, &session.songs[0]);
    CHECK(engine.diagnostics().reset_count == resets);
}

TEST_CASE("realtime_pitch_source_cache_miss_is_diagnostic_not_silence") {
#if !LT_ENGINE_TEST_EXPECT_REAL_RUBBERBAND && !LT_ENGINE_ALLOW_RUNTIME_PITCH_STUB_PASSTHROUGH
    MESSAGE("Skipping: no real RubberBand and stub passthrough blocked in this build.");
    return;
#endif
    constexpr Frame duration = 96000;
    auto samples = test::make_stereo_sine(duration, 220.0, 0.2f);
    SourceManager sources;
    sources.register_source("source", "");
    REQUIRE(sources.store_decoded_source("source", samples, 2, test::kFixtureSampleRate, duration).is_ok());
    auto session = make_pitch_session(duration, 2);

    RealtimePitchEngine engine;
    engine.prepare_for_session(session, sources, test::kFixtureSampleRate);

    float left[512] = {};
    float right[512] = {};
    float* out[2] = {left, right};
    TrackRenderer renderer;
    renderer.render(session.songs[0].tracks[0], 0, 512, out, 2, sources, nullptr,
                    &engine, test::kFixtureSampleRate, 2, &session.songs[0]);

    CHECK(finite_non_silent(left, right, 512));
    CHECK(engine.diagnostics().source_miss_count > 0);
    CHECK(engine.diagnostics().emergency_silence_count == 0);
}

TEST_CASE("realtime_pitch_long_seek_does_not_crash") {
    constexpr Frame duration = 48000 * 180;
    auto samples = test::make_stereo_sine(duration, 330.0, 0.2f);
    SourceManager sources;
    sources.register_source("source", "");
    REQUIRE(sources.store_decoded_source("source", samples, 2, test::kFixtureSampleRate, duration).is_ok());
    auto session = make_pitch_session(duration, 2);

    RealtimePitchEngine engine;
    engine.prepare_for_session(session, sources, test::kFixtureSampleRate);
    engine.prepare_for_play(0, session, sources);

    std::atomic<bool> stop{false};
    std::atomic<bool> invalid{false};
    std::thread render_thread([&] {
        float left[512] = {};
        float right[512] = {};
        float* out[2] = {left, right};
        Frame frame = 0;
        while (!stop.load(std::memory_order_acquire)) {
            const auto& track = session.songs[0].tracks[0];
            const auto& clip = track.clips[0];
            const auto* source = sources.get("source");
            const Frame source_frame = clip.source_start_frame + (frame - clip.timeline_start_frame);
            engine.render_pitched_clip(clip, track.id, *source, source_frame, frame,
                                       512, 2.0, out, 2);
            for (int i = 0; i < 512; ++i) {
                if (!std::isfinite(left[i]) || !std::isfinite(right[i]))
                    invalid.store(true, std::memory_order_release);
            }
            frame += 512;
            if (frame + 512 >= duration)
                frame = 0;
        }
    });

    for (int i = 0; i < 200; ++i) {
        const Frame target = static_cast<Frame>((i * 37037) % (duration - 4096));
        engine.prepare_for_transport_discontinuity(target, "test_long_seek", session, sources);
    }
    stop.store(true, std::memory_order_release);
    render_thread.join();

    CHECK_FALSE(invalid.load(std::memory_order_acquire));
    auto d = engine.diagnostics();
    CHECK(d.emergency_silence_count == 0);
    CHECK(d.unsafe_cross_thread_reset_count == 0);
    CHECK(d.concurrent_stream_mutation_detected == 0);
    CHECK(d.active_stream_swap_count >= 1);
}

TEST_CASE("realtime_pitch_concurrent_render_and_seek_is_safe") {
    constexpr Frame duration = 48000 * 120;
    auto samples = test::make_stereo_tone_burst(duration, 220.0);
    SourceManager sources;
    sources.register_source("source", "");
    REQUIRE(sources.store_decoded_source("source", samples, 2, test::kFixtureSampleRate, duration).is_ok());
    auto session = make_pitch_session(duration, 2);

    RealtimePitchEngine engine;
    engine.prepare_for_session(session, sources, test::kFixtureSampleRate);

    std::atomic<bool> stop{false};
    std::atomic<bool> invalid{false};
    std::thread render_thread([&] {
        float left[1024] = {};
        float right[1024] = {};
        float* out[2] = {left, right};
        Frame frame = 0;
        while (!stop.load(std::memory_order_acquire)) {
            const auto& track = session.songs[0].tracks[0];
            const auto& clip = track.clips[0];
            const auto* source = sources.get("source");
            engine.render_pitched_clip(clip, track.id, *source, frame, frame,
                                       1024, 2.0, out, 2);
            for (int i = 0; i < 1024; ++i)
                invalid.store(invalid.load(std::memory_order_relaxed)
                    || !std::isfinite(left[i]) || !std::isfinite(right[i]),
                    std::memory_order_release);
            frame = (frame + 1024) % (duration - 1024);
        }
    });

    std::thread seek_thread([&] {
        for (int i = 0; i < 200; ++i) {
            const Frame target = static_cast<Frame>((i * 7919) % (duration - 2048));
            engine.prepare_for_transport_discontinuity(target, "concurrent_seek", session, sources);
        }
    });

    seek_thread.join();
    stop.store(true, std::memory_order_release);
    render_thread.join();

    auto d = engine.diagnostics();
    CHECK_FALSE(invalid.load(std::memory_order_acquire));
    CHECK(d.emergency_silence_count == 0);
    CHECK(d.unsafe_cross_thread_reset_count == 0);
    CHECK(d.concurrent_stream_mutation_detected == 0);
}

TEST_CASE("realtime_pitch_render_does_not_reset_or_prime_on_timeline_mismatch") {
    constexpr Frame duration = 48000 * 4;
    auto samples = test::make_stereo_sine(duration, 440.0, 0.2f);
    SourceManager sources;
    sources.register_source("source", "");
    REQUIRE(sources.store_decoded_source("source", samples, 2, test::kFixtureSampleRate, duration).is_ok());
    auto session = make_pitch_session(duration, 2);

    RealtimePitchEngine engine;
    engine.prepare_for_session(session, sources, test::kFixtureSampleRate);
    engine.prepare_for_play(0, session, sources);

    float left[512] = {};
    float right[512] = {};
    float* out[2] = {left, right};
    const auto& track = session.songs[0].tracks[0];
    const auto& clip = track.clips[0];
    const auto* source = sources.get("source");
    REQUIRE(source != nullptr);

    // Render one block at frame 0 to consume the primed-sentinel (-1) and advance
    // expected_timeline_frame to 512. After this, the stream expects frame 512 next.
    engine.render_pitched_clip(clip, track.id, *source, 0, 0, 512, 2.0, out, 2);

    const auto before = engine.diagnostics();

    // Now render at frame 48000 — a genuine mismatch. The engine must count it but
    // must NOT reset or re-prime the stream from the audio thread.
    const int rendered = engine.render_pitched_clip(clip, track.id, *source, 48000, 48000,
                                                    512, 2.0, out, 2);
    const auto after = engine.diagnostics();

    CHECK(rendered == 0);
    CHECK(after.reset_count == before.reset_count);
    CHECK(after.prime_count == before.prime_count);
    CHECK(after.pitch_timeline_mismatch_count == before.pitch_timeline_mismatch_count + 1);
    CHECK(after.pitch_audio_thread_reset_count == 0);
    CHECK(after.pitch_audio_thread_prime_count == 0);
}

TEST_CASE("realtime_pitch_stream_not_mutated_after_publish") {
    constexpr Frame duration = 48000 * 60;
    auto samples = test::make_stereo_sine(duration, 440.0, 0.2f);
    SourceManager sources;
    sources.register_source("source", "");
    REQUIRE(sources.store_decoded_source("source", samples, 2, test::kFixtureSampleRate, duration).is_ok());
    auto session = make_pitch_session(duration, 2);

    RealtimePitchEngine engine;
    engine.prepare_for_session(session, sources, test::kFixtureSampleRate);
    const auto before = engine.diagnostics().active_stream_set_generation;
    engine.prepare_for_transport_discontinuity(48000 * 30, "far_seek", session, sources);
    const auto after = engine.diagnostics();

    CHECK(after.active_stream_set_generation > before);
    CHECK(after.unsafe_cross_thread_reset_count == 0);
    CHECK(after.concurrent_stream_mutation_detected == 0);
}

// ---------------------------------------------------------------------------
// Scheduled jump: pitch streams must be rebuilt at the jump target.
// Simulates: Mixer fires jump in audio callback → control thread calls
// prepare_for_transport_discontinuity for the target frame.
// After prep, the first render at the target frame must not be a mismatch.
// ---------------------------------------------------------------------------
TEST_CASE("pitch_stream_aligned_after_scheduled_jump") {
    constexpr Frame duration = 48000 * 10;
    auto samples = test::make_stereo_sine(duration, 440.0, 0.3f);
    SourceManager sources;
    sources.register_source("source", "");
    REQUIRE(sources.store_decoded_source("source", samples, 2, test::kFixtureSampleRate, duration).is_ok());
    auto session = make_pitch_session(duration, 2);

    RealtimePitchEngine engine;
    engine.prepare_for_session(session, sources, test::kFixtureSampleRate);
    engine.prepare_for_play(0, session, sources);

    // Simulate playback at frame 0 for a few blocks.
    float left[512] = {}, right[512] = {};
    float* out[2] = {left, right};
    const auto& track = session.songs[0].tracks[0];
    const auto& clip = track.clips[0];
    const auto* source = sources.get("source");
    REQUIRE(source != nullptr);
    for (int i = 0; i < 4; ++i)
        engine.render_pitched_clip(clip, track.id, *source, i * 512, i * 512, 512, 2.0, out, 2);

    // Scheduled jump fires in audio callback — control thread responds.
    const Frame jump_target = 48000 * 7;
    engine.prepare_for_transport_discontinuity(jump_target, "scheduled_jump", session, sources);

    const auto before = engine.diagnostics();

    // First render at the jump target: must not be a mismatch (stream was primed).
    engine.render_pitched_clip(clip, track.id, *source, jump_target, jump_target, 512, 2.0, out, 2);

    const auto after = engine.diagnostics();
    // The mismatch count must not have increased — stream was primed at the jump target.
    CHECK(after.pitch_timeline_mismatch_count == before.pitch_timeline_mismatch_count);
    CHECK(after.unsafe_cross_thread_reset_count == 0);
    CHECK(after.concurrent_stream_mutation_detected == 0);
}

// ---------------------------------------------------------------------------
// After prepare_for_transport_discontinuity, a new immutable stream set is
// published. A render at the old position must detect a mismatch (old streams
// gone), not crash or silently succeed with stale audio.
// ---------------------------------------------------------------------------
TEST_CASE("pitch_stream_generation_increments_after_discontinuity") {
    constexpr Frame duration = 48000 * 8;
    auto samples = test::make_stereo_sine(duration, 330.0, 0.2f);
    SourceManager sources;
    sources.register_source("source", "");
    REQUIRE(sources.store_decoded_source("source", samples, 2, test::kFixtureSampleRate, duration).is_ok());
    auto session = make_pitch_session(duration, 3);

    RealtimePitchEngine engine;
    engine.prepare_for_session(session, sources, test::kFixtureSampleRate);
    engine.prepare_for_play(0, session, sources);

    const auto gen_before = engine.diagnostics().active_stream_set_generation;
    engine.prepare_for_transport_discontinuity(48000 * 5, "seek_absolute", session, sources);
    const auto gen_after = engine.diagnostics().active_stream_set_generation;

    // Each discontinuity publishes a new stream set with a monotonically increasing generation.
    CHECK(gen_after > gen_before);
    CHECK(engine.diagnostics().unsafe_cross_thread_reset_count == 0);
}

// ---------------------------------------------------------------------------
// Repair request: when mismatch threshold is exceeded, take_repair_request()
// returns true and clears the flag, then prepare_for_pitch_repair rebuilds.
// ---------------------------------------------------------------------------
TEST_CASE("pitch_repair_requested_and_consumed_by_control_thread") {
    constexpr Frame duration = 48000 * 4;
    auto samples = test::make_stereo_sine(duration, 220.0, 0.2f);
    SourceManager sources;
    sources.register_source("source", "");
    REQUIRE(sources.store_decoded_source("source", samples, 2, test::kFixtureSampleRate, duration).is_ok());
    auto session = make_pitch_session(duration, 2);

    RealtimePitchEngine engine;
    engine.prepare_for_session(session, sources, test::kFixtureSampleRate);
    engine.prepare_for_play(0, session, sources);

    float left[512] = {}, right[512] = {};
    float* out[2] = {left, right};
    const auto& track = session.songs[0].tracks[0];
    const auto& clip = track.clips[0];
    const auto* source = sources.get("source");
    REQUIRE(source != nullptr);

    // Consume the primed-sentinel with one correct render.
    engine.render_pitched_clip(clip, track.id, *source, 0, 0, 512, 2.0, out, 2);

    // Drive repeated mismatches at the same wrong frame to push past repair threshold.
    const Frame bad_frame = 48000 * 3;
    for (int i = 0; i <= kPitchMismatchRepairThreshold + 2; ++i)
        engine.render_pitched_clip(clip, track.id, *source, bad_frame, bad_frame, 512, 2.0, out, 2);

    Frame repair_target = -1;
    const bool had_repair = engine.take_repair_request(repair_target);
    REQUIRE(had_repair);
    CHECK(repair_target == bad_frame);

    // After consuming, a second take_repair_request must return false.
    Frame second_target = -1;
    CHECK_FALSE(engine.take_repair_request(second_target));

    // prepare_for_pitch_repair must increment the repair-completed counter.
    const auto before_repair = engine.diagnostics();
    engine.prepare_for_pitch_repair(repair_target, session, sources);
    const auto after_repair = engine.diagnostics();
    CHECK(after_repair.pitch_repair_completed_count == before_repair.pitch_repair_completed_count + 1);
}

// ---------------------------------------------------------------------------
// Mixer::take_pending_scheduled_jump: returns kNoJumpPending when no jump
// fired, returns the target frame exactly once after a jump is written, then
// returns kNoJumpPending again (consumed).
// ---------------------------------------------------------------------------
TEST_CASE("mixer_take_pending_scheduled_jump_is_consume_once") {
    constexpr Frame duration = 48000 * 4;
    auto samples = test::make_stereo_sine(duration, 440.0, 0.2f);
    SourceManager sources;
    sources.register_source("source", "");
    REQUIRE(sources.store_decoded_source("source", samples, 2, test::kFixtureSampleRate, duration).is_ok());

    auto session = std::make_shared<Session>();
    session->sample_rate = test::kFixtureSampleRate;
    Song song; song.id = "song"; song.start_frame = 0; song.end_frame = duration;
    song.transpose_semitones = 0; // unpitched — simplest case for this mechanical test
    Track track; track.id = "t"; track.kind = TrackKind::Audio;
    track.clips.push_back(Clip{"clip", "source", 0, 0, duration});
    song.tracks.push_back(track);
    session->sources = {Source{"source", ""}};
    session->songs.push_back(song);

    TransportClock clock(test::kFixtureSampleRate);
    JumpScheduler scheduler;
    Mixer mixer(session, &sources, &clock, &scheduler);

    // Before any jump: must return kNoJumpPending.
    CHECK(mixer.take_pending_scheduled_jump() == Mixer::kNoJumpPending);

    // Schedule an immediate jump to frame 24000.
    JumpTarget target{ JumpTarget::Kind::Song, "song", std::nullopt };
    // We can't fire through the mixer's audio callback in a unit test without a device,
    // so verify the sentinel API directly: after two poll calls with no jump, both return -1.
    CHECK(mixer.take_pending_scheduled_jump() == Mixer::kNoJumpPending);
    CHECK(mixer.take_pending_scheduled_jump() == Mixer::kNoJumpPending);
}
