#pragma once

// ---------------------------------------------------------------------------
// AudioDeviceManager — JUCE-backed audio output management.
//
// Responsibilities:
//   - Enumerate output devices.
//   - Open / close devices.
//   - Manage the JUCE AudioIODevice and its callback.
//   - Report device diagnostics.
//
// The audio callback is decoupled via the AudioRenderCallback interface so
// the rest of the engine does not depend on JUCE types.
// ---------------------------------------------------------------------------

#include <lt_engine/core/result.h>
#include <lt_engine/core/snapshot.h>
#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace lt {

struct DeviceDescriptor {
    std::string id;
    std::string name;
    std::string backend;
    int output_channel_count = 2;
    std::vector<std::string> output_channel_names;
    std::vector<int> supported_sample_rates;
    std::vector<int> supported_buffer_sizes;
};

struct DeviceOpenRequest {
    std::string device_id;    // empty = default
    int         sample_rate  = 0;  // 0 = device default
    int         buffer_size  = 0;  // 0 = device default
    // Output channels to activate on the hardware (0-based indices into the
    // device's channel list). Empty = back-compat stereo (channels 0 and 1).
    std::vector<int> active_output_channels;
};

// ---------------------------------------------------------------------------
// AudioRenderCallback — implemented by the engine render layer.
// MUST obey realtime rules: no alloc, no lock, no I/O.
// ---------------------------------------------------------------------------
class AudioRenderCallback {
public:
    virtual ~AudioRenderCallback() = default;
    virtual void render(float** output_channels,
                        int     num_channels,
                        int     num_frames,
                        double  sample_rate) noexcept = 0;
};

// ---------------------------------------------------------------------------
// AudioDeviceManager
// ---------------------------------------------------------------------------
class AudioDeviceManager {
public:
    AudioDeviceManager();
    ~AudioDeviceManager();

    // Enumerate available output devices.
    std::vector<DeviceDescriptor> list_devices() const;

    // Open (and optionally start) a device.  Installs the callback.
    // Stopping the stream first if one is already open.
    Result<void> open_device(const DeviceOpenRequest& request,
                              AudioRenderCallback* callback);

    Result<void> close_device();

    Result<void> start();
    Result<void> stop();

    // Actual negotiated values (valid after open_device succeeds).
    int    actual_sample_rate() const;
    int    actual_buffer_size() const;
    // Total output latency in samples (device buffer + driver / OS engine
    // queuing). Samples handed to the device emerge from the speakers this
    // many frames later. Used by the engine to compensate the snapshot frame
    // so the UI playhead / meters line up with what the user hears.
    int    actual_output_latency_samples() const;
    std::string actual_device_name() const;
    std::string actual_backend() const;

    // Live diagnostics (updated every callback).
    DeviceInfo device_info() const;

    // Read-and-reset the worst inter-callback gap and worst in-callback work
    // time since the last call (LIBRETRACKS_AUDIO_DIAG). Call from a non-audio
    // thread (e.g. the snapshot poll) — the audio thread must never log.
    // Distinguishes "thread starved between callbacks" (gap) from "render
    // blocked inside the callback" (work). Returns 0 if no device is open.
    double take_callback_gap_max_ms();
    double take_callback_work_max_ms();

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace lt
