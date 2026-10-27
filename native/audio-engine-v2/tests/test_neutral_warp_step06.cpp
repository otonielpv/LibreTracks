// Paso 06 — no invocar a Bungee cuando el warp es la identidad.
//
// El criterio central es C3: el bypass sólo vale si lo que suena es EXACTAMENTE
// lo mismo que sonaría sin warp. Todo lo demás de este paso es contabilidad;
// eso es la prueba.
//
// El riesgo del paso no es el bypass en sí, es que las dos mitades de la
// decisión dejen de coincidir. `resolve_pitch_render_decision` elige el camino
// y `enumerate_voices` decide si enrola voz: si una dice Stretched y la otra no
// enrola, `render_path_stretched` devuelve silencio y la pista desaparece. Por
// eso ambas llaman a `is_neutral_warp` y por eso los tests de transición en
// caliente (C6/C7) existen.

#include "test_audio_fixtures.h"

#include <doctest/doctest.h>
#include <lt_engine/pitch/bungee_voice_manager.h>
#include <lt_engine/pitch/prearmed_jump_manager.h>
#include <lt_engine/render/pitch_resolution.h>
#include <lt_engine/render/track_renderer.h>
#include <lt_engine/session/session.h>
#include <lt_engine/sources/source_manager.h>

#include <algorithm>
#include <cmath>
#include <string>
#include <vector>

using namespace lt;

namespace {

constexpr int kSR       = test::kFixtureSampleRate;
constexpr int kChannels = 2;
constexpr int kBlock    = 512;

struct SessionOpts {
    bool      warp        = true;
    double    source_bpm  = 120.0;   // igual a song.bpm ⇒ ratio 1.0
    Semitones region_semis = 0;
    TransposeBehavior behavior = TransposeBehavior::FollowsSongOrRegion;
};

Session make_session(const SessionOpts& o, Frame length) {
    Session s;
    s.id = "s06";
    s.sample_rate = kSR;

    Song song;
    song.id = "song06";
    song.start_frame = 0;
    song.end_frame = length;
    song.bpm = 120.0;

    Region region;
    region.id = "region06";
    region.start_frame = 0;
    region.end_frame = length;
    region.transpose_semitones = o.region_semis;
    if (o.warp) {
        region.warp_enabled = true;
        region.warp_source_bpm = o.source_bpm;
    }
    song.regions.push_back(region);

    s.sources.push_back(Source{"src", ""});
    Track t;
    t.id = "trk";
    t.kind = TrackKind::Audio;
    t.transpose_behavior = o.behavior;
    t.clips.push_back(Clip{"clip", "src", 0, 0, length});
    song.tracks.push_back(std::move(t));

    s.songs.push_back(std::move(song));
    return s;
}

void add_source(SourceManager& sm, Frame length) {
    sm.register_source("src", "");
    REQUIRE(sm.store_decoded_source(
        "src", test::make_stereo_sine(length, 330.0, 0.5f),
        kChannels, kSR, length).is_ok());
}

// Renderiza `blocks` bloques y devuelve el intercalado estéreo.
std::vector<float> render(const SessionOpts& o, int blocks) {
    const Frame length = static_cast<Frame>(kBlock) * (blocks + 32);
    SourceManager sm;
    add_source(sm, length);
    Session session = make_session(o, length);

    BungeeVoiceManager voices;
#if LT_ENGINE_HAVE_BUNGEE
    REQUIRE(voices.prepare(kSR, kChannels, kBlock * 4));
#endif
    voices.rebuild_for_session(session, sm, /*playhead=*/0);

    TrackRenderer renderer;
    renderer.prepare(kBlock);

    std::vector<float> l(kBlock, 0.0f), r(kBlock, 0.0f);
    float* buf[2] = { l.data(), r.data() };

    std::vector<float> out;
    out.reserve(static_cast<std::size_t>(blocks) * kBlock * 2);
    const Song& song = session.songs[0];
    for (int b = 0; b < blocks; ++b) {
        std::fill(l.begin(), l.end(), 0.0f);
        std::fill(r.begin(), r.end(), 0.0f);
        renderer.render(song.tracks[0], static_cast<Frame>(b) * kBlock, kBlock,
                        buf, 2, sm, &voices, kSR, 0, &song);
        out.insert(out.end(), l.begin(), l.end());
        out.insert(out.end(), r.begin(), r.end());
    }
    return out;
}

int voices_for(const SessionOpts& o) {
    const Frame length = static_cast<Frame>(kSR) * 4;
    SourceManager sm;
    add_source(sm, length);
    Session session = make_session(o, length);
    BungeeVoiceManager voices;
#if LT_ENGINE_HAVE_BUNGEE
    REQUIRE(voices.prepare(kSR, kChannels, kBlock * 4));
#endif
    voices.rebuild_for_session(session, sm, /*playhead=*/0);
    return voices.diagnostics().active_voice_count;
}

} // namespace

TEST_CASE("step06 C2: warp con ratio 1.0 y sin transposición no enrola voz") {
    SessionOpts neutro;   // ratio 1.0, 0 semitonos
    const Frame length = static_cast<Frame>(kSR);
    Session s = make_session(neutro, length);
    const Track& t = s.songs[0].tracks[0];
    const Clip&  c = t.clips[0];

    CHECK(is_neutral_warp(t, c, s.songs[0], 0));
    CHECK(resolve_pitch_render_decision(t, c, s.songs[0], 0).path
          == ClipPathKind::Direct);
    CHECK(voices_for(neutro) == 0);
}

TEST_CASE("step06 C3: el bypass suena EXACTAMENTE igual que no tener warp") {
    // El criterio del paso. Si esto no es bit-exacto, el bypass no vale.
    constexpr int kBlocks = 200;

    SessionOpts neutro;                    // warp on, ratio 1.0, 0 semitonos
    SessionOpts sin_warp;  sin_warp.warp = false;

    const auto con = render(neutro, kBlocks);
    const auto sin = render(sin_warp, kBlocks);

    REQUIRE(con.size() == sin.size());
    REQUIRE(con.size() > 0);

    std::size_t diffs = 0;
    for (std::size_t i = 0; i < con.size(); ++i)
        if (!(con[i] == sin[i])) ++diffs;   // igualdad exacta, sin epsilon
    CHECK_MESSAGE(diffs == 0,
                  diffs << " muestras de " << con.size() << " difieren entre "
                  "warp-neutro y sin-warp");

    float peak = 0.0f;
    for (float s : con) peak = std::max(peak, std::abs(s));
    CHECK_MESSAGE(peak > 0.01f, "la comparación sería trivial si fuera silencio");
}

TEST_CASE("step06 C4: neutro en ratio pero con transposición SÍ necesita voz") {
    SessionOpts transpuesto;
    transpuesto.region_semis = 3;          // ratio 1.0 pero +3 semitonos
    const Frame length = static_cast<Frame>(kSR);
    Session s = make_session(transpuesto, length);
    const Track& t = s.songs[0].tracks[0];

    CHECK_FALSE(is_neutral_warp(t, t.clips[0], s.songs[0], 0));
    CHECK(resolve_pitch_render_decision(t, t.clips[0], s.songs[0], 0).path
          == ClipPathKind::Stretched);
#if LT_ENGINE_HAVE_BUNGEE
    CHECK(voices_for(transpuesto) == 1);
#endif
}

TEST_CASE("step06 C5: ratio distinto de 1.0 sigue necesitando voz") {
    for (double src_bpm : {100.0, 150.0}) {   // ratios 1.2 y 0.8
        SessionOpts warpeado;
        warpeado.source_bpm = src_bpm;
        const Frame length = static_cast<Frame>(kSR);
        Session s = make_session(warpeado, length);
        const Track& t = s.songs[0].tracks[0];

        CAPTURE(src_bpm);
        CHECK_FALSE(is_neutral_warp(t, t.clips[0], s.songs[0], 0));
        CHECK(resolve_pitch_render_decision(t, t.clips[0], s.songs[0], 0).path
              == ClipPathKind::Stretched);
#if LT_ENGINE_HAVE_BUNGEE
        CHECK(voices_for(warpeado) == 1);
#endif
    }
}

TEST_CASE("step06: NeverTranspose con ratio 1.0 también es neutro") {
    // El caso fácil de pasar por alto: una pista «no transponer» con warp ya
    // ignora los semitonos, así que con ratio 1.0 no le queda nada que hacer a
    // Bungee. Antes pagaba la voz entera para copiar el audio tal cual.
    SessionOpts nt;
    nt.behavior = TransposeBehavior::NeverTranspose;
    nt.region_semis = 7;                   // la región transpone, la pista no
    const Frame length = static_cast<Frame>(kSR);
    Session s = make_session(nt, length);
    const Track& t = s.songs[0].tracks[0];

    CHECK(is_neutral_warp(t, t.clips[0], s.songs[0], 0));
    CHECK(resolve_pitch_render_decision(t, t.clips[0], s.songs[0], 0).path
          == ClipPathKind::Direct);
    CHECK(voices_for(nt) == 0);
}

TEST_CASE("step06 C6/C7: las dos mitades de la decisión no pueden discrepar") {
    // La invariante que impide el fallo por silencio: para CUALQUIER
    // combinación, "el renderer pide Stretched" y "el gestor enrola voz" tienen
    // que coincidir. Si no, render_path_stretched devuelve silencio.
    //
    // Cubre a la vez la transición en caliente de C6/C7: cambiar la
    // transposición de la región es exactamente moverse entre estas filas, y lo
    // que hay que garantizar es que en ambas los dos lados están de acuerdo.
#if !LT_ENGINE_HAVE_BUNGEE
    return;
#endif
    for (bool warp : {true, false}) {
        for (double src_bpm : {120.0, 100.0}) {
            for (Semitones semis : {Semitones{0}, Semitones{2}}) {
                for (auto behavior : {TransposeBehavior::FollowsSongOrRegion,
                                      TransposeBehavior::NeverTranspose}) {
                    SessionOpts o;
                    o.warp = warp;
                    o.source_bpm = src_bpm;
                    o.region_semis = semis;
                    o.behavior = behavior;

                    const Frame length = static_cast<Frame>(kSR);
                    Session s = make_session(o, length);
                    const Track& t = s.songs[0].tracks[0];
                    const auto d =
                        resolve_pitch_render_decision(t, t.clips[0], s.songs[0], 0);

                    CAPTURE(warp);
                    CAPTURE(src_bpm);
                    CAPTURE(semis);
                    CAPTURE(static_cast<int>(behavior));

                    const bool renderer_pide_voz =
                        (d.path == ClipPathKind::Stretched);
                    const bool gestor_enrola_voz = voices_for(o) == 1;
                    CHECK_MESSAGE(renderer_pide_voz == gestor_enrola_voz,
                                  "el renderer y el gestor de voces discrepan: "
                                  "la pista sonaría en silencio");
                }
            }

        }
    }
}

TEST_CASE("neutral warp before a transposed region keeps instruments audible after Vamp") {
#if !LT_ENGINE_HAVE_BUNGEE
    return;
#endif
    constexpr Frame length = kSR * 4;
    constexpr Frame boundary = kSR;
    SourceManager sources;
    add_source(sources, length);
    auto session = make_session(SessionOpts{}, length);
    auto& song = session.songs[0];
    song.regions[0].end_frame = boundary;
    Region transposed = song.regions[0];
    transposed.id = "transposed";
    transposed.start_frame = boundary;
    transposed.end_frame = length;
    transposed.transpose_semitones = -2;
    song.regions.push_back(transposed);

    Track guide = song.tracks[0];
    guide.id = "guide";
    guide.clips[0].id = "guide-clip";
    guide.transpose_behavior = TransposeBehavior::NeverTranspose;
    song.tracks.push_back(guide);

    BungeeVoiceManager voices;
    REQUIRE(voices.prepare(kSR, kChannels, kBlock * 4));
    SUBCASE("session load") {
        voices.rebuild_for_session(session, sources, 0);
    }
    SUBCASE("seek into the neutral region") {
        voices.publish_prepared_voice_map_realtime(
            voices.build_seek_voice_map(0, session, sources));
    }
    SUBCASE("committed region edit") {
        voices.retime_existing_for_session(session, sources, 0, false);
    }
    SUBCASE("prepared Vamp wrap into the neutral region") {
        PrearmedJumpManager prearm;
        REQUIRE(prearm.prepare(kSR, kChannels, kBlock * 4));
        auto prepared = prearm.prepare_target_now(
            session, sources, PrearmTargetKind::VampStart,
            song.id, "__lt_vamp__:0", 0, 1);
        REQUIRE(prepared);
        REQUIRE(prepared->valid);
        CHECK(prepared->tracks.empty());
        voices.swap_in_prepared_voices(prepared->extract_voice_map());
        voices.enroll_missing_voices(session, sources, 0);
    }

    CHECK(voices.voice_for("clip") != nullptr);
    CHECK(voices.voice_for("guide-clip") == nullptr);
    CHECK(voices.diagnostics().active_voice_count == 1);

    TrackRenderer::reset_diagnostics();
    for (const auto& track : song.tracks) {
        TrackRenderer renderer;
        renderer.prepare(kBlock);
        constexpr int blocks = 48;
        std::vector<float> output;
        std::vector<float> l(kBlock), r(kBlock);
        float* buf[] = {l.data(), r.data()};
        for (int b = 0; b < blocks; ++b) {
            std::fill(l.begin(), l.end(), 0.0f);
            std::fill(r.begin(), r.end(), 0.0f);
            renderer.render(track, boundary + b * kBlock, kBlock,
                            buf, kChannels, sources, &voices, kSR, 0, &song);
            for (int f = 0; f < kBlock; ++f) {
                output.push_back(l[f]);
                output.push_back(r[f]);
            }
        }
        constexpr Frame skip = kBlock * 16;
        double energy = 0.0;
        for (std::size_t i = skip * kChannels; i < output.size(); ++i)
            energy += static_cast<double>(output[i]) * output[i];
        const double rms = std::sqrt(
            energy / (output.size() - skip * kChannels));
        CAPTURE(track.id);
        CHECK(rms > 0.05);
        const double expected_hz = track.id == "guide"
            ? 330.0 : 330.0 * std::pow(2.0, -2.0 / 12.0);
        const double actual_hz = test::estimate_frequency_hz(
            output, kSR, skip, blocks * kBlock - skip);
        CHECK(actual_hz == doctest::Approx(expected_hz).epsilon(0.01));
    }
    CHECK(TrackRenderer::diagnostics().pitch_missing_stream_silence_count == 0);
}
