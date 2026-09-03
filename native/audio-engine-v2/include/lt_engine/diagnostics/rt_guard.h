#pragma once

#include <cstdint>

namespace lt::rt {

struct Violations {
    std::uint64_t allocations = 0;
    std::uint64_t deallocations = 0;
};

#ifdef LT_ENGINE_RT_GUARD

namespace detail {

inline thread_local std::uint32_t realtime_section_depth = 0;
inline thread_local Violations thread_violations{};

inline void record_allocation() noexcept {
    if (realtime_section_depth != 0)
        ++thread_violations.allocations;
}

inline void record_deallocation() noexcept {
    if (realtime_section_depth != 0)
        ++thread_violations.deallocations;
}

} // namespace detail

class ScopedRealtimeSection {
public:
    ScopedRealtimeSection() noexcept { ++detail::realtime_section_depth; }
    ~ScopedRealtimeSection() noexcept { --detail::realtime_section_depth; }

    ScopedRealtimeSection(const ScopedRealtimeSection&) = delete;
    ScopedRealtimeSection& operator=(const ScopedRealtimeSection&) = delete;
};

inline Violations violations() noexcept { return detail::thread_violations; }

inline void reset_violations() noexcept { detail::thread_violations = {}; }

#else

class ScopedRealtimeSection {
public:
    ScopedRealtimeSection() noexcept = default;
    ~ScopedRealtimeSection() noexcept = default;
};

constexpr Violations violations() noexcept { return {}; }
constexpr void reset_violations() noexcept {}

#endif

} // namespace lt::rt
