#pragma once

// ---------------------------------------------------------------------------
// PilotTone — the main's "I am alive" tone for a hardware switcher
// (docs/plans/completed/redundancy/08-tono-piloto.md), like the "drone track" a Radial
// SW8 listens to.
//
// - A sine on ONE physical output channel (1-based, the number the user sees
//   on the interface), REPLACING whatever the mix put there: the channel is
//   exclusive while the tone is armed.
// - Written by the audio callback after the final mix, the master fade and
//   the limiter: transport, stop fades and track mutes never touch it. If the
//   callback stops (hang, crash, exit) the tone stops with it.
// - Phase continues across blocks of any size; arming and disarming ramp over
//   10 ms so the switcher hears no click.
// - Not part of the offline renderer: exports never contain it.
//
// Compatibility with iConnectivity PlayAUDIO "LifeSine" is NOT verified: its
// signal is not documented and no unit was available (decision D2). Frequency
// and level are configurable; the defaults (1 kHz, -12 dBFS) suit level-
// threshold switchers.
//
// Threading: configure() from the control thread (atomics only); render()
// from the audio thread (no allocation, no lock, no I/O).
// ---------------------------------------------------------------------------

#include <algorithm>
#include <atomic>
#include <cmath>

namespace lt {

class PilotTone {
public:
    enum class Error : int { None = 0, ChannelMissing = 1 };

    static constexpr double kDefaultFrequencyHz = 1000.0;
    static constexpr float  kDefaultLevelDb = -12.0f;
    static constexpr double kRampSeconds = 0.010;

    void configure(bool enabled, int channel_1_based, double frequency_hz,
                   float level_db) noexcept {
        channel_.store(channel_1_based, std::memory_order_relaxed);
        frequency_.store(std::clamp(frequency_hz, 20.0, 20000.0), std::memory_order_relaxed);
        const float level = std::clamp(level_db, -60.0f, 0.0f);
        gain_.store(std::pow(10.0f, level / 20.0f), std::memory_order_relaxed);
        enabled_.store(enabled, std::memory_order_release);
    }

    bool enabled() const noexcept { return enabled_.load(std::memory_order_acquire); }
    // Really on an output this block (armed, channel present, or fading out).
    bool active() const noexcept { return active_.load(std::memory_order_relaxed); }
    Error error() const noexcept {
        return static_cast<Error>(error_.load(std::memory_order_relaxed));
    }

    // `physical_channels[slot]` = 0-based device channel of each dense output
    // slot (JUCE packs enabled outputs). Audio thread.
    void render(float** output, int num_channels, int num_frames, double sample_rate,
                const int* physical_channels, int physical_count) noexcept {
        const bool want = enabled_.load(std::memory_order_acquire);
        const int wanted = channel_.load(std::memory_order_relaxed) - 1;
        int slot = -1;
        const int count = std::min(num_channels, physical_count);
        for (int i = 0; i < count; ++i) {
            if (physical_channels[i] == wanted) {
                slot = i;
                break;
            }
        }
        if (slot < 0) {
            // The device has no such output (or none is configured): nothing
            // is written, and the next time it is there it ramps in again.
            current_gain_ = 0.0f;
            active_.store(false, std::memory_order_relaxed);
            error_.store(static_cast<int>(want ? Error::ChannelMissing : Error::None),
                         std::memory_order_relaxed);
            return;
        }
        error_.store(static_cast<int>(Error::None), std::memory_order_relaxed);
        const float target = want ? gain_.load(std::memory_order_relaxed) : 0.0f;
        if (target == 0.0f && current_gain_ == 0.0f) {
            active_.store(false, std::memory_order_relaxed);
            return;  // disarmed and silent: the channel belongs to the mix again
        }
        const double sr = sample_rate > 0.0 ? sample_rate : 48000.0;
        const float full = std::max(gain_.load(std::memory_order_relaxed), 1.0e-6f);
        const float step = static_cast<float>(full / (kRampSeconds * sr));
        const double increment =
            2.0 * kPi * frequency_.load(std::memory_order_relaxed) / sr;
        float* out = output[slot];
        for (int f = 0; f < num_frames; ++f) {
            if (current_gain_ < target)
                current_gain_ = std::min(target, current_gain_ + step);
            else if (current_gain_ > target)
                current_gain_ = std::max(target, current_gain_ - step);
            out[f] = static_cast<float>(std::sin(phase_)) * current_gain_;
            phase_ += increment;
            if (phase_ >= 2.0 * kPi)
                phase_ -= 2.0 * kPi;
        }
        active_.store(current_gain_ > 0.0f || target > 0.0f, std::memory_order_relaxed);
    }

private:
    static constexpr double kPi = 3.14159265358979323846;

    std::atomic<bool>   enabled_{false};
    std::atomic<int>    channel_{0};
    std::atomic<double> frequency_{kDefaultFrequencyHz};
    std::atomic<float>  gain_{0.25118864f};  // -12 dBFS
    std::atomic<bool>   active_{false};
    std::atomic<int>    error_{0};
    // Audio thread only.
    double phase_ = 0.0;
    float  current_gain_ = 0.0f;
};

} // namespace lt
