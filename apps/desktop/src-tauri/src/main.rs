mod audio_runtime;
mod state;

use tauri::{AppHandle, State};

use state::{DesktopError, DesktopState, TransportSnapshot};

#[tauri::command]
fn healthcheck() -> &'static str {
    "libretracks-ready"
}

#[tauri::command]
fn get_transport_snapshot(state: State<'_, DesktopState>) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .snapshot_with_sync(&state.audio)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn pick_and_import_song_from_dialog(
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
fn play_transport(state: State<'_, DesktopState>) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session.play(&state.audio).map_err(|error| error.to_string())
}

#[tauri::command]
fn pause_transport(state: State<'_, DesktopState>) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session.pause(&state.audio).map_err(|error| error.to_string())
}

#[tauri::command]
fn stop_transport(state: State<'_, DesktopState>) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session.stop(&state.audio).map_err(|error| error.to_string())
}

#[tauri::command]
fn seek_transport(
    position_seconds: f64,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .seek(position_seconds, &state.audio)
        .map_err(|error| error.to_string())
}

fn main() {
    tauri::Builder::default()
        .manage(DesktopState::default())
        .invoke_handler(tauri::generate_handler![
            healthcheck,
            get_transport_snapshot,
            pick_and_import_song_from_dialog,
            play_transport,
            pause_transport,
            stop_transport,
            seek_transport
        ])
        .run(tauri::generate_context!())
        .expect("failed to run LibreTracks desktop application");
}
