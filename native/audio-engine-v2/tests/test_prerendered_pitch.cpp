// Cambio de tono preparado: un clip con `prerendered` ya trae el tono y el
// warp de su región renderizados en la fuente, así que el motor tiene que
// copiarlo tal cual (Direct) y no gastar una voz Bungee en él.
//
// Mismo riesgo que el warp neutro (test_neutral_warp_step06.cpp): si
// resolve_pitch_render_decision dijera Stretched y enumerate_voices no
// enrolara voz, la pista sonaría en silencio. Por eso se comprueban las dos
// mitades y lo que suena.

#include "test_audio_fixtures.h"

#include <doctest/doctest.h>
#include <lt_engine/core/commands.h>
#include <lt_engine/pitch/bungee_voice_manager.h>
#include <lt_engine/render/pitch_resolution.h>
#include <lt_engine/render/track_renderer.h>
#include <lt_engine/session/session.h>
#include <lt_engine/sources/source_manager.h>

#include <algorithm>
#include <cmath>
#include <vector>

using namespace lt;

namespace {

constexpr int kSR       = test::kFixtureSampleRate;
constexpr int kChannels = 2;
constexpr int kBlock    = 512;

struct Opts {
    bool      warp         = true;
    double    source_bpm   = 100.0;   // song.bpm 120 ⇒ ratio 1.2
    Semitones region_semis = 3;
    bool      prerendered  = true;
};

Session make_session(const Opts& o, Frame length) {
    Session s;
    s.id = "spre";
    s.sample_rate = kSR;

    Song song;
    song.id = "song";
    song.start_frame = 0;
    song.end_frame = length;
    song.bpm = 120.0;

    Region region;
    region.id = "region";
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
    Clip clip{"clip", "src", 0, 0, length};
    clip.prerendered = o.prerendered;
    t.clips.push_back(clip);
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

std::vector<float> render(const Opts& o, int blocks, int* voice_count = nullptr) {
    const Frame length = static_cast<Frame>(kBlock) * (blocks + 32);
    SourceManager sm;
    add_source(sm, length);
    Session session = make_session(o, length);

    BungeeVoiceManager voices;
#if LT_ENGINE_HAVE_BUNGEE
    REQUIRE(voices.prepare(kSR, kChannels, kBlock * 4));
#endif
    voices.rebuild_for_session(session, sm, /*playhead=*/0);
    if (voice_count) *voice_count = voices.diagnostics().active_voice_count;

    TrackRenderer renderer;
    renderer.prepare(kBlock);

    std::vector<float> l(kBlock, 0.0f), r(kBlock, 0.0f);
    float* buf[2] = { l.data(), r.data() };
    std::vector<float> out;
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

} // namespace

TEST_CASE("prerendered: un clip preparado va por Direct y no enrola voz") {
    Opts preparado;
    const Frame length = static_cast<Frame>(kSR);
    Session s = make_session(preparado, length);
    const Track& t = s.songs[0].tracks[0];
    const Clip&  c = t.clips[0];

    const auto d = resolve_pitch_render_decision(t, c, s.songs[0], 0);
    CHECK(d.path == ClipPathKind::Direct);
    CHECK_FALSE(d.warp_active);
    CHECK(d.effective_semitones == 0);
    CHECK(is_neutral_warp(t, c, s.songs[0], 0));

    int voices = -1;
    render(preparado, 4, &voices);
    CHECK(voices == 0);
}

TEST_CASE("prerendered: sin la marca, el mismo clip sí necesita Bungee") {
    // Guarda contra un test que pase por accidente: la sesión de arriba, sin
    // `prerendered`, es un caso Stretched normal.
    Opts vivo;
    vivo.prerendered = false;
    const Frame length = static_cast<Frame>(kSR);
    Session s = make_session(vivo, length);
    const Track& t = s.songs[0].tracks[0];
    CHECK(resolve_pitch_render_decision(t, t.clips[0], s.songs[0], 0).path
          == ClipPathKind::Stretched);
#if LT_ENGINE_HAVE_BUNGEE
    int voices = -1;
    render(vivo, 4, &voices);
    CHECK(voices == 1);
#endif
}

TEST_CASE("prerendered: suena exactamente como la fuente sin warp ni tono") {
    constexpr int kBlocks = 200;
    Opts preparado;
    Opts plano;
    plano.warp = false;
    plano.region_semis = 0;
    plano.prerendered = false;

    const auto a = render(preparado, kBlocks);
    const auto b = render(plano, kBlocks);
    REQUIRE(a.size() == b.size());

    std::size_t diffs = 0;
    for (std::size_t i = 0; i < a.size(); ++i)
        if (!(a[i] == b[i])) ++diffs;
    CHECK_MESSAGE(diffs == 0, diffs << " muestras difieren");

    float peak = 0.0f;
    for (float x : a) peak = std::max(peak, std::abs(x));
    CHECK_MESSAGE(peak > 0.01f, "comparar silencio no prueba nada");
}

TEST_CASE("prerendered: la marca viaja en SetSongTimelineWindow") {
    auto cmd = command_from_json(R"({
        "type":"SetSongTimelineWindow",
        "song_id":"song1",
        "clips":[
          {"id":"a","track_id":"t","source_id":"x","timeline_start_frame":0,
           "source_start_frame":0,"length_frames":10,"prerendered":true},
          {"id":"b","track_id":"t","source_id":"y","timeline_start_frame":0,
           "source_start_frame":0,"length_frames":10}],
        "regions":[],"markers":[],
        "bpm":120.0,"beats_per_bar":4,"beat_unit":4,
        "tempo_markers":[],"time_signature_markers":[]
    })");
    REQUIRE(std::holds_alternative<CmdSetSongTimelineWindow>(cmd));
    const auto& c = std::get<CmdSetSongTimelineWindow>(cmd);
    REQUIRE(c.clips.size() == 2);
    CHECK(c.clips[0].prerendered);
    CHECK_FALSE(c.clips[1].prerendered);   // ausente = sesiones y Rust viejos
}
