// ¿Escala de verdad repartir las voces Bungee entre hilos, con las reglas de
// tiempo real (prioridad Pro Audio, barrera de espera activa, sin locks)?
// Mide lo que paga el hilo del callback: el tiempo de pared del bloque entero.
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <memory>
#include <thread>
#include <vector>
#include <span>
#include <bungee/Bungee.h>
#include <bungee/Stream.h>
#if defined(_WIN32)
#  define NOMINMAX
#  define WIN32_LEAN_AND_MEAN
#  include <windows.h>
#  include <avrt.h>
#endif

using Edition   = Bungee::Basic;
using Stretcher = Bungee::Stretcher<Edition>;
using Stream    = Bungee::Stream<Edition>;

static void promote_pro_audio() {
#if defined(_WIN32)
    DWORD idx = 0;
    HANDLE h = AvSetMmThreadCharacteristicsA("Pro Audio", &idx);
    if (h) AvSetMmThreadPriority(h, AVRT_PRIORITY_CRITICAL);
    else   SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL);
#endif
}

struct Voice {
    std::unique_ptr<Stretcher> st;
    std::unique_ptr<Stream>    stream;
    std::vector<std::vector<float>> out_planes;
    std::vector<float*> out_ptrs;
    Voice(int sr, int ch, int max_in) {
        Bungee::SampleRates rates{sr, sr};
        st = std::make_unique<Stretcher>(rates, ch, -1);
        stream = std::make_unique<Stream>(*st, max_in, ch);
        out_planes.assign(ch, std::vector<float>(max_in, 0.f));
        out_ptrs.assign(ch, nullptr);
        for (int c = 0; c < ch; ++c) out_ptrs[c] = out_planes[c].data();
    }
};

// Estado compartido de la barrera. Una generación por bloque; los trabajadores
// giran en espera activa (nada de condition_variable: despertar al SO cuesta
// decenas de us y el presupuesto son milisegundos).
struct Pool {
    std::atomic<uint64_t> generation{0};
    std::atomic<int>      next_voice{0};
    std::atomic<int>      done{0};
    std::atomic<bool>     quit{false};
    std::vector<std::unique_ptr<Voice>>* voices = nullptr;
    const float* const*   in_ptrs = nullptr;
    int feed = 0, block = 0;
    double pitch = 1.0;

    void run_voices() {
        const int n = (int)voices->size();
        for (;;) {
            int i = next_voice.fetch_add(1, std::memory_order_relaxed);
            if (i >= n) break;
            auto& v = (*voices)[i];
            v->stream->process(in_ptrs, v->out_ptrs.data(), feed, (double)block, pitch);
            done.fetch_add(1, std::memory_order_release);
        }
    }
};

int main(int argc, char** argv) {
    const int sr     = argc > 1 ? std::atoi(argv[1]) : 48000;
    const int block  = argc > 2 ? std::atoi(argv[2]) : 512;
    const int ch     = 2;
    const int max_in = block * 4;
    const int blocks = 600;
    const double budget_us = block * 1e6 / sr;

    promote_pro_audio();

    std::vector<std::vector<float>> src(ch, std::vector<float>(max_in * 2));
    for (int c = 0; c < ch; ++c)
        for (size_t i = 0; i < src[c].size(); ++i)
            src[c][i] = 0.3f * std::sin(0.013f * i) + 0.2f * std::sin(0.31f * i + c);
    const float* in_ptrs[2] = { src[0].data(), src[1].data() };

    std::printf("sr=%d block=%d  presupuesto=%.3f ms  hw_threads=%u\n\n",
                sr, block, budget_us / 1000.0, std::thread::hardware_concurrency());

    for (int n : {8, 16, 24, 32}) {
        std::printf("--- %d voces ---\n", n);
        std::printf("%8s %11s %11s %11s %10s %9s\n",
                    "hilos", "avg us", "p95 us", "max us", "% presup", "speedup");
        double base_avg = 0.0;
        for (int T : {1, 2, 4, 6, 8}) {
            std::vector<std::unique_ptr<Voice>> voices;
            for (int i = 0; i < n; ++i) voices.push_back(std::make_unique<Voice>(sr, ch, max_in));

            Pool pool;
            pool.voices = &voices; pool.in_ptrs = in_ptrs; pool.block = block;
            std::vector<std::thread> workers;
            for (int t = 1; t < T; ++t) {
                workers.emplace_back([&pool] {
                    promote_pro_audio();
                    uint64_t seen = 0;
                    for (;;) {
                        while (pool.generation.load(std::memory_order_acquire) == seen) {
                            if (pool.quit.load(std::memory_order_relaxed)) return;
                            #if defined(_WIN32)
                            YieldProcessor();
                            #endif
                        }
                        seen = pool.generation.load(std::memory_order_acquire);
                        pool.run_voices();
                    }
                });
            }

            std::vector<double> samples; samples.reserve(blocks);
            double fed = 0.0, need = 0.0;
            for (int b = 0; b < blocks; ++b) {
                need += block;
                int feed = std::min((int)std::llround(need - fed), max_in);
                if (feed < 0) feed = 0;
                fed += feed;
                pool.feed = feed;
                pool.next_voice.store(0, std::memory_order_relaxed);
                pool.done.store(0, std::memory_order_relaxed);

                auto t0 = std::chrono::steady_clock::now();
                pool.generation.fetch_add(1, std::memory_order_release); // suelta a los obreros
                pool.run_voices();                                       // el conductor tambien curra
                while (pool.done.load(std::memory_order_acquire) < n) {  // junta
                    #if defined(_WIN32)
                    YieldProcessor();
                    #endif
                }
                auto t1 = std::chrono::steady_clock::now();
                const double us = std::chrono::duration<double, std::micro>(t1 - t0).count();
                if (b >= 150) samples.push_back(us);
            }

            pool.quit.store(true, std::memory_order_relaxed);
            pool.generation.fetch_add(1, std::memory_order_release);
            for (auto& w : workers) w.join();

            std::sort(samples.begin(), samples.end());
            double sum = 0; for (double s : samples) sum += s;
            const double avg = sum / samples.size();
            if (T == 1) base_avg = avg;
            std::printf("%8d %11.1f %11.1f %11.1f %9.1f%% %8.2fx\n",
                        T, avg, samples[(size_t)(samples.size() * 0.95)], samples.back(),
                        100.0 * avg / budget_us, base_avg / avg);
        }
        std::printf("\n");
    }
    return 0;
}
