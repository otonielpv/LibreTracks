#include <lt_engine/render/metronome_renderer.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstring>
#include <cctype>

namespace lt {

namespace {

constexpr double kTwoPi = 6.28318530717958647692;
constexpr float kMaxMetronomeVolume = 2.5f;

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

double semitones_to_ratio(float semitones) noexcept {
    return std::pow(2.0, static_cast<double>(semitones) / 12.0);
}

// Cheap deterministic PRNG (xorshift32), RT-safe — no global state.
uint32_t xorshift(uint32_t& state) noexcept {
    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    return state;
}

float white_noise(uint32_t& state) noexcept {
    return static_cast<float>(xorshift(state)) / 2147483648.0f - 1.0f;
}

float oscillator(int waveform, double phase) noexcept {
    const float s = static_cast<float>(std::sin(phase));
    switch (waveform) {
        case 1: { // soft square: blend of sine + clamped sign for a digital beep
            const float sq = s >= 0.0f ? 1.0f : -1.0f;
            return 0.5f * s + 0.5f * sq;
        }
        case 2: { // triangle-ish from arcsine of sine
            return static_cast<float>(2.0 / kTwoPi * 2.0 * std::asin(s));
        }
        default:
            return s;
    }
}

} // namespace

void MetronomeRenderer::set_config(const MetronomeConfig& config) {
    set_enabled(config.enabled);
    set_volume(config.volume);
    accent_enabled_.store(config.accent_enabled, std::memory_order_release);

    const auto clamp_preset = [](int p) {
        return std::clamp(p, 0, static_cast<int>(SoundPreset::Count) - 1);
    };
    accent_preset_.store(clamp_preset(config.accent_preset), std::memory_order_release);
    beat_preset_.store(clamp_preset(config.beat_preset), std::memory_order_release);
    accent_pitch_.store(std::clamp(config.accent_pitch, -24.0f, 24.0f), std::memory_order_release);
    beat_pitch_.store(std::clamp(config.beat_pitch, -24.0f, 24.0f), std::memory_order_release);
    int sub = config.subdivision;
    if (sub != 2 && sub != 3 && sub != 4) sub = 1;
    subdivision_.store(sub, std::memory_order_release);
    subdivision_preset_.store(clamp_preset(config.subdivision_preset), std::memory_order_release);
    subdivision_pitch_.store(std::clamp(config.subdivision_pitch, -24.0f, 24.0f),
                             std::memory_order_release);
    subdivision_gain_.store(std::clamp(config.subdivision_gain, 0.0f, 1.0f),
                            std::memory_order_release);

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
    volume_.store(std::clamp(volume, 0.0f, kMaxMetronomeVolume), std::memory_order_release);
}

MetronomeConfig MetronomeRenderer::config() const {
    MetronomeConfig config;
    config.enabled = enabled_.load(std::memory_order_acquire);
    config.volume = volume_.load(std::memory_order_acquire);
    config.output_route = array_text(output_route_);
    config.accent_enabled = accent_enabled_.load(std::memory_order_acquire);
    config.accent_preset = accent_preset_.load(std::memory_order_acquire);
    config.beat_preset = beat_preset_.load(std::memory_order_acquire);
    config.accent_pitch = accent_pitch_.load(std::memory_order_acquire);
    config.beat_pitch = beat_pitch_.load(std::memory_order_acquire);
    config.subdivision = subdivision_.load(std::memory_order_acquire);
    config.subdivision_preset = subdivision_preset_.load(std::memory_order_acquire);
    config.subdivision_pitch = subdivision_pitch_.load(std::memory_order_acquire);
    config.subdivision_gain = subdivision_gain_.load(std::memory_order_acquire);
    return config;
}

void MetronomeRenderer::reset_voice() noexcept {
    for (auto& v : voices_)
        v.remaining = 0;
    last_started_beat_frame_ = -1;
    last_started_sub_frame_ = -1;
}

// Build the synthesis parameters for one click from a preset, a pitch offset
// (semitones) and a base gain. Pure function — no engine state touched.
MetronomeRenderer::VoiceSpec MetronomeRenderer::make_voice_spec(int preset,
                                                                float pitch_semitones,
                                                                float gain) noexcept {
    const double ratio = semitones_to_ratio(pitch_semitones);
    VoiceSpec spec;
    spec.gain = gain;
    switch (static_cast<SoundPreset>(preset)) {
        case SoundPreset::Beep:
            spec.base_freq = 1000.0 * ratio;
            spec.duration_sec = 0.040;
            spec.decay_rate = 5.0f;
            spec.waveform = 1;
            break;
        case SoundPreset::Woodblock:
            // Hollow mid-pitched wooden knock: tone with a low inharmonic
            // partial, almost no noise, medium decay. "Tonk".
            spec.base_freq = 1200.0 * ratio;
            spec.duration_sec = 0.035;
            spec.decay_rate = 11.0f;
            spec.gain = gain * 1.3f;
            spec.partial2_ratio = 2.4f;
            spec.partial2_mix = 0.3f;
            spec.noise_mix = 0.1f;
            spec.noise_coeff = 0.3f;  // darker noise body
            break;
        case SoundPreset::Click:
            // Digital "tic": short and very bright. A pointed high tone with a
            // fizzy high-passed noise edge — sharp and defined, the snappiest
            // preset.
            spec.base_freq = 3200.0 * ratio;
            spec.duration_sec = 0.014;
            spec.decay_rate = 12.0f;
            spec.gain = gain * 4.5f;
            spec.noise_mix = 0.45f;
            spec.noise_hp_coeff = 0.7f;  // bright, fizzy edge
            break;
        case SoundPreset::Rimshot:
            // Harsh, noisy snare-rim crack: strong bright noise over a short
            // mid tone, longer ring than the click. "Tssak".
            spec.base_freq = 1400.0 * ratio;
            spec.duration_sec = 0.045;
            spec.decay_rate = 13.0f;
            spec.gain = gain * 2.4f;
            spec.noise_mix = 0.6f;
            spec.noise_hp_coeff = 0.4f;  // gritty, less fizzy than the click
            break;
        case SoundPreset::Cowbell:
            spec.base_freq = 800.0 * ratio;
            spec.duration_sec = 0.090;
            spec.decay_rate = 6.0f;
            spec.partial2_ratio = 1.5f;   // inharmonic upper partial
            spec.partial2_mix = 0.7f;
            spec.waveform = 1;
            break;
        case SoundPreset::Clave:
            // Dry resonant wooden clave "tock": clean two-partial tone, almost
            // no noise, fairly long ring. The most pitched/musical of the wood
            // family — clearly different from the noisy click/rimshot.
            spec.base_freq = 2500.0 * ratio;
            spec.duration_sec = 0.055;
            spec.decay_rate = 9.0f;
            spec.gain = gain * 2.0f;
            spec.partial2_ratio = 1.47f;  // slight inharmonicity = wooden ring
            spec.partial2_mix = 0.35f;
            spec.noise_mix = 0.06f;       // tiny attack tick only
            break;
        case SoundPreset::Sine:
        default:
            spec.base_freq = 1100.0 * ratio;
            spec.duration_sec = 0.022;
            spec.decay_rate = 7.0f;
            break;
    }
    return spec;
}

// Pick the inactive voice, or steal the one with the fewest frames remaining.
MetronomeRenderer::Voice* MetronomeRenderer::free_voice() noexcept {
    Voice* best = &voices_[0];
    for (auto& v : voices_) {
        if (v.remaining == 0) return &v;
        if (v.remaining < best->remaining) best = &v;
    }
    return best;
}

void MetronomeRenderer::trigger_voice(const VoiceSpec& spec, double sample_rate) noexcept {
    Voice* v = free_voice();
    v->total = static_cast<int>(std::max(1.0, std::round(sample_rate * spec.duration_sec)));
    v->remaining = v->total;
    v->index = 0;
    v->phase = 0.0;
    v->phase_step = kTwoPi * spec.base_freq / sample_rate;
    v->phase2 = 0.0;
    v->phase2_step = kTwoPi * spec.base_freq * spec.partial2_ratio / sample_rate;
    v->gain = spec.gain;
    v->decay_rate = spec.decay_rate;
    v->noise_mix = spec.noise_mix;
    v->partial2_mix = spec.partial2_mix;
    v->noise_coeff = spec.noise_coeff;
    v->noise_lp = 0.0f;
    v->noise_hp_coeff = spec.noise_hp_coeff;
    v->noise_hp_lp = 0.0f;
    v->waveform = spec.waveform;
    v->rng = (trigger_rng_ ^= 0x6d2b79f5u, trigger_rng_ ? trigger_rng_ : 1u);
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
                VoiceSpec spec;
                if (accent) {
                    // Accent emphasis: built-in freq/duration/gain boost on top of
                    // the chosen accent preset. The default (Sine, +0 st) reproduces
                    // the legacy accent click (1800 Hz / 0.030 s / 0.9) exactly.
                    spec = make_voice_spec(accent_preset_.load(std::memory_order_acquire),
                                           accent_pitch_.load(std::memory_order_acquire), 0.65f);
                    spec.base_freq *= 1800.0 / 1100.0;
                    spec.duration_sec *= 0.030 / 0.022;
                    spec.gain *= 0.9f / 0.65f;
                } else {
                    spec = make_voice_spec(beat_preset_.load(std::memory_order_acquire),
                                           beat_pitch_.load(std::memory_order_acquire), 0.65f);
                }
                trigger_voice(spec, sample_rate);
                last_started_beat_frame_ = beat_frame;
                last_beat_frame_.store(beat_frame, std::memory_order_release);
                rendered_clicks_count_.fetch_add(1, std::memory_order_relaxed);
            }

            // Subdivision clicks fall between main beats and never collide with one.
            const int subdivision = subdivision_.load(std::memory_order_acquire);
            if (subdivision >= 2) {
                const int64_t beat_floor = static_cast<int64_t>(
                    std::floor(static_cast<double>(rel) / beat_frames));
                for (int k = 1; k < subdivision; ++k) {
                    const double sub_pos =
                        static_cast<double>(beat_floor) + static_cast<double>(k) / subdivision;
                    const Frame sub_frame = segment_start
                        + static_cast<Frame>(std::llround(sub_pos * beat_frames));
                    if (sub_frame == abs_frame && sub_frame != last_started_sub_frame_
                        && sub_frame != last_started_beat_frame_) {
                        VoiceSpec spec = make_voice_spec(
                            subdivision_preset_.load(std::memory_order_acquire),
                            subdivision_pitch_.load(std::memory_order_acquire),
                            0.65f * subdivision_gain_.load(std::memory_order_acquire));
                        trigger_voice(spec, sample_rate);
                        last_started_sub_frame_ = sub_frame;
                    }
                }
            }

            const int64_t next_idx = static_cast<int64_t>(
                std::floor(static_cast<double>(rel) / beat_frames)) + 1;
            next_beat_frame_.store(rounded_beat_frame(segment_start, beat_frames, next_idx),
                                   std::memory_order_release);
            current_bar_.store(static_cast<int>(beat_index / beats_per_bar) + 1, std::memory_order_release);
            current_beat_.store(static_cast<int>(beat_index % beats_per_bar) + 1, std::memory_order_release);
        }

        for (auto& v : voices_) {
            if (v.remaining <= 0) continue;
            const float t = v.total <= 1 ? 1.0f
                : static_cast<float>(v.index) / static_cast<float>(v.total - 1);
            const float attack = std::min(1.0f, t / 0.03f);
            const float decay = std::exp(-v.decay_rate * t);
            float tone = oscillator(v.waveform, v.phase) * (1.0f - v.partial2_mix);
            if (v.partial2_mix > 0.0f)
                tone += static_cast<float>(std::sin(v.phase2)) * v.partial2_mix;
            float body = tone;
            if (v.noise_mix > 0.0f) {
                float n = white_noise(v.rng);
                if (v.noise_coeff > 0.0f) {
                    // One-pole low-pass: darker, woody noise.
                    v.noise_lp += v.noise_coeff * (n - v.noise_lp);
                    n = v.noise_lp;
                } else if (v.noise_hp_coeff > 0.0f) {
                    // One-pole high-pass (n minus its low-passed self): bright,
                    // harsh noise — the rimshot/click crack.
                    v.noise_hp_lp += v.noise_hp_coeff * (n - v.noise_hp_lp);
                    n = n - v.noise_hp_lp;
                }
                body = tone * (1.0f - v.noise_mix) + n * v.noise_mix;
            }
            const float sample = body * attack * decay * v.gain * current_output_gain_;
            output_channels[left][f] += sample;
            if (right != left)
                output_channels[right][f] += sample;
            v.phase += v.phase_step;
            v.phase2 += v.phase2_step;
            ++v.index;
            --v.remaining;
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
