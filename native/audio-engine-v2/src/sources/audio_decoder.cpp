#include <lt_engine/sources/audio_decoder.h>

#include <algorithm>
#include <cstring>
#include <stdexcept>
#include <string>

// ---------------------------------------------------------------------------
// Backend selection
// ---------------------------------------------------------------------------
#if defined(LT_USE_LIBSNDFILE)
#  include <sndfile.h>

// dr_mp3 — single-header MP3 decoder
#  define DR_MP3_IMPLEMENTATION
#  define DR_MP3_NO_STDIO
#  include "dr_mp3.h"

#endif // LT_USE_LIBSNDFILE

// ---------------------------------------------------------------------------
// Resampler selection
// ---------------------------------------------------------------------------
#if defined(LT_USE_R8BRAIN)
#  include <CDSPResampler.h>   // r8brain
#elif defined(LT_USE_LIBSAMPLERATE)
#  include <samplerate.h>
#endif

namespace lt {

// ============================================================================
// libsndfile decoder
// ============================================================================
#if defined(LT_USE_LIBSNDFILE)

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

// ---------------------------------------------------------------------------
// dr_mp3 decoder (MP3)
// ---------------------------------------------------------------------------
class DrMp3Decoder : public AudioDecoder {
public:
    ~DrMp3Decoder() override { close(); }

    Result<void> open(const std::string& path) override {
        if (!drmp3_init_file(&mp3_, path.c_str(), nullptr))
            return Result<void>::err("dr_mp3: failed to open " + path);

        info_.file_path             = path;
        info_.channel_count         = static_cast<int>(mp3_.channels);
        info_.original_sample_rate  = static_cast<int>(mp3_.sampleRate);
        info_.duration_frames       = static_cast<Frame>(drmp3_get_pcm_frame_count(&mp3_));
        info_.format                = "mp3";
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
    drmp3         mp3_{};
    AudioFileInfo info_;
    bool          open_ = false;
};

#endif // LT_USE_LIBSNDFILE

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

std::unique_ptr<AudioDecoder> make_decoder(const std::string& file_path) {
    std::string ext = file_extension(file_path);

#if defined(LT_USE_LIBSNDFILE)
    if (ext == "mp3") {
        return std::make_unique<DrMp3Decoder>();
    }
    // libsndfile handles wav, flac, ogg, aiff, and many others.
    return std::make_unique<SndfileDecoder>();
#else
    (void)ext;
    return nullptr;  // No decoder backend compiled.
#endif
}

// ============================================================================
// Resampler helper
// ============================================================================
static std::vector<float> resample_if_needed(
    const std::vector<float>& input,
    int                       in_channels,
    int                       in_rate,
    int                       out_rate,
    Frame                     in_frames)
{
    if (in_rate == out_rate) return input;

#if defined(LT_USE_R8BRAIN)
    // r8brain operates per-channel on non-interleaved data.
    Frame out_frames = static_cast<Frame>(
        std::ceil(static_cast<double>(in_frames) * out_rate / in_rate));

    std::vector<float> output(static_cast<size_t>(out_frames) * in_channels, 0.f);

    for (int ch = 0; ch < in_channels; ++ch) {
        // De-interleave channel.
        std::vector<double> ch_in(in_frames);
        for (Frame f = 0; f < in_frames; ++f)
            ch_in[f] = static_cast<double>(input[f * in_channels + ch]);

        r8b::CDSPResampler24 resampler(in_rate, out_rate,
                                       static_cast<int>(in_frames));

        double* out_ptr = nullptr;
        int produced = resampler.process(ch_in.data(),
                                          static_cast<int>(in_frames),
                                          out_ptr);
        Frame copy = std::min<Frame>(produced, out_frames);
        for (Frame f = 0; f < copy; ++f)
            output[f * in_channels + ch] = static_cast<float>(out_ptr[f]);
    }
    return output;

#elif defined(LT_USE_LIBSAMPLERATE)
    double ratio = static_cast<double>(out_rate) / in_rate;
    Frame out_frames = static_cast<Frame>(std::ceil(in_frames * ratio));
    std::vector<float> output(static_cast<size_t>(out_frames) * in_channels, 0.f);

    SRC_DATA src_data{};
    src_data.data_in       = input.data();
    src_data.input_frames  = static_cast<long>(in_frames);
    src_data.data_out      = output.data();
    src_data.output_frames = static_cast<long>(out_frames);
    src_data.src_ratio     = ratio;
    src_data.channels      = in_channels;

    // SRC_SINC_BEST_QUALITY = 0
    src_simple(&src_data, 0, in_channels);
    output.resize(static_cast<size_t>(src_data.output_frames_gen) * in_channels);
    return output;

#else
    // No resampler: return as-is (drift warning issued at session validation).
    return input;
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
    auto decoder = make_decoder(file_path);
    if (!decoder)
        return Result<std::vector<float>>::err("No decoder available for: " + file_path);

    auto open_result = decoder->open(file_path);
    if (open_result.is_err())
        return Result<std::vector<float>>::err(open_result.error());

    AudioFileInfo fi = decoder->info();
    if (fi.duration_frames <= 0 || fi.channel_count <= 0)
        return Result<std::vector<float>>::err("Invalid audio file info: " + file_path);

    // Read all frames.
    std::vector<float> raw(static_cast<size_t>(fi.duration_frames) * fi.channel_count);
    int read = decoder->read_frames(raw.data(), static_cast<int>(fi.duration_frames));
    decoder->close();

    if (read <= 0)
        return Result<std::vector<float>>::err("Failed to decode: " + file_path);

    raw.resize(static_cast<size_t>(read) * fi.channel_count);

    // Resample if needed.
    auto resampled = resample_if_needed(raw, fi.channel_count,
                                         fi.original_sample_rate,
                                         target_sample_rate,
                                         static_cast<Frame>(read));

    Frame out_frames = static_cast<Frame>(resampled.size()) / fi.channel_count;

    if (out_channel_count)   *out_channel_count   = fi.channel_count;
    if (out_duration_frames) *out_duration_frames  = out_frames;

    return Result<std::vector<float>>::ok(std::move(resampled));
}

} // namespace lt
