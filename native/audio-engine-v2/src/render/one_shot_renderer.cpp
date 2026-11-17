#include <lt_engine/render/one_shot_renderer.h>
#include <lt_engine/render/beat_grid.h>

#include <algorithm>
#include <cmath>

namespace lt {

namespace {

constexpr double kGateReleaseSeconds = 0.010;
constexpr double kChokeFadeSeconds = 0.002;
constexpr double kStopAllFadeSeconds = 0.030;
constexpr float kMaxOneShotGain = 4.0f;

} // namespace

// ── Hilo de comandos ─────────────────────────────────────────────────────────

void OneShotRenderer::set_bank(const OneShotBankData& bank) {
    auto next = std::make_unique<OneShotBankData>(bank);
    for (auto& pad : next->pads) {
        pad.gain = std::isfinite(pad.gain) ? std::clamp(pad.gain, 0.0f, kMaxOneShotGain) : 1.0f;
        pad.choke_group = std::max(0, pad.choke_group);
    }
    bank_.publish(std::move(next));
}

void OneShotRenderer::set_config(const std::string& route, float gain) {
    const AuxRoute parsed = parse_aux_route(normalize_aux_route(route));
    route_mode_.store(static_cast<int>(parsed.mode), std::memory_order_release);
    route_start_.store(parsed.start, std::memory_order_release);
    route_end_.store(parsed.end, std::memory_order_release);
    gain_.store(std::isfinite(gain) ? std::clamp(gain, 0.0f, kMaxOneShotGain) : 1.0f,
                std::memory_order_release);
}

void OneShotRenderer::collect_retired() {
    bank_.collect_retired();
}

bool OneShotRenderer::push_trigger(TriggerKind kind, int index, int value) noexcept {
    Trigger t;
    t.kind = static_cast<int>(kind);
    t.index = index;
    t.value = value;
    bool pushed = false;
    {
        std::lock_guard<std::mutex> lock(producer_mutex_);
        pushed = triggers_.push(t);
    }
    if (!pushed) dropped_.fetch_add(1, std::memory_order_relaxed);
    return pushed;
}

bool OneShotRenderer::wants_audio() const noexcept {
    return active_voice_count_.load(std::memory_order_acquire) > 0 || !triggers_.empty();
}

OneShotDiagnostics OneShotRenderer::diagnostics() const {
    OneShotDiagnostics d;
    d.playing_mask = playing_mask_.load(std::memory_order_acquire);
    d.active_voices = active_voice_count_.load(std::memory_order_acquire);
    d.triggers = trigger_count_.load(std::memory_order_relaxed);
    d.dropped_triggers = dropped_.load(std::memory_order_relaxed);
    d.stolen_voices = stolen_.load(std::memory_order_relaxed);
    return d;
}

// ── Hilo de audio ────────────────────────────────────────────────────────────

void OneShotRenderer::release_voice(Voice& voice) noexcept {
    if (!voice.active) return;
    SampleBank::release(voice.version);
    voice.active = false;
    voice.sample = nullptr;
    voice.version = nullptr;
}

void OneShotRenderer::fade_voice(Voice& voice, int frames) noexcept {
    if (!voice.active) return;
    frames = std::max(1, frames);
    if (voice.fade_total > 0 && voice.fade_left <= frames) return;  // ya cae más rápido
    voice.fade_total = frames;
    voice.fade_left = frames;
}

void OneShotRenderer::start_voice(int pad_index, float velocity, int offset) noexcept {
    if (!bank_in_block_ || !bank_version_ || pad_index < 0 || pad_index >= kOneShotPads) return;
    const OneShotPadData& pad = bank_in_block_->pads[static_cast<std::size_t>(pad_index)];
    const Sample* sample = bank_version_->sample(pad.slot);
    if (!sample || sample->frames <= 0) return;
    if (pad.choke_group > 0) {
        const int fade = static_cast<int>(sample_rate_ * kChokeFadeSeconds);
        for (auto& v : voices_)
            if (v.active && v.choke_group == pad.choke_group) fade_voice(v, fade);
    }
    Voice* target = nullptr;
    for (auto& v : voices_) {
        if (!v.active) {
            target = &v;
            break;
        }
    }
    if (!target) {
        target = &voices_[0];
        for (auto& v : voices_)
            if (v.serial < target->serial) target = &v;
        release_voice(*target);
        stolen_.fetch_add(1, std::memory_order_relaxed);
    }
    SampleBank::retain(bank_version_);
    target->sample = sample;
    target->version = bank_version_;
    target->position = 0;
    target->start_offset = std::max(0, offset);
    target->gain = pad.gain * velocity;
    target->pad = pad_index;
    target->choke_group = pad.choke_group;
    target->gate = pad.mode == OneShotMode::Gate;
    target->fade_total = 0;
    target->fade_left = 0;
    target->serial = ++voice_serial_;
    target->active = true;
}

int OneShotRenderer::quantized_offset(int quantize, int num_frames, const Session* session,
                                      const LoopSpan* spans, int span_count,
                                      const LoopRenderer* loop_clock) const noexcept {
    const bool bar = quantize == static_cast<int>(OneShotQuantize::Bar);
    const bool free_clock = loop_clock && loop_clock->free_clock();
    for (int i = 0; i < span_count; ++i) {
        const LoopSpan& span = spans[i];
        const int frames = std::min(span.frames, num_frames - span.offset);
        if (frames <= 0) continue;
        const bool has_grid = !free_clock
            && (span.kind == LoopSpanKind::Playing || span.kind == LoopSpanKind::Vamp);
        if (!has_grid) {
            // Sin rejilla de canción: los tiempos del loop si corre, y si no, ya.
            if (!loop_clock || !loop_clock->clock_running()) return span.offset;
            const int mark = loop_clock->block_mark_at_or_after(span.offset, bar);
            if (mark >= 0 && mark < span.offset + frames) return mark;
            continue;
        }
        const Song* song = span.kind == LoopSpanKind::Vamp ? span.frozen_song
                                                            : active_song(session, span.timeline_frame);
        if (!song) return span.offset;
        const Frame t = span.timeline_frame;
        const Frame next_song = span.kind == LoopSpanKind::Vamp ? -1 : next_song_start_after(session, song);
        const GridSegment g = grid_segment_at(song, t, sample_rate_, next_song);
        if (!g.valid()) return span.offset;
        const double beats = g.beats_at(t, sample_rate_);
        const double unit = bar ? static_cast<double>(g.beats_per_bar) : 1.0;
        double k = std::max(0.0, std::ceil(beats / unit - 1e-9)) * unit;
        Frame f = g.frame_of_beat(k, sample_rate_);
        if (f < t) f = g.frame_of_beat(k + unit, sample_rate_);
        // El tramo siguiente empieza en compás: si llega antes, manda él.
        if (g.next_grid > t && f >= g.next_grid) f = g.next_grid;
        if (f < t + frames) return span.offset + static_cast<int>(f - t);
    }
    return -1;
}

void OneShotRenderer::render(float** output_channels,
                             int num_channels,
                             int num_frames,
                             double sample_rate,
                             const Session* session,
                             const LoopSpan* spans,
                             int span_count,
                             SampleBank& bank,
                             const LoopRenderer* loop_clock,
                             const int* active_output_channels,
                             int active_output_channel_count) noexcept {
    if (num_frames <= 0 || num_channels <= 0 || sample_rate <= 0.0) return;
    sample_rate_ = sample_rate;
    bank_version_ = bank.acquire();
    bank_in_block_ = bank_.acquire();

    Trigger t;
    while (triggers_.pop(t)) {
        trigger_count_.fetch_add(1, std::memory_order_relaxed);
        switch (static_cast<TriggerKind>(t.kind)) {
            case TriggerKind::OneShotDown: {
                if (!bank_in_block_ || t.index < 0 || t.index >= kOneShotPads) break;
                const OneShotPadData& pad = bank_in_block_->pads[static_cast<std::size_t>(t.index)];
                if (pad.slot < 0) break;
                const float velocity =
                    static_cast<float>(std::clamp(t.value <= 0 ? 127 : t.value, 1, 127)) / 127.0f;
                if (pad.quantize == OneShotQuantize::Off) {
                    start_voice(t.index, velocity, 0);
                    break;
                }
                for (auto& p : pending_) {
                    if (!p.active) {
                        p.active = true;
                        p.pad = t.index;
                        p.velocity = velocity;
                        p.quantize = static_cast<int>(pad.quantize);
                        break;
                    }
                }
                break;
            }
            case TriggerKind::OneShotUp: {
                const int fade = static_cast<int>(sample_rate_ * kGateReleaseSeconds);
                for (auto& v : voices_)
                    if (v.active && v.gate && v.pad == t.index) fade_voice(v, fade);
                // Un gate soltado antes de su compás no llega a sonar.
                if (bank_in_block_ && t.index >= 0 && t.index < kOneShotPads
                    && bank_in_block_->pads[static_cast<std::size_t>(t.index)].mode == OneShotMode::Gate) {
                    for (auto& p : pending_)
                        if (p.active && p.pad == t.index) p.active = false;
                }
                break;
            }
            case TriggerKind::OneShotStopAll: {
                const int fade = static_cast<int>(sample_rate_ * kStopAllFadeSeconds);
                for (auto& v : voices_) fade_voice(v, fade);
                for (auto& p : pending_) p.active = false;
                break;
            }
            default:
                break;
        }
    }

    for (auto& p : pending_) {
        if (!p.active) continue;
        const int offset = quantized_offset(p.quantize, num_frames, session, spans, span_count, loop_clock);
        if (offset < 0) continue;
        start_voice(p.pad, p.velocity, offset);
        p.active = false;
    }

    const ResolvedAuxRoute route = resolve_aux_route(
        static_cast<AuxRouteMode>(route_mode_.load(std::memory_order_relaxed)),
        route_start_.load(std::memory_order_relaxed), route_end_.load(std::memory_order_relaxed),
        num_channels, active_output_channels, active_output_channel_count);
    float* left = output_channels[std::clamp(route.left, 0, num_channels - 1)];
    float* right = output_channels[std::clamp(route.right, 0, num_channels - 1)];
    const float master = gain_.load(std::memory_order_relaxed);

    uint32_t mask = 0;
    int alive = 0;
    for (auto& v : voices_) {
        if (!v.active) continue;
        const Sample& s = *v.sample;
        const float gain = v.gain * master;
        int f = std::min(v.start_offset, num_frames);
        v.start_offset = std::max(0, v.start_offset - num_frames);
        for (; f < num_frames; ++f) {
            if (v.position >= s.frames) break;
            float g = gain;
            if (v.fade_total > 0) {
                if (v.fade_left <= 0) break;
                g *= static_cast<float>(v.fade_left) / static_cast<float>(v.fade_total);
                --v.fade_left;
            }
            const std::size_t i = static_cast<std::size_t>(v.position) * static_cast<std::size_t>(s.channels);
            const float l = s.data[i] * g;
            const float r = s.channels > 1 ? s.data[i + 1] * g : l;
            left[f] += l;
            if (right != left) right[f] += r;
            ++v.position;
        }
        if (v.position >= s.frames || (v.fade_total > 0 && v.fade_left <= 0)) {
            release_voice(v);
            continue;
        }
        ++alive;
        if (v.pad >= 0 && v.pad < kOneShotPads) mask |= 1u << v.pad;
    }
    playing_mask_.store(mask, std::memory_order_release);
    active_voice_count_.store(alive, std::memory_order_release);

    bank_in_block_ = nullptr;
    bank_.end_block();
    bank.end_block();
}

} // namespace lt
