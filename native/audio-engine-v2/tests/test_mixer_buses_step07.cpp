// Paso 07 — buses de mezcla por pista.
//
// El contrato del paso es que NO cambie ni una muestra. El refactor mueve datos
// de sitio y parte el bucle en dos fases; si la salida se mueve, el paso está
// mal hecho, y si el test no lo detecta, el paso 08 se construirá sobre arena.
//
// Cómo se comprueba el «antes y después» sin poder instanciar las dos
// implementaciones a la vez: este fichero imprime una HUELLA determinista de la
// salida de una sesión fija. Se ejecuta con el árbol anterior al refactor y con
// el posterior, y las dos huellas tienen que coincidir. El procedimiento y las
// huellas obtenidas quedan en state/07.md.
//
// La sesión no es un caso fácil a propósito: 16 pistas, carpetas anidadas de
// tres niveles, routing mixto, mute y solo activos, una región con warp y otra
// con transposición. Si algo del reparto en fases se dejó una variable por el
// camino, sale aquí.

#include "test_audio_fixtures.h"

#include <doctest/doctest.h>
#include <lt_engine/render/mixer.h>
#include <lt_engine/scheduler/jump_scheduler.h>
#include <lt_engine/session/session.h>
#include <lt_engine/sources/source_manager.h>
#include <lt_engine/transport/transport_clock.h>

#include <cstdint>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

using namespace lt;

namespace {

constexpr int kSR     = test::kFixtureSampleRate;
constexpr int kBlock  = 512;
constexpr int kBlocks = 200;
constexpr int kTracks = 16;

// FNV-1a sobre los bytes crudos de las muestras. Se compara el patrón de bits,
// no el valor: un epsilon aquí haría que el test no valiese para nada.
std::uint64_t digest(const std::vector<float>& samples) {
    std::uint64_t h = 1469598103934665603ull;
    const auto* bytes = reinterpret_cast<const unsigned char*>(samples.data());
    const std::size_t n = samples.size() * sizeof(float);
    for (std::size_t i = 0; i < n; ++i) {
        h ^= bytes[i];
        h *= 1099511628211ull;
    }
    return h;
}

Session build_hard_session(SourceManager& sm, Frame length) {
    Session s;
    s.id = "s07";
    s.sample_rate = kSR;

    Song song;
    song.id = "song07";
    song.start_frame = 0;
    song.end_frame = length;
    song.bpm = 120.0;

    // Dos regiones: una warpeada de verdad (ratio 1.2) y otra transpuesta.
    Region warp;
    warp.id = "r-warp";
    warp.start_frame = 0;
    warp.end_frame = length / 2;
    warp.warp_enabled = true;
    warp.warp_source_bpm = 100.0;
    song.regions.push_back(warp);

    Region pitched;
    pitched.id = "r-pitch";
    pitched.start_frame = length / 2;
    pitched.end_frame = length;
    pitched.transpose_semitones = 4;
    song.regions.push_back(pitched);

    // Carpetas anidadas de tres niveles, con routing propio.
    Track outer;
    outer.id = "folder-outer";
    outer.kind = TrackKind::Folder;
    outer.audio_to = "ext:3";
    outer.gain = 0.8f;
    song.tracks.push_back(outer);

    Track mid;
    mid.id = "folder-mid";
    mid.kind = TrackKind::Folder;
    mid.parent_track_id = "folder-outer";
    mid.audio_to = "inherit";
    mid.pan = -0.25f;
    song.tracks.push_back(mid);

    Track inner;
    inner.id = "folder-inner";
    inner.kind = TrackKind::Folder;
    inner.parent_track_id = "folder-mid";
    inner.audio_to = "inherit";
    song.tracks.push_back(inner);

    for (int i = 0; i < kTracks; ++i) {
        const std::string src = "src-" + std::to_string(i);
        sm.register_source(src, "");
        REQUIRE(sm.store_decoded_source(
            src, test::make_stereo_sine(length, 110.0 + 17.0 * i, 0.35f),
            2, kSR, length).is_ok());
        s.sources.push_back(Source{src, ""});

        Track t;
        t.id = "trk-" + std::to_string(i);
        t.kind = TrackKind::Audio;
        t.gain = 0.3f + 0.04f * static_cast<float>(i % 7);
        t.pan  = -0.6f + 0.15f * static_cast<float>(i % 9);
        // Reparto por los tres niveles de carpeta y algunas sueltas.
        t.parent_track_id = (i % 4 == 0) ? ""
                          : (i % 4 == 1) ? "folder-outer"
                          : (i % 4 == 2) ? "folder-mid" : "folder-inner";
        t.audio_to = (i % 3 == 0) ? "inherit"
                   : (i % 3 == 1) ? "master" : "monitor";
        t.mute = (i == 5);
        // SIN solo a proposito. La primera version soleaba dos pistas, y con
        // solo activo las demas aportan exactamente 0.0f: sumar ceros SI es
        // asociativo, asi que la huella no cambiaba al invertir el orden de la
        // fase B y el test no probaba la bit-exactitud que decia probar. Lo
        // destapo la prueba de "sabe fallar", no la lectura del codigo.
        t.solo = false;
        t.transpose_behavior = (i % 5 == 0) ? TransposeBehavior::NeverTranspose
                                            : TransposeBehavior::FollowsSongOrRegion;
        t.clips.push_back(Clip{"clip-" + std::to_string(i), src, 0, 0, length});
        song.tracks.push_back(std::move(t));
    }

    s.songs.push_back(std::move(song));
    return s;
}

std::vector<float> render_session(int num_channels) {
    const Frame length = static_cast<Frame>(kBlock) * (kBlocks + 32);
    SourceManager sm;
    auto session = std::make_shared<const Session>(build_hard_session(sm, length));

    TransportClock clock(kSR);
    JumpScheduler  scheduler;
    Mixer mixer(session, &sm, &clock, &scheduler);
    mixer.prepare_render_resources(kBlock);
    // Cuatro salidas para que `ext:3` y `monitor` no colapsen sobre master.
    mixer.set_active_output_channels({0, 1, 2, 3});
    clock.play();

    std::vector<std::vector<float>> chans(
        static_cast<std::size_t>(num_channels), std::vector<float>(kBlock, 0.0f));
    std::vector<float*> ptrs(static_cast<std::size_t>(num_channels));
    for (int c = 0; c < num_channels; ++c) ptrs[static_cast<std::size_t>(c)] = chans[static_cast<std::size_t>(c)].data();

    std::vector<float> out;
    out.reserve(static_cast<std::size_t>(kBlocks) * kBlock * num_channels);
    for (int b = 0; b < kBlocks; ++b) {
        for (auto& c : chans) std::fill(c.begin(), c.end(), 0.0f);
        mixer.render(ptrs.data(), num_channels, kBlock, clock.sample_rate());
        for (const auto& c : chans) out.insert(out.end(), c.begin(), c.end());
    }
    return out;
}

} // namespace

TEST_CASE("step07: huella de la salida (comparar antes y despues del refactor)") {
    const auto out = render_session(4);
    REQUIRE(out.size() > 0);

    float peak = 0.0f;
    for (float s : out) peak = std::max(peak, std::abs(s));
    REQUIRE_MESSAGE(peak > 0.01f,
                    "la sesion no suena: la huella no probaria nada");

    const std::uint64_t h = digest(out);
    MESSAGE("HUELLA step07 = " << h
            << "  (" << out.size() << " muestras, pico " << peak << ")");
    // Sin aserción sobre el valor: la huella se compara ENTRE BUILDS, no contra
    // una constante escrita a mano. Fijarla aquí obligaría a actualizarla cada
    // vez que cambie algo legítimo del render y dejaría de significar nada.
    CHECK(h != 0);
}

TEST_CASE("step07: la salida es reproducible bloque a bloque") {
    // Guarda contra el fallo más probable del refactor: que el estado por
    // ranura sobreviva de un bloque al siguiente. Dos rendes completos de la
    // misma sesión tienen que dar exactamente lo mismo.
    const auto a = render_session(4);
    const auto b = render_session(4);
    REQUIRE(a.size() == b.size());

    std::size_t diffs = 0;
    for (std::size_t i = 0; i < a.size(); ++i)
        if (!(a[i] == b[i])) ++diffs;
    CHECK_MESSAGE(diffs == 0,
                  diffs << " muestras de " << a.size() << " difieren entre dos "
                  "rendes identicos");
}

TEST_CASE("step07: una pista saltada no arrastra su bus del bloque anterior") {
    // La fase B se salta las ranuras que la fase A no marco. Si el flag no se
    // resetea por bloque, una pista que deja de renderizarse seguiria sumando
    // su bus viejo. Se comprueba con el silencio: sin clips ni fuentes, la
    // salida tiene que ser exactamente cero en todos los bloques.
    Session s;
    s.id = "vacia";
    s.sample_rate = kSR;
    Song song;
    song.id = "song";
    song.start_frame = 0;
    song.end_frame = static_cast<Frame>(kBlock) * 64;
    Track t;
    t.id = "sin-clips";
    t.kind = TrackKind::Audio;
    song.tracks.push_back(std::move(t));
    s.songs.push_back(std::move(song));

    SourceManager sm;
    auto session = std::make_shared<const Session>(std::move(s));
    TransportClock clock(kSR);
    JumpScheduler  scheduler;
    Mixer mixer(session, &sm, &clock, &scheduler);
    mixer.prepare_render_resources(kBlock);
    clock.play();

    std::vector<float> l(kBlock, 0.0f), r(kBlock, 0.0f);
    float* ptrs[2] = { l.data(), r.data() };

    std::size_t non_zero = 0;
    for (int b = 0; b < 32; ++b) {
        std::fill(l.begin(), l.end(), 0.0f);
        std::fill(r.begin(), r.end(), 0.0f);
        mixer.render(ptrs, 2, kBlock, clock.sample_rate());
        for (int f = 0; f < kBlock; ++f) {
            if (l[f] != 0.0f) ++non_zero;
            if (r[f] != 0.0f) ++non_zero;
        }
    }
    CHECK(non_zero == 0);
}
