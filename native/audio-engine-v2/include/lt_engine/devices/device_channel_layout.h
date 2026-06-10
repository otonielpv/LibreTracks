#pragma once

// ---------------------------------------------------------------------------
// device_channel_layout — pure, JUCE-free helpers for reasoning about a
// device's output channel layout.
//
// These functions encapsulate the decisions that audio_device_manager.cpp
// makes around channel enumeration:
//   - which backends must be probed for their real channel layout
//     (ASIO/JACK/ALSA/CoreAudio) vs. assumed stereo (WASAPI/DirectSound/MME);
//   - the "fall back to stereo Out 1/Out 2" rule when a driver reports no
//     named channels;
//   - clamping a requested set of active output channels to what the device
//     actually exposes.
//
// They are split out of audio_device_manager.cpp so they can be unit-tested
// against a fabricated multichannel device (e.g. a Behringer UMC204HD with
// 4 outputs) WITHOUT a real JUCE backend or physical hardware. The manager
// reuses them so the tested logic is the same logic that ships.
// ---------------------------------------------------------------------------

#include <algorithm>
#include <cctype>
#include <string>
#include <vector>

namespace lt {

// Resolved output layout for a device after applying the stereo fallback.
struct ResolvedChannelLayout {
    int                      count = 2;
    std::vector<std::string> names = {"Out 1", "Out 2"};
};

namespace device_layout {

inline std::string lower_copy(std::string value) {
    std::transform(value.begin(), value.end(), value.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return value;
}

// Some backends (WASAPI shared / DirectSound / MME on Windows, the macOS
// non-aggregate CoreAudio devices) only expose stereo through cheap
// enumeration. Probing them by instantiating an AudioIODevice is pointless
// and, for some drivers (notably WASAPI on certain Realtek installs),
// surprisingly slow. ASIO and JACK are the ones where we *must* probe to
// discover the real channel layout, because the device count is
// driver-dependent — and that is exactly how a 4-output interface like the
// UMC204HD surfaces all four channels.
inline bool backend_needs_channel_probe(const std::string& backend) {
    const auto name = lower_copy(backend);
    return name.find("asio") != std::string::npos
        || name.find("jack") != std::string::npos
        || name.find("alsa") != std::string::npos
        || name.find("core audio") != std::string::npos
        || name.find("coreaudio") != std::string::npos;
}

// Apply the stereo fallback: a driver that reports no named output channels
// (count <= 0) is treated as a plain stereo device. Mirrors the
// "Out 1 / Out 2" default used in list_devices() and open_device().
inline ResolvedChannelLayout resolve_layout(int reported_count,
                                            std::vector<std::string> reported_names) {
    ResolvedChannelLayout layout;
    if (reported_count > 0) {
        layout.count = reported_count;
        layout.names = std::move(reported_names);
        return layout;
    }
    layout.count = 2;
    layout.names = {"Out 1", "Out 2"};
    return layout;
}

// Clamp a requested set of 0-based output channel indices to the channels the
// device actually exposes, dropping negatives and out-of-range entries. An
// empty request (or one fully out of range) falls back to stereo channels
// {0, 1} clamped to the available count — matching the back-compat behaviour
// of DeviceOpenRequest::active_output_channels.
//
// This is the seam where a "route to Out 3/4" request against a device that
// only reports 2 channels collapses back to Out 1/2 — the engine-side mirror
// of the TS normalizeEnabledOutputChannelsForOutputCount() rule.
inline std::vector<int> clamp_active_channels(const std::vector<int>& requested,
                                              int available_count) {
    std::vector<int> out;
    if (available_count <= 0)
        return out;
    for (int ch : requested) {
        if (ch >= 0 && ch < available_count)
            out.push_back(ch);
    }
    if (out.empty()) {
        for (int ch = 0; ch < 2 && ch < available_count; ++ch)
            out.push_back(ch);
    }
    return out;
}

} // namespace device_layout
} // namespace lt
