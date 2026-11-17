#pragma once

// Loops de batería por pasos (plan drum-loops, paso 03).
//
// El patrón suena con muestras del SampleBank, en el frame exacto que le toca
// a cada paso:
//   - "Seguir canción": los pasos caen en la rejilla del metrónomo
//     (beat_grid.h), con rampas, cambios de compás y el vamp congelado. Con el
//     transporte parado corre libre a la BPM de la canción bajo el playhead.
//   - "Libre": BPM propia (la del patrón o la fijada por tap), sin canción.
// Arrancar, parar y cambiar de variación se cuantizan a compás, tiempo o
// paso siguiente.
//
// Hilo de audio: render() no reserva ni bloquea. Los patrones llegan como un
// LoopProgram inmutable (RtPublisher) y los controles en directo por una cola
// SPSC; lo retirado se libera en el hilo de comandos (collect_retired).

#include <lt_engine/core/commands.h>
#include <lt_engine/core/types.h>
#include <lt_engine/render/output_route.h>
#include <lt_engine/render/rt_publisher.h>
#include <lt_engine/render/sample_bank.h>
#include <lt_engine/render/spsc_ring.h>
#include <lt_engine/session/session.h>

#include <array>
#include <atomic>
#include <cstdint>
#include <limits>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

namespace lt {

constexpr int kLoopMaxRows = 8;
constexpr int kLoopVariations = 4;
constexpr int kLoopMaxSteps = 64;
constexpr int kLoopVoiceCount = 24;

struct LoopPatternRow {
    int slot = -1;                 // slot del SampleBank
    float gain = 1.0f;             // lineal (fila + sonido)
    int choke_group = 0;           // 0 = sin grupo de corte
    // Un byte por paso: 0 silencio, 1 suave, 2 normal, 3 acento.
    std::array<std::array<uint8_t, kLoopMaxSteps>, kLoopVariations> steps{};
};

// Patrón plano y de tamaño fijo: se copia en el hilo de audio sin reservar.
struct LoopPatternData {
    int steps_per_beat = 4;        // 4 semicorcheas, 3 tresillos
    int beats_per_bar = 4;
    int beat_unit = 4;
    int bars = 1;                  // 1, 2 o 4
    double free_bpm = 120.0;       // reloj libre
    double swing = 0.0;            // 0..0.75
    int row_count = 0;
    std::array<LoopPatternRow, kLoopMaxRows> rows{};

    int steps_per_bar() const noexcept { return std::max(1, beats_per_bar) * std::max(1, steps_per_beat); }
    int step_count() const noexcept { return std::min(kLoopMaxSteps, steps_per_bar() * std::max(1, bars)); }
};

struct LoopRowState {
    bool enabled = true;
    int variation = 0;             // 0..3 (A-D)
};

struct RegionLoopData {
    std::string region_id;
    LoopPatternData pattern;
    bool autostart = false;
    int initial_row_count = 0;
    std::array<LoopRowState, kLoopMaxRows> initial_rows{};
};

// Lo que publica el hilo de comandos: el patrón elegido a mano y los loops
// de cada canción (SetRegionLoops). Inmutable una vez publicado.
struct LoopProgram {
    bool has_pattern = false;
    uint64_t pattern_serial = 0;   // cambia en cada SetLoopPattern
    LoopPatternData pattern;
    std::vector<RegionLoopData> regions;
};

// Del comando (vectores) al patrón plano, acotando a los límites del motor.
// Hilo de comandos.
LoopPatternData loop_pattern_data_from_spec(const LoopPatternSpec& spec);

enum class LoopClockMode : int { FollowSong = 0, Free = 1 };
enum class LoopQuantize : int { Bar = 0, Beat = 1, Immediate = 2 };

struct LoopConfig {
    LoopClockMode clock_mode = LoopClockMode::FollowSong;
    double free_bpm = 0.0;         // >0 sustituye a la BPM del patrón (tap)
    LoopQuantize quantize = LoopQuantize::Bar;
    std::string route = "master";
    float gain = 1.0f;
};

// Tramo del bloque y qué reloj rige en él. El Mixer los rellena en orden,
// cubriendo el bloque entero.
enum class LoopSpanKind : int { Stopped = 0, Playing = 1, Vamp = 2 };

struct LoopSpan {
    int offset = 0;
    int frames = 0;
    Frame timeline_frame = 0;      // frame del timeline (o del vamp) al inicio
    LoopSpanKind kind = LoopSpanKind::Stopped;
    const Song* frozen_song = nullptr;  // timing congelado del vamp
};

struct LoopDiagnostics {
    bool playing = false;
    int current_step = -1;
    int current_bar = 0;
    int active_voices = 0;
    uint64_t fired_steps = 0;
    uint64_t triggered_voices = 0;
    uint64_t stolen_voices = 0;
};

class LoopRenderer {
public:
    LoopRenderer();

    // ── Hilo de comandos ────────────────────────────────────────────────
    void set_pattern(const LoopPatternData& pattern);
    void set_region_loops(std::vector<RegionLoopData> regions);
    void set_transport(bool playing);
    /// `enabled`/`variation` < 0 = no cambiar.
    void set_row(int row, int enabled, int variation);
    void set_all_rows(int variation);
    void set_config(const LoopConfig& config);
    LoopConfig config() const;
    void collect_retired();

    // ── Lectura desde cualquier hilo (medidores, reposo) ──────────────────
    bool playing() const noexcept { return playing_.load(std::memory_order_acquire); }
    int current_step() const noexcept { return current_step_.load(std::memory_order_acquire); }
    int current_bar() const noexcept { return current_bar_.load(std::memory_order_acquire); }
    /// Suena o va a sonar: no se puede suspender el stream.
    bool wants_audio() const noexcept;
    LoopDiagnostics diagnostics() const;

    // ── Hilo de audio ───────────────────────────────────────────────────
    void render(float** output_channels,
                int num_channels,
                int num_frames,
                double sample_rate,
                const Session* session,
                const LoopSpan* spans,
                int span_count,
                SampleBank& bank,
                const int* active_output_channels = nullptr,
                int active_output_channel_count = 0) noexcept;

private:
    struct Control {
        enum Type : int { Transport = 0, Row = 1, AllRows = 2 };
        int type = Transport;
        int row = 0;
        int enabled = -1;
        int variation = -1;
        bool playing = false;
    };

    struct Voice {
        const Sample* sample = nullptr;
        const SampleBankVersion* version = nullptr;
        Frame position = 0;
        float gain = 0.0f;
        int choke_group = 0;
        int fade_total = 0;        // >0: fundido de corte en curso
        int fade_left = 0;
        uint64_t serial = 0;
        bool active = false;
    };

    enum class ClockKind : int { None = 0, Follow = 1, Free = 2 };

    void drain_controls() noexcept;
    void sync_program(const LoopProgram* program) noexcept;
    void process_follow(int offset, int frames, Frame t0, const Song* fixed_song,
                        const Session* session, double sample_rate) noexcept;
    void process_free(int offset, int frames, const Song* song_at_playhead, Frame playhead,
                      double sample_rate) noexcept;
    void on_step(int64_t bar, int step_in_bar, bool beat_boundary) noexcept;
    void apply_pending(int64_t bar) noexcept;
    void maybe_enter_region(const Song* song, Frame frame) noexcept;
    double swing_beats(int64_t step) const noexcept;
    void trigger(int slot, float gain, int choke_group) noexcept;
    void render_voices(int offset, int frames) noexcept;
    void release_voice(Voice& voice) noexcept;

    // Hilo de comandos
    RtPublisher<LoopProgram> program_;
    std::mutex writer_mutex_;      // serializa a los que publican (nunca audio)
    uint64_t next_pattern_serial_ = 1;
    SpscRing<Control, 256> controls_;

    std::atomic<int> clock_mode_{0};
    std::atomic<double> free_bpm_{0.0};
    std::atomic<int> quantize_{0};
    std::atomic<int> route_mode_{0};
    std::atomic<int> route_start_{0};
    std::atomic<int> route_end_{1};
    std::atomic<float> gain_{1.0f};
    std::array<char, 64> route_text_{};

    // Publicado para otros hilos
    std::atomic<bool> playing_{false};
    std::atomic<bool> start_requested_{false};
    std::atomic<int> current_step_{-1};
    std::atomic<int> current_bar_{0};
    std::atomic<int> active_voice_count_{0};
    std::atomic<uint64_t> fired_steps_{0};
    std::atomic<uint64_t> triggered_voices_{0};
    std::atomic<uint64_t> stolen_voices_{0};

    // ── Estado del hilo de audio ────────────────────────────────────────
    LoopPatternData pattern_;      // patrón activo (copia)
    bool has_pattern_ = false;
    uint64_t pattern_serial_ = 0;
    std::array<LoopRowState, kLoopMaxRows> rows_{};
    std::array<int, kLoopMaxRows> pending_enabled_{};
    std::array<int, kLoopMaxRows> pending_variation_{};
    int pending_playing_ = -1;     // -1 nada, 0 parar, 1 arrancar
    bool playing_now_ = false;
    bool realign_start_bar_ = false;
    int64_t start_bar_ = 0;
    std::array<char, 128> current_region_id_{};
    const LoopProgram* program_in_block_ = nullptr;

    // Reloj "seguir canción"
    ClockKind last_clock_ = ClockKind::None;
    Frame last_follow_end_ = std::numeric_limits<Frame>::min();
    Frame last_fired_frame_ = std::numeric_limits<Frame>::min();
    int64_t last_bar_ = 0;
    int last_step_in_bar_ = -1;

    // Reloj libre: frames del propio renderer
    Frame clock_ = 0;
    Frame free_origin_clock_ = 0;
    int64_t free_origin_step_ = 0;
    int64_t free_next_step_ = 0;
    double free_step_frames_ = 0.0;
    int free_steps_per_bar_ = 16;

    // Bloque en curso
    double sample_rate_ = 48000.0;
    float** out_ = nullptr;
    int out_channels_ = 0;
    int left_ = 0;
    int right_ = 1;
    float block_gain_ = 1.0f;
    const SampleBankVersion* bank_version_ = nullptr;

    std::array<Voice, kLoopVoiceCount> voices_{};
    uint64_t voice_serial_ = 0;
};

} // namespace lt
