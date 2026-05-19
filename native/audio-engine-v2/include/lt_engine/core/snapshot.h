#pragma once

#include <lt_engine/core/types.h>
#include <optional>
#include <string>
#include <cstdint>
#include <vector>

namespace lt {

// ---------------------------------------------------------------------------
// EngineSnapshot — complete, read-only view of engine state.
// Polled by the Rust/Tauri layer at UI refresh rate (~60 Hz).
// ---------------------------------------------------------------------------

enum class PlaybackState { Stopped, Playing, Paused };

struct PendingJumpInfo {
    Id          jump_id;
    std::string target_description;
    std::string trigger_description;
    std::string status;   // "pending" | "armed" | "cancelled" | "executed" | "failed"
    Frame       created_frame;
};

struct DeviceInfo {
    std::string device_id;
    std::string device_name;
    std::string backend;
    int         sample_rate  = 0;
    int         buffer_size  = 0;
    int         output_channel_count = 2;
    std::vector<std::string> output_channel_names;
    std::string last_error;
};

struct CpuDiagnostics {
    double callback_duration_ms  = 0.0;
    double callback_duration_max_ms = 0.0;
    double callback_load_percent = 0.0;
    int    underrun_count        = 0;
    int    callback_count        = 0;
    uint64_t callback_over_budget_count = 0;
    uint64_t mixer_rendered_track_count = 0;
    uint64_t mixer_skipped_track_count = 0;
    uint64_t track_renderer_prepare_count = 0;
    uint64_t track_renderer_scratch_resize_count = 0;
    uint64_t track_renderer_scratch_resize_in_audio_thread_count = 0;
    uint64_t track_renderer_block_too_large_count = 0;
    int track_renderer_scratch_capacity_frames = 0;
};

struct MeterValues {
    float left_peak   = 0.f;
    float right_peak  = 0.f;
    float left_rms    = 0.f;
    float right_rms   = 0.f;
};

struct TrackMeterValues {
    Id    track_id;
    float left_peak   = 0.f;
    float right_peak  = 0.f;
    float left_rms    = 0.f;
    float right_rms   = 0.f;
};

struct SourcePreparationInfo {
    Id          source_id;
    std::string status;   // "queued" | "running" | "completed" | "failed"
    int         progress_percent = 0;
    std::string error_message;
};

struct MetronomeSnapshot {
    bool        enabled = false;
    float       volume = 0.f;
    std::string output;
    Frame       last_beat_frame = -1;
    Frame       next_beat_frame = 0;
    int         current_bar = 1;
    int         current_beat = 1;
    std::string route_resolved;
    uint64_t    rendered_clicks_count = 0;
    std::string muted_reason;
    float       current_gain = 0.f;
    float       target_gain = 0.f;
    uint64_t    toggle_count = 0;
};

struct EngineSnapshot {
    // Transport position
    Frame              current_frame   = 0;
    double             current_seconds = 0.0;
    PlaybackState      playback_state  = PlaybackState::Stopped;
    bool               transport_pending_start = false;

    // Session context
    std::optional<Id>  current_song_id;
    std::optional<Id>  current_region_id;
    std::optional<Id>  current_marker_id;

    // Scheduler
    std::vector<PendingJumpInfo> pending_jumps;

    // Device
    DeviceInfo         device;

    // CPU / performance
    CpuDiagnostics     cpu;

    // Meters
    MeterValues        meters;
    std::vector<TrackMeterValues> track_meters;

    // Source preparation
    std::vector<SourcePreparationInfo> source_states;

    // Internal metronome
    MetronomeSnapshot metronome;

    std::uint64_t mixer_scheduled_jump_executed_count = 0;

    // Phase 8: prearmed-jump manager diagnostics. All counters monotonic
    // since engine init; ready_count is the live cache size.
    struct PrearmedJumps {
        int           ready_count          = 0;
        std::uint64_t prepared_total       = 0;
        std::uint64_t prepare_failed_total = 0;
        std::uint64_t take_hit_total       = 0;
        std::uint64_t take_miss_total      = 0;
        std::uint64_t stale_discard_total  = 0;
        std::uint64_t eviction_total       = 0;
        int           max_prepared_targets = 0;
    } prearmed_jumps;
};

std::string snapshot_to_json(const EngineSnapshot& snap);

} // namespace lt
