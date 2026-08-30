#pragma once

#include <string>
#include <vector>

namespace lt {

// Configure and activate the process-wide AVAudioSession for output-only DAW
// playback. The actual realtime callback remains owned by JUCE/CoreAudio.
//
// This also negotiates the output WIDTH: see current_ios_output_channel_count.
bool configure_ios_playback_session(std::string* error_message);

// Output channels the active route actually granted.
//
// iOS hands an app two channels unless it asks for more, so a class-compliant
// USB interface with four or eight outputs came up stereo and the rest of its
// outputs were unreachable — the app could not send the click to its own
// output, which is the whole point of a playback rig. The session asks for the
// route's maximum, and this reports what it got: the device list publishes it
// as the channel count, which is what the existing routing UI is driven by.
//
// Falls back to 2 when the session is not active yet or reports nothing usable.
int current_ios_output_channel_count();

// Human-readable runtime state for field diagnostics (route, volume, sample
// rate and buffer). Never called from the realtime callback.
std::string describe_ios_playback_session();

struct IosOutputRoute {
    std::string display_name;
    std::string port_type;
    std::string uid;
    std::vector<std::string> channel_names;
};

// iOS exposes the active output route, rather than a desktop-style list of
// independently openable CoreAudio devices. This still identifies wired/USB,
// Bluetooth, AirPlay, HDMI and built-in routes with their physical names.
IosOutputRoute current_ios_output_route();

} // namespace lt
