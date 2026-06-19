use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::audio_engine::AudioDebugSnapshot;
use crate::error::DesktopError;
use crate::midi::get_midi_input_names;
use crate::models::{DesktopPerformanceSnapshot, SystemResourceSnapshot};
use crate::remote;
use crate::state::DesktopState;
use libretracks_remote::RemoteServerInfo;

#[tauri::command]
pub fn healthcheck() -> &'static str {
    "libretracks-ready"
}

#[tauri::command]
pub fn is_debug_build() -> bool {
    cfg!(debug_assertions)
}

/// Combined diagnostic snapshot for the audio runtime ownership contract.
///
/// Surfaces both the Rust-side realtime command counters (Category A vs legacy sync) and
/// the key C++ snapshot fields (pitch backend identity, fail-fast counters) in a single poll.
/// Intended for developer diagnostics and automated health checks.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnershipDiagnostics {
    // Rust-side Category A counters.
    pub realtime_command_count: u64,
    pub metronome_realtime_toggle_count: u64,
    pub metronome_realtime_volume_count: u64,
    /// Pointer-up commits that updated mixer state + sent one targeted Category A command.
    pub commit_mix_command_count: u64,
    /// Pointer-up commits that updated pitch runtime (transpose_enabled, region_transpose).
    pub commit_pitch_command_count: u64,
    /// Tempo/time-signature commits pushed to C++ without reloading sources.
    pub transport_timing_update_count: u64,
    /// Model-only commits (name, visual metadata) — no audio command sent.
    pub commit_model_only_count: u64,
    /// Structural session rebuilds (LoadSession). Nonzero is expected only for StructureRebuild.
    pub session_rebuild_count: u64,
    /// Reason string from the most recent `replace_song_buffers` call.
    pub last_session_rebuild_reason: String,

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

    // Repair cycle health — repair_requested should equal repair_completed in steady state.
    pub pitch_repair_requested_count: u64,
    pub pitch_repair_completed_count: u64,

    // Scheduled jumps fired in audio callback (nonzero during live performance).
    pub mixer_scheduled_jump_executed_count: u64,

    // C++ CPU load.
    pub callback_duration_ms: f64,
    pub callback_load_percent: f64,
    pub underrun_count: i32,
    /// Frames played as silence due to streaming prebuffer starvation. Nonzero
    /// is the "audio silent until it catches up" symptom on slow machines.
    pub source_cache_miss_frames: u64,
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
        metronome_realtime_toggle_count: rt.metronome_realtime_toggle_count,
        metronome_realtime_volume_count: rt.metronome_realtime_volume_count,
        commit_mix_command_count: rt.commit_mix_command_count,
        commit_pitch_command_count: rt.commit_pitch_command_count,
        transport_timing_update_count: rt.transport_timing_update_count,
        commit_model_only_count: rt.commit_model_only_count,
        session_rebuild_count: rt.session_rebuild_count,
        last_session_rebuild_reason: rt.last_session_rebuild_reason.clone(),

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

        pitch_repair_requested_count: pitch.map(|p| p.pitch_repair_requested_count).unwrap_or(0),
        pitch_repair_completed_count: pitch.map(|p| p.pitch_repair_completed_count).unwrap_or(0),
        mixer_scheduled_jump_executed_count: pitch
            .map(|p| p.mixer_scheduled_jump_executed_count)
            .unwrap_or(0),

        callback_duration_ms: cpu.map(|c| c.callback_duration_ms).unwrap_or(0.0),
        callback_load_percent: cpu.map(|c| c.callback_load_percent).unwrap_or(0.0),
        underrun_count: cpu.map(|c| c.underrun_count).unwrap_or(0),
        source_cache_miss_frames: cpu.map(|c| c.source_cache_miss_frames).unwrap_or(0),
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

/// Sample current OS resource usage (CPU / RAM / disk) for the top-bar meter.
///
/// Independent of the session lock — see `ResourceMonitor` — so polling this
/// at ~1 Hz never contends with heavy session work.
#[tauri::command]
pub fn get_system_resource_snapshot(
    state: State<'_, DesktopState>,
) -> Result<SystemResourceSnapshot, String> {
    let mut snapshot = state.resource_monitor.sample();

    // Augment with the audio-callback load — the equivalent of Ableton's
    // transport CPU meter. Best-effort: if the engine isn't running the
    // snapshot is unavailable and the audio fields stay at their defaults
    // (0 / inactive). Same source as get_ownership_diagnostics.
    if let Ok(engine) = state.audio.engine_snapshot() {
        snapshot.audio_load_percent = engine.cpu.callback_load_percent;
        snapshot.audio_underrun_count = engine.cpu.underrun_count;
        snapshot.audio_engine_active = true;
    }

    Ok(snapshot)
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

/// Fetch the latest GitHub release metadata from the Rust side.
///
/// The in-app update check used to call `fetch()` directly from the WebView.
/// In packaged release builds that request originates from the `tauri://`
/// origin and GitHub's API rejected it (CORS / missing User-Agent), so the
/// promise rejected, the error was swallowed, and the update modal never
/// appeared — even though the same code worked in `dev` (origin
/// `http://127.0.0.1:1420`). Doing the request in Rust avoids the WebView's
/// origin restrictions entirely and lets us set the `User-Agent` header that
/// the GitHub API requires.
///
/// Returns the raw JSON body so the existing TypeScript parser
/// (`fetchLatestRelease`) stays the single source of truth for shape and
/// filtering (draft / prerelease). Outcomes are appended to the update log so
/// the check is diagnosable in production, where DevTools is unavailable.
#[tauri::command]
pub async fn fetch_latest_release(app: AppHandle, url: String) -> Result<String, String> {
    let user_agent = format!("LibreTracks/{}", env!("CARGO_PKG_VERSION"));

    let log = |line: String| append_update_log(&app, &line);

    let client = match reqwest::Client::builder()
        .user_agent(user_agent)
        .timeout(std::time::Duration::from_secs(15))
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            let message = format!("client build failed: {error}");
            log(message.clone());
            return Err(message);
        }
    };

    let response = match client
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => {
            let message = format!("request to {url} failed: {error}");
            log(message.clone());
            return Err(message);
        }
    };

    let status = response.status();
    let body = match response.text().await {
        Ok(body) => body,
        Err(error) => {
            let message = format!("reading response body failed: {error}");
            log(message.clone());
            return Err(message);
        }
    };

    if !status.is_success() {
        let message = format!("GitHub API returned {status}");
        log(format!("{message}; body: {body}"));
        return Err(message);
    }

    log(format!("fetched latest release OK ({status})"));
    Ok(body)
}

/// Append a line to the dedicated update-check log inside the app data dir.
/// Best-effort: logging must never make the update check itself fail.
fn append_update_log(app: &AppHandle, line: &str) {
    let Ok(log_dir) = app.path().app_data_dir() else {
        return;
    };
    if fs::create_dir_all(&log_dir).is_err() {
        return;
    }
    let log_path = log_dir.join("update-check.log");
    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&log_path) else {
        return;
    };
    let timestamp_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let _ = writeln!(file, "[{timestamp_ms}] {line}");
}

#[tauri::command]
pub fn append_debug_log(app: AppHandle, line: String) -> Result<(), String> {
    let log_dir = {
        #[cfg(target_os = "windows")]
        {
            std::env::var_os("LOCALAPPDATA")
                .map(PathBuf::from)
                .map(|dir| dir.join("LibreTracks"))
        }
        #[cfg(not(target_os = "windows"))]
        {
            None
        }
    }
    .or_else(|| app.path().app_local_data_dir().ok())
    .or_else(|| app.path().app_data_dir().ok())
    .ok_or_else(|| "could not resolve app log directory".to_string())?;
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

/// Read the dedicated error log (`logs/errors.log`) so the Diagnostics panel
/// can show / let the user copy it. Returns an empty string if it doesn't
/// exist yet (no errors have been recorded).
#[tauri::command]
pub fn read_error_log() -> Result<String, String> {
    let Some(path) = crate::error_log::errors_path() else {
        return Err("error logger not initialized".into());
    };
    match fs::read_to_string(&path) {
        Ok(contents) => Ok(contents),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(error.to_string()),
    }
}

/// Append a frontend-originated error (uncaught exception, rejected promise,
/// failed invoke) to the same error log as backend panics/command failures.
#[tauri::command]
pub fn append_frontend_error(message: String) -> Result<(), String> {
    crate::error_log::write_error(&format!("frontend: {message}"));
    Ok(())
}

/// Reveal the error log in the OS file manager so the user can attach it to a
/// bug report.
#[tauri::command]
pub fn reveal_error_log(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    let path = crate::error_log::errors_path()
        .ok_or_else(|| "error logger not initialized".to_string())?;
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|error| error.to_string())
}
