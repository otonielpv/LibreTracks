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
    uint64_t    realtime_seek_safe_resets = 0;
    uint64_t    realtime_pitch_underflow_count = 0;
    uint64_t    realtime_pitch_discontinuities = 0;
    uint64_t    realtime_seek_safe_preroll_frames = 0;
    int         realtime_pitch_start_pad_frames = 0;
    int         realtime_pitch_start_delay_frames = 0;
    int         realtime_pitch_preroll_frames = 0;
    int         realtime_pitch_discarded_frames = 0;
    uint64_t    realtime_seek_safe_render_count = 0;
    uint64_t    prepared_proxy_render_count = 0;
    uint64_t    emergency_silence_render_count = 0;
    uint64_t    active_stream_set_generation = 0;
    uint64_t    active_pitch_stream_count = 0;
    uint64_t    pitch_timeline_mismatch_count = 0;
    uint64_t    pitch_stream_not_aligned_count = 0;
    uint64_t    pitch_audio_thread_reset_count = 0;
    uint64_t    pitch_audio_thread_prime_count = 0;
    uint64_t    stream_generation = 0;
    uint64_t    stream_reset_thread_id = 0;
    uint64_t    stream_render_thread_id = 0;
    uint64_t    unsafe_cross_thread_reset_count = 0;
    uint64_t    concurrent_stream_mutation_detected = 0;
    uint64_t    active_stream_swap_count = 0;
    uint64_t    long_seek_count = 0;
    Frame       last_transport_discontinuity_target_frame = 0;
    std::string last_transport_discontinuity_reason;
    uint64_t    stale_proxy_jobs_skipped = 0;
    uint64_t    current_pitch_epoch = 0;
    uint64_t    disk_cache_audio_thread_load_attempts = 0;
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

    // Phase 1: backend identity fields
    std::string pitch_backend_detail;            // e.g. "rubberband v3.3.0" or "stub (passthrough blocked)"
    uint64_t    pitch_requested_but_backend_unavailable_count = 0;
    uint64_t    pitch_stub_passthrough_count = 0;
    uint64_t    pitch_stub_passthrough_blocked_count = 0;
    uint64_t    pitch_missing_stream_silence_count = 0;
    Semitones   last_effective_semitones = 0;
    std::string last_pitch_track_id;
    std::string last_pitch_clip_id;
    std::string last_pitch_reason;

    // Phase 9: repair cycle and scheduled-jump counters
    uint64_t    pitch_repair_requested_count = 0;
    uint64_t    pitch_repair_completed_count = 0;
    uint64_t    mixer_scheduled_jump_executed_count = 0;
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
