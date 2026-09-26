#include <doctest/doctest.h>

#include "test_audio_fixtures.h"

#include <lt_engine/render/offline_renderer.h>
#include <lt_engine/sources/audio_decoder.h>
#include <lt_engine/sources/source_manager.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

using namespace lt;
using json = nlohmann::json;

namespace {

namespace fs = std::filesystem;

// Fresh scratch folder per test, removed on scope exit.
struct TempDir {
    fs::path path;
    TempDir() {
        path = fs::temp_directory_path() /
            ("lt_offline_render_" +
             std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
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

// Minimal 32-bit float WAV writer for fixtures.
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

std::vector<float> stereo_sine_at(Frame frames, double hz, int sample_rate) {
    std::vector<float> out(static_cast<std::size_t>(frames) * 2);
    for (Frame f = 0; f < frames; ++f) {
        const float v = 0.5f * static_cast<float>(
            std::sin(2.0 * 3.14159265358979323846 * hz * static_cast<double>(f) / sample_rate));
        out[static_cast<std::size_t>(f) * 2] = v;
        out[static_cast<std::size_t>(f) * 2 + 1] = v;
    }
    return out;
}

std::vector<float> constant_stereo(Frame frames, float value) {
    return std::vector<float>(static_cast<std::size_t>(frames) * 2, value);
}

struct Decoded {
    int channels = 0;
    int sample_rate = 0;
    std::vector<float> interleaved;
    Frame frames() const { return channels ? static_cast<Frame>(interleaved.size()) / channels : 0; }
    float at(Frame frame, int channel) const {
        return interleaved[static_cast<std::size_t>(frame * channels + channel)];
    }
};

Decoded read_wav(const std::string& path) {
    Decoded d;
    auto decoder = make_decoder(path);
    REQUIRE(static_cast<bool>(decoder));
    REQUIRE(decoder->open(path).is_ok());
    const auto info = decoder->info();
    d.channels = info.channel_count;
    d.sample_rate = info.original_sample_rate;
    std::vector<float> chunk(4096 * static_cast<std::size_t>(std::max(1, d.channels)));
    while (true) {
        const int got = decoder->read_frames(chunk.data(), 4096);
        if (got <= 0) break;
        d.interleaved.insert(d.interleaved.end(), chunk.begin(),
                             chunk.begin() + static_cast<std::ptrdiff_t>(got) * d.channels);
    }
    decoder->close();
    return d;
}

json clip_json(const std::string& id, const std::string& track_id, const std::string& file,
               double start, double duration) {
    return {{"id", id}, {"trackId", track_id}, {"filePath", file},
            {"timelineStartSeconds", start}, {"sourceStartSeconds", 0.0},
            {"durationSeconds", duration}, {"gain", 1.0}};
}

json track_json(const std::string& id, double gain = 1.0, double pan = 0.0) {
    return {{"id", id}, {"name", id}, {"kind", "audio"}, {"gain", gain}, {"pan", pan}};
}

json song_json(json tracks, json clips, json regions = json::array()) {
    return {{"id", "song"}, {"title", "Song"}, {"bpm", 120.0}, {"timeSignature", "4/4"},
            {"durationSeconds", 10.0}, {"tracks", std::move(tracks)},
            {"clips", std::move(clips)}, {"regions", std::move(regions)}};
}

OfflineRenderRequest base_request(const json& song, double start, double end) {
    OfflineRenderRequest req;
    req.project_json = song.dump();
    req.sample_rate = 48000;
    req.start_seconds = start;
    req.end_seconds = end;
    req.format = OfflineSampleFormat::Float32;
    return req;
}

} // namespace

TEST_CASE("offline render mixes only the chosen tracks, with their gain and pan") {
    TempDir dir;
    const std::string a = dir.file("a.wav");
    const std::string b = dir.file("b.wav");
    write_float_wav(a, constant_stereo(48000, 0.1f), 2, 48000);
    write_float_wav(b, constant_stereo(48000, 0.2f), 2, 48000);
    const json song = song_json(
        json::array({track_json("ta", 0.5), track_json("tb", 1.0, -1.0)}),
        json::array({clip_json("ca", "ta", a, 0.5, 1.0), clip_json("cb", "tb", b, 0.5, 1.0)}));

    SUBCASE("one track: the other is absent, onset lands on the clip start") {
        auto req = base_request(song, 0.0, 2.0);
        req.outputs.push_back({dir.file("mix.wav"), {"ta"}});
        auto result = render_offline(req);
        REQUIRE_MESSAGE(result.is_ok(), (result.is_err() ? result.error() : ""));
        const auto out = read_wav(dir.file("mix.wav"));
        CHECK(out.channels == 2);
        CHECK(out.sample_rate == 48000);
        CHECK(out.frames() == 96000);
        CHECK(out.at(23999, 0) == doctest::Approx(0.0f));
        CHECK(out.at(24000, 0) == doctest::Approx(0.05f));   // 0.1 x track gain 0.5
        CHECK(out.at(24000, 1) == doctest::Approx(0.05f));
        CHECK(out.at(72000, 0) == doctest::Approx(0.0f));    // clip ended at 1.5 s
    }

    SUBCASE("both tracks sum, and a hard-left pan empties the right side") {
        auto req = base_request(song, 0.0, 2.0);
        req.outputs.push_back({dir.file("mix.wav"), {"ta", "tb"}});
        REQUIRE(render_offline(req).is_ok());
        const auto out = read_wav(dir.file("mix.wav"));
        CHECK(out.at(30000, 0) == doctest::Approx(0.25f));   // 0.05 + 0.2
        CHECK(out.at(30000, 1) == doctest::Approx(0.05f));   // tb panned hard left
    }

    SUBCASE("raw stems ignore the mixer and write one file per track") {
        auto req = base_request(song, 0.0, 2.0);
        req.apply_mixer = false;
        req.outputs.push_back({dir.file("ta.wav"), {"ta"}});
        req.outputs.push_back({dir.file("tb.wav"), {"tb"}});
        auto result = render_offline(req);
        REQUIRE(result.is_ok());
        CHECK(result.unwrap().files.size() == 2);
        CHECK(read_wav(dir.file("ta.wav")).at(30000, 0) == doctest::Approx(0.1f));
        const auto tb = read_wav(dir.file("tb.wav"));
        CHECK(tb.at(30000, 0) == doctest::Approx(0.2f));
        CHECK(tb.at(30000, 1) == doctest::Approx(0.2f));
    }

    SUBCASE("a range starting inside the clip renders from that point") {
        auto req = base_request(song, 1.0, 1.25);
        req.outputs.push_back({dir.file("mix.wav"), {"ta"}});
        REQUIRE(render_offline(req).is_ok());
        const auto out = read_wav(dir.file("mix.wav"));
        CHECK(out.frames() == 12000);
        CHECK(out.at(0, 0) == doctest::Approx(0.05f));
    }

    SUBCASE("normalize brings the peak to the requested ceiling") {
        auto req = base_request(song, 0.0, 2.0);
        req.normalize = true;
        req.normalize_peak_db = -6.0;
        req.outputs.push_back({dir.file("mix.wav"), {"ta"}});
        REQUIRE(render_offline(req).is_ok());
        const auto out = read_wav(dir.file("mix.wav"));
        CHECK(out.at(30000, 0) == doctest::Approx(std::pow(10.0, -6.0 / 20.0)).epsilon(1e-4));
    }

    SUBCASE("mono output folds L and R") {
        auto req = base_request(song, 0.0, 2.0);
        req.channels = 1;
        req.outputs.push_back({dir.file("mix.wav"), {"ta", "tb"}});
        REQUIRE(render_offline(req).is_ok());
        const auto out = read_wav(dir.file("mix.wav"));
        CHECK(out.channels == 1);
        CHECK(out.at(30000, 0) == doctest::Approx(0.5f * (0.25f + 0.05f)));
    }

    SUBCASE("16-bit PCM quantises to the nearest step") {
        auto req = base_request(song, 0.0, 2.0);
        req.format = OfflineSampleFormat::Pcm16;
        req.dither = false;
        req.outputs.push_back({dir.file("mix.wav"), {"ta"}});
        REQUIRE(render_offline(req).is_ok());
        const auto out = read_wav(dir.file("mix.wav"));
        CHECK(fs::file_size(dir.file("mix.wav")) == 44u + 96000u * 2u * 2u);
        CHECK(out.at(30000, 0) == doctest::Approx(0.05f).epsilon(1e-3));
    }

    SUBCASE("unknown track ids are rejected before anything is written") {
        auto req = base_request(song, 0.0, 2.0);
        req.outputs.push_back({dir.file("mix.wav"), {"nope"}});
        CHECK(render_offline(req).is_err());
        CHECK_FALSE(fs::exists(dir.file("mix.wav")));
    }

    SUBCASE("cancelling stops and leaves no file behind") {
        auto req = base_request(song, 0.0, 2.0);
        req.outputs.push_back({dir.file("ta.wav"), {"ta"}});
        req.outputs.push_back({dir.file("tb.wav"), {"tb"}});
        int calls = 0;
        auto result = render_offline(req, [&](double fraction) {
            ++calls;
            return fraction < 0.6;   // let the first file finish, stop in the second
        });
        REQUIRE(result.is_err());
        CHECK(result.error() == "cancelled");
        CHECK(calls > 0);
        CHECK_FALSE(fs::exists(dir.file("ta.wav")));
        CHECK_FALSE(fs::exists(dir.file("tb.wav")));
    }
}

TEST_CASE("offline render: a folder expands to its tracks and carries its gain") {
    TempDir dir;
    const std::string a = dir.file("a.wav");
    write_float_wav(a, constant_stereo(48000, 0.4f), 2, 48000);
    json folder = {{"id", "f"}, {"name", "Folder"}, {"kind", "folder"}, {"gain", 0.5}};
    json child = track_json("child");
    child["parentTrackId"] = "f";
    const json song = song_json(json::array({folder, child}),
                                json::array({clip_json("c", "child", a, 0.0, 1.0)}));
    auto req = base_request(song, 0.0, 1.0);
    req.outputs.push_back({dir.file("mix.wav"), {"f"}});
    REQUIRE(render_offline(req).is_ok());
    CHECK(read_wav(dir.file("mix.wav")).at(1000, 0) == doctest::Approx(0.2f));
}

TEST_CASE("offline render reports a missing file and renders the rest") {
    TempDir dir;
    const std::string a = dir.file("a.wav");
    write_float_wav(a, constant_stereo(48000, 0.1f), 2, 48000);
    const json song = song_json(
        json::array({track_json("ta"), track_json("tb")}),
        json::array({clip_json("ca", "ta", a, 0.0, 1.0),
                     clip_json("cb", "tb", dir.file("gone.wav"), 0.0, 1.0)}));
    auto req = base_request(song, 0.0, 1.0);
    req.outputs.push_back({dir.file("mix.wav"), {"ta", "tb"}});
    auto result = render_offline(req);
    REQUIRE(result.is_ok());
    CHECK(result.unwrap().missing_clips == 1);
    CHECK(read_wav(dir.file("mix.wav")).at(1000, 0) == doctest::Approx(0.1f));
}

// Points the engine's PCM cache at a scratch folder for one test.
struct ScopedCacheDir {
    explicit ScopedCacheDir(const std::string& dir) {
#ifdef _WIN32
        _putenv_s("LIBRETRACKS_CACHE_DIR", dir.c_str());
#else
        setenv("LIBRETRACKS_CACHE_DIR", dir.c_str(), 1);
#endif
    }
    ~ScopedCacheDir() {
#ifdef _WIN32
        _putenv_s("LIBRETRACKS_CACHE_DIR", "");
#else
        unsetenv("LIBRETRACKS_CACHE_DIR");
#endif
    }
};

TEST_CASE("offline render reads the engine's PCM cache instead of decoding again") {
    // The cache holds a different value than the original on purpose: the
    // output says which of the two was read.
    TempDir dir;
    ScopedCacheDir cache(dir.file("cache"));
    const std::string original = dir.file("a.mp3.wav");
    write_float_wav(original, constant_stereo(48000, 0.1f), 2, 48000);
    const std::string cached = pcm_cache_file_for(original, original, 48000);
    fs::create_directories(fs::path(cached).parent_path());
    const json song = song_json(json::array({track_json("t")}),
                                json::array({clip_json("c", "t", original, 0.0, 1.0)}));

    SUBCASE("a complete conversion is used") {
        write_float_wav(cached, constant_stereo(48000, 0.3f), 2, 48000);
        auto req = base_request(song, 0.0, 1.0);
        req.outputs.push_back({dir.file("mix.wav"), {"t"}});
        REQUIRE(render_offline(req).is_ok());
        CHECK(read_wav(dir.file("mix.wav")).at(1000, 0) == doctest::Approx(0.3f));
    }

    SUBCASE("a conversion shorter than the clip is still used, as playback does") {
        // An MP3's decoded length is a few frames off the length the project
        // recorded; rejecting that is what made the cache miss on Android.
        write_float_wav(cached, constant_stereo(47000, 0.3f), 2, 48000);
        auto req = base_request(song, 0.0, 1.0);
        req.outputs.push_back({dir.file("mix.wav"), {"t"}});
        REQUIRE(render_offline(req).is_ok());
        CHECK(read_wav(dir.file("mix.wav")).at(1000, 0) == doctest::Approx(0.3f));
    }

    SUBCASE("an empty conversion (write not finalised) is ignored") {
        write_float_wav(cached, {}, 2, 48000);
        auto req = base_request(song, 0.0, 1.0);
        req.outputs.push_back({dir.file("mix.wav"), {"t"}});
        REQUIRE(render_offline(req).is_ok());
        CHECK(read_wav(dir.file("mix.wav")).at(1000, 0) == doctest::Approx(0.1f));
    }

    SUBCASE("a conversion at another rate is ignored") {
        write_float_wav(cached, constant_stereo(44100, 0.3f), 2, 44100);
        auto req = base_request(song, 0.0, 1.0);
        req.outputs.push_back({dir.file("mix.wav"), {"t"}});
        REQUIRE(render_offline(req).is_ok());
        CHECK(read_wav(dir.file("mix.wav")).at(1000, 0) == doctest::Approx(0.1f));
    }
}

TEST_CASE("offline render resamples a 44.1 kHz source to the output rate") {
    TempDir dir;
    const std::string a = dir.file("a441.wav");
    write_float_wav(a, stereo_sine_at(44100, 441.0, 44100), 2, 44100);
    const json song = song_json(json::array({track_json("t")}),
                                json::array({clip_json("c", "t", a, 0.0, 1.0)}));
    auto req = base_request(song, 0.0, 1.0);
    req.outputs.push_back({dir.file("mix.wav"), {"t"}});
    REQUIRE(render_offline(req).is_ok());
    const auto out = read_wav(dir.file("mix.wav"));
    CHECK(out.frames() == 48000);
    CHECK(test::estimate_frequency_hz(out.interleaved, 48000, 4800, 38400)
          == doctest::Approx(441.0).epsilon(0.01));
}

TEST_CASE("offline render follows the region transpose (varispeed without warp)") {
    TempDir dir;
    const std::string a = dir.file("sine.wav");
    write_float_wav(a, test::make_stereo_sine(96000, 441.0, 0.5f), 2, 48000);
    const json region = {{"id", "r"}, {"name", "R"}, {"startSeconds", 0.0},
                         {"endSeconds", 2.0}, {"transposeSemitones", 12}};
    const json song = song_json(json::array({track_json("t")}),
                                json::array({clip_json("c", "t", a, 0.0, 1.0)}),
                                json::array({region}));
    auto req = base_request(song, 0.0, 1.0);
    req.outputs.push_back({dir.file("mix.wav"), {"t"}});
    REQUIRE(render_offline(req).is_ok());
    const auto out = read_wav(dir.file("mix.wav"));
    CHECK(test::estimate_frequency_hz(out.interleaved, 48000, 4800, 38400)
          == doctest::Approx(882.0).epsilon(0.01));
}

#if LT_ENGINE_HAVE_BUNGEE
TEST_CASE("offline render time-stretches a warped region through Bungee, keeping pitch") {
    TempDir dir;
    const std::string a = dir.file("two_tones.wav");
    // 2 s at 441 Hz, then 2 s at 661.5 Hz. At warp ratio 2 the render reaches
    // the second tone halfway through; without warp it never would.
    auto source = stereo_sine_at(96000, 441.0, 48000);
    const auto second = stereo_sine_at(96000, 661.5, 48000);
    source.insert(source.end(), second.begin(), second.end());
    write_float_wav(a, source, 2, 48000);
    // Source at 60 BPM on a 120 BPM timeline: twice as fast, same pitch.
    const json region = {{"id", "r"}, {"name", "R"}, {"startSeconds", 0.0},
                         {"endSeconds", 2.0}, {"warpEnabled", true}, {"warpSourceBpm", 60.0}};
    const json song = song_json(json::array({track_json("t")}),
                                json::array({clip_json("c", "t", a, 0.0, 2.0)}),
                                json::array({region}));
    auto req = base_request(song, 0.0, 2.0);
    req.outputs.push_back({dir.file("mix.wav"), {"t"}});
    auto result = render_offline(req);
    REQUIRE_MESSAGE(result.is_ok(), (result.is_err() ? result.error() : ""));
    const auto out = read_wav(dir.file("mix.wav"));
    CHECK(out.frames() == 96000);
    // Audio from the very first block (the voice is primed, not warming up).
    float head_peak = 0.0f;
    for (Frame f = 0; f < 2400; ++f) head_peak = std::max(head_peak, std::abs(out.at(f, 0)));
    CHECK(head_peak > 0.2f);
    // Pitch kept (a varispeed would double it) and source consumed at 2x.
    CHECK(test::estimate_frequency_hz(out.interleaved, 48000, 9600, 28800)
          == doctest::Approx(441.0).epsilon(0.02));
    CHECK(test::estimate_frequency_hz(out.interleaved, 48000, 57600, 28800)
          == doctest::Approx(661.5).epsilon(0.02));
}
#endif

TEST_CASE("offline render request JSON round trip") {
    const json j = {
        {"project_json", "{}"}, {"sample_rate", 44100}, {"start_seconds", 1.0},
        {"end_seconds", 3.0}, {"format", "pcm16"}, {"channels", 1},
        {"normalize", true}, {"apply_mixer", false},
        {"outputs", json::array({{{"path", "x.wav"}, {"track_ids", {"a", "b"}},
                                  {"include_metronome", true}}})},
        {"metronome", {{"volume", 0.5}, {"beat_preset", 3}}},
    };
    auto parsed = offline_render_request_from_json(j.dump());
    REQUIRE(parsed.is_ok());
    const auto& r = parsed.unwrap();
    CHECK(r.sample_rate == 44100);
    CHECK(r.format == OfflineSampleFormat::Pcm16);
    CHECK(r.channels == 1);
    CHECK(r.normalize);
    CHECK_FALSE(r.apply_mixer);
    REQUIRE(r.outputs.size() == 1);
    CHECK(r.outputs[0].track_ids.size() == 2);
    CHECK(r.outputs[0].include_metronome);
    CHECK(r.metronome.beat_preset == 3);
    CHECK(offline_render_request_from_json(R"({"format":"mp3"})").is_err());
}
