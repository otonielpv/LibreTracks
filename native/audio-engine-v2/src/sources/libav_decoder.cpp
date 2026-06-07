#include <lt_engine/sources/audio_decoder.h>

#if LT_ENGINE_USE_FFMPEG

#include <algorithm>
#include <chrono>
#include <cstring>
#include <cmath>
#include <memory>
#include <string>
#include <thread>
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

void yield_to_ui_scheduler() {
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
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

        auto decoded = decode_all(estimated_duration_frames(stream), std::move(on_progress));
        if (decoded.is_err())
            return Result<void>::err(decoded.error());
        samples_ = decoded.take();
        cursor_frame_ = 0;

        info_.channel_count = channels_;
        info_.original_sample_rate = sample_rate_;
        info_.duration_frames = static_cast<Frame>(samples_.size() / channels_);
        info_.format = codec_name(params);
        return Result<void>::ok();
    }

    AudioFileInfo info() const override { return info_; }

    int read_frames(float* out, int frame_count) override {
        if (!out || frame_count <= 0 || channels_ <= 0)
            return 0;

        const Frame available = info_.duration_frames - cursor_frame_;
        if (available <= 0)
            return 0;

        const int readable = static_cast<int>(
            std::min<Frame>(available, static_cast<Frame>(frame_count)));
        const std::size_t offset = static_cast<std::size_t>(cursor_frame_) * channels_;
        const std::size_t count = static_cast<std::size_t>(readable) * channels_;
        std::memcpy(out, samples_.data() + offset, count * sizeof(float));
        cursor_frame_ += readable;
        return readable;
    }

    Result<void> seek(Frame frame) override {
        if (frame < 0 || frame > info_.duration_frames)
            return Result<void>::err("libav: seek out of range");
        cursor_frame_ = frame;
        return Result<void>::ok();
    }

    void close() override {
        samples_.clear();
        cursor_frame_ = 0;
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

    Result<std::vector<float>> decode_all(Frame estimated_total_frames,
                                          DecodeProgressCallback on_progress) {
        std::unique_ptr<AVPacket, AvPacketDeleter> packet(av_packet_alloc());
        std::unique_ptr<AVFrame, AvFrameDeleter> frame(av_frame_alloc());
        if (!packet || !frame)
            return Result<std::vector<float>>::err("libav: packet/frame allocation failed");

        std::vector<float> out;
        int last_reported = 1;
        auto report_progress = [&](int progress_pct) {
            if (!on_progress)
                return;
            progress_pct = std::clamp(progress_pct, 1, 70);
            if (progress_pct <= last_reported)
                return;
            last_reported = progress_pct;
            on_progress(progress_pct);
            yield_to_ui_scheduler();
        };
        report_progress(1);
        int rc = 0;
        while ((rc = av_read_frame(format_, packet.get())) >= 0) {
            if (packet->stream_index == stream_index_) {
                auto sent = send_packet(packet.get(), frame.get(), out);
                if (sent.is_err())
                    return sent;
                if (estimated_total_frames > 0 && channels_ > 0) {
                    const Frame decoded_frames =
                        static_cast<Frame>(out.size() / static_cast<std::size_t>(channels_));
                    const int progress_pct = 1 + static_cast<int>(
                        (std::min<Frame>(decoded_frames, estimated_total_frames) * 69)
                            / estimated_total_frames);
                    report_progress(progress_pct);
                }
            }
            av_packet_unref(packet.get());
        }
        if (rc != AVERROR_EOF)
            return Result<std::vector<float>>::err("libav: read failed: " + av_error(rc));

        auto flushed = send_packet(nullptr, frame.get(), out);
        if (flushed.is_err())
            return flushed;
        report_progress(70);

        return Result<std::vector<float>>::ok(std::move(out));
    }

    Result<std::vector<float>> send_packet(
        AVPacket* packet,
        AVFrame* frame,
        std::vector<float>& out) {
        int rc = avcodec_send_packet(codec_ctx_, packet);
        if (rc < 0)
            return Result<std::vector<float>>::err("libav: send packet failed: " + av_error(rc));

        while (true) {
            rc = avcodec_receive_frame(codec_ctx_, frame);
            if (rc == AVERROR(EAGAIN) || rc == AVERROR_EOF)
                break;
            if (rc < 0)
                return Result<std::vector<float>>::err("libav: receive frame failed: " + av_error(rc));

            auto converted = append_converted_frame(frame, out);
            av_frame_unref(frame);
            if (converted.is_err())
                return converted;
        }

        return Result<std::vector<float>>::ok({});
    }

    Result<std::vector<float>> append_converted_frame(
        AVFrame* frame,
        std::vector<float>& out) {
        const int capacity = swr_get_out_samples(swr_, frame->nb_samples);
        if (capacity < 0)
            return Result<std::vector<float>>::err("libav: swr capacity failed");

        std::vector<float> buffer(static_cast<std::size_t>(capacity) * channels_);
        uint8_t* out_planes[] = { reinterpret_cast<uint8_t*>(buffer.data()) };
        const int converted = swr_convert(
            swr_,
            out_planes,
            capacity,
            const_cast<const uint8_t**>(frame->extended_data),
            frame->nb_samples);
        if (converted < 0)
            return Result<std::vector<float>>::err("libav: swr convert failed: " + av_error(converted));

        buffer.resize(static_cast<std::size_t>(converted) * channels_);
        out.insert(out.end(), buffer.begin(), buffer.end());
        return Result<std::vector<float>>::ok({});
    }

    AVFormatContext* format_ = nullptr;
    AVCodecContext* codec_ctx_ = nullptr;
    SwrContext* swr_ = nullptr;
#if LT_LIBAV_HAS_CHANNEL_LAYOUT_API
    AVChannelLayout output_layout_{};
#else
    uint64_t output_channel_layout_ = 0;
#endif
    AudioFileInfo info_;
    std::vector<float> samples_;
    int stream_index_ = -1;
    int channels_ = 0;
    int sample_rate_ = 0;
    Frame cursor_frame_ = 0;

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
