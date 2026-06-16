// bench_import_while_playing — reproduces the field bug where playback drops
// out / stutters while audio of a freshly-imported song is still decoding.
//
// Scenario (no UI, no real audio device — pure engine):
//   1. Build a session with N already-decoded, cache_ready tracks.
//   2. Start a render loop on its own thread, paced at real-time block cadence,
//      measuring per-block wall time and counting blocks that exceed the audio
//      buffer budget (= an underrun / dropout in the real app).
//   3. Concurrently, simulate "importing another song" by calling
//      store_decoded_source() for M large new sources from worker threads —
//      this is the heavy decode+PCM-cache-write that competes with the render.
//
// Output: max/avg block render time, count of over-budget blocks, cache misses.
// A clean engine keeps over_budget_blocks low even under concurrent import.
//
// Build: -DLT_ENGINE_BUILD_BENCHES=ON, run bench_import_while_playing.
// Tunables via env: LT_BENCH_TRACKS, LT_BENCH_IMPORTS, LT_BENCH_BLOCKS,
//   LT_BENCH_BUFFER, LT_BENCH_SECONDS.

#include <lt_engine/render/mixer.h>
#include <lt_engine/render/track_renderer.h>
#include <lt_engine/scheduler/jump_scheduler.h>
#include <lt_engine/session/session.h>
#include <lt_engine/sources/audio_decoder.h>
#include <lt_engine/sources/io_throttle.h>
#include <lt_engine/sources/source_manager.h>
#include <lt_engine/transport/transport_clock.h>

#include <memory>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <string>
#include <thread>
#include <vector>

#if defined(_WIN32)
#  define WIN32_LEAN_AND_MEAN
#  ifndef NOMINMAX
#    define NOMINMAX
#  endif
#  include <windows.h>
#  include <psapi.h>
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
}
#else
namespace { unsigned long long working_set_mb() { return 0; }
           unsigned long long page_fault_count() { return 0; } }
#endif

using namespace lt;
using Clock = std::chrono::steady_clock;

namespace {

constexpr int kSampleRate = 48000;
constexpr int kChannels = 2;

int env_int(const char* name, int fallback) {
    if (const char* v = std::getenv(name)) {
        const int n = std::atoi(v);
        if (n > 0) return n;
    }
    return fallback;
}

struct Config {
    int playing_tracks = 24;     // tracks already playing
    int import_sources = 24;     // new sources decoded concurrently
    int render_blocks  = 2000;   // blocks to render in the measured loop
    int buffer_frames  = 512;    // audio buffer size
    int seconds        = 60;     // length of each source
};

Config read_config() {
    Config c;
    c.playing_tracks = env_int("LT_BENCH_TRACKS", c.playing_tracks);
    c.import_sources = env_int("LT_BENCH_IMPORTS", c.import_sources);
    c.render_blocks  = env_int("LT_BENCH_BLOCKS", c.render_blocks);
    c.buffer_frames  = env_int("LT_BENCH_BUFFER", c.buffer_frames);
    c.seconds        = env_int("LT_BENCH_SECONDS", c.seconds);
    return c;
}

std::vector<float> make_audio(Frame frames, int idx) {
    std::vector<float> s(static_cast<std::size_t>(frames * kChannels), 0.0f);
    const double f1 = 90.0 + 7.0 * (idx % 31);
    for (Frame f = 0; f < frames; ++f) {
        const double t = static_cast<double>(f) / kSampleRate;
        const float v = static_cast<float>(0.2 * std::sin(2.0 * 3.14159265 * f1 * t));
        s[static_cast<std::size_t>(f * kChannels)] = v;
        s[static_cast<std::size_t>(f * kChannels + 1)] = v;
    }
    return s;
}

} // namespace

int main() {
    const Config cfg = read_config();
    const Frame song_frames = static_cast<Frame>(cfg.seconds) * kSampleRate;

    SourceManager sources;
    auto session = std::make_shared<Session>();
    session->id = "import-while-playing";
    session->sample_rate = kSampleRate;

    Song song;
    song.id = "song-0";
    song.start_frame = 0;
    song.end_frame = song_frames;

    std::printf("building %d playing tracks (%ds each)...\n",
                cfg.playing_tracks, cfg.seconds);
    for (int t = 0; t < cfg.playing_tracks; ++t) {
        const Id sid = "play-src-" + std::to_string(t);
        sources.register_source(sid, "play-" + std::to_string(t) + ".wav");
        auto r = sources.store_decoded_source(
            sid, make_audio(song_frames, t), kChannels, kSampleRate, song_frames);
        if (r.is_err()) { std::fprintf(stderr, "store failed: %s\n", r.error().c_str()); return 2; }

        Track track;
        track.id = "play-trk-" + std::to_string(t);
        track.gain = 1.0f / static_cast<float>(std::max(1, cfg.playing_tracks));
        track.clips.push_back(Clip{
            "play-clip-" + std::to_string(t), sid, 0, 0, song_frames, 1.0f});
        song.tracks.push_back(std::move(track));
    }
    session->songs.push_back(std::move(song));
    const Song& play_song = session->songs.front();

    // Warm the block cache for the window we'll render (these are the already-
    // ready tracks; in the app they'd be served from the streaming cache).
    const int track_count = std::min<int>(cfg.playing_tracks,
                                          static_cast<int>(play_song.tracks.size()));

    const double budget_ms = 1000.0 * cfg.buffer_frames / kSampleRate;
    std::printf("render: %d blocks @ %d frames, budget=%.2fms/block; "
                "concurrent imports=%d\n",
                cfg.render_blocks, cfg.buffer_frames, budget_ms, cfg.import_sources);

    std::atomic<bool> render_done{false};
    std::atomic<int>  over_budget{0};
    std::atomic<long long> max_block_us{0};
    std::atomic<long long> sum_block_us{0};
    std::atomic<std::size_t> render_misses{0};
    std::atomic<unsigned long long> peak_ws_mb{0};

    const unsigned long long pf_start = page_fault_count();
    // Memory sampler: tracks peak working set during the run (the field signal
    // was the import spiking the process working set to ~2.5GB, which triggered
    // OS working-set trimming and stalled the audio thread on soft faults).
    std::thread mem_sampler([&] {
        while (!render_done.load()) {
            const unsigned long long ws = working_set_mb();
            unsigned long long prev = peak_ws_mb.load(std::memory_order_relaxed);
            while (ws > prev &&
                   !peak_ws_mb.compare_exchange_weak(prev, ws, std::memory_order_relaxed)) {}
            std::this_thread::sleep_for(std::chrono::milliseconds(20));
        }
    });

    // The Mixer + clock + scheduler live in main scope so the "session churn"
    // thread (below) can call set_session() concurrently with render(), exactly
    // like the real app does when an import triggers a LoadSession mid-playback.
    TransportClock clock(kSampleRate);
    JumpScheduler scheduler;
    Mixer mixer(session, &sources, &clock, &scheduler);
    mixer.prepare_render_resources(cfg.buffer_frames);
    clock.seek(0);
    clock.play();
    clock.clear_pending_start();

    // ---- Render thread: drives the FULL Mixer (meters, folder controls,
    // metronome, voice guide — the same render() the audio callback runs),
    // paced at real-time block cadence, measuring per-block wall time.
    std::thread render_thread([&] {
        set_playback_active(true);

        std::vector<float> left(static_cast<std::size_t>(cfg.buffer_frames), 0.0f);
        std::vector<float> right(static_cast<std::size_t>(cfg.buffer_frames), 0.0f);
        float* out[2] = {left.data(), right.data()};

        const auto before = sources.cache_diagnostics();
        const auto block_period = std::chrono::microseconds(
            static_cast<long long>(budget_ms * 1000.0));
        auto next_deadline = Clock::now();

        for (int b = 0; b < cfg.render_blocks; ++b) {
            const auto t0 = Clock::now();
            std::fill(left.begin(), left.end(), 0.0f);
            std::fill(right.begin(), right.end(), 0.0f);
            mixer.render(out, kChannels, cfg.buffer_frames, kSampleRate);
            const auto t1 = Clock::now();
            const long long us =
                std::chrono::duration_cast<std::chrono::microseconds>(t1 - t0).count();
            sum_block_us.fetch_add(us, std::memory_order_relaxed);
            long long prev = max_block_us.load(std::memory_order_relaxed);
            while (us > prev && !max_block_us.compare_exchange_weak(prev, us)) {}
            if (us > budget_ms * 1000.0)
                over_budget.fetch_add(1, std::memory_order_relaxed);

            // Pace to real time: sleep until this block's deadline.
            next_deadline += block_period;
            std::this_thread::sleep_until(next_deadline);
        }
        const auto after = sources.cache_diagnostics();
        render_misses.store(after.blocks_miss - before.blocks_miss);
        set_playback_active(false);
        render_done.store(true);
    });

    // ---- Import sources: prefer REAL files from LT_BENCH_IMPORT_DIR (decoded
    // via the real MP3/FFmpeg path, exactly like a runtime import). Falls back
    // to synthetic buffers when no directory is given.
    std::vector<std::string> import_files;
    if (const char* dir = std::getenv("LT_BENCH_IMPORT_DIR")) {
        namespace fs = std::filesystem;
        std::error_code ec;
        for (const auto& entry : fs::directory_iterator(dir, ec)) {
            if (!entry.is_regular_file()) continue;
            auto ext = entry.path().extension().string();
            std::transform(ext.begin(), ext.end(), ext.begin(),
                           [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
            if (ext == ".mp3" || ext == ".wav" || ext == ".flac" || ext == ".aiff"
                || ext == ".aif" || ext == ".ogg" || ext == ".m4a")
                import_files.push_back(entry.path().string());
        }
        std::sort(import_files.begin(), import_files.end());
        std::printf("import source: %zu real files from %s\n", import_files.size(), dir);
    } else {
        std::printf("import source: %d synthetic buffers (set LT_BENCH_IMPORT_DIR "
                    "for real MP3 decode)\n", cfg.import_sources);
    }
    const int import_total = import_files.empty()
        ? cfg.import_sources : static_cast<int>(import_files.size());

    const int import_threads = std::max(1, env_int("LT_BENCH_IMPORT_THREADS", 4));
    std::atomic<int> next_import{0};
    std::atomic<int> imports_done{0};
    std::vector<std::thread> importers;
    const auto import_t0 = Clock::now();
    for (int w = 0; w < import_threads; ++w) {
        importers.emplace_back([&] {
            for (;;) {
                const int idx = next_import.fetch_add(1);
                if (idx >= import_total) break;
                const Id sid = "import-src-" + std::to_string(idx);

                {
                    // Same memory gate the real worker pool uses: bound the
                    // peak resident footprint while playing.
                    DecodeMemoryGate decode_gate;
                    const bool streaming = env_int("LT_BENCH_STREAMING", 1) != 0;
                    if (!import_files.empty() && streaming) {
                        // NEW streaming path: decode→resample→cache in chunks,
                        // never materializing the whole file. This is what the
                        // app's prep queue now uses.
                        const std::string& path = import_files[static_cast<std::size_t>(idx)];
                        sources.register_source(sid, path);
                        auto r = sources.decode_and_store_streaming(sid, path, kSampleRate);
                        if (r.is_err())
                            std::fprintf(stderr, "stream decode failed (%s): %s\n",
                                         path.c_str(), r.error().c_str());
                    } else {
                        // Whole-file path (old) — for A/B of peak working set.
                        std::vector<float> samples;
                        int ch = kChannels;
                        Frame dur = song_frames;
                        if (!import_files.empty()) {
                            const std::string& path = import_files[static_cast<std::size_t>(idx)];
                            sources.register_source(sid, path);
                            auto decoded = decode_file_to_float32(path, kSampleRate, &ch, &dur);
                            if (decoded.is_err()) {
                                std::fprintf(stderr, "decode failed (%s): %s\n",
                                             path.c_str(), decoded.error().c_str());
                                imports_done.fetch_add(1);
                                continue;
                            }
                            samples = decoded.take();
                        } else {
                            sources.register_source(sid, "import-" + std::to_string(idx) + ".wav");
                            samples = make_audio(song_frames, 1000 + idx);
                        }
                        auto r = sources.store_decoded_source(sid, std::move(samples), ch, kSampleRate, dur);
                        (void)r;
                    }
                }
                imports_done.fetch_add(1);

                // Simulate the LoadSession the app fires after each import:
                // build a fresh session adding this imported track and hand it
                // to the LIVE mixer via set_session(), concurrent with render().
                // This is the cross-thread interaction the earlier passes lacked.
                const int churn = env_int("LT_BENCH_CHURN", 1);
                for (int c = 0; c < churn; ++c) {
                    auto next = std::make_shared<Session>(*session);
                    Track tk;
                    tk.id = "import-trk-" + std::to_string(idx) + "-" + std::to_string(c);
                    tk.gain = 0.5f;
                    tk.clips.push_back(Clip{
                        "import-clip-" + std::to_string(idx) + "-" + std::to_string(c),
                        sid, 0, 0, song_frames, 1.0f});
                    if (!next->songs.empty())
                        next->songs.front().tracks.push_back(std::move(tk));
                    mixer.set_session(next, /*preserve_realtime_state=*/true);
                }
            }
        });
    }

    render_thread.join();
    for (auto& t : importers) t.join();
    mem_sampler.join();
    const unsigned long long pf_total = page_fault_count() - pf_start;
    const double import_ms =
        std::chrono::duration<double, std::milli>(Clock::now() - import_t0).count();

    const double avg_us = cfg.render_blocks > 0
        ? static_cast<double>(sum_block_us.load()) / cfg.render_blocks : 0.0;

    std::puts("---- results ----");
    std::printf("imports_completed=%d in %.0fms\n", imports_done.load(), import_ms);
    std::printf("render avg_block_us=%.1f max_block_us=%lld budget_us=%.0f\n",
                avg_us, max_block_us.load(), budget_ms * 1000.0);
    std::printf("over_budget_blocks=%d / %d (%.2f%%)\n",
                over_budget.load(), cfg.render_blocks,
                100.0 * over_budget.load() / std::max(1, cfg.render_blocks));
    std::printf("render_cache_misses=%zu\n", render_misses.load());
    std::printf("peak_working_set=%lluMB total_page_faults=%llu\n",
                peak_ws_mb.load(), pf_total);

    // Pass: fewer than 1% of blocks over budget under concurrent import.
    const double over_pct = 100.0 * over_budget.load() / std::max(1, cfg.render_blocks);
    const bool ok = over_pct < 1.0;
    std::printf("VERDICT: %s\n", ok ? "PASS" : "FAIL (dropouts under import)");
    return ok ? 0 : 5;
}
