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

} // namespace lt
