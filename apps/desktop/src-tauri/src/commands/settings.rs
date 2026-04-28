use tauri::{AppHandle, State};

use crate::error::DesktopError;
use crate::settings::{save_app_settings, AppSettings, AppSettingsStore};
use crate::state::DesktopState;

#[tauri::command]
pub fn get_settings(settings_store: State<'_, AppSettingsStore>) -> Result<AppSettings, String> {
    settings_store.current().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn save_settings(
    app: AppHandle,
    settings: AppSettings,
    settings_store: State<'_, AppSettingsStore>,
) -> Result<AppSettings, String> {
    settings_store
        .set(settings.clone())
        .map_err(|error| error.to_string())?;
    save_app_settings(&app, &settings).map_err(|error| error.to_string())?;
    Ok(settings)
}

#[tauri::command]
pub fn update_audio_settings(
    app: AppHandle,
    settings: AppSettings,
    settings_store: State<'_, AppSettingsStore>,
    state: State<'_, DesktopState>,
) -> Result<AppSettings, String> {
    let previous_settings = state
        .audio
        .current_settings()
        .map_err(|error| error.to_string())?;
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    let next_settings = session
        .update_audio_settings(settings, &state.audio)
        .map_err(|error| error.to_string())?;
    drop(session);

    settings_store
        .set(next_settings.clone())
        .map_err(|error| error.to_string())?;

    if previous_settings.selected_midi_device != next_settings.selected_midi_device {
        state
            .midi
            .restart(
                app,
                state.audio.command_sender(),
                next_settings.selected_midi_device.clone(),
            )
            .map_err(|error| error.to_string())?;
    }

    Ok(next_settings)
}
