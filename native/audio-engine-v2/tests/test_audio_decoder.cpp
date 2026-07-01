#include <doctest/doctest.h>
#include <lt_engine/sources/audio_decoder.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <string>

using namespace lt;

namespace {

std::string quote(const std::string& value) {
    std::string quoted = "\"";
    for (char c : value) {
        if (c == '"') quoted += "\\\"";
        else quoted += c;
    }
    quoted += "\"";
    return quoted;
}

bool ffmpeg_available() {
#ifdef _WIN32
    return std::system("ffmpeg -version > nul 2>&1") == 0;
#else
    return std::system("ffmpeg -version > /dev/null 2>&1") == 0;
#endif
}

float peak(const std::vector<float>& samples) {
    float p = 0.0f;
    for (float sample : samples)
        p = std::max(p, std::abs(sample));
    return p;
}

} // namespace

TEST_CASE("MP3 decode via FFmpeg CLI fallback produces non-silent PCM when ffmpeg is available") {
    if (!ffmpeg_available())
        return;

    auto path = std::filesystem::temp_directory_path() /
        ("libretracks_decoder_smoke_" +
         std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()) + ".mp3");
    std::filesystem::remove(path);
    std::string command =
        "ffmpeg -y -v error -f lavfi -i \"sine=frequency=440:duration=0.25\" "
        "-ac 2 -ar 48000 " + quote(path.string());
    if (std::system(command.c_str()) != 0 || !std::filesystem::exists(path))
        return;

    int channels = 0;
    Frame frames = 0;
    std::string decode_path = path.string();
#ifdef _WIN32
    std::replace(decode_path.begin(), decode_path.end(), '\\', '/');
    decode_path = "?//?/" + decode_path;
#endif
    auto decoded = decode_file_to_float32(decode_path, 48000, &channels, &frames);
    std::filesystem::remove(path);

    REQUIRE(decoded.is_ok());
    auto samples = decoded.take();
    CHECK(channels == 2);
    CHECK(frames > 0);
    CHECK(peak(samples) > 0.001f);
}

TEST_CASE("MP3 decoder open defers PCM decoding until read_frames") {
    if (!ffmpeg_available())
        return;

    auto path = std::filesystem::temp_directory_path() /
        ("libretracks_decoder_streaming_" +
         std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()) + ".mp3");
    std::filesystem::remove(path);
    std::string command =
        "ffmpeg -y -v error -f lavfi -i \"sine=frequency=660:duration=1.0\" "
        "-ac 2 -ar 48000 " + quote(path.string());
    if (std::system(command.c_str()) != 0 || !std::filesystem::exists(path))
        return;

    auto decoder = make_decoder(path.string());
    REQUIRE(static_cast<bool>(decoder));

    int progress_calls = 0;
    auto opened = decoder->open(path.string(), [&](int) { ++progress_calls; });
    REQUIRE(opened.is_ok());
    CHECK(progress_calls == 0);

    const AudioFileInfo info = decoder->info();
    REQUIRE(info.channel_count > 0);
    std::vector<float> chunk(static_cast<std::size_t>(1024) * info.channel_count);
    const int read = decoder->read_frames(chunk.data(), 1024);
    decoder->close();
    std::filesystem::remove(path);

    REQUIRE(read > 0);
    chunk.resize(static_cast<std::size_t>(read) * info.channel_count);
    CHECK(peak(chunk) > 0.001f);
}
