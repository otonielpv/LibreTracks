#pragma once

#include <string>
#include <vector>

namespace lt {

// Configure and activate the process-wide AVAudioSession for output-only DAW
// playback. The realtime callback itself belongs to the device manager's
// RemoteIO unit (audio_device_manager_ios.mm); this owns the policy.
//
// This also negotiates the output WIDTH: see current_ios_output_channel_count.
//
// preferred_sample_rate is a request, not a guarantee — Bluetooth and AirPlay
// routes routinely negotiate something else, and the caller must read back
// AVAudioSession.sampleRate. Pass 0 for the default (48 kHz).
bool configure_ios_playback_session(std::string* error_message,
                                    double preferred_sample_rate = 0.0);

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

// Counter bumped whenever iOS reports something that makes the OPEN device stop
// describing reality: an interface plugged or unplugged, or an interruption
// (a phone call) that has just ended.
//
// Deliberately a counter and not a callback. The device manager already has a
// proven recovery path — the stall monitor tears the stream down, the fallback
// pump keeps the engine clock running, and the control layer reopens — and
// calling into it from a notification thread would mean taking the stream mutex
// from a fourth thread. The monitor polls this instead, so a route change joins
// the same path a dead device already takes, with no new locking.
//
// Why it is needed at all, given the stall monitor: PLUGGING IN is invisible to
// it. iOS moves the route across seamlessly, the callbacks never stop, and the
// device stays open at the channel count it negotiated before the interface
// existed — so a four- or eight-output interface would keep behaving as stereo
// until the app was restarted.
unsigned ios_audio_route_generation();

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
