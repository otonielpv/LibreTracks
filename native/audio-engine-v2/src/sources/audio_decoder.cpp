#include <lt_engine/sources/audio_decoder.h>
#include <lt_engine/sources/resampler.h>

#include <algorithm>
#include <cctype>
#include <string>
#include <vector>

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

#if LT_ENGINE_USE_FFMPEG
#  if LT_ENGINE_USE_LIBSNDFILE
    if (ext != "wav" && ext != "wave" && ext != "flac") {
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
    // libsndfile handles WAV/FLAC/OGG/AIFF when compiled with those backends.
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
    Frame*             out_duration_frames)
{
    const std::string normalized_path = normalize_input_path(file_path);
    auto decoder = make_decoder(normalized_path);
    if (!decoder)
        return Result<std::vector<float>>::err("No decoder available for: " + normalized_path);

    auto open_result = decoder->open(normalized_path);
    if (open_result.is_err()) {
        return Result<std::vector<float>>::err(open_result.error());
    }

    AudioFileInfo fi = decoder->info();
    if (fi.duration_frames <= 0 || fi.channel_count <= 0)
        return Result<std::vector<float>>::err("Invalid audio file info: " + normalized_path);

    // Read all frames.
    std::vector<float> raw(static_cast<size_t>(fi.duration_frames) * fi.channel_count);
    int read = decoder->read_frames(raw.data(), static_cast<int>(fi.duration_frames));
    decoder->close();

    if (read <= 0)
        return Result<std::vector<float>>::err("Failed to decode: " + normalized_path);

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
