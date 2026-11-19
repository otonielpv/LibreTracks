#pragma once

// ---------------------------------------------------------------------------
// Analizador de espectro (RTA) del editor de EQ por pista (plan track-eq).
//
// Dos piezas, una a cada lado del hilo de audio:
//
//  - `AnalyzerTap`: búfer circular de la señal mono (L+R)/2 de UNA pista,
//    después de su EQ y antes del fader. Lo escribe el hilo que renderiza esa
//    pista en la fase A (un único productor por bloque) sin alojar ni
//    bloquear; lo lee cualquier hilo que no sea de audio quedándose con la
//    ventana más reciente. Si al copiar el productor ha dado la vuelta por
//    encima, la lectura se descarta (estilo seqlock): un RTA solo necesita la
//    última ventana buena, no todas.
//
//  - `SpectrumAnalyzer`: fuera del hilo de audio. FFT de 4096 puntos con
//    ventana de Hann (signalsmith-dsp `fft.h`), reducida a `kBands` bandas
//    logarítmicas de 20 Hz a 20 kHz (~1/6 de octava) en dB, donde 0 dB es un
//    seno a fondo de escala. Subida instantánea y caída de `kReleaseDbPerSecond`.
//
// Solo hay toma mientras el editor de una pista está abierto: con el
// analizador apagado el mezclador no copia nada.
// ---------------------------------------------------------------------------

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <vector>

namespace lt {

class AnalyzerTap {
public:
    static constexpr std::size_t kCapacity = 16384;

    // Hilo de audio. Mono (L+R)/2.
    void write(const float* left, const float* right, std::size_t frames) noexcept;

    // Cualquier hilo no de audio. Copia las últimas `count` muestras a `out`.
    // Devuelve false si aún no hay tantas o si el productor las pisó durante
    // la copia. `written` recibe el total escrito hasta ese momento.
    bool read_latest(float* out, std::size_t count, std::uint64_t* written) const noexcept;

    std::uint64_t written() const noexcept { return written_.load(std::memory_order_acquire); }

private:
    std::array<std::atomic<float>, kCapacity> samples_{};
    std::atomic<std::uint64_t> written_{0};
};

// Centro en Hz de la banda `band` de `kBands` (log, 20 Hz - 20 kHz). La UI usa
// la misma fórmula.
double spectrum_band_center_hz(std::size_t band, std::size_t band_count);

class SpectrumAnalyzer {
public:
    static constexpr std::size_t kFftSize = 4096;
    static constexpr std::size_t kBands = 64;
    static constexpr float kFloorDb = -100.0f;
    static constexpr float kReleaseDbPerSecond = 30.0f;

    SpectrumAnalyzer();
    ~SpectrumAnalyzer();

    // Analiza la ventana más reciente de `tap` y escribe hasta `capacity`
    // bandas en `out`. `elapsed_seconds` desde la llamada anterior marca la
    // caída. Devuelve las bandas escritas (0 si `capacity` es 0).
    std::size_t analyze(const AnalyzerTap& tap, double sample_rate, double elapsed_seconds,
                        float* out, std::size_t capacity);

    void reset();

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace lt
