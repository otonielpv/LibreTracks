// prearmed_jump_tests.cpp
//
// MVP tests for PrearmedJumpManager + BungeeVoiceManager::swap_in_prepared_voices.
// Phase 1 scope per the prearmed-jumps spec:
//   1. Prepared marker jump emits audio immediately
//   2. Prepared jump preserves alignment (pitched vs unpitched)
//   3. Prepared jump is transactional (no partial apply)
//   4. Fallback works when target not ready
//
// We do NOT spin up the full engine here — that would require Tauri/device
// init. We exercise the manager and the swap method directly, then render
// one block through TrackRenderer to confirm the prepared voice produces
// audible output.

#include "test_audio_fixtures.h"

#include <doctest/doctest.h>
#include <lt_engine/pitch/bungee_voice_manager.h>
#include <lt_engine/pitch/prearmed_jump_manager.h>
#include <lt_engine/render/track_renderer.h>
#include <lt_engine/session/session.h>
#include <lt_engine/sources/source_manager.h>

#include <algorithm>
#include <chrono>
#include <memory>
#include <string>
#include <thread>
#include <vector>

using namespace lt;

#ifndef LT_ENGINE_HAVE_BUNGEE
#define LT_ENGINE_HAVE_BUNGEE 0
#endif

#if LT_ENGINE_HAVE_BUNGEE

namespace {

// All MVP tests use the same 1-pitched + 1-unpitched fixture: a 4096-frame
// tone burst with a click at frame 1024, played from frame 0. The marker
// "marker-1" sits at frame 2048 (well inside the clip, past the click) so
// "jump to marker" lands in the middle of audible source content.
constexpr int   kSR             = test::kFixtureSampleRate;
constexpr int   kCh             = 2;
constexpr int   kBlockFrames    = 480;
constexpr Frame kClipLen        = 32768;
constexpr Frame kMarkerFrame    = 2048;
constexpr Semitones kSemitones  = -2;

// SourceManager holds a mutex, so we can't return it by value. Callers own
// the storage and pass it in.
//
// `samples_override` lets a test inject a specific source signal (e.g. a click
// instead of a sine). If empty, falls back to a continuous 440 Hz sine.
void init_fixture(SourceManager& sources,
                   Session& session,
                   const std::string& source_id,
                   const std::string& clip_id,
                   const std::string& track_id,
                   const std::string& song_id,
                   const std::string& marker_id,
                   Frame marker_frame,
                   bool transposed,
                   const std::vector<float>& samples_override = {},
                   Semitones transpose_amount = kSemitones) {
    // Continuous sine so any output block has measurable energy regardless
    // of where the marker lands.
    auto samples = samples_override.empty()
        ? test::make_stereo_sine(kClipLen, 440.0, 0.5f)
        : samples_override;
    sources.register_source(source_id, "");
    REQUIRE(sources.store_decoded_source(
        source_id, samples, kCh, kSR, kClipLen).is_ok());

    Track track;
    track.id   = track_id;
    track.gain = 1.0f;
    track.transpose_behavior = transposed
        ? TransposeBehavior::FollowsSongOrRegion
        : TransposeBehavior::NeverTranspose;
    track.clips.push_back(Clip{clip_id, source_id, 0, 0, kClipLen});

    Song song;
    song.id          = song_id;
    song.start_frame = 0;
    song.end_frame   = kClipLen;
    song.bpm         = 120.0;
    song.transpose_semitones = transposed ? transpose_amount : 0;
    // Phase-4 contract: Bungee voices (and therefore prearmed jumps) only
    // exist for warp-active clips. Pitched tests need a warp region wrapping
    // the song so the prearm path still has voices to prepare. The warp
    // ratio cancels (source=target=120) — only the warp_enabled flag matters
    // to keep this prearm test from regressing into a no-op.
    // Only enroll a warp region when the test actually expects pitch — tests
    // that pass `transpose_amount=0` deliberately assert "no audible pitch ->
    // no Bungee voice / nothing to prearm", which must keep holding under
    // Phase-4 too. With non-zero pitch, wrap the song in a warp region so the
    // decision routes through Stretched (Bungee voice + prearm exercise).
    if (transposed && transpose_amount != 0) {
        Region region;
        region.id              = "region-warp";
        region.start_frame     = 0;
        region.end_frame       = kClipLen;
        region.warp_enabled    = true;
        // Phase-4 routes pitch-only-no-warp through Varispeed. These prearm
        // tests need the Stretched path (Bungee voice + prearm), which
        // requires warp_active. Use a near-unity ratio so prefeed alignment
        // checks (|p_onset - u_onset| <= 32 samples) still pass — the click
        // can shift by at most ratio_delta * click_offset samples.
        song.bpm               = 120.0;
        region.warp_source_bpm = 120.0001;
        song.regions.push_back(region);
    }
    song.tracks.push_back(track);
    song.markers.push_back(Marker{marker_id, "M1", marker_frame});

    session.songs.push_back(song);
}

float block_rms(const std::vector<float>& il) {
    if (il.empty()) return 0.f;
    double sum = 0.0;
    for (float v : il) sum += static_cast<double>(v) * v;
    return static_cast<float>(std::sqrt(sum / il.size()));
}

} // namespace

// Helper: render `n_blocks` consecutive blocks starting at `start_frame`,
// returning the concatenated interleaved buffer.
std::vector<float> render_n_blocks(const Track& track,
                                    Frame start_frame,
                                    int n_blocks,
                                    const SourceManager& sources,
                                    BungeeVoiceManager* bvm,
                                    Semitones effective_semitones) {
    std::vector<float> all;
    all.reserve(static_cast<std::size_t>(n_blocks) * kBlockFrames * kCh);
    // IMPORTANT: track_renderer holds per-instance scratch + Bungee scratch.
    // We use the same renderer instance across blocks so internal state is
    // continuous (mirrors how the audio thread uses a single renderer).
    TrackRenderer renderer;
    renderer.prepare(kBlockFrames);
    for (int b = 0; b < n_blocks; ++b) {
        std::vector<float> L(static_cast<std::size_t>(kBlockFrames), 0.f);
        std::vector<float> R(static_cast<std::size_t>(kBlockFrames), 0.f);
        float* out[2] = {L.data(), R.data()};
        renderer.render(
            track, start_frame + Frame(b * kBlockFrames), kBlockFrames,
            out, kCh, sources, bvm,
            kSR, effective_semitones, /*active_song*/ nullptr);
        for (int i = 0; i < kBlockFrames; ++i) {
            all.push_back(L[static_cast<std::size_t>(i)]);
            all.push_back(R[static_cast<std::size_t>(i)]);
        }
    }
    return all;
}

std::vector<float> render_chunk_sequence(const Track& track,
                                         Frame start_frame,
                                         const std::vector<int>& chunks,
                                         const SourceManager& sources,
                                         BungeeVoiceManager* bvm,
                                         Semitones effective_semitones) {
    int max_chunk = 0;
    for (int chunk : chunks)
        max_chunk = std::max(max_chunk, chunk);

    std::vector<float> all;
    TrackRenderer renderer;
    renderer.prepare(std::max(1, max_chunk));

    Frame cursor = start_frame;
    for (int chunk : chunks) {
        std::vector<float> L(static_cast<std::size_t>(chunk), 0.f);
        std::vector<float> R(static_cast<std::size_t>(chunk), 0.f);
        float* out[2] = {L.data(), R.data()};
        renderer.render(
            track, cursor, chunk, out, kCh, sources, bvm,
            kSR, effective_semitones, /*active_song*/ nullptr);
        for (int i = 0; i < chunk; ++i) {
            all.push_back(L[static_cast<std::size_t>(i)]);
            all.push_back(R[static_cast<std::size_t>(i)]);
        }
        cursor += chunk;
    }
    return all;
}

// ─── Test 1: prepared marker jump produces audible output after warm-up ──────
//
// HONEST FRAMING (MVP / Phase 1 / silence-only warm):
//   The benefit of prearming at this stage is moving Bungee's ~80 ms control-
//   thread warm cost UP FRONT, before the user triggers the jump. The audio-
//   thread first-block behaviour is identical to today's reactive seek: the
//   structural ~85 ms Bungee Stream latency (hop=-1) means the first ~10
//   blocks (4864 frames) at 48 kHz are silence. Real-audio prefeed (Phase 2
//   on this same branch) is what eliminates that silence.
//
//   What we verify here: after the swap, rendering through the renderer for
//   long enough to clear the latency window produces non-zero output. This
//   proves the prepared voice is a working voice (not corrupted by the warm
//   loop or by the atomic swap).
TEST_CASE("PrearmedJumpManager: prepared marker jump produces audio after warmup") {
    SourceManager sources;
    Session       session;
    init_fixture(sources, session, "src-1", "clip-1", "track-1", "song-1",
                  "marker-1", kMarkerFrame, /*transposed*/ true);

    BungeeVoiceManager bvm;
    REQUIRE(bvm.prepare(kSR, kCh, kBlockFrames));

    PrearmedJumpManager prearm;
    REQUIRE(prearm.prepare(kSR, kCh, kBlockFrames));

    // Prearm — runs the silence warm loop on this thread, ~70 ms × N voices.
    prearm.prepare_all_markers(session, sources, /*revision*/ 1);

    PrearmTargetKey key;
    key.kind             = PrearmTargetKind::Marker;
    key.song_id          = "song-1";
    key.target_id        = "marker-1";
    key.timeline_frame   = kMarkerFrame;
    key.sample_rate      = kSR;
    key.block_size       = kBlockFrames;
    key.session_revision = 1;

    auto prepared = prearm.take_ready(key);
    REQUIRE(prepared);
    REQUIRE(prepared->valid);
    REQUIRE_EQ(prepared->tracks.size(), 1);
    REQUIRE(prepared->tracks[0].ready);

    // Swap in. Audio thread (this thread, in the test) immediately sees the
    // prepared voice via voice_for().
    bvm.swap_in_prepared_voices(prepared->extract_voice_map());

    // Render 20 × 480 = 9600 frames — comfortably past Bungee's ~4864-frame
    // structural latency. We then split at the latency boundary and confirm
    // (a) the early blocks are mostly silent (latency window), (b) the
    // settled blocks carry energy similar to the source.
    const Track& track = session.songs[0].tracks[0];
    auto all = render_n_blocks(track, kMarkerFrame, 20, sources,
                                &bvm, kSemitones);

    // Settled-region RMS: skip the first ~5120 frames (one latency window
    // + one block of margin), measure the rest.
    constexpr std::size_t kSkipFrames = 5120;
    constexpr std::size_t kSkipSamples = kSkipFrames * kCh;
    REQUIRE(all.size() > kSkipSamples);
    std::vector<float> settled(all.begin() + kSkipSamples, all.end());
    const float rms = block_rms(settled);
    INFO("settled rms=", rms);
    CHECK(rms > 0.05f); // 0.5-amp sine → settled RMS ≈ 0.35 expected
}

// ─── Test 2: prepared jump preserves alignment vs unpitched ─────────────────

TEST_CASE("PrearmedJumpManager: prepared jump preserves alignment with unpitched track") {
    // Two parallel fixtures, same source content, one transposed, one not.
    SourceManager p_sources, u_sources;
    Session       p_session, u_session;
    init_fixture(p_sources, p_session, "src-p", "clip-p", "track-p", "song-p",
                  "marker-p", kMarkerFrame, /*transposed*/ true);
    init_fixture(u_sources, u_session, "src-u", "clip-u", "track-u", "song-u",
                  "marker-u", kMarkerFrame, /*transposed*/ false);

    BungeeVoiceManager bvm;
    REQUIRE(bvm.prepare(kSR, kCh, kBlockFrames));

    PrearmedJumpManager prearm;
    REQUIRE(prearm.prepare(kSR, kCh, kBlockFrames));
    prearm.prepare_all_markers(p_session, p_sources, 1);

    PrearmTargetKey key;
    key.kind             = PrearmTargetKind::Marker;
    key.song_id          = "song-p";
    key.target_id        = "marker-p";
    key.timeline_frame   = kMarkerFrame;
    key.sample_rate      = kSR;
    key.block_size       = kBlockFrames;
    key.session_revision = 1;

    auto prepared = prearm.take_ready(key);
    REQUIRE(prepared);
    bvm.swap_in_prepared_voices(prepared->extract_voice_map());

    // Render 20 blocks of each track (9600 frames, past Bungee's ~4864-frame
    // latency window). The MVP doesn't promise sample-exact alignment for
    // prepared jumps (Phase 2 prefeed work targets that); the silence-only
    // warm gives us a voice with same alignment guarantees as today's
    // reactive seek path — i.e. order-of-magnitude RMS agreement on
    // sustained sine input after the warmup tail.
    auto pitched_il = render_n_blocks(p_session.songs[0].tracks[0],
                                       kMarkerFrame, 20, p_sources,
                                       &bvm, kSemitones);
    auto unpitched_il = render_n_blocks(u_session.songs[0].tracks[0],
                                         kMarkerFrame, 20, u_sources,
                                         /*bvm*/ nullptr, 0);

    // Skip the latency window (5120 frames = 10240 stereo samples) and
    // compare RMS of the settled region.
    const std::size_t skip = static_cast<std::size_t>(5120) * kCh;
    REQUIRE(pitched_il.size() > skip);
    REQUIRE(unpitched_il.size() > skip);
    std::vector<float> p_settled(pitched_il.begin() + skip, pitched_il.end());
    std::vector<float> u_settled(unpitched_il.begin() + skip, unpitched_il.end());
    const float p_rms = block_rms(p_settled);
    const float u_rms = block_rms(u_settled);
    INFO("pitched_rms=", p_rms, " unpitched_rms=", u_rms);
    REQUIRE(u_rms > 0.05f); // sanity: unpitched should be near 0.354 for 0.5-amp sine
    CHECK(p_rms > u_rms * 0.10f); // pitched within ~10x of unpitched
    CHECK(p_rms < u_rms * 10.0f);
}

// ─── Test 3: prepared jump is transactional ─────────────────────────────────

TEST_CASE("PrearmedJumpManager: take_ready rejects invalid set (transactional)") {
    PrearmedJumpManager prearm;
    REQUIRE(prearm.prepare(kSR, kCh, kBlockFrames));

    // No prepare_all_markers call — the manager has no entries at all.
    PrearmTargetKey key;
    key.kind             = PrearmTargetKind::Marker;
    key.song_id          = "song-3";
    key.target_id        = "marker-3";
    key.timeline_frame   = kMarkerFrame;
    key.sample_rate      = kSR;
    key.block_size       = kBlockFrames;
    key.session_revision = 1;

    auto prepared = prearm.take_ready(key);
    CHECK_FALSE(prepared); // explicit miss, not a partial set
    const auto d = prearm.diagnostics();
    CHECK_EQ(d.take_hit_total, 0u);
    CHECK_EQ(d.take_miss_total, 1u);
}

// ─── Test 4: fallback works when target not ready ───────────────────────────

TEST_CASE("PrearmedJumpManager: zero-semitone targets do not allocate prepared voices") {
    SourceManager sources;
    Session       session;
    init_fixture(sources, session, "src-zero", "clip-zero", "track-zero",
                  "song-zero", "marker-zero", kMarkerFrame,
                  /*transposed*/ true,
                  /*samples_override*/ {},
                  /*transpose_amount*/ 0);

    PrearmedJumpManager prearm;
    REQUIRE(prearm.prepare(kSR, kCh, kBlockFrames));
    prearm.prepare_all_targets(session, sources, /*revision*/ 1);

    CHECK_EQ(prearm.diagnostics().ready_count, 0);

    auto prepared = prearm.prepare_target_now(
        session, sources,
        PrearmTargetKind::Marker, "song-zero", "marker-zero", kMarkerFrame,
        /*revision*/ 1);
    REQUIRE(prepared);
    CHECK(prepared->valid);
    CHECK(prepared->tracks.empty());
}

TEST_CASE("PrearmedJumpManager: fallback path renders audio when prearm missed") {
    // Caller behaviour we're modelling: miss take_ready → call
    // bvm.rebuild_for_seek synchronously. Verify that path still produces a
    // working voice that the renderer can use.
    SourceManager sources;
    Session       session;
    init_fixture(sources, session, "src-4", "clip-4", "track-4", "song-4",
                  "marker-4", kMarkerFrame, /*transposed*/ true);

    BungeeVoiceManager bvm;
    REQUIRE(bvm.prepare(kSR, kCh, kBlockFrames));

    PrearmedJumpManager prearm;
    REQUIRE(prearm.prepare(kSR, kCh, kBlockFrames));

    PrearmTargetKey key;
    key.kind             = PrearmTargetKind::Marker;
    key.song_id          = "song-4";
    key.target_id        = "marker-4";
    key.timeline_frame   = kMarkerFrame;
    key.sample_rate      = kSR;
    key.block_size       = kBlockFrames;
    key.session_revision = 1;

    // Take attempt fails (nothing prepared).
    auto prepared = prearm.take_ready(key);
    REQUIRE_FALSE(prepared);

    // Fallback: synchronous rebuild_for_seek (what the engine_impl wiring
    // does when prearm misses). We render 20 blocks (past the latency
    // window) and verify audio appears in the settled region — same
    // assertion shape as test 1 for the prearmed-hit path. This proves the
    // fallback path is a viable substitute when prearm has nothing ready.
    bvm.rebuild_for_seek(kMarkerFrame, session, sources);

    const Track& track = session.songs[0].tracks[0];
    auto all = render_n_blocks(track, kMarkerFrame, 20, sources,
                                &bvm, kSemitones);
    constexpr std::size_t kSkipSamples = 5120 * kCh;
    REQUIRE(all.size() > kSkipSamples);
    std::vector<float> settled(all.begin() + kSkipSamples, all.end());
    const float rms = block_rms(settled);
    INFO("fallback settled rms=", rms);
    CHECK(rms > 0.05f);
}

// ─── Phase 2 prefeed tests ──────────────────────────────────────────────────
//
// These tests validate that real-audio prefeed delivers what silence-only
// could not: the FIRST post-jump render block contains audio corresponding
// to the target source position. If these regress, revert the prefeed commit.

// Phase 2 Test A: first block after a prepared jump emits non-zero output.
// (Was a deliberately-deferred goal in the MVP; this is the load-bearing
// assertion that prefeed actually works.)
TEST_CASE("PrearmedJumpManager prefeed: first post-jump block emits audio") {
    SourceManager sources;
    Session       session;
    init_fixture(sources, session, "src-pf1", "clip-pf1", "track-pf1",
                  "song-pf1", "marker-pf1", kMarkerFrame, /*transposed*/ true);

    BungeeVoiceManager bvm;
    REQUIRE(bvm.prepare(kSR, kCh, kBlockFrames));

    PrearmedJumpManager prearm;
    REQUIRE(prearm.prepare(kSR, kCh, kBlockFrames));
    prearm.prepare_all_markers(session, sources, /*revision*/ 1);

    PrearmTargetKey key;
    key.kind             = PrearmTargetKind::Marker;
    key.song_id          = "song-pf1";
    key.target_id        = "marker-pf1";
    key.timeline_frame   = kMarkerFrame;
    key.sample_rate      = kSR;
    key.block_size       = kBlockFrames;
    key.session_revision = 1;

    auto prepared = prearm.take_ready(key);
    REQUIRE(prepared);
    REQUIRE(prepared->valid);
    bvm.swap_in_prepared_voices(prepared->extract_voice_map());

    const Track& track = session.songs[0].tracks[0];
    auto first_block = render_n_blocks(track, kMarkerFrame, 1,
                                        sources, &bvm, kSemitones);

    // Expected first-block RMS for 0.5-amp sine pitched -2 semitones ≈ 0.35.
    // Bungee may attenuate first samples for the 5ms fade-in; settled RMS
    // averaged over the whole block should still be substantial.
    const float rms = block_rms(first_block);
    INFO("first-block rms with prefeed=", rms);
    // 0.05 = same threshold the silence-warm test uses for SETTLED audio.
    // If prefeed works, the first block already passes this bar.
    CHECK(rms > 0.05f);
}

// Spec test 9: prepare() with new dimensions clears stale prepared voices.
//
// Models the engine_impl device-change flow: when the audio device
// renegotiates sample_rate or buffer_size, engine_impl calls
// prearmed_jumps_->clear() then prepare(new_sr, ch, new_bs). The cache
// must be empty afterwards.
TEST_CASE("PrearmedJumpManager: prepare() with new dims clears stale voices") {
    SourceManager sources;
    Session       session;
    init_fixture(sources, session, "src-d9", "clip-d9", "track-d9", "song-d9",
                  "marker-d9", kMarkerFrame, /*transposed*/ true);

    PrearmedJumpManager prearm;
    REQUIRE(prearm.prepare(kSR, kCh, kBlockFrames));
    prearm.prepare_all_targets(session, sources, 1);
    REQUIRE(prearm.diagnostics().ready_count >= 1);

    // Reconfigure with different buffer size — simulates SetBufferSize.
    REQUIRE(prearm.prepare(kSR, kCh, 1024));
    CHECK_EQ(prearm.diagnostics().ready_count, 0);
}

// Spec test 11: rapid jumps don't crash / desync. Models the user spamming
// marker jumps quickly. Each "jump" is: take_ready → if hit, swap into BVM.
// We loop, alternately preparing and taking, and assert no double-free /
// no manager corruption / monotonic counters.
TEST_CASE("PrearmedJumpManager: rapid prepare+take cycles are safe") {
    SourceManager sources;
    Session       session;
    init_fixture(sources, session, "src-rj", "clip-rj", "track-rj", "song-rj",
                  "marker-rj", kMarkerFrame, /*transposed*/ true);
    // Add a few more markers so prepare has multiple targets per pass.
    for (int i = 1; i < 4; ++i) {
        Marker m;
        m.id = std::string("marker-rj-") + std::to_string(i);
        m.name = "M";
        m.frame = 1024 + i * 1024;
        session.songs[0].markers.push_back(m);
    }

    PrearmedJumpManager prearm;
    REQUIRE(prearm.prepare(kSR, kCh, kBlockFrames));

    BungeeVoiceManager bvm;
    REQUIRE(bvm.prepare(kSR, kCh, kBlockFrames));

    // 5 iterations of: bump revision, prepare, take all 4 markers.
    for (int iter = 0; iter < 5; ++iter) {
        const auto rev = static_cast<std::uint64_t>(iter + 1);
        prearm.prepare_all_targets(session, sources, rev);

        for (int i = 0; i < 4; ++i) {
            PrearmTargetKey key;
            key.kind             = PrearmTargetKind::Marker;
            key.song_id          = "song-rj";
            key.target_id        = (i == 0)
                ? std::string("marker-rj")
                : std::string("marker-rj-") + std::to_string(i);
            key.timeline_frame   = (i == 0) ? kMarkerFrame : (1024 + i * 1024);
            key.sample_rate      = kSR;
            key.block_size       = kBlockFrames;
            key.session_revision = rev;
            auto prepared = prearm.take_ready(key);
            REQUIRE(prepared);
            REQUIRE(prepared->valid);
            // Atomic swap — same call pattern as engine_impl on jump.
            bvm.swap_in_prepared_voices(prepared->extract_voice_map());
        }
    }
    // No crash and counters are sensible: 5 iter × 4 markers = 20 hits.
    const auto d = prearm.diagnostics();
    CHECK_EQ(d.take_hit_total, 20u);
    CHECK_EQ(d.take_miss_total, 0u);
}

// Phase 2: prepare_all_targets_async posts a job to the worker thread and
// returns immediately. Wait briefly for completion then check the cache.
//
// We poll the diagnostics counter instead of using a future, mirroring the
// pattern engine_impl uses (fire-and-forget; UI sees results via snapshot).
TEST_CASE("PrearmedJumpManager: prepare_all_targets_async completes off-thread") {
    auto session = std::make_shared<Session>();
    SourceManager sources;
    init_fixture(sources, *session, "src-as", "clip-as", "track-as", "song-as",
                  "marker-as", kMarkerFrame, /*transposed*/ true);

    PrearmedJumpManager prearm;
    REQUIRE(prearm.prepare(kSR, kCh, kBlockFrames));

    prearm.prepare_all_targets_async(session, &sources, /*revision*/ 1);

    // Wait up to ~5 s for the worker to finish (cap is generous — actual
    // time is ~1 s for 1 marker × 1 voice on this hardware).
    const auto deadline = std::chrono::steady_clock::now()
                           + std::chrono::seconds(5);
    while (std::chrono::steady_clock::now() < deadline) {
        if (prearm.diagnostics().ready_count >= 1) break;
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }
    CHECK(prearm.diagnostics().ready_count >= 1);
}

// Phase 6b: prepare_target_now is the sync fast path used when take_ready
// misses (first jump after a pitch change beats the async worker).
TEST_CASE("PrearmedJumpManager: prepare_target_now builds one set immediately") {
    SourceManager sources;
    Session       session;
    init_fixture(sources, session, "src-pn", "clip-pn", "track-pn", "song-pn",
                  "marker-pn", kMarkerFrame, /*transposed*/ true);

    PrearmedJumpManager prearm;
    REQUIRE(prearm.prepare(kSR, kCh, kBlockFrames));

    // No prepare_all_targets call → cache is empty (models "user jumped
    // before async worker finished").
    PrearmTargetKey key;
    key.kind             = PrearmTargetKind::Marker;
    key.song_id          = "song-pn";
    key.target_id        = "marker-pn";
    key.timeline_frame   = kMarkerFrame;
    key.sample_rate      = kSR;
    key.block_size       = kBlockFrames;
    key.session_revision = 1;
    REQUIRE_FALSE(prearm.take_ready(key)); // confirm cache miss

    // Sync prepare-one should succeed and return a usable set.
    auto prepared = prearm.prepare_target_now(
        session, sources,
        PrearmTargetKind::Marker, "song-pn", "marker-pn", kMarkerFrame,
        /*revision*/ 1);
    REQUIRE(prepared);
    CHECK(prepared->valid);
    REQUIRE_EQ(prepared->tracks.size(), 1);
    CHECK(prepared->tracks[0].ready);

    // Swap in and confirm audio comes out — same load-bearing assertion as
    // test 5 (prefeed first-block-audio) but via the sync miss path.
    BungeeVoiceManager bvm;
    REQUIRE(bvm.prepare(kSR, kCh, kBlockFrames));
    bvm.swap_in_prepared_voices(prepared->extract_voice_map());
    auto first_block = render_n_blocks(session.songs[0].tracks[0],
                                        kMarkerFrame, 1, sources,
                                        &bvm, kSemitones);
    const float rms = block_rms(first_block);
    INFO("sync-prepared first-block rms=", rms);
    CHECK(rms > 0.05f);

    // Diagnostics: prepared_total bumped, take_miss_total bumped (from the
    // initial take_ready failure).
    const auto d = prearm.diagnostics();
    CHECK(d.prepared_total >= 1u);
    CHECK_EQ(d.take_miss_total, 1u);
}

// Phase 7: max_prepared_targets cap evicts oldest when exceeded.
TEST_CASE("PrearmedJumpManager: max_prepared_targets evicts oldest (FIFO)") {
    SourceManager sources;
    Session       session;
    init_fixture(sources, session, "src-ev", "clip-ev", "track-ev", "song-ev",
                  "marker-ev-0", 1024, /*transposed*/ true);
    // Add 5 more markers — total 6 markers + 1 song start = 7 targets.
    for (int i = 1; i < 6; ++i) {
        Marker m;
        m.id = std::string("marker-ev-") + std::to_string(i);
        m.name = "M";
        m.frame = 1024 + i * 1024;
        session.songs[0].markers.push_back(m);
    }

    PrearmedJumpManager prearm;
    REQUIRE(prearm.prepare(kSR, kCh, kBlockFrames));
    prearm.set_max_prepared_targets(3); // tight cap to force eviction
    REQUIRE_EQ(prearm.max_prepared_targets(), 3);

    prearm.prepare_all_targets(session, sources, /*revision*/ 1);

    // We built 7 targets, cap was 3 → at least 4 evictions.
    const auto d = prearm.diagnostics();
    INFO("ready_count=", d.ready_count, " eviction_total=", d.eviction_total);
    CHECK_EQ(d.ready_count, 3);
    CHECK(d.eviction_total >= 4u);
}

// Phase 6: revision bump invalidates previously prepared sets.
//
// Models the engine_impl flow: load session → prearm at revision 1 → user
// changes a transpose → engine bumps prearm_revision_ and re-prearms at
// revision 2. take_ready(key with revision 1) must miss; take_ready(key
// with revision 2) must hit.
TEST_CASE("PrearmedJumpManager: revision bump invalidates stale prepared sets") {
    SourceManager sources;
    Session       session;
    init_fixture(sources, session, "src-rv", "clip-rv", "track-rv", "song-rv",
                  "marker-rv", kMarkerFrame, /*transposed*/ true);

    PrearmedJumpManager prearm;
    REQUIRE(prearm.prepare(kSR, kCh, kBlockFrames));
    prearm.prepare_all_targets(session, sources, /*revision*/ 1);

    PrearmTargetKey old_key;
    old_key.kind             = PrearmTargetKind::Marker;
    old_key.song_id          = "song-rv";
    old_key.target_id        = "marker-rv";
    old_key.timeline_frame   = kMarkerFrame;
    old_key.sample_rate      = kSR;
    old_key.block_size       = kBlockFrames;
    old_key.session_revision = 1;

    // Bump to revision 2 and re-prearm. The old cache must be discarded.
    prearm.prepare_all_targets(session, sources, /*revision*/ 2);

    // The OLD key (revision 1) must not be found — keyed on revision.
    auto stale = prearm.take_ready(old_key);
    CHECK_FALSE(stale);

    // The NEW key (revision 2) must hit.
    PrearmTargetKey new_key = old_key;
    new_key.session_revision = 2;
    auto fresh = prearm.take_ready(new_key);
    REQUIRE(fresh);
    CHECK(fresh->valid);

    // Diagnostics should reflect: 2 prepared totals (rev 1 then rev 2),
    // 1 stale discard (rev 1 cleared on rev 2), 1 hit (the new take), 1
    // miss (the old take).
    const auto d = prearm.diagnostics();
    CHECK(d.prepared_total >= 2u);
    CHECK(d.stale_discard_total >= 1u);
    CHECK_EQ(d.take_hit_total, 1u);
    CHECK_EQ(d.take_miss_total, 1u);
}

// Phase 6: PrearmedJumpManager::clear() drops everything regardless of
// revision — used by device-change handlers in engine_impl.
TEST_CASE("PrearmedJumpManager: clear() drops all prepared sets") {
    SourceManager sources;
    Session       session;
    init_fixture(sources, session, "src-cl", "clip-cl", "track-cl", "song-cl",
                  "marker-cl", kMarkerFrame, /*transposed*/ true);

    PrearmedJumpManager prearm;
    REQUIRE(prearm.prepare(kSR, kCh, kBlockFrames));
    prearm.prepare_all_targets(session, sources, /*revision*/ 1);

    PrearmTargetKey key;
    key.kind             = PrearmTargetKind::Marker;
    key.song_id          = "song-cl";
    key.target_id        = "marker-cl";
    key.timeline_frame   = kMarkerFrame;
    key.sample_rate      = kSR;
    key.block_size       = kBlockFrames;
    key.session_revision = 1;

    // Confirm prepared exists. prepare_all_targets builds one set per
    // marker + one per region + one per song start. Our fixture has 1
    // marker and 1 song with no regions, so 2 valid sets.
    CHECK(prearm.diagnostics().ready_count >= 1);

    prearm.clear();
    CHECK_EQ(prearm.diagnostics().ready_count, 0);

    // take_ready misses after clear.
    auto post_clear = prearm.take_ready(key);
    CHECK_FALSE(post_clear);
}

// Phase 1 ext: Region + Song targets share the marker pipeline. We verify
// that prepare_all_targets builds prepared sets for them and take_ready
// returns valid sets.
TEST_CASE("PrearmedJumpManager: region and song targets are prearmed alongside markers") {
    SourceManager sources;
    Session       session;
    init_fixture(sources, session, "src-rt", "clip-rt", "track-rt", "song-rt",
                  "marker-rt", kMarkerFrame, /*transposed*/ true);
    // Add a region after init_fixture (which only seeds a marker).
    session.songs[0].regions.push_back(
        Region{"region-rt", "R1", 4096, 8192, /*transpose*/ 0});

    PrearmedJumpManager prearm;
    REQUIRE(prearm.prepare(kSR, kCh, kBlockFrames));
    prearm.prepare_all_targets(session, sources, /*revision*/ 1);

    // Marker (existing behaviour)
    PrearmTargetKey marker_key;
    marker_key.kind             = PrearmTargetKind::Marker;
    marker_key.song_id          = "song-rt";
    marker_key.target_id        = "marker-rt";
    marker_key.timeline_frame   = kMarkerFrame;
    marker_key.sample_rate      = kSR;
    marker_key.block_size       = kBlockFrames;
    marker_key.session_revision = 1;
    auto marker_set = prearm.take_ready(marker_key);
    REQUIRE(marker_set);
    CHECK(marker_set->valid);

    // Region (new)
    PrearmTargetKey region_key;
    region_key.kind             = PrearmTargetKind::RegionStart;
    region_key.song_id          = "song-rt";
    region_key.target_id        = "region-rt";
    region_key.timeline_frame   = 4096;
    region_key.sample_rate      = kSR;
    region_key.block_size       = kBlockFrames;
    region_key.session_revision = 1;
    auto region_set = prearm.take_ready(region_key);
    REQUIRE(region_set);
    CHECK(region_set->valid);

    // Song start (new)
    PrearmTargetKey song_key;
    song_key.kind             = PrearmTargetKind::SongStart;
    song_key.song_id          = "song-rt";
    song_key.target_id        = "song-rt";
    song_key.timeline_frame   = 0; // Song.start_frame from init_fixture
    song_key.sample_rate      = kSR;
    song_key.block_size       = kBlockFrames;
    song_key.session_revision = 1;
    auto song_set = prearm.take_ready(song_key);
    REQUIRE(song_set);
    CHECK(song_set->valid);
}

// Phase 2 Test B: pitched onset stays sample-aligned with unpitched onset
// after a prepared jump. Uses the same fixture pattern as
// pitch_alignment_tests.cpp so the bar is comparable.
TEST_CASE("PrearmedJumpManager prefeed: pitched click onset aligned with unpitched") {
    // Click 1024 frames AFTER the marker, so we can find the onset by
    // scanning the rendered output starting at sample 0. Click amplitude 1.0
    // dominates any pitch-shifter ringing.
    constexpr Frame click_offset = 1024;
    auto click_samples = test::make_stereo_click(
        kClipLen, kMarkerFrame + click_offset, 1.0f);

    SourceManager p_sources, u_sources;
    Session       p_session, u_session;
    init_fixture(p_sources, p_session, "src-pf2p", "clip-pf2p", "track-pf2p",
                  "song-pf2p", "marker-pf2p", kMarkerFrame, /*transposed*/ true,
                  click_samples);
    init_fixture(u_sources, u_session, "src-pf2u", "clip-pf2u", "track-pf2u",
                  "song-pf2u", "marker-pf2u", kMarkerFrame, /*transposed*/ false,
                  click_samples);

    BungeeVoiceManager bvm;
    REQUIRE(bvm.prepare(kSR, kCh, kBlockFrames));

    PrearmedJumpManager prearm;
    REQUIRE(prearm.prepare(kSR, kCh, kBlockFrames));
    prearm.prepare_all_markers(p_session, p_sources, 1);

    PrearmTargetKey key;
    key.kind             = PrearmTargetKind::Marker;
    key.song_id          = "song-pf2p";
    key.target_id        = "marker-pf2p";
    key.timeline_frame   = kMarkerFrame;
    key.sample_rate      = kSR;
    key.block_size       = kBlockFrames;
    key.session_revision = 1;

    auto prepared = prearm.take_ready(key);
    REQUIRE(prepared);
    bvm.swap_in_prepared_voices(prepared->extract_voice_map());

    // Render enough blocks to comfortably contain the click. Click is 1024
    // frames past the marker, well within the first ~3 blocks (1440 frames).
    constexpr int n_blocks = 8;
    auto pitched_il = render_n_blocks(p_session.songs[0].tracks[0],
                                       kMarkerFrame, n_blocks, p_sources,
                                       &bvm, kSemitones);
    auto unpitched_il = render_n_blocks(u_session.songs[0].tracks[0],
                                         kMarkerFrame, n_blocks, u_sources,
                                         /*bvm*/ nullptr, 0);

    const Frame p_onset = test::first_onset_frame(pitched_il, 0.2f);
    const Frame u_onset = test::first_onset_frame(unpitched_il, 0.2f);
    INFO("pitched onset=", p_onset, " unpitched onset=", u_onset);
    REQUIRE(u_onset >= 0); // unpitched should always find the click
    REQUIRE(p_onset >= 0); // prefeed should make pitched find it too

    // The existing pitch_alignment_tests bar is ≤ 2 samples. With prefeed
    // we may not hit that exactly (pitch shifting smears transients
    // slightly), so we accept ≤ 32 samples (~0.67ms at 48kHz) for the MVP
    // — tight enough to prove prefeed delivers the alignment win, loose
    // enough to allow Bungee's natural transient smear.
    CHECK(std::llabs(p_onset - u_onset) <= 32);
}

TEST_CASE("PrearmedJumpManager prefeed: pitched click alignment is stable across transpose values") {
    constexpr Frame click_offset = 1024;
    auto click_samples = test::make_stereo_click(
        kClipLen, kMarkerFrame + click_offset, 1.0f);

    SourceManager u_sources;
    Session       u_session;
    init_fixture(u_sources, u_session, "src-align-u", "clip-align-u", "track-align-u",
                  "song-align-u", "marker-align-u", kMarkerFrame, /*transposed*/ false,
                  click_samples);
    constexpr int n_blocks = 8;
    auto unpitched_il = render_n_blocks(u_session.songs[0].tracks[0],
                                         kMarkerFrame, n_blocks, u_sources,
                                         /*bvm*/ nullptr, 0);
    const Frame u_onset = test::first_onset_frame(unpitched_il, 0.2f);
    REQUIRE(u_onset >= 0);

    for (Semitones semitones : {-7, -2, 2, 7}) {
        SourceManager p_sources;
        Session       p_session;
        const auto suffix = std::to_string(semitones);
        init_fixture(p_sources, p_session,
                      "src-align-p-" + suffix,
                      "clip-align-p-" + suffix,
                      "track-align-p-" + suffix,
                      "song-align-p-" + suffix,
                      "marker-align-p-" + suffix,
                      kMarkerFrame,
                      /*transposed*/ true,
                      click_samples,
                      semitones);

        BungeeVoiceManager bvm;
        REQUIRE(bvm.prepare(kSR, kCh, kBlockFrames));

        PrearmedJumpManager prearm;
        REQUIRE(prearm.prepare(kSR, kCh, kBlockFrames));
        prearm.prepare_all_markers(p_session, p_sources, 1);

        PrearmTargetKey key;
        key.kind             = PrearmTargetKind::Marker;
        key.song_id          = "song-align-p-" + suffix;
        key.target_id        = "marker-align-p-" + suffix;
        key.timeline_frame   = kMarkerFrame;
        key.sample_rate      = kSR;
        key.block_size       = kBlockFrames;
        key.session_revision = 1;

        auto prepared = prearm.take_ready(key);
        REQUIRE(prepared);
        bvm.swap_in_prepared_voices(prepared->extract_voice_map());

        auto pitched_il = render_n_blocks(p_session.songs[0].tracks[0],
                                           kMarkerFrame, n_blocks, p_sources,
                                           &bvm, semitones);
        const Frame p_onset = test::first_onset_frame(pitched_il, 0.2f);
        INFO("semitones=", semitones,
             " pitched onset=", p_onset,
             " unpitched onset=", u_onset);
        REQUIRE(p_onset >= 0);
        CHECK(std::llabs(p_onset - u_onset) <= 32);
    }
}

TEST_CASE("PrearmedJumpManager prefeed: scheduled mid-callback jump keeps pitched track aligned") {
    constexpr Frame click_offset = 1024;
    auto click_samples = test::make_stereo_click(
        kClipLen, kMarkerFrame + click_offset, 1.0f);

    SourceManager p_sources, u_sources;
    Session       p_session, u_session;
    init_fixture(p_sources, p_session, "src-mid-p", "clip-mid-p", "track-mid-p",
                  "song-mid-p", "marker-mid-p", kMarkerFrame, /*transposed*/ true,
                  click_samples);
    init_fixture(u_sources, u_session, "src-mid-u", "clip-mid-u", "track-mid-u",
                  "song-mid-u", "marker-mid-u", kMarkerFrame, /*transposed*/ false,
                  click_samples);

    BungeeVoiceManager bvm;
    REQUIRE(bvm.prepare(kSR, kCh, kBlockFrames));

    PrearmedJumpManager prearm;
    REQUIRE(prearm.prepare(kSR, kCh, kBlockFrames));
    prearm.prepare_all_markers(p_session, p_sources, 1);

    PrearmTargetKey key;
    key.kind             = PrearmTargetKind::Marker;
    key.song_id          = "song-mid-p";
    key.target_id        = "marker-mid-p";
    key.timeline_frame   = kMarkerFrame;
    key.sample_rate      = kSR;
    key.block_size       = kBlockFrames;
    key.session_revision = 1;

    auto prepared = prearm.take_ready(key);
    REQUIRE(prepared);
    bvm.swap_in_prepared_voices(prepared->extract_voice_map());

    const std::vector<int> chunks = {
        177, kBlockFrames, kBlockFrames, kBlockFrames, kBlockFrames};
    auto pitched_il = render_chunk_sequence(p_session.songs[0].tracks[0],
                                             kMarkerFrame, chunks, p_sources,
                                             &bvm, kSemitones);
    auto unpitched_il = render_chunk_sequence(u_session.songs[0].tracks[0],
                                               kMarkerFrame, chunks, u_sources,
                                               /*bvm*/ nullptr, 0);

    const Frame p_onset = test::first_onset_frame(pitched_il, 0.2f);
    const Frame u_onset = test::first_onset_frame(unpitched_il, 0.2f);
    INFO("pitched onset=", p_onset, " unpitched onset=", u_onset);
    REQUIRE(u_onset >= 0);
    REQUIRE(p_onset >= 0);
    CHECK(std::llabs(p_onset - u_onset) <= 32);
}

TEST_CASE("PrearmedJumpManager prepare_target_now waits for streaming target blocks beyond eager cache") {
    constexpr Frame marker_frame = kDefaultBlockFrames * 300;
    constexpr Frame clip_len = marker_frame + kDefaultBlockFrames * 4;
    SourceManager sources;
    sources.register_source("src-stream-prearm", "stream-prearm-far-marker.wav");
    REQUIRE(sources.store_decoded_source(
        "src-stream-prearm",
        test::make_stereo_sine(clip_len, 440.0, 0.5f),
        kCh,
        kSR,
        clip_len).is_ok());

    Session session;
    Track track;
    track.id = "track-stream-prearm";
    track.transpose_behavior = TransposeBehavior::FollowsSongOrRegion;
    track.clips.push_back(Clip{"clip-stream-prearm", "src-stream-prearm", 0, 0, clip_len});

    Song song;
    song.id = "song-stream-prearm";
    song.start_frame = 0;
    song.end_frame = clip_len;
    song.bpm = 120.0;
    song.transpose_semitones = kSemitones;
    // Phase-4: pitch-only-no-warp now uses Varispeed, which does not build a
    // Bungee voice and therefore is not prearmed. This test specifically
    // exercises the streaming-source prearm path, so wrap the song in a
    // near-unity warp region to keep the decision routed through Stretched.
    {
        Region region;
        region.id              = "region-stream-prearm";
        region.start_frame     = 0;
        region.end_frame       = clip_len;
        region.warp_enabled    = true;
        region.warp_source_bpm = 120.0001;
        song.regions.push_back(region);
    }
    song.tracks.push_back(track);
    song.markers.push_back(Marker{"marker-stream-prearm", "Far", marker_frame});
    session.songs.push_back(song);

    auto source = sources.get_shared("src-stream-prearm");
    REQUIRE(source);
    REQUIRE(source->is_streaming());
    REQUIRE_FALSE(source->is_range_ready(marker_frame, kSR / 4));

    PrearmedJumpManager prearm;
    REQUIRE(prearm.prepare(kSR, kCh, kBlockFrames));
    auto prepared = prearm.prepare_target_now(
        session,
        sources,
        PrearmTargetKind::Marker,
        "song-stream-prearm",
        "marker-stream-prearm",
        marker_frame,
        1);

    REQUIRE(prepared);
    CHECK(prepared->valid);
    CHECK(source->is_range_ready(marker_frame, kSR / 4));
}

#endif // LT_ENGINE_HAVE_BUNGEE
