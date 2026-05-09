#pragma once

#include <lt_engine/core/types.h>
#include <lt_engine/core/snapshot.h>
#include <lt_engine/session/session.h>
#include <lt_engine/sources/source_manager.h>
#include <lt_engine/render/track_renderer.h>
#include <lt_engine/render/fade_processor.h>
#include <lt_engine/devices/audio_device_manager.h>
#include <lt_engine/transport/transport_clock.h>
#include <lt_engine/scheduler/jump_scheduler.h>
#include <array>
#include <atomic>
#include <memory>

namespace lt {

// ---------------------------------------------------------------------------
// Mixer — JUCE AudioRenderCallback implementation.
//
// Owns a TrackRenderer per track and mixes all tracks to stereo output.
// Realtime-safe: no allocations, no locks in render().
// ---------------------------------------------------------------------------
class Mixer : public AudioRenderCallback {
public:
    Mixer(const Session*       session,
          const SourceManager* sources,
          TransportClock*      clock,
          JumpScheduler*       scheduler);

    // Called by the JUCE audio thread.
    void render(float** output_channels,
                int     num_channels,
                int     num_frames,
                double  sample_rate) noexcept override;

    // Called from command thread to update track gain/mute/solo atomically.
    // Changes take effect at the next render block.
    void set_track_gain(const Id& track_id, Gain gain);
    void set_track_mute(const Id& track_id, bool mute);
    void set_track_solo(const Id& track_id, bool solo);

    // Meter read (from UI thread — relaxed atomic).
    MeterValues meters() const noexcept;

    // Diagnostic counters.
    int    callback_count()          const noexcept;
    double callback_duration_ms()    const noexcept;

private:
    const Session*       session_;
    const SourceManager* sources_;
    TransportClock*      clock_;
    JumpScheduler*       scheduler_;

    // Per-track renderer pool (one per track, up to kMaxTracks).
    // Allocated once on construction, never in render().
    static constexpr int kMaxTracks = 64;
    std::array<TrackRenderer, kMaxTracks> renderers_;

    // Per-track mix overrides (command thread writes, audio thread reads).
    struct TrackOverride {
        std::atomic<float> gain{1.0f};
        std::atomic<bool>  mute{false};
        std::atomic<bool>  solo{false};
    };
    std::array<TrackOverride, kMaxTracks> overrides_;

    // Stereo mix bus (reused each block, fixed size).
    static constexpr int kMaxBlockFrames = 4096;
    float mix_l_[kMaxBlockFrames] = {};
    float mix_r_[kMaxBlockFrames] = {};
    float* mix_[2] = { mix_l_, mix_r_ };

    // Meters (peak hold, updated each block).
    std::atomic<float> meter_l_{0.f};
    std::atomic<float> meter_r_{0.f};

    // Callback stats.
    std::atomic<int>    callback_count_{0};
    std::atomic<double> callback_duration_ms_{0.0};

    // Click-free crossfade around seeks/jumps.
    FadeProcessor fade_;

    // Check whether any track is soloed.
    bool any_solo_active(const Song& song) const noexcept;
};

} // namespace lt
