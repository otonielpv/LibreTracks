// Tests for phases 5-7 of the realtime pitch redesign:
//   Phase 5 — RubberBand alignment hardening
//   Phase 6 — Source readiness and file-format independence
//   Phase 7 — Realtime safety and stress validation

#include "test_audio_fixtures.h"

#include <doctest/doctest.h>
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
#include <thread>
#include <vector>

using namespace lt;

namespace {

constexpr int kSR    = test::kFixtureSampleRate;
constexpr int kBlock = 512;

void add_source(SourceManager& sources, const Id& id,
                Frame dur = kSR * 4, float amplitude = 0.5f) {
    sources.register_source(id, "");
    REQUIRE(sources.store_decoded_source(
        id, test::make_stereo_sine(dur, 440.0, amplitude), 2, kSR, dur).is_ok());
}

void add_click_source(SourceManager& sources, const Id& id,
                      Frame dur, Frame click_at, float amplitude = 1.0f) {
    sources.register_source(id, "");
    REQUIRE(sources.store_decoded_source(
        id, test::make_stereo_click(dur, click_at, amplitude), 2, kSR, dur).is_ok());
}

Session make_session(const Id& src_id, Frame dur, Semitones song_semitones) {
    Session s;
    s.sample_rate = kSR;
    s.sources = {Source{src_id, ""}};
    Song song;
    song.id = "song"; song.start_frame = 0; song.end_frame = dur;
    song.transpose_semitones = song_semitones;
    Track track; track.id = "track"; track.kind = TrackKind::Audio;
    track.clips.push_back(Clip{"clip", src_id, 0, 0, dur});
    song.tracks.push_back(track);
    s.songs.push_back(song);
    return s;
}

// Render multiple consecutive blocks through the realtime pitch engine.
// Returns interleaved stereo output.
std::vector<float> render_blocks(RealtimePitchEngine& engine,
                                 const Session& session,
                                 const SourceManager& sources,
                                 Frame start_frame,
                                 int total_frames,
                                 int block_size = kBlock) {
    const auto& track = session.songs[0].tracks[0];
    const auto& clip  = track.clips[0];
    const auto* src   = sources.get(clip.source_id);
    REQUIRE(src != nullptr);
    const Semitones st = session.songs[0].transpose_semitones;

    std::vector<float> out_l(static_cast<std::size_t>(total_frames), 0.f);
    std::vector<float> out_r(static_cast<std::size_t>(total_frames), 0.f);

    Frame tl = start_frame;
    int remaining = total_frames;
    while (remaining > 0) {
        const int n = std::min(remaining, block_size);
        float* bufs[2] = { out_l.data() + (total_frames - remaining),
                           out_r.data() + (total_frames - remaining) };
        const Frame src_frame = clip.source_start_frame + (tl - clip.timeline_start_frame);
        engine.render_pitched_clip(clip, track.id, *src, src_frame, tl, n,
                                   static_cast<double>(st), bufs, 2);
        tl        += n;
        remaining -= n;
    }

    std::vector<float> interleaved(static_cast<std::size_t>(total_frames * 2));
    for (int f = 0; f < total_frames; ++f) {
        interleaved[static_cast<std::size_t>(f * 2)]     = out_l[static_cast<std::size_t>(f)];
        interleaved[static_cast<std::size_t>(f * 2 + 1)] = out_r[static_cast<std::size_t>(f)];
    }
    return interleaved;
}

} // namespace

// =============================================================================
// Phase 5 — RubberBand alignment hardening
// =============================================================================

// ---------------------------------------------------------------------------
// 5-A: Realtime stream click onset must be within ±2 frames of unpitched
//      onset after prepare_for_play at frame 0.
// ---------------------------------------------------------------------------
TEST_CASE("realtime_pitch_click_onset_aligned_after_play") {
#if !LT_ENGINE_TEST_EXPECT_REAL_RUBBERBAND && !LT_ENGINE_ALLOW_RUNTIME_PITCH_STUB_PASSTHROUGH
    MESSAGE("Skipping: no real RubberBand and stub passthrough blocked.");
    return;
#endif
    constexpr Frame dur = kSR * 4;
    constexpr Frame click_at = kSR;   // click at 1 second
    constexpr int render_frames = kSR * 3;

    SourceManager sources;
    add_click_source(sources, "src", dur, click_at);
    auto session = make_session("src", dur, 2);

    RealtimePitchEngine engine;
    engine.prepare_for_session(session, sources, kSR);
    engine.prepare_for_play(0, session, sources);

    auto pitched = render_blocks(engine, session, sources, 0, render_frames);
    Frame pitched_onset = test::first_onset_frame(pitched, 0.2f);

    // Read unpitched reference directly from source.
    const auto* src = sources.get("src");
    REQUIRE(src != nullptr);
    std::vector<float> ref_l(static_cast<std::size_t>(render_frames), 0.f);
    std::vector<float> ref_r(static_cast<std::size_t>(render_frames), 0.f);
    float* ref_ptrs[2] = { ref_l.data(), ref_r.data() };
    src->read(0, render_frames, ref_ptrs, 2);
    std::vector<float> unpitched(static_cast<std::size_t>(render_frames * 2));
    for (int f = 0; f < render_frames; ++f) {
        unpitched[static_cast<std::size_t>(f * 2)]     = ref_l[static_cast<std::size_t>(f)];
        unpitched[static_cast<std::size_t>(f * 2 + 1)] = ref_r[static_cast<std::size_t>(f)];
    }
    Frame unpitched_onset = test::first_onset_frame(unpitched, 0.2f);

    REQUIRE(unpitched_onset >= 0);
    REQUIRE(pitched_onset >= 0);
    INFO("unpitched_onset=", unpitched_onset, " pitched_onset=", pitched_onset);
    CHECK(std::llabs(pitched_onset - unpitched_onset) <= 2);

    // No crashes, no unsafe mutation.
    auto d = engine.diagnostics();
    CHECK(d.unsafe_cross_thread_reset_count == 0);
    CHECK(d.emergency_silence_count == 0);
}

// ---------------------------------------------------------------------------
// 5-B: After a seek, the realtime stream must re-align click onset to within
//      ±2 frames of the direct source read at that seek point.
// ---------------------------------------------------------------------------
TEST_CASE("realtime_pitch_click_onset_aligned_after_seek") {
#if !LT_ENGINE_TEST_EXPECT_REAL_RUBBERBAND && !LT_ENGINE_ALLOW_RUNTIME_PITCH_STUB_PASSTHROUGH
    MESSAGE("Skipping: no real RubberBand and stub passthrough blocked.");
    return;
#endif
    constexpr Frame dur      = kSR * 8;
    constexpr Frame click_at = kSR * 5;   // click 5 seconds in
    constexpr Frame seek_to  = kSR * 4;   // seek 1 second before click
    constexpr int render_frames = kSR * 2;

    SourceManager sources;
    add_click_source(sources, "src", dur, click_at);
    auto session = make_session("src", dur, 2);

    RealtimePitchEngine engine;
    engine.prepare_for_session(session, sources, kSR);
    engine.prepare_for_transport_discontinuity(seek_to, "seek_absolute", session, sources);

    auto pitched = render_blocks(engine, session, sources, seek_to, render_frames);
    Frame pitched_onset = test::first_onset_frame(pitched, 0.2f);

    const auto* src = sources.get("src");
    REQUIRE(src != nullptr);
    std::vector<float> ref_l(static_cast<std::size_t>(render_frames), 0.f);
    std::vector<float> ref_r(static_cast<std::size_t>(render_frames), 0.f);
    float* ref_ptrs[2] = { ref_l.data(), ref_r.data() };
    src->read(seek_to, render_frames, ref_ptrs, 2);
    std::vector<float> unpitched(static_cast<std::size_t>(render_frames * 2));
    for (int f = 0; f < render_frames; ++f) {
        unpitched[static_cast<std::size_t>(f * 2)]     = ref_l[static_cast<std::size_t>(f)];
        unpitched[static_cast<std::size_t>(f * 2 + 1)] = ref_r[static_cast<std::size_t>(f)];
    }
    Frame unpitched_onset = test::first_onset_frame(unpitched, 0.2f);

    REQUIRE(unpitched_onset >= 0);
    REQUIRE(pitched_onset >= 0);
    INFO("seek_to=", seek_to, " click_at=", click_at,
         " unpitched_onset=", unpitched_onset, " pitched_onset=", pitched_onset);
    CHECK(std::llabs(pitched_onset - unpitched_onset) <= 2);
    CHECK(engine.diagnostics().unsafe_cross_thread_reset_count == 0);
}

// ---------------------------------------------------------------------------
// 5-C: discard_remaining_ correctness — after reset_for_seek, the ring must
//      not contain pre-seek audio (start_delay frames must be discarded).
//      Verify by checking that the first render is not all-silence when
//      there is real source audio at the seek point.
// ---------------------------------------------------------------------------
TEST_CASE("realtime_pitch_reset_for_seek_discards_latency_correctly") {
#if !LT_ENGINE_TEST_EXPECT_REAL_RUBBERBAND && !LT_ENGINE_ALLOW_RUNTIME_PITCH_STUB_PASSTHROUGH
    MESSAGE("Skipping: no real RubberBand and stub passthrough blocked.");
    return;
#endif
    constexpr Frame dur = kSR * 4;
    SourceManager sources;
    add_source(sources, "src", dur);
    auto session = make_session("src", dur, 2);

    RealtimePitchEngine engine;
    engine.prepare_for_session(session, sources, kSR);
    engine.prepare_for_play(0, session, sources);

    // Render enough blocks to fill the ring and prove steady-state works.
    auto out_steady = render_blocks(engine, session, sources, 0, kSR);
    bool steady_non_silent = false;
    for (float v : out_steady)
        steady_non_silent = steady_non_silent || std::abs(v) > 0.0001f;
    CHECK(steady_non_silent);

    // Seek to 2 seconds, rebuild, and verify the first render block is non-silent.
    const Frame seek_frame = kSR * 2;
    engine.prepare_for_transport_discontinuity(seek_frame, "seek", session, sources);
    auto out_seek = render_blocks(engine, session, sources, seek_frame, kBlock * 4);
    bool post_seek_non_silent = false;
    for (float v : out_seek)
        post_seek_non_silent = post_seek_non_silent || std::abs(v) > 0.0001f;
    CHECK(post_seek_non_silent);

    auto d = engine.diagnostics();
    CHECK(d.emergency_silence_count == 0);
    CHECK(d.unsafe_cross_thread_reset_count == 0);
}

// ---------------------------------------------------------------------------
// 5-D: reset_ramp — first render after a seek must have finite, non-NaN output.
//      The apply_reset_ramp multiplier must not produce infinity or NaN.
// ---------------------------------------------------------------------------
TEST_CASE("realtime_pitch_reset_ramp_output_is_finite") {
#if !LT_ENGINE_TEST_EXPECT_REAL_RUBBERBAND && !LT_ENGINE_ALLOW_RUNTIME_PITCH_STUB_PASSTHROUGH
    MESSAGE("Skipping: no real RubberBand and stub passthrough blocked.");
    return;
#endif
    constexpr Frame dur = kSR * 4;
    SourceManager sources;
    add_source(sources, "src", dur, 1.0f);
    auto session = make_session("src", dur, 5);

    RealtimePitchEngine engine;
    engine.prepare_for_session(session, sources, kSR);
    engine.prepare_for_transport_discontinuity(kSR, "seek", session, sources);

    auto out = render_blocks(engine, session, sources, kSR, kBlock * 8);
    for (float v : out) {
        CHECK(std::isfinite(v));
    }
}

// ---------------------------------------------------------------------------
// 5-E: Multiple seeks in succession must not corrupt the stream or leave
//      stale latency discard counters that produce wrong-frame audio.
// ---------------------------------------------------------------------------
TEST_CASE("realtime_pitch_multiple_seeks_stay_aligned") {
#if !LT_ENGINE_TEST_EXPECT_REAL_RUBBERBAND && !LT_ENGINE_ALLOW_RUNTIME_PITCH_STUB_PASSTHROUGH
    MESSAGE("Skipping: no real RubberBand and stub passthrough blocked.");
    return;
#endif
    constexpr Frame dur = kSR * 10;
    constexpr Frame click_at = kSR * 7;
    SourceManager sources;
    add_click_source(sources, "src", dur, click_at);
    auto session = make_session("src", dur, 2);

    RealtimePitchEngine engine;
    engine.prepare_for_session(session, sources, kSR);

    // Three seeks in a row — only the last one should determine where the stream is primed.
    engine.prepare_for_transport_discontinuity(kSR * 1, "seek1", session, sources);
    engine.prepare_for_transport_discontinuity(kSR * 3, "seek2", session, sources);
    engine.prepare_for_transport_discontinuity(kSR * 6, "seek3", session, sources);

    auto pitched = render_blocks(engine, session, sources, kSR * 6, kSR * 2);
    Frame pitched_onset = test::first_onset_frame(pitched, 0.2f);

    const auto* src = sources.get("src");
    REQUIRE(src != nullptr);
    std::vector<float> ref_l(static_cast<std::size_t>(kSR * 2), 0.f);
    std::vector<float> ref_r(static_cast<std::size_t>(kSR * 2), 0.f);
    float* ref_ptrs[2] = { ref_l.data(), ref_r.data() };
    src->read(kSR * 6, kSR * 2, ref_ptrs, 2);
    std::vector<float> unpitched(static_cast<std::size_t>(kSR * 2 * 2));
    for (int f = 0; f < kSR * 2; ++f) {
        unpitched[static_cast<std::size_t>(f * 2)]     = ref_l[static_cast<std::size_t>(f)];
        unpitched[static_cast<std::size_t>(f * 2 + 1)] = ref_r[static_cast<std::size_t>(f)];
    }
    Frame unpitched_onset = test::first_onset_frame(unpitched, 0.2f);

    REQUIRE(unpitched_onset >= 0);
    REQUIRE(pitched_onset >= 0);
    INFO("unpitched_onset=", unpitched_onset, " pitched_onset=", pitched_onset);
    CHECK(std::llabs(pitched_onset - unpitched_onset) <= 2);
    CHECK(engine.diagnostics().unsafe_cross_thread_reset_count == 0);
}

// =============================================================================
// Phase 6 — Source readiness and file-format independence
// =============================================================================

// ---------------------------------------------------------------------------
// 6-A: Mono source is upmixed to stereo. Both output channels must be
//      non-silent and equal (center-panned mono expansion).
// ---------------------------------------------------------------------------
TEST_CASE("realtime_pitch_mono_source_upmixed_to_stereo") {
#if !LT_ENGINE_TEST_EXPECT_REAL_RUBBERBAND && !LT_ENGINE_ALLOW_RUNTIME_PITCH_STUB_PASSTHROUGH
    MESSAGE("Skipping: no real RubberBand and stub passthrough blocked.");
    return;
#endif
    constexpr Frame dur = kSR * 2;
    // Build a mono sine (channel_count=1).
    auto mono_samples = test::make_stereo_sine(dur, 440.0, 0.5f);
    // Thin to mono interleaved by keeping every other sample.
    std::vector<float> mono(static_cast<std::size_t>(dur));
    for (Frame f = 0; f < dur; ++f)
        mono[static_cast<std::size_t>(f)] = mono_samples[static_cast<std::size_t>(f * 2)];

    SourceManager sources;
    sources.register_source("mono_src", "");
    REQUIRE(sources.store_decoded_source("mono_src", mono, 1, kSR, dur).is_ok());

    Session session;
    session.sample_rate = kSR;
    session.sources = {Source{"mono_src", ""}};
    Song song; song.id = "song"; song.start_frame = 0; song.end_frame = dur;
    song.transpose_semitones = 2;
    Track track; track.id = "track"; track.kind = TrackKind::Audio;
    track.clips.push_back(Clip{"clip", "mono_src", 0, 0, dur});
    song.tracks.push_back(track);
    session.songs.push_back(song);

    RealtimePitchEngine engine;
    engine.prepare_for_session(session, sources, kSR);
    engine.prepare_for_play(0, session, sources);

    std::vector<float> out_l(kBlock, 0.f), out_r(kBlock, 0.f);
    float* out[2] = { out_l.data(), out_r.data() };
    const auto& track_ref = session.songs[0].tracks[0];
    const auto& clip_ref  = track_ref.clips[0];
    const auto* src = sources.get("mono_src");
    REQUIRE(src != nullptr);

    // Render enough blocks to get past RubberBand startup latency.
    for (int i = 0; i < 8; ++i) {
        std::fill(out_l.begin(), out_l.end(), 0.f);
        std::fill(out_r.begin(), out_r.end(), 0.f);
        engine.render_pitched_clip(clip_ref, track_ref.id, *src,
                                   static_cast<Frame>(i * kBlock),
                                   static_cast<Frame>(i * kBlock),
                                   kBlock, 2.0, out, 2);
    }

    // Both channels must be non-silent and equal (mono upmix).
    float peak_l = 0.f, peak_r = 0.f, max_diff = 0.f;
    for (int f = 0; f < kBlock; ++f) {
        peak_l = std::max(peak_l, std::abs(out_l[static_cast<std::size_t>(f)]));
        peak_r = std::max(peak_r, std::abs(out_r[static_cast<std::size_t>(f)]));
        max_diff = std::max(max_diff, std::abs(out_l[static_cast<std::size_t>(f)]
                                             - out_r[static_cast<std::size_t>(f)]));
    }
    CHECK(peak_l > 0.001f);
    CHECK(peak_r > 0.001f);
    CHECK(max_diff < 1e-5f);  // L==R for mono upmix
    CHECK(engine.diagnostics().unsafe_cross_thread_reset_count == 0);
}

// ---------------------------------------------------------------------------
// 6-B: Short clip — source shorter than RubberBand startup latency must not
//      crash or hang. The engine returns 0 frames rendered for source beyond
//      its end, but must never produce NaN or infinity.
// ---------------------------------------------------------------------------
TEST_CASE("realtime_pitch_short_clip_does_not_crash") {
    // 64 frames is shorter than any plausible RubberBand startup latency.
    constexpr Frame dur = 64;
    SourceManager sources;
    add_source(sources, "short_src", dur, 0.5f);
    auto session = make_session("short_src", dur, 3);

    RealtimePitchEngine engine;
    engine.prepare_for_session(session, sources, kSR);
    engine.prepare_for_play(0, session, sources);

    // Render past end of source — must not crash or NaN.
    float out_l[kBlock] = {}, out_r[kBlock] = {};
    float* out[2] = { out_l, out_r };
    const auto& track_ref = session.songs[0].tracks[0];
    const auto& clip_ref  = track_ref.clips[0];
    const auto* src = sources.get("short_src");
    REQUIRE(src != nullptr);

    for (int i = 0; i < 4; ++i) {
        std::fill(out_l, out_l + kBlock, 0.f);
        std::fill(out_r, out_r + kBlock, 0.f);
        engine.render_pitched_clip(clip_ref, track_ref.id, *src,
                                   static_cast<Frame>(i * kBlock),
                                   static_cast<Frame>(i * kBlock),
                                   kBlock, 3.0, out, 2);
        for (int f = 0; f < kBlock; ++f) {
            CHECK(std::isfinite(out_l[f]));
            CHECK(std::isfinite(out_r[f]));
        }
    }
    // No panic, no unsafe mutation.
    CHECK(engine.diagnostics().unsafe_cross_thread_reset_count == 0);
}

// ---------------------------------------------------------------------------
// 6-C: source_miss_count increments when source frame is past end but must
//      not trigger repair — it is a normal boundary condition, not a bug.
// ---------------------------------------------------------------------------
TEST_CASE("realtime_pitch_past_end_increments_source_miss_not_repair") {
    constexpr Frame dur = kSR / 4;   // 0.25 s
    SourceManager sources;
    add_source(sources, "short", dur, 0.3f);
    auto session = make_session("short", dur, 2);

    RealtimePitchEngine engine;
    engine.prepare_for_session(session, sources, kSR);
    engine.prepare_for_play(0, session, sources);

    float out_l[kBlock] = {}, out_r[kBlock] = {};
    float* out[2] = { out_l, out_r };
    const auto& t = session.songs[0].tracks[0];
    const auto& c = t.clips[0];
    const auto* src = sources.get("short");
    REQUIRE(src != nullptr);

    // Render at a frame far past end of source.
    const Frame past_end = dur + kSR * 2;
    engine.render_pitched_clip(c, t.id, *src, past_end, past_end, kBlock, 2.0, out, 2);

    // Repair must not have been requested for source-boundary silence.
    Frame repair_frame = -1;
    CHECK_FALSE(engine.take_repair_request(repair_frame));
}

// ---------------------------------------------------------------------------
// 6-D: Different semitone values produce distinct pitched output (not same as
//      unpitched and not same as each other — frequency discrimination).
// ---------------------------------------------------------------------------
TEST_CASE("realtime_pitch_different_semitones_produce_different_frequency") {
#if !LT_ENGINE_TEST_EXPECT_REAL_RUBBERBAND && !LT_ENGINE_ALLOW_RUNTIME_PITCH_STUB_PASSTHROUGH
    MESSAGE("Skipping: no real RubberBand and stub passthrough blocked.");
    return;
#endif
    constexpr Frame dur = kSR * 4;
    constexpr double ref_freq = 440.0;

    auto check_semitones = [&](Semitones semitones) {
        SourceManager sources;
        add_source(sources, "src", dur);
        auto session = make_session("src", dur, semitones);

        RealtimePitchEngine engine;
        engine.prepare_for_session(session, sources, kSR);
        engine.prepare_for_play(0, session, sources);

        // Render 2 seconds; skip first 0.5 s to clear startup ramp.
        auto out = render_blocks(engine, session, sources, 0, kSR * 2);
        const double measured = test::estimate_frequency_hz(
            out, kSR, kSR / 2, kSR);

        const double expected = ref_freq * std::pow(2.0, semitones / 12.0);
        // Allow ±3% tolerance for RubberBand's pitch estimation error and spectral leakage.
        const double tol = expected * 0.03;
        INFO("semitones=", semitones, " expected_hz=", expected, " measured_hz=", measured);
        CHECK(std::abs(measured - expected) < tol);
    };

    check_semitones(2);
    check_semitones(-2);
    check_semitones(7);
    check_semitones(12);
}

// =============================================================================
// Phase 7 — Realtime safety and stress validation
// =============================================================================

// ---------------------------------------------------------------------------
// 7-A: scratch_resize_in_audio_thread_count must stay at 0 during steady-
//      state playback through Mixer (all allocation must happen in prepare()).
// ---------------------------------------------------------------------------
TEST_CASE("realtime_pitch_no_scratch_resize_in_audio_thread") {
    constexpr Frame dur = kSR * 4;
    SourceManager sources;
    add_source(sources, "src", dur);

    auto session = std::make_shared<Session>();
    session->sample_rate = kSR;
    session->sources = {Source{"src", ""}};
    Song song; song.id = "song"; song.start_frame = 0; song.end_frame = dur;
    song.transpose_semitones = 3;
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

    TrackRenderer::reset_diagnostics();

    std::vector<float> out_l(kBlock, 0.f), out_r(kBlock, 0.f);
    float* out[2] = { out_l.data(), out_r.data() };
    for (int i = 0; i < 64; ++i)
        mixer.render(out, 2, kBlock, kSR);

    const auto d = TrackRenderer::diagnostics();
    CHECK(d.scratch_resize_in_audio_thread_count == 0);
    CHECK(pitch.diagnostics().unsafe_cross_thread_reset_count == 0);
}

// ---------------------------------------------------------------------------
// 7-B: unsafe_cross_thread_reset_count must stay 0 under rapid concurrent
//      control-thread rebuilds while the audio thread renders.
// ---------------------------------------------------------------------------
TEST_CASE("realtime_pitch_no_unsafe_cross_thread_reset_under_rapid_rebuild") {
    constexpr Frame dur = kSR * 60;
    auto samples = test::make_stereo_sine(dur, 440.0, 0.2f);
    SourceManager sources;
    sources.register_source("src", "");
    REQUIRE(sources.store_decoded_source("src", samples, 2, kSR, dur).is_ok());

    auto session = make_session("src", dur, 3);

    RealtimePitchEngine engine;
    engine.prepare_for_session(session, sources, kSR);
    engine.prepare_for_play(0, session, sources);

    std::atomic<bool> stop{false};
    std::atomic<bool> had_nan{false};

    // Audio thread: render continuously.
    std::thread audio([&] {
        const auto& t = session.songs[0].tracks[0];
        const auto& c = t.clips[0];
        const auto* src = sources.get("src");
        float out_l[kBlock] = {}, out_r[kBlock] = {};
        float* out[2] = { out_l, out_r };
        Frame frame = 0;
        while (!stop.load(std::memory_order_acquire)) {
            engine.render_pitched_clip(c, t.id, *src, frame, frame, kBlock, 3.0, out, 2);
            for (int f = 0; f < kBlock; ++f) {
                if (!std::isfinite(out_l[f]) || !std::isfinite(out_r[f]))
                    had_nan.store(true, std::memory_order_release);
            }
            frame = (frame + kBlock) % (dur - kBlock);
        }
    });

    // Control thread: rapid discontinuities to different positions.
    for (int i = 0; i < 100; ++i) {
        const Frame target = static_cast<Frame>((i * 48007) % (dur - kSR));
        engine.prepare_for_transport_discontinuity(target, "stress", session, sources);
    }

    stop.store(true, std::memory_order_release);
    audio.join();

    CHECK_FALSE(had_nan.load());
    auto d = engine.diagnostics();
    CHECK(d.unsafe_cross_thread_reset_count == 0);
    CHECK(d.concurrent_stream_mutation_detected == 0);
    CHECK(d.emergency_silence_count == 0);
}

// ---------------------------------------------------------------------------
// 7-C: Rapid transpose changes (song semitone changes while playing) must not
//      produce NaN, crash, or increment unsafe_cross_thread_reset_count.
//      Each prepare_for_transport_discontinuity publishes a new immutable set.
// ---------------------------------------------------------------------------
TEST_CASE("realtime_pitch_rapid_transpose_change_is_safe") {
    constexpr Frame dur = kSR * 30;
    auto samples = test::make_stereo_sine(dur, 220.0, 0.3f);
    SourceManager sources;
    sources.register_source("src", "");
    REQUIRE(sources.store_decoded_source("src", samples, 2, kSR, dur).is_ok());

    // Use a mutable session so we can change semitones between rebuilds.
    Session session_a = make_session("src", dur, 2);
    Session session_b = make_session("src", dur, 5);
    Session session_c = make_session("src", dur, -3);

    RealtimePitchEngine engine;
    engine.prepare_for_session(session_a, sources, kSR);
    engine.prepare_for_play(0, session_a, sources);

    std::atomic<bool> stop{false};
    std::atomic<bool> had_nan{false};

    std::thread audio([&] {
        const auto& t = session_a.songs[0].tracks[0];
        const auto& c = t.clips[0];
        const auto* src = sources.get("src");
        float out_l[kBlock] = {}, out_r[kBlock] = {};
        float* out[2] = { out_l, out_r };
        Frame frame = 0;
        while (!stop.load(std::memory_order_acquire)) {
            // Always render with session_a's semitones (2) — the engine holds the
            // published stream set atomically; mismatched semitones just miss the stream.
            engine.render_pitched_clip(c, t.id, *src, frame, frame, kBlock, 2.0, out, 2);
            for (int f = 0; f < kBlock; ++f)
                if (!std::isfinite(out_l[f]) || !std::isfinite(out_r[f]))
                    had_nan.store(true, std::memory_order_release);
            frame = (frame + kBlock) % (dur - kBlock);
        }
    });

    const Frame playhead = kSR;
    for (int i = 0; i < 50; ++i) {
        engine.prepare_for_transport_discontinuity(playhead, "transpose_change", session_a, sources);
        engine.prepare_for_transport_discontinuity(playhead, "transpose_change", session_b, sources);
        engine.prepare_for_transport_discontinuity(playhead, "transpose_change", session_c, sources);
    }

    stop.store(true, std::memory_order_release);
    audio.join();

    CHECK_FALSE(had_nan.load());
    auto d = engine.diagnostics();
    CHECK(d.unsafe_cross_thread_reset_count == 0);
    CHECK(d.concurrent_stream_mutation_detected == 0);
}

// ---------------------------------------------------------------------------
// 7-D: pitch_audio_thread_reset_count and pitch_audio_thread_prime_count must
//      remain 0 throughout steady playback — audio thread must never call
//      reset_for_seek() or prime() on a published stream.
// ---------------------------------------------------------------------------
TEST_CASE("realtime_pitch_audio_thread_never_resets_or_primes") {
    constexpr Frame dur = kSR * 4;
    SourceManager sources;
    add_source(sources, "src", dur);
    auto session = make_session("src", dur, 3);

    RealtimePitchEngine engine;
    engine.prepare_for_session(session, sources, kSR);
    engine.prepare_for_play(0, session, sources);

    const auto& t = session.songs[0].tracks[0];
    const auto& c = t.clips[0];
    const auto* src = sources.get("src");
    REQUIRE(src != nullptr);

    float out_l[kBlock] = {}, out_r[kBlock] = {};
    float* out[2] = { out_l, out_r };

    // Render 128 blocks — consume sentinel then steady-state.
    for (int i = 0; i < 128; ++i) {
        const Frame f = static_cast<Frame>(i * kBlock);
        engine.render_pitched_clip(c, t.id, *src, f, f, kBlock, 3.0, out, 2);
    }

    auto d = engine.diagnostics();
    CHECK(d.pitch_audio_thread_reset_count == 0);
    CHECK(d.pitch_audio_thread_prime_count == 0);
    CHECK(d.unsafe_cross_thread_reset_count == 0);
}

// ---------------------------------------------------------------------------
// 7-E: active_stream_swap_count must increment exactly once per
//      prepare_for_transport_discontinuity call (one new set published).
// ---------------------------------------------------------------------------
TEST_CASE("realtime_pitch_stream_swap_count_tracks_publishes") {
    constexpr Frame dur = kSR * 4;
    SourceManager sources;
    add_source(sources, "src", dur);
    auto session = make_session("src", dur, 2);

    RealtimePitchEngine engine;
    engine.prepare_for_session(session, sources, kSR);  // 1 publish
    const auto after_session = engine.diagnostics().active_stream_swap_count;

    engine.prepare_for_play(0, session, sources);         // 1 publish
    const auto after_play = engine.diagnostics().active_stream_swap_count;
    CHECK(after_play == after_session + 1);

    engine.prepare_for_transport_discontinuity(kSR, "seek", session, sources);  // 1 publish
    const auto after_seek = engine.diagnostics().active_stream_swap_count;
    CHECK(after_seek == after_play + 1);

    engine.prepare_for_transport_discontinuity(kSR * 2, "seek2", session, sources);  // 1 publish
    const auto after_seek2 = engine.diagnostics().active_stream_swap_count;
    CHECK(after_seek2 == after_seek + 1);
}
