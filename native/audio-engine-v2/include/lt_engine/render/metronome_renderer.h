#pragma once

#include <lt_engine/core/types.h>
#include <lt_engine/session/session.h>

#include <array>
#include <atomic>
#include <cstdint>
#include <string>

namespace lt {

// Procedural click timbres. Index values are part of the serialized command
// schema (commands.cpp / commands.rs / settings) — append, never reorder.
enum class SoundPreset : int {
    Sine = 0,       // pure tone (legacy default)
    Beep = 1,       // soft square/triangle digital beep
    Woodblock = 2,  // short pitched tone + filtered noise transient
    Click = 3,      // very short broadband impulse
    Rimshot = 4,    // noisy bright transient
    Cowbell = 5,    // two inharmonic partials
    Clave = 6,      // dry wooden clave / clapperboard "tock"
    Count = 7,      // sentinel (number of presets)
};

struct MetronomeConfig {
    bool enabled = false;
    float volume = 0.75f;
    std::string output_route = "master";
    bool accent_enabled = true;
    // Timbre / pitch per role. Defaults reproduce the legacy single click.
    int accent_preset = 0;          // SoundPreset
    int beat_preset = 0;            // SoundPreset
    float accent_pitch = 0.0f;      // semitones offset
    float beat_pitch = 0.0f;        // semitones offset
    // Subdivision click (between main beats). subdivision == 1 disables it.
    int subdivision = 1;            // 1=off, 2=eighths, 3=triplets, 4=sixteenths
    int subdivision_preset = 0;     // SoundPreset
    float subdivision_pitch = 0.0f; // semitones offset
    float subdivision_gain = 0.5f;  // relative gain of subdivision clicks
};

struct MetronomeDiagnostics {
    bool enabled = false;
    float volume = 0.75f;
    std::string output = "master";
    Frame last_beat_frame = -1;
    Frame next_beat_frame = 0;
    int current_bar = 1;
    int current_beat = 1;
    std::string route_resolved = "master";
    uint64_t rendered_clicks_count = 0;
    std::string muted_reason = "disabled";
    float current_gain = 0.0f;
    float target_gain = 0.0f;
    uint64_t toggle_count = 0;
};

class MetronomeRenderer {
public:
    void set_config(const MetronomeConfig& config);
    void set_enabled(bool enabled);
    void set_volume(float volume);
    MetronomeConfig config() const;

    void render(float** output_channels,
                int num_channels,
                int num_frames,
                double sample_rate,
                Frame timeline_frame,
                const Session* session) noexcept;

    MetronomeDiagnostics diagnostics() const;

private:
    enum class RouteMode : int { Master = 0, Monitor = 1, Ext = 2 };

    // Click role, used to pick the right preset/pitch when a voice is triggered.
    enum class ClickRole : int { Beat = 0, Accent = 1, Subdivision = 2 };

    // A single procedurally-synthesized click. The pool holds several so a
    // subdivision click can overlap the tail of a beat click without cutting it.
    struct Voice {
        int remaining = 0;          // frames left to render (0 == inactive)
        int total = 0;              // total frames of this click
        int index = 0;              // frames rendered so far
        double phase = 0.0;         // oscillator phase (radians)
        double phase_step = 0.0;    // phase increment per frame
        double phase2 = 0.0;        // second partial (cowbell)
        double phase2_step = 0.0;
        float gain = 0.0f;          // per-voice amplitude
        float decay_rate = 7.0f;    // exponential decay shaping
        float noise_mix = 0.0f;     // 0..1 blend of filtered noise (woodblock/click/rim)
        float partial2_mix = 0.0f;  // amplitude of the second partial
        float noise_lp = 0.0f;      // one-pole low-pass state for noise
        float noise_coeff = 0.0f;   // low-pass coefficient (0 = bypass)
        float noise_hp_lp = 0.0f;   // low-pass state used to derive a high-pass
        float noise_hp_coeff = 0.0f;// >0 makes the noise bright/harsh (rimshot)
        int waveform = 0;           // 0=sine, 1=square-ish, 2=triangle-ish
        uint32_t rng = 0x9e3779b9u; // deterministic xorshift state
    };

    static constexpr int kVoiceCount = 4;

    // Parameters for synthesizing one click, derived from a preset + pitch.
    struct VoiceSpec {
        double base_freq = 1100.0;
        double duration_sec = 0.022;
        float gain = 0.65f;
        float decay_rate = 7.0f;
        float noise_mix = 0.0f;
        float partial2_ratio = 0.0f; // freq ratio of 2nd partial (0 = none)
        float partial2_mix = 0.0f;
        float noise_coeff = 0.0f;    // low-pass the noise (darker)
        float noise_hp_coeff = 0.0f; // high-pass the noise (brighter/harsher)
        int waveform = 0;
    };

    static VoiceSpec make_voice_spec(int preset, float pitch_semitones, float gain) noexcept;
    void trigger_voice(const VoiceSpec& spec, double sample_rate) noexcept;
    Voice* free_voice() noexcept;

    void reset_voice() noexcept;

    std::atomic<bool> enabled_{false};
    std::atomic<float> volume_{0.75f};
    std::atomic<bool> accent_enabled_{true};
    std::atomic<int> route_mode_{static_cast<int>(RouteMode::Master)};
    std::atomic<int> route_start_{0};
    std::atomic<int> route_end_{1};

    std::atomic<int> accent_preset_{0};
    std::atomic<int> beat_preset_{0};
    std::atomic<float> accent_pitch_{0.0f};
    std::atomic<float> beat_pitch_{0.0f};
    std::atomic<int> subdivision_{1};
    std::atomic<int> subdivision_preset_{0};
    std::atomic<float> subdivision_pitch_{0.0f};
    std::atomic<float> subdivision_gain_{0.5f};

    std::array<char, 64> output_route_{};

    Frame last_render_end_ = -1;
    Frame last_started_beat_frame_ = -1;
    Frame last_started_sub_frame_ = -1;
    std::array<Voice, kVoiceCount> voices_{};
    uint32_t trigger_rng_ = 0x12345678u;
    float current_output_gain_ = 0.0f;

    std::atomic<Frame> last_beat_frame_{-1};
    std::atomic<Frame> next_beat_frame_{0};
    std::atomic<int> current_bar_{1};
    std::atomic<int> current_beat_{1};
    std::atomic<uint64_t> rendered_clicks_count_{0};
    std::atomic<uint64_t> toggle_count_{0};
    std::array<char, 64> muted_reason_{};
    std::array<char, 64> route_resolved_{};
};

} // namespace lt
