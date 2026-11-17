// Plan drum-loops, paso 02: banco de muestras en RAM para loops y one shots.
#include <doctest/doctest.h>

#include <lt_engine/render/sample_bank.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <string>
#include <thread>
#include <vector>

using namespace lt;

namespace {

namespace fs = std::filesystem;

struct TempDir {
    fs::path path;
    TempDir() {
        path = fs::temp_directory_path()
             / ("lt_sample_bank_" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
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

void write_float_wav(const std::string& path, const std::vector<float>& interleaved,
                     int channels, int sample_rate) {
    std::ofstream out(path, std::ios::binary);
    auto u32 = [&](std::uint32_t v) { out.write(reinterpret_cast<const char*>(&v), 4); };
    auto u16 = [&](std::uint16_t v) { out.write(reinterpret_cast<const char*>(&v), 2); };
    const auto data_bytes = static_cast<std::uint32_t>(interleaved.size() * 4);
    out.write("RIFF", 4);
    u32(36 + data_bytes);
    out.write("WAVEfmt ", 8);
    u32(16);
    u16(3);
    u16(static_cast<std::uint16_t>(channels));
    u32(static_cast<std::uint32_t>(sample_rate));
    u32(static_cast<std::uint32_t>(sample_rate * channels * 4));
    u16(static_cast<std::uint16_t>(channels * 4));
    u16(32);
    out.write("data", 4);
    u32(data_bytes);
    out.write(reinterpret_cast<const char*>(interleaved.data()), data_bytes);
}

std::vector<float> tone(Frame frames, int channels, int sample_rate) {
    std::vector<float> out(static_cast<std::size_t>(frames * channels));
    for (Frame f = 0; f < frames; ++f) {
        const float v = 0.5f * static_cast<float>(
            std::sin(2.0 * 3.14159265358979 * 440.0 * static_cast<double>(f) / sample_rate));
        for (int c = 0; c < channels; ++c) out[static_cast<std::size_t>(f * channels + c)] = v;
    }
    return out;
}

// Las tres fixtures del criterio C1.
struct Fixtures {
    TempDir dir;
    std::string mono_44k = dir.file("mono44.wav");
    std::string stereo_48k = dir.file("stereo48.wav");
    std::string short_48k = dir.file("short.wav");
    Fixtures() {
        write_float_wav(mono_44k, tone(4410, 1, 44100), 1, 44100);  // 0,1 s
        write_float_wav(stereo_48k, tone(1000, 2, 48000), 2, 48000);
        write_float_wav(short_48k, tone(10, 1, 48000), 1, 48000);
    }
    std::vector<SampleLoadEntry> entries() const {
        return {{0, mono_44k}, {1, stereo_48k}, {2, short_48k}};
    }
};

long long frames_diff(Frame a, Frame b) {
    return std::llabs(static_cast<long long>(a) - static_cast<long long>(b));
}

} // namespace

TEST_CASE("sample bank: decodes mono 44.1k, stereo 48k and a short file at the device rate") {
    Fixtures fx;
    SampleBank bank;
    const auto result = bank.load(fx.entries(), 48000);
    REQUIRE(result.ok);
    REQUIRE(result.entries.size() == 3);
    for (const auto& e : result.entries) CHECK(e.ok);

    const SampleBankVersion* v = bank.acquire();
    REQUIRE(v != nullptr);
    CHECK(v->sample_rate == 48000);
    const Sample* mono = v->sample(0);
    const Sample* stereo = v->sample(1);
    const Sample* tiny = v->sample(2);
    REQUIRE(mono);
    REQUIRE(stereo);
    REQUIRE(tiny);
    CHECK(mono->channels == 1);  // mono se queda mono
    CHECK(frames_diff(mono->frames, 4800) <= 2);  // remuestreado a 48 k
    CHECK(stereo->channels == 2);
    CHECK(stereo->frames == 1000);
    CHECK(tiny->channels == 1);
    CHECK(tiny->frames == 10);
    CHECK(v->sample(3) == nullptr);
    CHECK(v->sample(-1) == nullptr);
    CHECK(result.total_bytes == mono->bytes() + stereo->bytes() + tiny->bytes());
    bank.end_block();
}

TEST_CASE("sample bank: over the memory cap returns an error and keeps the published bank") {
    Fixtures fx;
    SampleBank bank;
    REQUIRE(bank.load({{0, fx.short_48k}}, 48000).ok);
    const SampleBankVersion* before = bank.current_for_diagnostics();

    bank.set_max_bytes(1000);  // el estéreo de 1000 frames ocupa 8000 bytes
    const auto result = bank.load(fx.entries(), 48000);
    CHECK_FALSE(result.ok);
    CHECK(result.error.find("memory limit") != std::string::npos);
    CHECK(result.total_bytes > 1000);
    CHECK(bank.current_for_diagnostics() == before);
    CHECK(bank.retired_count() == 0);
}

TEST_CASE("sample bank: a retired version outlives its live voice and is freed by the command-thread drain") {
    Fixtures fx;
    SampleBank bank;
    REQUIRE(bank.load({{0, fx.stereo_48k}}, 48000).ok);

    // "Hilo de audio": arranca una voz sobre la versión actual.
    const SampleBankVersion* voice_version = nullptr;
    const Sample* voice_sample = nullptr;
    std::thread audio_start([&] {
        voice_version = bank.acquire();
        SampleBank::retain(voice_version);
        voice_sample = voice_version->sample(0);
        bank.end_block();
    });
    audio_start.join();
    REQUIRE(voice_sample != nullptr);
    const float first_value = voice_sample->data[2];

    const int destroyed_before = SampleBankVersion::debug_destroyed_count();
    REQUIRE(bank.load({{0, fx.short_48k}}, 48000).ok);  // publica otra versión
    CHECK(bank.retired_count() == 1);
    bank.collect_retired();
    CHECK(bank.retired_count() == 1);  // la voz sigue viva
    CHECK(SampleBankVersion::debug_destroyed_count() == destroyed_before);

    // La voz termina en el render con sus datos intactos; el render no libera.
    std::thread::id audio_thread_id;
    bool saw_new_version = false;
    bool data_intact = false;
    std::thread audio_finish([&] {
        audio_thread_id = std::this_thread::get_id();
        const SampleBankVersion* now = bank.acquire();
        saw_new_version = now != voice_version;
        data_intact = voice_sample->data[2] == first_value && voice_sample->frames == 1000;
        SampleBank::release(voice_version);
        bank.end_block();
    });
    audio_finish.join();
    CHECK(saw_new_version);
    CHECK(data_intact);
    CHECK(SampleBankVersion::debug_destroyed_count() == destroyed_before);
    CHECK(bank.retired_count() == 1);

    // El vaciado del hilo de comandos (aquí, el hilo del test) la libera.
    bank.collect_retired();
    CHECK(bank.retired_count() == 0);
    CHECK(SampleBankVersion::debug_destroyed_count() == destroyed_before + 1);
    CHECK(SampleBankVersion::debug_last_destroy_thread() == std::this_thread::get_id());
    CHECK(SampleBankVersion::debug_last_destroy_thread() != audio_thread_id);
}

TEST_CASE("sample bank: the version under the hazard pointer is not freed") {
    Fixtures fx;
    SampleBank bank;
    REQUIRE(bank.load({{0, fx.short_48k}}, 48000).ok);
    const SampleBankVersion* in_block = bank.acquire();  // bloque en curso
    REQUIRE(bank.load({{0, fx.stereo_48k}}, 48000).ok);
    bank.collect_retired();
    CHECK(bank.retired_count() == 1);
    CHECK(in_block->sample(0)->frames == 10);
    bank.end_block();
    bank.collect_retired();
    CHECK(bank.retired_count() == 0);
}

TEST_CASE("sample bank: a missing or corrupt file is reported in its entry and the rest loads") {
    Fixtures fx;
    const std::string corrupt = fx.dir.file("corrupt.wav");
    {
        std::ofstream out(corrupt, std::ios::binary);
        out << "this is not audio at all";
    }
    SampleBank bank;
    const auto result = bank.load(
        {{0, fx.short_48k}, {1, fx.dir.file("missing.wav")}, {2, corrupt}, {3, fx.stereo_48k}}, 48000);
    REQUIRE(result.ok);
    REQUIRE(result.entries.size() == 4);
    CHECK(result.entries[0].ok);
    CHECK_FALSE(result.entries[1].ok);
    CHECK_FALSE(result.entries[1].error.empty());
    CHECK_FALSE(result.entries[2].ok);
    CHECK_FALSE(result.entries[2].error.empty());
    CHECK(result.entries[3].ok);
    const SampleBankVersion* v = bank.acquire();
    CHECK(v->sample(0) != nullptr);
    CHECK(v->sample(1) == nullptr);
    CHECK(v->sample(2) == nullptr);
    CHECK(v->sample(3) != nullptr);
    bank.end_block();
}

TEST_CASE("sample bank: a device sample-rate change reloads at the new rate") {
    Fixtures fx;
    SampleBank bank;
    REQUIRE(bank.load(fx.entries(), 48000).ok);
    const auto result = bank.reload_for_sample_rate(96000);
    REQUIRE(result.ok);
    const SampleBankVersion* v = bank.acquire();
    CHECK(v->sample_rate == 96000);
    CHECK(frames_diff(v->sample(1)->frames, 2000) <= 2);
    CHECK(frames_diff(v->sample(0)->frames, 9600) <= 3);
    CHECK(v->sample(0)->sample_rate == 96000);
    bank.end_block();
    bank.collect_retired();
}

TEST_CASE("sample bank: reuses already decoded samples with the same path and rate") {
    Fixtures fx;
    SampleBank bank;
    REQUIRE(bank.load({{0, fx.stereo_48k}}, 48000).ok);
    const Sample* first = bank.current_for_diagnostics()->sample(0);
    REQUIRE(bank.load({{5, fx.stereo_48k}, {6, fx.short_48k}}, 48000).ok);
    CHECK(bank.current_for_diagnostics()->sample(5) == first);
    bank.collect_retired();
}

TEST_CASE("sample bank: JSON request and result") {
    SampleLoadRequest request;
    std::string error;
    REQUIRE(sample_load_request_from_json(
        R"({"samples":[{"slot":2,"path":"a.wav"}],"maxBytes":2048,"sampleRate":44100})", request, &error));
    REQUIRE(request.entries.size() == 1);
    CHECK(request.entries[0].slot == 2);
    CHECK(request.entries[0].path == "a.wav");
    CHECK(request.max_bytes == 2048);
    CHECK(request.sample_rate == 44100);
    CHECK_FALSE(sample_load_request_from_json("{nope", request, &error));

    SampleLoadResult result;
    result.ok = true;
    result.total_bytes = 40;
    result.sample_rate = 48000;
    result.entries.push_back({1, false, "missing", 0, 0});
    const auto j = nlohmann::json::parse(sample_load_result_to_json(result));
    CHECK(j["ok"] == true);
    CHECK(j["totalBytes"] == 40);
    CHECK(j["entries"][0]["slot"] == 1);
    CHECK(j["entries"][0]["error"] == "missing");
}
