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

#include <cctype>

namespace lt {

// Smallest buffer a backend can actually sustain, in frames. 0 = trust the
// driver's own minimum.
//
// DirectSound and MME go through the OS shared mixer and are not built for
// small buffers. Asking for one does not produce low latency; it produces
// underruns — and an underrunning DirectSound device drops whole buffers, so
// the audio jumps forward again and again. What the listener reports is not
// "it crackles", it is "it crackles AND plays too fast", which sounds like a
// pitch bug and is not one.
//
// Measured on one device and session:
//     buffer=512 (11.6 ms) + latency 768  ->  29.0 ms out, clean
//     buffer=128 ( 2.9 ms) + latency 192  ->  crackling, audibly sped up
//
// WASAPI and ASIO are the backends to reach for when low latency is the goal:
// the same hardware on WASAPI runs 441 frames at 20.0 ms total, comfortably.
//
// Clamping rather than refusing is deliberate. Someone who picks 128 wants low
// latency, and the honest answer is the lowest this backend can give them —
// reported back through actual_buffer_size(), so the UI shows what is really
// running instead of what was asked for.
//
// Pure function of its input so the policy can be tested without a device.
inline int lt_min_buffer_frames_for_backend(const std::string& backend) {
    std::string name;
    name.reserve(backend.size());
    for (char c : backend)
        name.push_back(static_cast<char>(std::tolower(static_cast<unsigned char>(c))));
    if (name.find("directsound") != std::string::npos ||
        name.find("mme") != std::string::npos) {
        return 512;
    }
    return 0;
}


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
    // Android/Oboe only: request AAudio low-latency PerformanceMode. Ignored by
    // desktop backends. Off by default (deep-buffer mode, safe on low-end).
    bool        low_latency  = false;
};

// ---------------------------------------------------------------------------
// AudioRenderCallback — implemented by the engine render layer.
// MUST obey realtime rules: no alloc, no lock, no I/O.
// ---------------------------------------------------------------------------
class AudioRenderCallback {
public:
    virtual ~AudioRenderCallback() = default;
    // JUCE presents only enabled hardware outputs to render(), packed into a
    // dense 0..N-1 array. Publish the corresponding physical (device) channel
    // indices so explicit routes such as ext:14-15 can be translated back to
    // callback slots 2-3 when channels 12-15 are enabled.
    virtual void set_active_output_channels(const std::vector<int>& /*channels*/) noexcept {}
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
    //
    // When `force_rescan` is true the enumeration re-scans EVERY backend —
    // including the one that currently owns the live stream — and clears the
    // channel-layout cache, so freshly (un)plugged devices and changed driver
    // layouts show up. This is what the Settings "Refresh audio devices" button
    // passes. Because re-scanning the active backend tears the live stream down
    // on Windows (DirectSound), a forced rescan closes and reopens the current
    // device around the scan; expect a brief audio dropout while playing.
    // With `force_rescan == false` the active backend is skipped (no dropout)
    // and cached layouts are reused — the cheap path used on Settings open.
    std::vector<DeviceDescriptor> list_devices(bool force_rescan = false) const;

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

    // True while the render callback is being driven by the internal fallback
    // pump instead of a hardware stream. Entered when a device fails to open or
    // when the stall monitor declares the live stream dead (no callbacks for
    // ~1.5s — the post-suspend / unplugged-endpoint case). The transport keeps
    // advancing (silently) the whole time; the control layer polls this flag
    // and retries open_device() until the hardware comes back.
    bool fallback_active() const;

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
