#include <lt_engine/sources/resampler.h>

#include <algorithm>
#include <cmath>
#include <memory>

#if LT_ENGINE_USE_R8BRAIN
#  include <CDSPResampler.h>
#elif LT_ENGINE_USE_LIBSAMPLERATE
#  include <samplerate.h>
#endif

namespace lt {

namespace {

class EngineResampler final : public Resampler {
public:
    Result<std::vector<float>> process(const std::vector<float>& input,
                                       int channels,
                                       int source_sample_rate,
                                       int target_sample_rate,
                                       Frame input_frames,
                                       ResamplerDiagnostics* diagnostics) override {
        if (channels <= 0 || source_sample_rate <= 0 || target_sample_rate <= 0 || input_frames < 0) {
            return Result<std::vector<float>>::err("invalid resampler configuration");
        }

        if (source_sample_rate == target_sample_rate) {
            fill_diagnostics(diagnostics, channels, source_sample_rate, target_sample_rate,
                             input_frames, input_frames, "bypass");
            return Result<std::vector<float>>::ok(input);
        }

#if LT_ENGINE_USE_R8BRAIN
        const Frame output_frames = static_cast<Frame>(
            std::ceil(static_cast<double>(input_frames) *
                      static_cast<double>(target_sample_rate) /
                      static_cast<double>(source_sample_rate)));
        std::vector<float> output(static_cast<std::size_t>(output_frames) *
                                      static_cast<std::size_t>(channels),
                                  0.0f);

        for (int channel = 0; channel < channels; ++channel) {
            std::vector<double> channel_input(static_cast<std::size_t>(input_frames));
            for (Frame frame = 0; frame < input_frames; ++frame) {
                channel_input[static_cast<std::size_t>(frame)] =
                    static_cast<double>(input[static_cast<std::size_t>(frame) *
                                              static_cast<std::size_t>(channels) +
                                              static_cast<std::size_t>(channel)]);
            }

            r8b::CDSPResampler24 resampler(source_sample_rate, target_sample_rate,
                                           static_cast<int>(input_frames));
            double* channel_output = nullptr;
            const int produced = resampler.process(channel_input.data(),
                                                   static_cast<int>(input_frames),
                                                   channel_output);
            const Frame copy_frames = std::min<Frame>(produced, output_frames);
            for (Frame frame = 0; frame < copy_frames; ++frame) {
                output[static_cast<std::size_t>(frame) * static_cast<std::size_t>(channels) +
                       static_cast<std::size_t>(channel)] =
                    static_cast<float>(channel_output[frame]);
            }
        }
        fill_diagnostics(diagnostics, channels, source_sample_rate, target_sample_rate,
                         input_frames, output_frames, "r8brain");
        return Result<std::vector<float>>::ok(std::move(output));
#elif LT_ENGINE_USE_LIBSAMPLERATE
        const double ratio = static_cast<double>(target_sample_rate) /
                             static_cast<double>(source_sample_rate);
        const Frame output_frames = static_cast<Frame>(
            std::ceil(static_cast<double>(input_frames) * ratio));
        std::vector<float> output(static_cast<std::size_t>(output_frames) *
                                      static_cast<std::size_t>(channels),
                                  0.0f);

        SRC_DATA src_data{};
        src_data.data_in = input.data();
        src_data.input_frames = static_cast<long>(input_frames);
        src_data.data_out = output.data();
        src_data.output_frames = static_cast<long>(output_frames);
        src_data.src_ratio = ratio;
        src_data.channels = channels;

        const int rc = src_simple(&src_data, SRC_SINC_BEST_QUALITY, channels);
        if (rc != 0) {
            return Result<std::vector<float>>::err(std::string("libsamplerate: ") +
                                                   src_strerror(rc));
        }
        output.resize(static_cast<std::size_t>(src_data.output_frames_gen) *
                      static_cast<std::size_t>(channels));
        fill_diagnostics(diagnostics, channels, source_sample_rate, target_sample_rate,
                         input_frames, src_data.output_frames_gen, "libsamplerate");
        return Result<std::vector<float>>::ok(std::move(output));
#else
        fill_diagnostics(diagnostics, channels, source_sample_rate, target_sample_rate,
                         input_frames, input_frames, "none");
        return Result<std::vector<float>>::ok(input);
#endif
    }

private:
    static void fill_diagnostics(ResamplerDiagnostics* diagnostics,
                                 int channels,
                                 int source_sample_rate,
                                 int target_sample_rate,
                                 Frame input_frames,
                                 Frame output_frames,
                                 std::string backend) {
        if (!diagnostics) return;
        diagnostics->channels = channels;
        diagnostics->source_sample_rate = source_sample_rate;
        diagnostics->target_sample_rate = target_sample_rate;
        diagnostics->input_frames = input_frames;
        diagnostics->output_frames = output_frames;
        diagnostics->backend = std::move(backend);
    }
};

} // namespace

std::unique_ptr<Resampler> make_resampler() {
    return std::make_unique<EngineResampler>();
}

// ---------------------------------------------------------------------------
// StreamingResampler implementations
// ---------------------------------------------------------------------------
namespace {

// Sample-rate match → just interleave-copy the input through.
class PassthroughStreamingResampler final : public StreamingResampler {
public:
    explicit PassthroughStreamingResampler(int channels) : channels_(channels) {}
    Frame process_chunk(const float* input, Frame in_frames, bool /*eoi*/,
                        std::vector<float>& out) override {
        if (in_frames <= 0) return 0;
        const std::size_t n = static_cast<std::size_t>(in_frames) *
                              static_cast<std::size_t>(channels_);
        out.insert(out.end(), input, input + n);
        return in_frames;
    }
private:
    int channels_;
};

#if LT_ENGINE_USE_R8BRAIN
// Stateful r8brain resampler, one CDSPResampler per channel. We de-interleave
// each input chunk into per-channel double buffers, push through, then
// re-interleave the produced output. r8brain keeps internal state across calls,
// so feeding the file in chunks yields the same result as one big call.
class R8brainStreamingResampler final : public StreamingResampler {
public:
    R8brainStreamingResampler(int channels, int src_sr, int dst_sr)
        : channels_(channels) {
        // MaxInLen: the largest input block we'll feed per process() call.
        constexpr int kMaxInLen = 65536;
        resamplers_.reserve(static_cast<std::size_t>(channels));
        for (int c = 0; c < channels; ++c)
            resamplers_.push_back(std::make_unique<r8b::CDSPResampler24>(
                src_sr, dst_sr, kMaxInLen));
        chan_in_.resize(static_cast<std::size_t>(channels));
        // r8brain emits output with an internal delay; when streaming we must
        // drop the first `getInLenBeforeOutStart()`-worth of OUTPUT frames so
        // the result aligns with the one-shot whole-file resample. The whole-
        // file path constructs the resampler over the entire file and takes the
        // leading output_frames, which already starts at the correct position;
        // streaming has to skip the latency transient explicitly. The call
        // clears the resampler, so query it before any real processing.
        // getInLenBeforeOutStart returns INPUT samples before output starts;
        // the equivalent output latency is that many input frames × ratio.
        // NOTE: the whole-file path does NOT discard latency (it takes the first
        // output_frames of one big process() call), so to match it we DON'T skip
        // either. Kept queryable for reference.
        (void)src_sr; (void)dst_sr;
        skip_out_frames_ = 0;
    }

    Frame process_chunk(const float* input, Frame in_frames, bool /*eoi*/,
                        std::vector<float>& out) override {
        if (in_frames <= 0 || channels_ <= 0) return 0;
        // De-interleave into per-channel double buffers.
        for (int c = 0; c < channels_; ++c)
            chan_in_[static_cast<std::size_t>(c)].resize(static_cast<std::size_t>(in_frames));
        for (Frame f = 0; f < in_frames; ++f)
            for (int c = 0; c < channels_; ++c)
                chan_in_[static_cast<std::size_t>(c)][static_cast<std::size_t>(f)] =
                    static_cast<double>(input[static_cast<std::size_t>(f) *
                        static_cast<std::size_t>(channels_) + static_cast<std::size_t>(c)]);

        // Process each channel; r8brain returns a pointer to its internal output
        // and the produced count. All channels produce the same count for the
        // same input length (identical ratio + filter), so use channel 0's.
        std::vector<double*> outs(static_cast<std::size_t>(channels_), nullptr);
        int produced = 0;
        for (int c = 0; c < channels_; ++c) {
            double* op = nullptr;
            const int p = resamplers_[static_cast<std::size_t>(c)]->process(
                chan_in_[static_cast<std::size_t>(c)].data(),
                static_cast<int>(in_frames), op);
            outs[static_cast<std::size_t>(c)] = op;
            if (c == 0) produced = p;
        }
        if (produced <= 0) return 0;

        // Skip the leading latency-transient output frames so the streamed
        // result aligns with the whole-file one-shot resample.
        int start = 0;
        if (skip_out_frames_ > 0) {
            const Frame skip = std::min<Frame>(skip_out_frames_, produced);
            start = static_cast<int>(skip);
            skip_out_frames_ -= skip;
        }
        const int emit = produced - start;
        if (emit <= 0) return 0;

        const std::size_t base = out.size();
        out.resize(base + static_cast<std::size_t>(emit) *
                              static_cast<std::size_t>(channels_));
        for (int f = 0; f < emit; ++f)
            for (int c = 0; c < channels_; ++c)
                out[base + static_cast<std::size_t>(f) *
                        static_cast<std::size_t>(channels_) + static_cast<std::size_t>(c)] =
                    static_cast<float>(outs[static_cast<std::size_t>(c)][start + f]);
        return static_cast<Frame>(emit);
    }
private:
    int channels_;
    Frame skip_out_frames_ = 0;
    std::vector<std::unique_ptr<r8b::CDSPResampler24>> resamplers_;
    std::vector<std::vector<double>> chan_in_;
};
#endif

} // namespace

std::unique_ptr<StreamingResampler> make_streaming_resampler(
    int channels, int source_sample_rate, int target_sample_rate) {
    if (channels <= 0)
        channels = 1;
    if (source_sample_rate == target_sample_rate || source_sample_rate <= 0
        || target_sample_rate <= 0)
        return std::make_unique<PassthroughStreamingResampler>(channels);
#if LT_ENGINE_USE_R8BRAIN
    return std::make_unique<R8brainStreamingResampler>(
        channels, source_sample_rate, target_sample_rate);
#else
    // No streaming backend compiled → passthrough (sample rates should match in
    // that config, or the whole-file path is used).
    return std::make_unique<PassthroughStreamingResampler>(channels);
#endif
}

} // namespace lt
