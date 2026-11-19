// Plan track-eq: el RTA del editor de EQ (toma en el mezclador + FFT fuera
// del hilo de audio). Todo en muestras y frames.

#include "test_audio_fixtures.h"

#include <doctest/doctest.h>
#include <lt_engine/diagnostics/rt_guard.h>
#include <lt_engine/render/mixer.h>
#include <lt_engine/render/spectrum_analyzer.h>
#include <lt_engine/scheduler/jump_scheduler.h>
#include <lt_engine/session/session.h>
#include <lt_engine/sources/source_manager.h>
#include <lt_engine/transport/transport_clock.h>

#include <algorithm>
#include <cmath>
#include <memory>
#include <vector>

using namespace lt;

namespace {

constexpr int kSR = 48000;
constexpr double kPi = 3.14159265358979323846;

std::vector<float> sine(std::size_t frames, double hz, double amplitude) {
    std::vector<float> out(frames);
    for (std::size_t i = 0; i < frames; ++i)
        out[i] = static_cast<float>(amplitude * std::sin(2.0 * kPi * hz * static_cast<double>(i) / kSR));
    return out;
}

std::size_t band_near(double hz) {
    std::size_t best = 0;
    double best_distance = 1e9;
    for (std::size_t b = 0; b < SpectrumAnalyzer::kBands; ++b) {
        const double distance = std::abs(std::log(spectrum_band_center_hz(b, SpectrumAnalyzer::kBands) / hz));
        if (distance < best_distance) {
            best_distance = distance;
            best = b;
        }
    }
    return best;
}

std::vector<float> analyze_once(SpectrumAnalyzer& analyzer, const AnalyzerTap& tap, double elapsed = 0.0) {
    std::vector<float> bands(SpectrumAnalyzer::kBands);
    REQUIRE(analyzer.analyze(tap, kSR, elapsed, bands.data(), bands.size()) == bands.size());
    return bands;
}

} // namespace

TEST_CASE("rta: a full-scale-relative sine reads its level in its band and little elsewhere") {
    AnalyzerTap tap;
    const auto signal = sine(8192, 1000.0, 0.5);   // -6 dBFS de pico
    tap.write(signal.data(), signal.data(), signal.size());
    SpectrumAnalyzer analyzer;
    const auto bands = analyze_once(analyzer, tap);
    const float at_1k = bands[band_near(1000.0)];
    CAPTURE(at_1k);
    CHECK(std::abs(at_1k - (-6.02f)) < 1.5f);
    CHECK(bands[band_near(100.0)] < at_1k - 50.0f);
    CHECK(bands[band_near(10000.0)] < at_1k - 50.0f);
}

TEST_CASE("rta: bands fall at the release rate once the signal stops") {
    AnalyzerTap tap;
    const auto signal = sine(8192, 2000.0, 0.5);
    tap.write(signal.data(), signal.data(), signal.size());
    SpectrumAnalyzer analyzer;
    const float loud = analyze_once(analyzer, tap)[band_near(2000.0)];
    const std::vector<float> silence(8192, 0.0f);
    tap.write(silence.data(), silence.data(), silence.size());
    const float after = analyze_once(analyzer, tap, 0.5)[band_near(2000.0)];
    CHECK(after == doctest::Approx(loud - 0.5f * SpectrumAnalyzer::kReleaseDbPerSecond).epsilon(0.001));
    analyzer.reset();
    CHECK(analyze_once(analyzer, tap)[band_near(2000.0)] == SpectrumAnalyzer::kFloorDb);
}

TEST_CASE("rta: the tap refuses short or overwritten windows") {
    AnalyzerTap tap;
    std::vector<float> out(4096);
    const auto small = sine(1000, 440.0, 0.3);
    tap.write(small.data(), small.data(), small.size());
    CHECK_FALSE(tap.read_latest(out.data(), out.size(), nullptr));
    const auto more = sine(8000, 440.0, 0.3);
    tap.write(more.data(), more.data(), more.size());
    std::uint64_t written = 0;
    CHECK(tap.read_latest(out.data(), out.size(), &written));
    CHECK(written == 9000);
    CHECK(out.back() == more.back());
    CHECK_FALSE(tap.read_latest(out.data(), AnalyzerTap::kCapacity + 1, nullptr));
}

namespace {

struct Rig {
    SourceManager sources;
    TransportClock clock{ kSR };
    JumpScheduler scheduler;
    std::unique_ptr<Mixer> mixer;

    explicit Rig(std::optional<TrackEqParams> eq) {
        constexpr Frame kFrames = kSR * 2;
        Session session;
        session.id = "rta";
        session.sample_rate = kSR;
        Song song;
        song.id = "song";
        song.start_frame = 0;
        song.end_frame = kFrames;
        for (const char* id : { "a", "b" }) {
            const std::string src = std::string("src-") + id;
            sources.register_source(src, "");
            REQUIRE(sources.store_decoded_source(src, test::make_stereo_sine(kFrames, 1000.0, 0.4f), 2, kSR,
                                                 kFrames).is_ok());
            session.sources.push_back(Source{ src, "" });
            Track track;
            track.id = id;
            if (std::string(id) == "a") track.eq = eq;
            track.clips.push_back(Clip{ std::string("c-") + id, src, 0, 0, kFrames });
            song.tracks.push_back(std::move(track));
        }
        session.songs.push_back(std::move(song));
        mixer = std::make_unique<Mixer>(std::make_shared<const Session>(std::move(session)), &sources, &clock,
                                        &scheduler);
        mixer->prepare_render_resources(512);
        mixer->set_active_output_channels({ 0, 1 });
        clock.play();
        clock.clear_pending_start();
    }

    void render(int blocks) {
        std::vector<float> l(512), r(512);
        float* out[2] = { l.data(), r.data() };
        for (int b = 0; b < blocks; ++b)
            mixer->render(out, 2, 512, clock.sample_rate());
    }
};

} // namespace

TEST_CASE("rta: the mixer copies only the chosen track, and nothing when off") {
    Rig rig(std::nullopt);
    rig.render(4);
    CHECK(rig.mixer->analyzer_tap().written() == 0);
    rig.mixer->set_analyzer_track("a");
    rig.render(10);
    CHECK(rig.mixer->analyzer_tap().written() == 10 * 512);
    rig.mixer->set_analyzer_track("");
    rig.render(10);
    CHECK(rig.mixer->analyzer_tap().written() == 10 * 512);
}

TEST_CASE("rta: the tap sees the track after its eq") {
    TrackEqParams notch;
    notch.enabled = true;
    notch.band_count = 1;
    notch.bands[0] = { true, EqBandKind::Notch, 1000.0f, 0.0f, 2.0f, 12 };
    auto level_at_1k = [](std::optional<TrackEqParams> eq) {
        Rig rig(eq);
        rig.mixer->set_analyzer_track("a");
        rig.render(40);
        SpectrumAnalyzer analyzer;
        return analyze_once(analyzer, rig.mixer->analyzer_tap())[band_near(1000.0)];
    };
    const float dry = level_at_1k(std::nullopt);
    const float notched = level_at_1k(notch);
    CAPTURE(dry);
    CAPTURE(notched);
    CHECK(notched < dry - 25.0f);
}

TEST_CASE("rta: rendering with the analyzer on does not allocate") {
    Rig rig(default_track_eq_params());
    rig.mixer->set_analyzer_track("a");
    rig.render(4);
    std::vector<float> l(512), r(512);
    float* out[2] = { l.data(), r.data() };
    lt::rt::reset_violations();
    for (int b = 0; b < 30; ++b)
        rig.mixer->render(out, 2, 512, rig.clock.sample_rate());
    const auto found = lt::rt::violations();
#if !defined(_MSC_VER)
    CHECK(found.allocations == 0);
#else
    CHECK(found.allocations == found.deallocations);
#endif
}
