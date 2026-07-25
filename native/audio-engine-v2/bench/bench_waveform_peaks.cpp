// ---------------------------------------------------------------------------
// bench_waveform_peaks — cost of computing waveform overviews for a multitrack.
//
// Field report: adding a 25-stem multitrack freezes the UI for 6-7 seconds on a
// FAST machine, with no "preparing audio" feedback shown at all. That last part
// matters: preparation publishes progress as it runs, so a freeze with NO
// progress UI means the main thread is blocked BEFORE (or beside) preparation.
//
// bench_multitrack_load already showed preparation itself is not the culprit:
// the first stem is playable in 3 ms and a UI probe thread never missed a
// 16 ms deadline during it.
//
// analyze_file_peaks() is the other full pass over every file: it decodes each
// source end to end to build the waveform overview. That is a second traversal
// of the same ~5 GB, and it is what this bench measures — per file and total,
// with a UI-responsiveness probe running alongside.
//
// Usage:
//   LT_BENCH_DIR=<folder with stems>   (required)
//   LT_BENCH_RES=<resolution frames>   (default 512, as the UI requests)
//   LT_BENCH_MAX_FILES=N               (default: all)
// ---------------------------------------------------------------------------

#include <lt_engine/sources/source_manager.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <string>
#include <thread>
#include <vector>

using namespace lt;
using Clock = std::chrono::steady_clock;
namespace fs = std::filesystem;

namespace {

int env_int(const char* name, int fallback) {
    if (const char* v = std::getenv(name)) {
        const int n = std::atoi(v);
        if (n > 0) return n;
    }
    return fallback;
}

std::string env_str(const char* name, const std::string& fallback) {
    if (const char* v = std::getenv(name)) {
        if (*v) return std::string(v);
    }
    return fallback;
}

std::string to_utf8(const fs::path& p) {
    const auto u8 = p.u8string();
    return std::string(reinterpret_cast<const char*>(u8.data()), u8.size());
}

} // namespace

int main() {
    const std::string dir = env_str("LT_BENCH_DIR", "");
    if (dir.empty()) {
        std::fprintf(stderr, "LT_BENCH_DIR is required\n");
        return 2;
    }
    const int resolution = env_int("LT_BENCH_RES", 512);
    const int max_files = env_int("LT_BENCH_MAX_FILES", 0);

    std::error_code ec;
    std::vector<fs::path> files;
    for (const auto& entry : fs::directory_iterator(dir, ec)) {
        if (!entry.is_regular_file()) continue;
        auto ext = entry.path().extension().string();
        std::transform(ext.begin(), ext.end(), ext.begin(),
                       [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
        if (ext == ".wav" || ext == ".mp3" || ext == ".flac" || ext == ".aiff" || ext == ".aif")
            files.push_back(entry.path());
    }
    std::sort(files.begin(), files.end());
    if (files.empty()) {
        std::fprintf(stderr, "no audio files in %s\n", dir.c_str());
        return 2;
    }
    if (max_files > 0 && static_cast<int>(files.size()) > max_files)
        files.resize(static_cast<std::size_t>(max_files));

    unsigned long long input_bytes = 0;
    for (const auto& f : files) input_bytes += fs::file_size(f, ec);

    std::printf("=== waveform peaks bench ===\n");
    std::printf("files      : %zu (%.1f MB)\n", files.size(),
                input_bytes / (1024.0 * 1024.0));
    std::printf("resolution : %d frames per bucket\n\n", resolution);

    // Same UI-responsiveness probe as bench_multitrack_load: a thread that wants
    // to wake every 16 ms, like a 60 fps repaint.
    std::atomic<bool> done{false};
    std::atomic<long long> ui_worst_late_ms{0};
    std::atomic<long long> ui_late_over_100ms{0};
    std::thread ui_probe([&] {
        constexpr auto kPeriod = std::chrono::milliseconds(16);
        auto next = Clock::now() + kPeriod;
        while (!done.load(std::memory_order_relaxed)) {
            std::this_thread::sleep_until(next);
            const auto now = Clock::now();
            const auto late = std::chrono::duration_cast<std::chrono::milliseconds>(
                now - next).count();
            if (late > 100) ui_late_over_100ms.fetch_add(1, std::memory_order_relaxed);
            long long prev = ui_worst_late_ms.load(std::memory_order_relaxed);
            while (late > prev &&
                   !ui_worst_late_ms.compare_exchange_weak(prev, late,
                                                           std::memory_order_relaxed)) {}
            next += kPeriod;
            if (next < now) next = now + kPeriod;
        }
    });

    const auto t0 = Clock::now();
    long long worst_file_ms = 0;
    std::string worst_file;

    for (const auto& f : files) {
        const auto f0 = Clock::now();
        const auto overview = analyze_file_peaks(to_utf8(f), resolution);
        const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
            Clock::now() - f0).count();
        if (ms > worst_file_ms) {
            worst_file_ms = ms;
            worst_file = to_utf8(f.filename());
        }
        std::printf("  %-16s %6lld ms  (%zu buckets, sr=%d)\n",
                    to_utf8(f.filename()).c_str(), ms,
                    overview.max_peaks.size(), overview.sample_rate);
    }

    const auto total = std::chrono::duration_cast<std::chrono::milliseconds>(
        Clock::now() - t0).count();
    done.store(true, std::memory_order_relaxed);
    ui_probe.join();

    std::printf("\n--- results ---\n");
    std::printf("total          : %lld ms (%.1f s)\n", total, total / 1000.0);
    std::printf("slowest file   : %s at %lld ms\n",
                worst_file.c_str(), worst_file_ms);
    std::printf("throughput     : %.1f MB/s\n",
                total > 0 ? (input_bytes / (1024.0 * 1024.0)) / (total / 1000.0) : 0.0);
    std::printf("UI worst stall : %lld ms (%lld ticks over 100ms)\n",
                ui_worst_late_ms.load(), ui_late_over_100ms.load());
    return 0;
}
