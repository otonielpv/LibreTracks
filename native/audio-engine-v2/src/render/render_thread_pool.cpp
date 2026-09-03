#include <lt_engine/render/render_thread_pool.h>
#include <lt_engine/core/realtime_thread.h>

#include <algorithm>

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

// Cuántos bloques seguidos sin trabajo antes de aparcar a los trabajadores.
//
// Con el transporte en marcha llega un bloque cada 2,7-10,7 ms, así que un
// trabajador nunca llega a este umbral mientras suena algo: aparcar a mitad de
// reproducción costaría el despertar del SO que toda la barrera de espera
// activa existe para evitar. Con el transporte parado se alcanza en menos de un
// segundo y el pool deja de quemar CPU.
constexpr int kIdleBlocksBeforeParking = 200;

// Giros antes de ceder el resto del quantum. Suficiente para cubrir la latencia
// de un bloque normal sin monopolizar el núcleo si el trabajo se retrasa.
constexpr int kSpinsBeforeYield = 4000;

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

    // Aparcado en reposo. Sólo se usa cuando el transporte lleva rato parado.
    std::mutex              park_mutex;
    std::condition_variable park_cv;
    std::atomic<bool>       parked{false};

    // Diagnóstico.
    std::atomic<std::uint64_t> blocks_run{0};
    std::atomic<std::uint64_t> blocks_serial{0};
    std::atomic<std::uint64_t> barrier_entries{0};
    std::atomic<std::uint64_t> parked_wakeups{0};
    std::atomic<int>           spinning{0};

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
        int idle_blocks = 0;

        for (;;) {
            spinning.fetch_add(1, std::memory_order_relaxed);
            int spins = 0;
            while (generation.load(std::memory_order_acquire) == seen) {
                if (quit.load(std::memory_order_relaxed)) {
                    spinning.fetch_sub(1, std::memory_order_relaxed);
                    return;
                }
                if (++spins < kSpinsBeforeYield) {
                    LT_CPU_RELAX();
                    continue;
                }
                // Se acabó el giro barato. Si además llevamos muchos bloques
                // sin trabajo, aparcar de verdad en vez de seguir quemando.
                if (++idle_blocks >= kIdleBlocksBeforeParking) {
                    spinning.fetch_sub(1, std::memory_order_relaxed);
                    std::unique_lock lock(park_mutex);
                    parked.store(true, std::memory_order_relaxed);
                    park_cv.wait(lock, [&] {
                        return quit.load(std::memory_order_relaxed)
                            || generation.load(std::memory_order_acquire) != seen;
                    });
                    parked.store(false, std::memory_order_relaxed);
                    lock.unlock();
                    parked_wakeups.fetch_add(1, std::memory_order_relaxed);
                    idle_blocks = 0;
                    if (quit.load(std::memory_order_relaxed)) return;
                    spinning.fetch_add(1, std::memory_order_relaxed);
                }
                spins = 0;
                std::this_thread::yield();
            }
            spinning.fetch_sub(1, std::memory_order_relaxed);

            seen = generation.load(std::memory_order_acquire);
            idle_blocks = 0;
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
    {
        std::lock_guard lock(impl_->park_mutex);
        impl_->generation.fetch_add(1, std::memory_order_release);
    }
    impl_->park_cv.notify_all();
    for (auto& w : impl_->workers) {
        if (w.joinable()) w.join();
    }
    impl_->workers.clear();
    impl_->quit.store(false, std::memory_order_relaxed);
}

void RenderThreadPool::run_block(int count, const RenderJobRef& job) noexcept {
    if (count <= 0) return;

    // Camino serie: sin trabajadores no hay barrera, ni atómicos, ni nada que
    // pueda comportarse distinto. Es literalmente el bucle de antes del paso 08.
    if (!impl_ || impl_->workers.empty()) {
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

    // Publicar la generación suelta a los trabajadores. Si alguno está aparcado
    // hay que despertarlo con el lock tomado, o se pierde el aviso.
    if (I.parked.load(std::memory_order_relaxed)) {
        {
            std::lock_guard lock(I.park_mutex);
            I.generation.fetch_add(1, std::memory_order_release);
        }
        I.park_cv.notify_all();
    } else {
        I.generation.fetch_add(1, std::memory_order_release);
    }

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
    d.spinning_threads = impl_->spinning.load(std::memory_order_relaxed);
    return d;
}

} // namespace lt
