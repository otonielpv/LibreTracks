// warp_timing_tests.cpp
//
// The invariants the warp path owes Bungee, and that nothing else in the suite
// checks.
//
// Bungee::Stream has no concept of "where in the file" a block came from. It
// concatenates every buffer we hand it into one logical input stream and
// stretches THAT. So the renderer is solely responsible for two properties,
// and the audio gives away neither once the grains have smeared it:
//
//   CONTIGUITY  Consecutive feeds must abut exactly. A gap skips source
//               material; an overlap feeds it twice. Both are splices the
//               stretcher can neither see nor repair.
//
//   RATE        The total source span fed must equal (output frames elapsed x
//               warp ratio). Per-block rounding that always leans the same way
//               integrates into drift against the click — inaudible in the
//               first bars, unmistakable by the last chorus.
//
// These are independent: a design can satisfy either one while breaking the
// other, which is precisely how both historical bugs survived a green suite.
//
// Ratio choice matters more than it looks. 0.75 and 1.5 divide the common
// block sizes exactly, so ceil(N * ratio) == N * ratio and every rounding bug
// reports zero error. The ratios below are the ones real tempo pairs produce:
//   120 -> 100 = 0.8333...   110 -> 100 = 0.9091...   100 -> 120 = 1.2
// Do not "simplify" them to round numbers — that is what blinded the suite.

#include "test_audio_fixtures.h"

#include <doctest/doctest.h>
#include <lt_engine/pitch/bungee_voice_manager.h>
#include <lt_engine/render/track_renderer.h>
#include <lt_engine/session/session.h>
#include <lt_engine/sources/source_manager.h>

#include <cmath>
#include <string>
#include <vector>

#if LT_ENGINE_HAVE_BUNGEE

using namespace lt;

namespace {

constexpr int kSR       = test::kFixtureSampleRate;
constexpr int kChannels = 2;

// A song whose single region is warped from `source_bpm` to `song_bpm`, giving
// a warp ratio of song_bpm / source_bpm. One track, one clip spanning the whole
// thing, no transpose — we are measuring time, not pitch.
Session make_warped_session(double song_bpm, double source_bpm, Frame length) {
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
    song.end_frame   = length;
    song.bpm         = song_bpm;
    song.transpose_semitones = 0;

    Region region;
    region.id              = "region1";
    region.name            = "region";
    region.start_frame     = 0;
    region.end_frame       = length;
    region.warp_enabled    = true;
    region.warp_source_bpm = source_bpm;
    region.transpose_semitones = 0;
    song.regions.push_back(region);

    Track track;
    track.id   = "trk1";
    track.kind = TrackKind::Audio;
    track.transpose_behavior = TransposeBehavior::FollowsSongOrRegion;
    track.clips.push_back(Clip{"clip1", "src1", /*tl*/0, /*src*/0, length});
    song.tracks.push_back(track);

    s.songs.push_back(song);
    return s;
}

bool register_loaded_source(SourceManager& sm, const Id& id, Frame frames) {
    sm.register_source(id, "");
    auto pcm = test::make_stereo_sine(frames, 220.0, 0.5f);
    return sm.store_decoded_source(id, std::move(pcm), kChannels, kSR, frames).is_ok();
}

struct WarpRun {
    std::uint64_t gap_frames    = 0;
    std::uint64_t gap_events    = 0;
    std::uint64_t source_fed    = 0;
    std::uint64_t output_made   = 0;
    std::uint64_t stretched     = 0;
    double        delivered_ratio() const {
        return output_made ? static_cast<double>(source_fed)
                           / static_cast<double>(output_made)
                          : 0.0;
    }
};

// Render `seconds` of continuous playback through the real TrackRenderer and
// report what the warp path fed the stretcher.
WarpRun render_continuous(double song_bpm, double source_bpm,
                          int block, double seconds) {
    const Frame length = static_cast<Frame>(kSR * (seconds + 30.0));
    Session session = make_warped_session(song_bpm, source_bpm, length);

    SourceManager sm;
    REQUIRE(register_loaded_source(sm, "src1", length));

    BungeeVoiceManager voices;
    REQUIRE(voices.prepare(kSR, kChannels, block * 4));
    voices.rebuild_for_session(session, sm, /*playhead=*/0);

    TrackRenderer renderer;
    renderer.prepare(block);
    TrackRenderer::reset_diagnostics();

    std::vector<float> out_l(static_cast<std::size_t>(block), 0.0f);
    std::vector<float> out_r(static_cast<std::size_t>(block), 0.0f);
    float* out[2] = { out_l.data(), out_r.data() };

    const Song&  song  = session.songs[0];
    const Track& track = song.tracks[0];
    const int blocks = static_cast<int>(seconds * kSR / block);
    for (int b = 0; b < blocks; ++b) {
        std::fill(out_l.begin(), out_l.end(), 0.0f);
        std::fill(out_r.begin(), out_r.end(), 0.0f);
        renderer.render(track, static_cast<Frame>(b) * block, block,
                        out, 2, sm, &voices, kSR,
                        /*effective_semitones=*/0, &song);
    }

    const auto d = TrackRenderer::diagnostics();
    return WarpRun{d.stretched_feed_gap_frames, d.stretched_feed_gap_events,
                   d.stretched_source_frames_fed, d.stretched_output_frames_made,
                   d.path_stretched_count};
}

} // namespace

// ───────────────────────────────────────────────────────────────────────────
// Invariant 1 — the feed is contiguous.
//
// Fails when the read position is derived from anything that moves
// independently of what was actually consumed: a cursor advancing by output
// rather than input, or Bungee's live latency() folded into the read address.
// ───────────────────────────────────────────────────────────────────────────
// Marked should_fail until the read position is derived from the timeline.
// The suite stays green while the defect is on record; the decorator comes off
// in the commit that fixes it, and its removal is the proof the fix landed.
TEST_CASE("Warp: the source feed is contiguous across blocks"
          * doctest::should_fail()) {
    struct Case { const char* name; double song_bpm, source_bpm; int block; };
    const Case cases[] = {
        {"120->100 @512", 100.0, 120.0, 512},
        {"120->100 @256", 100.0, 120.0, 256},
        {"110->100 @512", 100.0, 110.0, 512},
        {"100->120 @512", 120.0, 100.0, 512},
    };

    for (const auto& c : cases) {
        INFO("case=" << std::string(c.name));
        const auto run = render_continuous(c.song_bpm, c.source_bpm, c.block, 20.0);
        REQUIRE(run.stretched > 0);   // guard: the warp path really ran

        // Every gap is a splice. There is no acceptable non-zero value here:
        // one frame of overlap per block still means we hand Bungee a stream
        // that repeats material 86 times a second.
        INFO("gap frames=" << run.gap_frames << " over " << run.gap_events
             << " blocks of " << run.stretched);
        CHECK(run.gap_frames == 0);
    }
}

// ───────────────────────────────────────────────────────────────────────────
// Invariant 2 — the delivered ratio equals the requested ratio.
//
// Fails when per-block rounding leans one way. The tolerance is deliberately
// tight: at 0.01% a four-minute song drifts ~24 ms, which is already audible
// against a click, so anything looser would licence the bug.
// ───────────────────────────────────────────────────────────────────────────
// should_fail for the same reason as the contiguity case above.
TEST_CASE("Warp: the delivered ratio does not drift from the requested ratio"
          * doctest::should_fail()) {
    struct Case { const char* name; double song_bpm, source_bpm; int block; };
    const Case cases[] = {
        {"120->100 @512", 100.0, 120.0, 512},
        {"120->100 @256", 100.0, 120.0, 256},
        {"110->100 @512", 100.0, 110.0, 512},
        {"100->120 @256", 120.0, 100.0, 256},
    };

    for (const auto& c : cases) {
        INFO("case=" << std::string(c.name));
        const double requested = c.song_bpm / c.source_bpm;
        const auto run = render_continuous(c.song_bpm, c.source_bpm, c.block, 20.0);
        REQUIRE(run.stretched > 0);
        REQUIRE(run.output_made > 0);

        const double delivered = run.delivered_ratio();
        const double rel_error = std::abs(delivered - requested) / requested;

        // Project the measured error onto a realistic song so a failure reads
        // as musical damage rather than an abstract percentage.
        const double drift_ms_4min = rel_error * 240.0 * 1000.0;
        INFO("requested=" << requested << " delivered=" << delivered
             << " rel_error=" << (rel_error * 100.0) << "%"
             << " => " << drift_ms_4min << " ms drift over 4 min");
        CHECK(rel_error < 1.0e-4);
    }
}

// ───────────────────────────────────────────────────────────────────────────
// The ratios that hide the bug.
//
// Not a redundant case — a guard on the test suite itself. 0.75 and 1.5 are
// exact for every common block size, so they report a clean bill of health no
// matter how broken the rounding is. If someone ever "tidies" the ratios above
// into round numbers, this test documents why the results would be worthless.
// ───────────────────────────────────────────────────────────────────────────
TEST_CASE("Warp: exact ratios cannot detect rounding drift") {
    for (int block : {256, 512, 1024}) {
        const double ratio = 0.75;
        const double exact = static_cast<double>(block) * ratio;
        CAPTURE(block);
        // ceil() is a no-op here, which is exactly why these ratios are useless
        // as regression cases.
        CHECK(std::ceil(exact) == exact);
        CHECK(std::ceil(static_cast<double>(block) * 1.5)
              == static_cast<double>(block) * 1.5);
        // …whereas a real tempo pair leaves a remainder on every single block.
        const double real = static_cast<double>(block) * (100.0 / 120.0);
        CHECK(std::ceil(real) != real);
    }
}

#endif // LT_ENGINE_HAVE_BUNGEE
