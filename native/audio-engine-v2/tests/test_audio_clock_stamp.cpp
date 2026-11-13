// Redundancy step 02 (docs/plans/completed/redundancy/02-reloj-de-audio.md): the
// (instant, frame) stamp the mixer publishes at the top of every block.

#include "test_audio_fixtures.h"

#include <doctest/doctest.h>
#include <lt_engine/render/mixer.h>
#include <lt_engine/scheduler/jump_scheduler.h>
#include <lt_engine/sources/source_manager.h>
#include <lt_engine/transport/audio_clock_stamp.h>
#include <lt_engine/transport/transport_clock.h>

#include <atomic>
#include <chrono>
#include <thread>
#include <vector>

using namespace lt;

namespace {

constexpr int kBlock = 256;

std::int64_t steady_ns_now() {
    return std::chrono::duration_cast<std::chrono::nanoseconds>(
               std::chrono::steady_clock::now().time_since_epoch())
        .count();
}

Session one_song_session() {
    Session session;
    session.id = "session";
    session.sample_rate = test::kFixtureSampleRate;
    session.sources.push_back(Source{"source", ""});
    Song song;
    song.id = "song";
    song.start_frame = 0;
    song.end_frame = 48000 * 4;
    Track track;
    track.id = "track";
    track.clips.push_back(Clip{"clip", "source", 0, 0, 48000 * 4});
    song.tracks.push_back(track);
    session.songs.push_back(song);
    return session;
}

} // namespace

TEST_CASE("audio clock stamp: the read stamp is the last block's start frame and instant") {
    SourceManager sources;
    sources.register_source("source", "");
    REQUIRE(sources.store_decoded_source("source",
        test::make_stereo_sine(48000 * 4, 440.0, 0.5f),
        2, test::kFixtureSampleRate, 48000 * 4).is_ok());
    auto session = std::make_shared<Session>(one_song_session());
    TransportClock clock(test::kFixtureSampleRate);
    JumpScheduler scheduler;
    Mixer mixer(session, &sources, &clock, &scheduler);
    AudioClockStamp stamp;
    mixer.set_audio_clock_stamp(&stamp);

    AudioClockStampData data;
    REQUIRE(stamp.read(data));
    CHECK(data.blocks == 0);

    clock.play();
    clock.clear_pending_start();

    std::vector<float> left(kBlock), right(kBlock);
    float* out[2] = {left.data(), right.data()};
    // The "fake device": N callbacks; before each one we note the frame the
    // block will start at and bracket the call with the clock.
    for (int block = 0; block < 10; ++block) {
        const Frame start_frame = clock.position().frame;
        const std::int64_t before = steady_ns_now();
        if (block == 7)
            mixer.set_block_host_time_ns(123456789ull);
        mixer.render(out, 2, kBlock, clock.sample_rate());
        const std::int64_t after = steady_ns_now();

        REQUIRE(stamp.read(data));
        CHECK(data.blocks == static_cast<std::uint64_t>(block + 1));
        // The frame BEFORE this block advanced the clock.
        CHECK(data.frame == start_frame);
        CHECK(clock.position().frame == start_frame + kBlock);
        CHECK(data.steady_ns >= before);
        CHECK(data.steady_ns <= after);
        CHECK(data.sample_rate == test::kFixtureSampleRate);
        CHECK(data.moving);
        CHECK(data.host_time_ns == (block == 7 ? 123456789ull : 0ull));
    }

    // Paused: the stamp still comes, saying the transport does not move.
    clock.pause();
    const Frame paused_at = clock.position().frame;
    mixer.render(out, 2, kBlock, clock.sample_rate());
    REQUIRE(stamp.read(data));
    CHECK_FALSE(data.moving);
    CHECK(data.frame == paused_at);

    // Held by the pending-start gate: playing, but not advancing yet.
    clock.play();
    clock.arm_pending_start();
    mixer.render(out, 2, kBlock, clock.sample_rate());
    REQUIRE(stamp.read(data));
    CHECK_FALSE(data.moving);
}

TEST_CASE("audio clock stamp: a concurrent reader never sees a mixed trio") {
    AudioClockStamp stamp;
    std::atomic<bool> done{false};
    // Writer: frame = 48 * t_ms, with t in ns, and sample rate / moving
    // derived from the same counter, so any torn read breaks a relation.
    std::thread writer([&] {
        for (std::int64_t i = 1; i <= 200000; ++i) {
            const std::int64_t t_ns = i * 1'000'000;  // i ms
            stamp.publish(t_ns, static_cast<std::uint64_t>(t_ns) + 7, 48 * i,
                          (i % 2) ? 48000 : 44100, (i % 3) == 0);
        }
        done.store(true, std::memory_order_release);
    });

    std::uint64_t reads = 0;
    std::uint64_t last_blocks = 0;
    bool mixed = false;
    while (!done.load(std::memory_order_acquire) || reads < 10000) {
        AudioClockStampData data;
        if (!stamp.read(data))
            continue;
        ++reads;
        if (data.blocks == 0)
            continue;
        const std::int64_t i = data.steady_ns / 1'000'000;
        const bool ok = data.frame == 48 * i
            && data.host_time_ns == static_cast<std::uint64_t>(data.steady_ns) + 7
            && data.sample_rate == ((i % 2) ? 48000 : 44100)
            && data.moving == ((i % 3) == 0)
            && data.blocks == static_cast<std::uint64_t>(i)
            && data.blocks >= last_blocks;
        if (!ok) {
            mixed = true;
            break;
        }
        last_blocks = data.blocks;
    }
    writer.join();
    CHECK_FALSE(mixed);
    CHECK(reads >= 10000);
}
