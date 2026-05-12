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

} // namespace lt
