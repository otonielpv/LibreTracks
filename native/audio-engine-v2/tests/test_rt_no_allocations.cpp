#include "test_audio_fixtures.h"

#include <doctest/doctest.h>
#include <lt_engine/diagnostics/rt_guard.h>
#include <lt_engine/render/mixer.h>
#include <lt_engine/scheduler/jump_scheduler.h>
#include <lt_engine/sources/source_manager.h>
#include <lt_engine/transport/transport_clock.h>

#include <memory>
#include <string>
#include <vector>

using namespace lt;

namespace {

constexpr int kBlockFrames = 512;
constexpr int kTrackCount = 4;
constexpr int kBlocks = 100;

Session four_track_session() {
    Session session;
    session.id = "rt-guard-session";
    session.sample_rate = test::kFixtureSampleRate;

    Song song;
    song.id = "song";
    song.start_frame = 0;
    song.end_frame = kBlockFrames * kBlocks;
    for (int index = 0; index < kTrackCount; ++index) {
        const auto suffix = std::to_string(index);
        const Id source_id = "source-" + suffix;
        session.sources.push_back(Source{source_id, ""});

        Track track;
        track.id = "track-" + suffix;
        track.clips.push_back(Clip{
            "clip-" + suffix, source_id, 0, 0, song.end_frame
        });
        song.tracks.push_back(std::move(track));
    }
    session.songs.push_back(std::move(song));
    return session;
}

} // namespace

// Expected failure until step 03 removes per-track routing allocations from
// Mixer::render. Run explicitly with --no-skip to inspect the current count;
// step 03 must remove doctest::skip() when the count reaches zero.
TEST_CASE("Mixer render performs no realtime allocations" * doctest::skip()) {
    SourceManager sources;
    for (int index = 0; index < kTrackCount; ++index) {
        const Id source_id = "source-" + std::to_string(index);
        sources.register_source(source_id, "");
        REQUIRE(sources.store_decoded_source(
            source_id,
            test::make_stereo_sine(kBlockFrames * kBlocks, 220.0 + index * 55.0),
            2,
            test::kFixtureSampleRate,
            kBlockFrames * kBlocks).is_ok());
    }

    auto session = std::make_shared<Session>(four_track_session());
    TransportClock clock(test::kFixtureSampleRate);
    JumpScheduler scheduler;
    Mixer mixer(session, &sources, &clock, &scheduler);
    clock.play();
    clock.clear_pending_start();

    std::vector<float> left(kBlockFrames);
    std::vector<float> right(kBlockFrames);
    float* output[] = {left.data(), right.data()};

    lt::rt::reset_violations();
    for (int block = 0; block < kBlocks; ++block)
        mixer.render(output, 2, kBlockFrames, clock.sample_rate());

    const auto found = lt::rt::violations();
    CAPTURE(found.allocations);
    CAPTURE(found.deallocations);
    CHECK(found.allocations == 0);
}
