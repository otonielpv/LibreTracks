#include <doctest/doctest.h>
#include <lt_engine/render/metronome_renderer.h>

#include <algorithm>
#include <cmath>
#include <vector>

using namespace lt;

namespace {

Session make_session(double bpm = 120.0, int beats_per_bar = 4, int beat_unit = 4) {
    Session session;
    session.sample_rate = 48000;
    Song song;
    song.id = "song";
    song.start_frame = 0;
    song.end_frame = 48000 * 16;
    song.bpm = bpm;
    song.beats_per_bar = beats_per_bar;
    song.beat_unit = beat_unit;
    session.songs.push_back(song);
    return session;
}

float peak(const std::vector<float>& samples) {
    float p = 0.0f;
    for (float sample : samples)
        p = std::max(p, std::abs(sample));
    return p;
}

} // namespace

TEST_CASE("metronome disabled produces silence") {
    MetronomeRenderer renderer;
    auto session = make_session();
    std::vector<float> left(512, 0.0f), right(512, 0.0f);
    float* out[] = { left.data(), right.data() };

    renderer.render(out, 2, 512, 48000.0, 0, &session);
    CHECK(peak(left) == doctest::Approx(0.0f));
    CHECK(peak(right) == doctest::Approx(0.0f));
}

TEST_CASE("metronome enabled renders clicks on beats and respects volume zero") {
    MetronomeRenderer renderer;
    auto session = make_session();
    renderer.set_config({true, 1.0f, "master", true});
    std::vector<float> left(2048, 0.0f), right(2048, 0.0f);
    float* out[] = { left.data(), right.data() };

    renderer.render(out, 2, 2048, 48000.0, 0, &session);
    CHECK(peak(left) > 0.01f);
    CHECK(peak(right) > 0.01f);

    std::fill(left.begin(), left.end(), 0.0f);
    std::fill(right.begin(), right.end(), 0.0f);
    renderer.set_config({true, 0.0f, "master", true});
    for (int i = 0; i < 40; ++i) {
        std::fill(left.begin(), left.end(), 0.0f);
        std::fill(right.begin(), right.end(), 0.0f);
        renderer.render(out, 2, 2048, 48000.0, 24000 + i * 2048, &session);
    }
    CHECK(peak(left) == doctest::Approx(0.0f));
}

TEST_CASE("metronome volume above unity boosts click output") {
    MetronomeRenderer normal;
    MetronomeRenderer loud;
    auto session = make_session();
    normal.set_config({true, 1.0f, "master", true});
    loud.set_config({true, 2.5f, "master", true});
    std::vector<float> normal_left(2048, 0.0f), normal_right(2048, 0.0f);
    std::vector<float> loud_left(2048, 0.0f), loud_right(2048, 0.0f);
    float* normal_out[] = { normal_left.data(), normal_right.data() };
    float* loud_out[] = { loud_left.data(), loud_right.data() };

    normal.render(normal_out, 2, 2048, 48000.0, 0, &session);
    loud.render(loud_out, 2, 2048, 48000.0, 0, &session);

    CHECK(loud.diagnostics().volume == doctest::Approx(2.5f));
    CHECK(peak(loud_left) > peak(normal_left) * 2.0f);
}

TEST_CASE("metronome volume clamps to boosted maximum") {
    MetronomeRenderer renderer;
    renderer.set_config({true, 3.0f, "master", true});

    CHECK(renderer.diagnostics().volume == doctest::Approx(2.5f));
}

TEST_CASE("accent click is louder than normal beat") {
    MetronomeRenderer renderer;
    auto session = make_session();
    renderer.set_config({true, 1.0f, "master", true});
    std::vector<float> warmup(4096, 0.0f), warmup_r(4096, 0.0f);
    float* warmup_out[] = { warmup.data(), warmup_r.data() };
    renderer.render(warmup_out, 2, 4096, 48000.0, 48000, &session);

    std::vector<float> accent(4096, 0.0f), normal(4096, 0.0f), scratch(4096, 0.0f);
    float* out1[] = { accent.data(), scratch.data() };
    renderer.render(out1, 2, 4096, 48000.0, 96000, &session);

    std::fill(scratch.begin(), scratch.end(), 0.0f);
    float* out2[] = { normal.data(), scratch.data() };
    renderer.render(out2, 2, 4096, 48000.0, 120000, &session);

    CHECK(peak(accent) > peak(normal));
}

TEST_CASE("BPM and time signature change beat diagnostics") {
    MetronomeRenderer renderer;
    auto session = make_session(120.0, 3, 4);
    renderer.set_config({true, 1.0f, "master", true});
    std::vector<float> left(512, 0.0f), right(512, 0.0f);
    float* out[] = { left.data(), right.data() };

    renderer.render(out, 2, 512, 48000.0, 0, &session);
    auto d = renderer.diagnostics();
    CHECK(d.next_beat_frame == 24000);

    renderer.render(out, 2, 512, 48000.0, 72000, &session);
    d = renderer.diagnostics();
    CHECK(d.current_bar == 2);
    CHECK(d.current_beat == 1);
}

TEST_CASE("tempo marker changes metronome beat spacing at marker frame") {
    MetronomeRenderer renderer;
    auto session = make_session(120.0, 4, 4);
    session.songs[0].tempo_markers.push_back(TempoMarker{"tempo-142", 48000, 142.0});
    renderer.set_config({true, 1.0f, "master", true});
    std::vector<float> left(512, 0.0f), right(512, 0.0f);
    float* out[] = { left.data(), right.data() };

    renderer.render(out, 2, 512, 48000.0, 48000, &session);
    auto d = renderer.diagnostics();
    CHECK(d.last_beat_frame == 48000);
    CHECK(d.next_beat_frame == 68282);
}

TEST_CASE("time signature marker changes accent spacing at marker frame") {
    MetronomeRenderer renderer;
    auto session = make_session(120.0, 4, 4);
    session.songs[0].time_signature_markers.push_back(TimeSignatureMarker{"sig-3-4", 48000, 3, 4});
    renderer.set_config({true, 1.0f, "master", true});
    std::vector<float> left(512, 0.0f), right(512, 0.0f);
    float* out[] = { left.data(), right.data() };

    renderer.render(out, 2, 512, 48000.0, 48000, &session);
    auto d = renderer.diagnostics();
    CHECK(d.current_bar == 1);
    CHECK(d.current_beat == 1);

    renderer.render(out, 2, 512, 48000.0, 120000, &session);
    d = renderer.diagnostics();
    CHECK(d.current_bar == 2);
    CHECK(d.current_beat == 1);
}

TEST_CASE("seek realigns and does not duplicate previous click") {
    MetronomeRenderer renderer;
    auto session = make_session();
    renderer.set_config({true, 1.0f, "master", true});
    std::vector<float> left(2048, 0.0f), right(2048, 0.0f);
    float* out[] = { left.data(), right.data() };

    renderer.render(out, 2, 2048, 48000.0, 0, &session);
    auto first_count = renderer.diagnostics().rendered_clicks_count;
    std::fill(left.begin(), left.end(), 0.0f);
    std::fill(right.begin(), right.end(), 0.0f);
    renderer.render(out, 2, 2048, 48000.0, 24000, &session);
    auto second_count = renderer.diagnostics().rendered_clicks_count;

    CHECK(second_count == first_count + 1);
    CHECK(peak(left) > 0.01f);
}

TEST_CASE("metronome routes to ext zero-based output channel") {
    MetronomeRenderer renderer;
    auto session = make_session();
    renderer.set_config({true, 1.0f, "ext:2", true});
    std::vector<float> ch0(1024, 0.0f), ch1(1024, 0.0f), ch2(1024, 0.0f), ch3(1024, 0.0f);
    float* out[] = { ch0.data(), ch1.data(), ch2.data(), ch3.data() };

    renderer.render(out, 4, 1024, 48000.0, 0, &session);
    CHECK(peak(ch0) == doctest::Approx(0.0f));
    CHECK(peak(ch1) == doctest::Approx(0.0f));
    CHECK(peak(ch2) > 0.01f);
    CHECK(peak(ch3) == doctest::Approx(0.0f));
}

TEST_CASE("metronome toggle is declicked") {
    MetronomeRenderer renderer;
    auto session = make_session();
    renderer.set_config({true, 1.0f, "master", true});
    std::vector<float> left(2048, 0.0f), right(2048, 0.0f);
    float* out[] = { left.data(), right.data() };
    renderer.render(out, 2, 2048, 48000.0, 0, &session);

    renderer.set_config({false, 1.0f, "master", true});
    float last = left.back();
    float max_jump = 0.0f;
    for (int block = 1; block < 12; ++block) {
        std::fill(left.begin(), left.end(), 0.0f);
        std::fill(right.begin(), right.end(), 0.0f);
        renderer.render(out, 2, 2048, 48000.0, block * 2048, &session);
        for (float sample : left) {
            max_jump = std::max(max_jump, std::abs(sample - last));
            last = sample;
        }
    }
    CHECK(max_jump < 0.75f);
    CHECK(renderer.diagnostics().toggle_count == 2);
}
