// BlockCache stores blocks as int16 (half the RAM of float32). These tests pin
// the three promises that makes: 16-bit sources stay bit-exact, deeper sources
// are dithered rather than truncated, and nothing beyond full scale is clipped.

#include <doctest/doctest.h>

#include <lt_engine/sources/block_cache.h>

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <limits>
#include <string>
#include <vector>

#if LT_ENGINE_USE_LIBSNDFILE
#include <sndfile.h>
#endif

using namespace lt;

namespace {

constexpr int kFrames = 4096;

// Reads `frames` stereo frames of block 0 back as interleaved float.
std::vector<float> read_back(BlockCache& cache, const Id& id, int frames, int channels = 2) {
    std::vector<float> l(frames), r(frames);
    float* out[2] = { l.data(), r.data() };
    REQUIRE(cache.read(id, 0, 0, frames, out, channels));
    std::vector<float> interleaved(static_cast<size_t>(frames) * channels);
    for (int f = 0; f < frames; ++f) {
        interleaved[static_cast<size_t>(f) * channels] = l[f];
        if (channels > 1)
            interleaved[static_cast<size_t>(f) * channels + 1] = r[f];
    }
    return interleaved;
}

std::vector<float> sine_block(float amplitude) {
    std::vector<float> s(static_cast<size_t>(kFrames) * 2);
    for (int f = 0; f < kFrames; ++f) {
        s[static_cast<size_t>(f) * 2]     = amplitude * std::sin(f * 0.031f);
        s[static_cast<size_t>(f) * 2 + 1] = amplitude * std::cos(f * 0.017f);
    }
    return s;
}

} // namespace

TEST_CASE("BlockCache int16: fill_pcm16 reads back exactly v / 32768") {
    BlockCache cache(kFrames, 16, 4);
    std::vector<int16_t> pcm(static_cast<size_t>(kFrames) * 2);
    for (size_t i = 0; i < pcm.size(); ++i)
        pcm[i] = static_cast<int16_t>(static_cast<int>(i * 7919) % 65536 - 32768);
    cache.fill_pcm16("src", 0, pcm.data(), 2, kFrames);

    const auto out = read_back(cache, "src", kFrames);
    for (size_t i = 0; i < pcm.size(); ++i)
        REQUIRE(out[i] == static_cast<float>(pcm[i]) / 32768.0f);
}

TEST_CASE("BlockCache int16: a stereo block costs half the bytes of float32") {
    BlockCache cache(kFrames, 16, 4);
    const auto samples = sine_block(0.5f);
    cache.fill("src", 0, samples.data(), 2, kFrames);
    CHECK(cache.diagnostics().bytes_used == static_cast<size_t>(kFrames) * 2 * sizeof(int16_t));
}

TEST_CASE("BlockCache int16: float within full scale is within dither of the source") {
    BlockCache cache(kFrames, 16, 4);
    const auto samples = sine_block(0.9f);
    cache.fill("src", 0, samples.data(), 2, kFrames);
    const auto out = read_back(cache, "src", kFrames);
    // Rounding (0.5 LSB) plus TPDF dither (at most 1 LSB).
    const float tolerance = 1.5f / 32768.0f + 1e-7f;
    for (size_t i = 0; i < samples.size(); ++i)
        REQUIRE(std::fabs(out[i] - samples[i]) <= tolerance);
}

TEST_CASE("BlockCache int16: digital silence stays exactly zero (no dither noise)") {
    BlockCache cache(kFrames, 16, 4);
    std::vector<float> samples(static_cast<size_t>(kFrames) * 2, 0.0f);
    samples[100] = 0.25f;  // not an all-zero block: the zeros around it matter
    cache.fill("src", 0, samples.data(), 2, kFrames);
    const auto out = read_back(cache, "src", kFrames);
    for (size_t i = 0; i < samples.size(); ++i) {
        if (samples[i] == 0.0f)
            REQUIRE(out[i] == 0.0f);
    }
}

TEST_CASE("BlockCache int16: dither keeps sub-LSB detail that rounding would erase") {
    // A constant 0.25 LSB rounds to 0 every time without dither. TPDF dither
    // is unbiased, so the block's mean must stay near 0.25 LSB.
    BlockCache cache(kFrames, 16, 4);
    const float quarter_lsb = 0.25f / 32768.0f;
    std::vector<float> samples(static_cast<size_t>(kFrames) * 2, quarter_lsb);
    cache.fill("src", 0, samples.data(), 2, kFrames);
    const auto out = read_back(cache, "src", kFrames);
    double sum = 0.0;
    for (float v : out) sum += v;
    const double mean_lsb = sum / out.size() * 32768.0;
    CHECK(mean_lsb > 0.15);
    CHECK(mean_lsb < 0.35);
}

TEST_CASE("BlockCache int16: a block over 0 dBFS stays float and is not clipped") {
    BlockCache cache(kFrames, 16, 4);
    auto samples = sine_block(0.5f);
    samples[2000] = 1.6f;
    samples[2001] = -1.25f;
    cache.fill("src", 0, samples.data(), 2, kFrames);
    const auto out = read_back(cache, "src", kFrames);
    for (size_t i = 0; i < samples.size(); ++i)
        REQUIRE(out[i] == samples[i]);
    CHECK(cache.diagnostics().bytes_used == static_cast<size_t>(kFrames) * 2 * sizeof(float));
}

TEST_CASE("BlockCache int16: exactly full scale is still int16") {
    BlockCache cache(kFrames, 16, 4);
    auto samples = sine_block(0.5f);
    samples[10] = 1.0f;
    samples[11] = -1.0f;
    cache.fill("src", 0, samples.data(), 2, kFrames);
    CHECK(cache.diagnostics().bytes_used == static_cast<size_t>(kFrames) * 2 * sizeof(int16_t));
    const auto out = read_back(cache, "src", kFrames);
    CHECK(out[10] == doctest::Approx(1.0f).epsilon(1e-4));
    CHECK(out[11] == -1.0f);
}

TEST_CASE("BlockCache int16: NaN keeps the block float instead of reaching lrintf") {
    BlockCache cache(kFrames, 16, 4);
    auto samples = sine_block(0.5f);
    samples[5] = std::numeric_limits<float>::quiet_NaN();
    cache.fill("src", 0, samples.data(), 2, kFrames);
    CHECK(cache.diagnostics().bytes_used == static_cast<size_t>(kFrames) * 2 * sizeof(float));
}

TEST_CASE("BlockCache int16: refilling a block gives identical samples") {
    BlockCache a(kFrames, 16, 4), b(kFrames, 16, 4);
    const auto samples = sine_block(0.7f);
    a.fill("src", 3, samples.data(), 2, kFrames);
    b.fill("src", 3, samples.data(), 2, kFrames);
    std::vector<float> la(kFrames), ra(kFrames), lb(kFrames), rb(kFrames);
    float* oa[2] = { la.data(), ra.data() };
    float* ob[2] = { lb.data(), rb.data() };
    REQUIRE(a.read("src", 3, 0, kFrames, oa, 2));
    REQUIRE(b.read("src", 3, 0, kFrames, ob, 2));
    CHECK(la == lb);
    CHECK(ra == rb);
}

TEST_CASE("BlockCache int16: mono block still feeds both output channels") {
    BlockCache cache(kFrames, 16, 4);
    std::vector<int16_t> pcm(kFrames);
    for (int f = 0; f < kFrames; ++f) pcm[f] = static_cast<int16_t>(f * 3 - 6000);
    cache.fill_pcm16("mono", 0, pcm.data(), 1, kFrames);
    std::vector<float> l(kFrames), r(kFrames);
    float* out[2] = { l.data(), r.data() };
    REQUIRE(cache.read("mono", 0, 0, kFrames, out, 2));
    for (int f = 0; f < kFrames; ++f) {
        REQUIRE(l[f] == static_cast<float>(pcm[f]) / 32768.0f);
        REQUIRE(r[f] == l[f]);
    }
}

#if LT_ENGINE_USE_LIBSNDFILE
TEST_CASE("BlockCache int16: a 16-bit file read via sf_readf_short matches sf_readf_float") {
    // Before blocks were int16 the fill worker read every file with
    // sf_readf_float. The new path must hand the audio thread the same floats.
    std::vector<int16_t> pcm(static_cast<size_t>(kFrames) * 2);
    for (size_t i = 0; i < pcm.size(); ++i)
        pcm[i] = static_cast<int16_t>(static_cast<int>(i * 104729) % 65536 - 32768);

    const std::string path = "lt_block_cache_int16_probe.wav";
    SF_INFO info{};
    info.samplerate = 48000;
    info.channels = 2;
    info.format = SF_FORMAT_WAV | SF_FORMAT_PCM_16;
    SNDFILE* w = sf_open(path.c_str(), SFM_WRITE, &info);
    REQUIRE(w != nullptr);
    REQUIRE(sf_writef_short(w, pcm.data(), kFrames) == kFrames);
    sf_close(w);

    SF_INFO rinfo{};
    SNDFILE* r = sf_open(path.c_str(), SFM_READ, &rinfo);
    REQUIRE(r != nullptr);
    std::vector<float> as_float(pcm.size());
    REQUIRE(sf_readf_float(r, as_float.data(), kFrames) == kFrames);
    sf_seek(r, 0, SEEK_SET);
    std::vector<int16_t> as_short(pcm.size());
    REQUIRE(sf_readf_short(r, as_short.data(), kFrames) == kFrames);
    sf_close(r);
    std::remove(path.c_str());

    BlockCache cache(kFrames, 16, 4);
    cache.fill_pcm16("src", 0, as_short.data(), 2, kFrames);
    const auto out = read_back(cache, "src", kFrames);
    for (size_t i = 0; i < as_float.size(); ++i)
        REQUIRE(out[i] == as_float[i]);
}
#endif
