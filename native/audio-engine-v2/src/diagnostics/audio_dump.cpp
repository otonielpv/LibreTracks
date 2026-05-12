#include <lt_engine/diagnostics/audio_dump.h>

#include <algorithm>
#include <cmath>

namespace lt {

std::string audio_dump_mode_name(AudioDumpMode mode) {
    switch (mode) {
        case AudioDumpMode::Mix:       return "mix";
        case AudioDumpMode::PerStem:   return "per-stem";
        case AudioDumpMode::PrePitch:  return "pre-pitch";
        case AudioDumpMode::PostPitch: return "post-pitch";
        case AudioDumpMode::Reference: return "reference";
    }
    return "unknown";
}

AudioDumpAnalysis analyze_audio_dump(const AudioDump& dump,
                                     float silence_threshold,
                                     float click_threshold) {
    AudioDumpAnalysis result;
    const int channels = std::max(1, dump.channel_count);
    const Frame frames = static_cast<Frame>(dump.samples.size() / channels);

    float previous = 0.0f;
    for (Frame frame = 0; frame < frames; ++frame) {
        float frame_peak = 0.0f;
        for (int ch = 0; ch < channels; ++ch) {
            float sample = dump.samples[static_cast<std::size_t>(frame) * channels + ch];
            frame_peak = std::max(frame_peak, std::abs(sample));
            result.peak = std::max(result.peak, std::abs(sample));
        }

        if (result.onset_frame < 0 && frame_peak >= silence_threshold) {
            result.onset_frame = frame;
            result.silent = false;
        }

        if (frame > 0 && std::abs(frame_peak - previous) >= click_threshold) {
            result.has_click_spike = true;
        }
        previous = frame_peak;
    }

    return result;
}

Frame measure_onset_offset(const AudioDump& reference,
                           const AudioDump& candidate,
                           float silence_threshold) {
    auto ref = analyze_audio_dump(reference, silence_threshold);
    auto cand = analyze_audio_dump(candidate, silence_threshold);
    if (ref.onset_frame < 0 || cand.onset_frame < 0) {
        return 0;
    }
    return cand.onset_frame - ref.onset_frame;
}

} // namespace lt
