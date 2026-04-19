mod audio_runtime;
mod state;

use tauri::{AppHandle, State};

use libretracks_audio::JumpTrigger;
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

#[tauri::command]
fn schedule_section_jump(
    target_section_id: String,
    trigger: String,
    bars: Option<u32>,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    let jump_trigger = parse_jump_trigger(&trigger, bars).map_err(|error| error.to_string())?;

    session
        .schedule_section_jump(&target_section_id, jump_trigger, &state.audio)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn cancel_section_jump(state: State<'_, DesktopState>) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .cancel_section_jump(&state.audio)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn move_clip(
    clip_id: String,
    timeline_start_seconds: f64,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .move_clip(&clip_id, timeline_start_seconds, &state.audio)
        .map_err(|error| error.to_string())
}

fn parse_jump_trigger(trigger: &str, bars: Option<u32>) -> Result<JumpTrigger, DesktopError> {
    match trigger {
        "immediate" => Ok(JumpTrigger::Immediate),
        "section_end" => Ok(JumpTrigger::SectionEnd),
        "after_bars" => Ok(JumpTrigger::AfterBars(bars.unwrap_or(4))),
        _ => Err(DesktopError::AudioCommand(format!(
            "unknown jump trigger: {trigger}"
        ))),
    }
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
            seek_transport,
            schedule_section_jump,
            cancel_section_jump,
            move_clip
        ])
        .run(tauri::generate_context!())
        .expect("failed to run LibreTracks desktop application");
}
