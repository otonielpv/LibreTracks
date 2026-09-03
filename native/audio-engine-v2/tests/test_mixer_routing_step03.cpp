#include "test_audio_fixtures.h"

#include <doctest/doctest.h>
#include <lt_engine/diagnostics/rt_guard.h>
#include <lt_engine/render/mixer.h>
#include <lt_engine/scheduler/jump_scheduler.h>
#include <lt_engine/sources/source_manager.h>
#include <lt_engine/transport/transport_clock.h>

#include <algorithm>
#include <cctype>
#include <cmath>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

using namespace lt;

namespace {
constexpr int kBlock = 512;
constexpr int kChannels = 8;

// Deliberately separate from mixer.cpp: this is the legacy oracle used by the
// tests, not a call into the implementation under test.
std::pair<int, int> legacy_route(std::string_view route, int channels,
                                 const std::vector<int>& active) {
    while (!route.empty() && std::isspace(static_cast<unsigned char>(route.front()))) route.remove_prefix(1);
    while (!route.empty() && std::isspace(static_cast<unsigned char>(route.back()))) route.remove_suffix(1);
    auto ieq = [](std::string_view a, std::string_view b) {
        if (a.size() != b.size()) return false;
        for (std::size_t i = 0; i < a.size(); ++i)
            if (std::tolower(static_cast<unsigned char>(a[i])) != b[i]) return false;
        return true;
    };
    auto pair_at = [channels](int n) { return std::pair<int, int>{std::clamp(n, 0, channels - 1),
                                                                    std::clamp(n + 1, 0, channels - 1)}; };
    if (route.empty() || ieq(route, "master") || ieq(route, "main") || ieq(route, "inherit")) return pair_at(0);
    if (ieq(route, "monitor")) return pair_at(channels >= 4 ? 2 : 0);

    bool zero_based = route.size() >= 4 && ieq(route.substr(0, 4), "ext:");
    for (auto prefix : {std::string_view("ext:"), std::string_view("hardware:"),
                        std::string_view("out_"), std::string_view("out ")}) {
        if (route.size() >= prefix.size() && ieq(route.substr(0, prefix.size()), prefix)) {
            route.remove_prefix(prefix.size());
            break;
        }
    }
    if (route.size() >= 3 && ieq(route.substr(0, 3), "out")) route.remove_prefix(3);
    auto number = [](std::string_view s, int& n) {
        if (s.empty()) return false;
        n = 0;
        for (char c : s) { if (c < '0' || c > '9') return false; n = n * 10 + c - '0'; }
        return true;
    };
    const auto dash = route.find('-');
    int first = 0, last = 0;
    if (dash != std::string_view::npos && number(route.substr(0, dash), first) &&
        number(route.substr(dash + 1), last) && last >= first) {
        // The old implementation accepts ranges and takes the first two.
    } else if (!number(route, first)) return pair_at(0);
    if (dash == std::string_view::npos) last = first;
    int result[2] = {0, -1};
    int found = 0;
    for (int logical = first; logical <= last && found < 2; ++logical) {
        const int physical = zero_based ? logical : logical - 1;
        auto it = std::find(active.begin(), active.end(), physical);
        if (it != active.end()) result[found++] = static_cast<int>(it - active.begin());
    }
    // The legacy implementation falls back to the master pair when a physical
    // route is outside the active map, rather than leaving the track silent.
    if (found == 0)
        return pair_at(0);
    return {result[0], result[1]};
}

Session routed_session(const std::vector<std::string>& routes, bool hierarchy = false,
                       Frame duration = kBlock * 2) {
    Session session;
    session.id = "routing-step03";
    session.sample_rate = test::kFixtureSampleRate;
    Song song;
    song.id = "song";
    song.end_frame = duration;
    for (std::size_t i = 0; i < routes.size(); ++i) {
        Track track;
        track.id = "track-" + std::to_string(i);
        track.audio_to = routes[i];
        track.clips.push_back(Clip{"clip-" + std::to_string(i), "source-" + std::to_string(i), 0, 0, song.end_frame});
        song.tracks.push_back(std::move(track));
        session.sources.push_back(Source{"source-" + std::to_string(i), ""});
    }
    if (hierarchy) {
        song.tracks.clear();
        Track root; root.id = "root"; root.kind = TrackKind::Folder; root.audio_to = "ext:3";
        Track middle; middle.id = "middle"; middle.kind = TrackKind::Folder; middle.parent_track_id = root.id; middle.audio_to = "inherit";
        Track leaf; leaf.id = "leaf"; leaf.parent_track_id = middle.id; leaf.audio_to = "inherit";
        leaf.clips.push_back(Clip{"clip-leaf", "source-0", 0, 0, song.end_frame});
        song.tracks = {root, middle, leaf};
    }
    session.songs.push_back(std::move(song));
    return session;
}

void add_sources(SourceManager& sources, int count, Frame frames = kBlock * 2) {
    for (int i = 0; i < count; ++i) {
        const auto id = "source-" + std::to_string(i);
        sources.register_source(id, "");
        REQUIRE(sources.store_decoded_source(id, test::make_stereo_sine(frames, 220.0 + i * 31.0, 0.2f),
                                             2, test::kFixtureSampleRate, frames).is_ok());
    }
}

std::vector<float> render(Mixer& mixer, TransportClock& clock, int channels, int blocks) {
    std::vector<float> all(static_cast<std::size_t>(channels * kBlock * blocks), 0.0f);
    std::vector<float*> out(static_cast<std::size_t>(channels));
    clock.play();
    clock.clear_pending_start();
    for (int block = 0; block < blocks; ++block) {
        for (int channel = 0; channel < channels; ++channel)
            out[static_cast<std::size_t>(channel)] = all.data() +
                static_cast<std::size_t>(channel * kBlock * blocks + block * kBlock);
        mixer.render(out.data(), channels, kBlock, clock.sample_rate());
    }
    return all;
}

float peak_channel(const std::vector<float>& audio, int channels, int channel) {
    float peak = 0.0f;
    const std::size_t per_channel = audio.size() / static_cast<std::size_t>(channels);
    const auto begin = audio.begin() + static_cast<std::size_t>(channel) * per_channel;
    for (auto it = begin; it != begin + per_channel; ++it)
        peak = std::max(peak, std::abs(*it));
    return peak;
}
} // namespace

TEST_CASE("step03 routing matches independent legacy oracle for every route and width") {
    const std::vector<std::string> routes = {"master", "main", "monitor", "inherit", "ext:3",
        "hardware:4", "out_3", "out 5", "", "garbage"};
    for (int channels : {2, 4, 8}) {
        for (const auto& route : routes) {
            std::vector<int> active(static_cast<std::size_t>(channels));
            for (int i = 0; i < channels; ++i) active[static_cast<std::size_t>(i)] = i;
            const auto expected = legacy_route(route, channels, active);
            const auto actual = Mixer::route_channels_for_test(route, channels, active.data(), channels);
            CAPTURE(channels);
            CAPTURE(route);
            CAPTURE(actual.first);
            CAPTURE(actual.second);
            CAPTURE(expected.first);
            CAPTURE(expected.second);
            CHECK(actual == expected);
        }
    }
}

TEST_CASE("step03 folder routing inheritance follows legacy through three levels") {
    SourceManager sources;
    add_sources(sources, 1);
    auto session = std::make_shared<Session>(routed_session({"master"}, true));
    TransportClock clock(test::kFixtureSampleRate);
    JumpScheduler scheduler;
    Mixer mixer(session, &sources, &clock, &scheduler);
    mixer.set_active_output_channels({0, 1, 2, 3});
    const auto audio = render(mixer, clock, 4, 1);
    const auto expected = legacy_route("ext:3", 4, {0, 1, 2, 3});
    for (int ch = 0; ch < 4; ++ch)
        CHECK((peak_channel(audio, 4, ch) > 0.001f) == (ch == expected.first || ch == expected.second));
}

TEST_CASE("step03 fallback routing is correct and allocation-free") {
    SourceManager sources;
    add_sources(sources, 1);
    auto session = std::make_shared<Session>(routed_session({"ext:3"}));
    TransportClock clock(test::kFixtureSampleRate);
    JumpScheduler scheduler;
    Mixer mixer(session, &sources, &clock, &scheduler);
    mixer.set_active_output_channels({0, 1, 2, 3});
    mixer.force_control_count_zero_for_test();
    std::vector<float> c0(kBlock), c1(kBlock), c2(kBlock), c3(kBlock);
    float* out[] = {c0.data(), c1.data(), c2.data(), c3.data()};
    clock.play();
    clock.clear_pending_start();
    rt::reset_violations();
    mixer.render(out, 4, kBlock, clock.sample_rate());
    CHECK(*std::max_element(c0.begin(), c0.end()) < 0.001f);
    CHECK(*std::max_element(c1.begin(), c1.end()) < 0.001f);
    CHECK(*std::max_element(c3.begin(), c3.end()) > 0.001f);
    CHECK(rt::violations().allocations == 0);
}

TEST_CASE("step03 routing is bit-exact for 200 blocks against the fallback path") {
    const std::vector<std::string> mixed = {"master", "monitor", "ext:2", "hardware:4", "out_5", "out 7", "ext:0", "garbage"};
    SourceManager sources;
    add_sources(sources, 8, kBlock * 220);
    // Both renderers receive the very same immutable session instance. This is
    // a before/after comparison of routing strategy, not two equivalent
    // fixtures that happen to serialize the same way.
    auto same_session = std::make_shared<Session>(routed_session(mixed, false, kBlock * 220));
    TransportClock clock_a(test::kFixtureSampleRate), clock_b(test::kFixtureSampleRate);
    JumpScheduler scheduler_a, scheduler_b;
    Mixer mixer_a(same_session, &sources, &clock_a, &scheduler_a);
    Mixer mixer_b(same_session, &sources, &clock_b, &scheduler_b);
    mixer_a.set_active_output_channels({0, 1, 2, 3, 4, 5, 6, 7});
    mixer_b.set_active_output_channels({0, 1, 2, 3, 4, 5, 6, 7});
    // The fallback path resolves routing from the live session for every
    // track; it is the before/after oracle for the precomputed control slots.
    mixer_b.force_control_count_zero_for_test();
    const auto a = render(mixer_a, clock_a, 8, 200);
    const auto b = render(mixer_b, clock_b, 8, 200);
    REQUIRE(a.size() == b.size());
    for (std::size_t i = 0; i < a.size(); ++i) CHECK(a[i] == b[i]);
}
