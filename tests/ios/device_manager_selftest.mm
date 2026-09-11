// ---------------------------------------------------------------------------
// Runs the REAL iOS device backend (audio_device_manager_ios.mm +
// ios_audio_session.mm) inside a simulator and checks the things that, until
// now, only an iPhone in someone's hand could check.
//
// What this DOES cover, and nothing else did:
//   * RemoteIO opens through the engine's own code path, negotiates a rate and
//     a buffer, and drives the render callback with real frames.
//   * The engine writes non-zero samples into the buffers the hardware hands
//     it — the signal path, not just the plumbing.
//   * The recovery path used by an incoming call and by plugging in a USB
//     interface: the AVAudioSession notification bumps the route generation,
//     the stall monitor tears the stream down and hands the clock to the
//     fallback pump (so the transport never stops), and the next open_device —
//     which is what the Rust watchdog issues every 2 s — gets the hardware
//     back.
//
// What it CANNOT cover, and must not be read as covering:
//   * Real hardware routes. A simulator has one stereo output; a USB interface
//     with four or eight outputs cannot be simulated, so the channel-width
//     negotiation is still unproven.
//   * A real interruption. iOS posts the notification when a call arrives;
//     here the test posts it. Everything downstream of the notification is the
//     production code, but the notification itself is not.
//   * Latency and underrun behaviour, which are meaningless in a VM.
//
// Build and run: see .github/workflows/ios-audio-probe.yml.
// ---------------------------------------------------------------------------

#import <AVFoundation/AVFoundation.h>

#include <lt_engine/devices/audio_device_manager.h>
#include <lt_engine/devices/ios_audio_session.h>

#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <string>
#include <thread>
#include <vector>

namespace {

int g_failures = 0;

void check(bool condition, const std::string& what) {
    std::printf("%s %s\n", condition ? "  ok  " : "  FAIL", what.c_str());
    if (!condition) ++g_failures;
}

/// Stands in for the Mixer: writes a tone so there is something to detect, and
/// records what the backend hands it. Obeys the same realtime rules.
class ToneCallback final : public lt::AudioRenderCallback {
public:
    void set_active_output_channels(const std::vector<int>& channels) noexcept override {
        published_channels_.store(static_cast<int>(channels.size()), std::memory_order_relaxed);
    }

    void render(float** output_channels, int num_channels, int num_frames,
                double sample_rate) noexcept override {
        const double increment = 2.0 * M_PI * 440.0 / (sample_rate > 0 ? sample_rate : 48000.0);
        float peak = 0.0f;
        for (int frame = 0; frame < num_frames; ++frame) {
            const float sample = static_cast<float>(0.25 * std::sin(phase_));
            phase_ += increment;
            if (phase_ > 2.0 * M_PI) phase_ -= 2.0 * M_PI;
            if (std::fabs(sample) > peak) peak = std::fabs(sample);
            for (int channel = 0; channel < num_channels; ++channel)
                output_channels[channel][frame] = sample;
        }
        if (peak > peak_.load(std::memory_order_relaxed))
            peak_.store(peak, std::memory_order_relaxed);
        last_channels_.store(num_channels, std::memory_order_relaxed);
        last_frames_.store(num_frames, std::memory_order_relaxed);
        last_sample_rate_.store(sample_rate, std::memory_order_relaxed);
        calls_.fetch_add(1, std::memory_order_relaxed);
    }

    int    calls() const { return calls_.load(std::memory_order_relaxed); }
    float  peak() const { return peak_.load(std::memory_order_relaxed); }
    int    last_channels() const { return last_channels_.load(std::memory_order_relaxed); }
    int    last_frames() const { return last_frames_.load(std::memory_order_relaxed); }
    double last_sample_rate() const { return last_sample_rate_.load(std::memory_order_relaxed); }
    int    published_channels() const { return published_channels_.load(std::memory_order_relaxed); }

private:
    double             phase_ = 0.0;
    std::atomic<int>   calls_{0};
    std::atomic<float> peak_{0.0f};
    std::atomic<int>   last_channels_{0};
    std::atomic<int>   last_frames_{0};
    std::atomic<double> last_sample_rate_{0.0};
    std::atomic<int>   published_channels_{-1};
};

void sleep_ms(int milliseconds) {
    std::this_thread::sleep_for(std::chrono::milliseconds(milliseconds));
}

/// Poll instead of sleeping a fixed time: the monitor ticks every 500 ms and
/// a fixed wait would either be flaky or slow.
template <typename Predicate>
bool wait_until(Predicate predicate, int timeout_ms) {
    const auto deadline = std::chrono::steady_clock::now()
                        + std::chrono::milliseconds(timeout_ms);
    while (std::chrono::steady_clock::now() < deadline) {
        if (predicate()) return true;
        sleep_ms(50);
    }
    return predicate();
}

} // namespace

int main() {
    @autoreleasepool {
        lt::AudioDeviceManager manager;
        ToneCallback callback;

        std::printf("── Device list ─────────────────────────────────────────\n");
        const auto devices = manager.list_devices();
        check(devices.size() == 1, "iOS publishes exactly one output route");
        if (!devices.empty()) {
            const auto& device = devices.front();
            std::printf("  route=\"%s\" backend=%s channels=%d\n",
                        device.name.c_str(), device.backend.c_str(),
                        device.output_channel_count);
            check(device.id.empty(), "the route has an empty device id (the system route)");
            check(device.backend == "coreaudio-ios", "backend is the RemoteIO one, not the stub");
            check(device.output_channel_count >= 1, "the route reports at least one channel");
        }

        std::printf("── Opening the device ──────────────────────────────────\n");
        lt::DeviceOpenRequest request;
        request.sample_rate = 48000;
        const auto opened = manager.open_device(request, &callback);
        if (!opened.is_ok()) {
            std::printf("  FAIL open_device: %s\n", opened.error().c_str());
            std::printf("SELFTEST_RESULT=open-failed\n");
            return 1;
        }
        const auto info = manager.device_info();
        std::printf("  name=\"%s\" backend=%s sr=%d buffer=%d channels=%d latency=%d\n",
                    info.device_name.c_str(), info.backend.c_str(), info.sample_rate,
                    info.buffer_size, info.output_channel_count,
                    manager.actual_output_latency_samples());
        check(info.backend == "coreaudio-ios", "device_info reports the RemoteIO backend");
        check(info.sample_rate > 0, "a sample rate was negotiated");
        check(info.buffer_size > 0, "a buffer size was negotiated");
        check(!manager.fallback_active(), "the hardware stream is live, not the fallback clock");

        std::printf("── Callbacks and signal ────────────────────────────────\n");
        const bool got_callbacks = wait_until([&] { return callback.calls() > 10; }, 3000);
        std::printf("  calls=%d frames=%d channels=%d sr=%.0f peak=%.4f\n",
                    callback.calls(), callback.last_frames(), callback.last_channels(),
                    callback.last_sample_rate(), static_cast<double>(callback.peak()));
        check(got_callbacks, "the render callback runs from the hardware stream");
        check(callback.peak() > 0.1f, "the engine's samples reach the output buffers");
        check(callback.last_channels() >= 1, "the callback gets at least one channel");
        check(callback.last_sample_rate() == info.sample_rate,
              "the callback's sample rate matches what the device negotiated");
        // Publishing the physical channel map before the first callback is what
        // lets explicit routes (ext:3-4) resolve; on iOS it is the identity.
        check(callback.published_channels() == info.output_channel_count,
              "the physical channel map was published to the render layer");

        std::printf("── Interruption recovery (the phone-call path) ─────────\n");
        const unsigned generation_before = lt::ios_audio_route_generation();
        const int calls_before = callback.calls();
        [NSNotificationCenter.defaultCenter
            postNotificationName:AVAudioSessionInterruptionNotification
                          object:AVAudioSession.sharedInstance
                        userInfo:@{AVAudioSessionInterruptionTypeKey:
                                     @(AVAudioSessionInterruptionTypeEnded)}];
        const bool bumped = wait_until(
            [&] { return lt::ios_audio_route_generation() != generation_before; }, 2000);
        check(bumped, "the session observer sees the interruption and bumps the route generation");

        // The monitor ticks every 500 ms; give it a few ticks.
        const bool went_to_fallback = wait_until([&] { return manager.fallback_active(); }, 4000);
        check(went_to_fallback, "the monitor tears the stream down and starts the fallback clock");

        if (went_to_fallback) {
            const int calls_at_fallback = callback.calls();
            sleep_ms(500);
            const int calls_during_fallback = callback.calls() - calls_at_fallback;
            std::printf("  callbacks during 500 ms of fallback: %d\n", calls_during_fallback);
            // This is the property that keeps the transport moving through a
            // call instead of freezing the playhead.
            check(calls_during_fallback > 0,
                  "the fallback pump keeps driving the render callback (transport survives)");
        }
        check(callback.calls() > calls_before, "the callback never stopped being called");

        std::printf("── Reopening, the way the watchdog does ────────────────\n");
        const auto reopened = manager.open_device(request, &callback);
        check(reopened.is_ok(), "open_device recovers the hardware stream");
        if (reopened.is_ok()) {
            check(!manager.fallback_active(), "the fallback clock is retired after recovery");
            const int calls_after_reopen = callback.calls();
            const bool running_again =
                wait_until([&] { return callback.calls() > calls_after_reopen + 10; }, 3000);
            check(running_again, "hardware callbacks resume after the recovery");
        }

        std::printf("── Closing ─────────────────────────────────────────────\n");
        check(manager.close_device().is_ok(), "close_device succeeds");
        sleep_ms(300);
        const int calls_at_close = callback.calls();
        sleep_ms(300);
        check(callback.calls() == calls_at_close,
              "nothing drives the callback once the device is closed");

        if (g_failures == 0) {
            std::printf("SELFTEST_RESULT=ok\n");
            return 0;
        }
        std::printf("SELFTEST_RESULT=%d-checks-failed\n", g_failures);
        return 1;
    }
}
