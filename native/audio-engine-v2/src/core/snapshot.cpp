#include <lt_engine/core/snapshot.h>
#include <nlohmann/json.hpp>

namespace lt {

using json = nlohmann::json;

static std::string playback_state_str(PlaybackState s) {
    switch (s) {
        case PlaybackState::Stopped: return "stopped";
        case PlaybackState::Playing: return "playing";
        case PlaybackState::Paused:  return "paused";
    }
    return "stopped";
}

std::string snapshot_to_json(const EngineSnapshot& snap) {
    json j;

    j["current_frame"]   = snap.current_frame;
    j["current_seconds"] = snap.current_seconds;
    j["playback_state"]  = playback_state_str(snap.playback_state);

    j["current_song_id"]   = snap.current_song_id.value_or("");
    j["current_region_id"] = snap.current_region_id.value_or("");
    j["current_marker_id"] = snap.current_marker_id.value_or("");

    json jumps = json::array();
    for (const auto& jmp : snap.pending_jumps) {
        jumps.push_back({
            {"jump_id",            jmp.jump_id},
            {"target_description", jmp.target_description},
            {"trigger_description",jmp.trigger_description},
            {"status",             jmp.status},
            {"created_frame",      jmp.created_frame},
        });
    }
    j["pending_jumps"] = jumps;

    j["device"] = {
        {"device_id",   snap.device.device_id},
        {"device_name", snap.device.device_name},
        {"backend",     snap.device.backend},
        {"sample_rate", snap.device.sample_rate},
        {"buffer_size", snap.device.buffer_size},
        {"last_error",  snap.device.last_error},
    };

    j["cpu"] = {
        {"callback_duration_ms",  snap.cpu.callback_duration_ms},
        {"callback_load_percent", snap.cpu.callback_load_percent},
        {"underrun_count",        snap.cpu.underrun_count},
        {"callback_count",        snap.cpu.callback_count},
    };

    j["meters"] = {
        {"left_peak",  snap.meters.left_peak},
        {"right_peak", snap.meters.right_peak},
        {"left_rms",   snap.meters.left_rms},
        {"right_rms",  snap.meters.right_rms},
    };

    json track_meters = json::array();
    for (const auto& m : snap.track_meters) {
        track_meters.push_back({
            {"track_id",   m.track_id},
            {"left_peak",  m.left_peak},
            {"right_peak", m.right_peak},
            {"left_rms",   m.left_rms},
            {"right_rms",  m.right_rms},
        });
    }
    j["track_meters"] = track_meters;

    json sources = json::array();
    for (const auto& s : snap.source_states) {
        sources.push_back({
            {"source_id",        s.source_id},
            {"status",           s.status},
            {"progress_percent", s.progress_percent},
            {"error_message",     s.error_message},
        });
    }
    j["source_states"] = sources;

    j["metronome"] = {
        {"enabled", snap.metronome.enabled},
        {"volume", snap.metronome.volume},
        {"output", snap.metronome.output},
        {"last_beat_frame", snap.metronome.last_beat_frame},
        {"next_beat_frame", snap.metronome.next_beat_frame},
        {"current_bar", snap.metronome.current_bar},
        {"current_beat", snap.metronome.current_beat},
        {"route_resolved", snap.metronome.route_resolved},
        {"rendered_clicks_count", snap.metronome.rendered_clicks_count},
        {"muted_reason", snap.metronome.muted_reason},
    };

    j["pitch"] = {
        {"pitch_engine_available", snap.pitch.pitch_engine_available},
        {"pitch_backend", snap.pitch.pitch_backend},
        {"rubberband_version", snap.pitch.rubberband_version},
        {"pitch_runtime_enabled", snap.pitch.pitch_runtime_enabled},
        {"pitch_processors_prepared", snap.pitch.pitch_processors_prepared},
        {"pitch_processors_missing", snap.pitch.pitch_processors_missing},
        {"pitch_missing_processor_count", snap.pitch.pitch_missing_processor_count},
        {"pitch_prepare_on_source_ready_count", snap.pitch.pitch_prepare_on_source_ready_count},
        {"source_ready_pitch_prepare_count", snap.pitch.source_ready_pitch_prepare_count},
        {"pitch_latency_frames", snap.pitch.pitch_latency_frames},
        {"active_pitch_keys", snap.pitch.active_pitch_keys},
        {"active_song_transpose", snap.pitch.active_song_transpose},
        {"pitch_prepare_queue_length", snap.pitch.pitch_prepare_queue_length},
        {"pitch_prepare_active", snap.pitch.pitch_prepare_active},
        {"pitch_prepare_pending", snap.pitch.pitch_prepare_pending},
        {"pitch_prepare_progress", snap.pitch.pitch_prepare_progress},
        {"pitch_prepare_status", snap.pitch.pitch_prepare_status},
        {"pitch_prepare_message", snap.pitch.pitch_prepare_message},
        {"pitch_reset_count", snap.pitch.pitch_reset_count},
        {"pitch_seek_generation", snap.pitch.pitch_seek_generation},
        {"pitch_starvation_count", snap.pitch.pitch_starvation_count},
        {"pitch_jobs_queued", snap.pitch.pitch_jobs_queued},
        {"pitch_jobs_pending", snap.pitch.pitch_jobs_pending},
        {"pitch_jobs_running", snap.pitch.pitch_jobs_running},
        {"pitch_jobs_completed", snap.pitch.pitch_jobs_completed},
        {"pitch_jobs_failed", snap.pitch.pitch_jobs_failed},
        {"seek_immediate_jobs_queued", snap.pitch.seek_immediate_jobs_queued},
        {"seek_immediate_jobs_completed", snap.pitch.seek_immediate_jobs_completed},
        {"pitch_proxy_blocks_ready", snap.pitch.pitch_proxy_blocks_ready},
        {"pitch_proxy_blocks_missing", snap.pitch.pitch_proxy_blocks_missing},
        {"pitch_proxy_blocks_pending", snap.pitch.pitch_proxy_blocks_pending},
        {"pitch_proxy_prepare_sync_count", snap.pitch.pitch_proxy_prepare_sync_count},
        {"pitch_proxy_prepare_blocking_ms", snap.pitch.pitch_proxy_prepare_blocking_ms},
        {"last_pitch_prepare_reason", snap.pitch.last_pitch_prepare_reason},
        {"active_pitch_render_path", snap.pitch.active_pitch_render_path},
        {"last_pitch_proxy_error", snap.pitch.last_pitch_proxy_error},
        {"last_missing_proxy_key", snap.pitch.last_missing_proxy_key},
        {"last_missing_proxy_block_index", snap.pitch.last_missing_proxy_block_index},
        {"active_pitch_mode", snap.pitch.active_pitch_mode},
        {"realtime_seek_safe_resets", snap.pitch.realtime_seek_safe_resets},
        {"realtime_seek_safe_preroll_frames", snap.pitch.realtime_seek_safe_preroll_frames},
        {"realtime_seek_safe_render_count", snap.pitch.realtime_seek_safe_render_count},
        {"prepared_proxy_render_count", snap.pitch.prepared_proxy_render_count},
        {"emergency_silence_render_count", snap.pitch.emergency_silence_render_count},
        {"stale_proxy_jobs_skipped", snap.pitch.stale_proxy_jobs_skipped},
        {"current_pitch_epoch", snap.pitch.current_pitch_epoch},
        {"disk_cache_audio_thread_load_attempts", snap.pitch.disk_cache_audio_thread_load_attempts},
        {"offline_pitch_segments_rendered", snap.pitch.offline_pitch_segments_rendered},
        {"offline_pitch_segment_failures", snap.pitch.offline_pitch_segment_failures},
        {"offline_pitch_latency_frames", snap.pitch.offline_pitch_latency_frames},
        {"offline_pitch_preroll_frames", snap.pitch.offline_pitch_preroll_frames},
        {"offline_pitch_postroll_frames", snap.pitch.offline_pitch_postroll_frames},
        {"offline_pitch_render_ms", snap.pitch.offline_pitch_render_ms},
        {"last_offline_pitch_error", snap.pitch.last_offline_pitch_error},
        {"pitch_disk_cache_enabled", snap.pitch.pitch_disk_cache_enabled},
        {"pitch_disk_cache_dir", snap.pitch.pitch_disk_cache_dir},
        {"pitch_disk_cache_hits", snap.pitch.pitch_disk_cache_hits},
        {"pitch_disk_cache_misses", snap.pitch.pitch_disk_cache_misses},
        {"pitch_disk_cache_writes", snap.pitch.pitch_disk_cache_writes},
        {"pitch_disk_cache_invalidations", snap.pitch.pitch_disk_cache_invalidations},
        {"pitch_disk_cache_size_bytes", snap.pitch.pitch_disk_cache_size_bytes},
        {"last_pitch_disk_cache_error", snap.pitch.last_pitch_disk_cache_error},
        {"pitch_muted_or_bypassed_reason", snap.pitch.pitch_muted_or_bypassed_reason},
    };

    return j.dump();
}

} // namespace lt
