#pragma once

#include <lt_engine/core/result.h>
#include <lt_engine/core/types.h>

#include <memory>
#include <string>
#include <vector>

namespace lt {

struct ResamplerDiagnostics {
    int source_sample_rate = 0;
    int target_sample_rate = 0;
    int channels = 0;
    Frame input_frames = 0;
    Frame output_frames = 0;
    std::string backend;
};

class Resampler {
public:
    virtual ~Resampler() = default;

    virtual Result<std::vector<float>> process(const std::vector<float>& input,
                                               int channels,
                                               int source_sample_rate,
                                               int target_sample_rate,
                                               Frame input_frames,
                                               ResamplerDiagnostics* diagnostics) = 0;
};

std::unique_ptr<Resampler> make_resampler();

// ---------------------------------------------------------------------------
// StreamingResampler — stateful, block-by-block resampling so a decode can be
// piped through to the PCM cache WITHOUT materializing the whole file (or a
// full resample copy) in RAM. Each track's decode otherwise held ~190MB +
// ~190MB, swinging the process working set 300MB↔1GB and stalling the audio
// callback during cold import. Feed interleaved input chunks; receive
// interleaved output chunks. Backend: r8brain (stateful CDSPResampler) or
// libsamplerate (SRC state); sample-rate match = passthrough.
// ---------------------------------------------------------------------------
class StreamingResampler {
public:
    virtual ~StreamingResampler() = default;

    // Resample one interleaved input chunk (`in_frames` frames, `channels`
    // interleaved). Appends the produced interleaved output to `out` (does not
    // clear it). `end_of_input=true` on the final chunk flushes tail samples.
    // Returns the number of output FRAMES appended, or -1 on error.
    virtual Frame process_chunk(const float* input,
                                Frame in_frames,
                                bool end_of_input,
                                std::vector<float>& out) = 0;
};

// channels/source_sr/target_sr fixed for the source's lifetime.
std::unique_ptr<StreamingResampler> make_streaming_resampler(
    int channels, int source_sample_rate, int target_sample_rate);

} // namespace lt
