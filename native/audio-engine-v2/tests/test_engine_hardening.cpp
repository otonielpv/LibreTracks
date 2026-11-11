// Hardening found comparing the engine with LMMS (2026-11-11): realtime
// allocations hidden by short test ids, a Session that could die on the audio
// thread, NaN/Inf reaching the device, and denormals left enabled.

#include "test_audio_fixtures.h"

#include <doctest/doctest.h>

#include <lt_engine/core/denormals.h>
#include <lt_engine/diagnostics/rt_guard.h>
#include <lt_engine/render/mix_math.h>
#include <lt_engine/render/mixer.h>
#include <lt_engine/scheduler/jump_scheduler.h>
#include <lt_engine/session/session.h>
#include <lt_engine/sources/block_cache.h>
#include <lt_engine/sources/source_manager.h>
#include <lt_engine/transport/transport_clock.h>

#include <cmath>
#include <limits>
#include <memory>
#include <thread>
#include <vector>

using namespace lt;

namespace {

// What a real source id looks like: the file path (normalize_source_id in
// engine.rs). Far longer than any small-string buffer, unlike the "source-0"
// ids the older allocation test uses, which is why it never saw this.
const Id kRealisticSourceId =
    "C:/Users/musician/Music/LibreTracks/Sessions/Sunday Service/Way Maker/Stems/Bass Guitar.wav";

} // namespace

TEST_CASE("BlockCache::read with a path-length source id does not allocate") {
    constexpr int kFrames = 256;
    BlockCache cache(kFrames, 16, 4);
    std::vector<float> interleaved(static_cast<std::size_t>(kFrames * 2), 0.25f);
    cache.fill(kRealisticSourceId, 0, interleaved.data(), 2, kFrames);
    REQUIRE(cache.has_block(kRealisticSourceId, 0));

    std::vector<float> left(kFrames), right(kFrames);
    float* out[2] = {left.data(), right.data()};

    lt::rt::reset_violations();
    bool hit = false;
    {
        lt::rt::ScopedRealtimeSection realtime;
        for (int i = 0; i < 64; ++i)
            hit = cache.read(kRealisticSourceId, 0, 0, kFrames, out, 2);
    }
    const auto found = lt::rt::violations();
    CHECK(hit);
    CHECK(left[0] == doctest::Approx(0.25f));
    CAPTURE(found.allocations);
    // Before the transparent lookup this was 64: one std::string copy per read.
    CHECK(found.allocations == 0);
    CHECK(found.deallocations == 0);
}

TEST_CASE("BlockCache lookups by view and by owning key agree") {
    constexpr int kFrames = 64;
    BlockCache cache(kFrames, 16, 4);
    std::vector<float> interleaved(static_cast<std::size_t>(kFrames * 2), 1.0f);
    cache.fill(kRealisticSourceId, 3, interleaved.data(), 2, kFrames);

    CHECK(cache.has_block(kRealisticSourceId, 3));
    CHECK_FALSE(cache.has_block(kRealisticSourceId, 2));
    CHECK_FALSE(cache.has_block(kRealisticSourceId + "x", 3));

    std::vector<int> missing;
    cache.append_missing_blocks(kRealisticSourceId, 2, 4, missing);
    CHECK(missing == std::vector<int>{2, 4});
}

TEST_CASE("soft_limit_output turns NaN and Inf into silence") {
    const float nan = std::numeric_limits<float>::quiet_NaN();
    const float inf = std::numeric_limits<float>::infinity();
    CHECK(soft_limit_output(nan) == 0.0f);
    CHECK(soft_limit_output(-nan) == 0.0f);
    CHECK(soft_limit_output(inf) == 0.0f);
    CHECK(soft_limit_output(-inf) == 0.0f);
    // Unchanged behaviour for real samples.
    CHECK(soft_limit_output(0.5f) == 0.5f);
    CHECK(soft_limit_output(-0.5f) == -0.5f);
    CHECK(soft_limit_output(4.0f) <= 0.999f);
    CHECK(soft_limit_output(4.0f) > 0.98f);
    CHECK(soft_limit_output(-4.0f) >= -0.999f);
}

TEST_CASE("sanitize_non_finite zeroes a poisoned buffer and leaves a healthy one alone") {
    std::vector<float> healthy{0.1f, -0.2f, 0.999f, 1.0e-30f, 0.0f, -0.0f, 3.0f};
    const auto before = healthy;
    CHECK_FALSE(sanitize_non_finite(healthy.data(), static_cast<int>(healthy.size())));
    CHECK(healthy == before);

    for (const float bad : {std::numeric_limits<float>::quiet_NaN(),
                            std::numeric_limits<float>::infinity(),
                            -std::numeric_limits<float>::infinity()}) {
        std::vector<float> poisoned(37, 0.5f);
        poisoned[29] = bad;
        CHECK(sanitize_non_finite(poisoned.data(), static_cast<int>(poisoned.size())));
        for (const float v : poisoned)
            CHECK(v == 0.0f);
    }
    CHECK_FALSE(sanitize_non_finite(nullptr, 8));
}

TEST_CASE("Mixer keeps a replaced session alive while another owner still holds it") {
    SourceManager sources;
    TransportClock clock(48000);
    JumpScheduler scheduler;

    auto first = std::make_shared<Session>();
    std::weak_ptr<const Session> first_watch = first;
    Mixer mixer(std::shared_ptr<const Session>(first), &sources, &clock, &scheduler);

    // Stands in for the audio thread's per-block copy, taken just before the
    // control thread swaps the session.
    std::shared_ptr<const Session> callback_copy = first;
    first.reset();

    mixer.set_session(std::make_shared<Session>(), /*preserve_realtime_state=*/false);

    // The callback finishes its block and drops its copy. Before the fix it was
    // the last owner here and the Session was destroyed on the audio thread.
    callback_copy.reset();
    CHECK_FALSE(first_watch.expired());

    // The next swap, on the control thread, is what frees it.
    mixer.set_session(std::make_shared<Session>(), /*preserve_realtime_state=*/false);
    CHECK(first_watch.expired());
}

TEST_CASE("Mixer frees a replaced session at once when nobody else holds it") {
    SourceManager sources;
    TransportClock clock(48000);
    JumpScheduler scheduler;

    auto first = std::make_shared<Session>();
    std::weak_ptr<const Session> first_watch = first;
    Mixer mixer(std::shared_ptr<const Session>(first), &sources, &clock, &scheduler);
    first.reset();

    mixer.set_session(std::make_shared<Session>(), /*preserve_realtime_state=*/false);
    CHECK(first_watch.expired());
}

TEST_CASE("ScopedNoDenormals flushes subnormals and restores the previous mode") {
    if (!denormal_control_supported())
        return;
    const bool was_disabled = denormals_disabled_for_current_thread();
    volatile float tiny = std::numeric_limits<float>::min();  // smallest normal
    {
        ScopedNoDenormals scope;
        CHECK(denormals_disabled_for_current_thread());
        volatile float halved = tiny * 0.5f;  // subnormal without FTZ
        CHECK(halved == 0.0f);
    }
    CHECK(denormals_disabled_for_current_thread() == was_disabled);
    if (!was_disabled) {
        volatile float halved = tiny * 0.5f;
        CHECK(halved > 0.0f);
    }
}

namespace {

// Two tracks over two sources: one healthy sine and one carrying NaN and Inf.
struct PoisonRig {
    static constexpr int kBlock = 256;
    static constexpr int kBlocks = 8;
    SourceManager sources;
    TransportClock clock{test::kFixtureSampleRate};
    JumpScheduler scheduler;
    std::unique_ptr<Mixer> mixer;

    explicit PoisonRig(bool mute_poisoned) {
        const Frame frames = kBlock * kBlocks;
        auto healthy = test::make_stereo_sine(frames, 330.0);
        auto poisoned = test::make_stereo_sine(frames, 440.0);
        for (std::size_t i = 0; i < poisoned.size(); i += 97)
            poisoned[i] = (i % 2) ? std::numeric_limits<float>::quiet_NaN()
                                  : std::numeric_limits<float>::infinity();
        sources.register_source("healthy", "");
        sources.register_source("poisoned", "");
        REQUIRE(sources.store_decoded_source("healthy", std::move(healthy), 2,
                                             test::kFixtureSampleRate, frames).is_ok());
        REQUIRE(sources.store_decoded_source("poisoned", std::move(poisoned), 2,
                                             test::kFixtureSampleRate, frames).is_ok());

        auto session = std::make_shared<Session>();
        session->id = "poison";
        session->sample_rate = test::kFixtureSampleRate;
        session->sources.push_back(Source{"healthy", ""});
        session->sources.push_back(Source{"poisoned", ""});
        Song song;
        song.id = "song";
        song.start_frame = 0;
        song.end_frame = frames;
        for (const char* id : {"healthy", "poisoned"}) {
            Track track;
            track.id = id;
            track.mute = mute_poisoned && std::string(id) == "poisoned";
            track.clips.push_back(Clip{std::string("clip-") + id, id, 0, 0, frames});
            song.tracks.push_back(std::move(track));
        }
        session->songs.push_back(std::move(song));
        mixer = std::make_unique<Mixer>(std::shared_ptr<const Session>(session),
                                        &sources, &clock, &scheduler);
        mixer->set_active_output_channels({0, 1});
        clock.play();
        clock.clear_pending_start();
    }

    // Renders every block; returns true when every output sample is finite and
    // at least one is non-zero (the healthy track still plays).
    bool render_all_finite_and_audible() {
        std::vector<float> l(kBlock), r(kBlock);
        float* out[2] = {l.data(), r.data()};
        bool finite = true, audible = false;
        for (int b = 0; b < kBlocks; ++b) {
            std::fill(l.begin(), l.end(), 0.f);
            std::fill(r.begin(), r.end(), 0.f);
            mixer->render(out, 2, kBlock, clock.sample_rate());
            for (int f = 0; f < kBlock; ++f) {
                finite = finite && std::isfinite(l[f]) && std::isfinite(r[f]);
                audible = audible || l[f] != 0.f || r[f] != 0.f;
            }
        }
        return finite && audible;
    }
};

} // namespace

TEST_CASE("a track rendering NaN/Inf is silenced; the rest of the mix survives") {
    PoisonRig rig(/*mute_poisoned=*/false);
    CHECK(rig.render_all_finite_and_audible());
    CHECK(rig.mixer->non_finite_track_blocks() > 0);
}

TEST_CASE("a muted track rendering NaN/Inf cannot poison the mix either") {
    // NaN * 0 is NaN: muting is not enough, and the post-fader meter skips its
    // loop for a muted track, so this path has its own scan.
    PoisonRig rig(/*mute_poisoned=*/true);
    CHECK(rig.render_all_finite_and_audible());
    CHECK(rig.mixer->non_finite_track_blocks() > 0);
}

TEST_CASE("the callback thread flushes denormals after its first block") {
    if (!denormal_control_supported())
        return;
    PoisonRig rig(/*mute_poisoned=*/false);
    bool before = true, after = false;
    // A fresh thread starts with the default IEEE mode, like a driver thread.
    std::thread callback([&] {
        before = denormals_disabled_for_current_thread();
        std::vector<float> l(PoisonRig::kBlock), r(PoisonRig::kBlock);
        float* out[2] = {l.data(), r.data()};
        rig.mixer->render(out, 2, PoisonRig::kBlock, rig.clock.sample_rate());
        after = denormals_disabled_for_current_thread();
    });
    callback.join();
    CHECK_FALSE(before);
    CHECK(after);
}
