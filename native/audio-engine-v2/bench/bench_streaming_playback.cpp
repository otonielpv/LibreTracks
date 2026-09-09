// Real file reads through SourceManager and Mixer. No audio device or GUI.
// Files must be named 0.wav .. N-1.wav, native 48 kHz mono/stereo.
// Seek is deliberately immediate: measures cache recovery, not JumpScheduler's
// gated transition. Never translate missing source frames into driver xruns.
#include <lt_engine/render/mixer.h>
#include <lt_engine/scheduler/jump_scheduler.h>
#include <lt_engine/session/session.h>
#include <lt_engine/sources/source_manager.h>
#include <lt_engine/sources/io_throttle.h>
#include <lt_engine/transport/transport_clock.h>
#include "streaming_import_workload.h"
#include <algorithm>
#include <chrono>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <thread>
#include <vector>
#if defined(_WIN32)
#  define NOMINMAX
#  define WIN32_LEAN_AND_MEAN
#  include <windows.h>
#  include <psapi.h>
#else
#  include <sys/resource.h>
#endif

using namespace lt;
using Clock = std::chrono::steady_clock;

static double cpu_seconds() {
#if defined(_WIN32)
    FILETIME created{}, exited{}, kernel{}, user{};
    if (!GetProcessTimes(GetCurrentProcess(), &created, &exited, &kernel, &user))
        throw std::runtime_error("Cannot sample process CPU");
    ULARGE_INTEGER k{}, u{};
    k.LowPart = kernel.dwLowDateTime; k.HighPart = kernel.dwHighDateTime;
    u.LowPart = user.dwLowDateTime; u.HighPart = user.dwHighDateTime;
    return (k.QuadPart + u.QuadPart) * 1e-7;
#else
    rusage usage{};
    if (getrusage(RUSAGE_SELF, &usage)) throw std::runtime_error("Cannot sample process CPU");
    return usage.ru_utime.tv_sec + usage.ru_stime.tv_sec
        + (usage.ru_utime.tv_usec + usage.ru_stime.tv_usec) * 1e-6;
#endif
}

static std::uint64_t peak_rss_bytes() {
#if defined(_WIN32)
    PROCESS_MEMORY_COUNTERS memory{};
    if (!GetProcessMemoryInfo(GetCurrentProcess(), &memory, sizeof(memory)))
        throw std::runtime_error("Cannot sample process memory");
    return memory.PeakWorkingSetSize;
#else
    rusage usage{};
    if (getrusage(RUSAGE_SELF, &usage)) throw std::runtime_error("Cannot sample process memory");
#if defined(__APPLE__)
    return usage.ru_maxrss;
#else
    return static_cast<std::uint64_t>(usage.ru_maxrss) * 1024;
#endif
#endif
}

int main(int argc, char** argv) try {
    if (argc != 8 && argc != 9) throw std::runtime_error(
        "Usage: bench_streaming_playback DIR JSON TRACKS BLOCK BLOCKS PRELOAD(0|1) TRIM(0|1) [IMPORTS]");
    const int tracks = std::stoi(argv[3]), block = std::stoi(argv[4]);
    const int blocks = std::stoi(argv[5]), preload = std::stoi(argv[6]), trim = std::stoi(argv[7]);
    const int imports = argc == 9 ? std::stoi(argv[8]) : 0;
    if (tracks < 1 || tracks > 128 || block < 64 || block > 2048 || blocks < 10 || blocks > 100000
        || preload < 0 || preload > 1 || trim < 0 || trim > 1 || imports < 0 || imports > 16)
        throw std::runtime_error("Invalid configuration");
    constexpr int sr = 48000;
    const Frame start = 5 * sr, target = 30 * sr;
    const Frame needed = target + Frame(block) * blocks;
    SourceManager sources;
    auto session = std::make_shared<Session>();
    session->id = "streaming-bench";
    session->sample_rate = sr;
    Song song;
    song.id = "song";
    song.start_frame = 0;
    song.end_frame = needed;
    std::vector<std::pair<Id, Frame>> heads;
    for (int i = 0; i < tracks; ++i) {
        const Id id = "streaming-source-" + std::to_string(i);
        const auto path = (std::filesystem::path(argv[1]) / (std::to_string(i) + ".wav")).string();
        sources.register_source(id, path);
        if (!sources.try_install_native_file(id, sr))
            throw std::runtime_error("Cannot stream native file: " + path);
        const auto source = sources.get_shared(id);
        if (!source || source->duration_frames() < needed)
            throw std::runtime_error("Source too short: " + path);
        Track track;
        track.id = "track-" + std::to_string(i);
        track.gain = 0.5f / tracks;
        track.clips.push_back(Clip{"clip-" + std::to_string(i), id, 0, 0, needed, 1.0f});
        song.tracks.push_back(std::move(track));
        heads.emplace_back(id, start);
    }
    session->songs.push_back(std::move(song));
    TransportClock transport(sr);
    JumpScheduler scheduler;
    Mixer mixer(session, &sources, &transport, &scheduler);
    mixer.prepare_render_resources(block);

    // Explicitly paid outside playback; only preload the start, never the jump.
    const auto prepare_start = Clock::now();
    if (preload) {
        sources.preload_clip_heads(heads);
        for (const auto& [id, frame] : heads) sources.request_range(id, frame, block, true);
        for (;;) {
            bool ready = true;
            for (const auto& [id, frame] : heads)
                ready = ready && sources.get_shared(id)->is_range_ready(frame, block);
            if (ready) break;
            if (Clock::now() - prepare_start > std::chrono::seconds(10))
                throw std::runtime_error("Preload timeout");
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
    }
    const double prepare_ms = std::chrono::duration<double, std::milli>(Clock::now() - prepare_start).count();
    (void)sources.take_fill_io_stats();
    const Frame miss0 = sources.total_cache_miss_frames();
    std::vector<double> times;
    times.reserve(blocks);
    std::vector<float> left(block), right(block);
    float* output[] = {left.data(), right.data()};
    std::uint64_t late = 0, affected = 0, misses_before_jump = 0, freed = 0;
    std::size_t peak_queue = 0, peak_cache = 0;
    double energy = 0;
    int recovery_blocks = -1, consecutive_ready = 0;
    const int jump_block = blocks / 2;
    std::unique_ptr<StreamingImportWorkload> importing;
    if (imports) importing = std::make_unique<StreamingImportWorkload>(sources, argv[1], imports);
    int import_overlap_blocks = 0;
    bool import_active_at_jump = false;
    transport.seek(start);
    transport.play();
    transport.clear_pending_start();
    set_playback_active(true);
    auto deadline = Clock::now();
    const auto period = std::chrono::nanoseconds(static_cast<long long>(1e9 * block / sr));
    const auto began = Clock::now();
    const auto cpu0 = cpu_seconds();
    for (int b = 0; b < blocks; ++b) {
        if (importing && b == jump_block - 1) importing->start();
        if (b == jump_block) {
            import_active_at_jump = importing && importing->active();
            misses_before_jump = sources.total_cache_miss_frames() - miss0;
            sources.drop_pending_readahead();
            if (trim) freed = sources.release_cached_blocks_under_pressure(1);
            transport.seek(target);
            transport.clear_pending_start();
        }
        const auto missing_before = sources.total_cache_miss_frames();
        if (importing && importing->active()) ++import_overlap_blocks;
        const auto t0 = Clock::now();
        mixer.render(output, 2, block, sr);
        const double us = std::chrono::duration<double, std::micro>(Clock::now() - t0).count();
        times.push_back(us);
        if (us > 1e6 * block / sr) ++late;
        const bool missing = sources.total_cache_miss_frames() != missing_before;
        if (missing) ++affected;
        if (b >= jump_block && recovery_blocks < 0) {
            consecutive_ready = missing ? 0 : consecutive_ready + 1;
            if (consecutive_ready == 8) recovery_blocks = b - jump_block - 7;
        }
        for (int f = 0; f < block; ++f) energy += double(left[f]) * left[f] + double(right[f]) * right[f];
        // Off-render sampling still perturbs pacing: preserve this cadence in A/B.
        if (b % 16 == 0) {
            peak_queue = std::max(peak_queue, sources.fill_queue_depth());
            peak_cache = std::max(peak_cache, sources.cache_diagnostics().bytes_used);
        }
        deadline += period;
        std::this_thread::sleep_until(deadline);
    }
    set_playback_active(false);
    const double wall_s = std::chrono::duration<double>(Clock::now() - began).count();
    const double cpu_s = cpu_seconds() - cpu0;
    const auto io = sources.take_fill_io_stats();
    const auto cache = sources.cache_diagnostics();
    const auto missing = sources.total_cache_miss_frames() - miss0;
    const auto playback_peak_rss = peak_rss_bytes();
    // Freeze playback observations before waiting for unfinished imports.
    if (importing) importing->finish();
    std::sort(times.begin(), times.end());
    const auto percentile = [&](double p) { return times[static_cast<std::size_t>(p * (times.size() - 1))]; };
    std::ofstream json(argv[2]);
    if (!json) throw std::runtime_error("Cannot create JSON");
    json << "{\n\"tracks\":" << tracks << ",\"block\":" << block << ",\"blocks\":" << blocks
         << ",\"sample_rate\":48000,\"preload\":" << preload << ",\"trim\":" << trim
         << ",\"imports_requested\":" << imports
         << ",\"imports_completed\":" << (importing ? importing->completed() : 0)
         << ",\"import_ms\":" << (importing ? importing->elapsed_ms() : 0)
         << ",\"import_overlap_blocks\":" << import_overlap_blocks
         << ",\"import_active_at_jump\":" << (import_active_at_jump ? 1 : 0)
         << ",\"prepare_ms\":" << prepare_ms << ",\"wall_seconds\":" << wall_s
         << ",\"process_cpu_seconds\":" << cpu_s << ",\"peak_rss_bytes\":" << playback_peak_rss
         << ",\"peak_rss_after_import_bytes\":" << peak_rss_bytes()
         << ",\"rendered_tracks\":" << mixer.rendered_track_count()
         << ",\"p50_us\":" << percentile(.5) << ",\"p95_us\":" << percentile(.95)
         << ",\"p99_us\":" << percentile(.99) << ",\"max_us\":" << times.back()
         << ",\"deadline_misses\":" << late << ",\"missing_source_frames\":" << missing
         << ",\"missing_before_jump\":" << misses_before_jump
         << ",\"missing_after_jump\":" << missing - misses_before_jump
         << ",\"blocks_with_missing_frames\":" << affected
         << ",\"jump_recovery_blocks\":" << recovery_blocks << ",\"output_energy\":" << energy
         << ",\"sampled_peak_queue\":" << peak_queue
         << ",\"sampled_peak_cache_bytes\":" << std::max(peak_cache, cache.bytes_used)
         << ",\"cache_capacity_bytes\":" << cache.bytes_capacity << ",\"trim_freed_bytes\":" << freed
         << ",\"read_count\":" << io.read_count << ",\"frames_read\":" << io.frames_read
         << ",\"read_max_us\":" << io.read_max_us << ",\"read_failures\":" << io.read_failures
         << ",\"open_failures\":" << io.open_failures
         << ",\"queue_urgent_end\":" << io.queue_urgent << ",\"queue_normal_end\":" << io.queue_normal << "\n}\n";
    json.close();
    if (!json || !std::isfinite(energy) || energy <= 0 || io.read_failures || io.open_failures || !io.read_count
        || mixer.rendered_track_count() != static_cast<std::uint64_t>(tracks) * blocks
        || (imports && !import_overlap_blocks))
        throw std::runtime_error("Invalid run: missing output, no streaming reads, I/O failure or JSON write failure");
    std::cout << "p95_us=" << percentile(.95) << " missing_source_frames=" << missing
              << " reads=" << io.read_count << "\n";
    return 0; // Timing and starvation are observations, never flaky PASS/FAIL gates.
} catch (const std::exception& e) {
    std::cerr << e.what() << '\n';
    return 2;
}
