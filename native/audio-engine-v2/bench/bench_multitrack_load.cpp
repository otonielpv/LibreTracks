// ---------------------------------------------------------------------------
// bench_multitrack_load — measure the LOAD path for a real multitrack folder.
//
// Field report: a ~20-track multitrack of 44.1kHz/24-bit WAV stems (~200MB each)
// makes the whole app slow and unusable. The load path has two very different
// routes (preparation_queue.cpp):
//
//   Fast: try_install_native_file() streams the original WAV in place — no
//         decode, no resample, no cache file. Requires the file's sample rate
//         to EQUAL the engine sample rate (source_manager.cpp eligibility).
//   Slow: DecodeWorkerPool decodes + resamples the whole file and writes a
//         PCM cache to disk.
//
// So a 44.1kHz stem set takes the fast route at engine SR 44100 and the slow
// route at 48000. This bench measures both so the fix is chosen on data.
//
// Usage:
//   LT_BENCH_DIR=<folder with .wav stems>   (required)
//   LT_BENCH_SR=44100|48000                 (engine sample rate, default 48000)
//   LT_BENCH_MAX_FILES=N                    (limit stems, default: all)
//   LT_BENCH_CACHE=<dir>                    (engine cache dir; default temp)
//
// Reports: wall time to prepare all sources, which route each took, peak
// working set, page faults, and bytes written to the cache dir.
// ---------------------------------------------------------------------------

#include <lt_engine/sources/preparation_queue.h>
#include <lt_engine/sources/source_manager.h>
#include <lt_engine/sources/worker_pool.h>
#include <lt_engine/session/session.h>
#include <lt_engine/core/events.h>
#include <lt_engine/core/types.h>
#include <variant>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <string>
#include <thread>
#include <vector>

#if defined(_WIN32)
#include <windows.h>
#include <psapi.h>
namespace {
unsigned long long working_set_mb() {
    PROCESS_MEMORY_COUNTERS pmc{};
    if (GetProcessMemoryInfo(GetCurrentProcess(), &pmc, sizeof(pmc)))
        return pmc.WorkingSetSize / (1024ull * 1024ull);
    return 0;
}
unsigned long long page_fault_count() {
    PROCESS_MEMORY_COUNTERS pmc{};
    if (GetProcessMemoryInfo(GetCurrentProcess(), &pmc, sizeof(pmc)))
        return pmc.PageFaultCount;
    return 0;
}
} // namespace
#else
namespace {
unsigned long long working_set_mb() { return 0; }
unsigned long long page_fault_count() { return 0; }
} // namespace
#endif

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

unsigned long long dir_bytes(const fs::path& dir) {
    unsigned long long total = 0;
    std::error_code ec;
    if (!fs::exists(dir, ec)) return 0;
    for (auto it = fs::recursive_directory_iterator(dir, ec);
         it != fs::recursive_directory_iterator(); it.increment(ec)) {
        if (ec) break;
        std::error_code fec;
        if (it->is_regular_file(fec)) total += it->file_size(fec);
    }
    return total;
}

} // namespace

int main() {
    const std::string dir = env_str("LT_BENCH_DIR", "");
    if (dir.empty()) {
        std::fprintf(stderr, "LT_BENCH_DIR is required (folder with .wav stems)\n");
        return 2;
    }
    const int engine_sr = env_int("LT_BENCH_SR", 48000);
    const int max_files = env_int("LT_BENCH_MAX_FILES", 0);

    // Isolate the engine's PCM cache so each run measures a COLD load and we can
    // weigh exactly how many bytes this configuration writes to disk.
    const std::string cache_dir = env_str(
        "LT_BENCH_CACHE",
        (fs::temp_directory_path() / ("lt_bench_cache_" + std::to_string(engine_sr))).string());
    std::error_code ec;
    fs::remove_all(cache_dir, ec);
    fs::create_directories(cache_dir, ec);
#if defined(_WIN32)
    SetEnvironmentVariableA("LIBRETRACKS_CACHE_DIR", cache_dir.c_str());
#else
    setenv("LIBRETRACKS_CACHE_DIR", cache_dir.c_str(), 1);
#endif

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

    std::printf("=== multitrack load bench ===\n");
    std::printf("dir       : %s\n", dir.c_str());
    std::printf("files     : %zu (%.1f MB total on disk)\n",
                files.size(), input_bytes / (1024.0 * 1024.0));
    std::printf("engine SR : %d Hz\n", engine_sr);
    std::printf("cache dir : %s\n\n", cache_dir.c_str());

    SourceManager sources;
    DecodeWorkerPool pool;

    const std::size_t expected = files.size();
    std::atomic<std::size_t> prepared{0};
    std::atomic<std::size_t> failed{0};

    SourcePreparationQueue queue(
        &sources, &pool,
        [&](EngineEvent ev) {
            if (std::holds_alternative<EvSourcePrepared>(ev))
                prepared.fetch_add(1, std::memory_order_relaxed);
            else if (std::holds_alternative<EvDiagnosticWarning>(ev))
                failed.fetch_add(1, std::memory_order_relaxed);
        },
        engine_sr);

    // The engine carries paths as UTF-8 (they come from the Rust/Tauri layer).
    // std::filesystem::path::string() on Windows converts to the ACTIVE ANSI
    // codepage, which mangles accented stem names ("Guía.wav") so the decoder
    // never opens them — one of the reported stems is exactly that. Convert
    // through u8string() so the bench feeds the engine what the app would.
    auto to_utf8 = [](const fs::path& p) {
        const auto u8 = p.u8string();
        return std::string(reinterpret_cast<const char*>(u8.data()), u8.size());
    };

    std::vector<Source> session_sources;
    session_sources.reserve(files.size());
    for (const auto& f : files) {
        Source s;
        s.id = to_utf8(f);
        s.file_path = to_utf8(f);
        session_sources.push_back(std::move(s));
    }

    std::atomic<bool> done{false};
    std::atomic<unsigned long long> peak_ws{0};
    std::thread sampler([&] {
        while (!done.load(std::memory_order_relaxed)) {
            const unsigned long long ws = working_set_mb();
            unsigned long long prev = peak_ws.load(std::memory_order_relaxed);
            while (ws > prev &&
                   !peak_ws.compare_exchange_weak(prev, ws, std::memory_order_relaxed)) {}
            std::this_thread::sleep_for(std::chrono::milliseconds(20));
        }
    });

    const unsigned long long pf_start = page_fault_count();
    const auto t0 = Clock::now();

    queue.enqueue_session(session_sources, 0);

    // Wait for every source to reach a terminal state. enqueue_session returns
    // immediately for the fast route and asynchronously for the decode pool, so
    // poll the SourceManager rather than trusting event counts alone.
    //
    // Also track PROGRESSIVE availability: preparation publishes each source as
    // playable when it finishes, so what matters to the user is not only the
    // total but when the first stem becomes audible and how the rest follow.
    // Stall detection rather than a flat long timeout: if nothing progresses for
    // a while the run is stuck, and waiting the full deadline just hides it.
    const auto deadline = t0 + std::chrono::minutes(15);
    constexpr auto kStallLimit = std::chrono::seconds(90);
    std::size_t ready = 0;
    long long first_ready_ms = -1;
    std::vector<long long> ready_at_ms;   // ms at which the Nth stem became ready
    std::size_t last_progress = 0;
    auto last_change = Clock::now();
    bool stalled = false;
    while (Clock::now() < deadline) {
        ready = 0;
        std::size_t errored = 0;
        std::size_t streaming = 0;
        for (const auto& d : sources.diagnostics()) {
            if (d.status == "ready" || d.status == "cache_ready") ++ready;
            else if (d.status == "streaming") ++streaming;
            else if (d.status == "failed") ++errored;
        }
        const auto now_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
            Clock::now() - t0).count();
        while (ready_at_ms.size() < ready)
            ready_at_ms.push_back(now_ms);
        if (first_ready_ms < 0 && (ready > 0 || streaming > 0))
            first_ready_ms = now_ms;
        if (ready + errored >= expected) break;

        const std::size_t progress = ready + errored + streaming;
        if (progress != last_progress) {
            last_progress = progress;
            last_change = Clock::now();
        } else if (Clock::now() - last_change > kStallLimit) {
            std::printf("!! stalled: no progress for %llds at %zu/%zu ready\n",
                        (long long)std::chrono::duration_cast<std::chrono::seconds>(
                            kStallLimit).count(), ready, expected);
            stalled = true;
            break;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(25));
    }

    const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
        Clock::now() - t0).count();
    done.store(true, std::memory_order_relaxed);
    sampler.join();

    const unsigned long long pf_delta = page_fault_count() - pf_start;
    const unsigned long long cache_written = dir_bytes(cache_dir);

    // Which route did each source take? A source streamed in place writes
    // nothing to the engine cache dir (disk_cache_bytes == 0); one that went
    // through decode+resample wrote a PCM cache file.
    std::size_t native_route = 0, decoded_route = 0;
    for (const auto& d : sources.diagnostics()) {
        if (d.status != "ready" && d.status != "cache_ready") continue;
        if (d.disk_cache_bytes == 0) ++native_route;
        else ++decoded_route;
    }

    std::printf("--- results ---\n");
    std::printf("sources ready      : %zu / %zu\n", ready, expected);
    std::printf("route: stream-in-place (fast) : %zu\n", native_route);
    std::printf("route: decode+resample (slow) : %zu\n", decoded_route);
    std::printf("wall time          : %lld ms (%.1f s)\n",
                static_cast<long long>(elapsed), elapsed / 1000.0);
    std::printf("first stem playable: %lld ms\n", first_ready_ms);
    if (!ready_at_ms.empty()) {
        std::printf("stems ready over time:\n");
        for (std::size_t i = 0; i < ready_at_ms.size(); ++i)
            std::printf("    #%-3zu at %6lld ms\n", i + 1, ready_at_ms[i]);
    }
    std::printf("peak working set   : %llu MB\n", peak_ws.load());
    std::printf("page faults        : %llu\n", pf_delta);
    std::printf("cache written      : %.1f MB\n",
                cache_written / (1024.0 * 1024.0));

    if (stalled)
        std::printf("\nRUN STALLED — figures above are partial.\n");

    pool.shutdown();
    return (ready == expected && !stalled) ? 0 : 1;
}
