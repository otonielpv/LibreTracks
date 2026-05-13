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

struct PitchSnapshot {
    bool        pitch_engine_available = false;
    std::string pitch_backend = "disabled";
    std::string rubberband_version;
    bool        pitch_runtime_enabled = false;
    std::size_t pitch_processors_prepared = 0;
    std::size_t pitch_processors_missing = 0;
    uint64_t    pitch_missing_processor_count = 0;
    uint64_t    pitch_prepare_on_source_ready_count = 0;
    uint64_t    source_ready_pitch_prepare_count = 0;
    int         pitch_latency_frames = 0;
    std::vector<std::string> active_pitch_keys;
    Semitones   active_song_transpose = 0;
    int         pitch_prepare_queue_length = 0;
    bool        pitch_prepare_active = false;
    bool        pitch_prepare_pending = false;
    double      pitch_prepare_progress = 1.0;
    std::string pitch_prepare_status = "idle";
    std::string pitch_prepare_message;
    uint64_t    pitch_reset_count = 0;
    uint64_t    pitch_seek_generation = 0;
    uint64_t    pitch_starvation_count = 0;
    uint64_t    pitch_jobs_queued = 0;
    uint64_t    pitch_jobs_pending = 0;
    uint64_t    pitch_jobs_running = 0;
    uint64_t    pitch_jobs_completed = 0;
    uint64_t    pitch_jobs_failed = 0;
    uint64_t    seek_immediate_jobs_queued = 0;
    uint64_t    seek_immediate_jobs_completed = 0;
    std::size_t pitch_proxy_blocks_ready = 0;
    std::size_t pitch_proxy_blocks_missing = 0;
    std::size_t pitch_proxy_blocks_pending = 0;
    uint64_t    pitch_proxy_prepare_sync_count = 0;
    double      pitch_proxy_prepare_blocking_ms = 0.0;
    std::string last_pitch_prepare_reason;
    std::string active_pitch_render_path;
    std::string last_pitch_proxy_error;
    std::string last_missing_proxy_key;
    int         last_missing_proxy_block_index = -1;
    std::string active_pitch_mode;
    uint64_t    offline_pitch_segments_rendered = 0;
    uint64_t    offline_pitch_segment_failures = 0;
    int         offline_pitch_latency_frames = 0;
    int         offline_pitch_preroll_frames = 0;
    int         offline_pitch_postroll_frames = 0;
    double      offline_pitch_render_ms = 0.0;
    std::string last_offline_pitch_error;
    bool        pitch_disk_cache_enabled = false;
    std::string pitch_disk_cache_dir;
    uint64_t    pitch_disk_cache_hits = 0;
    uint64_t    pitch_disk_cache_misses = 0;
    uint64_t    pitch_disk_cache_writes = 0;
    uint64_t    pitch_disk_cache_invalidations = 0;
    uint64_t    pitch_disk_cache_size_bytes = 0;
    std::string last_pitch_disk_cache_error;
    std::string pitch_muted_or_bypassed_reason;
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

    // Pitch processing diagnostics
    PitchSnapshot pitch;
};

std::string snapshot_to_json(const EngineSnapshot& snap);

} // namespace lt
