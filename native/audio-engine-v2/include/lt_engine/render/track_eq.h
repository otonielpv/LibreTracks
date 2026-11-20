#pragma once

// ---------------------------------------------------------------------------
// Ecualizador paramétrico por pista (plan track-eq, D2/D5/D6/D7).
//
// Hasta 6 bandas estilo EQ Eight sobre un bus estéreo: cortes de 12/24 dB/oct,
// shelves, campana y notch. Los filtros son biquads de signalsmith-dsp
// (`vendor/signalsmith-dsp/filters.h`); la campana y el notch usan el diseño
// `vicanek`, los shelves `oneSided` y los cortes `bilinear` (Butterworth con
// Q 0,71; el de 24 dB/oct es un Butterworth de 4.º orden en dos etapas).
//
// Es el ÚNICO código DSP del EQ: lo usan el mezclador en vivo y el render
// offline. No se copia.
//
// Hilo de audio: `set_target`, `process`, `reset` y `snap_to_target` no alojan,
// no bloquean y no lanzan. `prepare` tampoco aloja; se llama fuera del hilo de
// audio al cambiar de frecuencia de muestreo.
//
// Suavizado: un cambio de frecuencia, ganancia o Q se recorre en ~10 ms (en
// frames), en escala log para frecuencia y Q y en dB para la ganancia. Los
// coeficientes se recalculan por sub-bloque de 32 muestras SOLO mientras dura
// ese recorrido; parado, cero trigonometría. Encender o apagar una banda o el
// EQ entero es un fundido dry/wet de ~10 ms. Cambiar el tipo o la pendiente de
// una banda audible la funde a cero, cambia el filtro y vuelve a subirla.
//
// Con el EQ apagado y el fundido terminado, `process` no toca los buffers: la
// salida es bit-idéntica a una pista sin EQ.
// ---------------------------------------------------------------------------

#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>

#include <lt_engine/render/track_eq_params.h>

#include <signalsmith-dsp/filters.h>

namespace lt {

// Respuesta de magnitud en dB del conjunto con sus parámetros (sin suavizado),
// evaluada en `freq_hz`. Es la referencia de la curva que pinta la UI.
double track_eq_response_db(const TrackEqParams& params, double sample_rate, double freq_hz);

// Milisegundos de suavizado (rampa de cue) a frames; 0 = el suavizado por
// defecto de `TrackEq`. Lo usan el mezclador y el render offline.
inline std::size_t smoothing_frames_for(double smoothing_ms, double sample_rate) noexcept {
    if (!(smoothing_ms > 0.0) || !(sample_rate > 0.0))
        return 0;
    return static_cast<std::size_t>(std::llround(smoothing_ms * sample_rate / 1000.0));
}

class TrackEq {
public:
    static constexpr std::size_t kSubBlockFrames = 32;

    TrackEq() noexcept = default;

    // Fija la frecuencia de muestreo y deja el EQ apagado y sin estado.
    void prepare(double sample_rate) noexcept;

    // Nuevos parámetros objetivo (ya recortados o no: se recortan aquí).
    // Idempotente: con los mismos parámetros no hace nada.
    //
    // `smoothing_frames` (plan track-eq-2, E4): cuánto dura el recorrido de
    // frecuencia, ganancia y Q hasta el objetivo; 0 = los ~10 ms de siempre.
    // Una rampa de cue de 4 s es UNA llamada con 4 s en frames. Encender o
    // apagar una banda o cambiar su tipo sigue siendo el fundido corto.
    void set_target(const TrackEqParams& params, std::size_t smoothing_frames = 0) noexcept;

    // Frames del suavizado por defecto (~10 ms a la frecuencia preparada).
    std::size_t default_smoothing_frames() const noexcept { return ramp_frames_; }

    // Salta al objetivo sin suavizado ni fundidos (render offline: el primer
    // bloque ya sale ecualizado).
    void snap_to_target() noexcept;

    void process(float* left, float* right, std::size_t frames) noexcept;

    // Borra el estado de los filtros (al salir de silencio), sin tocar
    // parámetros ni fundidos.
    void reset() noexcept;

    // EQ apagado y fundido terminado: `process` no toca la señal.
    bool is_transparent() const noexcept;

    const TrackEqParams& target() const noexcept { return target_; }

#if defined(LT_ENGINE_TEST_HOOKS)
    std::uint64_t coefficient_updates() const noexcept { return coefficient_updates_; }
#endif

private:
    using Biquad = signalsmith::filters::BiquadStatic<double>;

    struct Band {
        // Estructura activa (lo que suena ahora).
        EqBandKind kind = EqBandKind::Peak;
        int stages = 1;
        // Parámetros actuales (suavizados) y objetivo, en su escala de rampa.
        double log2_freq = 0.0, target_log2_freq = 0.0;
        double gain_db = 0.0, target_gain_db = 0.0;
        double log_q = 0.0, target_log_q = 0.0;
        std::size_t ramp_remaining = 0;
        // Fundido dry/wet de la banda.
        double mix = 0.0;
        double mix_target = 0.0;
        // Cambio de tipo/pendiente esperando a que la banda se funda a cero.
        bool structure_pending = false;
        EqBandKind pending_kind = EqBandKind::Peak;
        int pending_stages = 1;
        bool enabled_target = false;
        // [etapa][canal]
        Biquad filters[2][2];
    };

    void configure_band(Band& band) noexcept;
    void snap_bands() noexcept;
    void apply_band_target(Band& band, const TrackEqBandParams& params,
                           std::size_t ramp_frames) noexcept;
    void advance_ramps(std::size_t frames) noexcept;
    void settle_after_chunk() noexcept;
    void process_chunk(float* left, float* right, std::size_t frames) noexcept;

    double sample_rate_ = 48000.0;
    std::size_t ramp_frames_ = 480;
    double mix_step_ = 1.0 / 480.0;

    TrackEqParams target_{};
    std::array<Band, kTrackEqMaxBands> bands_{};
    double global_mix_ = 0.0;
    double global_mix_target_ = 0.0;

#if defined(LT_ENGINE_TEST_HOOKS)
    std::uint64_t coefficient_updates_ = 0;
#endif
};

} // namespace lt
