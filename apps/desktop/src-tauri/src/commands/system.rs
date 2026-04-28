use tauri::State;

use crate::audio_runtime::AudioDebugSnapshot;
use crate::error::DesktopError;
use crate::midi::get_midi_input_names;
use crate::models::DesktopPerformanceSnapshot;
use crate::remote;
use crate::state::DesktopState;
use libretracks_remote::RemoteServerInfo;
use tauri::AppHandle;

#[tauri::command]
pub fn healthcheck() -> &'static str {
    "libretracks-ready"
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
