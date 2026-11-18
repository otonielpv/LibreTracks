// Plan drum-loops, paso 03: renderer de loops clavado a la rejilla del metrónomo.
// Todo se mide en frames.
#include <doctest/doctest.h>

#include <lt_engine/core/commands.h>
#include <lt_engine/diagnostics/rt_guard.h>
#include <lt_engine/render/loop_renderer.h>
#include <lt_engine/render/metronome_renderer.h>
#include <lt_engine/render/sample_bank.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <functional>
#include <string>
#include <vector>

using namespace lt;

namespace {

namespace fs = std::filesystem;

constexpr int kSr = 48000;
constexpr Frame kBar120 = 96000;   // 4/4 a 120 BPM
constexpr Frame kStep120 = 6000;   // semicorchea a 120 BPM

struct TempDir {
    fs::path path;
    TempDir() {
        path = fs::temp_directory_path()
             / ("lt_loop_renderer_" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
        fs::create_directories(path);
    }
    ~TempDir() {
        std::error_code ec;
        fs::remove_all(path, ec);
    }
    std::string file(const std::string& name) const {
        std::string s = (path / name).string();
        std::replace(s.begin(), s.end(), '\\', '/');
        return s;
    }
};

void write_wav(const std::string& path, const std::vector<float>& mono) {
    std::ofstream out(path, std::ios::binary);
    auto u32 = [&](std::uint32_t v) { out.write(reinterpret_cast<const char*>(&v), 4); };
    auto u16 = [&](std::uint16_t v) { out.write(reinterpret_cast<const char*>(&v), 2); };
    const auto data_bytes = static_cast<std::uint32_t>(mono.size() * 4);
    out.write("RIFF", 4);
    u32(36 + data_bytes);
    out.write("WAVEfmt ", 8);
    u32(16);
    u16(3);
    u16(1);
    u32(kSr);
    u32(kSr * 4);
    u16(4);
    u16(32);
    out.write("data", 4);
    u32(data_bytes);
    out.write(reinterpret_cast<const char*>(mono.data()), data_bytes);
}

// Slots: 0 impulso de 1.0, 1 impulso de 0.5, 2 un segundo a 1.0, 3 un segundo de silencio.
struct Bank {
    TempDir dir;
    SampleBank bank;
    Bank() {
        write_wav(dir.file("imp.wav"), {1.0f, 0.0f, 0.0f, 0.0f});
        write_wav(dir.file("imp_half.wav"), {0.5f, 0.0f, 0.0f, 0.0f});
        write_wav(dir.file("long.wav"), std::vector<float>(kSr, 1.0f));
        write_wav(dir.file("silent.wav"), std::vector<float>(kSr, 0.0f));
        const auto result = bank.load({{0, dir.file("imp.wav")}, {1, dir.file("imp_half.wav")},
                                       {2, dir.file("long.wav")}, {3, dir.file("silent.wav")}},
                                      kSr);
        REQUIRE(result.ok);
    }
};

Session make_session(double bpm = 120.0, int beats = 4, int unit = 4, Frame length = kSr * 60) {
    Session session;
    session.sample_rate = kSr;
    Song song;
    song.id = "song";
    song.start_frame = 0;
    song.end_frame = length;
    song.bpm = bpm;
    song.beats_per_bar = beats;
    song.beat_unit = unit;
    session.songs.push_back(std::move(song));
    return session;
}

LoopPatternData pattern(std::initializer_list<int> steps, int slot = 0, int beats_per_bar = 4,
                        int beat_unit = 4, int steps_per_beat = 4, int bars = 1) {
    LoopPatternData p;
    p.steps_per_beat = steps_per_beat;
    p.beats_per_bar = beats_per_bar;
    p.beat_unit = beat_unit;
    p.bars = bars;
    p.row_count = 1;
    p.rows[0].slot = slot;
    for (int v = 0; v < kLoopVariations; ++v)
        for (int s : steps) p.rows[0].steps[static_cast<std::size_t>(v)][static_cast<std::size_t>(s)] = 2;
    return p;
}

LoopPatternData every_beat(int beats_per_bar = 4) {
    LoopPatternData p = pattern({}, 0, beats_per_bar);
    for (int s = 0; s < p.steps_per_bar(); s += 4) p.rows[0].steps[0][static_cast<std::size_t>(s)] = 2;
    return p;
}

using SpanFn = std::function<LoopSpan(Frame out_frame, int frames)>;

LoopSpan playing_from(Frame timeline_start, Frame out_frame, int frames) {
    LoopSpan s;
    s.offset = 0;
    s.frames = frames;
    s.timeline_frame = timeline_start + out_frame;
    s.kind = LoopSpanKind::Playing;
    return s;
}

// Renderiza `total` frames en bloques de `block` y devuelve el canal izquierdo.
// `before_block` puede mandar comandos antes de cada bloque.
std::vector<float> run(LoopRenderer& loop, Bank& b, const Session* session, Frame total, int block,
                       const SpanFn& span_for,
                       const std::function<void(Frame)>& before_block = {}) {
    std::vector<float> out(static_cast<std::size_t>(total), 0.0f);
    std::vector<float> right(static_cast<std::size_t>(block), 0.0f);
    for (Frame f = 0; f < total; f += block) {
        const int n = static_cast<int>(std::min<Frame>(block, total - f));
        if (before_block) before_block(f);
        std::fill(right.begin(), right.end(), 0.0f);
        float* channels[] = {out.data() + f, right.data()};
        const LoopSpan span = span_for(f, n);
        loop.render(channels, 2, n, kSr, session, &span, 1, b.bank);
        b.bank.collect_retired();
    }
    return out;
}

std::vector<Frame> onsets(const std::vector<float>& out, float threshold = 0.05f) {
    std::vector<Frame> frames;
    for (std::size_t i = 0; i < out.size(); ++i)
        if (std::abs(out[i]) > threshold) frames.push_back(static_cast<Frame>(i));
    return frames;
}

// Frames en que el metrónomo dispara un clic, renderizando frame a frame.
std::vector<Frame> metronome_clicks(const Session& session, Frame total,
                                    const Song* frozen_from = nullptr, Frame frozen_at = -1) {
    MetronomeRenderer metronome;
    MetronomeConfig cfg;
    cfg.enabled = true;
    cfg.volume = 1.0f;
    metronome.set_config(cfg);
    float l = 0.0f, r = 0.0f;
    float* channels[] = {&l, &r};
    std::vector<Frame> clicks;
    uint64_t count = 0;
    for (Frame f = 0; f < total; ++f) {
        if (frozen_from && f >= frozen_at)
            metronome.render_song(channels, 2, 1, kSr, f, frozen_from);
        else
            metronome.render(channels, 2, 1, kSr, f, &session);
        const uint64_t now = metronome.diagnostics().rendered_clicks_count;
        if (now != count) {
            clicks.push_back(f);
            count = now;
        }
    }
    return clicks;
}

void expect_same(const std::vector<Frame>& got, const std::vector<Frame>& want) {
    REQUIRE(got.size() == want.size());
    for (std::size_t i = 0; i < want.size(); ++i) {
        CAPTURE(i);
        CHECK(got[i] == want[i]);
    }
}

} // namespace

TEST_CASE("loop renderer: one hit per beat in 4/4 at 120 lands on every metronome click for 8 bars") {
    Bank b;
    const Session session = make_session();
    LoopRenderer loop;
    loop.set_pattern(every_beat());
    loop.set_transport(true);
    const Frame total = 8 * kBar120;
    const auto out = run(loop, b, &session, total, 512,
                         [](Frame f, int n) { return playing_from(0, f, n); });
    const auto clicks = metronome_clicks(session, total);
    CHECK(clicks.size() == 32);
    expect_same(onsets(out), clicks);
}

TEST_CASE("loop renderer: stays on the click through a 90 to 130 ramp") {
    Bank b;
    Session session = make_session(90.0);
    auto& song = session.songs[0];
    song.tempo_markers.push_back({"t0", 0, 90.0, true});
    song.tempo_markers.push_back({"t1", 8 * kSr, 130.0, false});
    LoopRenderer loop;
    loop.set_pattern(every_beat());
    loop.set_transport(true);
    const Frame total = 12 * kSr;
    const auto out = run(loop, b, &session, total, 441,
                         [](Frame f, int n) { return playing_from(0, f, n); });
    const auto clicks = metronome_clicks(session, total);
    CHECK(clicks.size() > 20);
    expect_same(onsets(out), clicks);
}

TEST_CASE("loop renderer: stays on the click across a 4/4 to 6/8 change") {
    Bank b;
    Session session = make_session(120.0);
    auto& song = session.songs[0];
    song.time_signature_markers.push_back({"s0", 0, 4, 4});
    song.time_signature_markers.push_back({"s1", 2 * kBar120, 6, 8});
    LoopRenderer loop;
    loop.set_pattern(every_beat(6));  // 24 pasos por compás: cubre el de 6/8
    loop.set_transport(true);
    const Frame total = 6 * kBar120;
    const auto out = run(loop, b, &session, total, 512,
                         [](Frame f, int n) { return playing_from(0, f, n); });
    const auto clicks = metronome_clicks(session, total);
    expect_same(onsets(out), clicks);
}

TEST_CASE("loop renderer: the vamp keeps the loop in phase with the frozen click") {
    Bank b;
    Session session = make_session(100.0);
    const Frame pause = 3 * kSr + 12345;  // fin de canción fuera de rejilla
    Song frozen;
    MetronomeRenderer::freeze_timing_at(&session, pause - 1, frozen);
    LoopRenderer loop;
    loop.set_pattern(every_beat());
    loop.set_transport(true);
    const Frame total = 8 * kSr;
    std::vector<float> out(static_cast<std::size_t>(total), 0.0f);
    std::vector<float> right(512, 0.0f);
    for (Frame f = 0; f < total; f += 512) {
        const int n = static_cast<int>(std::min<Frame>(512, total - f));
        float* channels[] = {out.data() + f, right.data()};
        LoopSpan spans[2];
        int count = 0;
        if (f + n <= pause) {
            spans[count++] = playing_from(0, f, n);
        } else if (f >= pause) {
            LoopSpan v;
            v.frames = n;
            v.timeline_frame = f;
            v.kind = LoopSpanKind::Vamp;
            v.frozen_song = &frozen;
            spans[count++] = v;
        } else {
            const int pre = static_cast<int>(pause - f);
            spans[count++] = playing_from(0, f, pre);
            LoopSpan v;
            v.offset = pre;
            v.frames = n - pre;
            v.timeline_frame = pause;
            v.kind = LoopSpanKind::Vamp;
            v.frozen_song = &frozen;
            spans[count++] = v;
        }
        loop.render(channels, 2, n, kSr, &session, spans, count, b.bank);
    }
    const auto clicks = metronome_clicks(session, total, &frozen, pause);
    CHECK(clicks.back() > pause);
    expect_same(onsets(out), clicks);
}

TEST_CASE("loop renderer: start, variation change and stop are quantized to the bar") {
    Bank b;
    const Session session = make_session();
    SUBCASE("start requested mid-bar sounds on the next bar") {
        LoopRenderer loop;
        // Arranque a mano con la canción ya sonando: sin «Con la canción»,
        // que lo habría arrancado en el play (eso lo prueba test_loop_mixer).
        LoopConfig manual;
        manual.follow_transport = false;
        loop.set_config(manual);
        loop.set_pattern(every_beat());
        const auto out = run(loop, b, &session, 4 * kBar120, 512,
                             [](Frame f, int n) { return playing_from(0, f, n); },
                             [&](Frame f) {
                                 if (f <= kBar120 + kBar120 / 2 && f + 512 > kBar120 + kBar120 / 2)
                                     loop.set_transport(true);
                             });
        const auto got = onsets(out);
        REQUIRE_FALSE(got.empty());
        CHECK(got.front() == 2 * kBar120);
    }
    SUBCASE("variation change mid-bar applies on the next bar") {
        LoopRenderer loop;
        LoopPatternData p = every_beat();
        p.rows[0].steps[1] = {};
        p.rows[0].steps[1][2] = 2;  // B: solo el paso 2
        loop.set_pattern(p);
        loop.set_transport(true);
        const auto out = run(loop, b, &session, 3 * kBar120, 512,
                             [](Frame f, int n) { return playing_from(0, f, n); },
                             [&](Frame f) {
                                 if (f <= kBar120 + kBar120 / 2 && f + 512 > kBar120 + kBar120 / 2)
                                     loop.set_row(0, -1, 1);
                             });
        const std::vector<Frame> want = {0, 24000, 48000, 72000,
                                         96000, 120000, 144000, 168000,
                                         2 * kBar120 + 2 * kStep120};
        expect_same(onsets(out), want);
    }
    // Decisión del usuario (2026-11-18): parar NO se cuantiza, es inmediato.
    SUBCASE("stop mid-bar silences at once, without waiting for the bar") {
        LoopRenderer loop;
        loop.set_pattern(every_beat());
        loop.set_transport(true);
        const auto out = run(loop, b, &session, 3 * kBar120, 512,
                             [](Frame f, int n) { return playing_from(0, f, n); },
                             [&](Frame f) {
                                 if (f <= kBar120 + kBar120 / 2 && f + 512 > kBar120 + kBar120 / 2)
                                     loop.set_transport(false);
                             });
        const auto got = onsets(out);
        // El stop llega en el bloque que empieza en 143872: el tiempo de
        // 144000 (mitad del segundo compás) ya no suena.
        REQUIRE(got.size() == 6);
        CHECK(got.back() == kBar120 + 24000);
        CHECK_FALSE(loop.playing());
    }
}

TEST_CASE("loop renderer: Play from stopped puts the first onset on the song grid") {
    Bank b;
    const Session session = make_session();
    LoopRenderer loop;
    LoopPatternData all = pattern({0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15});
    loop.set_pattern(all);
    loop.set_transport(true);
    const Frame stopped_frames = 50000;
    const Frame playhead = 10000;  // fuera de la rejilla de pasos
    const auto out = run(loop, b, &session, stopped_frames + 3 * kStep120, 500,
                         [&](Frame f, int n) {
                             LoopSpan s;
                             s.frames = n;
                             if (f < stopped_frames) {
                                 s.kind = LoopSpanKind::Stopped;
                                 s.timeline_frame = playhead;
                             } else {
                                 s.kind = LoopSpanKind::Playing;
                                 s.timeline_frame = playhead + (f - stopped_frames);
                             }
                             return s;
                         });
    const auto got = onsets(out);
    // Parado ya sonaba con el reloj libre.
    REQUIRE(std::count_if(got.begin(), got.end(), [&](Frame f) { return f < stopped_frames; }) > 0);
    const auto first_after =
        std::find_if(got.begin(), got.end(), [&](Frame f) { return f >= stopped_frames; });
    REQUIRE(first_after != got.end());
    // Siguiente paso de la canción tras el frame 10000: el 12000.
    CHECK(*first_after - stopped_frames + playhead == 12000);
    CHECK(*(first_after + 1) - stopped_frames + playhead == 18000);
}

TEST_CASE("loop renderer: free clock at 97 BPM has zero drift over 16 bars") {
    Bank b;
    LoopRenderer loop;
    LoopConfig cfg;
    cfg.clock_mode = LoopClockMode::Free;
    cfg.free_bpm = 97.0;
    loop.set_config(cfg);
    LoopPatternData all = pattern({0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15});
    loop.set_pattern(all);
    loop.set_transport(true);
    const double step = kSr * 60.0 / 97.0 / 4.0;
    const Frame total = static_cast<Frame>(std::ceil(16 * 16 * step)) + 10;
    const auto out = run(loop, b, nullptr, total, 333, [](Frame, int n) {
        LoopSpan s;
        s.frames = n;
        s.kind = LoopSpanKind::Playing;  // en Libre el tramo no importa
        return s;
    });
    const auto got = onsets(out);
    REQUIRE(got.size() == 257);
    for (std::size_t k = 0; k < got.size(); ++k) {
        CAPTURE(k);
        CHECK(got[k] == static_cast<Frame>(std::llround(static_cast<double>(k) * step)));
    }
}

TEST_CASE("loop renderer: swing and triplets land on the computed frames") {
    Bank b;
    const Session session = make_session();
    SUBCASE("swing 0.5 delays odd sixteenths by a quarter of a step") {
        LoopRenderer loop;
        LoopPatternData p = pattern({0, 1, 2, 3});
        p.swing = 0.5;
        loop.set_pattern(p);
        loop.set_transport(true);
        const auto out = run(loop, b, &session, 4 * kStep120, 512,
                             [](Frame f, int n) { return playing_from(0, f, n); });
        const std::vector<Frame> want = {0, kStep120 + 1500, 2 * kStep120, 3 * kStep120 + 1500};
        expect_same(onsets(out), want);
    }
    SUBCASE("three steps per beat are eighth-note triplets") {
        LoopRenderer loop;
        loop.set_pattern(pattern({0, 1, 2, 3, 4}, 0, 4, 4, 3));
        loop.set_transport(true);
        const auto out = run(loop, b, &session, 2 * 24000, 512,
                             [](Frame f, int n) { return playing_from(0, f, n); });
        const std::vector<Frame> want = {0, 8000, 16000, 24000, 32000};
        expect_same(onsets(out), want);
    }
}

TEST_CASE("loop renderer: SetRegionLoops starts the second song's pattern on its first frame") {
    Bank b;
    Session session = make_session();
    auto& song = session.songs[0];
    const Frame r2 = 2 * kBar120;
    Region first;
    first.id = "r1";
    first.start_frame = 0;
    first.end_frame = r2;
    Region second;
    second.id = "r2";
    second.start_frame = r2;
    second.end_frame = 6 * kBar120;
    song.regions = {first, second};
    LoopRenderer loop;
    RegionLoopData data;
    data.region_id = "r2";
    data.pattern = pattern({0, 8});  // tiempo 1 y 3
    data.autostart = true;
    loop.set_region_loops({data});
    const auto out = run(loop, b, &session, 4 * kBar120, 512,
                         [](Frame f, int n) { return playing_from(0, f, n); });
    const std::vector<Frame> want = {r2, r2 + 48000, r2 + kBar120, r2 + kBar120 + 48000};
    expect_same(onsets(out), want);
    CHECK(loop.playing());
}

TEST_CASE("loop renderer: choke group fades the previous voice in 2 ms and the pool steals the oldest") {
    Bank b;
    const Session session = make_session();
    SUBCASE("choke") {
        LoopRenderer loop;
        LoopPatternData p;
        p.row_count = 2;
        p.rows[0].slot = 2;  // un segundo a 1.0
        p.rows[0].choke_group = 1;
        p.rows[0].steps[0][0] = 3;
        p.rows[1].slot = 3;  // silencio, mismo grupo
        p.rows[1].choke_group = 1;
        p.rows[1].steps[0][1] = 3;
        loop.set_pattern(p);
        loop.set_transport(true);
        const auto out = run(loop, b, &session, 2 * kStep120, 256,
                             [](Frame f, int n) { return playing_from(0, f, n); });
        CHECK(out[kStep120 - 1] == doctest::Approx(1.0f));
        CHECK(out[kStep120 + 48] > 0.3f);
        CHECK(out[kStep120 + 48] < 0.7f);
        CHECK(out[kStep120 + 96] == 0.0f);
        CHECK(out[kStep120 + 500] == 0.0f);
    }
    SUBCASE("steal") {
        LoopRenderer loop;
        LoopPatternData p;
        p.row_count = 8;
        for (int r = 0; r < 8; ++r) {
            p.rows[static_cast<std::size_t>(r)].slot = 2;
            for (int s = 0; s < 16; ++s) p.rows[static_cast<std::size_t>(r)].steps[0][static_cast<std::size_t>(s)] = 1;
        }
        loop.set_pattern(p);
        loop.set_transport(true);
        (void)run(loop, b, &session, 3 * kStep120 + 10, 256,
                  [](Frame f, int n) { return playing_from(0, f, n); });
        const auto d = loop.diagnostics();
        CHECK(d.triggered_voices == 32);
        CHECK(d.stolen_voices == 8);
        CHECK(d.active_voices == kLoopVoiceCount);
    }
}

TEST_CASE("loop renderer: render performs no allocations") {
    Bank b;
    Session session = make_session();
    session.songs[0].regions.push_back(Region{"r1", "Uno", 0, kBar120 * 10});
    LoopRenderer loop;
    LoopPatternData p = pattern({0, 2, 4, 6, 8, 10, 12, 14}, 2);
    p.rows[0].choke_group = 1;
    p.swing = 0.3;
    loop.set_pattern(p);
    RegionLoopData data;
    data.region_id = "r1";
    data.pattern = p;
    data.autostart = true;
    loop.set_region_loops({data});
    loop.set_transport(true);
    std::vector<float> l(512), r(512);
    float* channels[] = {l.data(), r.data()};
    lt::rt::reset_violations();
    for (int block = 0; block < 400; ++block) {
        LoopSpan s = playing_from(0, static_cast<Frame>(block) * 512, 512);
        if (block % 100 == 50) loop.set_row(0, -1, 1);  // la cola no reserva
        {
            lt::rt::ScopedRealtimeSection rt;
            loop.render(channels, 2, 512, kSr, &session, &s, 1, b.bank);
        }
    }
    const auto found = lt::rt::violations();
    CAPTURE(found.allocations);
    CHECK(found.allocations == 0);
    CHECK(found.deallocations == 0);
}

TEST_CASE("loop renderer: retired programs are freed by collect, not by render") {
    Bank b;
    LoopRenderer loop;
    loop.set_pattern(every_beat());
    loop.set_pattern(every_beat(3));  // la primera queda retirada y se libera ya
    const Session session = make_session();
    std::vector<float> l(256), r(256);
    float* channels[] = {l.data(), r.data()};
    LoopSpan s = playing_from(0, 0, 256);
    loop.render(channels, 2, 256, kSr, &session, &s, 1, b.bank);
    loop.set_pattern(every_beat());
    loop.collect_retired();
    CHECK(loop.diagnostics().fired_steps > 0);
}

TEST_CASE("loop commands: JSON round trip") {
    const auto cmd = command_from_json(
        R"({"type":"SetRegionLoops","regions":[{"region_id":"r2","autostart":true,)"
        R"("initial_rows":[{"enabled":false,"variation":2}],)"
        R"("pattern":{"steps_per_beat":3,"beats_per_bar":6,"beat_unit":8,"bars":2,"free_bpm":90,"swing":0.25,)"
        R"("rows":[{"slot":4,"gain":0.5,"choke_group":1,"variations":[[2,0,3],[1]]}]}}]})");
    REQUIRE(std::holds_alternative<CmdSetRegionLoops>(cmd));
    const auto& c = std::get<CmdSetRegionLoops>(cmd);
    REQUIRE(c.regions.size() == 1);
    CHECK(c.regions[0].region_id == "r2");
    CHECK(c.regions[0].autostart);
    CHECK(c.regions[0].initial_rows[0].variation == 2);
    CHECK(c.regions[0].pattern.steps_per_beat == 3);
    CHECK(c.regions[0].pattern.rows[0].variations[0][2] == 3);
    const auto back = command_from_json(command_to_json(cmd));
    CHECK(command_to_json(back) == command_to_json(cmd));

    const auto row = command_from_json(R"({"type":"SetLoopRow","row":2,"variation":1})");
    REQUIRE(std::holds_alternative<CmdSetLoopRow>(row));
    CHECK_FALSE(std::get<CmdSetLoopRow>(row).enabled.has_value());
    CHECK(*std::get<CmdSetLoopRow>(row).variation == 1);

    const auto config = command_from_json(
        R"({"type":"SetLoopConfig","clock_mode":"free","free_bpm":101,"quantize":"beat","route":"ext:3-4","gain":0.8})");
    REQUIRE(std::holds_alternative<CmdSetLoopConfig>(config));
    CHECK(std::get<CmdSetLoopConfig>(config).clock_mode == "free");

    const LoopPatternData data = loop_pattern_data_from_spec(c.regions[0].pattern);
    CHECK(data.steps_per_bar() == 18);
    CHECK(data.bars == 2);
    CHECK(data.rows[0].steps[0][2] == 3);
    CHECK(data.rows[0].steps[1][0] == 1);
}

TEST_CASE("loop renderer: publishes row state with pending changes") {
    Bank b;
    const Session session = make_session();
    LoopRenderer loop;
    LoopPatternData p = every_beat();
    p.row_count = 2;
    loop.set_pattern(p);
    loop.set_transport(true);
    std::vector<float> l(256), r(256);
    float* channels[] = {l.data(), r.data()};
    LoopSpan s = playing_from(0, 0, 256);
    loop.render(channels, 2, 256, kSr, &session, &s, 1, b.bank);
    CHECK(loop.row_count() == 2);
    CHECK((loop.rows_state() & 0xFFFFu) == 0x0101u);  // las dos encendidas en A
    loop.set_row(1, 0, 2);  // apagar y pasar a C, pendiente hasta el compás
    s = playing_from(0, 256, 256);
    loop.render(channels, 2, 256, kSr, &session, &s, 1, b.bank);
    const uint64_t row1 = (loop.rows_state() >> 8) & 0xFFu;
    CHECK((row1 & 1u) == 1u);          // aún encendida
    CHECK((row1 & 0x8u) != 0u);        // variación pendiente
    CHECK(((row1 >> 4) & 3u) == 2u);   // la C
    CHECK((row1 & 0x40u) != 0u);       // encendido pendiente
    CHECK((row1 & 0x80u) == 0u);       // a apagado
}
