#include <doctest/doctest.h>

#include <lt_engine/render/region_envelope.h>

#include <array>
#include <cmath>
#include <vector>

using namespace lt;

namespace {

Session session_with(std::vector<Region> regions) {
    Session session;
    Song song;
    song.id = "song";
    song.regions = std::move(regions);
    session.songs.push_back(std::move(song));
    return session;
}

Region region(Frame start, Frame end, Frame fade_in, Frame fade_out, float gain = 1.0f) {
    Region r;
    r.id = "r" + std::to_string(start);
    r.start_frame = start;
    r.end_frame = end;
    r.fade_in_frames = fade_in;
    r.fade_out_frames = fade_out;
    r.master_gain = gain;
    return r;
}

// The whole block, walked in envelope chunks exactly like the mixer does.
std::vector<float> envelope(const Session& session, Frame start, int frames) {
    std::vector<float> out(static_cast<std::size_t>(frames));
    for (int at = 0; at < frames; at += kRegionEnvelopeChunk) {
        const int count = std::min(kRegionEnvelopeChunk, frames - at);
        fill_region_envelope(session, start + at, count, out.data() + at);
    }
    return out;
}

} // namespace

TEST_CASE("song fade in rises linearly from silence at the song's first frame") {
    const auto session = session_with({region(1000, 3000, 400, 0)});
    const auto gains = envelope(session, 1000, 600);
    CHECK(gains[0] == doctest::Approx(0.0f));
    CHECK(gains[200] == doctest::Approx(0.5f));
    CHECK(gains[400] == doctest::Approx(1.0f));
    CHECK(gains[599] == doctest::Approx(1.0f));
}

TEST_CASE("song fade out reaches silence on the song's last frame") {
    const auto session = session_with({region(0, 1000, 0, 400)});
    const auto gains = envelope(session, 0, 1000);
    CHECK(gains[599] == doctest::Approx(1.0f));
    CHECK(gains[799] == doctest::Approx(0.5f));
    CHECK(gains[999] == doctest::Approx(0.0f));
}

TEST_CASE("song fades multiply the song master gain") {
    const auto session = session_with({region(0, 1000, 200, 0, 0.5f)});
    const auto gains = envelope(session, 0, 300);
    CHECK(gains[100] == doctest::Approx(0.25f));
    CHECK(gains[250] == doctest::Approx(0.5f));
}

// A block-constant gain (what the mixer did before the fades) would show up as
// steps at every chunk boundary. The envelope must be continuous across them.
TEST_CASE("the song envelope has no steps across chunk boundaries") {
    const Frame fade = 4000;
    const auto session = session_with({region(0, 20000, fade, fade)});
    const auto gains = envelope(session, 0, 20000);
    const float max_step = 1.0f / static_cast<float>(fade) + 1e-6f;
    for (std::size_t f = 1; f < gains.size(); ++f) {
        CAPTURE(f);
        REQUIRE(std::abs(gains[f] - gains[f - 1]) <= max_step);
    }
}

TEST_CASE("a jump past the fade in plays at full level") {
    const auto session = session_with({region(0, 48000, 4800, 0)});
    const auto gains = envelope(session, 24000, 256);
    for (float gain : gains)
        CHECK(gain == doctest::Approx(1.0f));
}

TEST_CASE("the envelope follows the region it is in across a song boundary") {
    // Song A fades out into song B, which fades in; the gap after B is unity.
    const auto session = session_with({region(0, 1000, 0, 100), region(1000, 2000, 100, 0)});
    const auto gains = envelope(session, 900, 1300);
    CHECK(gains[0] == doctest::Approx(99.0f / 100.0f));   // frame 900
    CHECK(gains[99] == doctest::Approx(0.0f));            // frame 999, A's last
    CHECK(gains[100] == doctest::Approx(0.0f));           // frame 1000, B's first
    CHECK(gains[150] == doctest::Approx(0.5f));           // frame 1050
    CHECK(gains[1200] == doctest::Approx(1.0f));          // frame 2100, no song
}

TEST_CASE("no fades and unity gain report unity so the mixer can skip the multiply") {
    const auto session = session_with({region(0, 1000, 0, 0)});
    std::array<float, kRegionEnvelopeChunk> gains{};
    CHECK(fill_region_envelope(session, 0, kRegionEnvelopeChunk, gains.data()));
    const auto faded = session_with({region(0, 1000, 10, 0)});
    CHECK_FALSE(fill_region_envelope(faded, 0, kRegionEnvelopeChunk, gains.data()));
}
