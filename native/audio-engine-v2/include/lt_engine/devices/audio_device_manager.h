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
    std::string actual_device_name() const;
    std::string actual_backend() const;

    // Live diagnostics (updated every callback).
    DeviceInfo device_info() const;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace lt
