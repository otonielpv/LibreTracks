// Plan track-eq, paso 01: el módulo DSP `lt::TrackEq`.
//
// Todo se mide en muestras y frames, nunca en milisegundos de reloj.

#include <doctest/doctest.h>

#include <lt_engine/diagnostics/rt_guard.h>
#include <lt_engine/render/track_eq.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>

using namespace lt;

namespace {

constexpr double kPi = 3.14159265358979323846;
constexpr int kRate = 48000;

std::vector<float> sine(std::size_t frames, double hz, double amplitude = 0.25,
                        std::size_t phase_offset = 0) {
    std::vector<float> out(frames);
    for (std::size_t i = 0; i < frames; ++i)
        out[i] = static_cast<float>(
            amplitude * std::sin(2.0 * kPi * hz * static_cast<double>(i + phase_offset) / kRate));
    return out;
}

double rms(const std::vector<float>& signal, std::size_t from, std::size_t to) {
    double sum = 0.0;
    for (std::size_t i = from; i < to; ++i)
        sum += static_cast<double>(signal[i]) * signal[i];
    return std::sqrt(sum / static_cast<double>(to - from));
}

TrackEqParams single_band(EqBandKind kind, float hz, float gain_db, float q, int slope = 12) {
    TrackEqParams params;
    params.enabled = true;
    params.band_count = 1;
    params.bands[0] = TrackEqBandParams{ true, kind, hz, gain_db, q, slope };
    return params;
}

// Ganancia en dB de estado estacionario de `params` sobre un seno de `hz`:
// un segundo de señal, se mide el segundo medio (número entero de ciclos).
double measured_gain_db(const TrackEqParams& params, double hz) {
    TrackEq eq;
    eq.prepare(kRate);
    eq.set_target(params);
    eq.snap_to_target();
    auto left = sine(kRate, hz);
    auto right = left;
    const auto dry = left;
    eq.process(left.data(), right.data(), left.size());
    const double in = rms(dry, kRate / 2, kRate);
    const double out = rms(left, kRate / 2, kRate);
    return 20.0 * std::log10(out / in);
}

float max_step(const std::vector<float>& signal) {
    float worst = 0.0f;
    for (std::size_t i = 1; i < signal.size(); ++i)
        worst = std::max(worst, std::abs(signal[i] - signal[i - 1]));
    return worst;
}

// Procesa `signal` (mono duplicado a estéreo) en bloques de 256, llamando a
// `on_block(block_index)` antes de cada uno para cambiar el objetivo.
template <typename OnBlock>
std::vector<float> process_in_blocks(TrackEq& eq, std::vector<float> signal, OnBlock on_block) {
    std::vector<float> right = signal;
    constexpr std::size_t kBlock = 256;
    for (std::size_t offset = 0, block = 0; offset < signal.size(); offset += kBlock, ++block) {
        on_block(block);
        const std::size_t n = std::min(kBlock, signal.size() - offset);
        eq.process(signal.data() + offset, right.data() + offset, n);
    }
    return signal;
}

} // namespace

TEST_CASE("track eq: peak +6 dB at 1 kHz measures +6 dB on a 1 kHz sine and stays flat away") {
    const auto params = single_band(EqBandKind::Peak, 1000.0f, 6.0f, 1.0f);
    CHECK(std::abs(measured_gain_db(params, 1000.0) - 6.0) < 0.1);
    CHECK(std::abs(measured_gain_db(params, 100.0)) < 0.5);
    CHECK(std::abs(measured_gain_db(params, 10000.0)) < 0.5);
}

TEST_CASE("track eq: shelves, cuts and notch match their nominal response") {
    SUBCASE("low shelf +6 dB at 200 Hz") {
        const auto params = single_band(EqBandKind::LowShelf, 200.0f, 6.0f, kTrackEqDefaultQ);
        CHECK(std::abs(measured_gain_db(params, 30.0) - 6.0) < 0.3);
        CHECK(std::abs(measured_gain_db(params, 200.0) - 3.0) < 0.3);
        CHECK(std::abs(measured_gain_db(params, 5000.0)) < 0.3);
    }
    SUBCASE("high shelf +6 dB at 4 kHz") {
        const auto params = single_band(EqBandKind::HighShelf, 4000.0f, 6.0f, kTrackEqDefaultQ);
        CHECK(std::abs(measured_gain_db(params, 16000.0) - 6.0) < 0.3);
        CHECK(std::abs(measured_gain_db(params, 4000.0) - 3.0) < 0.3);
        CHECK(std::abs(measured_gain_db(params, 200.0)) < 0.3);
    }
    SUBCASE("low cut 12 dB/oct at 200 Hz: -3 dB at cutoff, -12 dB one octave below") {
        const auto params = single_band(EqBandKind::LowCut, 200.0f, 0.0f, kTrackEqDefaultQ, 12);
        CHECK(std::abs(measured_gain_db(params, 200.0) + 3.0) < 0.2);
        CHECK(std::abs(measured_gain_db(params, 100.0) + 12.3) < 0.5);
        CHECK(std::abs(measured_gain_db(params, 5000.0)) < 0.1);
    }
    SUBCASE("low cut 24 dB/oct at 200 Hz: -3 dB at cutoff, -24 dB one octave below") {
        const auto params = single_band(EqBandKind::LowCut, 200.0f, 0.0f, kTrackEqDefaultQ, 24);
        CHECK(std::abs(measured_gain_db(params, 200.0) + 3.0) < 0.2);
        CHECK(std::abs(measured_gain_db(params, 100.0) + 24.1) < 0.6);
        CHECK(std::abs(measured_gain_db(params, 5000.0)) < 0.1);
    }
    SUBCASE("high cut 12 dB/oct at 2 kHz: -3 dB at cutoff, ~-12 dB one octave above") {
        const auto params = single_band(EqBandKind::HighCut, 2000.0f, 0.0f, kTrackEqDefaultQ, 12);
        CHECK(std::abs(measured_gain_db(params, 2000.0) + 3.0) < 0.2);
        CHECK(std::abs(measured_gain_db(params, 4000.0) + 12.3) < 0.8);
        CHECK(std::abs(measured_gain_db(params, 100.0)) < 0.1);
    }
    SUBCASE("high cut 24 dB/oct at 2 kHz") {
        const auto params = single_band(EqBandKind::HighCut, 2000.0f, 0.0f, kTrackEqDefaultQ, 24);
        CHECK(std::abs(measured_gain_db(params, 2000.0) + 3.0) < 0.2);
        CHECK(std::abs(measured_gain_db(params, 4000.0) + 24.1) < 1.2);
    }
    SUBCASE("notch at 1 kHz, Q 2") {
        const auto params = single_band(EqBandKind::Notch, 1000.0f, 0.0f, 2.0f);
        CHECK(measured_gain_db(params, 1000.0) < -30.0);
        CHECK(std::abs(measured_gain_db(params, 100.0)) < 0.5);
        CHECK(std::abs(measured_gain_db(params, 10000.0)) < 0.5);
    }
}

TEST_CASE("track eq: switched off with the fade finished it is bit-identical to the input") {
    TrackEq eq;
    eq.prepare(kRate);
    CHECK(eq.is_transparent());

    auto params = single_band(EqBandKind::Peak, 1000.0f, 12.0f, 1.0f);
    eq.set_target(params);
    auto warm_l = sine(kRate / 4, 1000.0);
    auto warm_r = warm_l;
    eq.process(warm_l.data(), warm_r.data(), warm_l.size());
    CHECK_FALSE(eq.is_transparent());

    params.enabled = false;
    eq.set_target(params);
    // Fundido de 10 ms (480 frames) y un poco más.
    std::vector<float> fade_l = sine(1024, 1000.0), fade_r = fade_l;
    eq.process(fade_l.data(), fade_r.data(), fade_l.size());
    REQUIRE(eq.is_transparent());

    auto left = sine(4096, 523.25, 0.5, 777);
    auto right = sine(4096, 98.0, 0.3, 13);
    const auto dry_l = left;
    const auto dry_r = right;
    eq.process(left.data(), right.data(), left.size());
    CHECK(std::memcmp(left.data(), dry_l.data(), left.size() * sizeof(float)) == 0);
    CHECK(std::memcmp(right.data(), dry_r.data(), right.size() * sizeof(float)) == 0);
}

// Umbral de clic: el mayor salto entre muestras consecutivas del seno de
// entrada multiplicado por la ganancia máxima en juego (+12 dB = x3,98) y un
// 10 % de margen para el sobreimpulso natural del biquad al pasar por la
// frecuencia del seno. Sin suavizado (salto de coeficientes) el pico pasa de
// largo este umbral; comprobado rompiendo el suavizado a propósito.
TEST_CASE("track eq: no clicks when a +12 dB peak jumps from 100 Hz to 10 kHz or bands toggle") {
    const auto input = sine(kRate, 1000.0, 0.2);
    const float threshold = max_step(input) * std::pow(10.0f, 12.0f / 20.0f) * 1.1f;
    CAPTURE(threshold);

    SUBCASE("frequency jump") {
        TrackEq eq;
        eq.prepare(kRate);
        auto params = single_band(EqBandKind::Peak, 100.0f, 12.0f, 1.0f);
        eq.set_target(params);
        eq.snap_to_target();
        const auto out = process_in_blocks(eq, input, [&](std::size_t block) {
            if (block == 40) {
                params.bands[0].frequency_hz = 10000.0f;
                eq.set_target(params);
            }
            if (block == 120) {
                params.bands[0].frequency_hz = 100.0f;
                eq.set_target(params);
            }
        });
        CHECK(max_step(out) <= threshold);
    }
    SUBCASE("frequency jump across the sine (gain on the sine goes x4 to x1)") {
        TrackEq eq;
        eq.prepare(kRate);
        auto params = single_band(EqBandKind::Peak, 1000.0f, 12.0f, 1.0f);
        eq.set_target(params);
        eq.snap_to_target();
        const auto out = process_in_blocks(eq, input, [&](std::size_t block) {
            if (block == 41 || block == 97 || block == 133) {
                params.bands[0].frequency_hz =
                    params.bands[0].frequency_hz == 1000.0f ? 10000.0f : 1000.0f;
                eq.set_target(params);
            }
        });
        CHECK(max_step(out) <= threshold);
    }
    SUBCASE("band on/off") {
        TrackEq eq;
        eq.prepare(kRate);
        auto params = single_band(EqBandKind::Peak, 1000.0f, 12.0f, 1.0f);
        params.bands[0].enabled = false;
        eq.set_target(params);
        eq.snap_to_target();
        const auto out = process_in_blocks(eq, input, [&](std::size_t block) {
            if (block == 41 || block == 125 || block == 152 || block == 170) {
                params.bands[0].enabled = !params.bands[0].enabled;
                eq.set_target(params);
            }
        });
        CHECK(max_step(out) <= threshold);
    }
    SUBCASE("whole eq on/off") {
        TrackEq eq;
        eq.prepare(kRate);
        auto params = single_band(EqBandKind::Peak, 1000.0f, 12.0f, 1.0f);
        const auto out = process_in_blocks(eq, input, [&](std::size_t block) {
            if (block == 10 || block == 80 || block == 150) {
                eq.set_target(params);
                params.enabled = !params.enabled;
            }
        });
        CHECK(max_step(out) <= threshold);
    }
    SUBCASE("band type change while audible") {
        TrackEq eq;
        eq.prepare(kRate);
        auto params = single_band(EqBandKind::Peak, 1000.0f, 12.0f, 1.0f);
        eq.set_target(params);
        eq.snap_to_target();
        const auto out = process_in_blocks(eq, input, [&](std::size_t block) {
            if (block == 40 || block == 77 || block == 121 || block == 163) {
                params.bands[0].kind = params.bands[0].kind == EqBandKind::Peak
                    ? EqBandKind::LowShelf : EqBandKind::Peak;
                eq.set_target(params);
            }
        });
        CHECK(max_step(out) <= threshold);
    }
}

#if defined(LT_ENGINE_TEST_HOOKS)
TEST_CASE("track eq: coefficients are recomputed only while smoothing") {
    TrackEq eq;
    eq.prepare(kRate);
    auto params = single_band(EqBandKind::Peak, 1000.0f, 6.0f, 1.0f);
    eq.set_target(params);
    eq.snap_to_target();
    auto left = sine(kRate, 440.0), right = left;
    eq.process(left.data(), right.data(), left.size());
    const auto settled = eq.coefficient_updates();
    eq.process(left.data(), right.data(), left.size());
    CHECK(eq.coefficient_updates() == settled);

    params.bands[0].gain_db = -6.0f;
    eq.set_target(params);
    eq.process(left.data(), right.data(), left.size());
    const auto after_ramp = eq.coefficient_updates();
    // 480 frames de rampa / 32 por sub-bloque = 15 recálculos.
    CHECK(after_ramp - settled == 15);
    eq.process(left.data(), right.data(), left.size());
    CHECK(eq.coefficient_updates() == after_ramp);
}
#endif

TEST_CASE("track eq: process, set_target and reset do not allocate") {
    TrackEq eq;
    eq.prepare(kRate);
    auto params = default_track_eq_params();
    for (auto& band : params.bands) {
        band.enabled = true;
        band.gain_db = 4.0f;
    }
    auto left = sine(4096, 440.0), right = left;

    lt::rt::reset_violations();
    {
        lt::rt::ScopedRealtimeSection realtime;
        eq.set_target(params);
        eq.process(left.data(), right.data(), left.size());
        params.bands[2].frequency_hz = 800.0f;
        params.bands[0].slope_db_per_octave = 24;
        eq.set_target(params);
        eq.process(left.data(), right.data(), left.size());
        eq.reset();
        params.enabled = false;
        eq.set_target(params);
        eq.process(left.data(), right.data(), left.size());
    }
    const auto found = lt::rt::violations();
    CHECK(found.allocations == 0);
    CHECK(found.deallocations == 0);
}

TEST_CASE("track eq: left and right keep independent filter state") {
    const auto params = single_band(EqBandKind::Peak, 1000.0f, 6.0f, 1.0f);
    TrackEq eq;
    eq.prepare(kRate);
    eq.set_target(params);
    eq.snap_to_target();
    auto left = sine(kRate, 1000.0);
    auto right = sine(kRate, 100.0);
    const auto dry_l = left;
    const auto dry_r = right;
    eq.process(left.data(), right.data(), left.size());
    const double gain_l = 20.0 * std::log10(rms(left, kRate / 2, kRate) / rms(dry_l, kRate / 2, kRate));
    const double gain_r = 20.0 * std::log10(rms(right, kRate / 2, kRate) / rms(dry_r, kRate / 2, kRate));
    CHECK(std::abs(gain_l - 6.0) < 0.1);
    CHECK(std::abs(gain_r) < 0.5);

    // Silencio en un canal sigue siendo silencio aunque el otro suene.
    std::vector<float> loud = sine(2048, 1000.0), quiet(2048, 0.0f);
    eq.reset();
    eq.process(loud.data(), quiet.data(), loud.size());
    CHECK(std::all_of(quiet.begin(), quiet.end(), [](float v) { return v == 0.0f; }));
}

TEST_CASE("track eq: clamp_params trims ranges and leaves a valid eq untouched") {
    const auto valid = default_track_eq_params();
    CHECK(clamp_params(valid) == valid);

    TrackEqParams wild = valid;
    wild.band_count = 9;
    wild.bands[0].frequency_hz = 5.0f;
    wild.bands[1].gain_db = 40.0f;
    wild.bands[2].q = 0.0f;
    wild.bands[3].frequency_hz = std::nanf("");
    wild.bands[4].gain_db = -INFINITY;
    wild.bands[5].slope_db_per_octave = 48;
    const auto clamped = clamp_params(wild);
    CHECK(clamped.band_count == kTrackEqMaxBands);
    CHECK(clamped.bands[0].frequency_hz == kTrackEqMinFrequencyHz);
    CHECK(clamped.bands[1].gain_db == kTrackEqMaxGainDb);
    CHECK(clamped.bands[2].q == kTrackEqMinQ);
    CHECK(clamped.bands[3].frequency_hz == 1000.0f);
    CHECK(clamped.bands[4].gain_db == 0.0f);
    CHECK(clamped.bands[5].slope_db_per_octave == 24);
}

// ---------------------------------------------------------------------------
// Tabla dorada de la respuesta (D11). La UI la compara con su port TS.
// Con LT_WRITE_EQ_GOLDEN=1 se regenera; si no, se comprueba que el C++ sigue
// dando lo mismo que está guardado.
// ---------------------------------------------------------------------------

#if defined(LT_EQ_GOLDEN_PATH)
namespace {

const char* kind_name(EqBandKind kind) {
    switch (kind) {
    case EqBandKind::LowCut: return "lowCut";
    case EqBandKind::LowShelf: return "lowShelf";
    case EqBandKind::Peak: return "peak";
    case EqBandKind::HighShelf: return "highShelf";
    case EqBandKind::HighCut: return "highCut";
    case EqBandKind::Notch: return "notch";
    }
    return "peak";
}

nlohmann::json params_json(const TrackEqParams& params) {
    nlohmann::json bands = nlohmann::json::array();
    for (std::size_t i = 0; i < params.band_count; ++i) {
        const auto& b = params.bands[i];
        bands.push_back({ { "enabled", b.enabled }, { "kind", kind_name(b.kind) },
                          { "frequencyHz", b.frequency_hz }, { "gainDb", b.gain_db },
                          { "q", b.q }, { "slope", b.slope_db_per_octave } });
    }
    return { { "enabled", params.enabled }, { "bands", bands } };
}

std::vector<std::pair<std::string, TrackEqParams>> golden_cases() {
    std::vector<std::pair<std::string, TrackEqParams>> cases;
    cases.emplace_back("peak +6 1k q1", single_band(EqBandKind::Peak, 1000.0f, 6.0f, 1.0f));
    cases.emplace_back("peak -12 150 q4", single_band(EqBandKind::Peak, 150.0f, -12.0f, 4.0f));
    cases.emplace_back("peak +18 15k q0.3", single_band(EqBandKind::Peak, 15000.0f, 18.0f, 0.3f));
    cases.emplace_back("low shelf +6 200", single_band(EqBandKind::LowShelf, 200.0f, 6.0f, 0.71f));
    cases.emplace_back("low shelf -9 80 q2", single_band(EqBandKind::LowShelf, 80.0f, -9.0f, 2.0f));
    cases.emplace_back("high shelf +6 4k", single_band(EqBandKind::HighShelf, 4000.0f, 6.0f, 0.71f));
    cases.emplace_back("high shelf -12 12k q0.5", single_band(EqBandKind::HighShelf, 12000.0f, -12.0f, 0.5f));
    cases.emplace_back("low cut 12 200", single_band(EqBandKind::LowCut, 200.0f, 0.0f, 0.71f, 12));
    cases.emplace_back("low cut 24 60 q1.5", single_band(EqBandKind::LowCut, 60.0f, 0.0f, 1.5f, 24));
    cases.emplace_back("high cut 12 8k", single_band(EqBandKind::HighCut, 8000.0f, 0.0f, 0.71f, 12));
    cases.emplace_back("high cut 24 18k", single_band(EqBandKind::HighCut, 18000.0f, 0.0f, 0.71f, 24));
    cases.emplace_back("notch 1k q2", single_band(EqBandKind::Notch, 1000.0f, 0.0f, 2.0f));
    cases.emplace_back("notch 16k q8", single_band(EqBandKind::Notch, 16000.0f, 0.0f, 8.0f));
    cases.emplace_back("default", default_track_eq_params());
    auto full = default_track_eq_params();
    full.bands[0] = { true, EqBandKind::LowCut, 35.0f, 0.0f, 0.71f, 24 };
    full.bands[1].gain_db = 3.5f;
    full.bands[2] = { true, EqBandKind::Peak, 320.0f, -4.0f, 2.2f, 12 };
    full.bands[3] = { true, EqBandKind::Notch, 2900.0f, 0.0f, 6.0f, 12 };
    full.bands[4].gain_db = 2.0f;
    full.bands[5] = { true, EqBandKind::HighCut, 16000.0f, 0.0f, 0.9f, 12 };
    cases.emplace_back("six bands", full);
    auto bypassed = full;
    bypassed.enabled = false;
    cases.emplace_back("bypassed", bypassed);
    return cases;
}

std::vector<double> golden_frequencies() {
    std::vector<double> freqs;
    constexpr int kPoints = 64;
    for (int i = 0; i < kPoints; ++i)
        freqs.push_back(20.0 * std::pow(1000.0, static_cast<double>(i) / (kPoints - 1)));
    return freqs;
}

nlohmann::json build_golden() {
    nlohmann::json cases = nlohmann::json::array();
    for (const double rate : { 48000.0, 44100.0 }) {
        for (const auto& [name, params] : golden_cases()) {
            nlohmann::json points = nlohmann::json::array();
            for (const double hz : golden_frequencies())
                points.push_back({ hz, track_eq_response_db(params, rate, hz) });
            cases.push_back({ { "name", name }, { "sampleRate", rate },
                              { "eq", params_json(params) }, { "points", points } });
        }
    }
    return { { "generatedBy", "native/audio-engine-v2/tests/test_track_eq.cpp" },
             { "cases", cases } };
}

} // namespace

TEST_CASE("track eq: golden response table matches the C++ design") {
    const auto golden = build_golden();
    const char* write = std::getenv("LT_WRITE_EQ_GOLDEN");
    if (write != nullptr && std::string(write) == "1") {
        std::ofstream out(LT_EQ_GOLDEN_PATH, std::ios::binary);
        REQUIRE(out.good());
        out << golden.dump() << "\n";
        return;
    }
    std::ifstream in(LT_EQ_GOLDEN_PATH, std::ios::binary);
    REQUIRE_MESSAGE(in.good(), "falta la tabla dorada; regenerala con LT_WRITE_EQ_GOLDEN=1");
    const auto stored = nlohmann::json::parse(in);
    REQUIRE(stored["cases"].size() == golden["cases"].size());
    for (std::size_t c = 0; c < golden["cases"].size(); ++c) {
        const auto& expected = golden["cases"][c];
        const auto& actual = stored["cases"][c];
        CAPTURE(expected["name"].get<std::string>());
        REQUIRE(actual["points"].size() == expected["points"].size());
        for (std::size_t p = 0; p < expected["points"].size(); ++p) {
            const double want = expected["points"][p][1].get<double>();
            const double got = actual["points"][p][1].get<double>();
            CHECK(std::abs(want - got) < 1e-6);
        }
    }
}
#endif

// ---------------------------------------------------------------------------
// Plan track-eq-2, paso 04: rampas largas de cue con `set_target(params, frames)`.
// ---------------------------------------------------------------------------

namespace {

// RMS en dB de ventanas consecutivas de `window` frames.
std::vector<double> window_levels_db(const std::vector<float>& signal, std::size_t window) {
    std::vector<double> out;
    for (std::size_t from = 0; from + window <= signal.size(); from += window)
        out.push_back(20.0 * std::log10(std::max(1e-12, rms(signal, from, from + window))));
    return out;
}

std::vector<float> ramp_from_0_to_12_db(std::size_t smoothing_frames) {
    TrackEq eq;
    eq.prepare(kRate);
    auto params = single_band(EqBandKind::Peak, 1000.0f, 0.0f, 1.0f);
    eq.set_target(params);
    eq.snap_to_target();
    // 0,1 s de régimen, 1 s de rampa y 0,4 s de cola.
    const auto input = sine(kRate * 3 / 2, 1000.0, 0.1);
    return process_in_blocks(eq, input, [&](std::size_t block) {
        if (block == 19) {   // 4864 frames (~0,1 s), en un límite de bloque
            params.bands[0].gain_db = 12.0f;
            eq.set_target(params, smoothing_frames);
        }
    });
}

} // namespace

TEST_CASE("track eq ramp C1: a 1 s ramp from 0 to +12 dB is continuous and lands on the target") {
    const std::size_t one_second = smoothing_frames_for(1000.0, kRate);
    REQUIRE(one_second == static_cast<std::size_t>(kRate));
    const auto out = ramp_from_0_to_12_db(one_second);

    // Muestra a muestra: no salta más que una rampa ideal muestreada (el seno
    // a la ganancia final, +12 dB = x3,98), con un 10 % de margen.
    const auto input = sine(kRate * 3 / 2, 1000.0, 0.1);
    const float ideal = max_step(input) * std::pow(10.0f, 12.0f / 20.0f) * 1.1f;
    CHECK(max_step(out) <= ideal);

    // La envolvente sube de forma continua: entre ventanas de 10 ms seguidas
    // no cambia más de 12 dB / 100 ventanas con margen. Un salto de 10 ms (el
    // suavizado corto de siempre) lo sube todo en una o dos ventanas.
    const auto levels = window_levels_db(out, 480);
    double worst = 0.0;
    for (std::size_t i = 11; i < levels.size(); ++i)
        worst = std::max(worst, std::abs(levels[i] - levels[i - 1]));
    CAPTURE(worst);
    CHECK(worst <= 0.25);

    // A mitad de la rampa está a ~+6 dB y al acabar en +12 dB.
    const double base = levels[5];
    CHECK(levels[10 + 50] - base == doctest::Approx(6.0).epsilon(0.08));
    CHECK(levels[10 + 100 + 20] - base == doctest::Approx(12.0).epsilon(0.02));
}

TEST_CASE("track eq ramp C1: the short default smoothing is what the long ramp avoids") {
    // Sabe fallar: con el suavizado por defecto el mismo cambio salta de golpe.
    const auto out = ramp_from_0_to_12_db(0);
    const auto levels = window_levels_db(out, 480);
    double worst = 0.0;
    for (std::size_t i = 11; i < levels.size(); ++i)
        worst = std::max(worst, std::abs(levels[i] - levels[i - 1]));
    CHECK(worst > 3.0);
}
