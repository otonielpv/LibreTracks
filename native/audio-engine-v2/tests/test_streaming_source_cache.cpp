#include <doctest/doctest.h>

#include <lt_engine/render/track_renderer.h>
#include <lt_engine/session/session.h>
#include <lt_engine/sources/source_manager.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <thread>
#include <vector>

using namespace lt;

namespace {

std::vector<float> make_reference_audio(Frame frames, int channels) {
    std::vector<float> samples(static_cast<std::size_t>(frames * channels), 0.0f);
    for (Frame f = 0; f < frames; ++f) {
        const float a = std::sin(static_cast<float>(f) * 0.0137f) * 0.42f;
        const float b = std::cos(static_cast<float>(f) * 0.0211f) * 0.31f;
        samples[static_cast<std::size_t>(f * channels)] = a;
        if (channels > 1)
            samples[static_cast<std::size_t>(f * channels + 1)] = b;
    }
    return samples;
}

void require_ready_range(const SourceManager& manager,
                         const Id& source_id,
                         Frame start,
                         int frames) {
    const auto source = manager.get_shared(source_id);
    REQUIRE(static_cast<bool>(source));
    const int first = static_cast<int>(start / kDefaultBlockFrames);
    const int last = static_cast<int>((start + frames - 1) / kDefaultBlockFrames);
    for (int block = first; block <= last; ++block)
        manager.request_block(source_id, block);

    for (int spin = 0; spin < 200 && !source->is_range_ready(start, frames); ++spin)
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    REQUIRE(source->is_range_ready(start, frames));
}

std::vector<float> read_planar(const DecodedSource& source, Frame start, int frames) {
    std::vector<float> left(static_cast<std::size_t>(frames), 0.0f);
    std::vector<float> right(static_cast<std::size_t>(frames), 0.0f);
    float* out[2] = {left.data(), right.data()};
    REQUIRE(source.read(start, frames, out, 2) == frames);

    std::vector<float> interleaved;
    interleaved.reserve(static_cast<std::size_t>(frames) * 2);
    for (int f = 0; f < frames; ++f) {
        interleaved.push_back(left[static_cast<std::size_t>(f)]);
        interleaved.push_back(right[static_cast<std::size_t>(f)]);
    }
    return interleaved;
}

std::vector<float> render_track_block(const SourceManager& manager,
                                      const Id& source_id,
                                      Frame timeline_frame,
                                      int frames) {
    Track track;
    track.id = "track";
    track.gain = 0.75f;
    track.clips.push_back(Clip{"clip", source_id, 0, 0, kDefaultBlockFrames * 4, 0.8f});

    TrackRenderer renderer;
    renderer.prepare(frames);
    std::vector<float> left(static_cast<std::size_t>(frames), 0.0f);
    std::vector<float> right(static_cast<std::size_t>(frames), 0.0f);
    float* out[2] = {left.data(), right.data()};
    renderer.render(track, timeline_frame, frames, out, 2, manager, nullptr, 48000);

    std::vector<float> interleaved;
    interleaved.reserve(static_cast<std::size_t>(frames) * 2);
    for (int f = 0; f < frames; ++f) {
        interleaved.push_back(left[static_cast<std::size_t>(f)]);
        interleaved.push_back(right[static_cast<std::size_t>(f)]);
    }
    return interleaved;
}

void require_audio_equal(const std::vector<float>& a, const std::vector<float>& b) {
    REQUIRE(a.size() == b.size());
    for (std::size_t i = 0; i < a.size(); ++i)
        CHECK(a[i] == doctest::Approx(b[i]).epsilon(0.000001));
}

} // namespace

TEST_CASE("SourceManager stores prepared sources in disk-backed block cache") {
    SourceManager manager;
    const Id source_id = "streaming-cache-source";
    manager.register_source(source_id, "streaming-cache-source.wav");

    constexpr int kChannels = 2;
    constexpr int kSampleRate = 48000;
    constexpr Frame kFrames = kDefaultBlockFrames * 2;
    std::vector<float> samples(static_cast<std::size_t>(kFrames * kChannels), 0.0f);
    for (Frame f = 0; f < kFrames; ++f) {
        samples[static_cast<std::size_t>(f * kChannels)] = static_cast<float>(f) / 1000.0f;
        samples[static_cast<std::size_t>(f * kChannels + 1)] = -static_cast<float>(f) / 1000.0f;
    }

    REQUIRE(manager.store_decoded_source(source_id, std::move(samples),
                                         kChannels, kSampleRate, kFrames).is_ok());

    auto source = manager.get_shared(source_id);
    REQUIRE(static_cast<bool>(source));
    CHECK(source->is_streaming());
    CHECK(source->memory_bytes() == 0);
    CHECK(source->is_range_ready(0, 512));

    std::vector<float> left(512, 0.0f);
    std::vector<float> right(512, 0.0f);
    float* out[2] = {left.data(), right.data()};
    CHECK(source->read(128, 512, out, 2) == 512);
    CHECK(left[0] == doctest::Approx(0.128f));
    CHECK(right[0] == doctest::Approx(-0.128f));

    const auto diagnostics = manager.diagnostics();
    REQUIRE(diagnostics.size() == 1);
    CHECK(diagnostics[0].storage_kind == "disk_cache");
    CHECK(diagnostics[0].memory_bytes == 0);
    CHECK(diagnostics[0].disk_cache_bytes > 0);
}

TEST_CASE("Streaming source reads match legacy in-memory source across block boundaries") {
    constexpr int kChannels = 2;
    constexpr int kSampleRate = 48000;
    constexpr Frame kFrames = kDefaultBlockFrames * 4 + 777;
    auto samples = make_reference_audio(kFrames, kChannels);

    SourceManager memory_manager;
    SourceManager streaming_manager;
    memory_manager.register_source("src", "");
    streaming_manager.register_source("src", "streaming-equivalence.wav");

    REQUIRE(memory_manager.store_decoded_source(
        "src", samples, kChannels, kSampleRate, kFrames).is_ok());
    REQUIRE(streaming_manager.store_decoded_source(
        "src", samples, kChannels, kSampleRate, kFrames).is_ok());

    const auto memory_source = memory_manager.get_shared("src");
    const auto streaming_source = streaming_manager.get_shared("src");
    REQUIRE(static_cast<bool>(memory_source));
    REQUIRE(static_cast<bool>(streaming_source));
    REQUIRE_FALSE(memory_source->is_streaming());
    REQUIRE(streaming_source->is_streaming());

    for (Frame start : {Frame{0}, Frame{kDefaultBlockFrames - 37},
                        Frame{kDefaultBlockFrames + 19},
                        Frame{kDefaultBlockFrames * 3 - 128}}) {
        constexpr int kReadFrames = 512;
        require_ready_range(streaming_manager, "src", start, kReadFrames);
        require_audio_equal(read_planar(*memory_source, start, kReadFrames),
                            read_planar(*streaming_source, start, kReadFrames));
    }
}

TEST_CASE("TrackRenderer output is identical for memory and streaming source paths") {
    constexpr int kChannels = 2;
    constexpr int kSampleRate = 48000;
    constexpr Frame kFrames = kDefaultBlockFrames * 4;
    auto samples = make_reference_audio(kFrames, kChannels);

    SourceManager memory_manager;
    SourceManager streaming_manager;
    memory_manager.register_source("src", "");
    streaming_manager.register_source("src", "streaming-render-equivalence.wav");

    REQUIRE(memory_manager.store_decoded_source(
        "src", samples, kChannels, kSampleRate, kFrames).is_ok());
    REQUIRE(streaming_manager.store_decoded_source(
        "src", samples, kChannels, kSampleRate, kFrames).is_ok());

    for (Frame start : {Frame{0}, Frame{640}, Frame{kDefaultBlockFrames - 240},
                        Frame{kDefaultBlockFrames * 2 + 123}}) {
        constexpr int kRenderFrames = 960;
        require_ready_range(streaming_manager, "src", start, kRenderFrames);
        require_audio_equal(render_track_block(memory_manager, "src", start, kRenderFrames),
                            render_track_block(streaming_manager, "src", start, kRenderFrames));
    }
}
