#pragma once

// Cola de un productor y un consumidor, sin bloqueo y sin reservas tras
// construirse. La usan los controles en directo de los loops (hilo de comandos
// → hilo de audio) y el disparo rápido (paso 04). `T` debe ser trivialmente
// copiable. Si se llena, `push` devuelve false y el evento se pierde (el
// productor decide qué hacer).

#include <array>
#include <atomic>
#include <cstddef>
#include <type_traits>

namespace lt {

template <typename T, std::size_t Capacity>
class SpscRing {
    static_assert(std::is_trivially_copyable_v<T>, "SpscRing needs trivially copyable items");
    static_assert(Capacity >= 2 && (Capacity & (Capacity - 1)) == 0, "Capacity must be a power of two");

public:
    bool push(const T& item) noexcept {
        const std::size_t head = head_.load(std::memory_order_relaxed);
        const std::size_t tail = tail_.load(std::memory_order_acquire);
        if (head - tail >= Capacity) return false;
        items_[head & (Capacity - 1)] = item;
        head_.store(head + 1, std::memory_order_release);
        return true;
    }

    bool pop(T& out) noexcept {
        const std::size_t tail = tail_.load(std::memory_order_relaxed);
        const std::size_t head = head_.load(std::memory_order_acquire);
        if (tail == head) return false;
        out = items_[tail & (Capacity - 1)];
        tail_.store(tail + 1, std::memory_order_release);
        return true;
    }

    bool empty() const noexcept {
        return head_.load(std::memory_order_acquire) == tail_.load(std::memory_order_acquire);
    }

private:
    std::array<T, Capacity> items_{};
    alignas(64) std::atomic<std::size_t> head_{0};
    alignas(64) std::atomic<std::size_t> tail_{0};
};

} // namespace lt
