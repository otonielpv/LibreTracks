#pragma once

#include <lt_engine/core/types.h>

#include <vector>

namespace lt::test {

constexpr int kFixtureSampleRate = 48000;

std::vector<float> make_stereo_click(Frame frames, Frame click_frame, float amplitude = 1.0f);
std::vector<float> make_stereo_sine(Frame frames, double frequency_hz, float amplitude = 0.5f);
std::vector<float> make_stereo_silence(Frame frames);
std::vector<float> make_stereo_tone_burst(Frame frames, double frequency_hz);

Frame first_onset_frame(const std::vector<float>& interleaved_stereo, float threshold);
double estimate_frequency_hz(const std::vector<float>& interleaved_stereo,
                             int sample_rate,
                             Frame start_frame,
                             Frame frame_count);

} // namespace lt::test
