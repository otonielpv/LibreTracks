// Plan track-eq-2, paso 08: EQ en pistas carpeta, sobre la suma de sus hijas.
//
// Se mide en muestras y frames. Lo "bit a bit" se compara con igualdad exacta.

#include "test_audio_fixtures.h"

#include <doctest/doctest.h>
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
#include <optional>
#include <string>
#include <vector>

using namespace lt;

#ifndef LT_ENGINE_HAVE_BUNGEE
#define LT_ENGINE_HAVE_BUNGEE 0
#endif

namespace {

constexpr int kSR = test::kFixtureSampleRate;
constexpr int kBlock = 512;

TrackEqParams folder_peak(float hz = 700.0f, float gain_db = 9.0f, float q = 1.0f) {
    TrackEqParams params;
    params.enabled = true;
    params.band_count = 1;
    params.bands[0] = TrackEqBandParams{ true, EqBandKind::Peak, hz, gain_db, q, 12 };
    return params;
}

struct FolderSpec {
    std::optional<TrackEqParams> folder_eq;
    std::optional<TrackEqParams> child_eq;
    // La segunda hija sale por su cuenta (no hereda la salida de la carpeta).
    bool second_child_own_route = false;
    // Una carpeta interior (con su propio EQ) entre la carpeta y la 2.ª hija.
    std::optional<TrackEqParams> inner_folder_eq;
};

Session folder_session(Frame frames, const FolderSpec& spec) {
    Session session;
    session.id = "folder-eq";
    session.sample_rate = kSR;
    session.sources.push_back(Source{ "s1", "" });
    session.sources.push_back(Source{ "s2", "" });
    Song song;
    song.id = "song";
    song.start_frame = 0;
    song.end_frame = frames;
    Track folder;
    folder.id = "folder";
    folder.kind = TrackKind::Folder;
    folder.eq = spec.folder_eq;
    folder.gain = 0.9f;
    song.tracks.push_back(folder);
    Track a;
    a.id = "a";
    a.parent_track_id = "folder";
    a.audio_to = "inherit";
    a.gain = 0.5f;
    a.pan = -0.4f;
    a.eq = spec.child_eq;
    a.clips.push_back(Clip{ "ca", "s1", 0, 0, frames });
    song.tracks.push_back(a);
    if (spec.inner_folder_eq) {
        Track inner;
        inner.id = "inner";
        inner.kind = TrackKind::Folder;
        inner.parent_track_id = "folder";
        inner.audio_to = "inherit";
        inner.eq = spec.inner_folder_eq;
        song.tracks.push_back(inner);
    }
    Track b;
    b.id = "b";
    b.parent_track_id = spec.inner_folder_eq ? "inner" : "folder";
    b.audio_to = spec.second_child_own_route ? "master" : "inherit";
    b.gain = 0.6f;
    b.pan = 0.3f;
    b.eq = spec.child_eq;
    b.clips.push_back(Clip{ "cb", "s2", 0, 0, frames });
    song.tracks.push_back(b);
    session.songs.push_back(std::move(song));
    return session;
}

struct Rig {
    SourceManager sources;
    TransportClock clock{ kSR };
    JumpScheduler scheduler;
    std::shared_ptr<const Session> session;
    std::unique_ptr<Mixer> mixer;

    explicit Rig(Frame frames) {
        add("s1", test::make_stereo_sine(frames, 523.25, 0.3f), frames);
        add("s2", test::make_stereo_sine(frames, 880.0, 0.25f), frames);
    }

    void add(const Id& id, std::vector<float> interleaved, Frame frames) {
        sources.register_source(id, "");
        REQUIRE(sources.store_decoded_source(id, std::move(interleaved), 2, kSR, frames).is_ok());
    }

    void start(Session s, Frame from = 0) {
        session = std::make_shared<const Session>(std::move(s));
        mixer = std::make_unique<Mixer>(session, &sources, &clock, &scheduler);
        mixer->prepare_render_resources(kBlock);
        mixer->set_active_output_channels({ 0, 1 });
        if (from > 0) clock.seek(from);
        clock.play();
        clock.clear_pending_start();
    }

    // Renderiza y devuelve L y R intercalados.
    std::vector<float> render(int blocks) {
        std::vector<float> left(kBlock), right(kBlock), out;
        float* channels[2] = { left.data(), right.data() };
        for (int b = 0; b < blocks; ++b) {
            std::fill(left.begin(), left.end(), 0.0f);
            std::fill(right.begin(), right.end(), 0.0f);
            mixer->render(channels, 2, kBlock, clock.sample_rate());
            for (int f = 0; f < kBlock; ++f) {
                out.push_back(left[static_cast<std::size_t>(f)]);
                out.push_back(right[static_cast<std::size_t>(f)]);
            }
        }
        return out;
    }
};

std::vector<float> render_folder(const FolderSpec& spec, int blocks = 80) {
    const Frame frames = static_cast<Frame>(kBlock) * (blocks + 8);
    Rig rig(frames);
    rig.start(folder_session(frames, spec));
    return rig.render(blocks);
}

std::size_t count_diffs(const std::vector<float>& a, const std::vector<float>& b) {
    REQUIRE(a.size() == b.size());
    std::size_t diffs = 0;
    for (std::size_t i = 0; i < a.size(); ++i)
        if (!(a[i] == b[i])) ++diffs;
    return diffs;
}

float max_diff(const std::vector<float>& a, const std::vector<float>& b, std::size_t from) {
    REQUIRE(a.size() == b.size());
    float worst = 0.0f;
    for (std::size_t i = from; i < a.size(); ++i) worst = std::max(worst, std::abs(a[i] - b[i]));
    return worst;
}

// Salto máximo entre muestras consecutivas de un canal (intercalado L/R).
float max_step(const std::vector<float>& v, std::size_t from_frame) {
    float worst = 0.0f;
    for (std::size_t f = std::max<std::size_t>(1, from_frame); f * 2 + 1 < v.size(); ++f)
        for (std::size_t ch = 0; ch < 2; ++ch)
            worst = std::max(worst, std::abs(v[f * 2 + ch] - v[(f - 1) * 2 + ch]));
    return worst;
}

} // namespace

TEST_CASE("folder eq C1: without eq on folders the output is bit-identical to today") {
    const auto none = render_folder({});
    auto off = folder_peak();
    off.enabled = false;
    CHECK(count_diffs(none, render_folder({ off })) == 0);
    auto no_bands = folder_peak();
    no_bands.bands[0].enabled = false;
    CHECK(count_diffs(none, render_folder({ no_bands })) == 0);
    // Y el EQ de carpeta sí cambia algo cuando suena.
    CHECK(count_diffs(none, render_folder({ folder_peak() })) > 0);
}

TEST_CASE("folder eq C2: a bell on the folder sounds like that bell on every child") {
    const auto on_folder = render_folder({ folder_peak(), std::nullopt });
    const auto on_children = render_folder({ std::nullopt, folder_peak() });
    // Desde el bloque 8: los dos caminos ya están en régimen (el arranque del
    // fader no conmuta con el filtro y su rastro se apaga en unos ms).
    const float worst = max_diff(on_folder, on_children, static_cast<std::size_t>(kBlock) * 8 * 2);
    CAPTURE(worst);
    CHECK(worst <= 1e-5f);
}

TEST_CASE("folder eq: a child with its own output skips the folder eq; nested folders stack") {
    // La 2.ª hija sale por su cuenta: con EQ en la carpeta, solo la 1.ª
    // cambia respecto a sin EQ.
    const auto plain = render_folder({ std::nullopt, std::nullopt, true });
    const auto folder_only = render_folder({ folder_peak(), std::nullopt, true });
    const auto first_only = [&] {
        FolderSpec spec{ std::nullopt, std::nullopt, true };
        Frame frames = static_cast<Frame>(kBlock) * 88;
        Rig rig(frames);
        Session s = folder_session(frames, spec);
        s.songs[0].tracks[1].eq = folder_peak();   // la EQ en la hija 1 en su lugar
        rig.start(std::move(s));
        return rig.render(80);
    }();
    CHECK(count_diffs(plain, folder_only) > 0);
    CHECK(max_diff(folder_only, first_only, static_cast<std::size_t>(kBlock) * 16) <= 1e-5f);

    // Anidadas: carpeta (+9 dB a 700 Hz) > carpeta interior (-6 dB a 880 Hz) > hija 2
    // equivale a poner las dos campanas en la hija 2 y la de fuera en la hija 1.
    const auto nested = render_folder({ folder_peak(), std::nullopt, false, folder_peak(880.0f, -6.0f) });
    const auto equivalent = [&] {
        const Frame frames = static_cast<Frame>(kBlock) * 88;
        Rig rig(frames);
        Session s = folder_session(frames, {});
        auto both = folder_peak();
        both.band_count = 2;
        both.bands[1] = TrackEqBandParams{ true, EqBandKind::Peak, 880.0f, -6.0f, 1.0f, 12 };
        s.songs[0].tracks[1].eq = folder_peak();
        s.songs[0].tracks[2].eq = both;
        rig.start(std::move(s));
        return rig.render(80);
    }();
    CHECK(max_diff(nested, equivalent, static_cast<std::size_t>(kBlock) * 16) <= 2e-5f);
}

TEST_CASE("folder eq C3: a jump in the middle of a block with folder eq does not click") {
    const Frame frames = kSR * 3;
    auto render_with_jump = [&](std::optional<TrackEqParams> folder_eq) {
        Rig rig(frames);
        rig.start(folder_session(frames, { folder_eq }), /*from=*/kBlock * 10);
        ScheduledJump jump;
        jump.jump_id = "jump";
        jump.target.kind = JumpTarget::Kind::Frame;
        jump.target.frame = kSR;
        jump.trigger = JumpTrigger::AtFrame;
        jump.status = JumpStatus::Pending;
        jump.trigger_frame = kBlock * 30 + 200;   // a mitad de bloque: render_timeline_span
        REQUIRE(rig.scheduler.schedule(jump).is_ok());
        auto out = rig.render(60);
        CHECK(rig.mixer->scheduled_jump_executed_count() == 1);
        return out;
    };
    const auto dry = render_with_jump(std::nullopt);
    const auto wet = render_with_jump(folder_peak(700.0f, 12.0f));
    const std::size_t from = static_cast<std::size_t>(kBlock) * 4;
    const float threshold = max_step(dry, from) * std::pow(10.0f, 12.0f / 20.0f) * 1.1f;
    CAPTURE(threshold);
    CHECK(max_step(wet, from) <= threshold);
    CHECK(count_diffs(dry, wet) > 0);
}

namespace {

std::vector<float> render_folders_threads(int threads) {
    constexpr int kBlocks = 70;
    constexpr int kChildren = 9;
    const Frame length = static_cast<Frame>(kBlock) * (kBlocks + 32);
    SourceManager sm;
    Session s;
    s.id = "folder-eq-threads";
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
    for (int f = 0; f < 3; ++f) {
        Track folder;
        folder.id = "folder-" + std::to_string(f);
        folder.kind = TrackKind::Folder;
        if (f != 2) folder.eq = folder_peak(300.0f + 400.0f * f, 6.0f - 3.0f * f);
        song.tracks.push_back(folder);
        for (int c = 0; c < kChildren / 3; ++c) {
            const int i = f * (kChildren / 3) + c;
            const std::string src = "src-" + std::to_string(i);
            sm.register_source(src, "");
            REQUIRE(sm.store_decoded_source(src, test::make_stereo_sine(length, 90.0 + 41.0 * i, 0.25f),
                                            2, kSR, length).is_ok());
            s.sources.push_back(Source{ src, "" });
            Track t;
            t.id = "trk-" + std::to_string(i);
            t.parent_track_id = folder.id;
            t.audio_to = "inherit";
            t.gain = 0.35f;
            t.pan = -0.4f + 0.1f * static_cast<float>(i);
            t.clips.push_back(Clip{ "clip-" + std::to_string(i), src, 0, 0, length });
            song.tracks.push_back(std::move(t));
        }
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
    for (int b = 0; b < kBlocks; ++b) {
        if (b == 25) mixer.set_track_eq("folder-2", folder_peak(2000.0f, 9.0f, 3.0f));
        if (b == 50) mixer.set_track_eq("folder-0", std::nullopt);
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

TEST_CASE("folder eq C4: with eq on folders the output is bit-identical with 1 and N threads") {
#if !LT_ENGINE_HAVE_BUNGEE
    return;
#endif
    const auto serial = render_folders_threads(1);
    float peak = 0.0f;
    for (float v : serial) peak = std::max(peak, std::abs(v));
    REQUIRE_MESSAGE(peak > 0.01f, "la sesion no suena: la comparacion seria trivial");
    for (int threads : { 2, 4 }) {
        CAPTURE(threads);
        CHECK(count_diffs(serial, render_folders_threads(threads)) == 0);
    }
}

TEST_CASE("folder eq C6: rendering with folder eq does not allocate on the audio thread") {
    const Frame frames = kSR * 2;
    Rig rig(frames);
    rig.start(folder_session(frames, { folder_peak(), std::nullopt, false, folder_peak(880.0f, -3.0f) }));
    rig.render(4);   // calienta: la primera vez se leen tabla y sesión
    std::vector<float> left(kBlock), right(kBlock);
    float* out[2] = { left.data(), right.data() };
    lt::rt::reset_violations();
    for (int b = 0; b < 40; ++b)
        rig.mixer->render(out, 2, kBlock, rig.clock.sample_rate());
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
