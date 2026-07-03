// ---------------------------------------------------------------------------
// MediaCodecDecoder — Android system-codec decoder (NDK AMediaExtractor +
// AMediaCodec).
//
// The Android counterpart of the desktop FFmpeg route: everything
// libsndfile + dr_libs can't decode (AAC/M4A, OGG/Vorbis, Opus, 3GP, ...)
// goes through the OS codecs, exactly like Ableton leans on CoreAudio on
// macOS. Zero extra binary size — the codecs ship with the device.
//
// Contract notes:
//  - Forward streaming decode (the cache-priming path reads 0 → EOF).
//    seek() is supported via extractor sync-seek + codec flush + decode-skip
//    to the exact frame (used by the prebuffer worker).
//  - info().duration_frames derives from the container duration; lossy
//    containers are allowed to be a few frames off — the cache writer
//    flushes/truncates to its projected length either way.
//  - MediaCodec outputs interleaved int16 PCM by default; converted to
//    float here. INFO_OUTPUT_FORMAT_CHANGED updates channel/rate info.
// ---------------------------------------------------------------------------

#if defined(__ANDROID__)

#include <lt_engine/debug/logging.h>
#include <lt_engine/sources/audio_decoder.h>

#include <media/NdkMediaCodec.h>
#include <media/NdkMediaExtractor.h>
#include <media/NdkMediaFormat.h>

#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#include <algorithm>
#include <cerrno>
#include <cstdio>
#include <cstring>
#include <deque>
#include <string>
#include <vector>

namespace lt {

namespace {

constexpr int64_t kDequeueTimeoutUs = 10000;  // 10 ms per pump step
constexpr int kMaxPumpIterations = 512;       // watchdog per read_frames call

class MediaCodecDecoder final : public AudioDecoder {
public:
    ~MediaCodecDecoder() override { close(); }

    Result<void> open(const std::string& file_path,
                      DecodeProgressCallback /*on_progress*/ = {}) override {
        close();

        extractor_ = AMediaExtractor_new();
        if (!extractor_)
            return Result<void>::err("MediaCodec: could not create extractor");

        // Use the fd variant: AMediaExtractor_setDataSource(path) routes
        // through the media HTTP/content resolver machinery and fails for
        // plain app-private paths on modern Android. An fd we opened
        // ourselves always works (the extractor dups it).
        const int fd = ::open(file_path.c_str(), O_RDONLY | O_CLOEXEC);
        if (fd < 0) {
            lt_debug_log( "[LT_MEDIACODEC] open('%s') failed: errno=%d\n",
                         file_path.c_str(), errno);
            close();
            return Result<void>::err(
                "MediaCodec: could not open file " + file_path);
        }
        struct stat st {};
        const int64_t file_size = ::fstat(fd, &st) == 0 ? st.st_size : 0;
        media_status_t status = AMediaExtractor_setDataSourceFd(
            extractor_, fd, 0, file_size);
        ::close(fd);
        if (status != AMEDIA_OK) {
            lt_debug_log(
                         "[LT_MEDIACODEC] setDataSourceFd('%s', %lld B) failed: %d\n",
                         file_path.c_str(), static_cast<long long>(file_size),
                         static_cast<int>(status));
            close();
            return Result<void>::err(
                "MediaCodec: could not open " + file_path);
        }

        const size_t track_count = AMediaExtractor_getTrackCount(extractor_);
        std::string mime_type;
        AMediaFormat* track_format = nullptr;
        for (size_t track = 0; track < track_count; ++track) {
            AMediaFormat* format =
                AMediaExtractor_getTrackFormat(extractor_, track);
            const char* mime = nullptr;
            if (format &&
                AMediaFormat_getString(format, AMEDIAFORMAT_KEY_MIME, &mime) &&
                mime && std::strncmp(mime, "audio/", 6) == 0) {
                AMediaExtractor_selectTrack(extractor_, track);
                track_format = format;
                mime_type = mime;
                break;
            }
            if (format)
                AMediaFormat_delete(format);
        }
        if (!track_format) {
            lt_debug_log( "[LT_MEDIACODEC] no audio track in '%s'\n",
                         file_path.c_str());
            close();
            return Result<void>::err(
                "MediaCodec: no audio track in " + file_path);
        }

        int32_t sample_rate = 0;
        int32_t channel_count = 0;
        int64_t duration_us = 0;
        AMediaFormat_getInt32(track_format, AMEDIAFORMAT_KEY_SAMPLE_RATE,
                              &sample_rate);
        AMediaFormat_getInt32(track_format, AMEDIAFORMAT_KEY_CHANNEL_COUNT,
                              &channel_count);
        AMediaFormat_getInt64(track_format, AMEDIAFORMAT_KEY_DURATION,
                              &duration_us);

        codec_ = AMediaCodec_createDecoderByType(mime_type.c_str());
        if (!codec_) {
            lt_debug_log( "[LT_MEDIACODEC] no decoder for mime '%s'\n",
                         mime_type.c_str());
            AMediaFormat_delete(track_format);
            close();
            return Result<void>::err(
                "MediaCodec: no decoder for " + mime_type);
        }
        status = AMediaCodec_configure(codec_, track_format, nullptr, nullptr, 0);
        AMediaFormat_delete(track_format);
        if (status != AMEDIA_OK) {
            lt_debug_log( "[LT_MEDIACODEC] configure failed for '%s': %d\n",
                         mime_type.c_str(), static_cast<int>(status));
            close();
            return Result<void>::err(
                "MediaCodec: configure failed for " + mime_type);
        }
        if (AMediaCodec_start(codec_) != AMEDIA_OK) {
            lt_debug_log( "[LT_MEDIACODEC] start failed for '%s'\n",
                         mime_type.c_str());
            close();
            return Result<void>::err(
                "MediaCodec: start failed for " + mime_type);
        }

        info_.file_path = file_path;
        info_.channel_count = std::max(1, channel_count);
        info_.original_sample_rate = std::max(1, sample_rate);
        info_.duration_frames = static_cast<Frame>(
            (static_cast<long double>(std::max<int64_t>(0, duration_us)) *
             info_.original_sample_rate) /
            1000000.0L);
        const auto dot = file_path.rfind('.');
        info_.format = dot == std::string::npos
            ? "unknown"
            : file_path.substr(dot + 1);

        input_eos_ = false;
        output_eos_ = false;
        skip_frames_ = 0;
        pending_.clear();
        lt_debug_log(
                     "[LT_MEDIACODEC] opened '%s' mime=%s sr=%d ch=%d frames=%lld\n",
                     file_path.c_str(), mime_type.c_str(),
                     info_.original_sample_rate, info_.channel_count,
                     static_cast<long long>(info_.duration_frames));
        return Result<void>::ok();
    }

    AudioFileInfo info() const override { return info_; }

    int read_frames(float* out, int frame_count) override {
        if (!codec_ || !extractor_ || frame_count <= 0)
            return 0;
        const int channels = info_.channel_count;
        const size_t want_samples =
            static_cast<size_t>(frame_count) * channels;

        int guard = 0;
        while (pending_.size() < want_samples && !output_eos_ &&
               guard++ < kMaxPumpIterations) {
            pump_once();
        }

        const size_t emit_samples =
            std::min(pending_.size(), want_samples);
        const int emit_frames = static_cast<int>(emit_samples / channels);
        const size_t aligned = static_cast<size_t>(emit_frames) * channels;
        for (size_t i = 0; i < aligned; ++i) {
            out[i] = pending_[i];
        }
        pending_.erase(pending_.begin(),
                       pending_.begin() + static_cast<long>(aligned));
        return emit_frames;
    }

    Result<void> seek(Frame frame) override {
        if (!codec_ || !extractor_)
            return Result<void>::err("MediaCodec: seek before open");
        const int64_t target_us = static_cast<int64_t>(
            (static_cast<long double>(std::max<Frame>(0, frame)) * 1000000.0L) /
            info_.original_sample_rate);
        AMediaExtractor_seekTo(extractor_, target_us,
                               AMEDIAEXTRACTOR_SEEK_PREVIOUS_SYNC);
        AMediaCodec_flush(codec_);
        pending_.clear();
        input_eos_ = false;
        output_eos_ = false;
        // The extractor landed on the previous sync sample; decode-skip the
        // difference so the next read_frames starts exactly at `frame`.
        const int64_t landed_us = AMediaExtractor_getSampleTime(extractor_);
        const Frame landed_frame = landed_us <= 0
            ? 0
            : static_cast<Frame>(
                  (static_cast<long double>(landed_us) *
                   info_.original_sample_rate) /
                  1000000.0L);
        skip_frames_ = std::max<Frame>(0, frame - landed_frame);
        return Result<void>::ok();
    }

    void close() override {
        if (codec_) {
            AMediaCodec_stop(codec_);
            AMediaCodec_delete(codec_);
            codec_ = nullptr;
        }
        if (extractor_) {
            AMediaExtractor_delete(extractor_);
            extractor_ = nullptr;
        }
        pending_.clear();
    }

private:
    // One extractor→codec pump step: feed one input buffer (if available)
    // and drain one output buffer (if ready) into `pending_` as floats.
    void pump_once() {
        if (!input_eos_) {
            const ssize_t in_index =
                AMediaCodec_dequeueInputBuffer(codec_, kDequeueTimeoutUs);
            if (in_index >= 0) {
                size_t capacity = 0;
                uint8_t* in_buf = AMediaCodec_getInputBuffer(
                    codec_, static_cast<size_t>(in_index), &capacity);
                const ssize_t sample_size = in_buf
                    ? AMediaExtractor_readSampleData(extractor_, in_buf,
                                                     capacity)
                    : -1;
                if (sample_size < 0) {
                    input_eos_ = true;
                    AMediaCodec_queueInputBuffer(
                        codec_, static_cast<size_t>(in_index), 0, 0, 0,
                        AMEDIACODEC_BUFFER_FLAG_END_OF_STREAM);
                } else {
                    const int64_t pts_us =
                        AMediaExtractor_getSampleTime(extractor_);
                    AMediaCodec_queueInputBuffer(
                        codec_, static_cast<size_t>(in_index), 0,
                        static_cast<size_t>(sample_size),
                        static_cast<uint64_t>(std::max<int64_t>(0, pts_us)),
                        0);
                    AMediaExtractor_advance(extractor_);
                }
            }
        }

        AMediaCodecBufferInfo buffer_info{};
        const ssize_t out_index = AMediaCodec_dequeueOutputBuffer(
            codec_, &buffer_info, kDequeueTimeoutUs);
        if (out_index >= 0) {
            if (buffer_info.size > 0) {
                size_t capacity = 0;
                const uint8_t* out_buf = AMediaCodec_getOutputBuffer(
                    codec_, static_cast<size_t>(out_index), &capacity);
                if (out_buf) {
                    append_pcm16(reinterpret_cast<const int16_t*>(
                                     out_buf + buffer_info.offset),
                                 static_cast<size_t>(buffer_info.size) / 2);
                }
            }
            if (buffer_info.flags & AMEDIACODEC_BUFFER_FLAG_END_OF_STREAM) {
                output_eos_ = true;
            }
            AMediaCodec_releaseOutputBuffer(
                codec_, static_cast<size_t>(out_index), false);
        } else if (out_index == AMEDIACODEC_INFO_OUTPUT_FORMAT_CHANGED) {
            AMediaFormat* format = AMediaCodec_getOutputFormat(codec_);
            if (format) {
                int32_t sample_rate = 0;
                int32_t channel_count = 0;
                if (AMediaFormat_getInt32(format,
                                          AMEDIAFORMAT_KEY_SAMPLE_RATE,
                                          &sample_rate) &&
                    sample_rate > 0) {
                    info_.original_sample_rate = sample_rate;
                }
                if (AMediaFormat_getInt32(format,
                                          AMEDIAFORMAT_KEY_CHANNEL_COUNT,
                                          &channel_count) &&
                    channel_count > 0) {
                    info_.channel_count = channel_count;
                }
                AMediaFormat_delete(format);
            }
        }
    }

    void append_pcm16(const int16_t* samples, size_t sample_count) {
        const int channels = std::max(1, info_.channel_count);
        size_t start = 0;
        if (skip_frames_ > 0) {
            const size_t skip_samples = std::min(
                sample_count,
                static_cast<size_t>(skip_frames_) * channels);
            start = skip_samples;
            skip_frames_ -= static_cast<Frame>(skip_samples / channels);
        }
        constexpr float kScale = 1.0f / 32768.0f;
        for (size_t i = start; i < sample_count; ++i) {
            pending_.push_back(static_cast<float>(samples[i]) * kScale);
        }
    }

    AMediaExtractor* extractor_ = nullptr;
    AMediaCodec* codec_ = nullptr;
    AudioFileInfo info_;
    std::deque<float> pending_;
    bool input_eos_ = false;
    bool output_eos_ = false;
    Frame skip_frames_ = 0;
};

} // namespace

std::unique_ptr<AudioDecoder> make_mediacodec_decoder() {
    return std::make_unique<MediaCodecDecoder>();
}

} // namespace lt

#endif // __ANDROID__
