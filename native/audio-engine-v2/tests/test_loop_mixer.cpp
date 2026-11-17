// Plan drum-loops: el loop a través del Mixer real (el camino de la app), con
// el transporte parado, con play/stop de la canción y con el ▶ del panel.
#include <doctest/doctest.h>

#include <lt_engine/render/mixer.h>
#include <lt_engine/scheduler/jump_scheduler.h>
#include <lt_engine/sources/source_manager.h>
#include <lt_engine/transport/transport_clock.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <memory>
#include <string>
#include <vector>

using namespace lt;

namespace {

namespace fs = std::filesystem;
constexpr int kSr = 48000;
constexpr int kBlock = 512;

std::string write_impulse(const fs::path& dir) {
    const std::string path = (dir / "imp.wav").string();
    const std::vector<float> mono = {1.0f, 0.0f, 0.0f, 0.0f};
    std::ofstream out(path, std::ios::binary);
    auto u32 = [&](std::uint32_t v) { out.write(reinterpret_cast<const char*>(&v), 4); };
    auto u16 = [&](std::uint16_t v) { out.write(reinterpret_cast<const char*>(&v), 2); };
    out.write("RIFF", 4);
    u32(36 + 16);
    out.write("WAVEfmt ", 8);
    u32(16);
    u16(3);
    u16(1);
    u32(kSr);
    u32(kSr * 4);
    u16(4);
    u16(32);
    out.write("data", 4);
    u32(16);
    out.write(reinterpret_cast<const char*>(mono.data()), 16);
    return path;
}

struct Rig {
    fs::path dir = fs::temp_directory_path()
                 / ("lt_loop_mixer_" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    SourceManager sources;
    TransportClock clock{kSr};
    JumpScheduler scheduler;
    std::shared_ptr<Session> session;
    std::unique_ptr<Mixer> mixer;
    std::vector<float> left = std::vector<float>(kBlock), right = std::vector<float>(kBlock);

    Rig() {
        fs::create_directories(dir);
        session = std::make_shared<Session>();
        session->sample_rate = kSr;
        Song song;
        song.id = "song";
        song.end_frame = kSr * 60;
        song.bpm = 120.0;
        session->songs.push_back(song);
        mixer = std::make_unique<Mixer>(session, &sources, &clock, &scheduler);
        mixer->set_active_output_channels({0, 1});
        REQUIRE(mixer->sample_bank().load({{0, write_impulse(dir)}}, kSr).ok);
        LoopPatternData p;
        p.row_count = 1;
        p.rows[0].slot = 0;
        for (int s = 0; s < 16; ++s) p.rows[0].steps[0][static_cast<std::size_t>(s)] = 2;
        mixer->loop_renderer().set_pattern(p);
    }
    ~Rig() {
        mixer.reset();
        std::error_code ec;
        fs::remove_all(dir, ec);
    }

    /// Onsets en `blocks` bloques.
    int render(int blocks) {
        int onsets = 0;
        for (int b = 0; b < blocks; ++b) {
            float* out[] = {left.data(), right.data()};
            mixer->render(out, 2, kBlock, kSr);
            for (float v : left) onsets += std::abs(v) > 0.05f ? 1 : 0;
        }
        return onsets;
    }
};

} // namespace

TEST_CASE("loop through the mixer: the panel button starts and stops it with the transport stopped") {
    Rig rig;
    CHECK(rig.render(40) == 0);
    rig.mixer->loop_renderer().toggle_transport();
    CHECK(rig.render(40) > 0);  // 40 × 512 ≈ 0,43 s: varias semicorcheas a 120
    CHECK(rig.mixer->loop_renderer().playing());
    rig.mixer->loop_renderer().set_transport(false);
    LoopConfig cfg;
    cfg.quantize = LoopQuantize::Immediate;
    rig.mixer->loop_renderer().set_config(cfg);
    rig.render(15);  // inmediato = en el siguiente paso (≤ 6000 frames)
    CHECK_FALSE(rig.mixer->loop_renderer().playing());
    CHECK(rig.render(40) == 0);
}

TEST_CASE("loop through the mixer: follows the song's play and stop") {
    Rig rig;
    rig.clock.play();
    rig.clock.clear_pending_start();
    CHECK(rig.render(40) > 0);
    CHECK(rig.mixer->loop_renderer().playing());
    rig.clock.stop();
    rig.render(1);
    CHECK_FALSE(rig.mixer->loop_renderer().playing());
    CHECK(rig.render(40) == 0);
}

TEST_CASE("loop through the mixer: without follow, the song's play does not start it") {
    Rig rig;
    LoopConfig cfg;
    cfg.follow_transport = false;
    rig.mixer->loop_renderer().set_config(cfg);
    rig.clock.play();
    rig.clock.clear_pending_start();
    CHECK(rig.render(40) == 0);
    CHECK_FALSE(rig.mixer->loop_renderer().playing());
}
