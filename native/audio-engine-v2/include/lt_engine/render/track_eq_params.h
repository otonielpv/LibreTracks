#pragma once

// Parámetros del ecualizador por pista (plan track-eq, D2). POD plano, sin
// coeficientes: es lo que publica el hilo de comandos y lee el de audio, y lo
// que guarda `Track::eq` en la sesión. Cabecera ligera a propósito (sin
// signalsmith-dsp) para que la sesión la pueda incluir.

#include <array>
#include <cstddef>
#include <cstdint>

namespace lt {

enum class EqBandKind : std::uint8_t {
    LowCut,
    LowShelf,
    Peak,
    HighShelf,
    HighCut,
    Notch,
};

constexpr std::size_t kTrackEqMaxBands = 6;

constexpr float kTrackEqMinFrequencyHz = 20.0f;
constexpr float kTrackEqMaxFrequencyHz = 20000.0f;
constexpr float kTrackEqMinGainDb = -18.0f;
constexpr float kTrackEqMaxGainDb = 18.0f;
constexpr float kTrackEqMinQ = 0.1f;
constexpr float kTrackEqMaxQ = 18.0f;
constexpr float kTrackEqDefaultQ = 0.71f;

struct TrackEqBandParams {
    bool enabled = false;
    EqBandKind kind = EqBandKind::Peak;
    float frequency_hz = 1000.0f;
    float gain_db = 0.0f;
    float q = kTrackEqDefaultQ;
    // Solo cortes: 12 o 24 dB/oct.
    int slope_db_per_octave = 12;

    bool operator==(const TrackEqBandParams&) const = default;
};

struct TrackEqParams {
    bool enabled = false;
    std::size_t band_count = 0;
    std::array<TrackEqBandParams, kTrackEqMaxBands> bands{};

    bool operator==(const TrackEqParams&) const = default;
};

// Las 6 bandas por defecto de D2 (EQ encendido; bandas 1 y 6 apagadas).
TrackEqParams default_track_eq_params() noexcept;

// Recorta rangos, limita a 6 bandas, corrige no finitos y tipos/pendientes
// desconocidos. Un EQ válido sale idéntico. Mismas reglas que
// `TrackEq::sanitized()` del core Rust.
TrackEqParams clamp_params(const TrackEqParams& params) noexcept;

} // namespace lt
