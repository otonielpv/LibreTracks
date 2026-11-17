#include <lt_engine/render/loop_renderer.h>
#include <lt_engine/render/beat_grid.h>

#include <algorithm>
#include <cmath>
#include <cstring>

namespace lt {

namespace {

// Velocidad del paso → ganancia: suave −10 dB, normal −4 dB, acento 0 dB.
constexpr float kVelocityGain[4] = {0.0f, 0.31622777f, 0.63095734f, 1.0f};
constexpr double kChokeFadeSeconds = 0.002;
constexpr float kMaxLoopGain = 4.0f;

int64_t floor_div(int64_t a, int64_t b) noexcept {
    int64_t q = a / b;
    if ((a % b != 0) && ((a < 0) != (b < 0))) --q;
    return q;
}

int64_t positive_mod(int64_t a, int64_t b) noexcept {
    const int64_t m = a % b;
    return m < 0 ? m + b : m;
}

} // namespace

LoopPatternData loop_pattern_data_from_spec(const LoopPatternSpec& spec) {
    LoopPatternData p;
    p.steps_per_beat = spec.steps_per_beat == 3 ? 3 : 4;
    p.beats_per_bar = std::clamp(spec.beats_per_bar, 1, 16);
    p.beat_unit = std::clamp(spec.beat_unit, 1, 32);
    p.bars = spec.bars >= 4 ? 4 : (spec.bars >= 2 ? 2 : 1);
    while (p.bars > 1 && p.steps_per_bar() * p.bars > kLoopMaxSteps) p.bars /= 2;
    p.free_bpm = std::isfinite(spec.free_bpm) ? std::clamp(spec.free_bpm, 30.0, 300.0) : 120.0;
    p.swing = std::isfinite(spec.swing) ? std::clamp(spec.swing, 0.0, 0.75) : 0.0;
    p.row_count = std::min<int>(kLoopMaxRows, static_cast<int>(spec.rows.size()));
    for (int r = 0; r < p.row_count; ++r) {
        const auto& in = spec.rows[static_cast<std::size_t>(r)];
        auto& out = p.rows[static_cast<std::size_t>(r)];
        out.slot = in.slot;
        out.gain = std::isfinite(in.gain) ? std::clamp(in.gain, 0.0f, kMaxLoopGain) : 1.0f;
        out.choke_group = std::max(0, in.choke_group);
        const int variations = std::min<int>(kLoopVariations, static_cast<int>(in.variations.size()));
        for (int v = 0; v < variations; ++v) {
            const auto& steps = in.variations[static_cast<std::size_t>(v)];
            const int count = std::min<int>(kLoopMaxSteps, static_cast<int>(steps.size()));
            for (int s = 0; s < count; ++s)
                out.steps[static_cast<std::size_t>(v)][static_cast<std::size_t>(s)] =
                    static_cast<uint8_t>(std::clamp(steps[static_cast<std::size_t>(s)], 0, 3));
        }
    }
    return p;
}

LoopRenderer::LoopRenderer() {
    pending_enabled_.fill(-1);
    pending_variation_.fill(-1);
    std::memcpy(route_text_.data(), "master", 7);
}

// ── Hilo de comandos ─────────────────────────────────────────────────────────

void LoopRenderer::set_pattern(const LoopPatternData& pattern) {
    std::lock_guard<std::mutex> lock(writer_mutex_);
    auto next = std::make_unique<LoopProgram>();
    if (const LoopProgram* current = program_.current_for_writer()) next->regions = current->regions;
    next->has_pattern = true;
    next->pattern = pattern;
    next->pattern.row_count = std::clamp(pattern.row_count, 0, kLoopMaxRows);
    next->pattern_serial = next_pattern_serial_++;
    program_.publish(std::move(next));
}

void LoopRenderer::set_region_loops(std::vector<RegionLoopData> regions) {
    std::lock_guard<std::mutex> lock(writer_mutex_);
    auto next = std::make_unique<LoopProgram>();
    if (const LoopProgram* current = program_.current_for_writer()) {
        next->has_pattern = current->has_pattern;
        next->pattern = current->pattern;
        next->pattern_serial = current->pattern_serial;
    }
    next->regions = std::move(regions);
    program_.publish(std::move(next));
}

void LoopRenderer::set_transport(bool playing) {
    Control c;
    c.type = Control::Transport;
    c.playing = playing;
    start_requested_.store(playing, std::memory_order_release);
    controls_.push(c);
}

void LoopRenderer::set_row(int row, int enabled, int variation) {
    if (row < 0 || row >= kLoopMaxRows) return;
    Control c;
    c.type = Control::Row;
    c.row = row;
    c.enabled = enabled < 0 ? -1 : (enabled ? 1 : 0);
    c.variation = variation < 0 ? -1 : std::clamp(variation, 0, kLoopVariations - 1);
    controls_.push(c);
}

void LoopRenderer::set_all_rows(int variation) {
    Control c;
    c.type = Control::AllRows;
    c.variation = std::clamp(variation, 0, kLoopVariations - 1);
    controls_.push(c);
}

void LoopRenderer::set_config(const LoopConfig& config) {
    clock_mode_.store(static_cast<int>(config.clock_mode), std::memory_order_release);
    free_bpm_.store(config.free_bpm > 0.0 ? std::clamp(config.free_bpm, 30.0, 300.0) : 0.0,
                    std::memory_order_release);
    quantize_.store(static_cast<int>(config.quantize), std::memory_order_release);
    gain_.store(std::clamp(config.gain, 0.0f, kMaxLoopGain), std::memory_order_release);
    const std::string route = normalize_aux_route(config.route);
    const AuxRoute parsed = parse_aux_route(route);
    route_mode_.store(static_cast<int>(parsed.mode), std::memory_order_release);
    route_start_.store(parsed.start, std::memory_order_release);
    route_end_.store(parsed.end, std::memory_order_release);
    std::lock_guard<std::mutex> lock(writer_mutex_);
    std::fill(route_text_.begin(), route_text_.end(), '\0');
    std::memcpy(route_text_.data(), route.data(), std::min(route.size(), route_text_.size() - 1));
}

LoopConfig LoopRenderer::config() const {
    LoopConfig c;
    c.clock_mode = static_cast<LoopClockMode>(clock_mode_.load(std::memory_order_acquire));
    c.free_bpm = free_bpm_.load(std::memory_order_acquire);
    c.quantize = static_cast<LoopQuantize>(quantize_.load(std::memory_order_acquire));
    c.gain = gain_.load(std::memory_order_acquire);
    c.route = std::string(route_text_.data());
    return c;
}

void LoopRenderer::collect_retired() {
    program_.collect_retired();
}

bool LoopRenderer::wants_audio() const noexcept {
    return playing_.load(std::memory_order_acquire)
        || start_requested_.load(std::memory_order_acquire)
        || active_voice_count_.load(std::memory_order_acquire) > 0;
}

LoopDiagnostics LoopRenderer::diagnostics() const {
    LoopDiagnostics d;
    d.playing = playing_.load(std::memory_order_acquire);
    d.current_step = current_step_.load(std::memory_order_acquire);
    d.current_bar = current_bar_.load(std::memory_order_acquire);
    d.active_voices = active_voice_count_.load(std::memory_order_acquire);
    d.fired_steps = fired_steps_.load(std::memory_order_relaxed);
    d.triggered_voices = triggered_voices_.load(std::memory_order_relaxed);
    d.stolen_voices = stolen_voices_.load(std::memory_order_relaxed);
    return d;
}

// ── Hilo de audio ────────────────────────────────────────────────────────────

void LoopRenderer::drain_controls() noexcept {
    Control c;
    while (controls_.pop(c)) {
        switch (c.type) {
            case Control::Transport:
                pending_playing_ = c.playing ? 1 : 0;
                break;
            case Control::Row:
                if (c.enabled >= 0) pending_enabled_[static_cast<std::size_t>(c.row)] = c.enabled;
                if (c.variation >= 0) pending_variation_[static_cast<std::size_t>(c.row)] = c.variation;
                break;
            case Control::AllRows:
                pending_variation_.fill(c.variation);
                break;
            default:
                break;
        }
    }
}

void LoopRenderer::sync_program(const LoopProgram* program) noexcept {
    if (!program || !program->has_pattern || program->pattern_serial == pattern_serial_) return;
    pattern_ = program->pattern;  // copia de tamaño fijo, sin reservas
    pattern_serial_ = program->pattern_serial;
    has_pattern_ = true;
}

double LoopRenderer::swing_beats(int64_t step) const noexcept {
    if (pattern_.swing <= 0.0 || (step & 1) == 0) return 0.0;
    // Los pasos impares se retrasan swing × duración_del_paso / 2.
    return pattern_.swing * 0.5 / static_cast<double>(std::max(1, pattern_.steps_per_beat));
}

void LoopRenderer::apply_pending(int64_t bar) noexcept {
    if (pending_playing_ == 1) {
        if (!playing_now_) {
            playing_now_ = true;
            start_bar_ = bar;
            realign_start_bar_ = false;
        }
        pending_playing_ = -1;
    } else if (pending_playing_ == 0) {
        playing_now_ = false;
        pending_playing_ = -1;
    }
    for (int r = 0; r < kLoopMaxRows; ++r) {
        auto& row = rows_[static_cast<std::size_t>(r)];
        int& en = pending_enabled_[static_cast<std::size_t>(r)];
        int& var = pending_variation_[static_cast<std::size_t>(r)];
        if (en >= 0) row.enabled = en != 0;
        if (var >= 0) row.variation = var;
        en = -1;
        var = -1;
    }
}

void LoopRenderer::on_step(int64_t bar, int step_in_bar, bool beat_boundary) noexcept {
    const int q = quantize_.load(std::memory_order_relaxed);
    const bool boundary = q == static_cast<int>(LoopQuantize::Immediate)
        || (q == static_cast<int>(LoopQuantize::Beat) && beat_boundary)
        || step_in_bar == 0;
    if (boundary) apply_pending(bar);
    last_bar_ = bar;
    last_step_in_bar_ = step_in_bar;
    fired_steps_.fetch_add(1, std::memory_order_relaxed);
    if (!playing_now_ || !has_pattern_) {
        current_step_.store(-1, std::memory_order_relaxed);
        return;
    }
    if (realign_start_bar_) {
        start_bar_ = bar;
        realign_start_bar_ = false;
    }
    const int bars = std::max(1, pattern_.bars);
    const int pattern_bar = static_cast<int>(positive_mod(bar - start_bar_, bars));
    current_bar_.store(pattern_bar, std::memory_order_relaxed);
    if (step_in_bar >= pattern_.steps_per_bar()) {
        // El compás de la canción es más largo que el del patrón: silencio.
        current_step_.store(-1, std::memory_order_relaxed);
        return;
    }
    const int step = pattern_bar * pattern_.steps_per_bar() + step_in_bar;
    if (step >= kLoopMaxSteps) return;
    current_step_.store(step, std::memory_order_relaxed);
    for (int r = 0; r < pattern_.row_count; ++r) {
        const auto& state = rows_[static_cast<std::size_t>(r)];
        if (!state.enabled) continue;
        const auto& row = pattern_.rows[static_cast<std::size_t>(r)];
        const int variation = std::clamp(state.variation, 0, kLoopVariations - 1);
        const uint8_t velocity = row.steps[static_cast<std::size_t>(variation)][static_cast<std::size_t>(step)];
        if (velocity == 0) continue;
        trigger(row.slot, row.gain * kVelocityGain[std::min<int>(velocity, 3)], row.choke_group);
    }
}

void LoopRenderer::maybe_enter_region(const Song* song, Frame frame) noexcept {
    if (!song) return;
    const Region* region = nullptr;
    for (const auto& r : song->regions) {
        if (frame >= r.start_frame && frame < r.end_frame) {
            region = &r;
            break;
        }
    }
    if (!region) return;
    if (std::strncmp(current_region_id_.data(), region->id.c_str(), current_region_id_.size()) == 0)
        return;
    std::fill(current_region_id_.begin(), current_region_id_.end(), '\0');
    std::memcpy(current_region_id_.data(), region->id.data(),
                std::min(region->id.size(), current_region_id_.size() - 1));
    if (!program_in_block_) return;
    for (const auto& loop : program_in_block_->regions) {
        if (loop.region_id != region->id) continue;
        // Canción con loop propio: su patrón y su estado inicial desde este
        // frame. Sin loop propio se queda el que hubiera.
        pattern_ = loop.pattern;
        has_pattern_ = true;
        for (int r = 0; r < kLoopMaxRows; ++r) {
            rows_[static_cast<std::size_t>(r)] = r < loop.initial_row_count
                ? loop.initial_rows[static_cast<std::size_t>(r)]
                : LoopRowState{};
            pending_enabled_[static_cast<std::size_t>(r)] = -1;
            pending_variation_[static_cast<std::size_t>(r)] = -1;
        }
        if (playing_now_) {
            realign_start_bar_ = true;  // el patrón nuevo empieza en su paso 0
        } else if (loop.autostart) {
            pending_playing_ = 1;
        }
        break;
    }
}

void LoopRenderer::process_follow(int offset, int frames, Frame t0, const Song* fixed_song,
                                  const Session* session, double sample_rate) noexcept {
    const Frame end = t0 + frames;
    if (last_clock_ != ClockKind::Follow || t0 != last_follow_end_) {
        // Discontinuidad (Play, salto, vamp): la fase sale de la canción.
        last_fired_frame_ = std::numeric_limits<Frame>::min();
        if (last_clock_ == ClockKind::Free) realign_start_bar_ = playing_now_;
    }
    last_clock_ = ClockKind::Follow;
    Frame t = t0;
    while (t < end) {
        const Song* song = fixed_song ? fixed_song : active_song(session, t);
        if (!song) {
            process_free(offset + static_cast<int>(t - t0), static_cast<int>(end - t), nullptr, t,
                         sample_rate);
            last_follow_end_ = end;
            return;
        }
        if (!fixed_song) maybe_enter_region(song, t);
        const Frame next_song = fixed_song ? -1 : next_song_start_after(session, song);
        const GridSegment g = grid_segment_at(song, t, sample_rate, next_song);
        Frame seg_end = end;
        if (g.next_grid > t && g.next_grid < seg_end) seg_end = g.next_grid;
        if (!fixed_song) {
            for (const auto& r : song->regions) {
                if (r.start_frame > t && r.start_frame < seg_end) seg_end = r.start_frame;
            }
        }
        if (!g.valid() || !has_pattern_) {
            // Sin rejilla o sin patrón no hay pasos; las voces siguen sonando.
            if (!has_pattern_ && pending_playing_ >= 0) apply_pending(0);
            render_voices(offset + static_cast<int>(t - t0), static_cast<int>(seg_end - t));
            t = seg_end;
            continue;
        }
        const int spb = std::max(1, pattern_.steps_per_beat);
        const int song_steps_per_bar = g.beats_per_bar * spb;
        const double beats = g.beats_at(t, sample_rate);
        int64_t k = std::max<int64_t>(0, static_cast<int64_t>(std::floor(beats * spb)) - 1);
        for (;;) {
            const double beat = static_cast<double>(k) / spb + swing_beats(k);
            const Frame f = g.frame_of_beat(beat, sample_rate);
            if (f < t || f <= last_fired_frame_) {
                ++k;
                continue;
            }
            if (f >= seg_end) break;
            // Mismo criterio que el metrónomo: en un tiempo, el espacio entre
            // clics; entre tiempos, el de la subdivisión.
            const double beat_spacing = g.frames_per_beat_near(beat, sample_rate);
            const double spacing = (k % spb == 0) ? beat_spacing : beat_spacing / spb;
            if (lands_on_next_grid(f, spacing, g.next_grid)) {
                ++k;
                continue;
            }
            render_voices(offset + static_cast<int>(t - t0), static_cast<int>(f - t));
            t = f;
            const int step_in_bar = static_cast<int>(positive_mod(k, song_steps_per_bar));
            on_step(floor_div(k, song_steps_per_bar), step_in_bar, step_in_bar % spb == 0);
            last_fired_frame_ = f;
            ++k;
        }
        render_voices(offset + static_cast<int>(t - t0), static_cast<int>(seg_end - t));
        t = seg_end;
    }
    last_follow_end_ = end;
}

void LoopRenderer::process_free(int offset, int frames, const Song* song_at_playhead, Frame playhead,
                                double sample_rate) noexcept {
    const Frame clock_end = clock_ + frames;
    // Tempo y compás de este reloj: la canción bajo el playhead (Seguir,
    // parado) o el patrón (Libre o sin canción).
    double bpm = pattern_.free_bpm;
    int beats_per_bar = pattern_.beats_per_bar;
    int beat_unit = pattern_.beat_unit;
    if (song_at_playhead) {
        bpm = bpm_at(song_at_playhead, playhead);
        const auto sig = signature_at(song_at_playhead, playhead);
        beats_per_bar = sig.first;
        beat_unit = sig.second;
    } else {
        const double tapped = free_bpm_.load(std::memory_order_relaxed);
        if (tapped > 0.0) bpm = tapped;
    }
    bpm = std::clamp(bpm > 0.0 ? bpm : 120.0, 20.0, 300.0);
    const int spb = std::max(1, pattern_.steps_per_beat);
    const double step_frames =
        sample_rate * 60.0 / bpm * (4.0 / static_cast<double>(std::max(1, beat_unit))) / spb;
    const int steps_per_bar = std::max(1, beats_per_bar) * spb;

    const auto onset = [&](int64_t step) {
        const double steps = static_cast<double>(step - free_origin_step_)
                           + swing_beats(step) * spb;
        return free_origin_clock_ + static_cast<Frame>(std::llround(steps * free_step_frames_));
    };

    if (last_clock_ != ClockKind::Free) {
        // Viene de seguir la canción (Stop) o arranca: el reloj libre sigue
        // desde el paso siguiente al último que sonó.
        if (last_clock_ == ClockKind::Follow && last_step_in_bar_ >= 0 && playing_now_) {
            const int64_t bar = last_bar_ - start_bar_;
            free_next_step_ = bar * steps_per_bar + last_step_in_bar_ + 1;
            start_bar_ = 0;
        } else {
            free_next_step_ = 0;
        }
        free_origin_step_ = free_next_step_;
        free_origin_clock_ = clock_;
        free_step_frames_ = step_frames;
        free_steps_per_bar_ = steps_per_bar;
        last_clock_ = ClockKind::Free;
    } else if (std::abs(step_frames - free_step_frames_) > 1e-9 || steps_per_bar != free_steps_per_bar_) {
        // Cambio de tempo: nuevo origen en el próximo paso, sin salto de fase.
        const Frame next = std::max(clock_, onset(free_next_step_));
        free_origin_step_ = free_next_step_;
        free_origin_clock_ = next;
        free_step_frames_ = step_frames;
        free_steps_per_bar_ = steps_per_bar;
    }

    if (!playing_now_ && pending_playing_ == 1) {
        // Parado no hay rejilla a la que cuantizar: arranca ya, en el paso 0.
        apply_pending(0);
        start_bar_ = 0;
        free_next_step_ = 0;
        free_origin_step_ = 0;
        free_origin_clock_ = clock_;
    }

    Frame now = clock_;
    if (playing_now_ || pending_playing_ >= 0) {
        for (;;) {
            Frame f = onset(free_next_step_);
            if (f < now) f = now;
            if (f >= clock_end) break;
            render_voices(offset + static_cast<int>(now - clock_), static_cast<int>(f - now));
            now = f;
            const int step_in_bar = static_cast<int>(positive_mod(free_next_step_, steps_per_bar));
            on_step(floor_div(free_next_step_, steps_per_bar), step_in_bar, step_in_bar % spb == 0);
            ++free_next_step_;
            if (!playing_now_ && pending_playing_ < 0) break;
        }
    } else {
        current_step_.store(-1, std::memory_order_relaxed);
    }
    render_voices(offset + static_cast<int>(now - clock_), static_cast<int>(clock_end - now));
    clock_ = clock_end;
}

void LoopRenderer::trigger(int slot, float gain, int choke_group) noexcept {
    if (!bank_version_) return;
    const Sample* sample = bank_version_->sample(slot);
    if (!sample || sample->frames <= 0) return;
    if (choke_group > 0) {
        const int fade = std::max(1, static_cast<int>(sample_rate_ * kChokeFadeSeconds));
        for (auto& v : voices_) {
            if (v.active && v.choke_group == choke_group && v.fade_total == 0) {
                v.fade_total = fade;
                v.fade_left = fade;
            }
        }
    }
    Voice* target = nullptr;
    for (auto& v : voices_) {
        if (!v.active) {
            target = &v;
            break;
        }
    }
    if (!target) {
        // Pool agotado: se roba la voz más vieja.
        target = &voices_[0];
        for (auto& v : voices_) {
            if (v.serial < target->serial) target = &v;
        }
        release_voice(*target);
        stolen_voices_.fetch_add(1, std::memory_order_relaxed);
    }
    SampleBank::retain(bank_version_);
    target->sample = sample;
    target->version = bank_version_;
    target->position = 0;
    target->gain = gain;
    target->choke_group = choke_group;
    target->fade_total = 0;
    target->fade_left = 0;
    target->serial = ++voice_serial_;
    target->active = true;
    triggered_voices_.fetch_add(1, std::memory_order_relaxed);
}

void LoopRenderer::release_voice(Voice& voice) noexcept {
    if (!voice.active) return;
    SampleBank::release(voice.version);
    voice.active = false;
    voice.sample = nullptr;
    voice.version = nullptr;
}

void LoopRenderer::render_voices(int offset, int frames) noexcept {
    if (frames <= 0 || !out_) return;
    float* left = out_[left_] + offset;
    float* right = out_[right_] + offset;
    for (auto& v : voices_) {
        if (!v.active) continue;
        const Sample& s = *v.sample;
        const float gain = v.gain * block_gain_;
        int f = 0;
        for (; f < frames; ++f) {
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
        if (v.position >= s.frames || (v.fade_total > 0 && v.fade_left <= 0)) release_voice(v);
    }
}

void LoopRenderer::render(float** output_channels,
                          int num_channels,
                          int num_frames,
                          double sample_rate,
                          const Session* session,
                          const LoopSpan* spans,
                          int span_count,
                          SampleBank& bank,
                          const int* active_output_channels,
                          int active_output_channel_count) noexcept {
    if (num_frames <= 0 || num_channels <= 0 || sample_rate <= 0.0) return;
    sample_rate_ = sample_rate;
    out_ = output_channels;
    out_channels_ = num_channels;
    const ResolvedAuxRoute route = resolve_aux_route(
        static_cast<AuxRouteMode>(route_mode_.load(std::memory_order_relaxed)),
        route_start_.load(std::memory_order_relaxed), route_end_.load(std::memory_order_relaxed),
        num_channels, active_output_channels, active_output_channel_count);
    left_ = std::clamp(route.left, 0, num_channels - 1);
    right_ = std::clamp(route.right, 0, num_channels - 1);
    block_gain_ = gain_.load(std::memory_order_relaxed);

    bank_version_ = bank.acquire();
    program_in_block_ = program_.acquire();
    sync_program(program_in_block_);
    drain_controls();

    const bool free_mode =
        clock_mode_.load(std::memory_order_relaxed) == static_cast<int>(LoopClockMode::Free);
    int done = 0;
    for (int i = 0; i < span_count && done < num_frames; ++i) {
        const LoopSpan& span = spans[i];
        const int frames = std::min(span.frames, num_frames - span.offset);
        if (frames <= 0 || span.offset < done) continue;
        if (span.offset > done) {
            // Hueco sin tramo: corre como parado.
            process_free(done, span.offset - done, nullptr, 0, sample_rate);
            done = span.offset;
        }
        if (free_mode) {
            process_free(span.offset, frames, nullptr, 0, sample_rate);
        } else if (span.kind == LoopSpanKind::Playing) {
            process_follow(span.offset, frames, span.timeline_frame, nullptr, session, sample_rate);
        } else if (span.kind == LoopSpanKind::Vamp && span.frozen_song) {
            process_follow(span.offset, frames, span.timeline_frame, span.frozen_song, session,
                           sample_rate);
        } else {
            process_free(span.offset, frames, active_song(session, span.timeline_frame),
                         span.timeline_frame, sample_rate);
        }
        done = span.offset + frames;
    }
    if (done < num_frames) process_free(done, num_frames - done, nullptr, 0, sample_rate);

    // Lo que ve el resto del motor.
    playing_.store(playing_now_, std::memory_order_release);
    if (pending_playing_ < 0) start_requested_.store(playing_now_, std::memory_order_release);
    if (!playing_now_) current_step_.store(-1, std::memory_order_relaxed);
    int alive = 0;
    for (const auto& v : voices_) alive += v.active ? 1 : 0;
    active_voice_count_.store(alive, std::memory_order_release);

    program_in_block_ = nullptr;
    program_.end_block();
    bank.end_block();
    out_ = nullptr;
}

} // namespace lt
