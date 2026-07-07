#include <lt_engine/sources/audio_decoder.h>
#include <lt_engine/sources/resampler.h>
#include <lt_engine/sources/io_throttle.h>
#include <lt_engine/core/fs_path.h>

#include <algorithm>
#include <cctype>
#include <chrono>
#include <string>
#include <thread>
#include <vector>

// ---------------------------------------------------------------------------
// Backend selection
// ---------------------------------------------------------------------------
#if LT_ENGINE_USE_LIBSNDFILE
// Must be set before <sndfile.h> so it declares sf_wchar_open() (the UTF-16
// path entry point we use on Windows for accented file names).
#  define ENABLE_SNDFILE_WINDOWS_PROTOTYPES 1
#  include <sndfile.h>
#  define DR_MP3_IMPLEMENTATION
#  include "dr_mp3.h"
#  define DR_FLAC_IMPLEMENTATION
#  include "dr_flac.h"

// dr_mp3 — single-header MP3 decoder
// dr_flac — single-header FLAC decoder (used when libsndfile is built without
// the FLAC codec, i.e. ENABLE_EXTERNAL_LIBS=OFF, and FFmpeg is not available)
#endif // LT_ENGINE_USE_LIBSNDFILE

namespace lt {

namespace {

void yield_to_ui_scheduler() {
    // Yields longer while the transport is playing so decoding a new import
    // doesn't starve the live audio stream. See io_throttle.h.
    decode_background_yield();
}

} // namespace

// ============================================================================
// libsndfile decoder
// ============================================================================
#if LT_ENGINE_USE_LIBSNDFILE

class SndfileDecoder : public AudioDecoder {
public:
    ~SndfileDecoder() override { close(); }

    Result<void> open(const std::string& path, DecodeProgressCallback on_progress = {}) override {
        (void)on_progress;
        SF_INFO info{};
#if defined(_WIN32)
        // sf_open uses the ANSI codepage for narrow paths; pass UTF-16 so
        // accented file names (e.g. "canción.wav") open correctly.
        sndfile_ = sf_wchar_open(to_wide(path).c_str(), SFM_READ, &info);
#else
        sndfile_ = sf_open(path.c_str(), SFM_READ, &info);
#endif
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

    Result<void> open(const std::string& path, DecodeProgressCallback on_progress = {}) override {
        (void)on_progress;
#if defined(_WIN32)
        if (!drmp3_init_file_w(&mp3_, to_wide(path).c_str(), nullptr))
#else
        if (!drmp3_init_file(&mp3_, path.c_str(), nullptr))
#endif
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

class DrFlacDecoder : public AudioDecoder {
public:
    ~DrFlacDecoder() override { close(); }

    Result<void> open(const std::string& path, DecodeProgressCallback on_progress = {}) override {
        (void)on_progress;
#if defined(_WIN32)
        flac_ = drflac_open_file_w(to_wide(path).c_str(), nullptr);
#else
        flac_ = drflac_open_file(path.c_str(), nullptr);
#endif
        if (!flac_)
            return Result<void>::err("dr_flac: failed to open " + path);

        info_.file_path = path;
        info_.channel_count = static_cast<int>(flac_->channels);
        info_.original_sample_rate = static_cast<int>(flac_->sampleRate);
        info_.duration_frames = static_cast<Frame>(flac_->totalPCMFrameCount);
        info_.format = "flac";
        return Result<void>::ok();
    }

    AudioFileInfo info() const override { return info_; }

    int read_frames(float* out, int frame_count) override {
        if (!flac_) return 0;
        return static_cast<int>(drflac_read_pcm_frames_f32(
            flac_, static_cast<drflac_uint64>(frame_count), out));
    }

    Result<void> seek(Frame frame) override {
        if (!flac_) return Result<void>::err("not open");
        if (!drflac_seek_to_pcm_frame(flac_, static_cast<drflac_uint64>(frame)))
            return Result<void>::err("dr_flac: seek failed");
        return Result<void>::ok();
    }

    void close() override {
        if (flac_) {
            drflac_close(flac_);
            flac_ = nullptr;
        }
    }

private:
    drflac*       flac_ = nullptr;
    AudioFileInfo info_;
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

#if LT_ENGINE_USE_FFMPEG
#  if LT_ENGINE_USE_LIBSNDFILE
    // libsndfile is built with ENABLE_EXTERNAL_LIBS=OFF (see dependencies.cmake),
    // so it only supports WAV/AIFF — it has NO FLAC/Ogg/Vorbis codec. Route FLAC
    // (and everything except plain WAV) to the libav/FFmpeg decoder, which has
    // full FLAC support. Sending FLAC to SndfileDecoder produces silence.
    if (ext != "wav" && ext != "wave") {
        return make_libav_decoder();
    }
#  else
    (void)ext;
    return make_libav_decoder();
#  endif
#endif

#if LT_ENGINE_USE_LIBSNDFILE
    if (ext == "mp3") {
        return std::make_unique<DrMp3Decoder>();
    }
    if (ext == "flac") {
        // libsndfile is built without the FLAC codec (ENABLE_EXTERNAL_LIBS=OFF),
        // so it cannot decode FLAC. Use the bundled dr_flac decoder instead.
        return std::make_unique<DrFlacDecoder>();
    }
#if defined(__ANDROID__)
    // Anything that isn't WAV/AIFF (libsndfile) or MP3/FLAC (dr_libs) goes
    // to the Android system codecs — AAC/M4A, OGG/Vorbis, Opus, 3GP... the
    // mobile counterpart of the desktop FFmpeg route (Ableton-style: decode
    // once with the OS, cache as PCM).
    if (ext != "wav" && ext != "wave" && ext != "aif" && ext != "aiff" &&
        ext != "aifc") {
        return make_mediacodec_decoder();
    }
#endif
    // libsndfile handles WAV/AIFF. (FLAC/OGG would need ENABLE_EXTERNAL_LIBS.)
    return std::make_unique<SndfileDecoder>();
#else
    (void)ext;
    return nullptr;  // No decoder backend compiled.
#endif
}

// ============================================================================
// decode_file_to_float32
// ============================================================================
Result<std::vector<float>> decode_file_to_float32(
    const std::string& file_path,
    int                target_sample_rate,
    int*               out_channel_count,
    Frame*             out_duration_frames,
    DecodeProgressCallback on_progress)
{
    auto report_progress = [&](int progress_pct) {
        if (on_progress) {
            on_progress(std::clamp(progress_pct, 0, 100));
            yield_to_ui_scheduler();
        }
    };

    const std::string normalized_path = normalize_input_path(file_path);
    auto decoder = make_decoder(normalized_path);
    if (!decoder)
        return Result<std::vector<float>>::err("No decoder available for: " + normalized_path);

    report_progress(1);
    auto open_result = decoder->open(normalized_path, on_progress);
    if (open_result.is_err()) {
        return Result<std::vector<float>>::err(open_result.error());
    }

    AudioFileInfo fi = decoder->info();
    if (fi.duration_frames <= 0 || fi.channel_count <= 0)
        return Result<std::vector<float>>::err("Invalid audio file info: " + normalized_path);

    std::vector<float> raw;
    raw.reserve(static_cast<size_t>(fi.duration_frames) * fi.channel_count);
    Frame total_read = 0;
    constexpr int kReadChunkFrames = 65536;
    while (total_read < fi.duration_frames) {
        const int frames_to_read = static_cast<int>(
            std::min<Frame>(kReadChunkFrames, fi.duration_frames - total_read));
        if (frames_to_read <= 0)
            break;
        const std::size_t old_size = raw.size();
        raw.resize(old_size + static_cast<std::size_t>(frames_to_read) * fi.channel_count);
        const int read = decoder->read_frames(raw.data() + old_size, frames_to_read);
        if (read <= 0) {
            raw.resize(old_size);
            break;
        }
        if (read < frames_to_read) {
            raw.resize(old_size + static_cast<std::size_t>(read) * fi.channel_count);
        }
        total_read += read;
        const int decode_pct = 1 + static_cast<int>(
            (std::min<Frame>(total_read, fi.duration_frames) * 69) / fi.duration_frames);
        report_progress(decode_pct);
    }
    decoder->close();

    if (total_read <= 0)
        return Result<std::vector<float>>::err("Failed to decode: " + normalized_path);

    report_progress(72);
    auto resampler = make_resampler();
    ResamplerDiagnostics resampler_diagnostics;
    auto resample_result = resampler->process(raw, fi.channel_count,
                                              fi.original_sample_rate,
                                              target_sample_rate,
                                              total_read,
                                              &resampler_diagnostics);
    if (resample_result.is_err()) {
        return Result<std::vector<float>>::err(resample_result.error());
    }
    auto resampled = resample_result.take();
    report_progress(85);

    Frame out_frames = static_cast<Frame>(resampled.size()) / fi.channel_count;

    if (out_channel_count)   *out_channel_count   = fi.channel_count;
    if (out_duration_frames) *out_duration_frames  = out_frames;

    return Result<std::vector<float>>::ok(std::move(resampled));
}

} // namespace lt
