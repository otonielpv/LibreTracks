#include <lt_engine/sources/audio_decoder.h>

#if LT_ENGINE_USE_FFMPEG

#include <algorithm>
#include <cstring>
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

    Result<void> open(const std::string& path) override {
        close();
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

        rc = avcodec_open2(codec_ctx_, codec, nullptr);
        if (rc < 0)
            return Result<void>::err("libav: codec open failed: " + av_error(rc));

        if (codec_ctx_->ch_layout.nb_channels <= 0)
            return Result<void>::err("libav: missing channel layout");
        if (codec_ctx_->sample_rate <= 0)
            return Result<void>::err("libav: missing sample rate");

        channels_ = codec_ctx_->ch_layout.nb_channels;
        sample_rate_ = codec_ctx_->sample_rate;
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
        if (rc < 0 || !swr_)
            return Result<void>::err("libav: swr allocation failed: " + av_error(rc));

        rc = swr_init(swr_);
        if (rc < 0)
            return Result<void>::err("libav: swr init failed: " + av_error(rc));

        auto decoded = decode_all();
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
        av_channel_layout_uninit(&output_layout_);
        if (codec_ctx_) {
            avcodec_free_context(&codec_ctx_);
        }
        if (format_) {
            avformat_close_input(&format_);
        }
    }

private:
    Result<std::vector<float>> decode_all() {
        std::unique_ptr<AVPacket, AvPacketDeleter> packet(av_packet_alloc());
        std::unique_ptr<AVFrame, AvFrameDeleter> frame(av_frame_alloc());
        if (!packet || !frame)
            return Result<std::vector<float>>::err("libav: packet/frame allocation failed");

        std::vector<float> out;
        int rc = 0;
        while ((rc = av_read_frame(format_, packet.get())) >= 0) {
            if (packet->stream_index == stream_index_) {
                auto sent = send_packet(packet.get(), frame.get(), out);
                if (sent.is_err())
                    return sent;
            }
            av_packet_unref(packet.get());
        }
        if (rc != AVERROR_EOF)
            return Result<std::vector<float>>::err("libav: read failed: " + av_error(rc));

        auto flushed = send_packet(nullptr, frame.get(), out);
        if (flushed.is_err())
            return flushed;

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
    AVChannelLayout output_layout_{};
    AudioFileInfo info_;
    std::vector<float> samples_;
    int stream_index_ = -1;
    int channels_ = 0;
    int sample_rate_ = 0;
    Frame cursor_frame_ = 0;
};

} // namespace

std::unique_ptr<AudioDecoder> make_libav_decoder() {
    return std::make_unique<LibavDecoder>();
}

} // namespace lt

#endif // LT_ENGINE_USE_FFMPEG
