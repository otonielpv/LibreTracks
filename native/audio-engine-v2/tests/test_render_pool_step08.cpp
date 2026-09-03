// Paso 08 — pool de trabajadores de tiempo real.
//
// C1 es el criterio que sostiene todo el paso: la salida tiene que ser
// BIT-EXACTA con 1, 2, 4 y 8 hilos. El paso 07 lo hizo posible al fijar el
// orden de la reducción; si aquí falla, es que algo de la fase B se coló en la
// fase A.
//
// Nada de este fichero mide tiempos. El rendimiento se demuestra con
// bench_render_callback, que ejecuta la persona.

#include "test_audio_fixtures.h"

#include <doctest/doctest.h>
#include <lt_engine/diagnostics/rt_guard.h>
#include <lt_engine/pitch/bungee_voice_manager.h>
#include <lt_engine/render/mixer.h>
#include <lt_engine/render/render_thread_pool.h>
#include <lt_engine/scheduler/jump_scheduler.h>
#include <lt_engine/session/session.h>
#include <lt_engine/sources/source_manager.h>
#include <lt_engine/transport/transport_clock.h>

#include <atomic>
#include <latch>
#include <memory>
#include <string>
#include <vector>

using namespace lt;

namespace {

constexpr int kSR     = test::kFixtureSampleRate;
constexpr int kBlock  = 512;
constexpr int kBlocks = 120;
constexpr int kTracks = 24;

Session build_session(SourceManager& sm, Frame length, bool warp_enabled = true,
                      int track_count = kTracks) {
    Session s;
    s.id = "s08";
    s.sample_rate = kSR;

    Song song;
    song.id = "song08";
    song.start_frame = 0;
    song.end_frame = length;
    song.bpm = 120.0;

    Region warp;
    warp.id = "r-warp";
    warp.start_frame = 0;
    warp.end_frame = length;
    warp.warp_enabled = warp_enabled;
    warp.warp_source_bpm = 100.0;      // ratio 1.2 -> voces Bungee de verdad
    song.regions.push_back(warp);

    Track folder;
    folder.id = "folder";
    folder.kind = TrackKind::Folder;
    folder.audio_to = "master";
    folder.gain = 0.9f;
    song.tracks.push_back(folder);

    for (int i = 0; i < track_count; ++i) {
        const std::string src = "src-" + std::to_string(i);
        sm.register_source(src, "");
        REQUIRE(sm.store_decoded_source(
            src, test::make_stereo_sine(length, 90.0 + 13.0 * i, 0.3f),
            2, kSR, length).is_ok());
        s.sources.push_back(Source{src, ""});

        Track t;
        t.id = "trk-" + std::to_string(i);
        t.kind = TrackKind::Audio;
        t.gain = 0.25f + 0.03f * static_cast<float>(i % 6);
        t.pan  = -0.5f + 0.11f * static_cast<float>(i % 8);
        t.parent_track_id = (i % 2 == 0) ? "folder" : "";
        t.audio_to = (i % 3 == 0) ? "inherit" : (i % 3 == 1) ? "master" : "monitor";
        t.clips.push_back(Clip{"clip-" + std::to_string(i), src, 0, 0, length});
        song.tracks.push_back(std::move(t));
    }
    s.songs.push_back(std::move(song));
    return s;
}

// Renderiza la sesión con `threads` hilos y devuelve todas las muestras.
std::vector<float> render_with(int threads) {
    const Frame length = static_cast<Frame>(kBlock) * (kBlocks + 32);
    SourceManager sm;
    auto session = std::make_shared<const Session>(build_session(sm, length));

    TransportClock clock(kSR);
    JumpScheduler  scheduler;
    Mixer mixer(session, &sm, &clock, &scheduler);

    // Sin gestor de voces, la region warpeada manda todo por render_path_stretched
    // y ese camino devuelve SILENCIO cuando no encuentra voz. La primera version
    // de este test se dejaba el gestor y comparaba silencio contra silencio: lo
    // caza el REQUIRE del pico, no la lectura.
    BungeeVoiceManager voices;
    REQUIRE(voices.prepare(kSR, 2, kBlock * 4));
    voices.rebuild_for_session(*session, sm, /*playhead=*/0);
    mixer.set_bungee_voice_manager(&voices);

    mixer.prepare_render_resources(kBlock);
    mixer.set_active_output_channels({0, 1, 2, 3});
    mixer.set_render_thread_count(threads);
    clock.play();

    std::vector<std::vector<float>> chans(4, std::vector<float>(kBlock, 0.0f));
    std::vector<float*> ptrs(4);
    for (int c = 0; c < 4; ++c) ptrs[static_cast<std::size_t>(c)] = chans[static_cast<std::size_t>(c)].data();

    std::vector<float> out;
    out.reserve(static_cast<std::size_t>(kBlocks) * kBlock * 4);
    for (int b = 0; b < kBlocks; ++b) {
        for (auto& c : chans) std::fill(c.begin(), c.end(), 0.0f);
        mixer.render(ptrs.data(), 4, kBlock, clock.sample_rate());
        for (const auto& c : chans) out.insert(out.end(), c.begin(), c.end());
    }
    mixer.set_render_thread_count(1);   // para los trabajadores antes de salir
    return out;
}

} // namespace

TEST_CASE("step08 C1: la salida es bit-exacta con 1, 2, 4 y 8 hilos") {
    const auto serie = render_with(1);
    REQUIRE(serie.size() > 0);

    float peak = 0.0f;
    for (float s : serie) peak = std::max(peak, std::abs(s));
    REQUIRE_MESSAGE(peak > 0.01f, "la sesion no suena: la comparacion seria trivial");

    for (int threads : {2, 3, 4, 8}) {
        const auto paralelo = render_with(threads);
        REQUIRE(paralelo.size() == serie.size());

        std::size_t diffs = 0;
        std::size_t first = 0;
        for (std::size_t i = 0; i < serie.size(); ++i) {
            if (!(serie[i] == paralelo[i])) {   // igualdad exacta, sin epsilon
                if (diffs == 0) first = i;
                ++diffs;
            }
        }
        CAPTURE(threads);
        CHECK_MESSAGE(diffs == 0,
                      diffs << " muestras de " << serie.size() << " difieren con "
                      << threads << " hilos (la primera en el indice " << first
                      << "): algo de la fase B se ha colado en la fase A");
    }
}

TEST_CASE("step08 C3: con un hilo no se entra en la barrera") {
    const Frame length = static_cast<Frame>(kBlock) * 64;
    SourceManager sm;
    auto session = std::make_shared<const Session>(build_session(sm, length));

    TransportClock clock(kSR);
    JumpScheduler  scheduler;
    Mixer mixer(session, &sm, &clock, &scheduler);
    mixer.prepare_render_resources(kBlock);
    mixer.set_render_thread_count(1);
    clock.play();

    std::vector<float> l(kBlock, 0.0f), r(kBlock, 0.0f);
    float* ptrs[2] = { l.data(), r.data() };
    for (int b = 0; b < 32; ++b)
        mixer.render(ptrs, 2, kBlock, clock.sample_rate());

    const auto d = mixer.render_pool_diagnostics();
    CHECK(d.threads == 1);
    CHECK_MESSAGE(d.barrier_entries == 0,
                  "con un hilo el camino serie no debe tocar la barrera");
    CHECK(d.blocks_serial > 0);
    CHECK(d.blocks_run == 0);
}

RenderThreadPoolDiagnostics render_pool_diagnostics_for(bool warp_enabled,
                                                         int track_count) {
    const Frame length = static_cast<Frame>(kBlock) * 64;
    SourceManager sm;
    auto session = std::make_shared<const Session>(
        build_session(sm, length, warp_enabled, track_count));

    TransportClock clock(kSR);
    JumpScheduler scheduler;
    Mixer mixer(session, &sm, &clock, &scheduler);
    BungeeVoiceManager voices;
    REQUIRE(voices.prepare(kSR, 2, kBlock * 4));
    voices.rebuild_for_session(*session, sm, /*playhead=*/0);
    mixer.set_bungee_voice_manager(&voices);
    mixer.prepare_render_resources(kBlock);
    mixer.set_render_thread_count(4);
    clock.play();

    std::vector<float> left(kBlock, 0.0f), right(kBlock, 0.0f);
    float* channels[2] = {left.data(), right.data()};
    mixer.render(channels, 2, kBlock, kSR);
    return mixer.render_pool_diagnostics();
}

TEST_CASE("el pool no despierta trabajadores para una sola tarea") {
    RenderThreadPool pool;
    pool.start(4);

    std::atomic<int> calls{0};
    auto job = [&](int) noexcept {
        calls.fetch_add(1, std::memory_order_relaxed);
    };
    RenderJobRef ref(job);
    for (int block = 0; block < 50; ++block)
        pool.run_block(1, ref);

    const auto d = pool.diagnostics();
    CHECK(calls.load(std::memory_order_relaxed) == 50);
    CHECK(d.blocks_serial == 50);
    CHECK(d.blocks_run == 0);
    CHECK(d.barrier_entries == 0);
}

TEST_CASE("el llamante puede mantener un bloque barato en serie") {
    RenderThreadPool pool;
    pool.start(4);

    std::atomic<int> calls{0};
    auto job = [&](int) noexcept {
        calls.fetch_add(1, std::memory_order_relaxed);
    };
    RenderJobRef ref(job);
    pool.run_block(24, ref, /*allow_parallel=*/false);

    const auto d = pool.diagnostics();
    CHECK(calls.load(std::memory_order_relaxed) == 24);
    CHECK(d.blocks_serial == 1);
    CHECK(d.blocks_run == 0);
    CHECK(d.barrier_entries == 0);
}

TEST_CASE("el mixer solo paraleliza cuando hay suficientes pistas DSP caras") {
    const auto direct = render_pool_diagnostics_for(false, 24);
    CHECK(direct.blocks_serial == 1);
    CHECK(direct.barrier_entries == 0);

    const auto small_warp = render_pool_diagnostics_for(true, 7);
    CHECK(small_warp.blocks_serial == 1);
    CHECK(small_warp.barrier_entries == 0);

    const auto large_warp = render_pool_diagnostics_for(true, 8);
    CHECK(large_warp.blocks_run == 1);
    CHECK(large_warp.barrier_entries == 1);
}

TEST_CASE("step08 C6: arrancar y parar el pool repetidamente no cuelga") {
    RenderThreadPool pool;
    std::atomic<int> calls{0};
    auto job = [&](int) noexcept { calls.fetch_add(1, std::memory_order_relaxed); };

    for (int i = 0; i < 100; ++i) {
        pool.start((i % 3) + 2);          // 2, 3 o 4 hilos
        RenderJobRef ref(job);
        pool.run_block(8, ref);
        pool.stop();
    }
    CHECK(calls.load() == 100 * 8);
    CHECK(pool.thread_count() == 1);      // parado
}

TEST_CASE("step08 C8: cambiar el numero de hilos entre bloques no pierde trabajo") {
    RenderThreadPool pool;
    std::atomic<int> calls{0};
    auto job = [&](int) noexcept { calls.fetch_add(1, std::memory_order_relaxed); };

    for (int threads : {1, 4, 1, 2, 8, 1}) {
        pool.start(threads);
        for (int b = 0; b < 20; ++b) {
            RenderJobRef ref(job);
            pool.run_block(16, ref);
        }
    }
    pool.stop();
    CHECK(calls.load() == 6 * 20 * 16);
}

TEST_CASE("step08 C9: si no hay trabajadores el trabajo se hace igual") {
    // Robustez: el camino serie tiene que producir exactamente el mismo numero
    // de llamadas. Es lo que garantiza que un fallo al crear hilos degrade a
    // "mas apretado" y no a "silencio".
    RenderThreadPool pool;
    std::atomic<int> calls{0};
    auto job = [&](int) noexcept { calls.fetch_add(1, std::memory_order_relaxed); };

    pool.start(0);                        // sin trabajadores
    CHECK(pool.thread_count() == 1);
    RenderJobRef ref(job);
    pool.run_block(32, ref);
    CHECK(calls.load() == 32);
}

TEST_CASE("step08: cada indice se ejecuta exactamente una vez") {
    // La cola es un fetch_add compartido. Si el reparto se equivocara, una
    // pista se renderizaria dos veces (se oiria al doble) o ninguna (silencio).
    RenderThreadPool pool;
    pool.start(4);

    constexpr int kCount = 512;
    std::vector<std::atomic<int>> hits(kCount);
    for (auto& h : hits) h.store(0, std::memory_order_relaxed);
    auto job = [&](int i) noexcept { hits[static_cast<std::size_t>(i)].fetch_add(1, std::memory_order_relaxed); };

    for (int b = 0; b < 50; ++b) {
        RenderJobRef ref(job);
        pool.run_block(kCount, ref);
    }
    pool.stop();

    std::size_t wrong = 0;
    for (auto& h : hits)
        if (h.load(std::memory_order_relaxed) != 50) ++wrong;
    CHECK_MESSAGE(wrong == 0, wrong << " indices no se ejecutaron exactamente 50 veces");
}

TEST_CASE("step08 C4: la fase A no asigna memoria, tampoco en los trabajadores") {
    // El detector del paso 02 es por hilo, asi que hay que marcar la seccion
    // DENTRO del trabajo, que es lo que corre en los trabajadores.
    RenderThreadPool pool;
    pool.start(4);

    std::atomic<std::uint64_t> allocations{0};
    auto job = [&](int) noexcept {
        lt::rt::reset_violations();
        lt::rt::ScopedRealtimeSection guard;
        // Trabajo representativo sin asignar: escribir en memoria ya reservada.
        volatile float acc = 0.0f;
        for (int i = 0; i < 64; ++i) acc += static_cast<float>(i);
        (void)acc;
        allocations.fetch_add(lt::rt::violations().allocations,
                              std::memory_order_relaxed);
    };

    for (int b = 0; b < 20; ++b) {
        RenderJobRef ref(job);
        pool.run_block(32, ref);
    }
    pool.stop();
    CHECK(allocations.load() == 0);
}
