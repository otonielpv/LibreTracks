#pragma once

#include <atomic>
#include <cstdint>

namespace lt {

// A worker must join this generation before reading its non-owning job data.
// Closing rejects late workers; the director then waits only for workers that
// actually joined, not every sleeping thread in the pool. The generation tag
// prevents a delayed wakeup from entering a subsequent block with stale data.
class RenderBlockAdmission {
public:
    void open(std::uint64_t generation) noexcept {
        state_.store(generation << 16, std::memory_order_release);
    }

    bool try_enter(std::uint64_t generation) noexcept {
        const auto tag = generation << 16;
        auto state = state_.load(std::memory_order_acquire);
        for (;;) {
            if ((state & ~kReaders) != tag || (state & kReaders) == kReaders)
                return false;
            if (state_.compare_exchange_weak(state, state + 1,
                    std::memory_order_acquire, std::memory_order_relaxed)) return true;
        }
    }

    void leave() noexcept { state_.fetch_sub(1, std::memory_order_release); }
    void close() noexcept { state_.fetch_or(kClosed, std::memory_order_acq_rel); }
    bool quiescent() const noexcept {
        return (state_.load(std::memory_order_acquire) & kReaders) == 0;
    }

private:
    static constexpr std::uint64_t kClosed = 1ULL << 15;
    static constexpr std::uint64_t kReaders = kClosed - 1;
    std::atomic<std::uint64_t> state_{kClosed};
};

} // namespace lt
