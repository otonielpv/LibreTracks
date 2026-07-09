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

PadConfig PadRenderer::config() const {
    PadConfig config;
    config.enabled = enabled_.load(std::memory_order_acquire);
    config.volume = volume_.load(std::memory_order_acquire);
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

    if (!enabled && current_output_gain_ <= 0.000001f) {
        copy_text(muted_reason_, "disabled");
        return;
    }

    std::shared_ptr<const PadClip> clip = std::atomic_load(&clip_);
    if (!clip || clip->empty()) {
        copy_text(muted_reason_, "no_clip");
        // Ramp remaining gain to zero so a mid-play disable fades cleanly, but
        // there's nothing to read — bail once silent.
        if (current_output_gain_ <= 0.000001f) return;
    }

    // Notice a clip swap and rewind the cursor. Done here (audio thread) so the
    // control thread never touches read_frame_.
    const std::uint64_t seq = clip_seq_.load(std::memory_order_acquire);
    if (seq != applied_clip_seq_) {
        applied_clip_seq_ = seq;
        read_frame_ = 0;
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

    const int   ch = clip ? clip->channels : 0;
    const std::int64_t total_frames =
        clip && ch > 0 ? static_cast<std::int64_t>(clip->samples.size() / static_cast<std::size_t>(ch))
                       : 0;
    const float* data = clip ? clip->samples.data() : nullptr;

    // Loop-seam crossfade length: blend the tail back into the head so the wrap
    // is click-free even when the file doesn't start/end at zero crossings.
    const std::int64_t xfade =
        total_frames > 0
            ? std::min<std::int64_t>(total_frames / 4,
                                     static_cast<std::int64_t>(sample_rate * 0.020))  // ~20 ms
            : 0;

    const float ramp_frames = static_cast<float>(std::max(1.0, sample_rate * 0.010));

    for (int f = 0; f < num_frames; ++f) {
        current_output_gain_ += (target_gain - current_output_gain_) / ramp_frames;
        if (std::abs(current_output_gain_ - target_gain) < 1.0e-6f)
            current_output_gain_ = target_gain;

        if (total_frames <= 0 || current_output_gain_ <= 0.0f) continue;

        std::int64_t pos = read_frame_;
        if (pos >= total_frames) pos %= total_frames;

        float sl = data[pos * ch];
        float sr = ch >= 2 ? data[pos * ch + 1] : sl;

        // Crossfade the last `xfade` frames of the clip with the first `xfade`
        // frames so the loop point doesn't pop.
        if (xfade > 0 && pos >= total_frames - xfade) {
            const std::int64_t into = pos - (total_frames - xfade);  // 0..xfade-1
            const float t = static_cast<float>(into) / static_cast<float>(xfade);
            const std::int64_t head = into;  // corresponding head frame
            const float hl = data[head * ch];
            const float hr = ch >= 2 ? data[head * ch + 1] : hl;
            sl = sl * (1.0f - t) + hl * t;
            sr = sr * (1.0f - t) + hr * t;
        }

        const float g = current_output_gain_;
        output_channels[left][f] += sl * g;
        if (right != left)
            output_channels[right][f] += sr * g;

        // Advance the cursor. When we reach the crossfade region we have already
        // pre-mixed the head, so wrap so that the frame AFTER the tail is the
        // frame just past where the head blend ended.
        ++read_frame_;
        if (read_frame_ >= total_frames)
            read_frame_ = xfade;  // head frames [0, xfade) were already played in the blend
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
