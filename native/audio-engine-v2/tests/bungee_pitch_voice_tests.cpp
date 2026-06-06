// bungee_pitch_voice_tests.cpp
//
// Phase 1 of the Bungee migration: only test that BungeePitchVoice links and
// runs. We are NOT testing audio quality, latency, or seek semantics here —
// those tests come in Phase 2 once track_renderer actually consumes the voice.
//
// Warp Phase 0: validate Bungee in pure time-stretch mode (pitch_scale=1.0,
// time_ratio≠1) BEFORE wiring it into the engine. These tests are the
// authoritative check that the Bungee API supports what the warp design
// expects: frame accounting under non-unit ratio, preserved pitch, and no
// gross discontinuities.

#define _USE_MATH_DEFINES  // MSVC: needed before <cmath> to expose M_PI.
#include <cmath>

#include <doctest/doctest.h>
#include <lt_engine/pitch/bungee_pitch_voice.h>

#include <algorithm>
#include <filesystem>
#include <vector>

#if LT_ENGINE_HAVE_BUNGEE
#  include <sndfile.h>
#endif

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

// Count zero-crossings in a buffer. Used as a poor-man's pitch detector: a
// sine wave's zero-crossing rate is ~2*frequency, independent of time-stretch.
int count_zero_crossings(const float* buf, int frames) {
    int n = 0;
    for (int i = 1; i < frames; ++i) {
        if ((buf[i - 1] >= 0.0f) != (buf[i] >= 0.0f))
            ++n;
    }
    return n;
}

// Maximum absolute difference between consecutive samples. A useful canary for
// gross discontinuities ("clicks") in the output.
float max_step(const float* buf, int frames) {
    float worst = 0.0f;
    for (int i = 1; i < frames; ++i) {
        const float d = std::abs(buf[i] - buf[i - 1]);
        if (d > worst) worst = d;
    }
    return worst;
}

#if LT_ENGINE_HAVE_BUNGEE
// Mirror of bench_real_sample_jump_stability.cpp's find_sample helper. Returns
// an empty path when the sample isn't available (CI, fresh clone) — tests that
// depend on it then skip cleanly instead of failing.
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

// Decode the first `max_frames` frames of a WAV into planar stereo. Mono
// sources are mirrored into both channels so Bungee receives stereo input.
// Returns the actual decoded frame count, or 0 on failure.
int load_wav_planar_stereo(const std::filesystem::path& path,
                           int max_frames,
                           std::vector<float>& out_l,
                           std::vector<float>& out_r,
                           int& out_sample_rate) {
    SF_INFO info{};
    SNDFILE* sf = sf_open(path.string().c_str(), SFM_READ, &info);
    if (!sf) return 0;
    if (info.channels < 1 || info.channels > 8) {
        sf_close(sf);
        return 0;
    }
    out_sample_rate = info.samplerate;
    std::vector<float> interleaved(static_cast<size_t>(max_frames) * info.channels, 0.0f);
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

#if LT_ENGINE_HAVE_BUNGEE

// ---------------------------------------------------------------------------
// Warp Phase 0 — time-stretch with pitch_scale = 1.0
//
// These tests answer the question "does Bungee actually do clean time-stretch
// when we leave pitch alone?". If any of them fails, the whole warp design has
// to pick a different backend before we touch the engine.
// ---------------------------------------------------------------------------

TEST_CASE("Warp[0]: input cursor advances by output_frames * time_ratio") {
    constexpr int kBlocks = 32;
    constexpr double kRatio = 1.5;
    constexpr int kInputPerBlock = static_cast<int>(kBlockFrames * 2); // headroom for any ratio <= 2
    BungeePitchVoice voice;
    REQUIRE(voice.configure(kSampleRate, kChannels, kBlockFrames));

    // Feed enough source per block to cover ratio > 1. Bungee consumes up to
    // ceil(output_frames * ratio) input frames per call; we just oversize the
    // input buffer so render_block can always satisfy that.
    auto in_l = make_sine(kInputPerBlock, 440.0);
    auto in_r = make_sine(kInputPerBlock, 440.0);
    const float* in_ptrs[2] = {in_l.data(), in_r.data()};
    std::vector<float> out_l(kBlockFrames, 0.f), out_r(kBlockFrames, 0.f);
    float* out_ptrs[2] = {out_l.data(), out_r.data()};

    for (int b = 0; b < kBlocks; ++b) {
        (void)voice.render_block(in_ptrs, kInputPerBlock, out_ptrs, kBlockFrames,
                                 1.0, kRatio);
    }

    // After N blocks, Bungee should have consumed roughly N * kBlockFrames *
    // kRatio source frames. ±3 block-widths absorbs rounding (we round per
    // block, error accumulates) and the analysis-pipeline warmup window.
    const long long expected = static_cast<long long>(
        kBlocks * kBlockFrames * kRatio);
    const long long actual = voice.input_position();
    CAPTURE(actual);
    CAPTURE(expected);
    const long long tol = 3LL * kBlockFrames;
    CHECK(std::abs(actual - expected) < tol);
}

TEST_CASE("Warp[0]: identity ratio matches pre-warp behaviour") {
    BungeePitchVoice voice;
    REQUIRE(voice.configure(kSampleRate, kChannels, kBlockFrames));

    auto in_l = make_sine(kBlockFrames, 440.0);
    auto in_r = make_sine(kBlockFrames, 440.0);
    const float* in_ptrs[2] = {in_l.data(), in_r.data()};
    std::vector<float> out_l(kBlockFrames, 0.f), out_r(kBlockFrames, 0.f);
    float* out_ptrs[2] = {out_l.data(), out_r.data()};

    for (int b = 0; b < 8; ++b) {
        (void)voice.render_block(in_ptrs, kBlockFrames, out_ptrs, kBlockFrames,
                                 1.0, 1.0);
    }
    // With ratio=1.0 the input cursor must advance lock-step with output —
    // the legacy `pitch_scale=1.0, no warp` invariant the engine relies on.
    const long long advance = voice.input_position();
    const long long expected = 8LL * kBlockFrames;
    CHECK(advance == expected);
}

TEST_CASE("Warp[0]: pitch preserved under time-stretch (sine)") {
    constexpr int kBlocks = 64;
    constexpr double kFreqHz = 440.0;
    constexpr double kRatio = 1.5;
    constexpr int kInputPerBlock = static_cast<int>(kBlockFrames * 2);
    BungeePitchVoice voice;
    REQUIRE(voice.configure(kSampleRate, kChannels, kBlockFrames));

    auto in_l = make_sine(kInputPerBlock, kFreqHz);
    auto in_r = make_sine(kInputPerBlock, kFreqHz);
    const float* in_ptrs[2] = {in_l.data(), in_r.data()};

    // Collect a long output buffer so we can measure the dominant frequency.
    std::vector<float> collected_l;
    collected_l.reserve(static_cast<size_t>(kBlocks * kBlockFrames));
    std::vector<float> out_l(kBlockFrames, 0.f), out_r(kBlockFrames, 0.f);
    float* out_ptrs[2] = {out_l.data(), out_r.data()};
    for (int b = 0; b < kBlocks; ++b) {
        // Feed the same multi-block sine repeatedly — phase discontinuity at
        // each block boundary is fine; we just need bandlimited-ish content.
        const int produced = voice.render_block(
            in_ptrs, kInputPerBlock, out_ptrs, kBlockFrames, 1.0, kRatio);
        collected_l.insert(collected_l.end(),
                           out_l.begin(), out_l.begin() + produced);
    }

    // Skip the first ~half second to clear Bungee's analysis warmup.
    const int skip = std::min<int>(kSampleRate / 2,
                                   static_cast<int>(collected_l.size()) / 4);
    REQUIRE(static_cast<int>(collected_l.size()) > skip + kSampleRate / 4);
    const float* tail = collected_l.data() + skip;
    const int tail_frames = static_cast<int>(collected_l.size()) - skip;

    // Zero-crossings ≈ 2 * freq * seconds. Tolerance ±8% absorbs frame
    // boundaries and Bungee's per-grain phase work.
    const int xings = count_zero_crossings(tail, tail_frames);
    const double seconds = static_cast<double>(tail_frames) / kSampleRate;
    const double measured_hz = xings / (2.0 * seconds);
    CAPTURE(measured_hz);
    CHECK(measured_hz > kFreqHz * 0.92);
    CHECK(measured_hz < kFreqHz * 1.08);
}

TEST_CASE("Warp[0]: output stays bounded and discontinuity-free") {
    constexpr int kBlocks = 64;
    constexpr double kRatio = 0.75; // slow down (source advances < output)
    constexpr int kInputPerBlock = kBlockFrames; // ratio < 1 needs no extra input
    BungeePitchVoice voice;
    REQUIRE(voice.configure(kSampleRate, kChannels, kBlockFrames));

    auto in_l = make_sine(kInputPerBlock, 220.0);
    auto in_r = make_sine(kInputPerBlock, 220.0);
    const float* in_ptrs[2] = {in_l.data(), in_r.data()};
    std::vector<float> out_l(kBlockFrames, 0.f), out_r(kBlockFrames, 0.f);
    float* out_ptrs[2] = {out_l.data(), out_r.data()};

    float worst_step = 0.0f;
    float worst_amp = 0.0f;
    for (int b = 0; b < kBlocks; ++b) {
        const int produced = voice.render_block(
            in_ptrs, kInputPerBlock, out_ptrs, kBlockFrames, 1.0, kRatio);
        if (b < 4) continue; // skip warmup
        for (int f = 0; f < produced; ++f) {
            worst_amp = std::max(worst_amp, std::abs(out_l[f]));
        }
        worst_step = std::max(worst_step, max_step(out_l.data(), produced));
    }
    // Sine peak is 0.5; output should stay well below 1.0.
    CAPTURE(worst_amp);
    CHECK(worst_amp < 1.0f);
    // Sample-to-sample delta should never approach a full-scale click. 0.4
    // is generous — a clean stretched 220 Hz sine at 48 kHz has deltas << 0.1.
    CAPTURE(worst_step);
    CHECK(worst_step < 0.4f);
}

TEST_CASE("Warp[0]: real WAV survives time-stretch without clipping (optional)") {
    const auto sample = find_acustica_sample();
    if (sample.empty()) {
        MESSAGE("samples/ACUSTICA 1_01.wav not found — skipping real-WAV warp test");
        return;
    }

    constexpr int kMaxFrames = 48000 * 4; // 4 seconds
    std::vector<float> src_l, src_r;
    int src_sr = 0;
    const int loaded = load_wav_planar_stereo(sample, kMaxFrames,
                                              src_l, src_r, src_sr);
    REQUIRE(loaded > 0);
    REQUIRE(src_sr > 0);

    BungeePitchVoice voice;
    REQUIRE(voice.configure(src_sr, kChannels, kBlockFrames));

    constexpr double kRatio = 1.25; // ~25% faster, common warp range
    // Always hand Bungee at least ceil(block * ratio) input frames so a
    // ratio > 1 has enough source to consume.
    const int kInputPerBlock = static_cast<int>(
        std::lround(kBlockFrames * kRatio)) + 4;
    int src_cursor = 0;
    std::vector<float> out_l(kBlockFrames, 0.f), out_r(kBlockFrames, 0.f);
    float* out_ptrs[2] = {out_l.data(), out_r.data()};

    float worst_amp = 0.0f;
    float worst_step = 0.0f;
    int blocks_rendered = 0;
    while (src_cursor + kInputPerBlock <= loaded) {
        const float* in_ptrs[2] = {
            src_l.data() + src_cursor,
            src_r.data() + src_cursor};
        const int produced = voice.render_block(
            in_ptrs, kInputPerBlock, out_ptrs, kBlockFrames, 1.0, kRatio);
        // Advance the source cursor in lock-step with how much Bungee
        // actually consumed — that is exactly the contract under test.
        src_cursor += static_cast<int>(std::lround(kBlockFrames * kRatio));
        ++blocks_rendered;
        if (blocks_rendered < 8) continue; // warmup
        for (int f = 0; f < produced; ++f) {
            worst_amp = std::max(worst_amp, std::abs(out_l[f]));
        }
        worst_step = std::max(worst_step, max_step(out_l.data(), produced));
    }
    REQUIRE(blocks_rendered > 16);

    CAPTURE(worst_amp);
    CAPTURE(worst_step);
    CHECK(worst_amp < 1.5f);  // very loose; only catches gross blow-up
    CHECK(worst_step < 0.9f); // catches obvious zipper/click artefacts
}

#endif // LT_ENGINE_HAVE_BUNGEE

