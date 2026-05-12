#pragma once

#include <lt_engine/core/types.h>
#include <lt_engine/session/session.h>

#include <array>
#include <atomic>
#include <string>

namespace lt {

struct MetronomeConfig {
    bool enabled = false;
    float volume = 0.75f;
    std::string output_route = "master";
    bool accent_enabled = true;
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
};

class MetronomeRenderer {
public:
    void set_config(const MetronomeConfig& config);
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

    void reset_voice() noexcept;

    std::atomic<bool> enabled_{false};
    std::atomic<float> volume_{0.75f};
    std::atomic<bool> accent_enabled_{true};
    std::atomic<int> route_mode_{static_cast<int>(RouteMode::Master)};
    std::atomic<int> route_start_{0};
    std::atomic<int> route_end_{1};

    std::array<char, 64> output_route_{};

    Frame last_render_end_ = -1;
    Frame last_started_beat_frame_ = -1;
    int voice_remaining_ = 0;
    int voice_total_ = 0;
    int voice_index_ = 0;
    double voice_phase_ = 0.0;
    double voice_phase_step_ = 0.0;
    float voice_gain_ = 0.0f;

    std::atomic<Frame> last_beat_frame_{-1};
    std::atomic<Frame> next_beat_frame_{0};
    std::atomic<int> current_bar_{1};
    std::atomic<int> current_beat_{1};
    std::atomic<uint64_t> rendered_clicks_count_{0};
    std::array<char, 64> muted_reason_{};
    std::array<char, 64> route_resolved_{};
};

} // namespace lt
