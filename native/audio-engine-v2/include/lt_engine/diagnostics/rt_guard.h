#pragma once

#include <cstdint>
#ifdef LT_ENGINE_RT_GUARD
#include <atomic>
#endif

namespace lt::rt {

struct Violations {
    std::uint64_t allocations = 0;
    std::uint64_t deallocations = 0;
};

#ifdef LT_ENGINE_RT_GUARD

namespace detail {

inline thread_local std::uint32_t realtime_section_depth = 0;
inline thread_local Violations thread_violations{};
// Monotonic test-only totals let a mixer test include worker threads without
// resetting another thread's local guard or instrumenting the job in the test.
inline std::atomic<std::uint64_t> all_allocations{0};
inline std::atomic<std::uint64_t> all_deallocations{0};

inline void record_allocation() noexcept {
    if (realtime_section_depth != 0) {
        ++thread_violations.allocations;
        all_allocations.fetch_add(1, std::memory_order_relaxed);
    }
}

inline void record_deallocation() noexcept {
    if (realtime_section_depth != 0) {
        ++thread_violations.deallocations;
        all_deallocations.fetch_add(1, std::memory_order_relaxed);
    }
}

} // namespace detail

class ScopedRealtimeSection {
public:
    ScopedRealtimeSection() noexcept { ++detail::realtime_section_depth; }
    ~ScopedRealtimeSection() noexcept { --detail::realtime_section_depth; }

    ScopedRealtimeSection(const ScopedRealtimeSection&) = delete;
    ScopedRealtimeSection& operator=(const ScopedRealtimeSection&) = delete;
};

// True mientras el hilo actual esté dentro de una sección de tiempo real.
//
// Lo consume el contador de voces destruidas en el callback
// (`BungeePitchVoice::destroyed_on_audio_thread_count`, paso 05): saber "estoy
// en el hilo de audio" es la misma pregunta que ya responde esta marca, y
// duplicarla con un thread_local propio habría dado dos verdades que se pueden
// desincronizar.
inline bool in_realtime_section() noexcept {
    return detail::realtime_section_depth != 0;
}

inline Violations violations() noexcept { return detail::thread_violations; }
inline Violations all_threads_violations() noexcept {
    return { detail::all_allocations.load(std::memory_order_relaxed),
             detail::all_deallocations.load(std::memory_order_relaxed) };
}

inline void reset_violations() noexcept { detail::thread_violations = {}; }

#else

class ScopedRealtimeSection {
public:
    ScopedRealtimeSection() noexcept = default;
    ~ScopedRealtimeSection() noexcept = default;
};

constexpr bool in_realtime_section() noexcept { return false; }
constexpr Violations violations() noexcept { return {}; }
constexpr Violations all_threads_violations() noexcept { return {}; }
constexpr void reset_violations() noexcept {}

#endif

} // namespace lt::rt
