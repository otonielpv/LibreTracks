#include <lt_engine/render/track_eq.h>

#include <algorithm>
#include <cmath>

namespace lt {

namespace {

// Factores de Q de un Butterworth de 4.º orden respecto al de 2.º (0,7071):
// con la Q por defecto, el corte de 24 dB/oct cae -3 dB en su frecuencia,
// igual que el de 12.
constexpr double kButterworthQ = 0.70710678118654752;
constexpr double kButterworth4Q1 = 0.54119610014619698;
constexpr double kButterworth4Q2 = 1.30656296487637653;

bool is_cut(EqBandKind kind) noexcept {
    return kind == EqBandKind::LowCut || kind == EqBandKind::HighCut;
}

int stages_for(EqBandKind kind, int slope) noexcept {
    return (is_cut(kind) && slope >= 24) ? 2 : 1;
}

float finite_or(float value, float fallback) noexcept {
    return std::isfinite(value) ? value : fallback;
}

// Diseña la etapa `stage` de una banda sobre `filter` con frecuencia
// normalizada (Hz / SR), ganancia en dB y Q. Mismo diseño que replica
// `eqResponse.ts` en la UI.
void design_stage(signalsmith::filters::BiquadStatic<double>& filter,
                  EqBandKind kind, int stages, int stage,
                  double scaled_freq, double gain_db, double q) noexcept {
    using signalsmith::filters::BiquadDesign;
    double stage_q = q;
    if (stages == 2)
        stage_q = q * ((stage == 0 ? kButterworth4Q1 : kButterworth4Q2) / kButterworthQ);
    switch (kind) {
    case EqBandKind::LowCut:
        filter.highpassQ(scaled_freq, stage_q, BiquadDesign::bilinear);
        break;
    case EqBandKind::HighCut:
        filter.lowpassQ(scaled_freq, stage_q, BiquadDesign::bilinear);
        break;
    case EqBandKind::LowShelf:
        filter.lowShelfDbQ(scaled_freq, gain_db, q, BiquadDesign::oneSided);
        break;
    case EqBandKind::HighShelf:
        filter.highShelfDbQ(scaled_freq, gain_db, q, BiquadDesign::oneSided);
        break;
    case EqBandKind::Peak:
        filter.peakDbQ(scaled_freq, gain_db, q, BiquadDesign::vicanek);
        break;
    case EqBandKind::Notch:
        filter.notchQ(scaled_freq, q, BiquadDesign::vicanek);
        break;
    }
}

} // namespace

TrackEqParams default_track_eq_params() noexcept {
    TrackEqParams params;
    params.enabled = true;
    params.band_count = kTrackEqMaxBands;
    const struct { bool enabled; EqBandKind kind; float freq; } defaults[kTrackEqMaxBands] = {
        { false, EqBandKind::LowCut, 40.0f },
        { true, EqBandKind::LowShelf, 100.0f },
        { true, EqBandKind::Peak, 400.0f },
        { true, EqBandKind::Peak, 2500.0f },
        { true, EqBandKind::HighShelf, 8000.0f },
        { false, EqBandKind::HighCut, 18000.0f },
    };
    for (std::size_t i = 0; i < kTrackEqMaxBands; ++i) {
        auto& band = params.bands[i];
        band.enabled = defaults[i].enabled;
        band.kind = defaults[i].kind;
        band.frequency_hz = defaults[i].freq;
        band.gain_db = 0.0f;
        band.q = kTrackEqDefaultQ;
        band.slope_db_per_octave = 12;
    }
    return params;
}

TrackEqParams clamp_params(const TrackEqParams& params) noexcept {
    TrackEqParams out = params;
    out.band_count = std::min(params.band_count, kTrackEqMaxBands);
    for (std::size_t i = 0; i < kTrackEqMaxBands; ++i) {
        auto& band = out.bands[i];
        if (i >= out.band_count) {
            band = TrackEqBandParams{};
            continue;
        }
        const auto raw_kind = static_cast<std::uint8_t>(band.kind);
        if (raw_kind > static_cast<std::uint8_t>(EqBandKind::Notch))
            band.kind = EqBandKind::Peak;
        band.frequency_hz = std::clamp(finite_or(band.frequency_hz, 1000.0f),
                                       kTrackEqMinFrequencyHz, kTrackEqMaxFrequencyHz);
        band.gain_db = std::clamp(finite_or(band.gain_db, 0.0f),
                                  kTrackEqMinGainDb, kTrackEqMaxGainDb);
        band.q = std::clamp(finite_or(band.q, kTrackEqDefaultQ), kTrackEqMinQ, kTrackEqMaxQ);
        band.slope_db_per_octave = band.slope_db_per_octave >= 18 ? 24 : 12;
    }
    return out;
}

double track_eq_response_db(const TrackEqParams& raw, double sample_rate, double freq_hz) {
    const TrackEqParams params = clamp_params(raw);
    if (!params.enabled || sample_rate <= 0.0)
        return 0.0;
    const double scaled_eval = freq_hz / sample_rate;
    double total_db = 0.0;
    for (std::size_t i = 0; i < params.band_count; ++i) {
        const auto& band = params.bands[i];
        if (!band.enabled)
            continue;
        const int stages = stages_for(band.kind, band.slope_db_per_octave);
        for (int stage = 0; stage < stages; ++stage) {
            signalsmith::filters::BiquadStatic<double> filter;
            design_stage(filter, band.kind, stages, stage,
                         band.frequency_hz / sample_rate, band.gain_db, band.q);
            total_db += filter.responseDb(scaled_eval);
        }
    }
    return total_db;
}

void TrackEq::prepare(double sample_rate) noexcept {
    sample_rate_ = sample_rate > 0.0 ? sample_rate : 48000.0;
    ramp_frames_ = std::max<std::size_t>(
        kSubBlockFrames, static_cast<std::size_t>(std::lround(sample_rate_ * 0.010)));
    mix_step_ = 1.0 / static_cast<double>(ramp_frames_);
    target_ = TrackEqParams{};
    bands_ = {};
    global_mix_ = 0.0;
    global_mix_target_ = 0.0;
}

void TrackEq::configure_band(Band& band) noexcept {
    const double scaled_freq = std::exp2(band.log2_freq) / sample_rate_;
    const double q = std::exp(band.log_q);
    for (int stage = 0; stage < band.stages; ++stage) {
        design_stage(band.filters[stage][0], band.kind, band.stages, stage,
                     scaled_freq, band.gain_db, q);
        band.filters[stage][1].copyFrom(band.filters[stage][0]);
    }
#if defined(LT_ENGINE_TEST_HOOKS)
    ++coefficient_updates_;
#endif
}

void TrackEq::apply_band_target(Band& band, const TrackEqBandParams& params) noexcept {
    band.target_log2_freq = std::log2(static_cast<double>(params.frequency_hz));
    band.target_gain_db = params.gain_db;
    band.target_log_q = std::log(static_cast<double>(params.q));
    band.enabled_target = params.enabled;

    const int stages = stages_for(params.kind, params.slope_db_per_octave);
    const bool structure_changed = params.kind != band.kind || stages != band.stages;
    const bool audible = band.mix > 0.0 || band.mix_target > 0.0;

    if (!audible) {
        // Banda callada: se cambia todo de golpe, sin estado que arrastrar.
        band.kind = params.kind;
        band.stages = stages;
        band.structure_pending = false;
        band.log2_freq = band.target_log2_freq;
        band.gain_db = band.target_gain_db;
        band.log_q = band.target_log_q;
        band.ramp_remaining = 0;
        if (params.enabled) {
            for (auto& stage : band.filters)
                for (auto& filter : stage)
                    filter.reset();
            configure_band(band);
            band.mix_target = 1.0;
        }
        return;
    }

    if (structure_changed) {
        // Fundir a cero, cambiar el filtro en `settle_after_chunk` y volver.
        band.structure_pending = true;
        band.pending_kind = params.kind;
        band.pending_stages = stages;
        band.mix_target = 0.0;
        return;
    }

    band.structure_pending = false;
    band.mix_target = params.enabled ? 1.0 : 0.0;
    if (band.log2_freq != band.target_log2_freq || band.gain_db != band.target_gain_db
        || band.log_q != band.target_log_q)
        band.ramp_remaining = ramp_frames_;
}

void TrackEq::set_target(const TrackEqParams& raw) noexcept {
    const TrackEqParams params = clamp_params(raw);
    if (params == target_)
        return;
    target_ = params;
    global_mix_target_ = params.enabled ? 1.0 : 0.0;
    for (std::size_t i = 0; i < kTrackEqMaxBands; ++i) {
        TrackEqBandParams band_params = params.bands[i];
        if (i >= params.band_count)
            band_params.enabled = false;
        apply_band_target(bands_[i], band_params);
    }
    // Con el EQ entero callado no hay nada que suavizar: las bandas saltan.
    if (global_mix_ == 0.0)
        snap_bands();
}

void TrackEq::snap_to_target() noexcept {
    global_mix_ = global_mix_target_;
    snap_bands();
}

void TrackEq::snap_bands() noexcept {
    for (auto& band : bands_) {
        if (band.structure_pending) {
            band.kind = band.pending_kind;
            band.stages = band.pending_stages;
            band.structure_pending = false;
        }
        band.log2_freq = band.target_log2_freq;
        band.gain_db = band.target_gain_db;
        band.log_q = band.target_log_q;
        band.ramp_remaining = 0;
        band.mix_target = band.enabled_target ? 1.0 : 0.0;
        band.mix = band.mix_target;
        for (auto& stage : band.filters)
            for (auto& filter : stage)
                filter.reset();
        if (band.mix > 0.0)
            configure_band(band);
    }
}

void TrackEq::reset() noexcept {
    for (auto& band : bands_)
        for (auto& stage : band.filters)
            for (auto& filter : stage)
                filter.reset();
}

bool TrackEq::is_transparent() const noexcept {
    return global_mix_ == 0.0 && global_mix_target_ == 0.0;
}

void TrackEq::advance_ramps(std::size_t frames) noexcept {
    for (auto& band : bands_) {
        if (band.ramp_remaining == 0)
            continue;
        if (band.mix == 0.0 && band.mix_target == 0.0) {
            band.ramp_remaining = 0;
            continue;
        }
        const std::size_t step = std::min(frames, band.ramp_remaining);
        const double fraction = static_cast<double>(step) / static_cast<double>(band.ramp_remaining);
        band.ramp_remaining -= step;
        if (band.ramp_remaining == 0) {
            band.log2_freq = band.target_log2_freq;
            band.gain_db = band.target_gain_db;
            band.log_q = band.target_log_q;
        } else {
            band.log2_freq += (band.target_log2_freq - band.log2_freq) * fraction;
            band.gain_db += (band.target_gain_db - band.gain_db) * fraction;
            band.log_q += (band.target_log_q - band.log_q) * fraction;
        }
        configure_band(band);
    }
}

void TrackEq::settle_after_chunk() noexcept {
    for (auto& band : bands_) {
        if (band.mix != 0.0 || band.mix_target != 0.0)
            continue;
        // Banda ya callada: se suelta su estado y, si esperaba un cambio de
        // tipo, se aplica ahora y vuelve a subir.
        for (auto& stage : band.filters)
            for (auto& filter : stage)
                filter.reset();
        band.ramp_remaining = 0;
        band.log2_freq = band.target_log2_freq;
        band.gain_db = band.target_gain_db;
        band.log_q = band.target_log_q;
        if (band.structure_pending) {
            band.kind = band.pending_kind;
            band.stages = band.pending_stages;
            band.structure_pending = false;
            if (band.enabled_target) {
                configure_band(band);
                band.mix_target = 1.0;
            }
        }
    }
    if (global_mix_ == 0.0 && global_mix_target_ == 0.0)
        reset();
}

void TrackEq::process_chunk(float* left, float* right, std::size_t frames) noexcept {
    std::size_t active[kTrackEqMaxBands];
    std::size_t active_count = 0;
    for (std::size_t i = 0; i < kTrackEqMaxBands; ++i) {
        const auto& band = bands_[i];
        if (band.mix > 0.0 || band.mix_target > 0.0)
            active[active_count++] = i;
    }

    for (std::size_t frame = 0; frame < frames; ++frame) {
        const double dry_l = left[frame];
        const double dry_r = right[frame];
        double xl = dry_l;
        double xr = dry_r;
        for (std::size_t a = 0; a < active_count; ++a) {
            Band& band = bands_[active[a]];
            double yl = xl;
            double yr = xr;
            for (int stage = 0; stage < band.stages; ++stage) {
                yl = band.filters[stage][0](yl);
                yr = band.filters[stage][1](yr);
            }
            if (band.mix == 1.0 && band.mix_target == 1.0) {
                xl = yl;
                xr = yr;
            } else {
                if (band.mix < band.mix_target)
                    band.mix = std::min(band.mix_target, band.mix + mix_step_);
                else if (band.mix > band.mix_target)
                    band.mix = std::max(band.mix_target, band.mix - mix_step_);
                xl += band.mix * (yl - xl);
                xr += band.mix * (yr - xr);
            }
        }
        if (global_mix_ == 1.0 && global_mix_target_ == 1.0) {
            left[frame] = static_cast<float>(xl);
            right[frame] = static_cast<float>(xr);
        } else {
            if (global_mix_ < global_mix_target_)
                global_mix_ = std::min(global_mix_target_, global_mix_ + mix_step_);
            else if (global_mix_ > global_mix_target_)
                global_mix_ = std::max(global_mix_target_, global_mix_ - mix_step_);
            left[frame] = static_cast<float>(dry_l + global_mix_ * (xl - dry_l));
            right[frame] = static_cast<float>(dry_r + global_mix_ * (xr - dry_r));
        }
    }
}

void TrackEq::process(float* left, float* right, std::size_t frames) noexcept {
    if (is_transparent() || left == nullptr || right == nullptr)
        return;
    std::size_t offset = 0;
    while (offset < frames) {
        const std::size_t chunk = std::min(kSubBlockFrames, frames - offset);
        advance_ramps(chunk);
        process_chunk(left + offset, right + offset, chunk);
        settle_after_chunk();
        offset += chunk;
        if (is_transparent())
            return;
    }
}

} // namespace lt
