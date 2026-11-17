#pragma once

#include <lt_engine/core/types.h>

#include <atomic>
#include <cstddef>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace lt {

// ---------------------------------------------------------------------------
// Banco de muestras de los loops de batería y los one shots (plan drum-loops,
// paso 02).
//
// Muestras cortas decodificadas a RAM a la SR del dispositivo. El hilo de
// audio las lee sin bloquear ni tocar contadores de referencia: cada carga
// publica una VERSIÓN completa e inmutable por puntero atómico, y la versión
// retirada se libera en el hilo de comandos (`collect_retired`), nunca en el
// render (project_voice_map_freed_on_audio_thread).
//
// Protocolo del hilo de audio, una vez por bloque:
//   const SampleBankVersion* v = bank.acquire();   // puntero de peligro
//   ... SampleBank::retain(v) al arrancar una voz, release(v) al acabar ...
//   bank.end_block();
// Una versión se libera solo si no es la actual, el puntero de peligro no la
// señala y no tiene voces vivas.
// ---------------------------------------------------------------------------

struct Sample {
    int channels = 0;              // 1 o 2 (mono se queda mono)
    Frame frames = 0;
    int sample_rate = 0;
    std::vector<float> data;       // intercalado, `frames * channels`
    std::size_t bytes() const noexcept { return data.size() * sizeof(float); }
};

struct SampleBankVersion {
    // Índice = slot asignado por Rust; nullptr = slot vacío o fallido.
    std::vector<std::shared_ptr<const Sample>> slots;
    std::vector<std::string> paths;  // ruta de cada slot (recarga por SR)
    int sample_rate = 0;
    std::size_t total_bytes = 0;
    mutable std::atomic<int> active_voices{0};

    SampleBankVersion() = default;
    SampleBankVersion(const SampleBankVersion&) = delete;
    SampleBankVersion& operator=(const SampleBankVersion&) = delete;
    ~SampleBankVersion();

    /// Lectura desde el hilo de audio: sin reservas ni bloqueos.
    const Sample* sample(int slot) const noexcept {
        if (slot < 0 || static_cast<std::size_t>(slot) >= slots.size()) return nullptr;
        return slots[static_cast<std::size_t>(slot)].get();
    }

    // Ganchos de test: cuántas versiones se han destruido y en qué hilo.
    static int debug_destroyed_count() noexcept;
    static std::thread::id debug_last_destroy_thread() noexcept;
};

struct SampleLoadEntry {
    int slot = -1;
    std::string path;
};

struct SampleLoadEntryResult {
    int slot = -1;
    bool ok = false;
    std::string error;
    int channels = 0;
    Frame frames = 0;
};

struct SampleLoadResult {
    bool ok = false;               // false = no se publicó nada
    std::string error;             // motivo cuando ok == false (p. ej. tope)
    std::size_t total_bytes = 0;
    int sample_rate = 0;
    std::vector<SampleLoadEntryResult> entries;
};

/// Petición de la FFI `lt_audio_engine_load_samples`:
/// `{"samples":[{"slot":0,"path":"..."}], "maxBytes"?: n, "sampleRate"?: n}`.
struct SampleLoadRequest {
    std::vector<SampleLoadEntry> entries;
    std::size_t max_bytes = 0;     // 0 = no cambiar el tope
    int sample_rate = 0;           // 0 = la del dispositivo
};
bool sample_load_request_from_json(const std::string& json, SampleLoadRequest& out,
                                   std::string* error);
/// `{"ok","error"?,"totalBytes","sampleRate","entries":[{"slot","ok","error"?,"channels","frames"}]}`
std::string sample_load_result_to_json(const SampleLoadResult& result);

/// Tope por defecto (D11): 96 MB en escritorio, 48 MB en móvil.
std::size_t default_sample_bank_max_bytes() noexcept;

class SampleBank {
public:
    SampleBank();
    ~SampleBank();
    SampleBank(const SampleBank&) = delete;
    SampleBank& operator=(const SampleBank&) = delete;

    void set_max_bytes(std::size_t bytes) noexcept;
    std::size_t max_bytes() const noexcept;

    // ── Hilo de comandos ────────────────────────────────────────────────
    /// Decodifica `entries` a `sample_rate` y publica un banco nuevo con
    /// exactamente esos slots. Reutiliza las muestras ya cargadas con la
    /// misma ruta y SR. Un fichero que falla se informa en su entrada y el
    /// resto se carga; superar el tope no publica nada.
    SampleLoadResult load(const std::vector<SampleLoadEntry>& entries, int sample_rate);
    /// Vuelve a decodificar el banco actual a otra SR (cambio de dispositivo).
    SampleLoadResult reload_for_sample_rate(int sample_rate);
    /// Libera las versiones retiradas que ya nadie usa. Nunca en el render.
    void collect_retired();
    std::size_t retired_count() const;
    /// Versión publicada (diagnóstico; no protege frente a la liberación).
    const SampleBankVersion* current_for_diagnostics() const noexcept;

    // ── Hilo de audio ───────────────────────────────────────────────────
    const SampleBankVersion* acquire() noexcept;
    void end_block() noexcept;
    static void retain(const SampleBankVersion* version) noexcept;
    static void release(const SampleBankVersion* version) noexcept;

    /// Decodifica un fichero como lo hace el banco (diagnóstico y tests).
    static std::shared_ptr<Sample> decode_sample(const std::string& path,
                                                 int sample_rate,
                                                 std::string* error);

private:
    void publish(std::unique_ptr<SampleBankVersion> next);

    std::atomic<SampleBankVersion*> current_{nullptr};
    std::atomic<SampleBankVersion*> hazard_{nullptr};
    std::atomic<std::size_t> max_bytes_;
    // Solo hilos de comandos: serializa publicar y recolectar. El hilo de
    // audio nunca lo toca.
    mutable std::mutex mutex_;
    std::vector<std::unique_ptr<SampleBankVersion>> retired_;
};

} // namespace lt
