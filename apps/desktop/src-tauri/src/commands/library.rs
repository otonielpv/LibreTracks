use tauri::{AppHandle, State};

use crate::error::DesktopError;
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
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .load_waveforms(&waveform_keys, &state.waveform_jobs, &app)
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
