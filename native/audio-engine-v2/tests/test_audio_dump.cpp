#include <doctest/doctest.h>
#include <lt_engine/diagnostics/audio_dump.h>

using namespace lt;

static AudioDump impulse_dump(Frame onset, int frames = 256) {
    AudioDump dump;
    dump.mode = AudioDumpMode::Reference;
    dump.sample_rate = 48000;
    dump.channel_count = 2;
    dump.samples.assign(static_cast<std::size_t>(frames) * 2, 0.0f);
    dump.samples[static_cast<std::size_t>(onset) * 2] = 1.0f;
    dump.samples[static_cast<std::size_t>(onset) * 2 + 1] = 1.0f;
    return dump;
}

TEST_CASE("audio dump analysis detects onset and silence") {
    AudioDump silent;
    silent.samples.assign(128 * 2, 0.0f);
    silent.channel_count = 2;
    CHECK(analyze_audio_dump(silent).silent);

    auto impulse = impulse_dump(32);
    auto analysis = analyze_audio_dump(impulse);
    CHECK_FALSE(analysis.silent);
    CHECK(analysis.onset_frame == 32);
    CHECK(analysis.peak == doctest::Approx(1.0f));
}

TEST_CASE("audio dump alignment measures onset offset") {
    auto reference = impulse_dump(64);
    auto candidate = impulse_dump(67);
    CHECK(measure_onset_offset(reference, candidate) == 3);
}

TEST_CASE("audio dump detects click spike around discontinuity") {
    AudioDump dump;
    dump.samples.assign(128 * 2, 0.0f);
    dump.channel_count = 2;
    dump.samples[40 * 2] = 1.0f;
    dump.samples[40 * 2 + 1] = 1.0f;
    CHECK(analyze_audio_dump(dump, 1.0e-4f, 0.5f).has_click_spike);
}
