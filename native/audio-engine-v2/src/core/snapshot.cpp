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
    j["transport_pending_start"] = snap.transport_pending_start;

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
        {"output_channel_count", snap.device.output_channel_count},
        {"output_channel_names", snap.device.output_channel_names},
        {"last_error",  snap.device.last_error},
    };

    j["cpu"] = {
        {"callback_duration_ms",  snap.cpu.callback_duration_ms},
        {"callback_duration_max_ms", snap.cpu.callback_duration_max_ms},
        {"callback_load_percent", snap.cpu.callback_load_percent},
        {"underrun_count",        snap.cpu.underrun_count},
        {"callback_count",        snap.cpu.callback_count},
        {"callback_over_budget_count", snap.cpu.callback_over_budget_count},
        {"mixer_rendered_track_count", snap.cpu.mixer_rendered_track_count},
        {"mixer_skipped_track_count", snap.cpu.mixer_skipped_track_count},
        {"track_renderer_prepare_count", snap.cpu.track_renderer_prepare_count},
        {"track_renderer_scratch_resize_count", snap.cpu.track_renderer_scratch_resize_count},
        {"track_renderer_scratch_resize_in_audio_thread_count", snap.cpu.track_renderer_scratch_resize_in_audio_thread_count},
        {"track_renderer_block_too_large_count", snap.cpu.track_renderer_block_too_large_count},
        {"track_renderer_scratch_capacity_frames", snap.cpu.track_renderer_scratch_capacity_frames},
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

    json region_meters = json::array();
    for (const auto& m : snap.region_meters) {
        region_meters.push_back({
            {"region_id", m.region_id},
            {"peak",      m.peak},
        });
    }
    j["region_meters"] = region_meters;

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
    j["source_cache"] = {
        {"ram_bytes_used", snap.source_cache.ram_bytes_used},
        {"ram_bytes_capacity", snap.source_cache.ram_bytes_capacity},
        {"disk_bytes_used", snap.source_cache.disk_bytes_used},
        {"blocks_cached", snap.source_cache.blocks_cached},
        {"blocks_hit", snap.source_cache.blocks_hit},
        {"blocks_miss", snap.source_cache.blocks_miss},
    };

    // Phase 8: prearmed-jumps diagnostics for the UI.
    j["prearmed_jumps"] = {
        {"ready_count",          snap.prearmed_jumps.ready_count},
        {"prepared_total",       snap.prearmed_jumps.prepared_total},
        {"prepare_failed_total", snap.prearmed_jumps.prepare_failed_total},
        {"take_hit_total",       snap.prearmed_jumps.take_hit_total},
        {"take_miss_total",      snap.prearmed_jumps.take_miss_total},
        {"stale_discard_total",  snap.prearmed_jumps.stale_discard_total},
        {"eviction_total",       snap.prearmed_jumps.eviction_total},
        {"max_prepared_targets", snap.prearmed_jumps.max_prepared_targets},
        {"worker_busy",             snap.prearmed_jumps.worker_busy},
        {"latest_posted_revision",  snap.prearmed_jumps.latest_posted_revision},
        {"last_completed_revision", snap.prearmed_jumps.last_completed_revision},
        {"posted_count",            snap.prearmed_jumps.posted_count},
        {"completed_count",         snap.prearmed_jumps.completed_count},
        {"active_target_total",     snap.prearmed_jumps.active_target_total},
        {"active_target_completed", snap.prearmed_jumps.active_target_completed},
    };

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
        {"current_gain", snap.metronome.current_gain},
        {"target_gain", snap.metronome.target_gain},
        {"toggle_count", snap.metronome.toggle_count},
    };

    j["pitch"] = {
        {"mixer_scheduled_jump_executed_count",
         snap.mixer_scheduled_jump_executed_count},
    };

    return j.dump();
}

} // namespace lt
