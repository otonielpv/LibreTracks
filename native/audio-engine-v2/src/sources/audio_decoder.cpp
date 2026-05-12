#include <lt_engine/sources/audio_decoder.h>
#include <lt_engine/sources/resampler.h>

#include <algorithm>
#include <chrono>
#include <cctype>
#include <cstdint>
#include <cstring>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <stdexcept>
#include <string>
#include <vector>

#ifdef _WIN32
#  define NOMINMAX
#  include <windows.h>
#endif

// ---------------------------------------------------------------------------
// Backend selection
// ---------------------------------------------------------------------------
#if LT_ENGINE_USE_LIBSNDFILE
#  include <sndfile.h>
#  define DR_MP3_IMPLEMENTATION
#  include "dr_mp3.h"

// dr_mp3 — single-header MP3 decoder
#endif // LT_ENGINE_USE_LIBSNDFILE

namespace lt {

// ============================================================================
// libsndfile decoder
// ============================================================================
#if LT_ENGINE_USE_LIBSNDFILE

class SndfileDecoder : public AudioDecoder {
public:
    ~SndfileDecoder() override { close(); }

    Result<void> open(const std::string& path) override {
        SF_INFO info{};
        sndfile_ = sf_open(path.c_str(), SFM_READ, &info);
        if (!sndfile_)
            return Result<void>::err(std::string("sndfile: ") + sf_strerror(nullptr));
        info_           = {};
        info_.file_path = path;
        info_.channel_count        = info.channels;
        info_.original_sample_rate = info.samplerate;
        info_.duration_frames      = info.frames;
        info_.format               = detect_format(info.format);
        return Result<void>::ok();
    }

    AudioFileInfo info() const override { return info_; }

    int read_frames(float* out, int frame_count) override {
        if (!sndfile_) return 0;
        return static_cast<int>(sf_readf_float(sndfile_, out, frame_count));
    }

    Result<void> seek(Frame frame) override {
        if (!sndfile_) return Result<void>::err("not open");
        sf_count_t pos = sf_seek(sndfile_, static_cast<sf_count_t>(frame), SEEK_SET);
        if (pos < 0)
            return Result<void>::err("seek failed");
        return Result<void>::ok();
    }

    void close() override {
        if (sndfile_) {
            sf_close(sndfile_);
            sndfile_ = nullptr;
        }
    }

private:
    SNDFILE*      sndfile_ = nullptr;
    AudioFileInfo info_;

    static std::string detect_format(int sf_format) {
        int base = sf_format & SF_FORMAT_TYPEMASK;
        switch (base) {
            case SF_FORMAT_WAV:   return "wav";
            case SF_FORMAT_FLAC:  return "flac";
            case SF_FORMAT_OGG:   return "ogg";
            case SF_FORMAT_AIFF:  return "aiff";
            default:              return "unknown";
        }
    }
};

class DrMp3Decoder : public AudioDecoder {
public:
    ~DrMp3Decoder() override { close(); }

    Result<void> open(const std::string& path) override {
        if (!drmp3_init_file(&mp3_, path.c_str(), nullptr))
            return Result<void>::err("dr_mp3: failed to open " + path);

        info_.file_path = path;
        info_.channel_count = static_cast<int>(mp3_.channels);
        info_.original_sample_rate = static_cast<int>(mp3_.sampleRate);
        info_.duration_frames = static_cast<Frame>(drmp3_get_pcm_frame_count(&mp3_));
        info_.format = "mp3";
        drmp3_seek_to_pcm_frame(&mp3_, 0);
        open_ = true;
        return Result<void>::ok();
    }

    AudioFileInfo info() const override { return info_; }

    int read_frames(float* out, int frame_count) override {
        if (!open_) return 0;
        return static_cast<int>(drmp3_read_pcm_frames_f32(&mp3_, frame_count, out));
    }

    Result<void> seek(Frame frame) override {
        if (!open_) return Result<void>::err("not open");
        if (!drmp3_seek_to_pcm_frame(&mp3_, static_cast<drmp3_uint64>(frame)))
            return Result<void>::err("dr_mp3: seek failed");
        return Result<void>::ok();
    }

    void close() override {
        if (open_) {
            drmp3_uninit(&mp3_);
            open_ = false;
        }
    }

private:
    drmp3 mp3_{};
    AudioFileInfo info_;
    bool open_ = false;
};

#endif // LT_ENGINE_USE_LIBSNDFILE

// ============================================================================
// Factory
// ============================================================================
static std::string file_extension(const std::string& path) {
    auto pos = path.rfind('.');
    if (pos == std::string::npos) return "";
    std::string ext = path.substr(pos + 1);
    for (auto& c : ext) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return ext;
}

static std::string normalize_input_path(std::string path) {
    std::replace(path.begin(), path.end(), '\\', '/');
    while (!path.empty() && (path.front() == '?' || path.front() == '"' || path.front() == '\'')) {
        path.erase(path.begin());
    }
    while (!path.empty() && (path.back() == '"' || path.back() == '\'')) {
        path.pop_back();
    }
    if (path.rfind("//?/", 0) == 0) path.erase(0, 4);
    if (path.rfind("/?/", 0) == 0) path.erase(0, 3);
    if (path.rfind("file:///", 0) == 0) path.erase(0, 8);
    return path;
}

std::unique_ptr<AudioDecoder> make_decoder(const std::string& file_path) {
    std::string ext = file_extension(normalize_input_path(file_path));

#if LT_ENGINE_USE_LIBSNDFILE
    if (ext == "mp3") {
        return std::make_unique<DrMp3Decoder>();
    }
    // libsndfile handles WAV/FLAC/OGG/AIFF when compiled with those backends.
    return std::make_unique<SndfileDecoder>();
#else
    (void)ext;
    return nullptr;  // No decoder backend compiled.
#endif
}

static bool ffmpeg_cli_preferred(const std::string& ext) {
    return ext == "mp3" || ext == "m4a" || ext == "aac" || ext == "ogg" ||
           ext == "oga" || ext == "flac" || ext == "aif" || ext == "aiff";
}

static std::string shell_quote(const std::string& value) {
    std::string quoted = "\"";
    for (char c : value) {
        if (c == '"') quoted += "\\\"";
        else quoted += c;
    }
    quoted += "\"";
    return quoted;
}

static int run_decode_command(const std::string& command_body) {
#ifdef _WIN32
    int wide_len = MultiByteToWideChar(CP_UTF8, 0, command_body.c_str(), -1, nullptr, 0);
    if (wide_len <= 0) return -1;
    std::vector<wchar_t> command_line(static_cast<std::size_t>(wide_len));
    MultiByteToWideChar(CP_UTF8, 0, command_body.c_str(), -1,
                        command_line.data(), wide_len);

    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    PROCESS_INFORMATION process{};
    BOOL ok = CreateProcessW(
        nullptr,
        command_line.data(),
        nullptr,
        nullptr,
        FALSE,
        CREATE_NO_WINDOW,
        nullptr,
        nullptr,
        &startup,
        &process);
    if (!ok) return -1;

    WaitForSingleObject(process.hProcess, INFINITE);
    DWORD exit_code = 1;
    if (!GetExitCodeProcess(process.hProcess, &exit_code)) {
        exit_code = 1;
    }
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    return static_cast<int>(exit_code);
#else
    return std::system(command_body.c_str());
#endif
}

static bool executable_exists(const std::string& path) {
    return std::filesystem::exists(path) && !std::filesystem::is_directory(path);
}

static std::string resolve_ffmpeg_executable() {
    const char* configured = std::getenv("LIBRETRACKS_FFMPEG_PATH");
    if (configured && configured[0]) return configured;

#ifdef _WIN32
    const std::vector<std::string> candidates = {
        "C:/Program Files/ffmpeg/bin/ffmpeg.exe",
        "C:/Program Files (x86)/ffmpeg/bin/ffmpeg.exe",
        "C:/Program Files/Ardour9/video/harvid/ffmpeg.exe"
    };
    for (const auto& candidate : candidates) {
        if (executable_exists(candidate))
            return candidate;
    }
    return "ffmpeg";
#else
    const std::vector<std::string> candidates = {
        "/usr/bin/ffmpeg",
        "/usr/local/bin/ffmpeg",
        "/opt/homebrew/bin/ffmpeg"
    };
    for (const auto& candidate : candidates) {
        if (executable_exists(candidate))
            return candidate;
    }
    return "ffmpeg";
#endif
}

static Result<std::vector<float>> decode_with_ffmpeg_cli(
    const std::string& file_path,
    int target_sample_rate,
    int* out_channel_count,
    Frame* out_duration_frames)
{
    const std::string normalized_path = normalize_input_path(file_path);
    const std::string ffmpeg = resolve_ffmpeg_executable();

    std::filesystem::path temp_path =
        std::filesystem::temp_directory_path() /
        ("libretracks_decode_" + std::to_string(std::hash<std::string>{}(normalized_path)) +
         "_" + std::to_string(target_sample_rate) + "_" +
         std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()) + ".f32le");

    std::filesystem::remove(temp_path);

    std::string command =
        shell_quote(ffmpeg) +
        " -y -v error -i " + shell_quote(normalized_path) +
        " -map 0:a:0 -vn -sn -dn -f f32le -acodec pcm_f32le -ac 2 -ar " +
        std::to_string(target_sample_rate) + " " + shell_quote(temp_path.string());

    int rc = run_decode_command(command);
    if (rc != 0 || !std::filesystem::exists(temp_path)) {
        std::filesystem::remove(temp_path);
        return Result<std::vector<float>>::err(
            "ffmpeg cli decode failed for: " + file_path +
            " using " + ffmpeg +
            " (set LIBRETRACKS_FFMPEG_PATH to a valid ffmpeg executable)");
    }

    std::ifstream in(temp_path, std::ios::binary | std::ios::ate);
    if (!in) {
        std::filesystem::remove(temp_path);
        return Result<std::vector<float>>::err("ffmpeg cli output could not be opened");
    }
    const std::streamoff bytes = in.tellg();
    if (bytes <= 0 || (static_cast<std::uintmax_t>(bytes) % (sizeof(float) * 2)) != 0) {
        std::filesystem::remove(temp_path);
        return Result<std::vector<float>>::err("ffmpeg cli produced invalid PCM output");
    }

    std::vector<float> samples(static_cast<std::size_t>(bytes) / sizeof(float));
    in.seekg(0, std::ios::beg);
    in.read(reinterpret_cast<char*>(samples.data()), bytes);
    const bool ok = in.good() || in.eof();
    in.close();
    std::filesystem::remove(temp_path);
    if (!ok || samples.empty())
        return Result<std::vector<float>>::err("ffmpeg cli PCM read failed");

    if (out_channel_count) *out_channel_count = 2;
    if (out_duration_frames) *out_duration_frames = static_cast<Frame>(samples.size() / 2);
    return Result<std::vector<float>>::ok(std::move(samples));
}

// ============================================================================
// decode_file_to_float32
// ============================================================================
Result<std::vector<float>> decode_file_to_float32(
    const std::string& file_path,
    int                target_sample_rate,
    int*               out_channel_count,
    Frame*             out_duration_frames)
{
    const std::string normalized_path = normalize_input_path(file_path);
    std::string ext = file_extension(normalized_path);
    std::string ffmpeg_error;
    if (ffmpeg_cli_preferred(ext)) {
        auto ffmpeg_result = decode_with_ffmpeg_cli(normalized_path, target_sample_rate,
                                                    out_channel_count, out_duration_frames);
        if (ffmpeg_result.is_ok())
            return ffmpeg_result;
        ffmpeg_error = ffmpeg_result.error();
    }

    auto decoder = make_decoder(normalized_path);
    if (!decoder)
        return Result<std::vector<float>>::err(
            ffmpeg_error.empty() ? "No decoder available for: " + normalized_path : ffmpeg_error);

    auto open_result = decoder->open(normalized_path);
    if (open_result.is_err()) {
        std::string err = open_result.error();
        if (!ffmpeg_error.empty()) err = ffmpeg_error + "; fallback decoder: " + err;
        return Result<std::vector<float>>::err(err);
    }

    AudioFileInfo fi = decoder->info();
    if (fi.duration_frames <= 0 || fi.channel_count <= 0)
        return Result<std::vector<float>>::err(
            ffmpeg_error.empty() ? "Invalid audio file info: " + normalized_path
                                 : ffmpeg_error + "; fallback decoder: invalid audio file info");

    // Read all frames.
    std::vector<float> raw(static_cast<size_t>(fi.duration_frames) * fi.channel_count);
    int read = decoder->read_frames(raw.data(), static_cast<int>(fi.duration_frames));
    decoder->close();

    if (read <= 0)
        return Result<std::vector<float>>::err(
            ffmpeg_error.empty() ? "Failed to decode: " + normalized_path
                                 : ffmpeg_error + "; fallback decoder failed to decode");

    raw.resize(static_cast<size_t>(read) * fi.channel_count);

    // Resample if needed.
    auto resampler = make_resampler();
    ResamplerDiagnostics resampler_diagnostics;
    auto resample_result = resampler->process(raw, fi.channel_count,
                                              fi.original_sample_rate,
                                              target_sample_rate,
                                              static_cast<Frame>(read),
                                              &resampler_diagnostics);
    if (resample_result.is_err()) {
        return Result<std::vector<float>>::err(resample_result.error());
    }
    auto resampled = resample_result.take();

    Frame out_frames = static_cast<Frame>(resampled.size()) / fi.channel_count;

    if (out_channel_count)   *out_channel_count   = fi.channel_count;
    if (out_duration_frames) *out_duration_frames  = out_frames;

    return Result<std::vector<float>>::ok(std::move(resampled));
}

} // namespace lt
