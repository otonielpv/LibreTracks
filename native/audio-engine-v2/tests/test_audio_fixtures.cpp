#include "test_audio_fixtures.h"

#include <algorithm>
#include <cmath>

namespace lt::test {

namespace {
constexpr double kPi = 3.14159265358979323846;
}

std::vector<float> make_stereo_click(Frame frames, Frame click_frame, float amplitude) {
    std::vector<float> samples(static_cast<std::size_t>(frames * 2), 0.0f);
    if (click_frame >= 0 && click_frame < frames) {
        samples[static_cast<std::size_t>(click_frame * 2)] = amplitude;
        samples[static_cast<std::size_t>(click_frame * 2 + 1)] = amplitude;
    }
    return samples;
}

std::vector<float> make_stereo_sine(Frame frames, double frequency_hz, float amplitude) {
    std::vector<float> samples(static_cast<std::size_t>(frames * 2), 0.0f);
    for (Frame f = 0; f < frames; ++f) {
        float value = static_cast<float>(std::sin(2.0 * kPi * frequency_hz *
                                                 static_cast<double>(f) / kFixtureSampleRate) * amplitude);
        samples[static_cast<std::size_t>(f * 2)] = value;
        samples[static_cast<std::size_t>(f * 2 + 1)] = value;
    }
    return samples;
}

std::vector<float> make_stereo_silence(Frame frames) {
    return std::vector<float>(static_cast<std::size_t>(frames * 2), 0.0f);
}

std::vector<float> make_stereo_tone_burst(Frame frames, double frequency_hz) {
    auto samples = make_stereo_sine(frames, frequency_hz, 0.4f);
    const Frame fade = std::min<Frame>(1200, frames / 8);
    for (Frame f = 0; f < frames; ++f) {
        float gain = 1.0f;
        if (f < fade)
            gain = static_cast<float>(f) / static_cast<float>(fade);
        else if (frames - f < fade)
            gain = static_cast<float>(frames - f) / static_cast<float>(fade);
        samples[static_cast<std::size_t>(f * 2)] *= gain;
        samples[static_cast<std::size_t>(f * 2 + 1)] *= gain;
    }
    return samples;
}

Frame first_onset_frame(const std::vector<float>& interleaved_stereo, float threshold) {
    const Frame frames = static_cast<Frame>(interleaved_stereo.size() / 2);
    for (Frame f = 0; f < frames; ++f) {
        float sample = std::max(std::abs(interleaved_stereo[static_cast<std::size_t>(f * 2)]),
                                std::abs(interleaved_stereo[static_cast<std::size_t>(f * 2 + 1)]));
        if (sample >= threshold)
            return f;
    }
    return -1;
}

double estimate_frequency_hz(const std::vector<float>& interleaved_stereo,
                             int sample_rate,
                             Frame start_frame,
                             Frame frame_count) {
    const Frame total_frames = static_cast<Frame>(interleaved_stereo.size() / 2);
    const Frame end = std::min(total_frames, start_frame + frame_count);
    std::vector<Frame> crossings;
    for (Frame f = std::max<Frame>(start_frame + 1, 1); f < end; ++f) {
        float prev = interleaved_stereo[static_cast<std::size_t>((f - 1) * 2)];
        float curr = interleaved_stereo[static_cast<std::size_t>(f * 2)];
        if (prev < 0.0f && curr >= 0.0f)
            crossings.push_back(f);
    }
    if (crossings.size() < 2)
        return 0.0;
    double periods = static_cast<double>(crossings.size() - 1);
    double frames = static_cast<double>(crossings.back() - crossings.front());
    return periods * static_cast<double>(sample_rate) / frames;
}

} // namespace lt::test
