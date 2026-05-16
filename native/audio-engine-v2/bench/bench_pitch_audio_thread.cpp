// bench_pitch_audio_thread.cpp
//
// Measures whether N concurrent RubberBandLiveShifter::shift() calls
// (or N RubberBandStretcher::process() calls) fit inside a real-time
// audio callback budget at common block sizes.
//
// What this answers:
//   "Can we run DSP directly on the audio thread per block instead of
//    using a ring-buffer / pre-priming architecture?"
//
// Decision criterion:
//   For a block_size B at sample_rate R, the callback budget is:
//     budget_us = (B / R) * 1e6  e.g. 480/48000 * 1e6 = 10000 µs = 10 ms
//   A single shift() call must use << budget / N so N streams fit with margin.
//   We target < 50% of budget for N=16 streams (worst case), leaving headroom
//   for decoding, mixing, metering, etc.
//
// Run with:
//   bench_pitch_audio_thread.exe [--stretcher]
//   (default: LiveShifter; --stretcher: use RubberBandStretcher instead)

#include <rubberband/RubberBandStretcher.h>

#if HAVE_RUBBERBAND_LIVE_SHIFTER
#  if __has_include(<rubberband/RubberBandLiveShifter.h>)
#    include <rubberband/RubberBandLiveShifter.h>
#  endif
#endif

#if HAVE_BUNGEE
#  include <bungee/Bungee.h>
#endif

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <memory>
#include <numeric>
#include <string>
#include <vector>

using Clock = std::chrono::steady_clock;
using Us    = std::chrono::microseconds;

// Log file written in parallel with stdout so we can tail it while running.
static std::ofstream g_log;
static void log(const char* fmt, ...) {
    char buf[512];
    va_list ap; va_start(ap, fmt); vsnprintf(buf, sizeof(buf), fmt, ap); va_end(ap);
    std::fputs(buf, stdout); std::fflush(stdout);
    if (g_log.is_open()) { g_log << buf; g_log.flush(); }
}

// ---------------------------------------------------------------------------
// Backend abstraction — minimal, just enough for the benchmark
// ---------------------------------------------------------------------------

struct IBenchVoice {
    virtual ~IBenchVoice() = default;
    virtual void  reset()  = 0;
    virtual int   block_size() const = 0;      // fixed input block (LiveShifter) or hint
    virtual void  process_block(float* const* in, float** out, int frames) = 0;
    virtual const char* name() const = 0;
};

// ── LiveShifter backend ───────────────────────────────────────────────────────
#if HAVE_RUBBERBAND_LIVE_SHIFTER
struct LiveShifterVoice : IBenchVoice {
    std::unique_ptr<RubberBand::RubberBandLiveShifter> shifter;
    int channels;
    int sample_rate;
    double pitch_scale;
    int bs = 0;

    LiveShifterVoice(int sr, int ch, double scale)
        : channels(ch), sample_rate(sr), pitch_scale(scale)
    {
        reset();
    }

    void reset() override {
        using Opt = RubberBand::RubberBandLiveShifter::Option;
        shifter = std::make_unique<RubberBand::RubberBandLiveShifter>(
            static_cast<size_t>(sample_rate),
            static_cast<size_t>(channels),
            Opt::OptionChannelsTogether);
        shifter->setPitchScale(pitch_scale);
        bs = static_cast<int>(shifter->getBlockSize());
    }

    int block_size() const override { return bs; }

    void process_block(float* const* in, float** out, int /*frames*/) override {
        // LiveShifter always processes exactly block_size() frames per shift() call.
        shifter->shift(in, out);
    }

    const char* name() const override { return "RubberBandLiveShifter"; }
};
#endif

// ── Stretcher backend ─────────────────────────────────────────────────────────
struct StretcherVoice : IBenchVoice {
    std::unique_ptr<RubberBand::RubberBandStretcher> stretcher;
    int channels;
    int sample_rate;
    double pitch_scale;
    int hint_block;

    StretcherVoice(int sr, int ch, double scale, int block)
        : channels(ch), sample_rate(sr), pitch_scale(scale), hint_block(block)
    {
        reset();
    }

    void reset() override {
        using RB  = RubberBand::RubberBandStretcher;
        using Opt = RubberBand::RubberBandStretcher::Option;
        const int opts = Opt::OptionProcessRealTime
                       | Opt::OptionPitchHighConsistency;
        stretcher = std::make_unique<RB>(
            static_cast<size_t>(sample_rate),
            static_cast<size_t>(channels),
            opts, 1.0, pitch_scale);
        // Feed start-pad silence (required before first audio block)
        const int pad = static_cast<int>(stretcher->getPreferredStartPad());
        std::vector<std::vector<float>> sil(static_cast<size_t>(channels),
            std::vector<float>(static_cast<size_t>(pad), 0.f));
        std::vector<float*> ptrs(static_cast<size_t>(channels));
        for (int c = 0; c < channels; ++c) ptrs[static_cast<size_t>(c)] = sil[static_cast<size_t>(c)].data();
        if (pad > 0) stretcher->process(ptrs.data(), static_cast<size_t>(pad), false);
    }

    int block_size() const override { return hint_block; }

    void process_block(float* const* in, float** out, int frames) override {
        stretcher->process(in, static_cast<size_t>(frames), false);
        int avail = static_cast<int>(stretcher->available());
        if (avail > 0)
            stretcher->retrieve(out, static_cast<size_t>(std::min(avail, frames)));
    }

    const char* name() const override { return "RubberBandStretcher"; }
};

// ── Bungee backend ─────────────────────────────────────────────────────────
#if HAVE_BUNGEE
struct BungeeVoice : IBenchVoice {
    // Bungee's Stretcher uses templated edition aliases. Use the default.
    using Stretcher = Bungee::Stretcher<Bungee::Basic>;
    std::unique_ptr<Stretcher> stretcher;
    Bungee::Request request{};
    int channels;
    int sample_rate;
    double pitch_scale;
    int hint_block;
    std::vector<float> input_buf;   // interleaved input scratch fed to analyseGrain
    int input_buf_frames = 0;

    BungeeVoice(int sr, int ch, double scale, int block)
        : channels(ch), sample_rate(sr), pitch_scale(scale), hint_block(block)
    {
        reset();
    }

    void reset() override {
        Bungee::SampleRates rates{sample_rate, sample_rate};
        stretcher = std::make_unique<Stretcher>(rates, channels);
        request.position = 0.0;
        request.speed    = 1.0;
        request.pitch    = pitch_scale;
        request.reset    = true;
        // ResampleMode is a global enum (Modes.h). Default to autoOut.
        request.resampleMode = ::resampleMode_autoOut;
        stretcher->preroll(request);
        // Pre-allocate a generous input scratch so analyseGrain never allocates.
        input_buf.assign(static_cast<size_t>(8192 * channels), 0.f);
        input_buf_frames = 8192;
    }

    int block_size() const override { return hint_block; }

    void process_block(float* const* in, float** out, int /*frames*/) override {
        // One grain per process_block call. specifyGrain → analyseGrain →
        // synthesiseGrain → next is the Bungee real-time loop.
        const Bungee::InputChunk inChunk = stretcher->specifyGrain(request);
        const int needed = std::max(0, inChunk.end - inChunk.begin);
        // Copy input from the caller's planar buffer into our interleaved scratch.
        // We don't have the requested source frames as planar audio, so synthesise
        // a steady tone in the scratch — same content as the caller's `in` buffers.
        const int copy = std::min(needed, input_buf_frames);
        for (int f = 0; f < copy; ++f)
            for (int c = 0; c < channels; ++c)
                input_buf[static_cast<size_t>(f * channels + c)] = in[c][f % hint_block];
        stretcher->analyseGrain(
            input_buf.data(),
            /*channelStride=*/1);   // interleaved
        Bungee::OutputChunk oc{};
        stretcher->synthesiseGrain(oc);
        // De-interleave back into the caller's planar output buffer.
        // We may produce fewer frames than hint_block — that's normal for granular APIs.
        const int produced = oc.frameCount;
        const int n = std::min(produced, hint_block);
        if (oc.data) {
            for (int f = 0; f < n; ++f)
                for (int c = 0; c < channels; ++c)
                    out[c][f] = oc.data[static_cast<size_t>(f * channels + c)];
        }
        stretcher->next(request);
        request.reset = false;
    }

    const char* name() const override { return "Bungee"; }
};
#endif

// ---------------------------------------------------------------------------
// Benchmark runner
// ---------------------------------------------------------------------------

struct Result {
    int    n_streams;
    int    block_size;
    double budget_us;
    double mean_us;      // mean callback time for all N streams combined
    double p95_us;
    double p99_us;
    double max_us;
    bool   fits;         // mean < 50% of budget
    bool   p99_fits;     // p99 < 80% of budget
};

static Result run_scenario(
    const std::vector<std::unique_ptr<IBenchVoice>>& voices,
    int block_size,
    int sample_rate,
    int n_warmup,
    int n_iter)
{
    const int n = static_cast<int>(voices.size());

    // Pre-allocate audio buffers (stereo)
    constexpr int kMaxBlock = 4096;
    constexpr int kCh = 2;
    static float in_buf[kCh][kMaxBlock];
    static float out_buf[kCh][kMaxBlock];
    static float* in_ptrs[kCh]  = { in_buf[0],  in_buf[1]  };
    static float* out_ptrs[kCh] = { out_buf[0], out_buf[1] };

    // Fill input with non-zero data (silence can hit fast paths)
    for (int c = 0; c < kCh; ++c)
        for (int f = 0; f < block_size; ++f)
            in_buf[c][f] = 0.1f * std::sin(2.0f * 3.14159f * 440.0f * f / sample_rate);

    std::vector<double> timings;
    timings.reserve(static_cast<size_t>(n_iter));

    for (int i = 0; i < n_warmup + n_iter; ++i) {
        const auto t0 = Clock::now();
        for (const auto& v : voices)
            v->process_block(in_ptrs, out_ptrs, block_size);
        const auto t1 = Clock::now();

        if (i >= n_warmup)
            timings.push_back(static_cast<double>(
                std::chrono::duration_cast<Us>(t1 - t0).count()));
    }

    std::sort(timings.begin(), timings.end());

    const double mean = std::accumulate(timings.begin(), timings.end(), 0.0)
                        / static_cast<double>(timings.size());
    const double p95  = timings[static_cast<size_t>(timings.size() * 95 / 100)];
    const double p99  = timings[static_cast<size_t>(timings.size() * 99 / 100)];
    const double mx   = timings.back();

    const double budget = static_cast<double>(block_size) / sample_rate * 1e6;

    Result r;
    r.n_streams  = n;
    r.block_size = block_size;
    r.budget_us  = budget;
    r.mean_us    = mean;
    r.p95_us     = p95;
    r.p99_us     = p99;
    r.max_us     = mx;
    r.fits       = mean    < budget * 0.50;
    r.p99_fits   = p99     < budget * 0.80;
    return r;
}

static void print_header() {
    log("\n%-10s %-10s %-10s %-10s %-10s %-10s %-10s %s\n",
        "streams", "block", "budget_us", "mean_us", "p95_us", "p99_us", "max_us", "verdict");
    log("%s\n", std::string(85, '-').c_str());
}

static void print_row(const Result& r) {
    const char* verdict = (r.fits && r.p99_fits) ? "OK"
                        : (r.fits)               ? "OK(p99!)"
                                                 : "TOO SLOW";
    log("%-10d %-10d %-10.0f %-10.1f %-10.1f %-10.1f %-10.1f %s\n",
        r.n_streams, r.block_size, r.budget_us,
        r.mean_us, r.p95_us, r.p99_us, r.max_us, verdict);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

int main(int argc, char** argv) {
    enum class Backend { LiveShifter, Stretcher, Bungee };
    Backend backend = Backend::LiveShifter;
    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        if (arg == "--stretcher") backend = Backend::Stretcher;
        else if (arg == "--bungee") backend = Backend::Bungee;
    }

    const char* log_path = nullptr;
    switch (backend) {
        case Backend::Stretcher:   log_path = "C:\\Users\\otoni\\bench_stretcher.txt"; break;
        case Backend::Bungee:      log_path = "C:\\Users\\otoni\\bench_bungee.txt"; break;
        case Backend::LiveShifter: log_path = "C:\\Users\\otoni\\bench_liveshifter.txt"; break;
    }
    g_log.open(log_path);
    log("[bench] logging to %s\n", log_path);

#if !HAVE_RUBBERBAND_LIVE_SHIFTER
    if (backend == Backend::LiveShifter) {
        log("NOTE: LiveShifter header not available; falling back to Stretcher.\n");
        backend = Backend::Stretcher;
    }
#endif
#if !HAVE_BUNGEE
    if (backend == Backend::Bungee) {
        log("NOTE: Bungee not compiled in; falling back to Stretcher. "
            "Reconfigure with -DLT_ENGINE_BENCH_BUNGEE=ON.\n");
        backend = Backend::Stretcher;
    }
#endif
    const bool use_stretcher = (backend == Backend::Stretcher);
    const bool use_bungee    = (backend == Backend::Bungee);

    const int sample_rate = 48000;
    const int channels    = 2;
    // Semitones to test — use -2 semitones (typical transpose in LibreTracks)
    const double pitch_scale = std::pow(2.0, -2.0 / 12.0);

    // Block sizes to test: common real-time buffer sizes
    const std::vector<int> block_sizes = { 128, 256, 480, 512, 1024, 2048 };

    // Stream counts to test: 1, 4, 8, 12, 16, 24, 32
    const std::vector<int> stream_counts = { 1, 4, 8, 12, 16, 24, 32 };

    const int n_warmup = 200;
    const int n_iter   = 2000;

    log("=============================================================\n");
    log("LibreTracks pitch DSP audio-thread benchmark\n");
    log("Backend : %s\n",
        use_stretcher ? "RubberBandStretcher"
        : use_bungee  ? "Bungee"
                      : "RubberBandLiveShifter");
    log("Rate    : %d Hz  Channels: %d  Pitch: %.4f (%.1f semitones)\n",
        sample_rate, channels, pitch_scale, -2.0);
    log("Warmup  : %d  Iterations: %d per scenario\n", n_warmup, n_iter);
    log("Decision: mean < 50%% budget AND p99 < 80%% budget = OK\n");
    log("=============================================================\n");

    // Determine the fixed block size for LiveShifter (it's constant regardless
    // of our requested block_size — we need to know it before building the table).
    int live_shifter_native_block = 512;
#if HAVE_RUBBERBAND_LIVE_SHIFTER
    if (!use_stretcher) {
        using Opt = RubberBand::RubberBandLiveShifter::Option;
        auto tmp = std::make_unique<RubberBand::RubberBandLiveShifter>(
            static_cast<size_t>(sample_rate), static_cast<size_t>(channels),
            Opt::OptionChannelsTogether);
        live_shifter_native_block = static_cast<int>(tmp->getBlockSize());
        log("LiveShifter native block size: %d frames\n", live_shifter_native_block);
    }
#endif

    std::vector<Result> results;

    for (int n_streams : stream_counts) {
        // LiveShifter: always native block size. Stretcher: test all block sizes.
        // Bungee: grain-based; we still want to measure per-block cost at 480
        // frames (typical 10ms callback at 48 kHz) so use a single representative
        // size matching the audio thread budget.
        std::vector<int> sizes_to_test;
        if (use_stretcher)        sizes_to_test = block_sizes;
        else if (use_bungee)      sizes_to_test = std::vector<int>{ 480 };
        else                      sizes_to_test = std::vector<int>{ live_shifter_native_block };

        if (!use_stretcher && n_streams == stream_counts.front()) {
            print_header();
        }

        for (int bs : sizes_to_test) {
            if (use_stretcher && bs == sizes_to_test.front())
                print_header();

            log("[bench] building %d voices (block=%d)...\n", n_streams, bs);

            // Build N voice instances
            std::vector<std::unique_ptr<IBenchVoice>> voices;
            voices.reserve(static_cast<size_t>(n_streams));
            for (int i = 0; i < n_streams; ++i) {
                log("[bench]   voice %d/%d\n", i + 1, n_streams);
                if (use_stretcher) {
                    voices.push_back(std::make_unique<StretcherVoice>(sample_rate, channels, pitch_scale, bs));
                }
#if HAVE_BUNGEE
                else if (use_bungee) {
                    voices.push_back(std::make_unique<BungeeVoice>(sample_rate, channels, pitch_scale, bs));
                }
#endif
#if HAVE_RUBBERBAND_LIVE_SHIFTER
                else {
                    voices.push_back(std::make_unique<LiveShifterVoice>(sample_rate, channels, pitch_scale));
                }
#else
                else {
                    voices.push_back(std::make_unique<StretcherVoice>(sample_rate, channels, pitch_scale, bs));
                }
#endif
            }

            log("[bench] running %d warmup + %d measured iterations...\n", n_warmup, n_iter);
            const Result r = run_scenario(voices, bs, sample_rate, n_warmup, n_iter);
            log("[bench] done: mean=%.1f us budget=%.0f us\n", r.mean_us, r.budget_us);
            print_row(r);
            results.push_back(r);

            if (use_stretcher) {
                if (bs == sizes_to_test.back()) log("\n");
            }
        }

        if (!use_stretcher) log("\n");
    }

    // ── Bungee-only: construction and recreate-reset micro-benchmarks ────────
    // These measure the control-thread cost of building/swapping voice sets,
    // which is what determines seek latency in a Bungee-based architecture.
#if HAVE_BUNGEE
    if (use_bungee) {
        const int construct_warmup = 5;
        const int construct_iter   = 50;
        const int bs               = 480;
        const double pitch_scale_b = pitch_scale;

        auto build_set = [&](int n) {
            std::vector<std::unique_ptr<BungeeVoice>> set;
            set.reserve(static_cast<size_t>(n));
            for (int i = 0; i < n; ++i)
                set.push_back(std::make_unique<BungeeVoice>(sample_rate, channels, pitch_scale_b, bs));
            return set;
        };

        auto measure = [&](const char* label, auto&& op) {
            log("\n=== %s (block=%d, warmup=%d, iter=%d) ===\n", label, bs, construct_warmup, construct_iter);
            log("%-10s %-12s %-12s %-12s %-12s\n", "streams", "mean_ms", "p95_ms", "p99_ms", "max_ms");
            log("%s\n", std::string(60, '-').c_str());
            for (int n_streams : { 1, 4, 8, 9, 12, 16 }) {
                std::vector<double> timings;
                timings.reserve(static_cast<size_t>(construct_iter));
                for (int i = 0; i < construct_warmup + construct_iter; ++i) {
                    const auto t = op(n_streams);
                    if (i >= construct_warmup) timings.push_back(t);
                }
                std::sort(timings.begin(), timings.end());
                const double mean = std::accumulate(timings.begin(), timings.end(), 0.0)
                                    / static_cast<double>(timings.size());
                const double p95  = timings[static_cast<size_t>(timings.size() * 95 / 100)];
                const double p99  = timings[static_cast<size_t>(timings.size() * 99 / 100)];
                const double mx   = timings.back();
                log("%-10d %-12.2f %-12.2f %-12.2f %-12.2f\n",
                    n_streams, mean, p95, p99, mx);
            }
        };

        // Phase A: cold construction — build N voices from nothing.
        // Returns elapsed time in MILLISECONDS for the full set build.
        measure("Bungee cold construction (N fresh Stretchers + preroll)",
            [&](int n) {
                const auto t0 = Clock::now();
                auto s = build_set(n);
                const auto t1 = Clock::now();
                // Force the set to actually live to t1 (avoid optimizer elision).
                volatile auto x = static_cast<int>(s.size()); (void)x;
                return static_cast<double>(std::chrono::duration_cast<std::chrono::microseconds>(t1 - t0).count()) / 1000.0;
            });

        // Phase B: destroy-and-recreate — the actual seek cost path per Bungee
        // issue #16 (the maintainer recommends recreating Stretchers to reset).
        // We hold a "live" set and time destroy+rebuild of an "incoming" set.
        measure("Bungee reset-by-recreate (destroy N + build N)",
            [&](int n) {
                // Pre-build a set so destruction is part of the measurement.
                auto live = build_set(n);
                const auto t0 = Clock::now();
                live.clear();             // destroy N
                live = build_set(n);      // build N fresh
                const auto t1 = Clock::now();
                volatile auto x = static_cast<int>(live.size()); (void)x;
                return static_cast<double>(std::chrono::duration_cast<std::chrono::microseconds>(t1 - t0).count()) / 1000.0;
            });
    }
#endif

    // ── Summary ──────────────────────────────────────────────────────────────
    log("\n=== SUMMARY ===\n");
    log("For the audio-thread-synchronous architecture to be viable:\n");
    log("  All target stream counts must show OK at the target block size.\n\n");

    // Find the max stream count that still passes for each block size
    if (use_bungee) {
        log("Bungee (grain-based, measured at block=480 frames, 10.0 ms budget at 48kHz):\n");
        int max_ok = 0;
        for (const auto& r : results)
            if (r.fits && r.p99_fits) max_ok = r.n_streams;
        log("  Max streams with OK verdict: %d\n", max_ok);
        if (max_ok >= 16)
            log("  VERDICT: VIABLE - can handle 16+ streams on audio thread\n");
        else if (max_ok >= 8)
            log("  VERDICT: MARGINAL - ok for typical sessions (<=8 streams), risky above\n");
        else
            log("  VERDICT: NOT VIABLE - too slow for multi-stream use on audio thread\n");
    } else if (!use_stretcher) {
        log("LiveShifter (native block=%d frames, %.1f ms budget at 48kHz):\n",
            live_shifter_native_block,
            static_cast<double>(live_shifter_native_block) / sample_rate * 1000.0);
        int max_ok = 0;
        for (const auto& r : results)
            if (r.fits && r.p99_fits) max_ok = r.n_streams;
        log("  Max streams with OK verdict: %d\n", max_ok);
        if (max_ok >= 16)
            log("  VERDICT: VIABLE - can handle 16+ streams on audio thread\n");
        else if (max_ok >= 8)
            log("  VERDICT: MARGINAL - ok for typical sessions (<=8 streams), risky above\n");
        else
            log("  VERDICT: NOT VIABLE - too slow for multi-stream use on audio thread\n");
    } else {
        log("Stretcher results by block size:\n");
        for (int bs : block_sizes) {
            int max_ok = 0;
            for (const auto& r : results)
                if (r.block_size == bs && r.fits && r.p99_fits) max_ok = r.n_streams;
            log("  block=%4d: max OK streams = %d\n", bs, max_ok);
        }
    }

    log("\n");
    return 0;
}
