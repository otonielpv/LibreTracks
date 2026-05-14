#pragma once

#include <lt_engine/core/types.h>
#include <lt_engine/core/snapshot.h>
#include <lt_engine/session/session.h>
#include <lt_engine/sources/source_manager.h>
#include <lt_engine/render/track_renderer.h>
#include <lt_engine/render/fade_processor.h>
#include <lt_engine/render/metronome_renderer.h>
#include <lt_engine/pitch/pitch_cache.h>
#include <lt_engine/pitch/realtime_pitch_engine.h>
#include <lt_engine/devices/audio_device_manager.h>
#include <lt_engine/transport/transport_clock.h>
#include <lt_engine/scheduler/jump_scheduler.h>
#include <array>
#include <atomic>
#include <memory>
#include <string>
#include <vector>

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
          JumpScheduler*       scheduler,
          PitchCache*          pitch_cache = nullptr,
          RealtimePitchEngine* pitch_engine = nullptr);

    Mixer(std::shared_ptr<const Session> session,
          const SourceManager* sources,
          TransportClock* clock,
          JumpScheduler* scheduler,
          PitchCache* pitch_cache = nullptr,
          RealtimePitchEngine* pitch_engine = nullptr);

    // Called by the JUCE audio thread.
    void render(float** output_channels,
                int     num_channels,
                int     num_frames,
                double  sample_rate) noexcept override;

    // Called from command thread to update track gain/mute/solo atomically.
    // Changes take effect at the next render block.
    void set_track_gain(const Id& track_id, Gain gain);
    void set_track_pan(const Id& track_id, float pan);
    void set_track_mute(const Id& track_id, bool mute);
    void set_track_solo(const Id& track_id, bool solo);
    void set_session(std::shared_ptr<const Session> session);
    void set_pitch_cache(PitchCache* pitch_cache) noexcept;
    void set_pitch_engine(RealtimePitchEngine* pitch_engine) noexcept;
    void clear_session();
    void trigger_crossfade() noexcept;
    void set_metronome_config(const MetronomeConfig& config);
    MetronomeDiagnostics metronome_diagnostics() const;

    // Meter read (from UI thread — relaxed atomic).
    MeterValues meters() const noexcept;
    std::vector<TrackMeterValues> track_meters() const;

    // Diagnostic counters.
    int    callback_count()          const noexcept;
    double callback_duration_ms()    const noexcept;

private:
    std::shared_ptr<const Session> session_;
    const SourceManager* sources_;
    TransportClock*      clock_;
    JumpScheduler*       scheduler_;
    PitchCache*          pitch_cache_ = nullptr;
    RealtimePitchEngine* pitch_engine_ = nullptr;

    // Per-track renderer pool (one per track, up to kMaxTracks).
    // Allocated once on construction, never in render().
    static constexpr int kMaxTracks = 64;
    std::array<TrackRenderer, kMaxTracks> renderers_;

    // Per-track mix overrides (command thread writes, audio thread reads).
    struct TrackControlState {
        Id track_id;
        std::atomic<float> gain{1.0f};
        std::atomic<float> pan{0.0f};
        std::atomic<bool>  mute{false};
        std::atomic<bool>  solo{false};
        float current_gain = 1.0f;
        float current_pan = 0.0f;
        float current_mute_gain = 1.0f;
        float current_solo_gain = 1.0f;
        bool initialized = false;
    };
    static constexpr int kMaxControlSlots = 256;
    std::array<TrackControlState, kMaxControlSlots> controls_;
    std::atomic<int> control_count_{0};
    TrackControlState fallback_control_;

    // Stereo mix bus (reused each block, fixed size).
    static constexpr int kMaxBlockFrames = 4096;
    float mix_l_[kMaxBlockFrames] = {};
    float mix_r_[kMaxBlockFrames] = {};
    float* mix_[2] = { mix_l_, mix_r_ };

    // Meters (peak hold, updated each block).
    std::atomic<float> meter_l_{0.f};
    std::atomic<float> meter_r_{0.f};
    std::atomic<float> meter_l_rms_{0.f};
    std::atomic<float> meter_r_rms_{0.f};

    struct TrackMeterSlot {
        std::atomic<float> left_peak{0.f};
        std::atomic<float> right_peak{0.f};
        std::atomic<float> left_rms{0.f};
        std::atomic<float> right_rms{0.f};
    };
    std::array<TrackMeterSlot, kMaxTracks> track_meters_;
    std::atomic<int> track_meter_count_{0};

    // Callback stats.
    std::atomic<int>    callback_count_{0};
    std::atomic<double> callback_duration_ms_{0.0};

    // Click-free crossfade around seeks/jumps.
    FadeProcessor fade_;
    MetronomeRenderer metronome_;

    // Check whether any track is soloed.
    bool any_solo_active(const Song& song) const noexcept;
    void reset_track_meters() noexcept;
    TrackControlState* control_for_track(const Id& track_id) noexcept;
    const TrackControlState* control_for_track(const Id& track_id) const noexcept;
    void rebuild_control_slots(std::shared_ptr<const Session> session);
};

} // namespace lt
