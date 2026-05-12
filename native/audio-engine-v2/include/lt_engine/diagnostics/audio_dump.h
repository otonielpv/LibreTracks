#pragma once

#include <lt_engine/core/types.h>

#include <string>
#include <vector>

namespace lt {

enum class AudioDumpMode {
    Mix,
    PerStem,
    PrePitch,
    PostPitch,
    Reference,
};

struct AudioDump {
    AudioDumpMode mode = AudioDumpMode::Mix;
    Id source_id;
    int sample_rate = 48000;
    int channel_count = 2;
    Frame start_frame = 0;
    std::vector<float> samples;
};

struct AudioDumpAnalysis {
    bool silent = true;
    bool has_click_spike = false;
    Frame onset_frame = -1;
    float peak = 0.0f;
};

AudioDumpAnalysis analyze_audio_dump(const AudioDump& dump,
                                     float silence_threshold = 1.0e-4f,
                                     float click_threshold = 0.75f);

Frame measure_onset_offset(const AudioDump& reference,
                           const AudioDump& candidate,
                           float silence_threshold = 1.0e-4f);

std::string audio_dump_mode_name(AudioDumpMode mode);

} // namespace lt
