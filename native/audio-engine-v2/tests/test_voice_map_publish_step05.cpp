// Paso 05 — publicación del mapa de voces sin el spinlock global de MSVC, y
// sin destruir voces dentro del callback.
//
// Los dos criterios con dientes de este paso:
//
//   C3  publicar y consumir el mapa desde hilos distintos es correcto, y ningún
//       mapa muere mientras alguien lo está usando.
//   C4  `voices_destroyed_on_audio_thread` vale 0 tras reconstruir el mapa a
//       mitad de reproducción.
//
// C4 es el que importa. Destruir una voz libera los buffers de Bungee, o sea
// toma el lock del allocator; hacerlo dentro del callback es un stall del hilo
// de audio, y es exactamente lo que pasaba cuando el hilo de audio soltaba la
// última referencia a un mapa ya reemplazado.

#include "test_audio_fixtures.h"

#include <doctest/doctest.h>
#include <lt_engine/diagnostics/rt_guard.h>
#include <lt_engine/pitch/bungee_pitch_voice.h>
#include <lt_engine/pitch/bungee_voice_manager.h>
#include <lt_engine/session/session.h>
#include <lt_engine/render/track_renderer.h>
#include <lt_engine/sources/source_manager.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <latch>
#include <string>
#include <thread>
#include <vector>

#if LT_ENGINE_HAVE_BUNGEE

using namespace lt;

namespace {

constexpr int kSR       = test::kFixtureSampleRate;
constexpr int kChannels = 2;
constexpr int kBlock    = 512;

// Canción warpeada con `tracks` pistas: warp es lo que hace que el gestor
// enrole voces, y sin voces este paso no prueba nada.
Session warped_session(int tracks, Frame length) {
    Session session;
    session.id          = "s05";
    session.sample_rate = kSR;

    Song song;
    song.id          = "song05";
    song.start_frame = 0;
    song.end_frame   = length;
    song.bpm         = 120.0;

    Region region;
    region.id              = "region05";
    region.start_frame     = 0;
    region.end_frame       = length;
    region.warp_enabled    = true;
    region.warp_source_bpm = 100.0;   // ratio 1.2
    song.regions.push_back(region);

    for (int i = 0; i < tracks; ++i) {
        const std::string src = "src-" + std::to_string(i);
        session.sources.push_back(Source{src, ""});

        Track track;
        track.id   = "trk-" + std::to_string(i);
        track.kind = TrackKind::Audio;
        track.clips.push_back(Clip{"clip-" + std::to_string(i), src, 0, 0, length});
        song.tracks.push_back(std::move(track));
    }
    session.songs.push_back(std::move(song));
    return session;
}

void register_sources(SourceManager& sm, int tracks, Frame length) {
    for (int i = 0; i < tracks; ++i) {
        const std::string src = "src-" + std::to_string(i);
        sm.register_source(src, "");
        REQUIRE(sm.store_decoded_source(
            src, test::make_stereo_sine(length, 220.0 + 7.0 * i, 0.4f),
            kChannels, kSR, length).is_ok());
    }
}

} // namespace

TEST_CASE("step05: publicar y consumir el mapa de voces desde hilos distintos") {
    constexpr int   kTracks = 4;
    const Frame     length  = static_cast<Frame>(kSR) * 4;

    SourceManager sm;
    register_sources(sm, kTracks, length);
    Session session = warped_session(kTracks, length);

    BungeeVoiceManager voices;
    REQUIRE(voices.prepare(kSR, kChannels, kBlock * 4));
    voices.rebuild_for_session(session, sm, /*playhead=*/0);
    REQUIRE(voices.diagnostics().active_voice_count == kTracks);

    // Un consumidor que hace lo mismo que el hilo de audio: pedir la voz de un
    // clip y quedarse la referencia mientras "renderiza".
    std::atomic<bool>          stop{false};
    std::atomic<std::uint64_t> lookups{0};
    std::latch                 consumer_running{1};
    std::atomic<bool>          saw_null{false};

    std::thread consumer([&] {
        consumer_running.count_down();
        while (!stop.load(std::memory_order_relaxed)) {
            for (int i = 0; i < kTracks; ++i) {
                auto v = voices.voice_for_shared("clip-" + std::to_string(i));
                if (!v) { saw_null.store(true); continue; }
                // Tocar la voz mientras se tiene la referencia: si el
                // productor la hubiera destruido bajo nuestros pies, esto sería
                // un uso tras liberar y ASAN lo cazaría.
                (void)v->is_ready();
                lookups.fetch_add(1, std::memory_order_relaxed);
            }
        }
    });

    consumer_running.wait();

    // Reconstruir el mapa repetidamente mientras el consumidor lo usa.
    for (int r = 0; r < 20; ++r)
        voices.rebuild_for_seek(static_cast<Frame>(r) * kSR / 4, session, sm);

    stop.store(true, std::memory_order_relaxed);
    consumer.join();

    CHECK(lookups.load() > 0);
    CHECK_FALSE(saw_null.load());
    CHECK(voices.diagnostics().active_voice_count == kTracks);
}

TEST_CASE("step05: ninguna voz se destruye en el hilo de audio") {
    constexpr int   kTracks = 4;
    const Frame     length  = static_cast<Frame>(kSR) * 4;

    SourceManager sm;
    register_sources(sm, kTracks, length);
    Session session = warped_session(kTracks, length);

    BungeeVoiceManager voices;
    REQUIRE(voices.prepare(kSR, kChannels, kBlock * 4));
    voices.rebuild_for_session(session, sm, /*playhead=*/0);

    BungeePitchVoice::reset_destroyed_on_audio_thread_count();

    // El orden importa, y es TODO el test.
    //
    // La destrucción peligrosa sólo puede ocurrir si el hilo de audio SIGUE
    // SOSTENIENDO su copia mientras la hebra de control publica un mapa nuevo,
    // y la suelta después. Un bucle que coge las voces y las suelta antes del
    // rebuild nunca llega a ser el último dueño: el mapa saliente muere en la
    // hebra de control y el contador da 0 tanto si el retiro funciona como si
    // no. (Se escribió así primero, y pasaba con el retiro desactivado: no
    // probaba nada.)
    //
    // Aquí se fuerza el entrelazado con latches, sin relojes ni sleeps.
    std::latch audio_holds{1};      // el hilo de audio ya tiene su copia
    std::latch control_published{1};// la hebra de control ya cambió el mapa

    std::thread audio_thread([&] {
        lt::rt::ScopedRealtimeSection in_callback;

        std::vector<std::shared_ptr<BungeePitchVoice>> held;
        held.reserve(kTracks);
        for (int i = 0; i < kTracks; ++i)
            held.push_back(voices.voice_for_shared("clip-" + std::to_string(i)));

        audio_holds.count_down();
        control_published.wait();

        // El mapa viejo ya fue sustituido. Si nadie en la hebra de control lo
        // retuvo, estas copias son las últimas referencias vivas a esas voces,
        // y soltarlas aquí las destruye DENTRO del callback.
        held.clear();
    });

    audio_holds.wait();
    // rebuild_for_seek destruye y reconstruye las voces (Bungee issue #16), así
    // que el mapa nuevo NO comparte objetos con el viejo. Es lo que deja al
    // hilo de audio como único dueño potencial.
    voices.rebuild_for_seek(static_cast<Frame>(kSR), session, sm);
    control_published.count_down();

    audio_thread.join();

    const auto d = voices.diagnostics();
    CHECK_MESSAGE(d.voices_destroyed_on_audio_thread == 0,
                  "se destruyeron " << d.voices_destroyed_on_audio_thread
                  << " voces dentro del callback: el mapa saliente no se está "
                     "reteniendo en la hebra de control");
}

TEST_CASE("step05: el contador sabe distinguir dónde murió la voz") {
    // Contraprueba del test anterior: si el contador no supiera detectar una
    // destrucción en el hilo de audio, aquel test pasaría por no mirar. Aquí se
    // destruye una voz DENTRO de una sección de tiempo real a propósito, y el
    // contador tiene que verlo.
    BungeePitchVoice::reset_destroyed_on_audio_thread_count();
    {
        auto voice = std::make_shared<BungeePitchVoice>();
        REQUIRE(voice->configure(kSR, kChannels, kBlock * 4));
        lt::rt::ScopedRealtimeSection audio_thread;
        voice.reset();   // destrucción dentro del callback
    }
    CHECK(BungeePitchVoice::destroyed_on_audio_thread_count() == 1);

    // Y fuera de la sección no cuenta.
    BungeePitchVoice::reset_destroyed_on_audio_thread_count();
    {
        auto voice = std::make_shared<BungeePitchVoice>();
        REQUIRE(voice->configure(kSR, kChannels, kBlock * 4));
        voice.reset();
    }
    CHECK(BungeePitchVoice::destroyed_on_audio_thread_count() == 0);
}

#endif // LT_ENGINE_HAVE_BUNGEE

TEST_CASE("step05: la salida con warp sigue siendo bit-exacta y determinista") {
    // Qué puede y qué no puede significar la bit-exactitud en ESTE paso.
    //
    // Los pasos 03 y 04 tenían un oráculo natural — el camino de respaldo, que
    // sigue vivo en el código— contra el que comparar. Aquí no lo hay: sólo
    // existe una forma de publicar el mapa, y el cambio sustituye el mecanismo
    // entero. No hay «implementación anterior» que instanciar dentro del test.
    //
    // Lo que sí se puede comprobar, y es el riesgo real de este cambio, es que
    // la publicación no introdujo indeterminismo: una carrera entre el store
    // del mapa y las lecturas del hilo de audio se vería como dos rendes de la
    // misma sesión que no coinciden. Se comparan patrones de bits, sin
    // tolerancia.
    constexpr int   kTracks = 4;
    constexpr int   kBlocks = 200;
    const Frame     length  = static_cast<Frame>(kBlock) * (kBlocks + 32);

    auto render_all = [&](std::vector<float>& out) {
        SourceManager sm;
        register_sources(sm, kTracks, length);
        Session session = warped_session(kTracks, length);

        BungeeVoiceManager voices;
        REQUIRE(voices.prepare(kSR, kChannels, kBlock * 4));
        voices.rebuild_for_session(session, sm, /*playhead=*/0);

        TrackRenderer renderer;
        renderer.prepare(kBlock);

        std::vector<float> l(kBlock, 0.0f), r(kBlock, 0.0f);
        float* buf[2] = { l.data(), r.data() };

        out.clear();
        out.reserve(static_cast<std::size_t>(kBlocks) * kBlock * 2);
        const Song& song = session.songs[0];
        for (int b = 0; b < kBlocks; ++b) {
            std::fill(l.begin(), l.end(), 0.0f);
            std::fill(r.begin(), r.end(), 0.0f);
            for (const Track& t : song.tracks)
                renderer.render(t, static_cast<Frame>(b) * kBlock, kBlock,
                                buf, 2, sm, &voices, kSR, 0, &song);
            out.insert(out.end(), l.begin(), l.end());
            out.insert(out.end(), r.begin(), r.end());
        }
    };

    std::vector<float> a, b;
    render_all(a);
    render_all(b);

    REQUIRE(a.size() == b.size());
    REQUIRE(a.size() > 0);
    std::size_t diffs = 0;
    for (std::size_t i = 0; i < a.size(); ++i)
        if (!(a[i] == b[i])) ++diffs;   // igualdad exacta, sin epsilon
    CHECK_MESSAGE(diffs == 0,
                  diffs << " muestras de " << a.size() << " difieren entre dos "
                  "rendes idénticos: la publicación del mapa introdujo "
                  "indeterminismo");

    // Y que no era silencio, que si no la comparación es trivial.
    float peak = 0.0f;
    for (float s : a) peak = std::max(peak, std::abs(s));
    CHECK(peak > 0.001f);
}
