use std::{
    fs::{self, OpenOptions},
    io::Write,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::audio_engine::AudioDebugSnapshot;
use crate::error::DesktopError;
use crate::midi::get_midi_input_names;
use crate::models::DesktopPerformanceSnapshot;
use crate::remote;
use crate::state::DesktopState;
use libretracks_remote::RemoteServerInfo;

#[tauri::command]
pub fn healthcheck() -> &'static str {
    "libretracks-ready"
}

/// Combined diagnostic snapshot for the audio runtime ownership contract.
///
/// Surfaces both the Rust-side realtime command counters (Category A vs sync_live_mix) and
/// the key C++ snapshot fields (pitch backend identity, fail-fast counters) in a single poll.
/// Intended for developer diagnostics and automated health checks.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnershipDiagnostics {
    // Rust-side Category A counters — should be >> sync_live_mix_count during live operation.
    pub realtime_command_count: u64,
    pub sync_live_mix_count: u64,
    pub metronome_realtime_toggle_count: u64,
    pub metronome_realtime_volume_count: u64,

    // C++ pitch backend identity — must be "rubberband" in a release build.
    pub pitch_backend: String,
    pub pitch_engine_available: bool,
    pub pitch_runtime_enabled: bool,
    pub pitch_muted_or_bypassed_reason: String,

    // Fail-fast counters — any nonzero value is an error in a release build.
    pub pitch_stub_passthrough_blocked_count: u64,
    pub pitch_requested_but_backend_unavailable_count: u64,

    // Realtime stream health — nonzero values indicate render problems.
    pub realtime_pitch_underflow_count: u64,
    pub realtime_pitch_discontinuities: u64,
    pub unsafe_cross_thread_reset_count: u64,
    pub concurrent_stream_mutation_detected: u64,
    pub pitch_audio_thread_reset_count: u64,
    pub pitch_audio_thread_prime_count: u64,

    // C++ CPU load.
    pub callback_duration_ms: f64,
    pub callback_load_percent: f64,
    pub underrun_count: i32,
}

#[tauri::command]
pub fn get_ownership_diagnostics(
    state: State<'_, DesktopState>,
) -> Result<OwnershipDiagnostics, String> {
    let rt = state.audio.realtime_control_diagnostics();

    // Best-effort: if the engine snapshot is unavailable (engine not started), return zeros for
    // C++ fields. The Rust counters are always available.
    let snap = state.audio.engine_snapshot().ok();

    let pitch = snap.as_ref().map(|s| &s.pitch);
    let cpu = snap.as_ref().map(|s| &s.cpu);

    Ok(OwnershipDiagnostics {
        realtime_command_count: rt.live_mix_realtime_command_count,
        sync_live_mix_count: rt.live_mix_sync_live_mix_count,
        metronome_realtime_toggle_count: rt.metronome_realtime_toggle_count,
        metronome_realtime_volume_count: rt.metronome_realtime_volume_count,

        pitch_backend: pitch.map(|p| p.pitch_backend.clone()).unwrap_or_default(),
        pitch_engine_available: pitch.map(|p| p.pitch_engine_available).unwrap_or(false),
        pitch_runtime_enabled: pitch.map(|p| p.pitch_runtime_enabled).unwrap_or(false),
        pitch_muted_or_bypassed_reason: pitch
            .map(|p| p.pitch_muted_or_bypassed_reason.clone())
            .unwrap_or_default(),

        pitch_stub_passthrough_blocked_count: pitch
            .map(|p| p.pitch_stub_passthrough_blocked_count)
            .unwrap_or(0),
        pitch_requested_but_backend_unavailable_count: pitch
            .map(|p| p.pitch_requested_but_backend_unavailable_count)
            .unwrap_or(0),

        realtime_pitch_underflow_count: pitch
            .map(|p| p.realtime_pitch_underflow_count)
            .unwrap_or(0),
        realtime_pitch_discontinuities: pitch
            .map(|p| p.realtime_pitch_discontinuities)
            .unwrap_or(0),
        unsafe_cross_thread_reset_count: pitch
            .map(|p| p.unsafe_cross_thread_reset_count)
            .unwrap_or(0),
        concurrent_stream_mutation_detected: pitch
            .map(|p| p.concurrent_stream_mutation_detected)
            .unwrap_or(0),
        pitch_audio_thread_reset_count: pitch
            .map(|p| p.pitch_audio_thread_reset_count)
            .unwrap_or(0),
        pitch_audio_thread_prime_count: pitch
            .map(|p| p.pitch_audio_thread_prime_count)
            .unwrap_or(0),

        callback_duration_ms: cpu.map(|c| c.callback_duration_ms).unwrap_or(0.0),
        callback_load_percent: cpu.map(|c| c.callback_load_percent).unwrap_or(0.0),
        underrun_count: cpu.map(|c| c.underrun_count).unwrap_or(0),
    })
}

#[tauri::command]
pub fn get_audio_debug_snapshot(
    state: State<'_, DesktopState>,
) -> Result<AudioDebugSnapshot, String> {
    state
        .audio
        .debug_snapshot()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_desktop_performance_snapshot(
    state: State<'_, DesktopState>,
) -> Result<DesktopPerformanceSnapshot, String> {
    let session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    Ok(session.performance_snapshot())
}

#[tauri::command]
pub fn report_ui_render_metric(
    render_millis: f64,
    state: State<'_, DesktopState>,
) -> Result<(), String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;
    session.report_ui_render_metric(render_millis);
    Ok(())
}

#[tauri::command]
pub fn get_remote_server_info(app: AppHandle) -> Result<RemoteServerInfo, String> {
    Ok(remote::remote_server_info(&app))
}

#[tauri::command]
pub fn get_midi_inputs() -> Result<Vec<String>, String> {
    get_midi_input_names()
}

#[tauri::command]
pub fn append_debug_log(app: AppHandle, line: String) -> Result<(), String> {
    let log_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&log_dir).map_err(|error| error.to_string())?;

    let log_path = log_dir.join("transport-dnd.log");
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|error| error.to_string())?;

    let timestamp_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    writeln!(file, "[{timestamp_ms}] {line}").map_err(|error| error.to_string())?;
    Ok(())
}
