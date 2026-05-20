#include <lt_engine/render/track_renderer.h>
#include <lt_engine/session/session.h>
#include <lt_engine/sources/source_manager.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <memory>
#include <string>
#include <thread>
#include <vector>

using namespace lt;
using Clock = std::chrono::steady_clock;

namespace {

constexpr int kChannels = 2;
constexpr int kSampleRate = 48000;
constexpr int kBlockFrames = 512;
constexpr int kTrackCount = 12;
constexpr Frame kSourceFrames = kSampleRate * 30;
constexpr int kRenderBlocks = 1200;

std::vector<float> make_source_audio(Frame frames, int index) {
    std::vector<float> samples(static_cast<std::size_t>(frames * kChannels), 0.0f);
    const double f1 = 110.0 + 17.0 * index;
    const double f2 = 330.0 + 11.0 * index;
    for (Frame f = 0; f < frames; ++f) {
        const float l = static_cast<float>(
            0.35 * std::sin(2.0 * 3.141592653589793 * f1 * double(f) / kSampleRate));
        const float r = static_cast<float>(
            0.25 * std::cos(2.0 * 3.141592653589793 * f2 * double(f) / kSampleRate));
        samples[static_cast<std::size_t>(f * kChannels)] = l;
        samples[static_cast<std::size_t>(f * kChannels + 1)] = r;
    }
    return samples;
}

struct BuildResult {
    std::unique_ptr<SourceManager> sources;
    std::vector<Track> tracks;
    double prep_ms = 0.0;
};

BuildResult build_architecture(bool streaming) {
    BuildResult result;
    result.sources = std::make_unique<SourceManager>();
    result.tracks.reserve(kTrackCount);

    const auto t0 = Clock::now();
    for (int i = 0; i < kTrackCount; ++i) {
        const Id source_id = "src-" + std::to_string(i);
        result.sources->register_source(
            source_id,
            streaming ? ("bench-stream-source-" + std::to_string(i) + ".wav") : "");
        auto samples = make_source_audio(kSourceFrames, i);
        auto stored = result.sources->store_decoded_source(
            source_id, std::move(samples), kChannels, kSampleRate, kSourceFrames);
        if (stored.is_err()) {
            std::fprintf(stderr, "store_decoded_source failed: %s\n", stored.error().c_str());
            std::exit(2);
        }

        Track track;
        track.id = "track-" + std::to_string(i);
        track.gain = 1.0f / static_cast<float>(kTrackCount);
        track.clips.push_back(Clip{
            "clip-" + std::to_string(i),
            source_id,
            0,
            0,
            kSourceFrames,
            1.0f});
        result.tracks.push_back(std::move(track));
    }
    const auto t1 = Clock::now();
    result.prep_ms = std::chrono::duration<double, std::milli>(t1 - t0).count();
    return result;
}

bool wait_ready_range(const SourceManager& sources,
                      const std::vector<Track>& tracks,
                      Frame start,
                      int frames) {
    for (const auto& track : tracks) {
        const auto& source_id = track.clips.front().source_id;
        const int first = static_cast<int>(start / kDefaultBlockFrames);
        const int last = static_cast<int>((start + frames - 1) / kDefaultBlockFrames);
        for (int block = first; block <= last; ++block)
            sources.request_block(source_id, block);
    }

    for (int spin = 0; spin < 1000; ++spin) {
        bool ready = true;
        for (const auto& track : tracks) {
            const auto source = sources.get_shared(track.clips.front().source_id);
            ready = ready && source && source->is_range_ready(start, frames);
        }
        if (ready)
            return true;
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    return false;
}

struct RenderResult {
    double render_ms = 0.0;
    double checksum = 0.0;
};

RenderResult render_architecture(const SourceManager& sources,
                                 const std::vector<Track>& tracks,
                                 Frame start_frame,
                                 int blocks) {
    std::vector<TrackRenderer> renderers(static_cast<std::size_t>(tracks.size()));
    for (auto& renderer : renderers)
        renderer.prepare(kBlockFrames);

    std::vector<float> left(kBlockFrames, 0.0f);
    std::vector<float> right(kBlockFrames, 0.0f);
    float* out[2] = {left.data(), right.data()};
    double checksum = 0.0;

    const auto t0 = Clock::now();
    for (int block = 0; block < blocks; ++block) {
        std::fill(left.begin(), left.end(), 0.0f);
        std::fill(right.begin(), right.end(), 0.0f);
        const Frame timeline = start_frame + Frame(block * kBlockFrames);
        for (std::size_t i = 0; i < tracks.size(); ++i) {
            renderers[i].render(
                tracks[i], timeline, kBlockFrames, out, kChannels,
                sources, nullptr, kSampleRate);
        }
        for (int f = 0; f < kBlockFrames; f += 17)
            checksum += left[static_cast<std::size_t>(f)] * 0.73 + right[static_cast<std::size_t>(f)] * 0.37;
    }
    const auto t1 = Clock::now();
    return {std::chrono::duration<double, std::milli>(t1 - t0).count(), checksum};
}

void print_diagnostics(const char* label,
                       const SourceManager& sources,
                       const RenderResult& render,
                       double prep_ms) {
    std::size_t source_ram = 0;
    std::size_t disk_cache = 0;
    for (const auto& d : sources.diagnostics()) {
        source_ram += d.memory_bytes;
        disk_cache += d.disk_cache_bytes;
    }
    const auto cache = sources.cache_diagnostics();
    std::printf(
        "%-10s prep_ms=%8.2f render_ms=%8.2f checksum=%12.6f source_ram_mb=%8.2f cache_ram_mb=%8.2f disk_cache_mb=%8.2f hits=%zu misses=%zu\n",
        label,
        prep_ms,
        render.render_ms,
        render.checksum,
        double(source_ram) / (1024.0 * 1024.0),
        double(cache.bytes_used) / (1024.0 * 1024.0),
        double(disk_cache) / (1024.0 * 1024.0),
        cache.blocks_hit,
        cache.blocks_miss);
}

} // namespace

int main() {
    std::puts("LibreTracks source architecture benchmark");
    std::printf("tracks=%d source_seconds=%lld render_blocks=%d block_frames=%d\n",
                kTrackCount,
                static_cast<long long>(kSourceFrames / kSampleRate),
                kRenderBlocks,
                kBlockFrames);

    auto memory = build_architecture(false);
    auto streaming = build_architecture(true);

    const Frame render_start = kDefaultBlockFrames * 300;
    const int render_frames = kRenderBlocks * kBlockFrames;
    if (!wait_ready_range(*streaming.sources, streaming.tracks, render_start, render_frames)) {
        std::fprintf(stderr, "streaming prebuffer did not become ready\n");
        return 3;
    }

    const auto memory_render = render_architecture(
        *memory.sources, memory.tracks, render_start, kRenderBlocks);
    const auto streaming_render = render_architecture(
        *streaming.sources, streaming.tracks, render_start, kRenderBlocks);

    print_diagnostics("memory", *memory.sources, memory_render, memory.prep_ms);
    print_diagnostics("streaming", *streaming.sources, streaming_render, streaming.prep_ms);

    const double diff = std::abs(memory_render.checksum - streaming_render.checksum);
    std::printf("checksum_abs_diff=%.9f\n", diff);
    return diff < 0.0001 ? 0 : 4;
}
