#include <lt_engine/render/voice_guide_renderer.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstring>

namespace lt {

namespace {

void copy_text(std::array<char, 64>& dst, const std::string& text) noexcept {
    std::fill(dst.begin(), dst.end(), '\0');
    const std::size_t count = std::min(dst.size() - 1, text.size());
    std::memcpy(dst.data(), text.data(), count);
}

void copy_text(std::array<char, 32>& dst, const std::string& text) noexcept {
    std::fill(dst.begin(), dst.end(), '\0');
    const std::size_t count = std::min(dst.size() - 1, text.size());
    std::memcpy(dst.data(), text.data(), count);
}

std::string array_text(const std::array<char, 64>& src) {
    return std::string(src.data());
}
std::string array_text(const std::array<char, 32>& src) {
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

// ── Beat-grid helpers (kept identical in spirit to MetronomeRenderer so the
// two stay sample-aligned) ───────────────────────────────────────────────────

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

std::string kind_token(MarkerKind kind) noexcept {
    switch (kind) {
        case MarkerKind::Intro: return "intro";
        case MarkerKind::Verse: return "verse";
        case MarkerKind::PreChorus: return "pre_chorus";
        case MarkerKind::Chorus: return "chorus";
        case MarkerKind::PostChorus: return "post_chorus";
        case MarkerKind::Bridge: return "bridge";
        case MarkerKind::Breakdown: return "breakdown";
        case MarkerKind::Drop: return "drop";
        case MarkerKind::Solo: return "solo";
        case MarkerKind::Outro: return "outro";
        case MarkerKind::Custom: default: return "custom";
    }
}

} // namespace

// ── Clip bank lookups ────────────────────────────────────────────────────────

const VoiceGuideClip* VoiceGuideClipBank::section_for(MarkerKind kind) const noexcept {
    const int idx = static_cast<int>(kind);
    if (idx < 0 || idx >= kKindCount) return nullptr;
    const VoiceGuideClip& clip = sections[static_cast<std::size_t>(idx)];
    return clip.samples.empty() ? nullptr : &clip;
}

const VoiceGuideClip* VoiceGuideClipBank::count_for(int beat_number) const noexcept {
    if (beat_number < 0 || beat_number >= kMaxCount) return nullptr;
    const VoiceGuideClip& clip = counts[static_cast<std::size_t>(beat_number)];
    return clip.samples.empty() ? nullptr : &clip;
}

// ── Config ───────────────────────────────────────────────────────────────────

void VoiceGuideRenderer::set_config(const VoiceGuideConfig& config) {
    set_enabled(config.enabled);
    set_volume(config.volume);
    lead_bars_.store(std::clamp(config.lead_bars, 1, 4), std::memory_order_release);
    count_in_enabled_.store(config.count_in_enabled, std::memory_order_release);

    std::string route = normalize_route(config.output_route.empty() ? "monitor"
                                                                     : config.output_route);
    copy_text(output_route_, route);
    if (route == "master") {
        route_mode_.store(static_cast<int>(RouteMode::Master), std::memory_order_release);
    } else {
        route_mode_.store(static_cast<int>(RouteMode::Monitor), std::memory_order_release);
    }
}

void VoiceGuideRenderer::set_enabled(bool enabled) {
    enabled_.store(enabled, std::memory_order_release);
}

void VoiceGuideRenderer::set_volume(float volume) {
    volume_.store(std::clamp(volume, 0.0f, 4.0f), std::memory_order_release);
}

VoiceGuideConfig VoiceGuideRenderer::config() const {
    VoiceGuideConfig config;
    config.enabled = enabled_.load(std::memory_order_acquire);
    config.volume = volume_.load(std::memory_order_acquire);
    config.output_route = array_text(output_route_);
    config.lead_bars = lead_bars_.load(std::memory_order_acquire);
    config.count_in_enabled = count_in_enabled_.load(std::memory_order_acquire);
    return config;
}

void VoiceGuideRenderer::set_clip_bank(std::shared_ptr<const VoiceGuideClipBank> bank) noexcept {
    bank_present_.store(bank != nullptr, std::memory_order_release);
    std::atomic_store(&bank_, std::move(bank));
}

// ── Voice pool ───────────────────────────────────────────────────────────────

VoiceGuideRenderer::Voice* VoiceGuideRenderer::free_voice() noexcept {
    Voice* best = &voices_[0];
    for (auto& v : voices_) {
        if (!v.active()) return &v;
        // Steal the voice with the fewest samples remaining.
        if ((v.total - v.index) < (best->total - best->index)) best = &v;
    }
    return best;
}

void VoiceGuideRenderer::trigger_clip(const VoiceGuideClip* clip, float gain) noexcept {
    if (!clip || clip->samples.empty()) return;
    Voice* v = free_voice();
    v->samples = clip->samples.data();
    v->total = static_cast<int>(clip->samples.size());
    v->index = 0;
    v->gain = gain;
}

void VoiceGuideRenderer::reset_voices() noexcept {
    for (auto& v : voices_) {
        v.samples = nullptr;
        v.index = 0;
        v.total = 0;
    }
    last_section_frame_ = -1;
    last_count_frame_ = -1;
}

const Marker* VoiceGuideRenderer::upcoming_marker(const Song* song, Frame frame) noexcept {
    if (!song) return nullptr;
    const Marker* best = nullptr;
    for (const auto& marker : song->markers) {
        if (marker.kind == MarkerKind::Custom) continue;  // no recording
        if (marker.frame < frame) continue;
        if (!best || marker.frame < best->frame) best = &marker;
    }
    return best;
}

// ── Render ───────────────────────────────────────────────────────────────────

void VoiceGuideRenderer::render(float** output_channels,
                                int num_channels,
                                int num_frames,
                                double sample_rate,
                                Frame timeline_frame,
                                const Session* session) noexcept {
    if (num_channels <= 0 || num_frames <= 0 || sample_rate <= 0.0) return;

    // A discontinuity (seek/jump) invalidates in-flight voices and fire history.
    if (last_render_end_ >= 0 && timeline_frame != last_render_end_)
        reset_voices();
    last_render_end_ = timeline_frame + num_frames;

    const bool enabled = enabled_.load(std::memory_order_acquire);
    const float volume = volume_.load(std::memory_order_acquire);
    const float target_gain = enabled ? volume : 0.0f;

    if (!enabled && current_output_gain_ <= 0.000001f) {
        copy_text(muted_reason_, "disabled");
        return;
    }

    std::shared_ptr<const VoiceGuideClipBank> bank = std::atomic_load(&bank_);
    if (!bank) {
        copy_text(muted_reason_, "no_bank");
        // Still ramp the gain down so a mid-clip disable fades cleanly.
        if (current_output_gain_ <= 0.000001f) return;
    }

    const Song* song = active_song(session, timeline_frame);
    if (!song) {
        copy_text(muted_reason_, "no_active_song");
        if (current_output_gain_ <= 0.000001f) return;
    }

    // Resolve the monitor output pair (channels 2-3 when available, else 0-1).
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
    } else {
        copy_text(route_resolved_, "master");
    }

    copy_text(muted_reason_, "");

    const int lead_bars = lead_bars_.load(std::memory_order_acquire);
    const bool count_in = count_in_enabled_.load(std::memory_order_acquire);

    for (int f = 0; f < num_frames; ++f) {
        const float ramp_frames = static_cast<float>(std::max(1.0, sample_rate * 0.010));
        current_output_gain_ += (target_gain - current_output_gain_) / ramp_frames;
        if (std::abs(current_output_gain_ - target_gain) < 1.0e-6f)
            current_output_gain_ = target_gain;

        const Frame abs_frame = timeline_frame + f;

        if (song && bank) {
            const double bpm = bpm_at(song, abs_frame);
            const auto [beats_per_bar, beat_unit] = signature_at(song, abs_frame);
            const double quarter_note_frames = sample_rate * 60.0 / bpm;
            const double beat_frames = quarter_note_frames * (4.0 / static_cast<double>(beat_unit));

            if (std::isfinite(beat_frames) && beat_frames >= 1.0) {
                const Marker* marker = upcoming_marker(song, abs_frame);
                if (marker) {
                    next_marker_frame_.store(marker->frame, std::memory_order_release);
                    copy_text(next_marker_kind_, kind_token(marker->kind));

                    // Beat 1 of the lead window: marker_frame - beats_per_bar*lead_bars.
                    // We fire the section clip there, then a count clip on each
                    // subsequent beat up to (but excluding) the marker downbeat.
                    const int lead_beats = beats_per_bar * lead_bars;
                    for (int b = 0; b < lead_beats; ++b) {
                        const Frame beat_frame = marker->frame
                            - static_cast<Frame>(std::llround((lead_beats - b) * beat_frames));
                        if (beat_frame != abs_frame) continue;
                        if (b == 0) {
                            if (beat_frame != last_section_frame_) {
                                trigger_clip(bank->section_for(marker->kind),
                                             0.9f);
                                last_section_frame_ = beat_frame;
                                announcements_fired_.fetch_add(1, std::memory_order_relaxed);
                            }
                        } else if (count_in) {
                            // Beat number within the bar the marker lands in is
                            // (b % beats_per_bar) + 1; beat 1 is the section, so
                            // counts run 2..beats_per_bar.
                            const int beat_number = (b % beats_per_bar) + 1;
                            if (beat_number >= 2 && beat_frame != last_count_frame_) {
                                trigger_clip(bank->count_for(beat_number), 0.9f);
                                last_count_frame_ = beat_frame;
                                counts_fired_.fetch_add(1, std::memory_order_relaxed);
                            }
                        }
                    }
                } else {
                    next_marker_frame_.store(-1, std::memory_order_release);
                    copy_text(next_marker_kind_, "");
                }
            }
        }

        // Mix all active voices into the output pair.
        for (auto& v : voices_) {
            if (!v.active()) continue;
            const float sample = v.samples[v.index] * v.gain * current_output_gain_;
            output_channels[left][f] += sample;
            if (right != left)
                output_channels[right][f] += sample;
            ++v.index;
        }
    }
}

VoiceGuideDiagnostics VoiceGuideRenderer::diagnostics() const {
    VoiceGuideDiagnostics d;
    d.enabled = enabled_.load(std::memory_order_acquire);
    d.volume = volume_.load(std::memory_order_acquire);
    d.route_resolved = array_text(route_resolved_);
    d.lead_bars = lead_bars_.load(std::memory_order_acquire);
    d.next_marker_frame = next_marker_frame_.load(std::memory_order_acquire);
    d.next_marker_kind = array_text(next_marker_kind_);
    d.announcements_fired = announcements_fired_.load(std::memory_order_acquire);
    d.counts_fired = counts_fired_.load(std::memory_order_acquire);
    d.muted_reason = array_text(muted_reason_);
    d.current_gain = current_output_gain_;
    d.bank_loaded = bank_present_.load(std::memory_order_acquire);
    return d;
}

} // namespace lt
