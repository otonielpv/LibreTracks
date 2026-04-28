use tauri::{AppHandle, State};

use crate::commands::events::emit_transport_lifecycle_event;
use crate::error::DesktopError;
use crate::models::TransportSnapshot;
use crate::state::DesktopState;
use libretracks_audio::{JumpTrigger, TransitionType, VampMode};

#[tauri::command]
pub fn get_transport_snapshot(state: State<'_, DesktopState>) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .snapshot_with_sync(&state.audio)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn play_transport(
    app: AppHandle,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    let snapshot = session
        .play(&state.audio)
        .map_err(|error| error.to_string())?;
    emit_transport_lifecycle_event(&app, "play", &snapshot);
    Ok(snapshot)
}

#[tauri::command]
pub fn pause_transport(
    app: AppHandle,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    let snapshot = session
        .pause(&state.audio)
        .map_err(|error| error.to_string())?;
    emit_transport_lifecycle_event(&app, "pause", &snapshot);
    Ok(snapshot)
}

#[tauri::command]
pub fn stop_transport(
    app: AppHandle,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    let snapshot = session
        .stop(&state.audio)
        .map_err(|error| error.to_string())?;
    emit_transport_lifecycle_event(&app, "stop", &snapshot);
    Ok(snapshot)
}

#[tauri::command]
pub fn seek_transport(
    app: AppHandle,
    position_seconds: f64,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    let snapshot = session
        .seek(position_seconds, &state.audio)
        .map_err(|error| error.to_string())?;
    emit_transport_lifecycle_event(&app, "seek", &snapshot);
    Ok(snapshot)
}

#[tauri::command]
pub fn schedule_marker_jump(
    target_marker_id: String,
    trigger: String,
    bars: Option<u32>,
    transition: Option<String>,
    duration_seconds: Option<f64>,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    let jump_trigger = parse_jump_trigger(&trigger, bars).map_err(|error| error.to_string())?;
    let transition =
        parse_transition_type(transition.as_deref(), duration_seconds).map_err(|error| error.to_string())?;

    session
        .schedule_marker_jump(&target_marker_id, jump_trigger, transition, &state.audio)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn schedule_region_jump(
    target_region_id: String,
    trigger: String,
    bars: Option<u32>,
    transition: Option<String>,
    duration_seconds: Option<f64>,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    let jump_trigger = parse_jump_trigger(&trigger, bars).map_err(|error| error.to_string())?;
    let transition = parse_transition_type(transition.as_deref(), duration_seconds)
        .map_err(|error| error.to_string())?;

    session
        .schedule_region_jump(&target_region_id, jump_trigger, transition, &state.audio)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn cancel_marker_jump(state: State<'_, DesktopState>) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .cancel_marker_jump(&state.audio)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn toggle_vamp(
    mode: String,
    bars: Option<u32>,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    let vamp_mode = parse_vamp_mode(&mode, bars).map_err(|error| error.to_string())?;

    session
        .toggle_vamp(vamp_mode, &state.audio)
        .map_err(|error| error.to_string())
}

pub(crate) fn parse_jump_trigger(
    trigger: &str,
    bars: Option<u32>,
) -> Result<JumpTrigger, DesktopError> {
    match trigger {
        "immediate" => Ok(JumpTrigger::Immediate),
        "section_end" | "next_marker" => Ok(JumpTrigger::NextMarker),
        "region_end" => Ok(JumpTrigger::RegionEnd),
        "after_bars" => Ok(JumpTrigger::AfterBars(bars.unwrap_or(4))),
        _ => Err(DesktopError::AudioCommand(format!(
            "unknown jump trigger: {trigger}"
        ))),
    }
}

pub(crate) fn parse_transition_type(
    transition: Option<&str>,
    duration_seconds: Option<f64>,
) -> Result<TransitionType, DesktopError> {
    match transition.unwrap_or("instant") {
        "instant" => Ok(TransitionType::Instant),
        "fade_out" => Ok(TransitionType::FadeOut {
            duration_seconds: duration_seconds.unwrap_or(0.35).max(0.0),
        }),
        other => Err(DesktopError::AudioCommand(format!(
            "unknown transition type: {other}"
        ))),
    }
}

pub(crate) fn parse_vamp_mode(mode: &str, bars: Option<u32>) -> Result<VampMode, DesktopError> {
    match mode {
        "section" => Ok(VampMode::Section),
        "bars" => Ok(VampMode::Bars(bars.unwrap_or(4).max(1))),
        other => Err(DesktopError::AudioCommand(format!(
            "unknown vamp mode: {other}"
        ))),
    }
}
