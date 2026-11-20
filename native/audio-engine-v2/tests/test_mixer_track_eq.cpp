// Plan track-eq, paso 03: el EQ por pista en el mezclador en vivo.
//
// Se mide en muestras y frames. Lo que se compara "bit a bit" se compara con
// igualdad exacta de flotantes, sin epsilon.

#include "test_audio_fixtures.h"

#include <doctest/doctest.h>
#include <lt_engine/core/commands.h>
#include <lt_engine/diagnostics/rt_guard.h>
#include <lt_engine/pitch/bungee_voice_manager.h>
#include <lt_engine/render/mixer.h>
#include <lt_engine/scheduler/jump_scheduler.h>
#include <lt_engine/session/session.h>
#include <lt_engine/sources/source_manager.h>
#include <lt_engine/transport/transport_clock.h>

#include <algorithm>
#include <cmath>
#include <memory>
#include <string>
#include <vector>

using namespace lt;

#ifndef LT_ENGINE_HAVE_BUNGEE
#define LT_ENGINE_HAVE_BUNGEE 0
#endif

namespace {

constexpr int kSR = test::kFixtureSampleRate;
constexpr int kBlock = 512;

TrackEqParams peak_eq(float hz, float gain_db, float q) {
    TrackEqParams params;
    params.enabled = true;
    params.band_count = 1;
    params.bands[0] = TrackEqBandParams{ true, EqBandKind::Peak, hz, gain_db, q, 12 };
    return params;
}

// Fuente estéreo intercalada: `first` durante `split` frames y `second` después.
std::vector<float> two_part_sine(Frame frames, Frame split, double first_hz, double second_hz,
                                 float amplitude) {
    auto a = test::make_stereo_sine(frames, first_hz, amplitude);
    const auto b = test::make_stereo_sine(frames, second_hz, amplitude);
    for (Frame f = split; f < frames; ++f) {
        a[static_cast<std::size_t>(f) * 2] = b[static_cast<std::size_t>(f) * 2];
        a[static_cast<std::size_t>(f) * 2 + 1] = b[static_cast<std::size_t>(f) * 2 + 1];
    }
    return a;
}

struct Rig {
    SourceManager sources;
    TransportClock clock{ kSR };
    JumpScheduler scheduler;
    std::shared_ptr<const Session> session;
    std::unique_ptr<Mixer> mixer;

    void start(Session s) {
        session = std::make_shared<const Session>(std::move(s));
        mixer = std::make_unique<Mixer>(session, &sources, &clock, &scheduler);
        mixer->prepare_render_resources(kBlock);
        mixer->set_active_output_channels({ 0, 1 });
        clock.play();
        clock.clear_pending_start();
    }

    void add_source(const Id& id, std::vector<float> interleaved, Frame frames) {
        sources.register_source(id, "");
        REQUIRE(sources.store_decoded_source(id, std::move(interleaved), 2, kSR, frames).is_ok());
    }

    // Renderiza `blocks` bloques y devuelve el canal izquierdo concatenado.
    template <typename OnBlock>
    std::vector<float> render(int blocks, OnBlock on_block) {
        std::vector<float> left(kBlock), right(kBlock), out;
        float* channels[2] = { left.data(), right.data() };
        for (int b = 0; b < blocks; ++b) {
            on_block(b);
            std::fill(left.begin(), left.end(), 0.0f);
            std::fill(right.begin(), right.end(), 0.0f);
            mixer->render(channels, 2, kBlock, clock.sample_rate());
            out.insert(out.end(), left.begin(), left.end());
        }
        return out;
    }
    std::vector<float> render(int blocks) { return render(blocks, [](int) {}); }
};

Session single_track_session(Frame frames, std::optional<TrackEqParams> eq,
                             const Id& source = "src") {
    Session session;
    session.id = "eq-session";
    session.sample_rate = kSR;
    session.sources.push_back(Source{ source, "" });
    Song song;
    song.id = "song";
    song.start_frame = 0;
    song.end_frame = frames;
    Track track;
    track.id = "track";
    track.eq = eq;
    track.clips.push_back(Clip{ "clip", source, 0, 0, frames });
    song.tracks.push_back(std::move(track));
    session.songs.push_back(std::move(song));
    return session;
}

double rms(const std::vector<float>& v, std::size_t from, std::size_t to) {
    double sum = 0.0;
    for (std::size_t i = from; i < to; ++i) sum += static_cast<double>(v[i]) * v[i];
    return std::sqrt(sum / static_cast<double>(to - from));
}

float max_step(const std::vector<float>& v, std::size_t from = 1) {
    float worst = 0.0f;
    for (std::size_t i = std::max<std::size_t>(1, from); i < v.size(); ++i)
        worst = std::max(worst, std::abs(v[i] - v[i - 1]));
    return worst;
}

std::size_t count_diffs(const std::vector<float>& a, const std::vector<float>& b) {
    REQUIRE(a.size() == b.size());
    std::size_t diffs = 0;
    for (std::size_t i = 0; i < a.size(); ++i)
        if (!(a[i] == b[i])) ++diffs;
    return diffs;
}

} // namespace

TEST_CASE("mixer eq C1: a +6 dB peak at 1 kHz lifts a 1 kHz track by 6 dB") {
    constexpr Frame kFrames = kSR * 2;
    constexpr int kBlocks = 150;
    auto render_once = [&](std::optional<TrackEqParams> eq) {
        Rig rig;
        rig.add_source("src", test::make_stereo_sine(kFrames, 1000.0, 0.2f), kFrames);
        rig.start(single_track_session(kFrames, eq));
        return rig.render(kBlocks);
    };
    const auto dry = render_once(std::nullopt);
    const auto wet = render_once(peak_eq(1000.0f, 6.0f, 1.0f));
    const std::size_t from = static_cast<std::size_t>(kBlock) * 50;
    const double gain_db = 20.0 * std::log10(rms(wet, from, wet.size()) / rms(dry, from, dry.size()));
    CAPTURE(gain_db);
    CHECK(std::abs(gain_db - 6.0) < 0.1);
}

TEST_CASE("mixer eq C2: tracks without eq, or with eq switched off, are bit-identical") {
    constexpr Frame kFrames = kSR * 2;
    auto render_once = [&](std::optional<TrackEqParams> eq) {
        Rig rig;
        rig.add_source("src", test::make_stereo_sine(kFrames, 523.25, 0.4f), kFrames);
        rig.start(single_track_session(kFrames, eq));
        return rig.render(100);
    };
    const auto none = render_once(std::nullopt);
    auto off = peak_eq(1000.0f, 12.0f, 1.0f);
    off.enabled = false;
    CHECK(count_diffs(none, render_once(off)) == 0);
    // Encendido pero sin bandas encendidas: también idéntico.
    auto no_bands = peak_eq(1000.0f, 12.0f, 1.0f);
    no_bands.bands[0].enabled = false;
    CHECK(count_diffs(none, render_once(no_bands)) == 0);
    // Y el EQ sí cambia algo cuando suena (si no, todo lo anterior es trivial).
    CHECK(count_diffs(none, render_once(peak_eq(523.25f, 6.0f, 1.0f))) > 0);
}

namespace {

constexpr int kThreadBlocks = 90;
constexpr int kThreadTracks = 12;

std::vector<float> render_threads_with_eq(int threads) {
    const Frame length = static_cast<Frame>(kBlock) * (kThreadBlocks + 32);
    SourceManager sm;
    Session s;
    s.id = "eq-threads";
    s.sample_rate = kSR;
    Song song;
    song.id = "song";
    song.start_frame = 0;
    song.end_frame = length;
    song.bpm = 120.0;
    Region warp;
    warp.id = "r-warp";
    warp.start_frame = 0;
    warp.end_frame = length;
    warp.warp_enabled = true;          // voces Bungee: el pool reparte la fase A
    warp.warp_source_bpm = 100.0;
    song.regions.push_back(warp);
    for (int i = 0; i < kThreadTracks; ++i) {
        const std::string src = "src-" + std::to_string(i);
        sm.register_source(src, "");
        REQUIRE(sm.store_decoded_source(src, test::make_stereo_sine(length, 90.0 + 37.0 * i, 0.3f),
                                        2, kSR, length).is_ok());
        s.sources.push_back(Source{ src, "" });
        Track t;
        t.id = "trk-" + std::to_string(i);
        t.gain = 0.3f;
        t.pan = -0.5f + 0.1f * static_cast<float>(i);
        if (i % 3 != 2) {
            auto eq = default_track_eq_params();
            eq.bands[1].gain_db = 4.0f;
            eq.bands[2].gain_db = -3.0f + static_cast<float>(i);
            eq.bands[0].enabled = true;
            eq.bands[0].slope_db_per_octave = 24;
            t.eq = eq;
        }
        t.clips.push_back(Clip{ "clip-" + std::to_string(i), src, 0, 0, length });
        song.tracks.push_back(std::move(t));
    }
    s.songs.push_back(std::move(song));
    auto session = std::make_shared<const Session>(std::move(s));

    TransportClock clock(kSR);
    JumpScheduler scheduler;
    Mixer mixer(session, &sm, &clock, &scheduler);
    BungeeVoiceManager voices;
    REQUIRE(voices.prepare(kSR, 2, kBlock * 4));
    voices.rebuild_for_session(*session, sm, 0);
    mixer.set_bungee_voice_manager(&voices);
    mixer.prepare_render_resources(kBlock);
    mixer.set_active_output_channels({ 0, 1 });
    mixer.set_render_thread_count(threads);
    clock.play();

    std::vector<float> left(kBlock), right(kBlock), out;
    float* ptrs[2] = { left.data(), right.data() };
    for (int b = 0; b < kThreadBlocks; ++b) {
        if (b == 30) mixer.set_track_eq("trk-4", peak_eq(2000.0f, 9.0f, 3.0f));
        if (b == 55) mixer.set_track_eq("trk-2", peak_eq(300.0f, -6.0f, 1.0f));
        if (b == 70) mixer.set_track_eq("trk-0", std::nullopt);
        std::fill(left.begin(), left.end(), 0.0f);
        std::fill(right.begin(), right.end(), 0.0f);
        mixer.render(ptrs, 2, kBlock, clock.sample_rate());
        out.insert(out.end(), left.begin(), left.end());
        out.insert(out.end(), right.begin(), right.end());
    }
    mixer.set_render_thread_count(1);
    return out;
}

} // namespace

TEST_CASE("mixer eq C3: with eq on several tracks the output is bit-identical with 1 and N threads") {
#if !LT_ENGINE_HAVE_BUNGEE
    return;
#endif
    const auto serial = render_threads_with_eq(1);
    float peak = 0.0f;
    for (float v : serial) peak = std::max(peak, std::abs(v));
    REQUIRE_MESSAGE(peak > 0.01f, "la sesion no suena: la comparacion seria trivial");
    for (int threads : { 2, 4 }) {
        CAPTURE(threads);
        CHECK(count_diffs(serial, render_threads_with_eq(threads)) == 0);
    }
}

// Mismo criterio que 01-C4: el salto máximo entre muestras no supera el de la
// salida sin EQ multiplicado por la ganancia máxima en juego (+12 dB) y un 10 %.
TEST_CASE("mixer eq C4: SetTrackEq while playing produces no discontinuity") {
    constexpr Frame kFrames = kSR * 2;
    constexpr int kBlocks = 160;
    auto render_once = [&](bool automate) {
        Rig rig;
        rig.add_source("src", test::make_stereo_sine(kFrames, 1000.0, 0.15f), kFrames);
        rig.start(single_track_session(kFrames, std::nullopt));
        return rig.render(kBlocks, [&](int b) {
            if (!automate) return;
            if (b == 21) rig.mixer->set_track_eq("track", peak_eq(1000.0f, 12.0f, 1.0f));
            if (b == 52) rig.mixer->set_track_eq("track", peak_eq(10000.0f, 12.0f, 1.0f));
            if (b == 83) rig.mixer->set_track_eq("track", peak_eq(1000.0f, 12.0f, 1.0f));
            if (b == 113) {
                auto off = peak_eq(1000.0f, 12.0f, 1.0f);
                off.enabled = false;
                rig.mixer->set_track_eq("track", off);
            }
            if (b == 131) rig.mixer->set_track_eq("track", peak_eq(1000.0f, 12.0f, 1.0f));
            if (b == 146) rig.mixer->set_track_eq("track", std::nullopt);
        });
    };
    const auto dry = render_once(false);
    // Desde el bloque 4: el arranque del transporte tiene su propio fundido.
    const std::size_t from = static_cast<std::size_t>(kBlock) * 4;
    const float threshold = max_step(dry, from) * std::pow(10.0f, 12.0f / 20.0f) * 1.1f;
    const auto wet = render_once(true);
    CAPTURE(threshold);
    CHECK(max_step(wet, from) <= threshold);
}

TEST_CASE("mixer eq C5: a track coming back from settled silence carries no old filter state") {
    constexpr Frame kFrames = kSR * 2;
    constexpr Frame kSplit = kBlock * 40;   // la fuente cambia mientras la pista calla
    constexpr int kBlocks = 90;
    auto render_once = [&](double before_hz) {
        Rig rig;
        rig.add_source("src", two_part_sine(kFrames, kSplit, before_hz, 440.0, 0.3f), kFrames);
        // Campana grave y estrecha: su estado tarda mucho en olvidarse.
        rig.start(single_track_session(kFrames, peak_eq(60.0f, 12.0f, 12.0f)));
        return rig.render(kBlocks, [&](int b) {
            if (b == 20) rig.mixer->set_track_mute("track", true);
            if (b == 60) rig.mixer->set_track_mute("track", false);
        });
    };
    const auto a = render_once(55.0);
    const auto b = render_once(130.0);
    const std::size_t before_mute = static_cast<std::size_t>(kBlock) * 19;
    const std::size_t after_unmute = static_cast<std::size_t>(kBlock) * 60;
    // Antes del silencio suenan distinto (si no, el test no prueba nada)...
    std::vector<float> a_pre(a.begin(), a.begin() + before_mute), b_pre(b.begin(), b.begin() + before_mute);
    REQUIRE(count_diffs(a_pre, b_pre) > 0);
    // ...y desde que vuelve, idénticas: nada del filtro viene de antes.
    std::vector<float> a_post(a.begin() + after_unmute, a.end()), b_post(b.begin() + after_unmute, b.end());
    CHECK(count_diffs(a_post, b_post) == 0);
}

TEST_CASE("mixer eq C6: a slot rebuild keeps the eq of surviving tracks and applies it to new ones") {
    constexpr Frame kFrames = kSR * 2;
    Rig rig;
    rig.add_source("src", test::make_stereo_sine(kFrames, 700.0, 0.3f), kFrames);
    rig.add_source("src2", test::make_stereo_sine(kFrames, 300.0, 0.3f), kFrames);
    rig.start(single_track_session(kFrames, peak_eq(700.0f, 3.0f, 1.0f)));
    rig.render(10);

    // Valor en vivo (arrastre) distinto del de la sesión.
    const auto live = peak_eq(900.0f, 7.0f, 2.0f);
    rig.mixer->set_track_eq("track", live);

    Session next = *rig.session;
    Track added;
    added.id = "added";
    added.eq = peak_eq(300.0f, -5.0f, 1.0f);
    added.clips.push_back(Clip{ "clip2", "src2", 0, 0, kFrames });
    next.songs[0].tracks.insert(next.songs[0].tracks.begin(), added);   // la pista vieja cambia de ranura
    next.sources.push_back(Source{ "src2", "" });
    rig.mixer->set_session(std::make_shared<const Session>(next), /*preserve_realtime_state=*/true);

    REQUIRE(rig.mixer->track_eq_for_test("track").has_value());
    CHECK(*rig.mixer->track_eq_for_test("track") == clamp_params(live));
    REQUIRE(rig.mixer->track_eq_for_test("added").has_value());
    CHECK(*rig.mixer->track_eq_for_test("added") == clamp_params(*added.eq));

    // Sin preserve (cargar sesión) manda la sesión.
    rig.mixer->set_session(std::make_shared<const Session>(next), /*preserve_realtime_state=*/false);
    CHECK(*rig.mixer->track_eq_for_test("track") == clamp_params(peak_eq(700.0f, 3.0f, 1.0f)));

    // UpsertSongTracks: el EQ de la sesión manda sobre el valor en vivo.
    rig.mixer->set_track_eq("track", live);
    Session upserted = next;
    upserted.songs[0].tracks[1].eq = std::nullopt;
    rig.mixer->set_session(std::make_shared<const Session>(upserted), true);
    CHECK(rig.mixer->track_eq_for_test("track") == clamp_params(live));
    rig.mixer->sync_track_eqs_from_song("song");
    CHECK_FALSE(rig.mixer->track_eq_for_test("track").has_value());
}

TEST_CASE("mixer eq C6: swapping to an equal session mid-play keeps the filter state") {
    constexpr Frame kFrames = kSR * 2;
    auto render_once = [&](bool swap) {
        Rig rig;
        rig.add_source("src", test::make_stereo_sine(kFrames, 120.0, 0.3f), kFrames);
        rig.start(single_track_session(kFrames, peak_eq(100.0f, 10.0f, 8.0f)));
        return rig.render(60, [&](int b) {
            if (swap && b == 30)
                rig.mixer->set_session(std::make_shared<const Session>(*rig.session), true);
        });
    };
    CHECK(count_diffs(render_once(false), render_once(true)) == 0);
}

TEST_CASE("mixer eq C7: SetTrackEq and UpsertSongTracks parse eq tolerantly") {
    SUBCASE("SetTrackEq without eq, with null and with garbage removes the eq") {
        for (const char* json : {
                 R"({"type":"SetTrackEq","track_id":"t"})",
                 R"({"type":"SetTrackEq","track_id":"t","eq":null})",
                 R"({"type":"SetTrackEq","track_id":"t","eq":42})" }) {
            CAPTURE(json);
            const auto cmd = command_from_json(json);
            REQUIRE(std::holds_alternative<CmdSetTrackEq>(cmd));
            CHECK(std::get<CmdSetTrackEq>(cmd).track_id == "t");
            CHECK_FALSE(std::get<CmdSetTrackEq>(cmd).eq.has_value());
        }
    }
    SUBCASE("unknown fields are ignored, missing ones take defaults, ranges are clamped") {
        const auto cmd = command_from_json(R"({"type":"SetTrackEq","track_id":"t","future":1,
            "eq":{"enabled":true,"mystery":"x","bands":[
              {"enabled":true,"kind":"peak","frequencyHz":1000,"gainDb":40,"q":1,"slope":12,"shape":"new"},
              {"kind":"highCut","slope":24},
              {"enabled":true,"kind":"tiltShelf","frequencyHz":500}]}})");
        const auto& eq = std::get<CmdSetTrackEq>(cmd).eq;
        REQUIRE(eq.has_value());
        CHECK(eq->enabled);
        CHECK(eq->band_count == 3);
        CHECK(eq->bands[0].gain_db == kTrackEqMaxGainDb);
        CHECK(eq->bands[1].kind == EqBandKind::HighCut);
        CHECK(eq->bands[1].enabled);
        CHECK(eq->bands[1].frequency_hz == 1000.0f);
        CHECK(eq->bands[1].slope_db_per_octave == 24);
        // Tipo de una versión futura: la banda se apaga, no suena a otra cosa.
        CHECK_FALSE(eq->bands[2].enabled);
    }
    SUBCASE("UpsertSongTracks reads eq on audio tracks and folders, not on midi") {
        // Plan track-eq-2, E9: las carpetas también llevan EQ.
        const auto cmd = command_from_json(R"({"type":"UpsertSongTracks","song_id":"s","tracks":[
            {"id":"a","kind":"audio","eq":{"enabled":true,"bands":[{"kind":"notch","frequencyHz":60}]}},
            {"id":"b","kind":"audio"},
            {"id":"c","kind":"audio","eq":null},
            {"id":"m","kind":"midi","eq":{"enabled":true,"bands":[]}},
            {"id":"f","kind":"folder","eq":{"enabled":true,"bands":[]}}]})");
        const auto& up = std::get<CmdUpsertSongTracks>(cmd);
        REQUIRE(up.tracks.size() == 5);
        REQUIRE(up.tracks[0].eq.has_value());
        CHECK(up.tracks[0].eq->bands[0].kind == EqBandKind::Notch);
        CHECK(up.tracks[0].eq->bands[0].frequency_hz == 60.0f);
        CHECK_FALSE(up.tracks[1].eq.has_value());
        CHECK_FALSE(up.tracks[2].eq.has_value());
        CHECK_FALSE(up.tracks[3].eq.has_value());
        CHECK(up.tracks[4].eq.has_value());
    }
}

TEST_CASE("mixer eq C8: render with active eq and a SetTrackEq applied does not allocate") {
    constexpr Frame kFrames = kSR * 2;
    Rig rig;
    rig.add_source("src", test::make_stereo_sine(kFrames, 440.0, 0.3f), kFrames);
    auto eq = default_track_eq_params();
    for (std::size_t i = 0; i < eq.band_count; ++i) {
        eq.bands[i].enabled = true;
        eq.bands[i].gain_db = 3.0f;
    }
    rig.start(single_track_session(kFrames, eq));
    rig.render(4);   // calienta: la primera vez se leen tabla y sesión

    std::vector<float> left(kBlock), right(kBlock);
    float* out[2] = { left.data(), right.data() };
    lt::rt::reset_violations();
    for (int b = 0; b < 40; ++b) {
        rig.mixer->render(out, 2, kBlock, rig.clock.sample_rate());
        if (b == 10) {
            // Hilo de comandos: publicar sí aloja, y fuera de la sección RT.
            const auto saved = lt::rt::violations();
            eq.bands[3].frequency_hz = 5000.0f;
            rig.mixer->set_track_eq("track", eq);
            CHECK(lt::rt::violations().allocations == saved.allocations);
        }
    }
    const auto found = lt::rt::violations();
    CAPTURE(found.allocations);
    CAPTURE(found.deallocations);
#if !defined(_MSC_VER)
    CHECK(found.allocations == 0);
#else
    // Igual que test_rt_no_allocations: MSVC cuenta la contabilidad interna
    // de atomic<shared_ptr> como alojamiento en cada callback.
    CHECK(found.allocations == found.deallocations);
#endif
}
