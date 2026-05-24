#include <lt_engine/render/mixer.h>
#include <lt_engine/debug/logging.h>
#include <lt_engine/render/fade_processor.h>
#include <lt_engine/render/pitch_resolution.h>
#include <lt_engine/pitch/bungee_voice_manager.h>
#include <lt_engine/pitch/warp_voice_manager.h>
#include <algorithm>
#include <array>
#include <chrono>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <limits>
#include <string>

namespace lt {

namespace {

bool jump_debug_enabled() {
    static const bool on = [] {
        const char* raw = std::getenv("LIBRETRACKS_JUMP_DEBUG");
        if (!raw) raw = std::getenv("LIBRETRACKS_AUDIO_DEBUG");
        if (!raw) return false;
        std::string value = raw;
        std::transform(value.begin(), value.end(), value.begin(),
                       [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
        return value == "1" || value == "true" || value == "yes" || value == "on";
    }();
    return on;
}

void jump_debug_log(const char* fmt, ...) {
    if (!jump_debug_enabled()) return;
    va_list args;
    va_start(args, fmt);
    lt_debug_vlog(fmt, args);
    va_end(args);
}

struct PreparedVoiceDebugSummary {
    int voices = 0;
    int queued_min = 0;
    int queued_max = 0;
    int queued_total = 0;
};

PreparedVoiceDebugSummary summarize_prepared_voice_map(
    const std::shared_ptr<const PreparedVoiceMap>& voices) {
    PreparedVoiceDebugSummary out;
    if (!voices || voices->empty())
        return out;
    out.queued_min = std::numeric_limits<int>::max();
    for (const auto& kv : *voices) {
        if (!kv.second) continue;
        const int queued = kv.second->queued_output_frames();
        ++out.voices;
        out.queued_total += queued;
        out.queued_min = std::min(out.queued_min, queued);
        out.queued_max = std::max(out.queued_max, queued);
    }
    if (out.voices == 0)
        out.queued_min = 0;
    return out;
}

float clamp_pan(float pan) noexcept {
    return std::max(-1.0f, std::min(1.0f, pan));
}

float soft_limit_output(float x) noexcept {
    constexpr float threshold = 0.98f;
    constexpr float ceiling = 0.999f;
    const float ax = std::abs(x);
    if (ax <= threshold)
        return x;
    const float over = ax - threshold;
    const float shaped = threshold
        + (ceiling - threshold) * (over / (over + (ceiling - threshold)));
    return std::copysign(std::min(shaped, ceiling), x);
}

std::vector<int> route_channels(const std::string& audio_to, int available_channels) {
    const int channels = std::max(1, available_channels);
    std::string normalized = audio_to;
    std::transform(normalized.begin(), normalized.end(), normalized.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    normalized.erase(normalized.begin(), std::find_if(normalized.begin(), normalized.end(), [](unsigned char c) {
        return std::isspace(c) == 0;
    }));
    normalized.erase(std::find_if(normalized.rbegin(), normalized.rend(), [](unsigned char c) {
        return std::isspace(c) == 0;
    }).base(), normalized.end());

    auto stereo_pair = [channels](int start) {
        int first = std::max(0, std::min(start, channels - 1));
        int second = std::max(0, std::min(first + 1, channels - 1));
        return std::vector<int>{ first, second };
    };

    if (normalized.empty() || normalized == "master" || normalized == "main")
        return stereo_pair(0);
    if (normalized == "monitor")
        return channels >= 4 ? stereo_pair(2) : stereo_pair(0);

    bool ext_zero_based = normalized.rfind("ext:", 0) == 0;
    for (const auto& prefix : { std::string("ext:"), std::string("hardware:"), std::string("out_"), std::string("out ") }) {
        if (normalized.rfind(prefix, 0) == 0) {
            normalized = normalized.substr(prefix.size());
            break;
        }
    }
    if (normalized.rfind("out", 0) == 0)
        normalized = normalized.substr(3);

    normalized.erase(std::remove_if(normalized.begin(), normalized.end(), [](unsigned char c) {
        return std::isspace(c) != 0;
    }), normalized.end());
    std::vector<int> result;
    auto add_channel = [&](int parsed) {
        int zero_based = ext_zero_based ? parsed : parsed - 1;
        if (zero_based >= 0 && zero_based < channels)
            result.push_back(zero_based);
    };

    auto dash = normalized.find('-');
    if (dash != std::string::npos) {
        try {
            int start = std::stoi(normalized.substr(0, dash));
            int end = std::stoi(normalized.substr(dash + 1));
            if (end >= start) {
                for (int ch = start; ch <= end; ++ch)
                    add_channel(ch);
            }
        } catch (...) {
            result.clear();
        }
    } else {
        try {
            add_channel(std::stoi(normalized));
        } catch (...) {
        }
    }

    if (result.empty())
        return stereo_pair(0);
    return result;
}

} // namespace

Mixer::Mixer(const Session*       session,
             const SourceManager* sources,
             TransportClock*      clock,
             JumpScheduler*       scheduler)
    : session_(session ? std::make_shared<Session>(*session) : nullptr)
    , sources_(sources)
    , clock_(clock)
    , scheduler_(scheduler)
{
    rebuild_control_slots(session_, false);
    prepare_render_resources(kMaxBlockFrames);
}

Mixer::Mixer(std::shared_ptr<const Session> session,
             const SourceManager* sources,
             TransportClock* clock,
             JumpScheduler* scheduler)
    : session_(std::move(session))
    , sources_(sources)
    , clock_(clock)
    , scheduler_(scheduler)
{
    rebuild_control_slots(session_, false);
    prepare_render_resources(kMaxBlockFrames);
}

bool Mixer::any_solo_active_in_slots() const noexcept {
    const int count = std::clamp(control_count_.load(std::memory_order_acquire), 0, kMaxControlSlots);
    for (int i = 0; i < count; ++i) {
        if (controls_[static_cast<std::size_t>(i)].initialized
            && controls_[static_cast<std::size_t>(i)].solo.load(std::memory_order_relaxed))
            return true;
    }
    return false;
}

Mixer::TrackControlState* Mixer::control_for_track(const Id& track_id) noexcept {
    const int count = std::clamp(control_count_.load(std::memory_order_acquire), 0, kMaxControlSlots);
    for (int i = 0; i < count; ++i) {
        if (controls_[static_cast<std::size_t>(i)].initialized
            && controls_[static_cast<std::size_t>(i)].track_id == track_id)
            return &controls_[static_cast<std::size_t>(i)];
    }
    return nullptr;
}

const Mixer::TrackControlState* Mixer::control_for_track(const Id& track_id) const noexcept {
    const int count = std::clamp(control_count_.load(std::memory_order_acquire), 0, kMaxControlSlots);
    for (int i = 0; i < count; ++i) {
        if (controls_[static_cast<std::size_t>(i)].initialized
            && controls_[static_cast<std::size_t>(i)].track_id == track_id)
            return &controls_[static_cast<std::size_t>(i)];
    }
    return nullptr;
}

int Mixer::control_index_for_track(const Id& track_id) const noexcept {
    if (track_id.empty()) return -1;
    const int count = std::clamp(control_count_.load(std::memory_order_acquire), 0, kMaxControlSlots);
    for (int i = 0; i < count; ++i) {
        if (controls_[static_cast<std::size_t>(i)].initialized
            && controls_[static_cast<std::size_t>(i)].track_id == track_id)
            return i;
    }
    return -1;
}

bool Mixer::is_solo_eligible(int slot_index) const noexcept {
    // Walk parent chain: eligible if any ancestor or self is soloed.
    int depth = 0;
    int idx = slot_index;
    while (idx >= 0 && idx < kMaxControlSlots && depth < kMaxFolderDepth) {
        if (controls_[static_cast<std::size_t>(idx)].solo.load(std::memory_order_relaxed))
            return true;
        idx = controls_[static_cast<std::size_t>(idx)].parent_control_index;
        ++depth;
    }
    return false;
}

Mixer::EffectiveControls Mixer::compute_effective_controls(int slot_index, bool solo_active) const noexcept {
    float eff_gain = 1.0f;
    float eff_pan  = 0.0f;
    bool  eff_muted = false;

    // Walk the parent chain (bounded).
    int depth = 0;
    int idx = slot_index;
    while (idx >= 0 && idx < kMaxControlSlots && depth < kMaxFolderDepth) {
        const auto& slot = controls_[static_cast<std::size_t>(idx)];
        eff_gain  *= slot.gain.load(std::memory_order_relaxed);
        eff_pan    = clamp_pan(eff_pan + slot.pan.load(std::memory_order_relaxed));
        if (slot.mute.load(std::memory_order_relaxed)) eff_muted = true;
        idx = slot.parent_control_index;
        ++depth;
    }

    const float target_solo_gain = (solo_active && !is_solo_eligible(slot_index)) ? 0.0f : 1.0f;
    return { eff_gain, eff_pan, eff_muted, target_solo_gain };
}

void Mixer::rebuild_control_slots(std::shared_ptr<const Session> session, bool preserve_realtime_state) {
    std::array<TrackControlState, kMaxControlSlots> next;
    int count = 0;
    if (session) {
        for (const auto& song : session->songs) {
            for (const auto& track : song.tracks) {
                if (count >= kMaxControlSlots)
                    break;
                auto& slot = next[static_cast<std::size_t>(count)];
                const auto* previous = preserve_realtime_state ? control_for_track(track.id) : nullptr;
                slot.track_id       = track.id;
                slot.parent_track_id = track.parent_track_id;
                slot.is_folder      = (track.kind == TrackKind::Folder);
                // parent_control_index resolved in second pass below.
                slot.parent_control_index = -1;
                slot.gain.store(previous ? previous->gain.load(std::memory_order_relaxed) : track.gain,
                                std::memory_order_relaxed);
                slot.pan.store(previous ? previous->pan.load(std::memory_order_relaxed)
                                        : std::clamp(track.pan, -1.0f, 1.0f),
                               std::memory_order_relaxed);
                slot.mute.store(previous ? previous->mute.load(std::memory_order_relaxed) : track.mute,
                                std::memory_order_relaxed);
                slot.solo.store(previous ? previous->solo.load(std::memory_order_relaxed) : track.solo,
                                std::memory_order_relaxed);
                slot.current_gain = previous ? previous->current_gain : track.gain;
                slot.current_pan = previous ? previous->current_pan : std::clamp(track.pan, -1.0f, 1.0f);
                slot.current_mute_gain = previous ? previous->current_mute_gain : (track.mute ? 0.0f : 1.0f);
                slot.current_solo_gain = previous ? previous->current_solo_gain : 1.0f;
                slot.initialized = true;
                ++count;
            }
        }
    }

    // Copy next into controls_ first so control_index_for_track can find them.
    for (int i = 0; i < kMaxControlSlots; ++i) {
        auto& dst = controls_[static_cast<std::size_t>(i)];
        auto& src = next[static_cast<std::size_t>(i)];
        dst.track_id       = std::move(src.track_id);
        dst.parent_track_id = std::move(src.parent_track_id);
        dst.is_folder      = src.is_folder;
        dst.parent_control_index = src.parent_control_index;
        dst.gain.store(src.gain.load(std::memory_order_relaxed), std::memory_order_relaxed);
        dst.pan.store(src.pan.load(std::memory_order_relaxed), std::memory_order_relaxed);
        dst.mute.store(src.mute.load(std::memory_order_relaxed), std::memory_order_relaxed);
        dst.solo.store(src.solo.load(std::memory_order_relaxed), std::memory_order_relaxed);
        dst.current_gain = src.current_gain;
        dst.current_pan = src.current_pan;
        dst.current_mute_gain = src.current_mute_gain;
        dst.current_solo_gain = src.current_solo_gain;
        dst.initialized = src.initialized;
    }
    control_count_.store(count, std::memory_order_release);

    // Second pass: resolve parent_control_index for each slot.
    for (int i = 0; i < count; ++i) {
        auto& slot = controls_[static_cast<std::size_t>(i)];
        if (!slot.parent_track_id.empty()) {
            slot.parent_control_index = control_index_for_track(slot.parent_track_id);
        } else {
            slot.parent_control_index = -1;
        }
    }
}

void Mixer::render_timeline_span(float** output_channels,
                                 int num_channels,
                                 int num_frames,
                                 int output_offset,
                                 const std::shared_ptr<const Session>& session) noexcept {
    if (num_frames <= 0 || !session || clock_->position().state != TransportState::Playing)
        return;

    const Frame timeline_frame = clock_->position().frame;
    std::uint64_t rendered_this_block = 0;
    std::uint64_t skipped_this_block = 0;

    for (const auto& song : session->songs) {
        if (timeline_frame < song.start_frame || timeline_frame >= song.end_frame)
            continue;

        const bool solo_active = any_solo_active_in_slots();

        for (std::size_t ti = 0; ti < song.tracks.size() && ti < kMaxTracks; ++ti) {
            const Track& track = song.tracks[ti];

            if (track.kind == TrackKind::Folder) {
                ++skipped_this_block;
                continue;
            }

            int slot_idx = control_index_for_track(track.id);
            TrackControlState* control = (slot_idx >= 0) ? &controls_[static_cast<std::size_t>(slot_idx)] : nullptr;

            if (!control) {
                fallback_control_.track_id = track.id;
                fallback_control_.parent_track_id = track.parent_track_id;
                fallback_control_.parent_control_index = -1;
                fallback_control_.is_folder = false;
                fallback_control_.gain.store(track.gain, std::memory_order_relaxed);
                fallback_control_.pan.store(std::clamp(track.pan, -1.0f, 1.0f), std::memory_order_relaxed);
                fallback_control_.mute.store(track.mute, std::memory_order_relaxed);
                fallback_control_.solo.store(track.solo, std::memory_order_relaxed);
                fallback_control_.current_gain = track.gain;
                fallback_control_.current_pan = std::clamp(track.pan, -1.0f, 1.0f);
                fallback_control_.current_mute_gain = track.mute ? 0.0f : 1.0f;
                fallback_control_.current_solo_gain = solo_active && !track.solo ? 0.0f : 1.0f;
                fallback_control_.initialized = true;
                control = &fallback_control_;
                slot_idx = -1;
            }

            const EffectiveControls eff = (slot_idx >= 0)
                ? compute_effective_controls(slot_idx, solo_active)
                : EffectiveControls{
                    control->gain.load(std::memory_order_relaxed),
                    control->pan.load(std::memory_order_relaxed),
                    control->mute.load(std::memory_order_relaxed),
                    (solo_active && !control->solo.load(std::memory_order_relaxed)) ? 0.0f : 1.0f
                  };

            const float gain = eff.target_gain;
            const float pan_target = eff.target_pan;
            const float target_mute_gain = eff.target_muted ? 0.0f : 1.0f;
            const float target_solo_gain = eff.target_solo_gain;

            const float smooth_ms = 10.0f;
            const float coeff = std::clamp(static_cast<float>(num_frames) /
                std::max(1.0f, static_cast<float>(clock_->sample_rate()) * smooth_ms * 0.001f), 0.0f, 1.0f);
            const float start_gain = control->current_gain;
            const float start_pan = control->current_pan;
            const float start_mute_gain = control->current_mute_gain;
            const float start_solo_gain = control->current_solo_gain;
            const float end_gain = start_gain + (gain - start_gain) * coeff;
            const float end_pan = start_pan + (pan_target - start_pan) * coeff;
            const float end_mute_gain = start_mute_gain + (target_mute_gain - start_mute_gain) * coeff;
            const float end_solo_gain = start_solo_gain + (target_solo_gain - start_solo_gain) * coeff;
            control->current_gain = end_gain;
            control->current_pan = end_pan;
            control->current_mute_gain = end_mute_gain;
            control->current_solo_gain = end_solo_gain;
            const bool settled_silent = std::abs(end_gain * end_mute_gain * end_solo_gain) <= 1.0e-6f
                && std::abs(start_gain * start_mute_gain * start_solo_gain) <= 1.0e-6f
                && std::abs(gain * target_mute_gain * target_solo_gain) <= 1.0e-6f;
            if (settled_silent && track.clips.empty()) {
                ++skipped_this_block;
                continue;
            }

            std::fill(mix_l_, mix_l_ + num_frames, 0.f);
            std::fill(mix_r_, mix_r_ + num_frames, 0.f);

            Track patched = track;
            patched.gain = 1.0f;
            patched.mute = false;
            patched.pan = 0.0f;

            renderers_[ti].render(patched, timeline_frame, num_frames,
                                   mix_, 2, *sources_, bungee_voices_,
                                   clock_->sample_rate(), 0, &song,
                                   warp_voices_);
            ++rendered_this_block;

            float track_peak_l = 0.f, track_peak_r = 0.f;
            double track_sum_l = 0.0, track_sum_r = 0.0;
            for (int f = 0; f < num_frames; ++f) {
                track_peak_l = std::max(track_peak_l, std::abs(mix_l_[f]));
                track_peak_r = std::max(track_peak_r, std::abs(mix_r_[f]));
                track_sum_l += static_cast<double>(mix_l_[f]) * mix_l_[f];
                track_sum_r += static_cast<double>(mix_r_[f]) * mix_r_[f];
            }
            track_meters_[ti].left_peak.store(track_peak_l, std::memory_order_relaxed);
            track_meters_[ti].right_peak.store(track_peak_r, std::memory_order_relaxed);
            track_meters_[ti].left_rms.store(static_cast<float>(std::sqrt(track_sum_l / std::max(1, num_frames))), std::memory_order_relaxed);
            track_meters_[ti].right_rms.store(static_cast<float>(std::sqrt(track_sum_r / std::max(1, num_frames))), std::memory_order_relaxed);

            auto route = route_channels(track.audio_to, num_channels);
            const int left_channel = route.empty() ? 0 : route[0];
            const int right_channel = route.size() > 1 ? route[1] : -1;
            const bool left_only_source = track_peak_l > 1.0e-7f && track_peak_r <= 1.0e-7f;
            const bool right_only_source = track_peak_r > 1.0e-7f && track_peak_l <= 1.0e-7f;

            for (int f = 0; f < num_frames; ++f) {
                const float t = static_cast<float>(f + 1) / static_cast<float>(std::max(1, num_frames));
                const float sample_gain = start_gain + (end_gain - start_gain) * t;
                const float sample_mute_gain = start_mute_gain + (end_mute_gain - start_mute_gain) * t;
                const float sample_solo_gain = start_solo_gain + (end_solo_gain - start_solo_gain) * t;
                const float effective_gain = sample_gain * sample_mute_gain * sample_solo_gain;
                const float pan = clamp_pan(start_pan + (end_pan - start_pan) * t);
                const float left_gain = pan > 0.0f ? 1.0f - pan : 1.0f;
                const float right_gain = pan < 0.0f ? 1.0f + pan : 1.0f;
                float source_l = mix_l_[f];
                float source_r = mix_r_[f];
                if (left_only_source)
                    source_r = source_l;
                else if (right_only_source)
                    source_l = source_r;

                float out_l = source_l * effective_gain * left_gain;
                float out_r = source_r * effective_gain * right_gain;
                if (right_channel < 0) {
                    if (left_channel >= 0 && left_channel < num_channels)
                        output_channels[left_channel][output_offset + f] += 0.5f * (out_l + out_r);
                } else {
                    if (left_channel >= 0 && left_channel < num_channels)
                        output_channels[left_channel][output_offset + f] += out_l;
                    if (right_channel >= 0 && right_channel < num_channels)
                        output_channels[right_channel][output_offset + f] += out_r;
                }
            }
        }
        break;
    }

    rendered_track_count_.fetch_add(rendered_this_block, std::memory_order_relaxed);
    skipped_track_count_.fetch_add(skipped_this_block, std::memory_order_relaxed);

    std::array<float*, 64> shifted_channels{};
    float** metronome_channels = output_channels;
    if (num_channels <= static_cast<int>(shifted_channels.size())) {
        for (int ch = 0; ch < num_channels; ++ch)
            shifted_channels[static_cast<std::size_t>(ch)] = output_channels[ch] + output_offset;
        metronome_channels = shifted_channels.data();
    }
    metronome_.render(metronome_channels, num_channels, num_frames,
                      clock_->sample_rate(), timeline_frame, session.get());

    const bool was_pending_start = clock_->pending_start();
    clock_->advance(num_frames);
    if (was_pending_start)
        clock_->clear_pending_start();
}

void Mixer::render(float** output_channels,
                   int     num_channels,
                   int     num_frames,
                   double  /*sample_rate*/) noexcept {
    auto t0 = std::chrono::steady_clock::now();
    callback_count_.fetch_add(1, std::memory_order_relaxed);
    auto session = std::atomic_load(&session_);

    // Drain pending scheduler ops (at top of block, before clock advance).
    scheduler_->drain_pending();

    auto due_jump = session ? scheduler_->check_due(*clock_, *session, num_frames) : std::nullopt;

    // Zero output buses.
    for (int ch = 0; ch < num_channels; ++ch)
        std::fill(output_channels[ch], output_channels[ch] + num_frames, 0.f);

    Frame timeline_frame = clock_->position().frame;

    reset_track_meters();

    bool fade_processed_in_split = false;
    if (due_jump) {
        const Frame block_start = clock_->position().frame;
        const int pre_frames = static_cast<int>(std::clamp<Frame>(
            due_jump->trigger_frame - block_start, 0, num_frames));
        const auto prepared_summary =
            summarize_prepared_voice_map(due_jump->prepared_voice_map);
        jump_debug_log(
            "[LT_JUMP_DEBUG][mixer] due block_start=%lld block_frames=%d trigger_frame=%lld pre_frames=%d post_frames=%d target_frame=%lld prepared=%d prepared_voices=%d prepared_fifo_min=%d prepared_fifo_max=%d prepared_fifo_total=%d suppress_seek_fade=%d pending_start=%d\n",
            static_cast<long long>(block_start),
            num_frames,
            static_cast<long long>(due_jump->trigger_frame),
            pre_frames,
            num_frames - pre_frames,
            static_cast<long long>(due_jump->target_frame),
            due_jump->prepared_voice_map ? 1 : 0,
            prepared_summary.voices,
            prepared_summary.queued_min,
            prepared_summary.queued_max,
            prepared_summary.queued_total,
            due_jump->suppress_seek_fade ? 1 : 0,
            clock_->pending_start() ? 1 : 0);

        const bool apply_seek_fade =
            !due_jump->suppress_seek_fade || static_cast<bool>(due_jump->prepared_voice_map);

        render_timeline_span(output_channels, num_channels, pre_frames, 0, session);
        if (apply_seek_fade && pre_frames > 0)
            fade_.capture_previous_sample(output_channels, num_channels, pre_frames - 1);

        const Frame from = clock_->position().frame;
        if (bungee_voices_ && due_jump->prepared_voice_map) {
            const auto publish_summary =
                summarize_prepared_voice_map(due_jump->prepared_voice_map);
            jump_debug_log(
                "[LT_JUMP_DEBUG][mixer] publish_prepared target_frame=%lld from_frame=%lld voices=%d fifo_min=%d fifo_max=%d fifo_total=%d\n",
                static_cast<long long>(due_jump->target_frame),
                static_cast<long long>(from),
                publish_summary.voices,
                publish_summary.queued_min,
                publish_summary.queued_max,
                publish_summary.queued_total);
            bungee_voices_->publish_prepared_voice_map_realtime(due_jump->prepared_voice_map);
        }
        clock_->seek(due_jump->target_frame);
        clock_->clear_pending_start();
        scheduler_->mark_executed(from, due_jump->target_frame);
        if (apply_seek_fade)
            fade_.trigger_crossfade();
        if (!due_jump->prepared_voice_map) {
            if (bungee_voices_)
                bungee_voices_->publish_empty_voice_map_realtime();
            pending_scheduled_jump_frame_.store(due_jump->target_frame, std::memory_order_release);
            jump_debug_log(
                "[LT_JUMP_DEBUG][mixer] scheduled_jump_needs_control_repair target_frame=%lld\n",
                static_cast<long long>(due_jump->target_frame));
        }
        scheduled_jump_executed_count_.fetch_add(1, std::memory_order_relaxed);

        render_timeline_span(output_channels, num_channels, num_frames - pre_frames,
                             pre_frames, session);
        jump_debug_log(
            "[LT_JUMP_DEBUG][mixer] rendered_post_jump post_frames=%d clock_frame_after=%lld executed_count=%llu applied_seek_fade=%d\n",
            num_frames - pre_frames,
            static_cast<long long>(clock_->position().frame),
            static_cast<unsigned long long>(
                scheduled_jump_executed_count_.load(std::memory_order_relaxed)),
            apply_seek_fade ? 1 : 0);
        const int post_frames = num_frames - pre_frames;
        if (apply_seek_fade) {
            std::array<float*, 64> shifted_channels{};
            float** fade_channels = output_channels;
            if (num_channels <= static_cast<int>(shifted_channels.size())) {
                for (int ch = 0; ch < num_channels; ++ch)
                    shifted_channels[static_cast<std::size_t>(ch)] = output_channels[ch] + pre_frames;
                fade_channels = shifted_channels.data();
            }
            fade_.process(fade_channels, num_channels, post_frames);
        }
        fade_processed_in_split = true;
    } else if (clock_->position().state == TransportState::Playing && session) {
        std::uint64_t rendered_this_block = 0;
        std::uint64_t skipped_this_block = 0;
        // Find the current song.
        for (const auto& song : session->songs) {
            if (timeline_frame < song.start_frame || timeline_frame >= song.end_frame)
                continue;

            const bool solo_active = any_solo_active_in_slots();

            // Render each track.
            for (std::size_t ti = 0; ti < song.tracks.size() && ti < kMaxTracks; ++ti) {
                const Track& track = song.tracks[ti];

                // Folder tracks are not audio sources — skip rendering them.
                if (track.kind == TrackKind::Folder) {
                    ++skipped_this_block;
                    continue;
                }

                int slot_idx = control_index_for_track(track.id);
                TrackControlState* control = (slot_idx >= 0) ? &controls_[static_cast<std::size_t>(slot_idx)] : nullptr;

                if (!control) {
                    fallback_control_.track_id = track.id;
                    fallback_control_.parent_track_id = track.parent_track_id;
                    fallback_control_.parent_control_index = -1;
                    fallback_control_.is_folder = false;
                    fallback_control_.gain.store(track.gain, std::memory_order_relaxed);
                    fallback_control_.pan.store(std::clamp(track.pan, -1.0f, 1.0f), std::memory_order_relaxed);
                    fallback_control_.mute.store(track.mute, std::memory_order_relaxed);
                    fallback_control_.solo.store(track.solo, std::memory_order_relaxed);
                    fallback_control_.current_gain = track.gain;
                    fallback_control_.current_pan = std::clamp(track.pan, -1.0f, 1.0f);
                    fallback_control_.current_mute_gain = track.mute ? 0.0f : 1.0f;
                    fallback_control_.current_solo_gain = solo_active && !track.solo ? 0.0f : 1.0f;
                    fallback_control_.initialized = true;
                    control = &fallback_control_;
                    slot_idx = -1;
                }

                // Compute effective target controls including parent folder chain.
                const EffectiveControls eff = (slot_idx >= 0)
                    ? compute_effective_controls(slot_idx, solo_active)
                    : EffectiveControls{
                        control->gain.load(std::memory_order_relaxed),
                        control->pan.load(std::memory_order_relaxed),
                        control->mute.load(std::memory_order_relaxed),
                        (solo_active && !control->solo.load(std::memory_order_relaxed)) ? 0.0f : 1.0f
                      };

                const float gain        = eff.target_gain;
                const float pan_target  = eff.target_pan;
                const float target_mute_gain = eff.target_muted ? 0.0f : 1.0f;
                const float target_solo_gain = eff.target_solo_gain;

                const float smooth_ms = 10.0f;
                const float coeff = std::clamp(static_cast<float>(num_frames) /
                    std::max(1.0f, static_cast<float>(clock_->sample_rate()) * smooth_ms * 0.001f), 0.0f, 1.0f);
                const float start_gain = control->current_gain;
                const float start_pan = control->current_pan;
                const float start_mute_gain = control->current_mute_gain;
                const float start_solo_gain = control->current_solo_gain;
                const float end_gain = start_gain + (gain - start_gain) * coeff;
                const float end_pan = start_pan + (pan_target - start_pan) * coeff;
                const float end_mute_gain = start_mute_gain + (target_mute_gain - start_mute_gain) * coeff;
                const float end_solo_gain = start_solo_gain + (target_solo_gain - start_solo_gain) * coeff;
                control->current_gain = end_gain;
                control->current_pan = end_pan;
                control->current_mute_gain = end_mute_gain;
                control->current_solo_gain = end_solo_gain;
                const bool settled_silent = std::abs(end_gain * end_mute_gain * end_solo_gain) <= 1.0e-6f
                    && std::abs(start_gain * start_mute_gain * start_solo_gain) <= 1.0e-6f
                    && std::abs(gain * target_mute_gain * target_solo_gain) <= 1.0e-6f;
                if (settled_silent && track.clips.empty()) {
                    ++skipped_this_block;
                    continue;
                }
                // Render into mix bus.
                std::fill(mix_l_, mix_l_ + num_frames, 0.f);
                std::fill(mix_r_, mix_r_ + num_frames, 0.f);

                Track patched = track;
                patched.gain  = 1.0f;
                patched.mute  = false;  // already handled above
                patched.pan = 0.0f;

                renderers_[ti].render(patched, timeline_frame, num_frames,
                                       mix_, 2, *sources_, bungee_voices_,
                                       clock_->sample_rate(), 0, &song,
                                       warp_voices_);
                ++rendered_this_block;

                float track_peak_l = 0.f, track_peak_r = 0.f;
                double track_sum_l = 0.0, track_sum_r = 0.0;
                for (int f = 0; f < num_frames; ++f) {
                    track_peak_l = std::max(track_peak_l, std::abs(mix_l_[f]));
                    track_peak_r = std::max(track_peak_r, std::abs(mix_r_[f]));
                    track_sum_l += static_cast<double>(mix_l_[f]) * mix_l_[f];
                    track_sum_r += static_cast<double>(mix_r_[f]) * mix_r_[f];
                }
                track_meters_[ti].left_peak.store(track_peak_l, std::memory_order_relaxed);
                track_meters_[ti].right_peak.store(track_peak_r, std::memory_order_relaxed);
                track_meters_[ti].left_rms.store(static_cast<float>(std::sqrt(track_sum_l / std::max(1, num_frames))), std::memory_order_relaxed);
                track_meters_[ti].right_rms.store(static_cast<float>(std::sqrt(track_sum_r / std::max(1, num_frames))), std::memory_order_relaxed);

                auto route = route_channels(track.audio_to, num_channels);
                const int left_channel = route.empty() ? 0 : route[0];
                const int right_channel = route.size() > 1 ? route[1] : -1;
                const bool left_only_source = track_peak_l > 1.0e-7f && track_peak_r <= 1.0e-7f;
                const bool right_only_source = track_peak_r > 1.0e-7f && track_peak_l <= 1.0e-7f;

                // Accumulate into selected output route.
                for (int f = 0; f < num_frames; ++f) {
                    const float t = static_cast<float>(f + 1) / static_cast<float>(std::max(1, num_frames));
                    const float sample_gain = start_gain + (end_gain - start_gain) * t;
                    const float sample_mute_gain = start_mute_gain + (end_mute_gain - start_mute_gain) * t;
                    const float sample_solo_gain = start_solo_gain + (end_solo_gain - start_solo_gain) * t;
                    const float effective_gain = sample_gain * sample_mute_gain * sample_solo_gain;
                    const float pan = clamp_pan(start_pan + (end_pan - start_pan) * t);
                    const float left_gain = pan > 0.0f ? 1.0f - pan : 1.0f;
                    const float right_gain = pan < 0.0f ? 1.0f + pan : 1.0f;
                    float source_l = mix_l_[f];
                    float source_r = mix_r_[f];
                    if (left_only_source)
                        source_r = source_l;
                    else if (right_only_source)
                        source_l = source_r;

                    float out_l = source_l * effective_gain * left_gain;
                    float out_r = source_r * effective_gain * right_gain;
                    if (right_channel < 0) {
                        if (left_channel >= 0 && left_channel < num_channels)
                            output_channels[left_channel][f] += 0.5f * (out_l + out_r);
                    } else {
                        if (left_channel >= 0 && left_channel < num_channels)
                            output_channels[left_channel][f] += out_l;
                        output_channels[right_channel][f] += out_r;
                    }
                }
            }
            break;
        }
        rendered_track_count_.fetch_add(rendered_this_block, std::memory_order_relaxed);
        skipped_track_count_.fetch_add(skipped_this_block, std::memory_order_relaxed);

        metronome_.render(output_channels, num_channels, num_frames,
                          clock_->sample_rate(), timeline_frame, session.get());

        const bool was_pending_start = clock_->pending_start();
        clock_->advance(num_frames);
        if (was_pending_start)
            clock_->clear_pending_start();
    }

    // Apply crossfade ramp (Phase 7).
    if (!fade_processed_in_split)
        fade_.process(output_channels, num_channels, num_frames);

    apply_master_gain(output_channels, num_channels, num_frames);

    // Peak meters.
    float peak_l = 0.f, peak_r = 0.f;
    double sum_l = 0.0, sum_r = 0.0;
    for (int f = 0; f < num_frames; ++f) {
        peak_l = std::max(peak_l, std::abs(output_channels[0][f]));
        sum_l += static_cast<double>(output_channels[0][f]) * output_channels[0][f];
        if (num_channels >= 2)
        {
            peak_r = std::max(peak_r, std::abs(output_channels[1][f]));
            sum_r += static_cast<double>(output_channels[1][f]) * output_channels[1][f];
        }
    }
    meter_l_.store(peak_l, std::memory_order_relaxed);
    meter_r_.store(peak_r, std::memory_order_relaxed);
    meter_l_rms_.store(static_cast<float>(std::sqrt(sum_l / std::max(1, num_frames))), std::memory_order_relaxed);
    meter_r_rms_.store(static_cast<float>(std::sqrt(sum_r / std::max(1, num_frames))), std::memory_order_relaxed);

    // advance() ticks the clock forward — keeping playhead and audio aligned.
    if (session) {
        int count = 0;
        for (const auto& song : session->songs) {
            if (timeline_frame >= song.start_frame && timeline_frame < song.end_frame) {
                count = static_cast<int>(std::min<std::size_t>(song.tracks.size(), kMaxTracks));
                break;
            }
        }
        track_meter_count_.store(count, std::memory_order_relaxed);
    } else {
        track_meter_count_.store(0, std::memory_order_relaxed);
    }

    auto t1 = std::chrono::steady_clock::now();
    double dur = std::chrono::duration<double, std::milli>(t1 - t0).count();
    double prev = callback_duration_ms_.load(std::memory_order_relaxed);
    callback_duration_ms_.store(0.9 * prev + 0.1 * dur, std::memory_order_relaxed);
    double max_prev = callback_duration_max_ms_.load(std::memory_order_relaxed);
    while (dur > max_prev
           && !callback_duration_max_ms_.compare_exchange_weak(
               max_prev, dur, std::memory_order_relaxed)) {}
    const double budget_ms = clock_ ? (static_cast<double>(num_frames) * 1000.0
        / static_cast<double>(std::max(1, clock_->sample_rate()))) : 0.0;
    if (budget_ms > 0.0 && dur > budget_ms * 0.75)
        callback_over_budget_count_.fetch_add(1, std::memory_order_relaxed);
}

void Mixer::set_track_gain(const Id& track_id, Gain gain) {
    if (auto* control = control_for_track(track_id))
        control->gain.store(std::max(0.0f, gain), std::memory_order_relaxed);
}

void Mixer::set_track_pan(const Id& track_id, float pan) {
    if (auto* control = control_for_track(track_id))
        control->pan.store(std::clamp(pan, -1.0f, 1.0f), std::memory_order_relaxed);
}

void Mixer::set_track_mute(const Id& track_id, bool mute) {
    if (auto* control = control_for_track(track_id))
        control->mute.store(mute, std::memory_order_relaxed);
}

void Mixer::set_track_solo(const Id& track_id, bool solo) {
    if (auto* control = control_for_track(track_id))
        control->solo.store(solo, std::memory_order_relaxed);
}

void Mixer::start_master_fade(float target_gain, double duration_seconds) noexcept {
    master_fade_target_gain_.store(std::clamp(target_gain, 0.0f, 1.0f),
                                   std::memory_order_relaxed);
    master_fade_duration_seconds_.store(std::max(0.0, duration_seconds),
                                        std::memory_order_relaxed);
    master_fade_request_seq_.fetch_add(1, std::memory_order_release);
}

void Mixer::set_session(std::shared_ptr<const Session> session, bool preserve_realtime_state) {
    std::atomic_store(&session_, std::move(session));
    rebuild_control_slots(std::atomic_load(&session_), preserve_realtime_state);
    prepare_render_resources(kMaxBlockFrames);
    reset_track_meters();
}

void Mixer::set_bungee_voice_manager(BungeeVoiceManager* mgr) noexcept {
    bungee_voices_ = mgr;
}

void Mixer::set_warp_voice_manager(WarpVoiceManager* mgr) noexcept {
    warp_voices_ = mgr;
}

void Mixer::clear_session() {
    std::atomic_store(&session_, std::shared_ptr<const Session>{});
    reset_track_meters();
}

void Mixer::prepare_render_resources(int max_block_frames) noexcept {
    const int frames = std::clamp(max_block_frames, 1, kMaxBlockFrames);
    for (auto& renderer : renderers_)
        renderer.prepare(frames);
}

void Mixer::trigger_crossfade() noexcept {
    fade_.trigger_crossfade();
}

void Mixer::apply_master_gain(float** output_channels, int num_channels, int num_frames) noexcept {
    if (num_channels <= 0 || num_frames <= 0)
        return;

    const auto seq = master_fade_request_seq_.load(std::memory_order_acquire);
    if (seq != master_fade_applied_seq_) {
        master_fade_applied_seq_ = seq;
        master_gain_start_ = master_gain_current_;
        master_gain_target_ = master_fade_target_gain_.load(std::memory_order_relaxed);
        const double duration = master_fade_duration_seconds_.load(std::memory_order_relaxed);
        const int sr = clock_ ? std::max(1, clock_->sample_rate()) : 48000;
        if (duration <= 0.0) {
            master_gain_current_ = master_gain_target_;
            master_gain_start_ = master_gain_target_;
            master_fade_total_frames_ = 0;
            master_fade_processed_frames_ = 0;
        } else {
            master_fade_total_frames_ = std::max(1, static_cast<int>(std::ceil(duration * sr)));
            master_fade_processed_frames_ = 0;
        }
        jump_debug_log(
            "[LT_JUMP_DEBUG][mixer] start_master_fade current=%.6f target=%.6f duration=%.9f frames=%d\n",
            static_cast<double>(master_gain_start_),
            static_cast<double>(master_gain_target_),
            duration,
            master_fade_total_frames_);
    }

    for (int f = 0; f < num_frames; ++f) {
        if (master_fade_processed_frames_ < master_fade_total_frames_) {
            const float t = master_fade_total_frames_ <= 1
                ? 1.0f
                : static_cast<float>(master_fade_processed_frames_)
                    / static_cast<float>(master_fade_total_frames_ - 1);
            const float eased = t * t * (3.0f - 2.0f * t);
            master_gain_current_ =
                master_gain_start_ + (master_gain_target_ - master_gain_start_) * eased;
            ++master_fade_processed_frames_;
            if (master_fade_processed_frames_ >= master_fade_total_frames_)
                master_gain_current_ = master_gain_target_;
        }

        if (std::abs(master_gain_current_ - 1.0f) <= 0.000001f)
            continue;
        for (int ch = 0; ch < num_channels; ++ch) {
            if (output_channels[ch])
                output_channels[ch][f] *= master_gain_current_;
        }
    }

    for (int ch = 0; ch < num_channels; ++ch) {
        if (!output_channels[ch])
            continue;
        for (int f = 0; f < num_frames; ++f)
            output_channels[ch][f] = soft_limit_output(output_channels[ch][f]);
    }
}

void Mixer::set_metronome_config(const MetronomeConfig& config) {
    metronome_.set_config(config);
}

void Mixer::set_metronome_enabled(bool enabled) {
    metronome_.set_enabled(enabled);
}

void Mixer::set_metronome_volume(float volume) {
    metronome_.set_volume(volume);
}

MetronomeDiagnostics Mixer::metronome_diagnostics() const {
    return metronome_.diagnostics();
}

MeterValues Mixer::meters() const noexcept {
    MeterValues m;
    m.left_peak  = meter_l_.load(std::memory_order_relaxed);
    m.right_peak = meter_r_.load(std::memory_order_relaxed);
    m.left_rms   = meter_l_rms_.load(std::memory_order_relaxed);
    m.right_rms  = meter_r_rms_.load(std::memory_order_relaxed);
    return m;
}

std::vector<TrackMeterValues> Mixer::track_meters() const {
    std::vector<TrackMeterValues> values;
    auto session = std::atomic_load(&session_);
    if (!session) return values;
    Frame frame = clock_ ? clock_->position().frame : 0;
    const Song* active_song = nullptr;
    for (const auto& song : session->songs) {
        if (frame >= song.start_frame && frame < song.end_frame) {
            active_song = &song;
            break;
        }
    }
    if (!active_song && !session->songs.empty()) {
        active_song = &session->songs.front();
    }
    if (!active_song) return values;

    int count = static_cast<int>(std::min<std::size_t>(active_song->tracks.size(), kMaxTracks));
    values.reserve(static_cast<std::size_t>(count));
    for (int i = 0; i < count; ++i) {
        TrackMeterValues meter;
        meter.track_id = active_song->tracks[static_cast<std::size_t>(i)].id;
        meter.left_peak = track_meters_[i].left_peak.load(std::memory_order_relaxed);
        meter.right_peak = track_meters_[i].right_peak.load(std::memory_order_relaxed);
        meter.left_rms = track_meters_[i].left_rms.load(std::memory_order_relaxed);
        meter.right_rms = track_meters_[i].right_rms.load(std::memory_order_relaxed);
        values.push_back(std::move(meter));
    }
    return values;
}

void Mixer::reset_track_meters() noexcept {
    int count = track_meter_count_.load(std::memory_order_relaxed);
    count = std::max(0, std::min(count, kMaxTracks));
    for (int i = 0; i < count; ++i) {
        track_meters_[i].left_peak.store(0.f, std::memory_order_relaxed);
        track_meters_[i].right_peak.store(0.f, std::memory_order_relaxed);
        track_meters_[i].left_rms.store(0.f, std::memory_order_relaxed);
        track_meters_[i].right_rms.store(0.f, std::memory_order_relaxed);
    }
}

int    Mixer::callback_count()       const noexcept { return callback_count_.load(std::memory_order_relaxed); }
double Mixer::callback_duration_ms() const noexcept { return callback_duration_ms_.load(std::memory_order_relaxed); }
double Mixer::callback_duration_max_ms() const noexcept { return callback_duration_max_ms_.load(std::memory_order_relaxed); }
std::uint64_t Mixer::callback_over_budget_count() const noexcept { return callback_over_budget_count_.load(std::memory_order_relaxed); }
std::uint64_t Mixer::rendered_track_count() const noexcept { return rendered_track_count_.load(std::memory_order_relaxed); }
std::uint64_t Mixer::skipped_track_count() const noexcept { return skipped_track_count_.load(std::memory_order_relaxed); }
std::uint64_t Mixer::scheduled_jump_executed_count() const noexcept { return scheduled_jump_executed_count_.load(std::memory_order_relaxed); }

Frame Mixer::take_pending_scheduled_jump() noexcept {
    const Frame f = pending_scheduled_jump_frame_.load(std::memory_order_acquire);
    if (f == kNoJumpPending) return kNoJumpPending;
    // Use compare_exchange to ensure only one control thread call "wins" the jump.
    Frame expected = f;
    if (pending_scheduled_jump_frame_.compare_exchange_strong(
            expected, kNoJumpPending, std::memory_order_acq_rel))
        return f;
    return kNoJumpPending;
}

} // namespace lt
