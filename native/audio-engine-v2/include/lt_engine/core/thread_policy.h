#pragma once

// ---------------------------------------------------------------------------
// thread_policy — one place that decides how many background worker threads to
// spin up, scaled to the actual machine (logical cores AND installed RAM).
//
// Two background pools size themselves through here:
//   * Decode (MP3/etc → WAV cache): CPU + I/O bound, and each concurrent job
//     holds a decode buffer (+ a resample copy), so it's also RAM-bound. On a
//     low-RAM PC too many decoders thrash the working set (the very paging the
//     [LT_STARVATION] logs showed), so we cap harder when RAM is small.
//   * Fill (repopulate evicted WAV-cache blocks for the PLAYING tracks): pure
//     disk I/O, tiny per-thread memory. It scales with cores but a few threads
//     already saturate a single disk, so it's capped lower than decode.
//
// We deliberately only use signals we can read portably and trust: logical core
// count and physical RAM. CPU frequency / P-vs-E core type / IPC are not
// portably or reliably queryable, so we don't pretend to.
//
// Every caller keeps its own env override (checked before calling here), so a
// user can still pin an exact count for A/B testing.
// ---------------------------------------------------------------------------

#include <algorithm>
#include <cstdint>
#include <thread>

#if defined(_WIN32)
// Forward-declare instead of pulling in <windows.h> (which leaks min/max macros
// into every TU that includes this header). Matches the Win32 SDK signature.
struct _MEMORYSTATUSEX;
extern "C" __declspec(dllimport) int __stdcall GlobalMemoryStatusEx(_MEMORYSTATUSEX* lpBuffer);
#elif defined(__APPLE__)
#include <sys/sysctl.h>
#include <sys/types.h>
#else
#include <unistd.h>
#endif

namespace lt {

enum class WorkerRole {
    Decode,  // MP3/etc → WAV cache: CPU + I/O + RAM bound.
    Fill,    // repopulate evicted WAV blocks for playing tracks: disk I/O bound.
};

// Total physical RAM in bytes, 0 if it can't be determined.
inline std::uint64_t lt_physical_ram_bytes() {
#if defined(_WIN32)
    // Lay out MEMORYSTATUSEX by hand to avoid <windows.h>. Field order/types are
    // ABI-stable: DWORD length, DWORD memoryLoad, then 7 DWORDLONG counters; the
    // 3rd member (index 2) is ullTotalPhys.
    struct MemStatus {
        unsigned long dwLength;
        unsigned long dwMemoryLoad;
        unsigned long long ullTotalPhys;
        unsigned long long ullAvailPhys;
        unsigned long long ullTotalPageFile;
        unsigned long long ullAvailPageFile;
        unsigned long long ullTotalVirtual;
        unsigned long long ullAvailVirtual;
        unsigned long long ullAvailExtendedVirtual;
    } status{};
    status.dwLength = sizeof(status);
    if (GlobalMemoryStatusEx(reinterpret_cast<_MEMORYSTATUSEX*>(&status)))
        return status.ullTotalPhys;
    return 0;
#elif defined(__APPLE__)
    int mib[2] = {CTL_HW, HW_MEMSIZE};
    std::uint64_t value = 0;
    size_t len = sizeof(value);
    if (sysctl(mib, 2, &value, &len, nullptr, 0) == 0)
        return value;
    return 0;
#else
    const long pages = sysconf(_SC_PHYS_PAGES);
    const long page_size = sysconf(_SC_PAGE_SIZE);
    if (pages > 0 && page_size > 0)
        return static_cast<std::uint64_t>(pages) * static_cast<std::uint64_t>(page_size);
    return 0;
#endif
}

// Recommend a background worker count for `role`, scaled to this machine.
inline int lt_recommend_worker_threads(WorkerRole role) {
    const unsigned hw = std::thread::hardware_concurrency();
    const int cores = hw > 0 ? static_cast<int>(hw) : 4;

    // Leave one core for the audio callback + UI; never go below 1.
    const int spare = std::max(1, cores - 1);

    const std::uint64_t ram = lt_physical_ram_bytes();
    const double ram_gb = ram > 0 ? static_cast<double>(ram) / (1024.0 * 1024.0 * 1024.0)
                                  : 8.0;  // assume a middling 8GB when unknown

    // Modest machines first: on a dual-core (or unknown low core count) keep the
    // background pools tiny so the audio callback + UI never get starved of a
    // core. `spare` is already cores-1, so a 2-core box yields spare=1.
    const bool low_core = cores <= 2;

    if (role == WorkerRole::Decode) {
        // Decode is the RAM-heavy one (decode buffer + resample copy per job).
        // Bound the count by RAM so a low-RAM PC doesn't page itself to death
        // (the working-set pressure the [LT_STARVATION] logs showed):
        //   <=4GB → 2, <=8GB → 3, <=16GB → 4, else 6.
        int ram_cap;
        if (ram_gb <= 4.5)       ram_cap = 2;
        else if (ram_gb <= 8.5)  ram_cap = 3;
        else if (ram_gb <= 16.5) ram_cap = 4;
        else                     ram_cap = 6;
        int n = std::min(spare, ram_cap);
        // Only push the "decode several at once" floor of 2 on machines that can
        // actually spare a core for it (>=3 cores). A dual-core gets 1 so the
        // audio thread keeps a core to itself.
        const int floor = low_core ? 1 : 2;
        return std::clamp(n, floor, 6);
    }

    // Fill: disk-I/O bound, ~no per-thread RAM. Scale with cores; a few threads
    // already saturate a single disk. Trim hard on low core/RAM so it doesn't
    // compete with decode (or the audio thread) during an import on a modest PC.
    int cap = 4;
    if (low_core || ram_gb <= 4.5) cap = 2;
    return std::clamp(std::min(spare, cap), 1, 4);
}

} // namespace lt
