use tauri::{AppHandle, State};

use crate::commands::events::emit_ready_library_waveforms;
use crate::error::DesktopError;
use crate::models::{LibraryAssetSummary, SongView, TransportSnapshot};
use crate::state::{CreateClipRequest, DesktopState};

#[tauri::command]
pub fn get_song_view(state: State<'_, DesktopState>) -> Result<Option<SongView>, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session.song_view().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn pick_and_import_song_from_dialog(
    app: AppHandle,
    state: State<'_, DesktopState>,
) -> Result<Option<TransportSnapshot>, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .import_song_from_dialog(&app, &state.audio)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn create_song(
    app: AppHandle,
    state: State<'_, DesktopState>,
) -> Result<Option<TransportSnapshot>, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .create_song(&app, &state.audio)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn save_project(state: State<'_, DesktopState>) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session.save_project().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn save_project_as(
    state: State<'_, DesktopState>,
) -> Result<Option<TransportSnapshot>, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session.save_project_as().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn open_project_from_dialog(
    state: State<'_, DesktopState>,
) -> Result<Option<TransportSnapshot>, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .open_project_from_dialog(&state.audio)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn create_clip(
    app: AppHandle,
    track_id: String,
    file_path: String,
    timeline_start_seconds: f64,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    let snapshot = session
        .create_clip(&track_id, &file_path, timeline_start_seconds, &state.audio)
        .map_err(|error| error.to_string())?;

    if let Some(song_dir) = snapshot.song_dir.as_deref() {
        emit_ready_library_waveforms(&app, &state, &mut session, song_dir, &[file_path])?;
    }

    Ok(snapshot)
}

#[tauri::command]
pub fn create_clips_batch(
    app: AppHandle,
    requests: Vec<CreateClipRequest>,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    let snapshot = session
        .create_clips_batch(&requests, &state.audio)
        .map_err(|error| error.to_string())?;

    if let Some(song_dir) = snapshot.song_dir.as_deref() {
        let requested_paths = requests
            .iter()
            .map(|request| request.file_path.clone())
            .collect::<Vec<_>>();
        emit_ready_library_waveforms(&app, &state, &mut session, song_dir, &requested_paths)?;
    }

    Ok(snapshot)
}

#[tauri::command]
pub fn import_library_assets_from_dialog(
    app: AppHandle,
    state: State<'_, DesktopState>,
) -> Result<Option<Vec<LibraryAssetSummary>>, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .import_library_assets_from_dialog(&app)
        .map_err(|error| error.to_string())
}
