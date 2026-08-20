#pragma once

// ---------------------------------------------------------------------------
// device_profile — one place that decides how much this machine can spend.
//
// thread_policy.h scales the worker pools by PHYSICAL RAM, which is the right
// signal on a desktop: the OS will page, but the app owns the box. On Android
// it is the wrong signal twice over:
//
//   * What the app may use is not the RAM the device has. The Oppo CPH1931 has
//     2.58 GB installed but only ~1 GB available, and ActivityManager caps the
//     process well below that (heapgrowthlimit=384m on that device).
//   * The app shares the machine with the system. Taking "half of RAM" on a
//     desktop annoys the user; on a phone it makes the low-memory killer shoot
//     everything else, which is exactly how a 2 GB .ltset import took the
//     device's system_server down with it.
//     See docs/plans/android-low-end/00-DIAGNOSTICO.md.
//
// So: classify the machine once, and derive a budget from AVAILABLE memory on
// handhelds while leaving desktop behaviour byte-for-byte identical.
//
// The policy is a pure function (lt_device_profile_for) so it can be tested
// with injected numbers instead of whatever machine the test runs on; the
// system-reading wrapper (lt_device_profile) just feeds it real values and
// caches the result.
// ---------------------------------------------------------------------------

#include <lt_engine/core/thread_policy.h>

#include <algorithm>
#include <cstdint>
#include <thread>

#if !defined(_WIN32) && !defined(__APPLE__)
#include <fstream>
#include <string>
#endif

namespace lt {

enum class DeviceClass {
    Workstation,    // > 16 GB
    Desktop,        // 8-16 GB
    ModestDesktop,  // 4-8 GB
    Handheld,       // Android/iOS
    Constrained,    // Handheld with little memory actually available
};

struct DeviceProfile {
    DeviceClass device_class = DeviceClass::Desktop;
    std::uint64_t physical_ram_bytes = 0;
    // Memory the SYSTEM reports as available right now. 0 when unknown (every
    // desktop platform here: we never needed it, and MemAvailable has no
    // portable equivalent).
    std::uint64_t available_ram_bytes = 0;
    // What the engine allows itself to spend. Only meaningful on handhelds;
    // 0 on desktop, where the existing per-consumer policies still rule.
    std::uint64_t usable_budget_bytes = 0;
    int cores = 0;
    int decode_threads = 0;
    int fill_threads = 0;
    std::size_t source_cache_mb = 0;
    // Blocks per source that eviction must never take: the read-ahead window
    // that keeps the audio thread from waiting on the disk. This is what a
    // streaming engine actually spends RAM on, and it is per PLAYING track, so
    // it decides how many tracks a device can carry at once.
    std::size_t protected_blocks_per_source = 0;
};

// Inputs the policy needs, so tests can supply them instead of the real machine.
struct DeviceProbe {
    std::uint64_t physical_ram_bytes = 0;
    std::uint64_t available_ram_bytes = 0;  // 0 = unknown
    int cores = 0;
    bool is_handheld = false;
};

// Below this much AVAILABLE memory a handheld is treated as Constrained. The
// CPH1931 sat at ~1.0 GB available while idle and dropped to 188 MB during the
// import that triggered this work, so 1.5 GB is the line between "a phone" and
// "a phone that cannot afford us".
inline constexpr std::uint64_t kConstrainedAvailableBytes = 1536ull * 1024 * 1024;

// The whole policy, as a pure function of the probe. Desktop paths delegate to
// the existing thread_policy/source_manager rules so this cannot drift from
// them; only the handheld branches are new.
inline DeviceProfile lt_device_profile_for(const DeviceProbe& probe) {
    DeviceProfile profile;
    profile.physical_ram_bytes = probe.physical_ram_bytes;
    profile.available_ram_bytes = probe.available_ram_bytes;
    profile.cores = probe.cores > 0 ? probe.cores : 4;

    const double ram_gb = probe.physical_ram_bytes > 0
                              ? static_cast<double>(probe.physical_ram_bytes) / (1024.0 * 1024.0 * 1024.0)
                              : 8.0;  // same "assume a middling 8GB" as thread_policy

    if (probe.is_handheld) {
        // Trust available memory when we have it; fall back to a quarter of
        // physical when we don't (better than assuming a desktop's headroom).
        const std::uint64_t available =
            probe.available_ram_bytes > 0 ? probe.available_ram_bytes : probe.physical_ram_bytes / 4;

        profile.device_class = available < kConstrainedAvailableBytes ? DeviceClass::Constrained
                                                                     : DeviceClass::Handheld;

        // A quarter of what's free, capped. The cap matters more than the
        // fraction: the app also pays for a separate WebView process, and the
        // system starts killing long before "free" reaches zero.
        const std::uint64_t quarter = available / 4;
        const std::uint64_t cap = profile.device_class == DeviceClass::Constrained
                                      ? 128ull * 1024 * 1024
                                      : 256ull * 1024 * 1024;
        profile.usable_budget_bytes = std::min(quarter, cap);

        // One decoder. On the CPH1931 (8 cores, but 4 slow A73 + 4 A53) the
        // bottleneck is the eMMC, not the CPU: a second decoder doubles peak
        // RSS without finishing sooner, and peak RSS is what summons the
        // low-memory killer.
        //
        // Playback streams from disk, so the cache is not "the song in RAM":
        // it is the read-ahead window that keeps the audio thread from waiting
        // on a seek. What costs memory is that window x the number of PLAYING
        // tracks, and BlockCache's desktop default reserves 48 blocks per
        // source — 4.5 s, 1.5 MB each. Thirty-six stems therefore pin 54 MB
        // before a single byte of slack, which is what a 48 MB budget could
        // not hold: it thrashed, and the audio thread was served 43.5 MILLION
        // silenced frames (~15 min) across 98 [LT_STARVATION] events on the
        // CPH1931.
        //
        // The fix is to shorten the window rather than to buy it more room. A
        // phone reads from flash, not a spinning disk, so 1.5 s of lead is
        // ample; that alone cuts the per-track cost from 1.5 MB to 0.5 MB and
        // triples how many tracks fit in the same memory. The budget below is
        // then sized to hold several sessions' worth of those windows.
        if (profile.device_class == DeviceClass::Constrained) {
            profile.decode_threads = 1;
            profile.fill_threads = 1;
            profile.source_cache_mb = 128;
            profile.protected_blocks_per_source = 16;  // ~1.5 s
        } else {
            profile.decode_threads = 2;
            profile.fill_threads = 2;
            profile.source_cache_mb = 192;
            profile.protected_blocks_per_source = 24;  // ~2.2 s
        }
        return profile;
    }

    if (ram_gb > 16.5)      profile.device_class = DeviceClass::Workstation;
    else if (ram_gb > 8.5)  profile.device_class = DeviceClass::Desktop;
    else if (ram_gb > 4.5)  profile.device_class = DeviceClass::ModestDesktop;
    else                    profile.device_class = DeviceClass::ModestDesktop;

    // Desktop keeps the existing behaviour, computed by the existing code.
    // usable_budget_bytes stays 0: nothing on desktop consults it.
    profile.decode_threads = lt_recommend_worker_threads_for(WorkerRole::Decode, probe.cores,
                                                            probe.physical_ram_bytes);
    profile.fill_threads = lt_recommend_worker_threads_for(WorkerRole::Fill, probe.cores,
                                                           probe.physical_ram_bytes);
    if (ram_gb <= 8.5)       profile.source_cache_mb = 512;
    else if (ram_gb <= 16.5) profile.source_cache_mb = 1024;
    else if (ram_gb <= 32.5) profile.source_cache_mb = 2048;
    else                     profile.source_cache_mb = 3072;
    // Unchanged on desktop: BlockCache's own default, kept explicit so the
    // handheld value below reads as a deviation from it rather than a mystery.
    profile.protected_blocks_per_source = 48;  // ~4.5 s
    return profile;
}

// PCM disk-cache budget, in bytes, from the free space on the cache volume.
//
// Desktop policy (unchanged): 10% of free space, but never below 4 GiB, so a
// nearly-full drive still has a usable working set.
//
// That minimum is actively harmful on a phone. The import that prompted this
// work consumed 4.91 GB of a 10 GB free partition — and a 4 GiB cache floor
// says that is fine. Handhelds get 10% capped at 512 MB, and nothing at all
// once free space drops below 1 GB: a device that is nearly full must not be
// pushed over by our cache. Serving from the original file is slower than
// serving from cache, but it is not "your phone is out of space".
//
// Pure function of its inputs so the policy can be tested without a filesystem.
inline std::size_t lt_disk_cache_limit_for(std::uint64_t free_bytes, DeviceClass device_class) {
    const bool handheld =
        device_class == DeviceClass::Handheld || device_class == DeviceClass::Constrained;

    const std::uint64_t ten_percent = free_bytes / 10ull;

    if (handheld) {
        constexpr std::uint64_t kFloorFreeBytes = 1024ull * 1024 * 1024;  // 1 GB
        constexpr std::uint64_t kMaxBytes = 512ull * 1024 * 1024;
        // free_bytes == 0 means the stat failed; on a phone assume the worst.
        if (free_bytes < kFloorFreeBytes) return 0;
        return static_cast<std::size_t>(std::min(ten_percent, kMaxBytes));
    }

    // Desktop: 10% of free disk, floored at 4 GiB. A failed stat (0) lands on
    // the minimum, which keeps the policy safe on weird filesystems.
    constexpr std::uint64_t kMinBytes = 4ull * 1024 * 1024 * 1024;
    return static_cast<std::size_t>(ten_percent > kMinBytes ? ten_percent : kMinBytes);
}

// Memory the system reports as available, in bytes. 0 when we can't tell.
// Only Linux/Android answers: it's the only platform where we need it, and
// MemAvailable is the number Android's own low-memory killer watches.
inline std::uint64_t lt_available_ram_bytes() {
#if defined(_WIN32) || defined(__APPLE__)
    return 0;
#else
    std::ifstream meminfo("/proc/meminfo");
    if (!meminfo) return 0;

    std::string label;
    std::uint64_t value = 0;
    std::string unit;
    std::uint64_t fallback = 0;  // MemFree + Buffers + Cached, for old kernels
    bool have_available = false;

    while (meminfo >> label >> value >> unit) {
        if (label == "MemAvailable:") {
            return value * 1024ull;  // /proc/meminfo reports kB
        }
        if (label == "MemFree:" || label == "Buffers:" || label == "Cached:") {
            fallback += value * 1024ull;
            have_available = true;
        }
    }
    return have_available ? fallback : 0;
#endif
}

// This machine's profile. Resolved once (reading /proc/meminfo per query would
// be wasteful and, worse, would make the budget wobble as other apps come and
// go). Thread-safe: C++11 guarantees the static is initialised exactly once.
inline const DeviceProfile& lt_device_profile() {
    static const DeviceProfile profile = [] {
        DeviceProbe probe;
        probe.physical_ram_bytes = lt_physical_ram_bytes();
        probe.available_ram_bytes = lt_available_ram_bytes();
        const unsigned hw = std::thread::hardware_concurrency();
        probe.cores = hw > 0 ? static_cast<int>(hw) : 4;
#if defined(__ANDROID__)
        probe.is_handheld = true;
#else
        probe.is_handheld = false;
#endif
        return lt_device_profile_for(probe);
    }();
    return profile;
}

inline const char* lt_device_class_name(DeviceClass device_class) {
    switch (device_class) {
        case DeviceClass::Workstation:   return "Workstation";
        case DeviceClass::Desktop:       return "Desktop";
        case DeviceClass::ModestDesktop: return "ModestDesktop";
        case DeviceClass::Handheld:      return "Handheld";
        case DeviceClass::Constrained:   return "Constrained";
    }
    return "Unknown";
}

}  // namespace lt
