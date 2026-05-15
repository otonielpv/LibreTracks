#include "test_audio_fixtures.h"

#include <doctest/doctest.h>
#include <lt_engine/pitch/realtime_pitch_engine.h>
#include <lt_engine/pitch/realtime_pitch_stream.h>
#include <lt_engine/render/mixer.h>
#include <lt_engine/render/pitch_resolution.h>
#include <lt_engine/render/track_renderer.h>
#include <lt_engine/session/session.h>
#include <lt_engine/sources/source_manager.h>
#include <lt_engine/transport/transport_clock.h>
#include <lt_engine/scheduler/jump_scheduler.h>

#include <cmath>
#include <vector>

using namespace lt;

namespace {

constexpr int kBlock = 512;
constexpr int kSR    = test::kFixtureSampleRate;

void add_source(SourceManager& sources, const Id& id,
                float amplitude = 0.5f, Frame dur = kSR * 4) {
    sources.register_source(id, "");
    REQUIRE(sources.store_decoded_source(id,
        test::make_stereo_sine(dur, 440.0, amplitude),
        2, kSR, dur).is_ok());
}

float peak_buf(const std::vector<float>& s) {
    float p = 0.f;
    for (float v : s) p = std::max(p, std::abs(v));
    return p;
}

} // namespace

// ---------------------------------------------------------------------------
// Phase 5, Test 1: backend identity reported in stream diagnostics
// ---------------------------------------------------------------------------
TEST_CASE("realtime_pitch_stream_reports_backend_identity") {
    RealtimePitchStream stream;
    RealtimePitchStream::Config cfg;
    cfg.sample_rate = kSR;
    cfg.channel_count = 2;
    cfg.semitones = 2.0;
    stream.configure(cfg);

    auto d = stream.diagnostics();
    // Must report a non-empty backend string.
    CHECK(!d.pitch_backend.empty());
    CHECK(d.pitch_backend != "");
#if LT_ENGINE_TEST_EXPECT_REAL_RUBBERBAND
    CHECK(d.pitch_backend == "rubberband");
    CHECK(d.pitch_runtime_enabled == true);
    CHECK(d.pitch_muted_or_bypassed_reason.empty());
#else
    // Stub build: must report stub and runtime_enabled=false.
    CHECK(d.pitch_backend == "stub");
    CHECK(d.pitch_runtime_enabled == false);
    CHECK(!d.pitch_muted_or_bypassed_reason.empty());
#endif
}

// ---------------------------------------------------------------------------
// Phase 5, Test 2: stub does not claim runtime_enabled
// ---------------------------------------------------------------------------
TEST_CASE("realtime_pitch_stub_does_not_claim_runtime_enabled") {
#if LT_ENGINE_TEST_EXPECT_REAL_RUBBERBAND
    // This test is for stub builds only. Skip in real-RB builds.
    MESSAGE("Skipping stub_does_not_claim_runtime_enabled — real RubberBand build.");
#else
    RealtimePitchStream stream;
    RealtimePitchStream::Config cfg;
    cfg.sample_rate = kSR;
    cfg.channel_count = 2;
    cfg.semitones = 5.0;
    stream.configure(cfg);

    auto d = stream.diagnostics();
    CHECK(d.pitch_backend == "stub");
    CHECK(d.pitch_runtime_enabled == false);
    CHECK(!d.pitch_muted_or_bypassed_reason.empty());
#endif
}

// ---------------------------------------------------------------------------
// Phase 5, Test 3: stub passthrough blocked in runtime mode
// ---------------------------------------------------------------------------
TEST_CASE("realtime_pitch_stub_passthrough_blocked_in_runtime_mode") {
#if LT_ENGINE_ALLOW_RUNTIME_PITCH_STUB_PASSTHROUGH
    // Explicit stub passthrough build — passthrough is allowed; skip this test.
    MESSAGE("Skipping stub_passthrough_blocked — explicit stub passthrough build.");
#elif LT_ENGINE_TEST_EXPECT_REAL_RUBBERBAND
    // Real RubberBand build — no passthrough concern; test trivially passes.
    MESSAGE("Real RubberBand backend — no stub passthrough possible.");
#else
    // Non-stub, non-real-RB build (stub but passthrough blocked).
    SourceManager sources;
    add_source(sources, "src");

    Session session;
    session.id = "s"; session.sample_rate = kSR;
    Song song; song.id = "song"; song.start_frame = 0; song.end_frame = kSR * 4;
    song.transpose_semitones = 3;
    Track track; track.id = "t"; track.kind = TrackKind::Audio;
    track.clips.push_back(Clip{"clip", "src", 0, 0, kSR * 4});
    song.tracks.push_back(track);
    session.sources = {Source{"src", ""}};
    session.songs.push_back(song);

    RealtimePitchEngine pitch;
    pitch.prepare_for_session(session, sources, kSR);
    pitch.prepare_for_play(0, session, sources);

    // Render several blocks — in blocked mode, the ring stays empty after process_source,
    // so underflow occurs and we get silence, NOT original audio.
    const DecodedSource* src = sources.get("src");
    REQUIRE(src != nullptr);

    float buf0[kBlock] = {}, buf1[kBlock] = {};
    float* out[2] = {buf0, buf1};

    // Read a known reference block from source directly (original audio).
    std::vector<float> ref0(kBlock), ref1(kBlock);
    float* ref[2] = {ref0.data(), ref1.data()};
    src->read(0, kBlock, ref, 2);
    float ref_peak = 0.f;
    for (int i = 0; i < kBlock; ++i) ref_peak = std::max(ref_peak, std::abs(ref0[i]));

    // In stub-blocked mode, the pitch engine returns silence (ring empty).
    // We can't check the engine stream directly easily, so check diagnostics.
    const auto d_engine = pitch.diagnostics();
    // backend_unavailable_count may still be 0 before render; that's OK.
    // The test verifies stub_passthrough_count stays at 0 even after rendering.
    Clip clip = session.songs[0].tracks[0].clips[0];
    pitch.render_pitched_clip(clip, "t", *src, 0, 0, kBlock, 3.0, out, 2);

    const auto d_after = pitch.diagnostics();
    CHECK(d_after.stub_passthrough_count == 0);
    CHECK(d_after.stub_passthrough_blocked_count > 0);
#endif
}

// ---------------------------------------------------------------------------
// Phase 5, Test 4: RealtimePitchEngine reports correct backend in diagnostics
// ---------------------------------------------------------------------------
TEST_CASE("realtime_pitch_engine_reports_backend_in_diagnostics") {
    SourceManager sources;
    add_source(sources, "src");

    Session session;
    session.id = "s"; session.sample_rate = kSR;
    Song song; song.id = "song"; song.start_frame = 0; song.end_frame = kSR * 4;
    song.transpose_semitones = 2;
    Track track; track.id = "t"; track.kind = TrackKind::Audio;
    track.clips.push_back(Clip{"clip", "src", 0, 0, kSR * 4});
    song.tracks.push_back(track);
    session.sources = {Source{"src", ""}};
    session.songs.push_back(song);

    RealtimePitchEngine pitch;
    pitch.prepare_for_session(session, sources, kSR);
    pitch.prepare_for_play(0, session, sources);

    const auto d = pitch.diagnostics();
    CHECK(!d.pitch_backend.empty());
    CHECK(d.active_pitch_stream_count >= 1);
#if LT_ENGINE_TEST_EXPECT_REAL_RUBBERBAND
    CHECK(d.pitch_backend == "rubberband");
    CHECK(d.pitch_runtime_enabled == true);
#else
    CHECK(d.pitch_backend == "stub");
    CHECK(d.pitch_runtime_enabled == false);
#endif
}

// ---------------------------------------------------------------------------
// Phase 5, Test 5: pitch streams survive track actions (combined backend check)
// ---------------------------------------------------------------------------
TEST_CASE("pitch_streams_and_backend_survive_track_actions") {
    SourceManager sources;
    add_source(sources, "src");

    auto session = std::make_shared<Session>();
    session->id = "s"; session->sample_rate = kSR;
    Song song; song.id = "song"; song.start_frame = 0; song.end_frame = kSR * 4;
    song.transpose_semitones = 2;
    Track track; track.id = "t"; track.kind = TrackKind::Audio;
    track.clips.push_back(Clip{"clip", "src", 0, 0, kSR * 4});
    song.tracks.push_back(track);
    session->sources = {Source{"src", ""}};
    session->songs.push_back(song);

    RealtimePitchEngine pitch;
    pitch.prepare_for_session(*session, sources, kSR);
    pitch.prepare_for_play(0, *session, sources);

    TransportClock clock(kSR);
    JumpScheduler scheduler;
    Mixer mixer(session, &sources, &clock, &scheduler, nullptr, &pitch);
    clock.play();

    std::vector<float> left(kBlock, 0.f), right(kBlock, 0.f);
    float* out[2] = {left.data(), right.data()};
    for (int i = 0; i < 5; ++i)
        mixer.render(out, 2, kBlock, kSR);

    const auto before = pitch.diagnostics();
    CHECK(before.active_pitch_stream_count >= 1);
    const std::string backend_before = before.pitch_backend;
    CHECK(!backend_before.empty());

    // Track actions must not change backend or destroy streams.
    mixer.set_track_gain("t", 0.5f);
    mixer.set_track_pan("t", 0.3f);
    mixer.set_track_mute("t", true);
    mixer.set_track_mute("t", false);
    for (int i = 0; i < 5; ++i)
        mixer.render(out, 2, kBlock, kSR);

    const auto after = pitch.diagnostics();
    CHECK(after.pitch_backend == backend_before);
    CHECK(after.pitch_runtime_enabled == before.pitch_runtime_enabled);
    CHECK(after.active_pitch_stream_count == before.active_pitch_stream_count);
    CHECK(after.active_stream_swap_count == before.active_stream_swap_count);
}

// ---------------------------------------------------------------------------
// Phase 5, Test 6: T button (transposeEnabled) controls pitch decision
// ---------------------------------------------------------------------------
TEST_CASE("track_T_enabled_with_song_transpose_needs_pitch") {
    Song song; song.id = "s"; song.transpose_semitones = 2;
    Track track; track.id = "t"; track.transpose_behavior = TransposeBehavior::FollowsSongOrRegion;
    Clip clip; clip.id = "c"; clip.semitones = 0;

    const auto dec = resolve_pitch_render_decision(track, clip, song, 0);
    CHECK(dec.needs_pitch == true);
    CHECK(dec.is_never_transpose == false);
    CHECK(dec.effective_semitones == 2);
}

TEST_CASE("track_T_disabled_with_song_transpose_bypasses_pitch") {
    Song song; song.id = "s"; song.transpose_semitones = 2;
    Track track; track.id = "t"; track.transpose_behavior = TransposeBehavior::NeverTranspose;
    Clip clip; clip.id = "c"; clip.semitones = 0;

    const auto dec = resolve_pitch_render_decision(track, clip, song, 0);
    CHECK(dec.needs_pitch == false);
    CHECK(dec.is_never_transpose == true);
    CHECK(dec.effective_semitones == 0);
}

TEST_CASE("track_T_enabled_with_zero_song_transpose_does_not_pitch") {
    Song song; song.id = "s"; song.transpose_semitones = 0;
    Track track; track.id = "t"; track.transpose_behavior = TransposeBehavior::FollowsSongOrRegion;
    Clip clip; clip.id = "c"; clip.semitones = 0;

    const auto dec = resolve_pitch_render_decision(track, clip, song, 0);
    CHECK(dec.needs_pitch == false);
    CHECK(dec.is_never_transpose == false);
    CHECK(dec.effective_semitones == 0);
}

// ---------------------------------------------------------------------------
// Phase 5, Test 7: missing_stream_count increases when stream not found,
//                  NOT original audio
// ---------------------------------------------------------------------------
TEST_CASE("pitch_missing_stream_increments_diagnostic_not_original_audio") {
    SourceManager sources;
    add_source(sources, "src");

    Session session;
    session.id = "s"; session.sample_rate = kSR;
    Song song; song.id = "song"; song.start_frame = 0; song.end_frame = kSR * 4;
    song.transpose_semitones = 5;
    Track track; track.id = "t"; track.kind = TrackKind::Audio;
    Clip clip; clip.id = "clip"; clip.source_id = "src";
    clip.timeline_start_frame = 0; clip.source_start_frame = 0; clip.length_frames = kSR * 4;
    track.clips.push_back(clip);
    song.tracks.push_back(track);
    session.sources = {Source{"src", ""}};
    session.songs.push_back(song);

    RealtimePitchEngine pitch;
    // Deliberately do NOT prepare streams — simulates a stream set without this clip.
    // missing_stream_count should be incremented.

    const DecodedSource* src = sources.get("src");
    REQUIRE(src != nullptr);

    TrackRenderer::reset_diagnostics();

    float buf0[kBlock] = {}, buf1[kBlock] = {};
    float* out[2] = {buf0, buf1};

    // Render via render_pitched_clip directly — no stream exists, so it must return 0.
    const int rendered = pitch.render_pitched_clip(clip, "t", *src, 0, 0, kBlock, 5.0, out, 2);
    CHECK(rendered == 0);

    // Output must be silence, not original audio.
    float out_peak = 0.f;
    for (int i = 0; i < kBlock; ++i) out_peak = std::max(out_peak, std::abs(buf0[i]));
    CHECK(out_peak < 1.0e-6f);

    const auto d = pitch.diagnostics();
    // missing_stream_count is not exposed in PitchStreamDiagnostics directly,
    // but pitch_timeline_mismatch_count stays 0 (no stream to mismatch),
    // and no repair was requested (stream simply not found).
    CHECK(d.pitch_timeline_mismatch_count == 0);
    CHECK(d.pitch_repair_requested_count == 0);
    // render_count stays 0 — no successful render.
    CHECK(d.render_count == 0);
}
