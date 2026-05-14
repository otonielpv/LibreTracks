#include <lt_engine/render/metronome_renderer.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstring>
#include <cctype>

namespace lt {

namespace {

constexpr double kTwoPi = 6.28318530717958647692;

void copy_text(std::array<char, 64>& dst, const std::string& text) noexcept {
    std::fill(dst.begin(), dst.end(), '\0');
    const std::size_t count = std::min(dst.size() - 1, text.size());
    std::memcpy(dst.data(), text.data(), count);
}

std::string array_text(const std::array<char, 64>& src) {
    return std::string(src.data());
}

std::string normalize_route(std::string route) {
    std::transform(route.begin(), route.end(), route.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    route.erase(route.begin(), std::find_if(route.begin(), route.end(), [](unsigned char c) {
        return std::isspace(c) == 0;
    }));
    route.erase(std::find_if(route.rbegin(), route.rend(), [](unsigned char c) {
        return std::isspace(c) == 0;
    }).base(), route.end());
    return route;
}

std::pair<int, int> signature_at(const Song* song, Frame frame) noexcept {
    if (!song) return {4, 4};
    int beats = std::max(1, song->beats_per_bar);
    int unit = std::max(1, song->beat_unit);
    for (const auto& marker : song->time_signature_markers) {
        if (marker.frame > frame) break;
        beats = std::max(1, marker.beats_per_bar);
        unit = std::max(1, marker.beat_unit);
    }
    return {beats, unit};
}

double bpm_at(const Song* song, Frame frame) noexcept {
    if (!song) return 120.0;
    double bpm = song->bpm;
    for (const auto& marker : song->tempo_markers) {
        if (marker.frame > frame) break;
        bpm = marker.bpm;
    }
    return std::clamp(bpm, 20.0, 300.0);
}

Frame timing_segment_start(const Song* song, Frame frame) noexcept {
    if (!song) return 0;
    Frame start = song->start_frame;
    for (const auto& marker : song->tempo_markers) {
        if (marker.frame > frame) break;
        start = std::max(song->start_frame, marker.frame);
    }
    for (const auto& marker : song->time_signature_markers) {
        if (marker.frame > frame) break;
        start = std::max(start, marker.frame);
    }
    return start;
}

const Song* active_song(const Session* session, Frame frame) noexcept {
    if (!session) return nullptr;
    for (const auto& song : session->songs) {
        if (frame >= song.start_frame && frame < song.end_frame)
            return &song;
    }
    return nullptr;
}

Frame rounded_beat_frame(Frame segment_start, double beat_frames, int64_t beat_index) noexcept {
    return segment_start + static_cast<Frame>(std::llround(static_cast<double>(beat_index) * beat_frames));
}

} // namespace

void MetronomeRenderer::set_config(const MetronomeConfig& config) {
    set_enabled(config.enabled);
    set_volume(config.volume);
    accent_enabled_.store(config.accent_enabled, std::memory_order_release);

    std::string route = normalize_route(config.output_route.empty() ? "master" : config.output_route);
    copy_text(output_route_, route);

    if (route == "monitor") {
        route_mode_.store(static_cast<int>(RouteMode::Monitor), std::memory_order_release);
        route_start_.store(2, std::memory_order_release);
        route_end_.store(3, std::memory_order_release);
    } else if (route.rfind("ext:", 0) == 0) {
        route_mode_.store(static_cast<int>(RouteMode::Ext), std::memory_order_release);
        std::string spec = route.substr(4);
        auto dash = spec.find('-');
        int start = 0;
        int end = 0;
        try {
            if (dash == std::string::npos) {
                start = end = std::max(0, std::stoi(spec));
            } else {
                start = std::max(0, std::stoi(spec.substr(0, dash)));
                end = std::max(start, std::stoi(spec.substr(dash + 1)));
            }
        } catch (...) {
            start = 0;
            end = 1;
        }
        route_start_.store(start, std::memory_order_release);
        route_end_.store(end, std::memory_order_release);
    } else {
        route_mode_.store(static_cast<int>(RouteMode::Master), std::memory_order_release);
        route_start_.store(0, std::memory_order_release);
        route_end_.store(1, std::memory_order_release);
    }
}

void MetronomeRenderer::set_enabled(bool enabled) {
    const bool previous_enabled = enabled_.load(std::memory_order_acquire);
    enabled_.store(enabled, std::memory_order_release);
    if (previous_enabled != enabled)
        toggle_count_.fetch_add(1, std::memory_order_relaxed);
}

void MetronomeRenderer::set_volume(float volume) {
    volume_.store(std::clamp(volume, 0.0f, 1.0f), std::memory_order_release);
}

MetronomeConfig MetronomeRenderer::config() const {
    MetronomeConfig config;
    config.enabled = enabled_.load(std::memory_order_acquire);
    config.volume = volume_.load(std::memory_order_acquire);
    config.output_route = array_text(output_route_);
    config.accent_enabled = accent_enabled_.load(std::memory_order_acquire);
    return config;
}

void MetronomeRenderer::reset_voice() noexcept {
    voice_remaining_ = 0;
    voice_total_ = 0;
    voice_index_ = 0;
    voice_phase_ = 0.0;
    voice_phase_step_ = 0.0;
    voice_gain_ = 0.0f;
    last_started_beat_frame_ = -1;
}

void MetronomeRenderer::render(float** output_channels,
                               int num_channels,
                               int num_frames,
                               double sample_rate,
                               Frame timeline_frame,
                               const Session* session) noexcept {
    if (num_channels <= 0 || num_frames <= 0 || sample_rate <= 0.0) return;

    if (last_render_end_ >= 0 && timeline_frame != last_render_end_)
        reset_voice();
    last_render_end_ = timeline_frame + num_frames;

    const bool enabled = enabled_.load(std::memory_order_acquire);
    const float volume = volume_.load(std::memory_order_acquire);
    const float target_gain = enabled ? volume : 0.0f;
    if (!enabled && current_output_gain_ <= 0.000001f) {
        copy_text(muted_reason_, "disabled");
        return;
    }
    if (target_gain <= 0.000001f && current_output_gain_ <= 0.000001f) {
        copy_text(muted_reason_, "volume_zero");
        return;
    }

    const Song* song = active_song(session, timeline_frame);
    if (!song) {
        copy_text(muted_reason_, "no_active_song");
        return;
    }
    int left = 0;
    int right = std::min(1, num_channels - 1);
    const int mode = route_mode_.load(std::memory_order_acquire);
    if (mode == static_cast<int>(RouteMode::Monitor)) {
        if (num_channels >= 4) {
            left = 2;
            right = 3;
            copy_text(route_resolved_, "monitor");
        } else {
            copy_text(route_resolved_, "monitor_fallback_master");
        }
    } else if (mode == static_cast<int>(RouteMode::Ext)) {
        left = std::clamp(route_start_.load(std::memory_order_acquire), 0, num_channels - 1);
        right = std::clamp(route_end_.load(std::memory_order_acquire), 0, num_channels - 1);
        copy_text(route_resolved_, "ext");
    } else {
        copy_text(route_resolved_, "master");
    }

    copy_text(muted_reason_, "");

    for (int f = 0; f < num_frames; ++f) {
        const float ramp_frames = static_cast<float>(std::max(1.0, sample_rate * 0.010));
        current_output_gain_ += (target_gain - current_output_gain_) / ramp_frames;
        if (std::abs(current_output_gain_ - target_gain) < 1.0e-6f)
            current_output_gain_ = target_gain;
        const Frame abs_frame = timeline_frame + f;
        const double bpm = bpm_at(song, abs_frame);
        const auto [beats_per_bar, beat_unit] = signature_at(song, abs_frame);
        const Frame segment_start = timing_segment_start(song, abs_frame);
        const double quarter_note_frames = sample_rate * 60.0 / bpm;
        const double beat_frames = quarter_note_frames * (4.0 / static_cast<double>(beat_unit));
        if (!std::isfinite(beat_frames) || beat_frames < 1.0) {
            copy_text(muted_reason_, "tempo_map_invalid");
            continue;
        }

        const Frame rel = abs_frame - segment_start;
        if (rel >= 0) {
            const int64_t beat_index = static_cast<int64_t>(
                std::floor((static_cast<double>(rel) / beat_frames) + 0.5));
            const Frame beat_frame = rounded_beat_frame(segment_start, beat_frames, beat_index);
            if (beat_frame == abs_frame && beat_frame != last_started_beat_frame_) {
                const bool accent = accent_enabled_.load(std::memory_order_acquire)
                    && (beat_index % beats_per_bar == 0);
                voice_total_ = static_cast<int>(std::max(1.0, std::round(sample_rate * (accent ? 0.030 : 0.022))));
                voice_remaining_ = voice_total_;
                voice_index_ = 0;
                voice_phase_ = 0.0;
                voice_phase_step_ = kTwoPi * (accent ? 1800.0 : 1100.0) / sample_rate;
                voice_gain_ = accent ? 0.9f : 0.65f;
                last_started_beat_frame_ = beat_frame;
                last_beat_frame_.store(beat_frame, std::memory_order_release);
                rendered_clicks_count_.fetch_add(1, std::memory_order_relaxed);
            }

            const int64_t next_idx = static_cast<int64_t>(
                std::floor(static_cast<double>(rel) / beat_frames)) + 1;
            next_beat_frame_.store(rounded_beat_frame(segment_start, beat_frames, next_idx),
                                   std::memory_order_release);
            current_bar_.store(static_cast<int>(beat_index / beats_per_bar) + 1, std::memory_order_release);
            current_beat_.store(static_cast<int>(beat_index % beats_per_bar) + 1, std::memory_order_release);
        }

        if (voice_remaining_ > 0) {
            const float t = voice_total_ <= 1 ? 1.0f
                : static_cast<float>(voice_index_) / static_cast<float>(voice_total_ - 1);
            const float attack = std::min(1.0f, t / 0.03f);
            const float decay = std::exp(-7.0f * t);
            const float sample = std::sin(voice_phase_) * attack * decay * voice_gain_ * current_output_gain_;
            output_channels[left][f] += sample;
            if (right != left)
                output_channels[right][f] += sample;
            voice_phase_ += voice_phase_step_;
            ++voice_index_;
            --voice_remaining_;
        }
    }
}

MetronomeDiagnostics MetronomeRenderer::diagnostics() const {
    MetronomeDiagnostics d;
    d.enabled = enabled_.load(std::memory_order_acquire);
    d.volume = volume_.load(std::memory_order_acquire);
    d.output = array_text(output_route_);
    d.last_beat_frame = last_beat_frame_.load(std::memory_order_acquire);
    d.next_beat_frame = next_beat_frame_.load(std::memory_order_acquire);
    d.current_bar = current_bar_.load(std::memory_order_acquire);
    d.current_beat = current_beat_.load(std::memory_order_acquire);
    d.route_resolved = array_text(route_resolved_);
    d.rendered_clicks_count = rendered_clicks_count_.load(std::memory_order_acquire);
    d.muted_reason = array_text(muted_reason_);
    d.current_gain = current_output_gain_;
    d.target_gain = d.enabled ? d.volume : 0.0f;
    d.toggle_count = toggle_count_.load(std::memory_order_acquire);
    return d;
}

} // namespace lt
