// Crecer el pool de pistas mientras el hilo de audio renderiza.
//
// Google Play (1.16, moto g75) reporto un SIGSEGV en la fase A del mezclador:
// prepare_render_resources publicaba renderer_count_ = 0 y ampliaba
// renderers_ / track_buses_ en el acto, pero un bloque que ya habia leido el
// contador anterior seguia indexando esos vectores mientras se reasignaban.
// Ahora espera a que no quede ningun render() en vuelo. Este test alterna
// sesiones cada vez mas grandes (por encima de las 64 ranuras iniciales) con
// un hilo de audio renderizando sin parar y el pool de 4 hilos activo; con el
// fallo, la build Debug lee punteros liberados y revienta.

#include "test_audio_fixtures.h"

#include <doctest/doctest.h>
#include <lt_engine/render/mixer.h>
#include <lt_engine/scheduler/jump_scheduler.h>
#include <lt_engine/session/session.h>
#include <lt_engine/sources/source_manager.h>
#include <lt_engine/transport/transport_clock.h>

#include <atomic>
#include <memory>
#include <string>
#include <thread>
#include <vector>

using namespace lt;

namespace {

constexpr int kSR = test::kFixtureSampleRate;
constexpr int kBlock = 256;

std::shared_ptr<const Session> session_with_tracks(SourceManager& sm, int tracks, Frame length) {
    Session s;
    s.id = "grow";
    s.sample_rate = kSR;
    s.sources.push_back(Source{"src", ""});

    Song song;
    song.id = "song";
    song.start_frame = 0;
    song.end_frame = length;
    song.bpm = 120.0;
    for (int i = 0; i < tracks; ++i) {
        Track t;
        t.id = "trk-" + std::to_string(i);
        t.kind = TrackKind::Audio;
        t.gain = 0.1f;
        t.clips.push_back(Clip{"clip-" + std::to_string(i), "src", 0, 0, length});
        song.tracks.push_back(std::move(t));
    }
    s.songs.push_back(std::move(song));
    return std::make_shared<const Session>(std::move(s));
}

} // namespace

TEST_CASE("mixer: ampliar las pistas con el hilo de audio renderizando no lee memoria liberada") {
    const Frame length = static_cast<Frame>(kSR) * 4;
    SourceManager sm;
    sm.register_source("src", "");
    REQUIRE(sm.store_decoded_source(
        "src", test::make_stereo_sine(length, 220.0, 0.3f), 2, kSR, length).is_ok());

    TransportClock clock(kSR);
    JumpScheduler scheduler;
    Mixer mixer(session_with_tracks(sm, 8, length), &sm, &clock, &scheduler);
    mixer.set_render_thread_count(4);
    mixer.set_active_output_channels({0, 1});
    clock.play();

    std::atomic<bool> stop{false};
    std::atomic<int> blocks{0};
    std::thread audio([&] {
        std::vector<float> l(kBlock), r(kBlock);
        float* ptrs[2] = {l.data(), r.data()};
        while (!stop.load(std::memory_order_relaxed)) {
            mixer.render(ptrs, 2, kBlock, kSR);
            blocks.fetch_add(1, std::memory_order_relaxed);
        }
    });

    // Cada sesion supera a la anterior, asi que cada set_session amplia y
    // reasigna los vectores del pool.
    for (int tracks = 66; tracks <= 66 + 40 * 8; tracks += 8) {
        mixer.set_session(session_with_tracks(sm, tracks, length));
        std::this_thread::yield();
    }

    stop.store(true);
    audio.join();
    CHECK(blocks.load() > 0);

    // El pool quedo publicado entero y sin la exclusion puesta: el bloque
    // siguiente vuelve a sonar. Al principio del clip, que el hilo de audio
    // habra dejado atras.
    clock.seek(0);
    std::vector<float> l(kBlock), r(kBlock);
    float* ptrs[2] = {l.data(), r.data()};
    mixer.render(ptrs, 2, kBlock, kSR);
    float peak = 0.0f;
    for (float v : l) peak = std::max(peak, std::abs(v));
    CHECK(peak > 0.0f);
}
