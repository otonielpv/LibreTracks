#include <lt_engine/render/pad_renderer.h>

#include <lt_engine/sources/audio_decoder.h>

#include <algorithm>
#include <atomic>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>

namespace lt {

namespace {

// Pad changes should feel immediate during performance. Both clips overlap for
// 12 ms, preserving the fast response without a silent midpoint.
constexpr double kPadSwapCrossfadeSeconds = 0.012;
constexpr double kPadGainRampSeconds = 0.005;

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

// Filesystem-safe stem for each of the 12 keys (sharp spelling avoids '#').
const char* key_stem(int key) noexcept {
    switch (key) {
        case 0:  return "C";
        case 1:  return "Cs";
        case 2:  return "D";
        case 3:  return "Ds";
        case 4:  return "E";
        case 5:  return "F";
        case 6:  return "Fs";
        case 7:  return "G";
        case 8:  return "Gs";
        case 9:  return "A";
        case 10: return "As";
        case 11: return "B";
        default: return nullptr;
    }
}

bool file_exists(const std::string& path) noexcept {
    if (FILE* f = std::fopen(path.c_str(), "rb")) {
        std::fclose(f);
        return true;
    }
    return false;
}

} // namespace

// ── Clip loading (off the audio thread) ──────────────────────────────────────

std::shared_ptr<PadClip> load_pad_clip(const std::string& pads_dir,
                                       const std::string& pad_id,
                                       int key,
                                       int target_sample_rate) {
    auto clip = std::make_shared<PadClip>();
    clip->key = key;
    clip->sample_rate = static_cast<double>(target_sample_rate);

    const char* stem = key_stem(key);
    if (pads_dir.empty() || pad_id.empty() || !stem || target_sample_rate <= 0)
        return clip;  // empty

    const std::string base = pads_dir + "/" + pad_id + "/" + stem;
    // Probe the shipped/decodable formats in preference order. WAV first so a
    // post-download re-encode (cheaper to decode than MP3) is preferred if
    // present; MP3/OGG/FLAC follow.
    static const char* kExts[] = {".wav", ".flac", ".mp3", ".ogg", ".m4a", ".aac"};
    std::string path;
    for (const char* ext : kExts) {
        std::string candidate = base + ext;
        if (file_exists(candidate)) { path = std::move(candidate); break; }
    }
    if (path.empty()) return clip;  // no file for this key

    int channels = 0;
    Frame duration = 0;
    auto decoded = decode_file_to_float32(path, target_sample_rate, &channels, &duration);
    if (!decoded.is_ok() || channels <= 0) return clip;  // empty on failure

    clip->channels = std::min(channels, 2);  // we only ever mix a stereo pair
    if (channels <= 2) {
        clip->samples = decoded.unwrap();
        clip->channels = channels;
    } else {
        // Downmix >2 channels to interleaved stereo (front L/R average of rest).
        const std::vector<float>& in = decoded.unwrap();
        const std::size_t frames = in.size() / static_cast<std::size_t>(channels);
        clip->samples.assign(frames * 2, 0.0f);
        for (std::size_t f = 0; f < frames; ++f) {
            float l = 0.0f;
            float r = 0.0f;
            for (int c = 0; c < channels; ++c) {
                float s = in[f * static_cast<std::size_t>(channels)
                              + static_cast<std::size_t>(c)];
                if (c % 2 == 0) l += s; else r += s;
            }
            const int left_ch = (channels + 1) / 2;
            const int right_ch = channels / 2;
            clip->samples[f * 2] = left_ch ? l / static_cast<float>(left_ch) : 0.0f;
            clip->samples[f * 2 + 1] = right_ch ? r / static_cast<float>(right_ch) : 0.0f;
        }
        clip->channels = 2;
    }
    return clip;
}

// ── Config ───────────────────────────────────────────────────────────────────

void PadRenderer::set_config(const PadConfig& config) {
    set_enabled(config.enabled);
    set_volume(config.volume);
    set_fade_in_seconds(config.fade_in_seconds);
    set_fade_out_seconds(config.fade_out_seconds);
    key_.store(std::clamp(config.key, 0, 11), std::memory_order_release);
    copy_text(pad_id_, config.pad_id);

    std::string route = normalize_route(config.output_route.empty() ? "master"
                                                                     : config.output_route);
    copy_text(output_route_, route);
    if (route.rfind("ext:", 0) == 0) {
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
            start = 2;
            end = 3;
        }
        route_start_.store(start, std::memory_order_release);
        route_end_.store(end, std::memory_order_release);
    } else if (route == "monitor") {
        route_mode_.store(static_cast<int>(RouteMode::Monitor), std::memory_order_release);
        route_start_.store(2, std::memory_order_release);
        route_end_.store(3, std::memory_order_release);
    } else {
        route_mode_.store(static_cast<int>(RouteMode::Master), std::memory_order_release);
        route_start_.store(0, std::memory_order_release);
        route_end_.store(1, std::memory_order_release);
    }
}

void PadRenderer::set_enabled(bool enabled) {
    enabled_.store(enabled, std::memory_order_release);
}

void PadRenderer::set_volume(float volume) {
    volume_.store(std::clamp(volume, 0.0f, 4.0f), std::memory_order_release);
}

void PadRenderer::set_fade_in_seconds(float seconds) {
    // Clamp to a sane musical range; 0 keeps the near-instant default.
    fade_in_seconds_.store(std::clamp(seconds, 0.0f, 30.0f), std::memory_order_release);
}

void PadRenderer::set_fade_out_seconds(float seconds) {
    fade_out_seconds_.store(std::clamp(seconds, 0.0f, 30.0f), std::memory_order_release);
}

PadConfig PadRenderer::config() const {
    PadConfig config;
    config.enabled = enabled_.load(std::memory_order_acquire);
    config.volume = volume_.load(std::memory_order_acquire);
    config.fade_in_seconds = fade_in_seconds_.load(std::memory_order_acquire);
    config.fade_out_seconds = fade_out_seconds_.load(std::memory_order_acquire);
    config.output_route = array_text(output_route_);
    config.key = key_.load(std::memory_order_acquire);
    config.pad_id = array_text(pad_id_);
    return config;
}

void PadRenderer::set_clip(std::shared_ptr<const PadClip> clip) noexcept {
    clip_present_.store(clip != nullptr && !clip->empty(), std::memory_order_release);
    clip_key_.store(clip ? clip->key : -1, std::memory_order_release);
    std::atomic_store(&clip_, std::move(clip));
    // Signal the audio thread to reset its read cursor to the new clip's start.
    clip_seq_.fetch_add(1, std::memory_order_release);
}

// ── Render ───────────────────────────────────────────────────────────────────

void PadRenderer::render(float** output_channels,
                         int num_channels,
                         int num_frames,
                         double sample_rate) noexcept {
    if (num_channels <= 0 || num_frames <= 0 || sample_rate <= 0.0) return;

    const bool enabled = enabled_.load(std::memory_order_acquire);
    const float volume = volume_.load(std::memory_order_acquire);
    const float target_gain = enabled ? volume : 0.0f;
    const float fade_in_seconds = fade_in_seconds_.load(std::memory_order_acquire);
    const float fade_out_seconds = fade_out_seconds_.load(std::memory_order_acquire);

    // Pick the level-ramp duration from the enabled edge: a soft entrance on
    // enable, a soft exit on disable, and the fast default for volume tweaks
    // (and whenever the corresponding fade is 0). On any change to the target we
    // (re)capture a constant linear per-sample step so the fade is a straight
    // ramp across however many blocks it spans, not an ever-slowing tail.
    const bool enable_edge = enabled && !was_enabled_;
    const bool disable_edge = !enabled && was_enabled_;
    was_enabled_ = enabled;

    if (target_gain != current_output_gain_ && gain_step_ == 0.0f) {
        // A level change is pending but no ramp is in flight — start one.
        double ramp_seconds = kPadGainRampSeconds;
        if (enable_edge && fade_in_seconds > 0.0f) {
            ramp_seconds = fade_in_seconds;
        } else if (disable_edge && fade_out_seconds > 0.0f) {
            ramp_seconds = fade_out_seconds;
        }
        const double ramp_frames = std::max(1.0, sample_rate * ramp_seconds);
        gain_step_ = static_cast<float>(
            std::abs(target_gain - current_output_gain_) / ramp_frames);
    } else if (enable_edge && fade_in_seconds > 0.0f) {
        // A soft entrance always (re)arms its own slow ramp even mid-flight.
        const double ramp_frames = std::max(1.0, sample_rate * fade_in_seconds);
        gain_step_ = static_cast<float>(volume / ramp_frames);
    } else if (disable_edge && fade_out_seconds > 0.0f) {
        const double ramp_frames = std::max(1.0, sample_rate * fade_out_seconds);
        gain_step_ = static_cast<float>(current_output_gain_ / ramp_frames);
    }

    if (!enabled && current_output_gain_ <= 0.000001f) {
        copy_text(muted_reason_, "disabled");
        return;
    }

    // The newest decoded clip becomes the incoming voice while the previous
    // one remains audible for the brief overlap.
    std::shared_ptr<const PadClip> pending = std::atomic_load(&clip_);

    // Detect a newly decoded key or pack.
    const std::uint64_t seq = clip_seq_.load(std::memory_order_acquire);
    if (seq != applied_clip_seq_) {
        applied_clip_seq_ = seq;
        if (pending && !pending->empty() && active_clip_) {
            // Adopt now while retaining the old clip as the outgoing voice.
            outgoing_clip_ = active_clip_;
            outgoing_read_frame_ = read_frame_;
            active_clip_ = pending;
            const std::int64_t pending_frames = static_cast<std::int64_t>(
                pending->samples.size() / static_cast<std::size_t>(pending->channels));
            read_frame_ = pending_frames > 0
                ? outgoing_read_frame_ % pending_frames
                : 0;
            // A configured soft exit stretches the swap so the outgoing pad
            // leaves gently; otherwise keep the fast performance crossfade.
            const double swap_seconds = fade_out_seconds > 0.0f
                ? static_cast<double>(fade_out_seconds)
                : kPadSwapCrossfadeSeconds;
            crossfade_total_ = std::max(
                1, static_cast<int>(sample_rate * swap_seconds));
            crossfade_remaining_ = crossfade_total_;
        } else if (pending && !pending->empty()) {
            // First activation has no outgoing voice, so only fade it in.
            active_clip_ = pending;
            read_frame_ = 0;
            outgoing_clip_.reset();
            outgoing_read_frame_ = 0;
            crossfade_total_ = std::max(
                1, static_cast<int>(sample_rate * kPadSwapCrossfadeSeconds));
            crossfade_remaining_ = crossfade_total_;
        }
    }

    const std::shared_ptr<const PadClip>& clip = active_clip_;
    if (!clip || clip->empty()) {
        copy_text(muted_reason_, "no_clip");
        return;
    }

    // Resolve the configured output route (same scheme as the metronome / voice
    // guide: master = main pair, monitor = 2-3 when present, ext = explicit).
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

    // Immutable playback data for each voice.
    auto clip_params = [](const std::shared_ptr<const PadClip>& c,
                          int& ch_out, std::int64_t& total_out,
                          const float*& data_out, std::int64_t& xfade_out,
                          double sr) {
        ch_out = c ? c->channels : 0;
        total_out = c && ch_out > 0
            ? static_cast<std::int64_t>(c->samples.size() / static_cast<std::size_t>(ch_out))
            : 0;
        data_out = c ? c->samples.data() : nullptr;
        // Loop-seam crossfade so the wrap is click-free.
        xfade_out = total_out > 0
            ? std::min<std::int64_t>(total_out / 4,
                                     static_cast<std::int64_t>(sr * 0.020))
            : 0;
    };

    int ch = 0;
    std::int64_t total_frames = 0;
    const float* data = nullptr;
    std::int64_t xfade = 0;
    clip_params(clip, ch, total_frames, data, xfade, sample_rate);

    int outgoing_ch = 0;
    std::int64_t outgoing_total_frames = 0;
    const float* outgoing_data = nullptr;
    std::int64_t outgoing_xfade = 0;
    clip_params(outgoing_clip_, outgoing_ch, outgoing_total_frames,
                outgoing_data, outgoing_xfade, sample_rate);

    // Fallback per-sample step if none was armed above (e.g. gain already at
    // target when a fresh clip arrives): the fast default keeps behaviour intact.
    const float default_step = static_cast<float>(
        1.0 / std::max(1.0, sample_rate * kPadGainRampSeconds));

    auto sample_clip = [](const float* clip_data, int clip_channels,
                          std::int64_t clip_frames, std::int64_t seam_xfade,
                          std::int64_t position, float& left_sample,
                          float& right_sample) {
        left_sample = 0.0f;
        right_sample = 0.0f;
        if (!clip_data || clip_channels <= 0 || clip_frames <= 0) return;

        const std::int64_t pos = position % clip_frames;
        left_sample = clip_data[pos * clip_channels];
        right_sample = clip_channels >= 2
            ? clip_data[pos * clip_channels + 1]
            : left_sample;

        if (seam_xfade > 0 && pos >= clip_frames - seam_xfade) {
            const std::int64_t into = pos - (clip_frames - seam_xfade);
            const float t = static_cast<float>(into) / static_cast<float>(seam_xfade);
            const float head_left = clip_data[into * clip_channels];
            const float head_right = clip_channels >= 2
                ? clip_data[into * clip_channels + 1]
                : head_left;
            left_sample = left_sample * (1.0f - t) + head_left * t;
            right_sample = right_sample * (1.0f - t) + head_right * t;
        }
    };

    constexpr float kHalfPi = 1.57079632679489661923f;

    for (int f = 0; f < num_frames; ++f) {
        // Linear ramp toward the target at the armed step (or the fast default).
        if (current_output_gain_ != target_gain) {
            const float step = gain_step_ > 0.0f ? gain_step_ : default_step;
            if (current_output_gain_ < target_gain) {
                current_output_gain_ = std::min(target_gain, current_output_gain_ + step);
            } else {
                current_output_gain_ = std::max(target_gain, current_output_gain_ - step);
            }
            if (current_output_gain_ == target_gain)
                gain_step_ = 0.0f;  // ramp complete; next change re-arms
        }

        // Constant-power overlap. There is no shared silent midpoint between
        // the outgoing and incoming voices.
        float incoming_mix = 1.0f;
        float outgoing_mix = 0.0f;
        if (crossfade_remaining_ > 0) {
            const float progress = 1.0f
                - static_cast<float>(crossfade_remaining_)
                    / static_cast<float>(std::max(1, crossfade_total_));
            incoming_mix = std::sin(progress * kHalfPi);
            outgoing_mix = outgoing_clip_
                ? std::cos(progress * kHalfPi)
                : 0.0f;
        }

        float incoming_left = 0.0f;
        float incoming_right = 0.0f;
        sample_clip(data, ch, total_frames, xfade, read_frame_,
                    incoming_left, incoming_right);

        float outgoing_left = 0.0f;
        float outgoing_right = 0.0f;
        if (outgoing_mix > 0.0f) {
            sample_clip(outgoing_data, outgoing_ch, outgoing_total_frames,
                        outgoing_xfade, outgoing_read_frame_,
                        outgoing_left, outgoing_right);
        }

        const float g = current_output_gain_;
        const float sl = (incoming_left * incoming_mix
                          + outgoing_left * outgoing_mix) * g;
        const float sr = (incoming_right * incoming_mix
                          + outgoing_right * outgoing_mix) * g;

        output_channels[left][f] += sl;
        if (right != left)
            output_channels[right][f] += sr;

        ++read_frame_;
        if (read_frame_ >= total_frames)
            read_frame_ = xfade;

        if (outgoing_clip_) {
            ++outgoing_read_frame_;
            if (outgoing_read_frame_ >= outgoing_total_frames)
                outgoing_read_frame_ = outgoing_xfade;
        }

        if (crossfade_remaining_ > 0) {
            --crossfade_remaining_;
            if (crossfade_remaining_ == 0) {
                outgoing_clip_.reset();
                outgoing_read_frame_ = 0;
            }
        }
    }
}

PadDiagnostics PadRenderer::diagnostics() const {
    PadDiagnostics d;
    d.enabled = enabled_.load(std::memory_order_acquire);
    d.volume = volume_.load(std::memory_order_acquire);
    d.route_resolved = array_text(route_resolved_);
    d.key = key_.load(std::memory_order_acquire);
    d.pad_id = array_text(pad_id_);
    d.clip_loaded = clip_present_.load(std::memory_order_acquire);
    d.clip_key = clip_key_.load(std::memory_order_acquire);
    d.current_gain = current_output_gain_;
    d.muted_reason = array_text(muted_reason_);
    return d;
}

} // namespace lt
