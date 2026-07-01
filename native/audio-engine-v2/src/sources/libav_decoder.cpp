#include <lt_engine/sources/audio_decoder.h>

#if LT_ENGINE_USE_FFMPEG

#include <algorithm>
#include <cstring>
#include <cmath>
#include <memory>
#include <string>
#include <vector>

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/avutil.h>
#include <libavutil/channel_layout.h>
#include <libavutil/error.h>
#include <libavutil/samplefmt.h>
#include <libswresample/swresample.h>
}

namespace lt {

namespace {

#if LIBAVUTIL_VERSION_MAJOR >= 57
#define LT_LIBAV_HAS_CHANNEL_LAYOUT_API 1
#else
#define LT_LIBAV_HAS_CHANNEL_LAYOUT_API 0
#endif

struct AvPacketDeleter {
    void operator()(AVPacket* packet) const noexcept {
        if (packet) av_packet_free(&packet);
    }
};

struct AvFrameDeleter {
    void operator()(AVFrame* frame) const noexcept {
        if (frame) av_frame_free(&frame);
    }
};

std::string av_error(int code) {
    char buffer[AV_ERROR_MAX_STRING_SIZE] = {};
    av_strerror(code, buffer, sizeof(buffer));
    return buffer;
}

std::string codec_name(const AVCodecParameters* params) {
    if (!params) return "unknown";
    const AVCodecDescriptor* descriptor = avcodec_descriptor_get(params->codec_id);
    return descriptor && descriptor->name ? descriptor->name : "unknown";
}

class LibavDecoder : public AudioDecoder {
public:
    ~LibavDecoder() override { close(); }

    Result<void> open(const std::string& path, DecodeProgressCallback on_progress = {}) override {
        close();
        av_log_set_level(AV_LOG_ERROR);
        info_ = {};
        info_.file_path = path;

        AVFormatContext* raw_format = nullptr;
        int rc = avformat_open_input(&raw_format, path.c_str(), nullptr, nullptr);
        if (rc < 0)
            return Result<void>::err("libav: open failed: " + av_error(rc));
        format_ = raw_format;

        rc = avformat_find_stream_info(format_, nullptr);
        if (rc < 0)
            return Result<void>::err("libav: stream info failed: " + av_error(rc));

        rc = av_find_best_stream(format_, AVMEDIA_TYPE_AUDIO, -1, -1, nullptr, 0);
        if (rc < 0)
            return Result<void>::err("libav: no audio stream");
        stream_index_ = rc;

        AVStream* stream = format_->streams[stream_index_];
        const AVCodecParameters* params = stream->codecpar;
        const AVCodec* codec = avcodec_find_decoder(params->codec_id);
        if (!codec)
            return Result<void>::err("libav: decoder not found for " + codec_name(params));

        codec_ctx_ = avcodec_alloc_context3(codec);
        if (!codec_ctx_)
            return Result<void>::err("libav: codec context allocation failed");

        rc = avcodec_parameters_to_context(codec_ctx_, params);
        if (rc < 0)
            return Result<void>::err("libav: codec parameters failed: " + av_error(rc));

        // FFmpeg defaults to codec-dependent worker counts. During a cold
        // project open that can silently spawn many CPU-heavy decoder threads
        // from inside our single decode job and starve the WebView. Keep each
        // source decode single-threaded; DecodeWorkerPool controls outer
        // concurrency.
        codec_ctx_->thread_count = 1;

        rc = avcodec_open2(codec_ctx_, codec, nullptr);
        if (rc < 0)
            return Result<void>::err("libav: codec open failed: " + av_error(rc));

        const int channel_count = codec_channel_count();
        if (channel_count <= 0)
            return Result<void>::err("libav: missing channel count");
        if (codec_ctx_->sample_rate <= 0)
            return Result<void>::err("libav: missing sample rate");

        channels_ = channel_count;
        sample_rate_ = codec_ctx_->sample_rate;

#if LT_LIBAV_HAS_CHANNEL_LAYOUT_API
        av_channel_layout_default(&output_layout_, channels_);

        rc = swr_alloc_set_opts2(
            &swr_,
            &output_layout_,
            AV_SAMPLE_FMT_FLT,
            sample_rate_,
            &codec_ctx_->ch_layout,
            codec_ctx_->sample_fmt,
            sample_rate_,
            0,
            nullptr);
#else
        output_channel_layout_ = av_get_default_channel_layout(channels_);
        const uint64_t input_channel_layout =
            codec_ctx_->channel_layout != 0
                ? codec_ctx_->channel_layout
                : av_get_default_channel_layout(channels_);

        swr_ = swr_alloc_set_opts(
            nullptr,
            static_cast<int64_t>(output_channel_layout_),
            AV_SAMPLE_FMT_FLT,
            sample_rate_,
            static_cast<int64_t>(input_channel_layout),
            codec_ctx_->sample_fmt,
            sample_rate_,
            0,
            nullptr);
        rc = swr_ ? 0 : AVERROR(ENOMEM);
#endif
        if (rc < 0 || !swr_)
            return Result<void>::err("libav: swr allocation failed: " + av_error(rc));

        rc = swr_init(swr_);
        if (rc < 0)
            return Result<void>::err("libav: swr init failed: " + av_error(rc));

        packet_.reset(av_packet_alloc());
        frame_.reset(av_frame_alloc());
        if (!packet_ || !frame_)
            return Result<void>::err("libav: packet/frame allocation failed");

        info_.channel_count = channels_;
        info_.original_sample_rate = sample_rate_;
        info_.duration_frames = estimated_duration_frames(stream);
        info_.format = codec_name(params);
        (void)on_progress;
        return Result<void>::ok();
    }

    AudioFileInfo info() const override { return info_; }

    int read_frames(float* out, int frame_count) override {
        if (!out || frame_count <= 0 || channels_ <= 0)
            return 0;

        int copied = copy_pending(out, frame_count);
        while (copied < frame_count && !decoder_eof_ && !decode_failed_) {
            if (receive_one_frame()) {
                copied += copy_pending(
                    out + static_cast<std::size_t>(copied) * channels_,
                    frame_count - copied);
                continue;
            }

            if (decoder_eof_ || decode_failed_)
                break;

            const StepResult step = send_next_packet_or_flush();
            if (step == StepResult::Failed || step == StepResult::Done)
                break;
        }

        return copied;
    }

    Result<void> seek(Frame frame) override {
        if (frame < 0 || (info_.duration_frames > 0 && frame > info_.duration_frames))
            return Result<void>::err("libav: seek out of range");
        if (!format_ || !codec_ctx_ || stream_index_ < 0)
            return Result<void>::err("libav: not open");

        AVStream* stream = format_->streams[stream_index_];
        const int64_t timestamp = av_rescale_q(
            frame,
            AVRational{1, sample_rate_},
            stream->time_base);
        const int rc = av_seek_frame(format_, stream_index_, timestamp, AVSEEK_FLAG_BACKWARD);
        if (rc < 0)
            return Result<void>::err("libav: seek failed: " + av_error(rc));

        avcodec_flush_buffers(codec_ctx_);
        clear_pending();
        discard_pending_packet();
        input_eof_ = false;
        flush_sent_ = false;
        decoder_eof_ = false;
        decode_failed_ = false;
        return Result<void>::ok();
    }

    void close() override {
        clear_pending();
        discard_pending_packet();
        packet_.reset();
        frame_.reset();
        input_eof_ = false;
        flush_sent_ = false;
        decoder_eof_ = false;
        decode_failed_ = false;
        info_ = {};
        stream_index_ = -1;
        channels_ = 0;
        sample_rate_ = 0;
        if (swr_) {
            swr_free(&swr_);
        }
#if LT_LIBAV_HAS_CHANNEL_LAYOUT_API
        av_channel_layout_uninit(&output_layout_);
#else
        output_channel_layout_ = 0;
#endif
        if (codec_ctx_) {
            avcodec_free_context(&codec_ctx_);
        }
        if (format_) {
            avformat_close_input(&format_);
        }
    }

private:
    enum class StepResult {
        Sent,
        NeedReceive,
        Done,
        Failed
    };

    Frame estimated_duration_frames(const AVStream* stream) const {
        if (!stream || sample_rate_ <= 0)
            return 0;
        if (stream->duration > 0) {
            return static_cast<Frame>(
                av_rescale_q(stream->duration, stream->time_base, AVRational{1, sample_rate_}));
        }
        if (format_ && format_->duration > 0) {
            const double seconds = static_cast<double>(format_->duration) / AV_TIME_BASE;
            return static_cast<Frame>(std::max(0.0, seconds * sample_rate_));
        }
        return 0;
    }

    int copy_pending(float* out, int max_frames) {
        if (!out || max_frames <= 0 || pending_.empty())
            return 0;
        const Frame total_frames =
            static_cast<Frame>(pending_.size() / static_cast<std::size_t>(channels_));
        const Frame available = total_frames - pending_offset_frames_;
        if (available <= 0) {
            clear_pending();
            return 0;
        }

        const int frames = static_cast<int>(
            std::min<Frame>(available, static_cast<Frame>(max_frames)));
        const std::size_t sample_offset =
            static_cast<std::size_t>(pending_offset_frames_) * channels_;
        const std::size_t sample_count =
            static_cast<std::size_t>(frames) * channels_;
        std::memcpy(out, pending_.data() + sample_offset, sample_count * sizeof(float));
        pending_offset_frames_ += frames;
        if (pending_offset_frames_ >= total_frames)
            clear_pending();
        return frames;
    }

    void clear_pending() {
        pending_.clear();
        pending_offset_frames_ = 0;
    }

    void discard_pending_packet() {
        if (packet_ && packet_pending_)
            av_packet_unref(packet_.get());
        packet_pending_ = false;
    }

    StepResult send_next_packet_or_flush() {
        if (!format_ || !codec_ctx_ || !packet_)
            return StepResult::Failed;

        if (packet_pending_) {
            const int rc = avcodec_send_packet(codec_ctx_, packet_.get());
            if (rc == AVERROR(EAGAIN))
                return StepResult::NeedReceive;
            av_packet_unref(packet_.get());
            packet_pending_ = false;
            if (rc < 0) {
                decode_failed_ = true;
                return StepResult::Failed;
            }
            return StepResult::Sent;
        }

        if (input_eof_) {
            if (flush_sent_)
                return StepResult::Done;
            const int rc = avcodec_send_packet(codec_ctx_, nullptr);
            if (rc == AVERROR(EAGAIN))
                return StepResult::NeedReceive;
            flush_sent_ = true;
            if (rc == AVERROR_EOF) {
                decoder_eof_ = true;
                return StepResult::Done;
            }
            if (rc < 0) {
                decode_failed_ = true;
                return StepResult::Failed;
            }
            return StepResult::Sent;
        }

        while (true) {
            const int rc = av_read_frame(format_, packet_.get());
            if (rc == AVERROR_EOF) {
                input_eof_ = true;
                return send_next_packet_or_flush();
            }
            if (rc < 0) {
                decode_failed_ = true;
                return StepResult::Failed;
            }

            if (packet_->stream_index != stream_index_) {
                av_packet_unref(packet_.get());
                continue;
            }

            packet_pending_ = true;
            return send_next_packet_or_flush();
        }
    }

    bool receive_one_frame() {
        if (!codec_ctx_ || !frame_ || decoder_eof_ || decode_failed_)
            return false;

        const int rc = avcodec_receive_frame(codec_ctx_, frame_.get());
        if (rc == AVERROR(EAGAIN))
            return false;
        if (rc == AVERROR_EOF) {
            decoder_eof_ = true;
            return false;
        }
        if (rc < 0) {
            decode_failed_ = true;
            return false;
        }

        const bool ok = append_converted_frame(frame_.get());
        av_frame_unref(frame_.get());
        if (!ok)
            decode_failed_ = true;
        return ok;
    }

    bool append_converted_frame(AVFrame* frame) {
        const int capacity = swr_get_out_samples(swr_, frame->nb_samples);
        if (capacity < 0)
            return false;

        std::vector<float> buffer(static_cast<std::size_t>(capacity) * channels_);
        uint8_t* out_planes[] = { reinterpret_cast<uint8_t*>(buffer.data()) };
        const int converted = swr_convert(
            swr_,
            out_planes,
            capacity,
            const_cast<const uint8_t**>(frame->extended_data),
            frame->nb_samples);
        if (converted < 0)
            return false;

        buffer.resize(static_cast<std::size_t>(converted) * channels_);
        pending_.insert(pending_.end(), buffer.begin(), buffer.end());
        return true;
    }

    AVFormatContext* format_ = nullptr;
    AVCodecContext* codec_ctx_ = nullptr;
    SwrContext* swr_ = nullptr;
    std::unique_ptr<AVPacket, AvPacketDeleter> packet_;
    std::unique_ptr<AVFrame, AvFrameDeleter> frame_;
#if LT_LIBAV_HAS_CHANNEL_LAYOUT_API
    AVChannelLayout output_layout_{};
#else
    uint64_t output_channel_layout_ = 0;
#endif
    AudioFileInfo info_;
    std::vector<float> pending_;
    int stream_index_ = -1;
    int channels_ = 0;
    int sample_rate_ = 0;
    Frame pending_offset_frames_ = 0;
    bool packet_pending_ = false;
    bool input_eof_ = false;
    bool flush_sent_ = false;
    bool decoder_eof_ = false;
    bool decode_failed_ = false;

    int codec_channel_count() const {
#if LT_LIBAV_HAS_CHANNEL_LAYOUT_API
        return codec_ctx_ ? codec_ctx_->ch_layout.nb_channels : 0;
#else
        return codec_ctx_ ? codec_ctx_->channels : 0;
#endif
    }
};

} // namespace

std::unique_ptr<AudioDecoder> make_libav_decoder() {
    return std::make_unique<LibavDecoder>();
}

} // namespace lt

#endif // LT_ENGINE_USE_FFMPEG
