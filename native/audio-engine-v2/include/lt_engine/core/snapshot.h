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
    std::string last_error;
};

struct CpuDiagnostics {
    double callback_duration_ms  = 0.0;
    double callback_load_percent = 0.0;
    int    underrun_count        = 0;
    int    callback_count        = 0;
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
};

struct EngineSnapshot {
    // Transport position
    Frame              current_frame   = 0;
    double             current_seconds = 0.0;
    PlaybackState      playback_state  = PlaybackState::Stopped;

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
};

std::string snapshot_to_json(const EngineSnapshot& snap);

} // namespace lt
