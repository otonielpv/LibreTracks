use tauri::{AppHandle, State};

use crate::commands::events::emit_transport_lifecycle_event;
use crate::audio_engine::jump_debug_logging_enabled;
use crate::error::DesktopError;
use crate::models::TransportSnapshot;
use crate::settings::AppSettingsStore;
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
pub fn prewarm_timeline_seek(
    position_seconds: f64,
    state: State<'_, DesktopState>,
) -> Result<(), String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .on_timeline_hover_or_drag(position_seconds, &state.audio)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn schedule_marker_jump(
    target_marker_id: String,
    settings_store: State<'_, AppSettingsStore>,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    let settings = settings_store
        .current()
        .map_err(|error| error.to_string())?;
    let jump_trigger =
        parse_jump_trigger(&settings.global_jump_mode, Some(settings.global_jump_bars))
            .map_err(|error| error.to_string())?;
    let transition = parse_transition_type(Some(&settings.song_transition_mode), None)
        .map_err(|error| error.to_string())?;
    if jump_debug_logging_enabled() {
        eprintln!(
            "[LT_JUMP_DEBUG][tauri-command] schedule_marker_jump target_marker={target_marker_id} global_mode={} global_bars={} transition={} parsed_trigger={jump_trigger:?} parsed_transition={transition:?}",
            settings.global_jump_mode,
            settings.global_jump_bars,
            settings.song_transition_mode
        );
    }

    session
        .schedule_marker_jump(&target_marker_id, jump_trigger, transition, &state.audio)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn schedule_region_jump(
    target_region_id: String,
    settings_store: State<'_, AppSettingsStore>,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    let settings = settings_store
        .current()
        .map_err(|error| error.to_string())?;
    let jump_trigger =
        parse_jump_trigger(&settings.song_jump_trigger, Some(settings.song_jump_bars))
            .map_err(|error| error.to_string())?;
    let transition = parse_transition_type(Some(&settings.song_transition_mode), None)
        .map_err(|error| error.to_string())?;
    if jump_debug_logging_enabled() {
        eprintln!(
            "[LT_JUMP_DEBUG][tauri-command] schedule_region_jump target_region={target_region_id} song_trigger={} song_bars={} transition={} parsed_trigger={jump_trigger:?} parsed_transition={transition:?}",
            settings.song_jump_trigger,
            settings.song_jump_bars,
            settings.song_transition_mode
        );
    }

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
    if jump_debug_logging_enabled() {
        eprintln!(
            "[LT_JUMP_DEBUG][tauri-command] toggle_vamp mode={mode} bars={bars:?} parsed={vamp_mode:?}"
        );
    }

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
