use tauri::{AppHandle, State};

use crate::infra::error::DesktopError;
use crate::models::{LibraryAssetSummary, WaveformSummaryDto};
use crate::state::DesktopState;

#[tauri::command]
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

#[tauri::command]
pub fn get_library_folders(state: State<'_, DesktopState>) -> Result<Vec<String>, String> {
    let session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .get_library_folders()
        .map_err(|error| error.to_string())
}

#[tauri::command]
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
    session
        .load_waveforms(&waveform_keys, &state.waveform_jobs, &app, &state.audio)
        .map_err(|error| error.to_string())
}

#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
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
