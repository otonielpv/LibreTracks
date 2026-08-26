#pragma once

#include <string>
#include <vector>

namespace lt {

// Configure and activate the process-wide AVAudioSession for output-only DAW
// playback. The actual realtime callback remains owned by JUCE/CoreAudio.
bool configure_ios_playback_session(std::string* error_message);

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
