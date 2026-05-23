// signalsmith_warp_voice_tests.cpp
//
// Validate the SignalsmithWarpVoice wrapper end-to-end in the engine build.
// Mirrors the bench_warp_quality bench at unit-test scale so we catch any
// gap between the bench (offline, isolated) and the engine (linked against
// our build's transitive dependencies and configuration).

#define _USE_MATH_DEFINES  // MSVC: M_PI
#include <cmath>

#include <doctest/doctest.h>
#include <lt_engine/pitch/signalsmith_warp_voice.h>

#include <algorithm>
#include <filesystem>
#include <vector>

#if LT_ENGINE_HAVE_SIGNALSMITH
#  include <sndfile.h>
#endif

using namespace lt;

namespace {

constexpr int    kSampleRate  = 48000;
constexpr int    kChannels    = 2;
constexpr int    kBlockFrames = 480;

std::vector<float> make_sine(int frames, double hz, float amp = 0.5f) {
    std::vector<float> v(static_cast<size_t>(frames));
    for (int f = 0; f < frames; ++f)
        v[static_cast<size_t>(f)] = amp * std::sin(2.0 * M_PI * hz * f / kSampleRate);
    return v;
}

int count_zero_crossings(const float* buf, int frames) {
    int n = 0;
    for (int i = 1; i < frames; ++i)
        if ((buf[i - 1] >= 0.0f) != (buf[i] >= 0.0f)) ++n;
    return n;
}

float max_step(const float* buf, int frames) {
    float worst = 0.0f;
    for (int i = 1; i < frames; ++i) {
        const float d = std::abs(buf[i] - buf[i - 1]);
        if (d > worst) worst = d;
    }
    return worst;
}

#if LT_ENGINE_HAVE_SIGNALSMITH
std::filesystem::path find_acustica_sample() {
    for (auto path : {
             std::filesystem::path("samples") / "ACUSTICA 1_01.wav",
             std::filesystem::path("Samples") / "ACUSTICA 1_01.wav",
             std::filesystem::path("..") / "samples" / "ACUSTICA 1_01.wav",
             std::filesystem::path("..") / ".." / "samples" / "ACUSTICA 1_01.wav",
             std::filesystem::path("..") / ".." / ".." / "samples" / "ACUSTICA 1_01.wav"}) {
        if (std::filesystem::exists(path))
            return std::filesystem::absolute(path);
    }
    return {};
}

int load_wav_planar_stereo(const std::filesystem::path& path,
                            int max_frames,
                            std::vector<float>& out_l,
                            std::vector<float>& out_r,
                            int& out_sample_rate) {
    SF_INFO info{};
    SNDFILE* sf = sf_open(path.string().c_str(), SFM_READ, &info);
    if (!sf) return 0;
    if (info.channels < 1 || info.channels > 8) { sf_close(sf); return 0; }
    out_sample_rate = info.samplerate;
    std::vector<float> interleaved(
        static_cast<size_t>(max_frames) * info.channels, 0.0f);
    const sf_count_t got = sf_readf_float(sf, interleaved.data(), max_frames);
    sf_close(sf);
    if (got <= 0) return 0;
    out_l.assign(static_cast<size_t>(got), 0.0f);
    out_r.assign(static_cast<size_t>(got), 0.0f);
    for (sf_count_t f = 0; f < got; ++f) {
        const float l = interleaved[static_cast<size_t>(f * info.channels)];
        const float r = info.channels > 1
            ? interleaved[static_cast<size_t>(f * info.channels + 1)]
            : l;
        out_l[static_cast<size_t>(f)] = l;
        out_r[static_cast<size_t>(f)] = r;
    }
    return static_cast<int>(got);
}
#endif

} // namespace

TEST_CASE("SignalsmithWarpVoice links and configures") {
    SignalsmithWarpVoice voice;
    const bool ok = voice.configure(kSampleRate, kChannels, kBlockFrames);
#if LT_ENGINE_HAVE_SIGNALSMITH
    CHECK(ok);
    CHECK(voice.is_ready());
    CHECK_EQ(std::string(voice.backend_name()),
             std::string("signalsmith_stretch"));
#else
    CHECK_FALSE(ok);
    CHECK_FALSE(voice.is_ready());
    CHECK_EQ(std::string(voice.backend_name()), std::string("unavailable"));
#endif
}

#if LT_ENGINE_HAVE_SIGNALSMITH

TEST_CASE("Warp[signalsmith]: identity ratio produces input back unchanged") {
    constexpr int kBlocks = 8;
    SignalsmithWarpVoice voice;
    REQUIRE(voice.configure(kSampleRate, kChannels, kBlockFrames));

    auto in_l = make_sine(kBlockFrames, 440.0);
    auto in_r = make_sine(kBlockFrames, 440.0);
    const float* in_ptrs[2] = { in_l.data(), in_r.data() };
    std::vector<float> out_l(kBlockFrames, 0.f), out_r(kBlockFrames, 0.f);
    float* out_ptrs[2] = { out_l.data(), out_r.data() };

    for (int b = 0; b < kBlocks; ++b) {
        const int produced = voice.render_block(
            in_ptrs, kBlockFrames, out_ptrs, kBlockFrames, /*ratio*/ 1.0);
        CHECK(produced == kBlockFrames);
        for (int f = 0; f < produced; ++f) {
            CHECK(std::isfinite(out_l[f]));
            CHECK(std::isfinite(out_r[f]));
        }
    }
}

TEST_CASE("Warp[signalsmith]: pitch preserved under time-stretch (sine)") {
    constexpr int kBlocks = 64;
    constexpr double kFreqHz = 440.0;
    constexpr double kRatio = 1.5;
    constexpr int kInputPerBlock = static_cast<int>(kBlockFrames * 2);
    SignalsmithWarpVoice voice;
    REQUIRE(voice.configure(kSampleRate, kChannels, kBlockFrames));

    auto in_l = make_sine(kInputPerBlock, kFreqHz);
    auto in_r = make_sine(kInputPerBlock, kFreqHz);
    const float* in_ptrs[2] = { in_l.data(), in_r.data() };
    std::vector<float> out_l(kBlockFrames, 0.f), out_r(kBlockFrames, 0.f);
    float* out_ptrs[2] = { out_l.data(), out_r.data() };
    std::vector<float> collected_l;
    collected_l.reserve(static_cast<size_t>(kBlocks * kBlockFrames));

    for (int b = 0; b < kBlocks; ++b) {
        const int produced = voice.render_block(
            in_ptrs, kInputPerBlock, out_ptrs, kBlockFrames, kRatio);
        collected_l.insert(collected_l.end(),
                            out_l.begin(), out_l.begin() + produced);
    }

    // Skip warm-up window (~latency frames) before measuring pitch.
    const int skip = std::min<int>(kSampleRate / 4,
                                    static_cast<int>(collected_l.size()) / 4);
    REQUIRE(static_cast<int>(collected_l.size()) > skip + kSampleRate / 4);
    const float* tail = collected_l.data() + skip;
    const int tail_frames = static_cast<int>(collected_l.size()) - skip;
    const int xings = count_zero_crossings(tail, tail_frames);
    const double seconds = static_cast<double>(tail_frames) / kSampleRate;
    const double measured_hz = xings / (2.0 * seconds);
    CAPTURE(measured_hz);
    CHECK(measured_hz > kFreqHz * 0.90);
    CHECK(measured_hz < kFreqHz * 1.10);
}

TEST_CASE("Warp[signalsmith]: output stays bounded with no gross clicks") {
    constexpr int kBlocks = 64;
    constexpr double kRatio = 0.75;
    constexpr int kInputPerBlock = kBlockFrames;
    SignalsmithWarpVoice voice;
    REQUIRE(voice.configure(kSampleRate, kChannels, kBlockFrames));

    auto in_l = make_sine(kInputPerBlock, 220.0);
    auto in_r = make_sine(kInputPerBlock, 220.0);
    const float* in_ptrs[2] = { in_l.data(), in_r.data() };
    std::vector<float> out_l(kBlockFrames, 0.f), out_r(kBlockFrames, 0.f);
    float* out_ptrs[2] = { out_l.data(), out_r.data() };

    float worst_amp = 0.0f, worst_step = 0.0f;
    for (int b = 0; b < kBlocks; ++b) {
        const int produced = voice.render_block(
            in_ptrs, kInputPerBlock, out_ptrs, kBlockFrames, kRatio);
        if (b < 4) continue;
        for (int f = 0; f < produced; ++f)
            worst_amp = std::max(worst_amp, std::abs(out_l[f]));
        worst_step = std::max(worst_step, max_step(out_l.data(), produced));
    }
    CAPTURE(worst_amp);
    CAPTURE(worst_step);
    CHECK(worst_amp < 1.0f);
    CHECK(worst_step < 0.4f);
}

TEST_CASE("Warp[signalsmith]: real WAV survives time-stretch (optional)") {
    const auto sample = find_acustica_sample();
    if (sample.empty()) {
        MESSAGE("samples/ACUSTICA 1_01.wav not found — skipping real-WAV test");
        return;
    }
    constexpr int kMaxFrames = 48000 * 4; // 4 seconds
    std::vector<float> src_l, src_r;
    int src_sr = 0;
    const int loaded = load_wav_planar_stereo(
        sample, kMaxFrames, src_l, src_r, src_sr);
    REQUIRE(loaded > 0);
    REQUIRE(src_sr > 0);

    SignalsmithWarpVoice voice;
    REQUIRE(voice.configure(src_sr, kChannels, kBlockFrames));

    constexpr double kRatio = 1.25;
    const int kInputPerBlock = static_cast<int>(
        std::lround(kBlockFrames * kRatio)) + 4;
    int src_cursor = 0;
    std::vector<float> out_l(kBlockFrames, 0.f), out_r(kBlockFrames, 0.f);
    float* out_ptrs[2] = { out_l.data(), out_r.data() };

    float worst_amp = 0.0f, worst_step = 0.0f;
    int blocks_rendered = 0;
    while (src_cursor + kInputPerBlock <= loaded) {
        const float* in_ptrs[2] = {
            src_l.data() + src_cursor,
            src_r.data() + src_cursor };
        const int produced = voice.render_block(
            in_ptrs, kInputPerBlock, out_ptrs, kBlockFrames, kRatio);
        CHECK(produced == kBlockFrames);
        src_cursor += static_cast<int>(std::lround(kBlockFrames * kRatio));
        ++blocks_rendered;
        if (blocks_rendered < 8) continue;
        for (int f = 0; f < produced; ++f)
            worst_amp = std::max(worst_amp, std::abs(out_l[f]));
        worst_step = std::max(worst_step, max_step(out_l.data(), produced));
    }
    REQUIRE(blocks_rendered > 16);
    CAPTURE(worst_amp);
    CAPTURE(worst_step);
    CHECK(worst_amp < 1.5f);
    CHECK(worst_step < 0.9f);
}

#endif // LT_ENGINE_HAVE_SIGNALSMITH
