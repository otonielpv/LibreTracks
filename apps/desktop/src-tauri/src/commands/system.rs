use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::audio::engine::{AudioDebugSnapshot, AudioOutputMeterLevel};
use crate::infra::error::DesktopError;
use crate::midi::get_midi_input_names;
use crate::midi::output::{get_midi_output_names, OutboundMidiMessage};
use crate::models::{DesktopPerformanceSnapshot, SystemResourceSnapshot};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use crate::remote;
use crate::state::DesktopState;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use libretracks_remote::RemoteServerInfo;

#[tauri::command]
pub fn healthcheck() -> &'static str {
    "libretracks-ready"
}

#[tauri::command]
pub fn is_debug_build() -> bool {
    cfg!(debug_assertions)
}

/// Broad, non-identifying build platform used only after analytics opt-in.
/// Compile-time values avoid unreliable User-Agent architecture detection and
/// deliberately expose no model, hostname, OS version or hardware details.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryPlatform {
    pub os: &'static str,
    pub arch: &'static str,
    pub device_class: &'static str,
}

#[tauri::command]
pub fn get_telemetry_platform() -> TelemetryPlatform {
    let os = if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else if cfg!(target_os = "android") {
        "android"
    } else if cfg!(target_os = "ios") {
        "ios"
    } else {
        "unknown"
    };
    let arch = if cfg!(target_arch = "x86_64") {
        "x86_64"
    } else if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "unknown"
    };
    let device_class = if cfg!(target_os = "android") || cfg!(target_os = "ios") {
        "mobile"
    } else {
        "desktop"
    };

    TelemetryPlatform {
        os,
        arch,
        device_class,
    }
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

    /// Warp timing invariants, surfaced so an end-to-end test can assert them
    /// against the real app. `warp_feed_gap_frames` must stay 0 while playing;
    /// fed/made is the stretch ratio the engine actually delivered.
    pub warp_feed_gap_frames: u64,
    pub warp_feed_gap_events: u64,
    pub warp_source_frames_fed: u64,
    pub warp_output_frames_made: u64,

    /// Prearmed-jump cache. A jump that HITS is instant; a jump that MISSES
    /// makes the engine publish an empty voice map and rebuild asynchronously,
    /// which is silence for as long as the rebuild takes. So the hit rate is
    /// the direct measure of "do jumps sound instant".
    pub prearm_ready_count: i32,
    pub prearm_take_hit_total: u64,
    pub prearm_take_miss_total: u64,
    pub prearm_stale_discard_total: u64,
    pub prearm_prepared_total: u64,
    pub prearm_prepare_failed_total: u64,
    pub prearm_worker_busy: bool,
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
    let prearm = snap.as_ref().map(|s| &s.prearmed_jumps);

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

        warp_feed_gap_frames: cpu.map(|c| c.warp_feed_gap_frames).unwrap_or(0),
        warp_feed_gap_events: cpu.map(|c| c.warp_feed_gap_events).unwrap_or(0),
        warp_source_frames_fed: cpu.map(|c| c.warp_source_frames_fed).unwrap_or(0),
        warp_output_frames_made: cpu.map(|c| c.warp_output_frames_made).unwrap_or(0),

        prearm_ready_count: prearm.map(|p| p.ready_count).unwrap_or(0),
        prearm_take_hit_total: prearm.map(|p| p.take_hit_total).unwrap_or(0),
        prearm_take_miss_total: prearm.map(|p| p.take_miss_total).unwrap_or(0),
        prearm_stale_discard_total: prearm.map(|p| p.stale_discard_total).unwrap_or(0),
        prearm_prepared_total: prearm.map(|p| p.prepared_total).unwrap_or(0),
        prearm_prepare_failed_total: prearm.map(|p| p.prepare_failed_total).unwrap_or(0),
        prearm_worker_busy: prearm.map(|p| p.worker_busy).unwrap_or(false),
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
pub fn get_audio_output_meter(
    state: State<'_, DesktopState>,
) -> Result<AudioOutputMeterLevel, String> {
    state
        .audio
        .current_output_meter_level()
        .map_err(|error| error.to_string())
}

/// E2E-only: available only when the native engine was built with capture.
#[tauri::command]
pub fn get_audio_output_capture(
    state: State<'_, DesktopState>,
) -> Result<crate::audio::engine::AudioOutputCapture, String> {
    state
        .audio
        .capture_output_samples()
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
///
/// `(async)` moves it off the main thread: sampling `/proc` costs tens of
/// milliseconds at best, and a plain `#[tauri::command]` runs inline on the GTK
/// main loop that drives WebKitGTK rendering, turning this 1 Hz poll into a 1 Hz
/// UI freeze on Linux. See `get_transport_snapshot` for the same reasoning.
#[tauri::command(async)]
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

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
pub fn get_remote_server_info(app: AppHandle) -> Result<RemoteServerInfo, String> {
    Ok(remote::remote_server_info(&app))
}

/// Mobile build: there is no embedded remote-control server (the app itself
/// is the handheld device), so the command exists for API parity but always
/// errors. The frontend hides the remote UI on mobile and never calls this.
#[cfg(any(target_os = "android", target_os = "ios"))]
#[tauri::command]
pub fn get_remote_server_info() -> Result<serde_json::Value, String> {
    Err("remote control server is not available on mobile".to_string())
}

#[tauri::command]
pub fn get_midi_inputs() -> Result<Vec<String>, String> {
    get_midi_input_names()
}

#[tauri::command]
pub fn get_midi_outputs() -> Result<Vec<String>, String> {
    get_midi_output_names()
}

/// Send a short note on the configured output port so the user can confirm the
/// cabling reaches the target software without having to build a timeline
/// first. Note-on and note-off are queued back to back; the receiving device
/// sees a blip, which is enough for a MIDI monitor or a "learn" dialog.
#[tauri::command]
pub fn send_midi_test_note(
    state: State<'_, DesktopState>,
    channel: u8,
    note: u8,
) -> Result<(), String> {
    if !state.midi_output.is_default_port_open() {
        return Err("no MIDI output device is selected".to_string());
    }
    state.midi_output.send(&[
        OutboundMidiMessage::note_on(channel, note, 100),
        OutboundMidiMessage::note_off(channel, note),
    ]);
    Ok(())
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

const IOS_PICKER_DIAGNOSTIC_FILE: &str = "LibreTracks-picker.log";

/// Append one step of the iOS document-picker flow to a file that is exposed
/// through Files > On My iPhone > LibreTracks. Kept separate from the general
/// error log because an invocation that never resolves is not technically an
/// error and would otherwise leave us with no evidence from a physical phone.
pub(crate) fn write_picker_diagnostic(app: &AppHandle, layer: &str, message: &str) {
    let directory = {
        #[cfg(target_os = "ios")]
        {
            app.path().document_dir().ok()
        }
        #[cfg(not(target_os = "ios"))]
        {
            app.path().app_data_dir().ok()
        }
    };
    let Some(directory) = directory else {
        return;
    };
    if fs::create_dir_all(&directory).is_err() {
        return;
    }
    let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(directory.join(IOS_PICKER_DIAGNOSTIC_FILE))
    else {
        return;
    };
    let timestamp_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let _ = writeln!(file, "[{timestamp_ms}] [{layer}] {message}");
}

#[tauri::command]
pub fn append_picker_diagnostic(app: AppHandle, message: String) -> Result<(), String> {
    write_picker_diagnostic(&app, "frontend", &message);
    Ok(())
}

/// Read the dedicated error log (`logs/errors.log`) so the Diagnostics panel
/// can show / let the user copy it. Returns an empty string if it doesn't
/// exist yet (no errors have been recorded).
#[tauri::command]
pub fn read_error_log() -> Result<String, String> {
    let Some(path) = crate::infra::error_log::errors_path() else {
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
    crate::infra::error_log::write_error(&format!("frontend: {message}"));
    Ok(())
}

/// Reveal the error log in the OS file manager so the user can attach it to a
/// bug report.
#[tauri::command]
pub fn reveal_error_log(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    let path = crate::infra::error_log::errors_path()
        .ok_or_else(|| "error logger not initialized".to_string())?;
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|error| error.to_string())
}

/// Default tail size for the in-app log viewer: enough context to see what
/// happened before a failure, small enough that the WebView renders it without
/// a stutter (the engine log grows unbounded across sessions).
const DIAGNOSTICS_LOG_TAIL_BYTES: u64 = 256 * 1024;
const DIAGNOSTICS_LOG_MAX_TAIL_BYTES: u64 = 4 * 1024 * 1024;

/// The tail of one diagnostics log, ready to render.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsLogView {
    /// Absolute path, so a desktop user can find the file themselves.
    pub path: String,
    pub total_bytes: u64,
    /// True when older lines were left out of `contents`.
    pub truncated: bool,
    pub contents: String,
}

/// Resolve a log kind to its file.
///
/// - `errors`: `logs/errors.log`, the app's own error log (panics, failed
///   commands, frontend exceptions).
/// - `engine`: the C++ engine's diagnostic log (`[LT_STARVATION]`,
///   `[LT_DEVICE]`, `[LT_THREADS]`…), whose path Rust pins at startup via
///   `LIBRETRACKS_AUDIO_DEBUG_LOG`. This is the one that says whether a track
///   went silent because the audio thread ran out of decoded blocks.
fn diagnostics_log_path(kind: &str) -> Result<PathBuf, String> {
    match kind {
        "errors" => crate::infra::error_log::errors_path()
            .ok_or_else(|| "error logger not initialized".to_string()),
        "engine" => std::env::var_os("LIBRETRACKS_AUDIO_DEBUG_LOG")
            .map(PathBuf::from)
            .filter(|path| !path.as_os_str().is_empty())
            .ok_or_else(|| "engine log path is not set".to_string()),
        other => Err(format!("unknown diagnostics log: {other}")),
    }
}

/// Read the END of a diagnostics log so Settings can SHOW it on the device.
///
/// Copying to the clipboard was the only way to get at these, which does not
/// survive a big log (and on Android there is no file manager to fall back
/// to). Reading the tail — not the whole file — keeps this usable no matter
/// how long the engine log has grown.
#[tauri::command]
pub fn read_diagnostics_log(
    kind: String,
    max_bytes: Option<u64>,
) -> Result<DiagnosticsLogView, String> {
    use std::io::{Read, Seek, SeekFrom};

    let path = diagnostics_log_path(&kind)?;
    let limit = max_bytes
        .unwrap_or(DIAGNOSTICS_LOG_TAIL_BYTES)
        .clamp(4096, DIAGNOSTICS_LOG_MAX_TAIL_BYTES);

    let mut file = match fs::File::open(&path) {
        Ok(file) => file,
        // Nothing logged yet is a normal state, not an error.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(DiagnosticsLogView {
                path: path.to_string_lossy().into_owned(),
                total_bytes: 0,
                truncated: false,
                contents: String::new(),
            })
        }
        Err(error) => return Err(error.to_string()),
    };

    let total_bytes = file.metadata().map_err(|error| error.to_string())?.len();
    let start = total_bytes.saturating_sub(limit);
    let truncated = start > 0;
    if truncated {
        file.seek(SeekFrom::Start(start))
            .map_err(|error| error.to_string())?;
    }
    let mut buffer = Vec::new();
    file.read_to_end(&mut buffer)
        .map_err(|error| error.to_string())?;

    let mut contents = String::from_utf8_lossy(&buffer).into_owned();
    if truncated {
        // The seek lands mid-line; drop that fragment so the view starts on a
        // whole entry.
        if let Some(first_break) = contents.find('\n') {
            contents = contents[first_break + 1..].to_string();
        }
    }

    Ok(DiagnosticsLogView {
        path: path.to_string_lossy().into_owned(),
        total_bytes,
        truncated,
        contents,
    })
}

/// Save a diagnostics log wherever the user wants it, so they can attach the
/// WHOLE file to a bug report instead of pasting a clipboard excerpt. On
/// Android this is the only way to get the file out of the app's private
/// storage. Returns false when the user cancels.
#[tauri::command]
pub fn save_diagnostics_log(app: AppHandle, kind: String) -> Result<bool, String> {
    let path = diagnostics_log_path(&kind)?;
    if !path.is_file() {
        return Err("that log has not been written yet".to_string());
    }
    let suggested_name = format!(
        "libretracks-{}-{}.log",
        if kind == "engine" { "engine" } else { "errors" },
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_secs())
            .unwrap_or(0)
    );

    #[cfg(target_os = "android")]
    {
        let Some(target) = crate::platform::mobile_files::save_file(
            &app,
            "Guardar registro de diagnostico",
            &suggested_name,
        ) else {
            return Ok(false);
        };
        crate::platform::mobile_files::copy_path_to_picked_target(&app, &path, &target)?;
        return Ok(true);
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = &app;
        let Some(target) = rfd::FileDialog::new()
            .set_title("Guardar registro de diagnostico")
            .set_file_name(&suggested_name)
            .save_file()
        else {
            return Ok(false);
        };
        fs::copy(&path, &target).map_err(|error| error.to_string())?;
        Ok(true)
    }

    #[cfg(target_os = "ios")]
    {
        let _ = (&app, &suggested_name);
        Err("exporting diagnostics is not available in the iOS smoke build".to_string())
    }
}
