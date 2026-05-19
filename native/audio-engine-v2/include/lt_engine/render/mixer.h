#pragma once

#include <lt_engine/core/types.h>
#include <lt_engine/core/snapshot.h>
#include <lt_engine/session/session.h>
#include <lt_engine/sources/source_manager.h>
#include <lt_engine/render/track_renderer.h>
#include <lt_engine/render/fade_processor.h>
#include <lt_engine/render/metronome_renderer.h>
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
          JumpScheduler*       scheduler);

    Mixer(std::shared_ptr<const Session> session,
          const SourceManager* sources,
          TransportClock* clock,
          JumpScheduler* scheduler);

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
    void start_master_fade(float target_gain, double duration_seconds) noexcept;
    // preserve_realtime_state=true: keep existing gain/pan/mute/solo atomics for known tracks
    //   (used for session pointer swaps during transpose/region changes — slider state survives).
    // preserve_realtime_state=false: always load values from session
    //   (used after LoadSession — the session IS the source of truth for mixer values).
    void set_session(std::shared_ptr<const Session> session, bool preserve_realtime_state = true);
    void set_bungee_voice_manager(class BungeeVoiceManager* mgr) noexcept;
    void clear_session();
    void prepare_render_resources(int max_block_frames) noexcept;
    void trigger_crossfade() noexcept;
    void set_metronome_config(const MetronomeConfig& config);
    void set_metronome_enabled(bool enabled);
    void set_metronome_volume(float volume);
    MetronomeDiagnostics metronome_diagnostics() const;

    // Meter read (from UI thread — relaxed atomic).
    MeterValues meters() const noexcept;
    std::vector<TrackMeterValues> track_meters() const;

    // Diagnostic counters.
    int    callback_count()          const noexcept;
    double callback_duration_ms()    const noexcept;
    double callback_duration_max_ms() const noexcept;
    std::uint64_t callback_over_budget_count() const noexcept;
    std::uint64_t rendered_track_count() const noexcept;
    std::uint64_t skipped_track_count() const noexcept;
    std::uint64_t scheduled_jump_executed_count() const noexcept;

    // Called from the control thread to check if a scheduled jump executed inside the audio
    // callback since the last call. Returns the target frame if one did, or -1 otherwise.
    // The control thread must then call prepare_for_transport_discontinuity for that frame.
    // This is the mechanism that ensures pitch streams are primed before a scheduled jump
    // becomes audible — the jump fires in the audio callback (atomic clock seek + crossfade),
    // and the control thread repairs pitch alignment immediately after.
    Frame take_pending_scheduled_jump() noexcept;

    // Sentinel returned by take_pending_scheduled_jump() when no jump is pending.
    static constexpr Frame kNoJumpPending = -1;

private:
    std::shared_ptr<const Session> session_;
    const SourceManager* sources_;
    TransportClock*      clock_;
    JumpScheduler*       scheduler_;
    class BungeeVoiceManager* bungee_voices_ = nullptr;

    // Per-track renderer pool (one per track, up to kMaxTracks).
    // Allocated once on construction, never in render().
    static constexpr int kMaxTracks = 64;
    std::array<TrackRenderer, kMaxTracks> renderers_;

    // Per-track mix overrides (command thread writes, audio thread reads).
    struct TrackControlState {
        Id track_id;
        Id parent_track_id;
        int parent_control_index = -1;     // index into controls_[], -1 = no parent
        bool is_folder = false;
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
    static constexpr int kMaxFolderDepth  = 8;
    std::array<TrackControlState, kMaxControlSlots> controls_;
    std::atomic<int> control_count_{0};
    TrackControlState fallback_control_;

    // Compute effective (folder-chained) controls for a track slot.
    // Must only be called from the audio thread.
    struct EffectiveControls {
        float target_gain;
        float target_pan;
        bool  target_muted;
        float target_solo_gain;
    };
    EffectiveControls compute_effective_controls(int slot_index, bool solo_active) const noexcept;

    // Solo eligibility: true if track or any ancestor is soloed, or no solo is active at all.
    bool is_solo_eligible(int slot_index) const noexcept;

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
    std::atomic<double> callback_duration_max_ms_{0.0};
    std::atomic<std::uint64_t> callback_over_budget_count_{0};
    std::atomic<std::uint64_t> rendered_track_count_{0};
    std::atomic<std::uint64_t> skipped_track_count_{0};
    std::atomic<std::uint64_t> scheduled_jump_executed_count_{0};

    std::atomic<std::uint64_t> master_fade_request_seq_{0};
    std::atomic<float> master_fade_target_gain_{1.0f};
    std::atomic<double> master_fade_duration_seconds_{0.0};
    std::uint64_t master_fade_applied_seq_ = 0;
    float master_gain_current_ = 1.0f;
    float master_gain_start_ = 1.0f;
    float master_gain_target_ = 1.0f;
    int master_fade_total_frames_ = 0;
    int master_fade_processed_frames_ = 0;

    // When a scheduled jump fires inside the audio callback, the target frame is written here
    // so the control thread can call prepare_for_transport_discontinuity() for pitch.
    // Sentinel: -1 means no pending jump. Written from audio thread, read from control thread.
    std::atomic<Frame> pending_scheduled_jump_frame_{kNoJumpPending};

    // Click-free crossfade around seeks/jumps.
    FadeProcessor fade_;
    MetronomeRenderer metronome_;

    // Check whether any track is soloed (scans control slots).
    bool any_solo_active_in_slots() const noexcept;
    void reset_track_meters() noexcept;
    void render_timeline_span(float** output_channels,
                              int num_channels,
                              int num_frames,
                              int output_offset,
                              const std::shared_ptr<const Session>& session) noexcept;
    void apply_master_gain(float** output_channels, int num_channels, int num_frames) noexcept;
    TrackControlState* control_for_track(const Id& track_id) noexcept;
    const TrackControlState* control_for_track(const Id& track_id) const noexcept;
    int control_index_for_track(const Id& track_id) const noexcept;
    void rebuild_control_slots(std::shared_ptr<const Session> session, bool preserve_realtime_state);
};

} // namespace lt
