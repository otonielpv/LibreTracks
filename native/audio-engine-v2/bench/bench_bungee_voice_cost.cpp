// Micro-bench: coste real de N voces Bungee por bloque de audio,
// replicando el patron de alimentacion de TrackRenderer::render_path_stretched.
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <memory>
#include <vector>
#include <span>
#include <bungee/Bungee.h>
#include <bungee/Stream.h>

using Edition   = Bungee::Basic;
using Stretcher = Bungee::Stretcher<Edition>;
using Stream    = Bungee::Stream<Edition>;

struct Voice {
    std::unique_ptr<Stretcher> st;
    std::unique_ptr<Stream>    stream;
    std::vector<std::vector<float>> out_planes;
    std::vector<float*> out_ptrs;
    Voice(int sr, int ch, int max_in, int hop) {
        Bungee::SampleRates rates{sr, sr};
        st = std::make_unique<Stretcher>(rates, ch, hop);
        stream = std::make_unique<Stream>(*st, max_in, ch);
        out_planes.assign(ch, std::vector<float>(max_in, 0.f));
        out_ptrs.assign(ch, nullptr);
        for (int c = 0; c < ch; ++c) out_ptrs[c] = out_planes[c].data();
    }
};

int main(int argc, char** argv) {
    const int sr        = argc > 1 ? std::atoi(argv[1]) : 48000;
    const int block     = argc > 2 ? std::atoi(argv[2]) : 512;
    const int hop       = argc > 3 ? std::atoi(argv[3]) : -1;
    const double ratio  = argc > 4 ? std::atof(argv[4]) : 1.0;
    const double pitch  = argc > 5 ? std::atof(argv[5]) : 1.0;
    const int    ch     = 2;
    const int    max_in = block * 4;
    const int    blocks = 800;

    // Fuente sintetica: ruido rosa-ish, suficiente para que el analisis trabaje.
    std::vector<std::vector<float>> src(ch, std::vector<float>(max_in * 2));
    for (int c = 0; c < ch; ++c)
        for (size_t i = 0; i < src[c].size(); ++i)
            src[c][i] = 0.3f * std::sin(0.013f * i) + 0.2f * std::sin(0.31f * i + c);
    const float* in_ptrs[2] = { src[0].data(), src[1].data() };

    std::printf("sr=%d block=%d hop=%d ratio=%.4f pitch=%.4f  budget=%.3f ms\n",
                sr, block, hop, ratio, pitch, block * 1000.0 / sr);
    std::printf("%6s %12s %12s %12s %10s\n",
                "voces", "avg us/blk", "p95 us/blk", "max us/blk", "% budget");

    const double budget_us = block * 1e6 / sr;

    for (int n : {1, 2, 4, 8, 12, 16, 20, 24, 32}) {
        std::vector<std::unique_ptr<Voice>> voices;
        for (int i = 0; i < n; ++i) voices.push_back(std::make_unique<Voice>(sr, ch, max_in, hop));

        std::vector<double> samples;
        samples.reserve(blocks);
        double fed = 0.0;   // frames de fuente ya alimentados (contiguidad)
        double need = 0.0;  // frames requeridos por el timeline
        for (int b = 0; b < blocks; ++b) {
            need += block * ratio;
            int feed = (int)std::llround(need - fed);
            feed = std::min(feed, max_in);
            if (feed < 0) feed = 0;
            fed += feed;
            auto t0 = std::chrono::steady_clock::now();
            for (auto& v : voices)
                v->stream->process(in_ptrs, v->out_ptrs.data(), feed, (double)block, pitch);
            auto t1 = std::chrono::steady_clock::now();
            const double us = std::chrono::duration<double, std::micro>(t1 - t0).count();
            if (b >= 200) samples.push_back(us); // descarta el calentamiento
        }
        std::sort(samples.begin(), samples.end());
        double sum = 0; for (double s : samples) sum += s;
        const double avg = sum / samples.size();
        const double p95 = samples[(size_t)(samples.size() * 0.95)];
        const double mx  = samples.back();
        std::printf("%6d %12.1f %12.1f %12.1f %9.1f%%\n",
                    n, avg, p95, mx, 100.0 * avg / budget_us);
    }
    return 0;
}
