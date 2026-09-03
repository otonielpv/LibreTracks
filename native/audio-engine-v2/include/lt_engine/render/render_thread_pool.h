#pragma once

// ---------------------------------------------------------------------------
// RenderThreadPool — reparte la fase A del bloque entre el hilo del callback
// («el director») y N-1 trabajadores en prioridad de audio.
//
// Por qué existe: el coste del warp es ~1 % del presupuesto del callback POR
// PISTA y el hilo de audio las recorre en serie, así que 24 pistas warpeadas
// son ~30 % en una máquina rápida y el 96 % que reportó un usuario en la suya.
// Medido, repartir esas voces escala ~3,8x con 4 hilos, y sigue escalando con
// buffers de 128 frames. Ver los hechos 2 y 3 de
// docs/plans/audio-thread-parallelism/00-DIAGNOSTICO.md.
//
// ── Las reglas que lo hacen viable ─────────────────────────────────────────
//
// 1. ESPERA HIBRIDA. Tras acabar un bloque los trabajadores giran brevemente
//    para absorber publicaciones contiguas (bancos/tests), y luego duermen
//    sobre el contador atomico. Nunca queman el hueco completo entre callbacks.
//    La junta del director si usa espera activa: ahi hay trabajo real pendiente
//    y el callback no puede devolver hasta que termine.
// 2. SIN MUTEX EN EL CALLBACK. atomic::notify_all despierta a los trabajadores
//    sin que run_block tome el mutex de una condition_variable.
// 3. EL DIRECTOR TRABAJA. Toma tareas de la misma cola, así que con un solo
//    hilo el reparto no cuesta nada.
// 4. thread_count == 1 NO PASA POR AQUÍ. El llamante ejecuta su bucle tal cual;
//    ni barrera, ni atómicos, ni un camino nuevo que probar.
// 5. NADA DE ASIGNAR, BLOQUEAR NI LANZAR dentro de run_block.
//
// ── Lo que NO resuelve ────────────────────────────────────────────────────
//
// El bloque no acaba hasta que acaba la última pista: manda el rezagado. Un
// trabajador desalojado por el planificador durante 5 ms revienta el buffer
// aunque el trabajo total sobre de sobra. De ahí la prioridad de los
// trabajadores, y de ahí que en híbridos Intel un trabajador en un E-core sea
// un riesgo real (paso 09).
// ---------------------------------------------------------------------------

#include <atomic>
#include <cstdint>
#include <memory>
#include <thread>
#include <vector>

namespace lt {

// Referencia no propietaria a la tarea del bloque. Deliberadamente NO es
// std::function: esa asigna, y esto vive en el callback.
class RenderJobRef {
public:
    template <typename F>
    explicit RenderJobRef(F& fn) noexcept
        : obj_(static_cast<void*>(&fn)),
          call_([](void* o, int i) { (*static_cast<F*>(o))(i); }) {}

    void operator()(int index) const noexcept { call_(obj_, index); }

private:
    void* obj_;
    void (*call_)(void*, int);
};

struct RenderThreadPoolDiagnostics {
    int           threads = 1;
    std::uint64_t blocks_run = 0;        // bloques repartidos entre trabajadores
    std::uint64_t blocks_serial = 0;     // bloques hechos sólo por el director
    std::uint64_t barrier_entries = 0;   // veces que se armó la barrera
    std::uint64_t parked_wakeups = 0;    // despertares desde espera atomica
    std::uint64_t wait_entries = 0;      // entradas en espera atomica
    int           spinning_threads = 0;  // trabajadores en el giro corto
    int           waiting_threads = 0;   // trabajadores dormidos
};

class RenderThreadPool {
public:
    RenderThreadPool();
    ~RenderThreadPool();

    RenderThreadPool(const RenderThreadPool&) = delete;
    RenderThreadPool& operator=(const RenderThreadPool&) = delete;

    // Sólo desde la HEBRA DE CONTROL, nunca durante un bloque.
    // thread_count <= 1 deja el pool sin trabajadores: run_block ejecuta todo
    // en el llamante, por el camino serie.
    void start(int thread_count);
    void stop() noexcept;

    // Desde el HILO DE AUDIO. Ejecuta job(i) para i en [0, count) y no vuelve
    // hasta que han terminado todos. El llamante participa.
    void run_block(int count, const RenderJobRef& job,
                   bool allow_parallel = true) noexcept;

    int  thread_count() const noexcept;
    RenderThreadPoolDiagnostics diagnostics() const noexcept;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace lt
