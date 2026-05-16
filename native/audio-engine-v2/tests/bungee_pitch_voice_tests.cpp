// bungee_pitch_voice_tests.cpp
//
// Phase 1 of the Bungee migration: only test that BungeePitchVoice links and
// runs. We are NOT testing audio quality, latency, or seek semantics here —
// those tests come in Phase 2 once track_renderer actually consumes the voice.

#define _USE_MATH_DEFINES  // MSVC: needed before <cmath> to expose M_PI.
#include <cmath>

#include <doctest/doctest.h>
#include <lt_engine/pitch/bungee_pitch_voice.h>

#include <vector>

using namespace lt;

namespace {

constexpr int kSampleRate    = 48000;
constexpr int kChannels      = 2;
constexpr int kBlockFrames   = 480;
constexpr double kPitchDown2 = 0.8908987181403393; // 2^(-2/12)

std::vector<float> make_sine(int frames, double hz, float amp = 0.5f) {
    std::vector<float> v(static_cast<size_t>(frames));
    for (int f = 0; f < frames; ++f)
        v[static_cast<size_t>(f)] = amp * std::sin(2.0 * M_PI * hz * f / kSampleRate);
    return v;
}

} // namespace

TEST_CASE("BungeePitchVoice links and configures") {
    BungeePitchVoice voice;
    const bool ok = voice.configure(kSampleRate, kChannels, kBlockFrames);

#if LT_ENGINE_HAVE_BUNGEE
    CHECK(ok);
    CHECK(voice.is_ready());
    CHECK_EQ(std::string(voice.backend_name()), std::string("bungee_basic"));
#else
    // Stub build: configure must fail cleanly and identify itself as unavailable.
    CHECK_FALSE(ok);
    CHECK_FALSE(voice.is_ready());
    CHECK_EQ(std::string(voice.backend_name()), std::string("unavailable"));
#endif
}

TEST_CASE("BungeePitchVoice produces finite output on one block") {
    BungeePitchVoice voice;
    if (!voice.configure(kSampleRate, kChannels, kBlockFrames)) {
        // Stub build path — render_block must not crash and must zero the output.
        std::vector<float> l(kBlockFrames, 1.f), r(kBlockFrames, 1.f);
        float* out[2] = {l.data(), r.data()};
        const float* in[2] = {nullptr, nullptr};
        const int produced = voice.render_block(in, 0, out, kBlockFrames, kPitchDown2);
        CHECK(produced == 0);
        for (int f = 0; f < kBlockFrames; ++f) {
            CHECK(l[f] == 0.f);
            CHECK(r[f] == 0.f);
        }
        return;
    }

    // Active backend path. Feed a 440 Hz stereo sine for one block.
    std::vector<float> in_l = make_sine(kBlockFrames, 440.0);
    std::vector<float> in_r = make_sine(kBlockFrames, 440.0);
    const float* in_ptrs[2] = {in_l.data(), in_r.data()};
    std::vector<float> out_l(kBlockFrames, 0.f);
    std::vector<float> out_r(kBlockFrames, 0.f);
    float* out_ptrs[2] = {out_l.data(), out_r.data()};

    const int produced = voice.render_block(
        in_ptrs, kBlockFrames, out_ptrs, kBlockFrames, kPitchDown2);

    // First call after a fresh Stretcher prerolls and may produce fewer frames
    // than requested (or zero) — that is expected and matches the documented
    // ~200ms startup latency. We only check the output is finite and that the
    // returned frame count is non-negative and within bounds.
    CHECK(produced >= 0);
    CHECK(produced <= kBlockFrames);
    for (int f = 0; f < produced; ++f) {
        CHECK(std::isfinite(out_l[f]));
        CHECK(std::isfinite(out_r[f]));
    }
}
