// Plan drum-loops, paso 04: one shots y disparo rápido. Medido en frames.
#include <doctest/doctest.h>

#include <lt_engine/core/commands.h>
#include <lt_engine/diagnostics/rt_guard.h>
#include <lt_engine/render/loop_renderer.h>
#include <lt_engine/render/one_shot_renderer.h>
#include <lt_engine/render/sample_bank.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

using namespace lt;

namespace {

namespace fs = std::filesystem;
constexpr int kSr = 48000;
constexpr Frame kBar120 = 96000;

struct TempDir {
    fs::path path;
    TempDir() {
        path = fs::temp_directory_path()
             / ("lt_one_shot_" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
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

// Slot 0: impulso. Slot 1: un segundo a 1.0. Slot 2: un segundo de silencio.
struct Fixture {
    TempDir dir;
    SampleBank bank;
    OneShotRenderer shots;
    Session session;
    Fixture() {
        write_wav(dir.file("imp.wav"), {1.0f, 0.0f, 0.0f, 0.0f});
        write_wav(dir.file("long.wav"), std::vector<float>(kSr, 1.0f));
        write_wav(dir.file("silent.wav"), std::vector<float>(kSr, 0.0f));
        REQUIRE(bank.load({{0, dir.file("imp.wav")}, {1, dir.file("long.wav")}, {2, dir.file("silent.wav")}},
                          kSr).ok);
        Song song;
        song.id = "song";
        song.end_frame = kSr * 60;
        song.bpm = 120.0;
        session.sample_rate = kSr;
        session.songs.push_back(song);
    }

    void pads(std::initializer_list<OneShotPadData> list) {
        OneShotBankData data;
        int i = 0;
        for (const auto& p : list) data.pads[static_cast<std::size_t>(i++)] = p;
        shots.set_bank(data);
    }

    // Renderiza un bloque y lo añade a `out` (canal izquierdo).
    void block(std::vector<float>& out, int frames, LoopSpanKind kind = LoopSpanKind::Playing,
               const LoopRenderer* loop = nullptr) {
        std::vector<float> l(static_cast<std::size_t>(frames), 0.0f), r(static_cast<std::size_t>(frames), 0.0f);
        float* channels[] = {l.data(), r.data()};
        LoopSpan span;
        span.frames = frames;
        span.timeline_frame = static_cast<Frame>(out.size());
        span.kind = kind;
        shots.render(channels, 2, frames, kSr, &session, &span, 1, bank, loop);
        out.insert(out.end(), l.begin(), l.end());
    }
};

OneShotPadData pad(int slot, OneShotMode mode = OneShotMode::OneShot,
                   OneShotQuantize q = OneShotQuantize::Off, int choke = 0) {
    OneShotPadData p;
    p.slot = slot;
    p.mode = mode;
    p.quantize = q;
    p.choke_group = choke;
    return p;
}

std::vector<Frame> onsets(const std::vector<float>& out) {
    std::vector<Frame> frames;
    for (std::size_t i = 0; i < out.size(); ++i)
        if (std::abs(out[i]) > 0.05f) frames.push_back(static_cast<Frame>(i));
    return frames;
}

} // namespace

TEST_CASE("one shots: a trigger before a block starts on frame 0 of that block") {
    Fixture fx;
    fx.pads({pad(0)});
    std::vector<float> out;
    fx.block(out, 300);
    REQUIRE(fx.shots.push_trigger(TriggerKind::OneShotDown, 0, 127));
    fx.block(out, 300);
    const auto got = onsets(out);
    REQUIRE(got.size() == 1);
    CHECK(got[0] == 300);
    CHECK(out[300] == doctest::Approx(1.0f));
    // Velocidad 64 → mitad (aprox.).
    fx.shots.push_trigger(TriggerKind::OneShotDown, 0, 64);
    fx.block(out, 300);
    CHECK(out[600] == doctest::Approx(64.0f / 127.0f));
}

TEST_CASE("one shots: bar quantization starts on the next bar") {
    Fixture fx;
    fx.pads({pad(0, OneShotMode::OneShot, OneShotQuantize::Bar)});
    std::vector<float> out;
    while (out.size() < static_cast<std::size_t>(kBar120 + 30000)) fx.block(out, 512);
    fx.shots.push_trigger(TriggerKind::OneShotDown, 0, 127);
    while (out.size() < static_cast<std::size_t>(2 * kBar120 + 1000)) fx.block(out, 512);
    const auto got = onsets(out);
    REQUIRE(got.size() == 1);
    CHECK(got[0] == 2 * kBar120);

    SUBCASE("beat quantization while the transport is stopped follows the free loop's beats") {
        LoopRenderer loop;
        LoopPatternData p;
        p.row_count = 0;
        loop.set_pattern(p);
        LoopConfig cfg;
        cfg.clock_mode = LoopClockMode::Free;
        cfg.free_bpm = 120.0;
        loop.set_config(cfg);
        loop.set_transport(true);
        fx.pads({pad(0, OneShotMode::OneShot, OneShotQuantize::Beat)});
        std::vector<float> stopped;
        std::vector<float> l(500), r(500);
        float* channels[] = {l.data(), r.data()};
        Frame rendered = 0;
        bool pushed = false;
        while (rendered < 60000) {
            if (!pushed && rendered >= 10000) {
                fx.shots.push_trigger(TriggerKind::OneShotDown, 0, 127);
                pushed = true;
            }
            std::fill(l.begin(), l.end(), 0.0f);
            LoopSpan span;
            span.frames = 500;
            span.kind = LoopSpanKind::Stopped;
            loop.render(channels, 2, 500, kSr, nullptr, &span, 1, fx.bank);
            fx.shots.render(channels, 2, 500, kSr, nullptr, &span, 1, fx.bank, &loop);
            stopped.insert(stopped.end(), l.begin(), l.end());
            rendered += 500;
        }
        const auto hits = onsets(stopped);
        REQUIRE(hits.size() == 1);
        CHECK(hits[0] == 24000);  // siguiente tiempo del loop libre a 120
    }
}

TEST_CASE("one shots: a gate pad released after 1000 frames fades out in 10 ms") {
    Fixture fx;
    fx.pads({pad(1, OneShotMode::Gate)});
    std::vector<float> out;
    fx.shots.push_trigger(TriggerKind::OneShotDown, 0, 127);
    while (out.size() < 1000) fx.block(out, 100);
    CHECK(fx.shots.playing_mask() == 1u);
    fx.shots.push_trigger(TriggerKind::OneShotUp, 0, 0);
    while (out.size() < 3000) fx.block(out, 100);
    CHECK(out[999] == doctest::Approx(1.0f));
    CHECK(out[1000] == doctest::Approx(1.0f));
    CHECK(out[1240] > 0.4f);
    CHECK(out[1240] < 0.6f);
    CHECK(out[1480] == 0.0f);
    CHECK(out[2500] == 0.0f);
    CHECK(fx.shots.playing_mask() == 0u);

    SUBCASE("a one-shot pad ignores the release") {
        fx.pads({pad(1)});
        std::vector<float> o;
        fx.shots.push_trigger(TriggerKind::OneShotDown, 0, 127);
        fx.block(o, 100);
        fx.shots.push_trigger(TriggerKind::OneShotUp, 0, 0);
        while (o.size() < 5000) fx.block(o, 100);
        CHECK(o[4999] == doctest::Approx(1.0f));
    }
}

TEST_CASE("one shots: choke group, voice stealing and stop all") {
    Fixture fx;
    SUBCASE("choke") {
        fx.pads({pad(1, OneShotMode::OneShot, OneShotQuantize::Off, 3),
                 pad(2, OneShotMode::OneShot, OneShotQuantize::Off, 3)});
        std::vector<float> out;
        fx.shots.push_trigger(TriggerKind::OneShotDown, 0, 127);
        fx.block(out, 500);
        fx.shots.push_trigger(TriggerKind::OneShotDown, 1, 127);
        fx.block(out, 500);
        CHECK(out[499] == doctest::Approx(1.0f));
        CHECK(out[548] > 0.3f);
        CHECK(out[548] < 0.7f);
        CHECK(out[596] == 0.0f);
        CHECK(fx.shots.playing_mask() == 0b10u);
    }
    SUBCASE("steal") {
        fx.pads({pad(1)});
        std::vector<float> out;
        for (int i = 0; i < kOneShotVoiceCount + 1; ++i) fx.shots.push_trigger(TriggerKind::OneShotDown, 0, 127);
        fx.block(out, 100);
        const auto d = fx.shots.diagnostics();
        CHECK(d.stolen_voices == 1);
        CHECK(d.active_voices == kOneShotVoiceCount);
        CHECK(out[50] == doctest::Approx(static_cast<float>(kOneShotVoiceCount)));
    }
    SUBCASE("stop all fades every voice in 30 ms") {
        fx.pads({pad(1), pad(1)});
        std::vector<float> out;
        fx.shots.push_trigger(TriggerKind::OneShotDown, 0, 127);
        fx.shots.push_trigger(TriggerKind::OneShotDown, 1, 127);
        fx.block(out, 1000);
        CHECK(fx.shots.playing_mask() == 0b11u);
        fx.shots.push_trigger(TriggerKind::OneShotStopAll, 0, 0);
        while (out.size() < 4000) fx.block(out, 1000);
        CHECK(out[999] == doctest::Approx(2.0f));
        CHECK(out[1000 + 720] == doctest::Approx(1.0f).epsilon(0.01));
        CHECK(out[1000 + 1440] == 0.0f);
        CHECK(fx.shots.playing_mask() == 0u);
    }
}

TEST_CASE("one shots: a full queue drops without blocking and counts") {
    Fixture fx;
    fx.pads({pad(0)});
    int accepted = 0;
    for (int i = 0; i < kOneShotTriggerQueue + 44; ++i)
        accepted += fx.shots.push_trigger(TriggerKind::OneShotDown, 0, 127) ? 1 : 0;
    CHECK(accepted == kOneShotTriggerQueue);
    CHECK(fx.shots.dropped_triggers() == 44);
    std::vector<float> out;
    fx.block(out, 64);
    CHECK(fx.shots.push_trigger(TriggerKind::OneShotDown, 0, 127));  // vaciada en el render
}

TEST_CASE("one shots: render performs no allocations") {
    Fixture fx;
    fx.pads({pad(0), pad(1, OneShotMode::Gate, OneShotQuantize::Beat, 1),
             pad(1, OneShotMode::OneShot, OneShotQuantize::Bar, 1)});
    std::vector<float> l(512), r(512);
    float* channels[] = {l.data(), r.data()};
    lt::rt::reset_violations();
    for (int block = 0; block < 400; ++block) {
        if (block % 7 == 0) fx.shots.push_trigger(TriggerKind::OneShotDown, block % 3, 100);
        if (block % 11 == 0) fx.shots.push_trigger(TriggerKind::OneShotUp, 1, 0);
        if (block % 97 == 0) fx.shots.push_trigger(TriggerKind::OneShotStopAll, 0, 0);
        LoopSpan span;
        span.frames = 512;
        span.timeline_frame = static_cast<Frame>(block) * 512;
        span.kind = LoopSpanKind::Playing;
        lt::rt::ScopedRealtimeSection rt;
        fx.shots.render(channels, 2, 512, kSr, &fx.session, &span, 1, fx.bank, nullptr);
    }
    const auto found = lt::rt::violations();
    CAPTURE(found.allocations);
    CHECK(found.allocations == 0);
    CHECK(found.deallocations == 0);
}

TEST_CASE("one shot commands: JSON round trip") {
    const auto cmd = command_from_json(
        R"({"type":"SetOneShotBank","pads":[{"slot":3,"gain":0.5,"mode":"gate","quantize":"bar","choke_group":2},null]})");
    REQUIRE(std::holds_alternative<CmdSetOneShotBank>(cmd));
    const auto& c = std::get<CmdSetOneShotBank>(cmd);
    REQUIRE(c.pads.size() == 2);
    CHECK(c.pads[0].mode == "gate");
    CHECK(c.pads[0].quantize == "bar");
    CHECK(c.pads[1].slot == -1);
    CHECK(command_to_json(command_from_json(command_to_json(cmd))) == command_to_json(cmd));
    const auto config = command_from_json(R"({"type":"SetOneShotConfig","route":"monitor","gain":0.7})");
    REQUIRE(std::holds_alternative<CmdSetOneShotConfig>(config));
    CHECK(std::get<CmdSetOneShotConfig>(config).route == "monitor");
}
