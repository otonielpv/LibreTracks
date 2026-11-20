// Plan track-eq-2, paso 09: EQ de máster por canción.
//
// Se mide en muestras y frames. Lo "bit a bit" se compara con igualdad exacta.

#include "test_audio_fixtures.h"

#include <doctest/doctest.h>
#include <lt_engine/render/mixer.h>
#include <lt_engine/scheduler/jump_scheduler.h>
#include <lt_engine/session/session.h>
#include <lt_engine/sources/source_manager.h>
#include <lt_engine/transport/transport_clock.h>

#include <algorithm>
#include <cmath>
#include <memory>
#include <optional>
#include <string>
#include <vector>

using namespace lt;

namespace {

constexpr int kSR = test::kFixtureSampleRate;
constexpr int kBlock = 512;
constexpr int kChannels = 4;   // 0-1 máster, 2-3 monitor

TrackEqParams master_peak(float hz = 700.0f, float gain_db = 9.0f) {
    TrackEqParams params;
    params.enabled = true;
    params.band_count = 1;
    params.bands[0] = TrackEqBandParams{ true, EqBandKind::Peak, hz, gain_db, 1.0f, 12 };
    return params;
}

// Dos canciones seguidas (A y B) con una pista por el máster y otra por el
// monitor en cada una.
Session two_song_session(Frame song_frames, std::optional<TrackEqParams> eq_a,
                         std::optional<TrackEqParams> eq_b) {
    Session session;
    session.id = "master-eq";
    session.sample_rate = kSR;
    session.sources.push_back(Source{ "s-main", "" });
    session.sources.push_back(Source{ "s-mon", "" });
    Song song;
    song.id = "song";
    song.start_frame = 0;
    song.end_frame = song_frames * 2;
    Region a;
    a.id = "a";
    a.start_frame = 0;
    a.end_frame = song_frames;
    a.master_eq = eq_a;
    Region b;
    b.id = "b";
    b.start_frame = song_frames;
    b.end_frame = song_frames * 2;
    b.master_eq = eq_b;
    song.regions = { a, b };
    Track main;
    main.id = "main";
    main.audio_to = "master";
    main.clips.push_back(Clip{ "c-main", "s-main", 0, 0, song_frames * 2 });
    Track mon;
    mon.id = "mon";
    mon.audio_to = "monitor";
    mon.clips.push_back(Clip{ "c-mon", "s-mon", 0, 0, song_frames * 2 });
    song.tracks = { main, mon };
    session.songs.push_back(std::move(song));
    return session;
}

struct Output {
    std::vector<float> master;    // L y R intercalados
    std::vector<float> monitor;
};

template <typename OnBlock>
Output render(Session session, int blocks, Frame song_frames, OnBlock on_block,
              bool metronome = false) {
    SourceManager sources;
    const Frame total = song_frames * 2;
    sources.register_source("s-main", "");
    REQUIRE(sources.store_decoded_source("s-main", test::make_stereo_sine(total, 523.25, 0.3f), 2,
                                         kSR, total).is_ok());
    sources.register_source("s-mon", "");
    REQUIRE(sources.store_decoded_source("s-mon", test::make_stereo_sine(total, 880.0, 0.25f), 2,
                                         kSR, total).is_ok());
    TransportClock clock(kSR);
    JumpScheduler scheduler;
    auto shared = std::make_shared<const Session>(std::move(session));
    Mixer mixer(shared, &sources, &clock, &scheduler);
    mixer.prepare_render_resources(kBlock);
    mixer.set_active_output_channels({ 0, 1, 2, 3 });
    if (metronome) mixer.set_metronome_config(MetronomeConfig{ true, 0.15f, "master", true });
    clock.play();
    clock.clear_pending_start();
    std::vector<std::vector<float>> buffers(kChannels, std::vector<float>(kBlock));
    float* channels[kChannels] = { buffers[0].data(), buffers[1].data(), buffers[2].data(),
                                   buffers[3].data() };
    Output out;
    for (int b = 0; b < blocks; ++b) {
        on_block(mixer, b);
        for (auto& buffer : buffers) std::fill(buffer.begin(), buffer.end(), 0.0f);
        mixer.render(channels, kChannels, kBlock, clock.sample_rate());
        for (int f = 0; f < kBlock; ++f) {
            out.master.push_back(buffers[0][static_cast<std::size_t>(f)]);
            out.master.push_back(buffers[1][static_cast<std::size_t>(f)]);
            out.monitor.push_back(buffers[2][static_cast<std::size_t>(f)]);
            out.monitor.push_back(buffers[3][static_cast<std::size_t>(f)]);
        }
    }
    return out;
}

Output render(Session session, int blocks, Frame song_frames, bool metronome = false) {
    return render(std::move(session), blocks, song_frames, [](Mixer&, int) {}, metronome);
}

std::size_t count_diffs(const std::vector<float>& a, const std::vector<float>& b) {
    REQUIRE(a.size() == b.size());
    std::size_t diffs = 0;
    for (std::size_t i = 0; i < a.size(); ++i)
        if (!(a[i] == b[i])) ++diffs;
    return diffs;
}

float max_step(const std::vector<float>& v, std::size_t from_frame) {
    float worst = 0.0f;
    for (std::size_t f = std::max<std::size_t>(1, from_frame); f * 2 + 1 < v.size(); ++f)
        for (std::size_t ch = 0; ch < 2; ++ch)
            worst = std::max(worst, std::abs(v[f * 2 + ch] - v[(f - 1) * 2 + ch]));
    return worst;
}

} // namespace

TEST_CASE("master eq C1: without a song master eq the output is bit-identical") {
    const Frame song = kBlock * 60;
    const auto none = render(two_song_session(song, std::nullopt, std::nullopt), 80, song);
    auto off = master_peak();
    off.enabled = false;
    const auto disabled = render(two_song_session(song, off, off), 80, song);
    CHECK(count_diffs(none.master, disabled.master) == 0);
    CHECK(count_diffs(none.monitor, disabled.monitor) == 0);
    const auto on = render(two_song_session(song, master_peak(), std::nullopt), 80, song);
    CHECK(count_diffs(none.master, on.master) > 0);
}

TEST_CASE("master eq C2: the song master eq leaves the monitor route and the click alone") {
    const Frame song = kBlock * 60;
    const auto plain = render(two_song_session(song, std::nullopt, std::nullopt), 50, song);
    const auto with_eq = render(two_song_session(song, master_peak(), master_peak()), 50, song);
    CHECK(count_diffs(plain.master, with_eq.master) > 0);
    CHECK(count_diffs(plain.monitor, with_eq.monitor) == 0);

    // El click se suma después del EQ: la diferencia con click y sin click es
    // la misma con y sin EQ de máster (el click no pasa por el EQ).
    const auto plain_click = render(two_song_session(song, std::nullopt, std::nullopt), 50, song, true);
    const auto eq_click = render(two_song_session(song, master_peak(), master_peak()), 50, song, true);
    float worst = 0.0f;
    for (std::size_t i = 0; i < plain.master.size(); ++i) {
        const float click_plain = plain_click.master[i] - plain.master[i];
        const float click_eq = eq_click.master[i] - with_eq.master[i];
        worst = std::max(worst, std::abs(click_plain - click_eq));
    }
    CAPTURE(worst);
    CHECK(worst <= 1e-6f);
    float click_peak = 0.0f;
    for (std::size_t i = 0; i < plain.master.size(); ++i)
        click_peak = std::max(click_peak, std::abs(plain_click.master[i] - plain.master[i]));
    CHECK(click_peak > 0.005f);
}

TEST_CASE("master eq C3: moving to a song with a different eq does not click") {
    const Frame song = kBlock * 40;
    const auto dry = render(two_song_session(song, std::nullopt, std::nullopt), 80, song);
    const auto wet = render(two_song_session(song, master_peak(523.25f, 12.0f),
                                             master_peak(523.25f, -12.0f)),
                            80, song);
    const std::size_t from = static_cast<std::size_t>(kBlock) * 4;
    const float threshold = max_step(dry.master, from) * std::pow(10.0f, 12.0f / 20.0f) * 1.1f;
    CAPTURE(threshold);
    CHECK(max_step(wet.master, from) <= threshold);
    // Y el cambio de canción cambia la curva: después del límite suena más bajo.
    double before = 0.0, after = 0.0;
    const std::size_t boundary = static_cast<std::size_t>(song);
    for (std::size_t f = boundary - 4000; f < boundary - 1000; ++f) before += wet.master[f * 2] * wet.master[f * 2];
    for (std::size_t f = boundary + 3000; f < boundary + 6000; ++f) after += wet.master[f * 2] * wet.master[f * 2];
    CHECK(after < before * 0.1);
}

TEST_CASE("master eq: a live SetSongMasterEq reaches the playing song") {
    const Frame song = kBlock * 60;
    const auto plain = render(two_song_session(song, std::nullopt, std::nullopt), 50, song);
    const auto live = render(two_song_session(song, std::nullopt, std::nullopt), 50, song,
                             [](Mixer& mixer, int b) {
                                 if (b == 10) mixer.set_song_master_eq("a", master_peak());
                                 if (b == 30) mixer.set_song_master_eq("a", std::nullopt);
                             });
    const std::size_t block = static_cast<std::size_t>(kBlock) * 2;
    std::vector<float> early(plain.master.begin(), plain.master.begin() + block * 9);
    std::vector<float> early_live(live.master.begin(), live.master.begin() + block * 9);
    CHECK(count_diffs(early, early_live) == 0);
    std::vector<float> mid(plain.master.begin() + block * 12, plain.master.begin() + block * 28);
    std::vector<float> mid_live(live.master.begin() + block * 12, live.master.begin() + block * 28);
    CHECK(count_diffs(mid, mid_live) > 0);
    CHECK(count_diffs(plain.monitor, live.monitor) == 0);
}
