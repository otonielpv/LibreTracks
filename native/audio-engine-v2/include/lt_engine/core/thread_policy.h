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
    Decode,    // MP3/etc → WAV cache: CPU + I/O + RAM bound.
    Fill,      // repopulate evicted WAV blocks for playing tracks: disk I/O bound.
    Waveform,  // peak analysis for the UI: disk I/O bound, negligible RAM.
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

// Same policy, but over explicitly supplied machine facts instead of querying
// the host. Exists so the rules can be tested at every RAM/core tier without
// the test being at the mercy of the machine it runs on (and so device_profile.h
// can reuse them rather than restating them, which would let the two drift).
// `cores` <= 0 and `ram_bytes` == 0 mean "unknown" and take the same fallbacks
// the querying version has always taken.
inline int lt_recommend_worker_threads_for(WorkerRole role, int cores_in, std::uint64_t ram) {
    const int cores = cores_in > 0 ? cores_in : 4;

    // Leave one core for the audio callback + UI; never go below 1.
    const int spare = std::max(1, cores - 1);

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

    if (role == WorkerRole::Waveform) {
        // Waveform analysis is COSMETIC: it reads a file end to end and keeps
        // only a min/max per bucket. Cheap per thread, but it runs at exactly
        // the moment Decode and Fill are busiest — an import — and a late
        // waveform costs the user nothing while a late audio block is a
        // dropout. So this pool scales with the machine but stays deliberately
        // smaller than the other two.
        //
        // One worker was the old behaviour and it showed: 25 stems at ~260 ms
        // of analysis each are ~7 s of strictly sequential work, with the last
        // clip only starting once the 24 before it finished.
        //
        // Scales with the machine, but stays deliberately below Fill's cap:
        // during an import the Decode and Fill pools are already running, and
        // this must not be the pool that tips the box over.
        int cap;
        if (cores <= 3)       cap = 1;
        else if (cores <= 7)  cap = 2;
        else if (cores <= 15) cap = 3;
        else                  cap = 4;
        if (ram_gb <= 4.5) cap = 1;
        return std::clamp(std::min(spare, cap), 1, 4);
    }

    // Fill: disk-I/O bound, ~no per-thread RAM. The useful parallelism is set by
    // how many requests the storage will service at once, not by core count, so
    // this scales past the "one thread per core" intuition — but only where
    // there are cores to spare.
    //
    // Measured against a real 39-track session (SSD), refilling every track's
    // window after a jump:
    //     4 threads  21.4 ms      12 threads  13.8 ms      24 threads  14.2 ms
    // A third faster, and flat beyond ~12. Worth taking on a big machine.
    //
    // Modest PCs keep exactly what they had: `spare` is already cores-1, so a
    // 4-core box lands on 3 either way, and the low-core/low-RAM trim to 2 is
    // untouched. Raising the cap only ever changes machines that were being held
    // back by the constant.
    //
    // Note this is now the SECOND-order fix. Serving the starving block before
    // any read-ahead (SourceManager::request_block) is worth ~16x on its own;
    // extra threads only refill the lookahead sooner.
    // Never take more than half the cores: these run at ABOVE_NORMAL and must
    // not crowd the audio callback or the decode pool. Half of 8 is 4, so an
    // 8-core desktop lands exactly where it always did; only machines with real
    // headroom (16+ cores) see more.
    int cap = std::clamp(cores / 2, 4, 8);
    if (low_core || ram_gb <= 4.5) cap = 2;
    return std::clamp(std::min(spare, cap), 1, 8);
}

// Recommend a background worker count for `role`, scaled to this machine.
inline int lt_recommend_worker_threads(WorkerRole role) {
    const unsigned hw = std::thread::hardware_concurrency();
    return lt_recommend_worker_threads_for(role, hw > 0 ? static_cast<int>(hw) : 0,
                                           lt_physical_ram_bytes());
}

} // namespace lt
