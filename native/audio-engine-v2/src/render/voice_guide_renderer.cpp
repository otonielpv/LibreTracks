#include <lt_engine/render/voice_guide_renderer.h>

#include <lt_engine/sources/audio_decoder.h>

#include <algorithm>
#include <atomic>
#include <cctype>
#include <cmath>
#include <cstring>
#include <string>

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
        case MarkerKind::Acapella: return "acapella";
        case MarkerKind::Instrumental: return "instrumental";
        case MarkerKind::Interlude: return "interlude";
        case MarkerKind::Refrain: return "refrain";
        case MarkerKind::Tag: return "tag";
        case MarkerKind::Vamp: return "vamp";
        case MarkerKind::Ending: return "ending";
        case MarkerKind::Exhortation: return "exhortation";
        case MarkerKind::Rap: return "rap";
        case MarkerKind::Turnaround: return "turnaround";
        case MarkerKind::AdLib: return "ad_lib";
        case MarkerKind::AllIn: return "all_in";
        case MarkerKind::Bass: return "bass";
        case MarkerKind::BigEnding: return "big_ending";
        case MarkerKind::Break: return "break";
        case MarkerKind::Build: return "build";
        case MarkerKind::DrumsIn: return "drums_in";
        case MarkerKind::Drums: return "drums";
        case MarkerKind::Guitar: return "guitar";
        case MarkerKind::Hits: return "hits";
        case MarkerKind::Hold: return "hold";
        case MarkerKind::KeyChangeDown: return "key_change_down";
        case MarkerKind::KeyChangeUp: return "key_change_up";
        case MarkerKind::Keys: return "keys";
        case MarkerKind::LastTime: return "last_time";
        case MarkerKind::SlowlyBuild: return "slowly_build";
        case MarkerKind::Softly: return "softly";
        case MarkerKind::Swell: return "swell";
        case MarkerKind::WorshipFreely: return "worship_freely";
        case MarkerKind::Custom: default: return "custom";
    }
}

} // namespace

// ── Clip bank lookups ────────────────────────────────────────────────────────

const VoiceGuideClip* VoiceGuideClipBank::section_for(MarkerKind kind, int variant) const noexcept {
    const int idx = static_cast<int>(kind);
    if (idx < 0 || idx >= kKindCount) return nullptr;
    const VoiceGuideSection& section = sections[static_cast<std::size_t>(idx)];
    if (variant >= 1 && variant < VoiceGuideSection::kMaxVariant) {
        const VoiceGuideClip& v = section.variants[static_cast<std::size_t>(variant)];
        if (!v.samples.empty()) return &v;   // numbered variant present
        // else fall through to base
    }
    return section.base.samples.empty() ? nullptr : &section.base;
}

const VoiceGuideClip* VoiceGuideClipBank::count_for(int beat_number) const noexcept {
    if (beat_number < 0 || beat_number >= kMaxCount) return nullptr;
    const VoiceGuideClip& clip = counts[static_cast<std::size_t>(beat_number)];
    return clip.samples.empty() ? nullptr : &clip;
}

const VoiceGuideClip* VoiceGuideClipBank::cue_for(MarkerKind kind) const noexcept {
    const int idx = static_cast<int>(kind);
    if (idx < 0 || idx >= kKindCount) return nullptr;
    const VoiceGuideClip& clip = cues[static_cast<std::size_t>(idx)];
    return clip.samples.empty() ? nullptr : &clip;
}

// ── Bank loading (off the audio thread) ──────────────────────────────────────

namespace {

// Trim leading and trailing near-silence so a clip occupies only the spoken
// part. The pack's WAVs are padded to a fixed length with silence tails; left
// untrimmed those tails keep a voice "playing" and force later beats to overlap.
// Keeps a small pad on each side so the consonants aren't clipped.
void trim_silence(std::vector<float>& mono, int sample_rate) {
    if (mono.empty()) return;
    float peak = 0.0f;
    for (float s : mono) peak = std::max(peak, std::abs(s));
    if (peak <= 1.0e-5f) { mono.clear(); return; }   // wholly silent
    const float thr = peak * 0.02f;                  // -34 dB relative gate
    std::size_t first = 0;
    while (first < mono.size() && std::abs(mono[first]) < thr) ++first;
    std::size_t last = mono.size();
    while (last > first && std::abs(mono[last - 1]) < thr) --last;
    const std::size_t pad = static_cast<std::size_t>(std::max(1, sample_rate / 100)); // 10 ms
    first = first > pad ? first - pad : 0;
    last = std::min(mono.size(), last + pad);
    if (first == 0 && last == mono.size()) return;
    mono.assign(mono.begin() + static_cast<std::ptrdiff_t>(first),
                mono.begin() + static_cast<std::ptrdiff_t>(last));
}

// Decode one file to mono at the target rate, trimming silence. Returns empty on
// any failure (missing file, decode error) — a missing clip is a valid "silent
// slot".
std::vector<float> decode_mono(const std::string& path, int target_sample_rate) {
    int channels = 0;
    Frame duration = 0;
    auto decoded = decode_file_to_float32(path, target_sample_rate, &channels, &duration);
    if (!decoded.is_ok() || channels <= 0) return {};
    const std::vector<float>& interleaved = decoded.unwrap();
    std::vector<float> mono;
    if (channels == 1) {
        mono = interleaved;
    } else {
        // Downmix to mono by averaging channels.
        const std::size_t frames = interleaved.size() / static_cast<std::size_t>(channels);
        mono.assign(frames, 0.0f);
        for (std::size_t f = 0; f < frames; ++f) {
            float sum = 0.0f;
            for (int c = 0; c < channels; ++c)
                sum += interleaved[f * static_cast<std::size_t>(channels)
                                   + static_cast<std::size_t>(c)];
            mono[f] = sum / static_cast<float>(channels);
        }
    }
    trim_silence(mono, target_sample_rate);
    return mono;
}

const char* section_filename(int kind_index) noexcept {
    switch (static_cast<MarkerKind>(kind_index)) {
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
        case MarkerKind::Acapella: return "acapella";
        case MarkerKind::Instrumental: return "instrumental";
        case MarkerKind::Interlude: return "interlude";
        case MarkerKind::Refrain: return "refrain";
        case MarkerKind::Tag: return "tag";
        case MarkerKind::Vamp: return "vamp";
        case MarkerKind::Ending: return "ending";
        case MarkerKind::Exhortation: return "exhortation";
        case MarkerKind::Rap: return "rap";
        case MarkerKind::Turnaround: return "turnaround";
        // Cue kinds and Custom have no entry in the sections tree.
        default: return nullptr;
    }
}

// Filename stem for a dynamic-cue kind under voices/<lang>/cues/. Returns
// nullptr for section kinds and Custom (no cue recording).
const char* cue_filename(int kind_index) noexcept {
    switch (static_cast<MarkerKind>(kind_index)) {
        case MarkerKind::AdLib: return "ad_lib";
        case MarkerKind::AllIn: return "all_in";
        case MarkerKind::Bass: return "bass";
        case MarkerKind::BigEnding: return "big_ending";
        case MarkerKind::Break: return "break";
        case MarkerKind::Build: return "build";
        case MarkerKind::DrumsIn: return "drums_in";
        case MarkerKind::Drums: return "drums";
        case MarkerKind::Guitar: return "guitar";
        case MarkerKind::Hits: return "hits";
        case MarkerKind::Hold: return "hold";
        case MarkerKind::KeyChangeDown: return "key_change_down";
        case MarkerKind::KeyChangeUp: return "key_change_up";
        case MarkerKind::Keys: return "keys";
        case MarkerKind::LastTime: return "last_time";
        case MarkerKind::SlowlyBuild: return "slowly_build";
        case MarkerKind::Softly: return "softly";
        case MarkerKind::Swell: return "swell";
        case MarkerKind::WorshipFreely: return "worship_freely";
        default: return nullptr;
    }
}

} // namespace

std::shared_ptr<VoiceGuideClipBank> load_voice_guide_bank(
    const std::string& voices_dir, const std::string& lang, int target_sample_rate) {
    if (voices_dir.empty() || lang.empty() || target_sample_rate <= 0) return nullptr;

    auto bank = std::make_shared<VoiceGuideClipBank>();
    bank->sample_rate = static_cast<double>(target_sample_rate);

    const std::string base = voices_dir + "/" + lang;
    for (int k = 0; k < VoiceGuideClipBank::kKindCount; ++k) {
        const char* name = section_filename(k);
        if (!name) continue;  // Custom has no clip
        VoiceGuideSection& section = bank->sections[static_cast<std::size_t>(k)];
        const std::string dir = base + "/sections/";
        section.base.samples = decode_mono(dir + name + ".wav", target_sample_rate);
        for (int v = 1; v < VoiceGuideSection::kMaxVariant; ++v) {
            section.variants[static_cast<std::size_t>(v)].samples =
                decode_mono(dir + name + "_" + std::to_string(v) + ".wav", target_sample_rate);
        }
    }
    for (int n = 1; n < VoiceGuideClipBank::kMaxCount; ++n) {
        bank->counts[static_cast<std::size_t>(n)].samples =
            decode_mono(base + "/counts/" + std::to_string(n) + ".wav", target_sample_rate);
    }
    // Dynamic cues: one file per cue kind under <lang>/cues/. No variants, no
    // count-in. A missing file (e.g. an English-only cue) leaves the slot empty.
    const std::string cues_dir = base + "/cues/";
    for (int k = 0; k < VoiceGuideClipBank::kKindCount; ++k) {
        const char* name = cue_filename(k);
        if (!name) continue;
        bank->cues[static_cast<std::size_t>(k)].samples =
            decode_mono(cues_dir + name + ".wav", target_sample_rate);
    }
    return bank;
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
        route_start_.store(0, std::memory_order_release);
        route_end_.store(1, std::memory_order_release);
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
            start = 2;
            end = 3;
        }
        route_start_.store(start, std::memory_order_release);
        route_end_.store(end, std::memory_order_release);
    } else {
        route_mode_.store(static_cast<int>(RouteMode::Monitor), std::memory_order_release);
        route_start_.store(2, std::memory_order_release);
        route_end_.store(3, std::memory_order_release);
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

// Start a short fade-out on every voice that is still playing, so the next
// announcement replaces them cleanly instead of talking over them.
void VoiceGuideRenderer::choke_active_voices(double sample_rate) noexcept {
    const int fade = std::max(1, static_cast<int>(sample_rate * 0.020)); // ~20 ms
    for (auto& v : voices_) {
        if (!v.active() || v.fade_remaining >= 0) continue;
        v.fade_remaining = fade;
        v.fade_total = fade;
    }
}

void VoiceGuideRenderer::trigger_clip(const VoiceGuideClip* clip, float gain,
                                      double sample_rate) noexcept {
    if (!clip || clip->samples.empty()) return;
    // Choke whatever is still playing so voices never overlap (Playback-style).
    choke_active_voices(sample_rate);
    // Pick a voice that is NOT mid-choke if possible, so we keep the fading tail.
    Voice* v = nullptr;
    for (std::size_t i = 0; i < voices_.size(); ++i) {
        if (!voices_[i].active()) { v = &voices_[i]; break; }
    }
    if (!v) {
        // All voices busy; steal the one with the fewest samples remaining.
        v = &voices_[0];
        for (std::size_t i = 0; i < voices_.size(); ++i) {
            if ((voices_[i].total - voices_[i].index) < (v->total - v->index))
                v = &voices_[i];
        }
    }
    v->samples = clip->samples.data();
    v->total = static_cast<int>(clip->samples.size());
    v->index = 0;
    v->gain = gain;
    v->fade_remaining = -1;
    v->fade_total = 0;
}

void VoiceGuideRenderer::reset_voices() noexcept {
    for (auto& v : voices_) {
        v.samples = nullptr;
        v.index = 0;
        v.total = 0;
        v.fade_remaining = -1;
        v.fade_total = 0;
    }
    last_section_frame_ = -1;
    last_count_frame_ = -1;
    last_cue_frame_ = -1;
    last_chained_cue_frame_ = -1;
}

const Marker* VoiceGuideRenderer::upcoming_marker(const Song* song, Frame frame) noexcept {
    if (!song) return nullptr;
    const Marker* best = nullptr;
    for (const auto& marker : song->markers) {
        if (marker.kind == MarkerKind::Custom) continue;       // no recording
        if (marker_kind_is_cue(marker.kind)) continue;         // cues aren't downbeat targets
        if (marker.frame < frame) continue;
        if (!best || marker.frame < best->frame) best = &marker;
    }
    return best;
}

const Marker* VoiceGuideRenderer::upcoming_cue(const Song* song, Frame frame) noexcept {
    if (!song) return nullptr;
    const Marker* best = nullptr;
    for (const auto& marker : song->markers) {
        if (!marker_kind_is_cue(marker.kind)) continue;
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
                                const Session* session,
                                const VoiceGuideTarget& jump_target) noexcept {
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

    // Resolve the configured output route. The legacy monitor bus uses
    // channels 2-3 when available, else falls back to the main pair.
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
                // Two independent announce targets, evaluated separately so one
                // never silences the other (a pending automation jump further
                // down the timeline must not stop the markers in between from
                // being announced):
                //   1. the next typed marker ahead of the playhead, and
                //   2. the scheduled-jump destination, if one is pending
                //      (announce where you're jumping TO, before it fires). Its
                //      trigger frame may be behind us in linear time — you can
                //      jump backwards — so we key off the trigger frame, not the
                //      playhead. When the jump lands on exactly the same frame as
                //      the upcoming marker they are the same downbeat: dedupe so
                //      it only fires once.
                const Marker* marker = upcoming_marker(song, abs_frame);
                const Frame marker_frame = marker ? marker->frame : -1;
                const Frame jump_frame =
                    (jump_target.active && jump_target.at_frame > abs_frame)
                        ? jump_target.at_frame
                        : -1;

                // Fire (section + count) for one target downbeat. Each beat-frame
                // guard keys off the absolute frame, so distinct targets that
                // happen to share this block fire on their own frames.
                auto announce_target =
                    [&](Frame target_frame, MarkerKind kind, int variant) {
                        if (target_frame <= abs_frame) return;

                        // Layout (no overlap — Playback-style):
                        //   count bar  = the `lead_bars` bars immediately before
                        //               the target downbeat; full count "1..N".
                        //   cues       = any dynamic-cue markers that fall in the
                        //               lead window [count_bar_start, target] are
                        //               chained right before the count, stacked
                        //               backward so they END at count_bar_start.
                        //   section    = spoken name placed to END where the first
                        //               chained cue begins (or at count_bar_start
                        //               when there are no cues).
                        const Frame count_bar_start = target_frame
                            - static_cast<Frame>(
                                  std::llround(beats_per_bar * lead_bars * beat_frames));

                        // Gather cues in the lead window, in timeline order, and
                        // compute where the chained block of cue audio begins. The
                        // cues speak back-to-back ending at count_bar_start, so the
                        // earliest cue's start is the section name's end point.
                        // (kMaxChainedCues caps the stack so a pile of cues on one
                        // downbeat can't run unbounded; extras are dropped.)
                        constexpr int kMaxChainedCues = 3;
                        const VoiceGuideClip* chained[kMaxChainedCues] = {};
                        Frame chained_marker_frame[kMaxChainedCues] = {};
                        int chained_count = 0;
                        for (const auto& cue : song->markers) {
                            if (!marker_kind_is_cue(cue.kind)) continue;
                            if (cue.frame < count_bar_start || cue.frame > target_frame)
                                continue;
                            const VoiceGuideClip* clip = bank->cue_for(cue.kind);
                            if (!clip) continue;            // no recording in this lang
                            if (chained_count >= kMaxChainedCues) break;
                            // Insertion sort by marker frame (small N).
                            int pos = chained_count;
                            while (pos > 0
                                   && chained_marker_frame[pos - 1] > cue.frame) {
                                chained[pos] = chained[pos - 1];
                                chained_marker_frame[pos] = chained_marker_frame[pos - 1];
                                --pos;
                            }
                            chained[pos] = clip;
                            chained_marker_frame[pos] = cue.frame;
                            ++chained_count;
                        }

                        // Walk the chained cues from last to first, assigning each
                        // an end frame (the previous block's start) and firing it
                        // when its start lands on this frame. block_start ends up
                        // as the earliest cue's start = the section name's end.
                        // Firing keys off `cue_start == abs_frame`, which each
                        // absolute frame hits exactly once across contiguous blocks
                        // (abs_frame is monotonic), so no scalar guard is needed to
                        // fire-once. We still record the latest chained marker frame
                        // for the loose-cue path's belt-and-suspenders dedup.
                        Frame block_start = count_bar_start;
                        for (int i = chained_count - 1; i >= 0; --i) {
                            const Frame cue_start =
                                block_start - static_cast<Frame>(chained[i]->samples.size());
                            if (cue_start == abs_frame && cue_start >= timeline_frame) {
                                trigger_clip(chained[i], 0.9f, sample_rate);
                                last_chained_cue_frame_ = chained_marker_frame[i];
                                announcements_fired_.fetch_add(1, std::memory_order_relaxed);
                            }
                            block_start = cue_start;
                        }

                        // Section announcement: fire so its (trimmed) length ends
                        // at block_start (= count_bar_start when no cues chained).
                        // Best-effort — only if it still fits ahead of the current
                        // block (short jumps may leave no room; the count always
                        // plays).
                        if (const VoiceGuideClip* section =
                                bank->section_for(kind, variant)) {
                            const Frame section_start =
                                block_start - static_cast<Frame>(section->samples.size());
                            if (section_start == abs_frame
                                && section_start >= timeline_frame
                                && section_start != last_section_frame_) {
                                trigger_clip(section, 0.9f, sample_rate);
                                last_section_frame_ = section_start;
                                announcements_fired_.fetch_add(1, std::memory_order_relaxed);
                            }
                        }

                        // Count: every beat of the lead bar(s), spoken "1..N".
                        // Always plays (rhythmic entry), even when the name didn't
                        // fit.
                        if (count_in) {
                            const int lead_beats = beats_per_bar * lead_bars;
                            for (int b = 0; b < lead_beats; ++b) {
                                const Frame beat_frame = count_bar_start
                                    + static_cast<Frame>(std::llround(b * beat_frames));
                                if (beat_frame != abs_frame) continue;
                                const int beat_number = (b % beats_per_bar) + 1;
                                if (beat_frame != last_count_frame_) {
                                    trigger_clip(bank->count_for(beat_number), 0.9f,
                                                 sample_rate);
                                    last_count_frame_ = beat_frame;
                                    counts_fired_.fetch_add(1, std::memory_order_relaxed);
                                }
                            }
                        }
                    };

                // Diagnostics report the soonest pending downbeat of either kind.
                Frame soonest = -1;
                MarkerKind soonest_kind = MarkerKind::Custom;
                if (jump_frame > abs_frame) {
                    soonest = jump_frame;
                    soonest_kind = jump_target.kind;
                }
                if (marker_frame > abs_frame && (soonest < 0 || marker_frame < soonest)) {
                    soonest = marker_frame;
                    soonest_kind = marker->kind;
                }
                if (soonest > abs_frame) {
                    next_marker_frame_.store(soonest, std::memory_order_release);
                    copy_text(next_marker_kind_, kind_token(soonest_kind));
                } else {
                    next_marker_frame_.store(-1, std::memory_order_release);
                    copy_text(next_marker_kind_, "");
                }

                // The jump destination's section wins on its own downbeat; the
                // marker is announced independently unless it lands on that exact
                // frame (same downbeat — fire once).
                if (jump_frame > abs_frame) {
                    announce_target(jump_frame, jump_target.kind, jump_target.variant);
                }
                if (marker && marker_frame > abs_frame && marker_frame != jump_frame) {
                    announce_target(marker_frame, marker->kind, marker->variant);
                }

                // Loose dynamic cues: a cue that is NOT inside the lead window of
                // the upcoming section/jump downbeat fires as a one-shot, spoken
                // right at its own frame (no count-in). Cues inside a lead window
                // were already chained above; skip them here so they aren't
                // doubled (the chained one keyed off last_chained_cue_frame_).
                const Marker* cue = upcoming_cue(song, abs_frame);
                if (cue && cue->frame == abs_frame
                    && cue->frame != last_cue_frame_
                    && cue->frame != last_chained_cue_frame_) {
                    // Is this cue chained into a nearby downbeat's lead-in? If so,
                    // it has already been (or will be) spoken earlier; don't also
                    // one-shot it. A cue is "chained" when it sits within the lead
                    // window before a section or jump downbeat.
                    auto in_lead_window = [&](Frame downbeat) {
                        if (downbeat <= abs_frame) return false;
                        const Frame win_start = downbeat
                            - static_cast<Frame>(
                                  std::llround(beats_per_bar * lead_bars * beat_frames));
                        return cue->frame >= win_start && cue->frame <= downbeat;
                    };
                    const bool chained =
                        (marker_frame > abs_frame && in_lead_window(marker_frame))
                        || (jump_frame > abs_frame && in_lead_window(jump_frame));
                    if (!chained) {
                        // Only count an announcement when there is actually a clip
                        // for this cue in the loaded language (an absent recording
                        // is a silent slot, not a fired announcement).
                        if (const VoiceGuideClip* clip = bank->cue_for(cue->kind)) {
                            trigger_clip(clip, 0.9f, sample_rate);
                            announcements_fired_.fetch_add(1, std::memory_order_relaxed);
                        }
                        last_cue_frame_ = cue->frame;
                    }
                }
            }
        }

        // Mix all active voices into the output pair, applying any choke fade.
        for (auto& v : voices_) {
            if (!v.active()) continue;
            float fade_gain = 1.0f;
            if (v.fade_remaining >= 0) {
                fade_gain = v.fade_total > 0
                    ? static_cast<float>(v.fade_remaining) / static_cast<float>(v.fade_total)
                    : 0.0f;
                if (--v.fade_remaining < 0) {
                    // Fade complete: stop this voice.
                    v.samples = nullptr;
                    v.index = 0;
                    v.total = 0;
                    continue;
                }
            }
            const float sample =
                v.samples[v.index] * v.gain * fade_gain * current_output_gain_;
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
