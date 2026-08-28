//! Every command in this file is `(async)`. Going back to a plain
//! `#[tauri::command]` is a regression, not a style choice.
//!
//! Tauri runs a plain command inline in the IPC handler, i.e. on the main
//! thread: the GTK main loop that also drives WebKitGTK's rendering on Linux,
//! and the loop that owns the WebView2 host window on Windows. `(async)` only
//! picks the threadpool; the bodies stay synchronous.
//!
//! Why it matters here: these walk and mutate the library folder on disk.

use tauri::{AppHandle, State};

use crate::infra::error::DesktopError;
use crate::models::view::encode_peaks_base64;
use crate::models::{LibraryAssetSummary, WaveformSummaryDto, WaveformWindowDto};
use crate::state::DesktopState;
#[tauri::command(async)]
pub fn get_library_assets(
    state: State<'_, DesktopState>,
) -> Result<Vec<LibraryAssetSummary>, String> {
    let session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .get_library_assets()
        .map_err(|error| error.to_string())
}

#[tauri::command(async)]
pub fn get_library_folders(state: State<'_, DesktopState>) -> Result<Vec<String>, String> {
    let session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .get_library_folders()
        .map_err(|error| error.to_string())
}

#[tauri::command(async)]
pub fn get_waveform_summaries(
    waveform_keys: Vec<String>,
    app: AppHandle,
    state: State<'_, DesktopState>,
) -> Result<Vec<WaveformSummaryDto>, String> {
    // Instrumented because this command is the prime suspect for the 6-7s UI
    // freeze on a native-WAV multitrack: it holds the session lock across
    // load_waveforms, which primes peaks for EVERY source in the song. Timing
    // the lock wait separately from the work tells us whether a given call is
    // the one doing the work or a victim queued behind it.
    // Enable with LIBRETRACKS_WAVEFORM_DIAG=1 (works in release builds).
    use crate::infra::waveform_diag as diag;

    if diag::is_enabled() {
        diag::mark_run_start(&format!(
            "get_waveform_summaries keys={}",
            waveform_keys.len()
        ));
        // Once per process: the device rate and how much the engine has written
        // to its PCM cache. Sources matching the device rate stream in place and
        // write nothing; a mismatch means decode+resample+cache-write (measured:
        // 13.9 s and 3.6 GB for a 25-stem 44.1 kHz set on a 48 kHz device). The
        // per-source rates are not exposed to Rust, but nonzero disk usage is
        // the same signal: it only grows when conversion actually happened.
        diag::log_sample_rates_once(|| {
            state.audio.engine_snapshot().ok().map(|snapshot| {
                (
                    snapshot.device.sample_rate,
                    snapshot.source_states.len(),
                    snapshot.source_cache.disk_bytes_used,
                )
            })
        });
    }
    let _total = diag::Span::new(format!(
        "get_waveform_summaries(keys={})",
        waveform_keys.len()
    ));

    let lock_span = diag::Span::new("  session.lock() wait");
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;
    let lock_wait_ms = lock_span.elapsed_ms();
    drop(lock_span);
    if diag::is_enabled() && lock_wait_ms > 50 {
        diag::log(format!(
            "  !! waited {lock_wait_ms}ms for the session lock (blocked behind another command)"
        ));
    }

    let _held = diag::Span::new("  session lock HELD");
    let result = session
        .load_waveforms(&waveform_keys, &state.waveform_jobs, &app, &state.audio)
        .map_err(|error| error.to_string());

    // How much the caller got vs how much it asked for: a persistent shortfall
    // means the single-threaded waveform worker is the bottleneck, not this
    // command. Pairs with the per-job timings to tell "slow machine" apart from
    // "pipeline stalled".
    if diag::is_enabled() {
        let served = result.as_ref().map(|s| s.len()).unwrap_or(0);
        diag::log_queue_state(waveform_keys.len(), waveform_keys.len() - served.min(waveform_keys.len()));
    }

    result
}

/// High-resolution peaks for one visible tile. Runs on a blocking worker and
/// deliberately never acquires `DesktopState::session`: zoom detail is
/// cosmetic and must not serialize project commands. `None` is the normal
/// fallback while the source is absent or still streaming.
#[tauri::command]
pub async fn get_waveform_window(
    waveform_key: String,
    start_seconds: f64,
    end_seconds: f64,
    bucket_count: usize,
    state: State<'_, DesktopState>,
) -> Result<Option<WaveformWindowDto>, String> {
    let audio = std::sync::Arc::clone(&state.audio);
    tauri::async_runtime::spawn_blocking(move || {
        audio
            .source_peaks_window(&waveform_key, start_seconds, end_seconds, bucket_count)
            .map(|window| {
                let rate = f64::from(window.sample_rate.max(1));
                WaveformWindowDto {
                    sample_rate: window.sample_rate,
                    start_seconds: window.start_frame as f64 / rate,
                    end_seconds: window.end_frame as f64 / rate,
                    bucket_count: window.bucket_count,
                    min_peaks_base64: encode_peaks_base64(&window.min_peaks),
                    max_peaks_base64: encode_peaks_base64(&window.max_peaks),
                    min_peaks_right_base64: encode_peaks_base64(&window.min_peaks_right),
                    max_peaks_right_base64: encode_peaks_base64(&window.max_peaks_right),
                }
            })
    })
    .await
    .map_err(|error| format!("waveform window worker failed: {error}"))
}

#[tauri::command(async)]
pub fn get_library_waveform_summaries(
    file_paths: Vec<String>,
    app: tauri::AppHandle,
    state: State<'_, DesktopState>,
) -> Result<Vec<WaveformSummaryDto>, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .load_library_waveforms(&file_paths, &state.waveform_jobs, &app)
        .map_err(|error| error.to_string())
}

#[tauri::command(async)]
pub fn delete_library_asset(
    file_path: String,
    state: State<'_, DesktopState>,
) -> Result<Vec<LibraryAssetSummary>, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .delete_library_asset(&file_path)
        .map_err(|error| error.to_string())
}

/// Roll a library import back out of the manifest after its timeline placement
/// was rejected. Never deletes audio from disk — see
/// `DesktopSession::forget_library_assets`.
#[tauri::command(async)]
pub fn forget_library_assets(
    file_paths: Vec<String>,
    state: State<'_, DesktopState>,
) -> Result<Vec<LibraryAssetSummary>, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .forget_library_assets(&file_paths)
        .map_err(|error| error.to_string())
}

#[tauri::command(async)]
pub fn move_library_asset(
    file_path: String,
    new_folder_path: Option<String>,
    state: State<'_, DesktopState>,
) -> Result<Vec<LibraryAssetSummary>, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .move_library_asset(&file_path, new_folder_path)
        .map_err(|error| error.to_string())
}

#[tauri::command(async)]
pub fn create_library_folder(
    folder_path: String,
    state: State<'_, DesktopState>,
) -> Result<Vec<String>, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .create_library_folder(&folder_path)
        .map_err(|error| error.to_string())
}

#[tauri::command(async)]
pub fn rename_library_folder(
    old_folder_path: String,
    new_folder_path: String,
    state: State<'_, DesktopState>,
) -> Result<Vec<LibraryAssetSummary>, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .rename_library_folder(&old_folder_path, &new_folder_path)
        .map_err(|error| error.to_string())
}

#[tauri::command(async)]
pub fn delete_library_folder(
    folder_path: String,
    state: State<'_, DesktopState>,
) -> Result<Vec<LibraryAssetSummary>, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .delete_library_folder(&folder_path)
        .map_err(|error| error.to_string())
}
