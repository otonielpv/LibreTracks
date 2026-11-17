#pragma once

// Publicación de datos inmutables al hilo de audio sin bloquear ni liberar
// memoria en él (mismo protocolo que el SampleBank del paso 02):
//   - el hilo de comandos publica una versión completa con `publish`;
//   - el hilo de audio la lee con `acquire()` al empezar el bloque y suelta el
//     puntero de peligro con `end_block()`;
//   - lo retirado se libera en `collect_retired()`, siempre en el hilo de
//     comandos, cuando ya ni es la actual ni la señala el puntero de peligro.
// Un único lector (el hilo de audio).

#include <atomic>
#include <memory>
#include <mutex>
#include <vector>

namespace lt {

template <typename T>
class RtPublisher {
public:
    RtPublisher() = default;
    RtPublisher(const RtPublisher&) = delete;
    RtPublisher& operator=(const RtPublisher&) = delete;
    ~RtPublisher() { delete current_.exchange(nullptr, std::memory_order_acq_rel); }

    // ── Hilo de comandos ────────────────────────────────────────────────
    void publish(std::unique_ptr<T> next) {
        std::lock_guard<std::mutex> lock(mutex_);
        T* old = current_.exchange(next.release(), std::memory_order_seq_cst);
        if (old) retired_.emplace_back(old);
        collect_locked();
    }

    void collect_retired() {
        std::unique_lock<std::mutex> lock(mutex_, std::try_to_lock);
        if (lock.owns_lock()) collect_locked();
    }

    std::size_t retired_count() const {
        std::lock_guard<std::mutex> lock(mutex_);
        return retired_.size();
    }

    /// Versión actual para leerla desde el hilo de comandos (quien publica).
    const T* current_for_writer() const noexcept { return current_.load(std::memory_order_acquire); }

    // ── Hilo de audio ───────────────────────────────────────────────────
    const T* acquire() noexcept {
        T* p = current_.load(std::memory_order_seq_cst);
        for (;;) {
            hazard_.store(p, std::memory_order_seq_cst);
            T* q = current_.load(std::memory_order_seq_cst);
            if (q == p) return p;
            p = q;
        }
    }

    void end_block() noexcept { hazard_.store(nullptr, std::memory_order_seq_cst); }

private:
    void collect_locked() {
        T* hazard = hazard_.load(std::memory_order_seq_cst);
        std::vector<std::unique_ptr<T>> keep;
        for (auto& item : retired_) {
            if (item.get() == hazard) keep.push_back(std::move(item));
        }
        retired_.swap(keep);  // lo demás se destruye aquí, en este hilo
    }

    std::atomic<T*> current_{nullptr};
    std::atomic<T*> hazard_{nullptr};
    mutable std::mutex mutex_;
    std::vector<std::unique_ptr<T>> retired_;
};

} // namespace lt
