// Redundancy step 08 (docs/plans/redundancy/08-tono-piloto.md): the pilot
// tone a hardware switcher listens to.

#include "test_audio_fixtures.h"

#include <doctest/doctest.h>
#include <lt_engine/render/mixer.h>
#include <lt_engine/render/pilot_tone.h>
#include <lt_engine/scheduler/jump_scheduler.h>
#include <lt_engine/sources/source_manager.h>
#include <lt_engine/transport/transport_clock.h>

#include <chrono>
#include <cmath>
#include <vector>

using namespace lt;

namespace {

constexpr int kRate = 48000;
constexpr double kPi = 3.14159265358979323846;
constexpr float kMinus12Db = 0.25118864f;

struct Bus {
    std::vector<std::vector<float>> channels;
    std::vector<float*> pointers;

    Bus(int count, int frames) : channels(count, std::vector<float>(frames, 0.0f)) {
        for (auto& channel : channels)
            pointers.push_back(channel.data());
    }
};

struct Rig {
    SourceManager sources;
    TransportClock clock{kRate};
    JumpScheduler scheduler;
    std::shared_ptr<Session> session;
    std::unique_ptr<Mixer> mixer;

    explicit Rig(int outputs, Session base = Session{}) {
        base.sample_rate = kRate;
        session = std::make_shared<Session>(base);
        mixer = std::make_unique<Mixer>(session, &sources, &clock, &scheduler);
        std::vector<int> physical;
        for (int channel = 0; channel < outputs; ++channel)
            physical.push_back(channel);
        mixer->set_active_output_channels(physical);
    }

    /// Render `blocks` blocks of `frames`, returning each channel appended.
    std::vector<std::vector<float>> run(int outputs, int blocks, int frames) {
        std::vector<std::vector<float>> recorded(outputs);
        for (int block = 0; block < blocks; ++block) {
            Bus bus(outputs, frames);
            mixer->render(bus.pointers.data(), outputs, frames, kRate);
            for (int channel = 0; channel < outputs; ++channel)
                recorded[channel].insert(recorded[channel].end(), bus.channels[channel].begin(),
                                         bus.channels[channel].end());
        }
        return recorded;
    }
};

float peak(const std::vector<float>& samples, std::size_t from = 0) {
    float value = 0.0f;
    for (std::size_t i = from; i < samples.size(); ++i)
        value = std::max(value, std::abs(samples[i]));
    return value;
}

int zero_crossings(const std::vector<float>& samples, std::size_t from) {
    int count = 0;
    for (std::size_t i = from + 1; i < samples.size(); ++i)
        if ((samples[i - 1] < 0.0f) != (samples[i] < 0.0f))
            ++count;
    return count;
}

Session one_track_session(const std::string& route) {
    Session session;
    session.id = "session";
    session.sources.push_back(Source{"source", ""});
    Song song;
    song.id = "song";
    song.start_frame = 0;
    song.end_frame = kRate * 4;
    Track track;
    track.id = "track";
    track.audio_to = route;
    track.clips.push_back(Clip{"clip", "source", 0, 0, kRate * 4});
    song.tracks.push_back(track);
    session.songs.push_back(song);
    return session;
}

} // namespace

TEST_CASE("pilot tone: channel 8 of 8 carries the sine, channels 1-7 are untouched") {
    Rig with_tone(8);
    Rig without_tone(8);
    with_tone.mixer->pilot_tone().configure(true, 8, 1000.0, -12.0f);
    // Transport stopped: the tone sounds anyway (C3).
    const auto tone = with_tone.run(8, 100, 480);       // 1 s
    const auto plain = without_tone.run(8, 100, 480);
    for (int channel = 0; channel < 7; ++channel)
        CHECK(tone[channel] == plain[channel]);          // bit for bit
    const std::size_t settled = kRate / 50;              // past the 10 ms ramp
    CHECK(peak(tone[7], settled) == doctest::Approx(kMinus12Db).epsilon(0.001));
    // 1 kHz over the settled part: two crossings per period.
    const double seconds = static_cast<double>(tone[7].size() - settled) / kRate;
    CHECK(zero_crossings(tone[7], settled) == doctest::Approx(2000.0 * seconds).epsilon(0.01));
    CHECK(with_tone.mixer->pilot_tone().active());
    CHECK(with_tone.mixer->pilot_tone().error() == PilotTone::Error::None);
}

TEST_CASE("pilot tone: phase continues across blocks of different sizes") {
    PilotTone tone;
    tone.configure(true, 1, 1000.0, -12.0f);
    const int sizes[] = {64, 128, 441, 512};
    std::vector<float> signal;
    const int physical[] = {0};
    for (int round = 0; round < 40; ++round) {
        for (int frames : sizes) {
            std::vector<float> block(static_cast<std::size_t>(frames), 0.0f);
            float* out[] = {block.data()};
            tone.render(out, 1, frames, kRate, physical, 1);
            signal.insert(signal.end(), block.begin(), block.end());
        }
    }
    const double max_slope = 2.0 * kPi * 1000.0 / kRate * kMinus12Db;
    float worst = 0.0f;
    for (std::size_t i = static_cast<std::size_t>(kRate / 50) + 1; i < signal.size(); ++i)
        worst = std::max(worst, std::abs(signal[i] - signal[i - 1]));
    CHECK(worst <= max_slope * 1.0001);
}

TEST_CASE("pilot tone: a stop fade in progress does not touch it") {
    Rig rig(8);
    rig.mixer->pilot_tone().configure(true, 8, 1000.0, -12.0f);
    rig.run(8, 10, 480);
    rig.mixer->start_master_fade(0.0f, 0.5);
    const auto during = rig.run(8, 20, 480);
    CHECK(peak(during[7]) == doctest::Approx(kMinus12Db).epsilon(0.001));
}

TEST_CASE("pilot tone: a track routed to its channel does not reach it while armed") {
    auto add_source = [](Rig& rig) {
        rig.sources.register_source("source", "");
        REQUIRE(rig.sources.store_decoded_source("source",
            test::make_stereo_sine(kRate * 4, 220.0, 0.5f), 2, test::kFixtureSampleRate,
            kRate * 4).is_ok());
    };
    // The track plays on outputs 7-8 (0-based 6-7).
    Rig armed(8, one_track_session("ext:6-7"));
    Rig plain(8, one_track_session("ext:6-7"));
    add_source(armed);
    add_source(plain);
    for (Rig* rig : {&armed, &plain}) {
        rig->clock.play();
        rig->clock.clear_pending_start();
    }
    armed.mixer->pilot_tone().configure(true, 8, 1000.0, -12.0f);
    const auto with_tone = armed.run(8, 50, 480);
    const auto without = plain.run(8, 50, 480);
    CHECK(peak(without[7]) > 0.05f);  // the track does reach output 8 normally

    // Output 8 armed = exactly a pure pilot tone, nothing of the track.
    PilotTone reference;
    reference.configure(true, 1, 1000.0, -12.0f);
    std::vector<float> pure;
    const int physical[] = {0};
    for (int block = 0; block < 50; ++block) {
        std::vector<float> chunk(480, 0.0f);
        float* out[] = {chunk.data()};
        reference.render(out, 1, 480, kRate, physical, 1);
        pure.insert(pure.end(), chunk.begin(), chunk.end());
    }
    CHECK(with_tone[7] == pure);
    CHECK(with_tone[6] == without[6]);  // the other side of the pair is the mix
}

TEST_CASE("pilot tone: a device without that output disables it and says so") {
    Rig rig(2);  // stereo interface, tone asked on output 8
    rig.mixer->pilot_tone().configure(true, 8, 1000.0, -12.0f);
    const auto out = rig.run(2, 10, 480);
    CHECK(peak(out[0]) == 0.0f);
    CHECK(peak(out[1]) == 0.0f);
    CHECK_FALSE(rig.mixer->pilot_tone().active());
    CHECK(rig.mixer->pilot_tone().error() == PilotTone::Error::ChannelMissing);
}

TEST_CASE("pilot tone: disarming fades out over 10 ms without a step") {
    PilotTone tone;
    tone.configure(true, 1, 1000.0, -12.0f);
    const int physical[] = {0};
    std::vector<float> block(4800, 0.0f);
    float* out[] = {block.data()};
    tone.render(out, 1, 4800, kRate, physical, 1);
    tone.configure(false, 1, 1000.0, -12.0f);
    std::vector<float> tail(4800, 0.0f);
    float* tail_out[] = {tail.data()};
    tone.render(tail_out, 1, 4800, kRate, physical, 1);
    // Gone after 10 ms (480 frames) ...
    CHECK(peak(tail, 481) == 0.0f);
    // ... gradually: no jump bigger than the sine's own slope plus one ramp step.
    const double limit = 2.0 * kPi * 1000.0 / kRate * kMinus12Db + kMinus12Db / 480.0;
    float worst = std::abs(tail[0] - block.back());
    for (std::size_t i = 1; i < tail.size(); ++i)
        worst = std::max(worst, std::abs(tail[i] - tail[i - 1]));
    CHECK(worst <= limit * 1.0001);
    // Something was still sounding in the first milliseconds.
    CHECK(peak(std::vector<float>(tail.begin(), tail.begin() + 240)) > 0.05f);
    CHECK_FALSE(tone.active());
}

TEST_CASE("pilot tone: cost per block is negligible") {
    PilotTone tone;
    tone.configure(true, 8, 1000.0, -12.0f);
    int physical[8];
    for (int i = 0; i < 8; ++i)
        physical[i] = i;
    Bus bus(8, 256);
    const int blocks = 20000;
    const auto start = std::chrono::steady_clock::now();
    for (int block = 0; block < blocks; ++block)
        tone.render(bus.pointers.data(), 8, 256, kRate, physical, 8);
    const double ns = std::chrono::duration<double, std::nano>(
        std::chrono::steady_clock::now() - start).count() / blocks;
    MESSAGE("pilot tone render: " << ns << " ns per 256-frame block (budget 5333 us)");
    CHECK(ns < 50000.0);  // < 1 % of a 5.3 ms block, with a wide margin
}
