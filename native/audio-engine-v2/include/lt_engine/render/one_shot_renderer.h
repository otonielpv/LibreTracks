#pragma once

// One shots (plan drum-loops, paso 04): rejilla de 12 pads que disparan
// muestras del SampleBank.
//
// Camino lento: SetOneShotBank / SetOneShotConfig (hilo de comandos, versión
// inmutable por RtPublisher). Camino rápido: `push_trigger`, una cola SPSC de
// capacidad fija que el render vacía al empezar cada bloque, sin snapshot ni
// JSON (D9). Si la cola está llena el evento se descarta y se cuenta.
//
// Hilo de audio: sin reservas ni bloqueos. Los productores de la cola se
// serializan con un mutex del lado productor (UI y MIDI pueden disparar a la
// vez); el hilo de audio nunca lo toma.

#include <lt_engine/core/types.h>
#include <lt_engine/render/loop_renderer.h>
#include <lt_engine/render/output_route.h>
#include <lt_engine/render/rt_publisher.h>
#include <lt_engine/render/sample_bank.h>
#include <lt_engine/render/spsc_ring.h>
#include <lt_engine/session/session.h>

#include <array>
#include <atomic>
#include <cstdint>
#include <mutex>
#include <string>

namespace lt {

constexpr int kOneShotPads = 12;
constexpr int kOneShotVoiceCount = 16;
constexpr int kOneShotTriggerQueue = 256;

enum class OneShotMode : int { OneShot = 0, Gate = 1 };
enum class OneShotQuantize : int { Off = 0, Beat = 1, Bar = 2 };

struct OneShotPadData {
    int slot = -1;                 // -1 = pad vacío
    float gain = 1.0f;
    OneShotMode mode = OneShotMode::OneShot;
    OneShotQuantize quantize = OneShotQuantize::Off;
    int choke_group = 0;           // 0 = sin grupo
};

struct OneShotBankData {
    std::array<OneShotPadData, kOneShotPads> pads{};
};

// Disparo rápido. Los valores son parte de la FFI (lt_audio_engine_trigger):
// añadir al final, nunca reordenar.
enum class TriggerKind : int {
    OneShotDown = 0,               // index = pad, value = velocidad 0-127
    OneShotUp = 1,                 // index = pad
    OneShotStopAll = 2,
    LoopToggle = 3,                // arranca o para el loop
    LoopRow = 4,                   // index = fila: alterna encendida/apagada
    LoopVariation = 5,             // index = fila (-1 todas), value = variación
};

struct OneShotDiagnostics {
    uint32_t playing_mask = 0;
    int active_voices = 0;
    uint64_t triggers = 0;
    uint64_t dropped_triggers = 0;
    uint64_t stolen_voices = 0;
};

class OneShotRenderer {
public:
    // ── Hilo de comandos ────────────────────────────────────────────────
    void set_bank(const OneShotBankData& bank);
    void set_config(const std::string& route, float gain);
    void collect_retired();

    // ── Cualquier hilo (UI, MIDI): camino rápido ─────────────────────────
    /// Encola un disparo. false = cola llena (descartado y contado).
    bool push_trigger(TriggerKind kind, int index, int value) noexcept;

    // ── Lectura desde cualquier hilo ────────────────────────────────────
    /// Bits 0..11: pads con voz sonando (para iluminarlos).
    uint32_t playing_mask() const noexcept { return playing_mask_.load(std::memory_order_acquire); }
    bool wants_audio() const noexcept;
    uint64_t dropped_triggers() const noexcept { return dropped_.load(std::memory_order_acquire); }
    OneShotDiagnostics diagnostics() const;

    // ── Hilo de audio ───────────────────────────────────────────────────
    /// Usa los mismos tramos que el LoopRenderer (cuantización con la rejilla
    /// de la canción). Si el bloque no tiene rejilla (parado), los disparos
    /// cuantizados caen en los tiempos del loop libre si suena, y si no, ya.
    void render(float** output_channels,
                int num_channels,
                int num_frames,
                double sample_rate,
                const Session* session,
                const LoopSpan* spans,
                int span_count,
                SampleBank& bank,
                const LoopRenderer* loop_clock,
                const int* active_output_channels = nullptr,
                int active_output_channel_count = 0) noexcept;

private:
    struct Trigger {
        int kind = 0;
        int index = 0;
        int value = 0;
    };

    struct Pending {
        bool active = false;
        int pad = 0;
        float velocity = 1.0f;
        int quantize = 0;
    };

    struct Voice {
        const Sample* sample = nullptr;
        const SampleBankVersion* version = nullptr;
        Frame position = 0;
        int start_offset = 0;      // frames que esperar dentro del bloque
        float gain = 0.0f;
        int pad = -1;
        int choke_group = 0;
        bool gate = false;
        int fade_total = 0;
        int fade_left = 0;
        uint64_t serial = 0;
        bool active = false;
    };

    void start_voice(int pad, float velocity, int offset) noexcept;
    void release_voice(Voice& voice) noexcept;
    void fade_voice(Voice& voice, int frames) noexcept;
    int quantized_offset(int quantize, int num_frames, const Session* session, const LoopSpan* spans,
                         int span_count, const LoopRenderer* loop_clock) const noexcept;

    RtPublisher<OneShotBankData> bank_;
    std::mutex producer_mutex_;
    SpscRing<Trigger, kOneShotTriggerQueue> triggers_;

    std::atomic<int> route_mode_{0};
    std::atomic<int> route_start_{0};
    std::atomic<int> route_end_{1};
    std::atomic<float> gain_{1.0f};

    std::atomic<uint32_t> playing_mask_{0};
    std::atomic<int> active_voice_count_{0};
    std::atomic<uint64_t> trigger_count_{0};
    std::atomic<uint64_t> dropped_{0};
    std::atomic<uint64_t> stolen_{0};

    // Estado del hilo de audio
    const OneShotBankData* bank_in_block_ = nullptr;
    const SampleBankVersion* bank_version_ = nullptr;
    double sample_rate_ = 48000.0;
    std::array<Pending, kOneShotVoiceCount> pending_{};
    std::array<Voice, kOneShotVoiceCount> voices_{};
    uint64_t voice_serial_ = 0;
};

} // namespace lt
