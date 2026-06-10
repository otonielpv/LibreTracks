#include <doctest/doctest.h>

#include <lt_engine/devices/device_channel_layout.h>

#include <string>
#include <vector>

using namespace lt;
using namespace lt::device_layout;

namespace {

// A fabricated audio device — stands in for a real driver/hardware so the
// channel-layout logic can be exercised without JUCE or physical interfaces.
struct FakeDevice {
    std::string              backend;          // e.g. "ASIO", "Windows Audio"
    std::vector<std::string> reported_channels; // what the driver advertises
};

// A Behringer U-Phoria UMC204HD seen through its ASIO driver: 4 discrete
// outputs (two stereo pairs). This is the device from the bug report.
FakeDevice umc204hd_asio() {
    return FakeDevice{
        "ASIO",
        {"UMC204HD Out 1", "UMC204HD Out 2", "UMC204HD Out 3", "UMC204HD Out 4"},
    };
}

// The same interface seen through WASAPI shared mode, which only exposes the
// first stereo pair — this is the failure mode the user reported ("sólo me
// reconoce la salida 1 y 2").
FakeDevice umc204hd_wasapi_shared() {
    return FakeDevice{"Windows Audio", {}};
}

// Resolve a fake device the way the manager would: probe-capable backends use
// the reported channels; everything else falls through the stereo fallback.
ResolvedChannelLayout resolve_fake(const FakeDevice& dev) {
    if (backend_needs_channel_probe(dev.backend)) {
        return resolve_layout(static_cast<int>(dev.reported_channels.size()),
                              dev.reported_channels);
    }
    // Non-probed backends report nothing here; the fallback fills in stereo.
    return resolve_layout(0, {});
}

} // namespace

TEST_CASE("backend probe classification matches the shipping rule") {
    CHECK(backend_needs_channel_probe("ASIO"));
    CHECK(backend_needs_channel_probe("asio"));
    CHECK(backend_needs_channel_probe("JACK"));
    CHECK(backend_needs_channel_probe("ALSA"));
    CHECK(backend_needs_channel_probe("CoreAudio"));
    CHECK(backend_needs_channel_probe("Core Audio"));

    // Windows shared backends are assumed stereo, never probed.
    CHECK_FALSE(backend_needs_channel_probe("Windows Audio"));
    CHECK_FALSE(backend_needs_channel_probe("DirectSound"));
    CHECK_FALSE(backend_needs_channel_probe("Windows Audio (MME)"));
}

TEST_CASE("UMC204HD over ASIO exposes all four outputs") {
    auto layout = resolve_fake(umc204hd_asio());
    CHECK(layout.count == 4);
    REQUIRE(layout.names.size() == 4);
    CHECK(layout.names[2] == "UMC204HD Out 3");
    CHECK(layout.names[3] == "UMC204HD Out 4");
}

TEST_CASE("UMC204HD over WASAPI shared collapses to stereo (the reported bug)") {
    auto layout = resolve_fake(umc204hd_wasapi_shared());
    // Reproduces "sólo me reconoce la salida 1 y 2": the second pair is gone.
    CHECK(layout.count == 2);
    REQUIRE(layout.names.size() == 2);
    CHECK(layout.names[0] == "Out 1");
    CHECK(layout.names[1] == "Out 2");
}

TEST_CASE("stereo fallback fires when a driver reports no named channels") {
    auto layout = resolve_layout(0, {});
    CHECK(layout.count == 2);
    CHECK(layout.names == std::vector<std::string>{"Out 1", "Out 2"});

    // A negative/garbage count is treated the same as "nothing reported".
    auto neg = resolve_layout(-1, {});
    CHECK(neg.count == 2);
}

TEST_CASE("active channel clamping against the real device width") {
    // On a 4-output device, routing to Out 3/4 (indices 2,3) is preserved.
    CHECK(clamp_active_channels({2, 3}, 4) == std::vector<int>{2, 3});

    // The same routing against a 2-output device drops the missing channels
    // and falls back to the stereo pair — engine-side mirror of the TS
    // normalizeEnabledOutputChannelsForOutputCount() clamp.
    CHECK(clamp_active_channels({2, 3}, 2) == std::vector<int>{0, 1});

    // Out-of-range and negative indices are filtered out.
    CHECK(clamp_active_channels({-1, 0, 1, 9}, 4) == std::vector<int>{0, 1});

    // An empty request defaults to stereo, clamped to what exists.
    CHECK(clamp_active_channels({}, 4) == std::vector<int>{0, 1});
    CHECK(clamp_active_channels({}, 1) == std::vector<int>{0});

    // A device with no outputs yields nothing to activate.
    CHECK(clamp_active_channels({0, 1}, 0).empty());
}
