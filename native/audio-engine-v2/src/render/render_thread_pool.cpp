#include <lt_engine/render/render_thread_pool.h>
#include <lt_engine/core/realtime_thread.h>

#if defined(_WIN32)
#  ifndef NOMINMAX
#    define NOMINMAX
#  endif
#  ifndef WIN32_LEAN_AND_MEAN
#    define WIN32_LEAN_AND_MEAN
#  endif
#  include <windows.h>
#  define LT_CPU_RELAX() YieldProcessor()
#elif defined(__x86_64__) || defined(__i386__)
#  include <immintrin.h>
#  define LT_CPU_RELAX() _mm_pause()
#elif defined(__aarch64__) || defined(__arm__)
#  define LT_CPU_RELAX() __asm__ __volatile__("yield")
#else
#  define LT_CPU_RELAX() ((void)0)
#endif

namespace lt {

namespace {

// Ventana corta antes de dormir. Cubre publicaciones contiguas en bancos y
// callbacks encadenados sin mantener N-1 nucleos ocupados durante los 2,7-10,7
// ms que normalmente separan dos buffers de audio.
constexpr int kSpinsBeforeWait = 256;

} // namespace

struct RenderThreadPool::Impl {
    // ── Estado de la barrera ────────────────────────────────────────────────
    //
    // Una generación por bloque. Los trabajadores giran hasta ver una
    // generación nueva, toman índices de la cola compartida con fetch_add, y el
    // director espera a que `done` alcance el total.
    std::atomic<std::uint64_t> generation{0};
    std::atomic<int>           next_index{0};
    std::atomic<int>           done{0};
    std::atomic<int>           total{0};
    const RenderJobRef*        job = nullptr;

    std::atomic<bool> quit{false};
    std::vector<std::thread> workers;

    // Diagnóstico.
    std::atomic<std::uint64_t> blocks_run{0};
    std::atomic<std::uint64_t> blocks_serial{0};
    std::atomic<std::uint64_t> barrier_entries{0};
    std::atomic<std::uint64_t> parked_wakeups{0};
    std::atomic<std::uint64_t> wait_entries{0};
    std::atomic<int>           spinning{0};
    std::atomic<int>           waiting{0};

    // Toma tareas hasta agotar la cola. Lo ejecutan por igual el director y los
    // trabajadores: es lo que hace que con un hilo no haya reparto que pagar.
    void drain() noexcept {
        const int n = total.load(std::memory_order_acquire);
        const RenderJobRef* j = job;
        if (!j) return;
        for (;;) {
            const int i = next_index.fetch_add(1, std::memory_order_relaxed);
            if (i >= n) break;
            (*j)(i);
            done.fetch_add(1, std::memory_order_release);
        }
    }

    void worker_loop() noexcept {
        promote_render_worker_thread();

        std::uint64_t seen = generation.load(std::memory_order_acquire);

        for (;;) {
            spinning.fetch_add(1, std::memory_order_relaxed);
            int spins = 0;
            while (generation.load(std::memory_order_acquire) == seen
                   && spins++ < kSpinsBeforeWait) {
                if (quit.load(std::memory_order_relaxed)) {
                    spinning.fetch_sub(1, std::memory_order_relaxed);
                    return;
                }
                LT_CPU_RELAX();
            }
            spinning.fetch_sub(1, std::memory_order_relaxed);

            if (quit.load(std::memory_order_relaxed)) return;

            if (generation.load(std::memory_order_acquire) == seen) {
                wait_entries.fetch_add(1, std::memory_order_relaxed);
                waiting.fetch_add(1, std::memory_order_relaxed);
                generation.wait(seen, std::memory_order_acquire);
                waiting.fetch_sub(1, std::memory_order_relaxed);
                parked_wakeups.fetch_add(1, std::memory_order_relaxed);
                if (quit.load(std::memory_order_relaxed)) return;
            }

            const std::uint64_t published =
                generation.load(std::memory_order_acquire);
            if (published == seen) continue;
            seen = published;
            drain();
        }
    }
};

RenderThreadPool::RenderThreadPool() : impl_(std::make_unique<Impl>()) {}

RenderThreadPool::~RenderThreadPool() { stop(); }

void RenderThreadPool::start(int thread_count) {
    stop();
    if (thread_count <= 1) return;   // sin trabajadores: camino serie puro

    impl_->quit.store(false, std::memory_order_relaxed);
    impl_->workers.reserve(static_cast<std::size_t>(thread_count - 1));
    try {
        for (int i = 1; i < thread_count; ++i)
            impl_->workers.emplace_back([impl = impl_.get()] { impl->worker_loop(); });
    } catch (...) {
        // No se pudieron crear los hilos: se para lo que haya y se sigue en
        // serie. El motor tiene que sonar igual, sólo que más apretado.
        stop();
    }
}

void RenderThreadPool::stop() noexcept {
    if (!impl_ || impl_->workers.empty()) {
        if (impl_) impl_->quit.store(true, std::memory_order_relaxed);
        return;
    }
    impl_->quit.store(true, std::memory_order_relaxed);
    impl_->generation.fetch_add(1, std::memory_order_release);
    impl_->generation.notify_all();
    for (auto& w : impl_->workers) {
        if (w.joinable()) w.join();
    }
    impl_->workers.clear();
    impl_->quit.store(false, std::memory_order_relaxed);
}

void RenderThreadPool::run_block(int count, const RenderJobRef& job,
                                 bool allow_parallel) noexcept {
    if (count <= 0) return;

    // Camino serie: sin trabajadores no hay barrera, ni atómicos, ni nada que
    // pueda comportarse distinto. Una sola tarea tambien se queda aqui: avisar
    // a N-1 trabajadores para que compitan por un unico indice solo añade CPU.
    if (!impl_ || impl_->workers.empty() || count == 1 || !allow_parallel) {
        for (int i = 0; i < count; ++i) job(i);
        impl_ ? (void)impl_->blocks_serial.fetch_add(1, std::memory_order_relaxed)
              : (void)0;
        return;
    }

    Impl& I = *impl_;
    I.job = &job;
    I.total.store(count, std::memory_order_relaxed);
    I.next_index.store(0, std::memory_order_relaxed);
    I.done.store(0, std::memory_order_relaxed);
    I.barrier_entries.fetch_add(1, std::memory_order_relaxed);

    // Publicar y despertar. atomic::wait comprueba el valor antes de dormir,
    // así que una notificación que coincida con esa transición no se pierde.
    I.generation.fetch_add(1, std::memory_order_release);
    I.generation.notify_all();

    // El director también trabaja.
    I.drain();

    // Junta. No hay salida por tiempo a propósito: abandonar dejaría el bloque a
    // medias, que suena peor que llegar tarde.
    while (I.done.load(std::memory_order_acquire) < count)
        LT_CPU_RELAX();

    I.job = nullptr;
    I.blocks_run.fetch_add(1, std::memory_order_relaxed);
}

int RenderThreadPool::thread_count() const noexcept {
    if (!impl_) return 1;
    return static_cast<int>(impl_->workers.size()) + 1;
}

RenderThreadPoolDiagnostics RenderThreadPool::diagnostics() const noexcept {
    RenderThreadPoolDiagnostics d;
    if (!impl_) return d;
    d.threads          = thread_count();
    d.blocks_run       = impl_->blocks_run.load(std::memory_order_relaxed);
    d.blocks_serial    = impl_->blocks_serial.load(std::memory_order_relaxed);
    d.barrier_entries  = impl_->barrier_entries.load(std::memory_order_relaxed);
    d.parked_wakeups   = impl_->parked_wakeups.load(std::memory_order_relaxed);
    d.wait_entries     = impl_->wait_entries.load(std::memory_order_relaxed);
    d.spinning_threads = impl_->spinning.load(std::memory_order_relaxed);
    d.waiting_threads  = impl_->waiting.load(std::memory_order_relaxed);
    return d;
}

} // namespace lt
