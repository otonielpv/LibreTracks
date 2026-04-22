mod audio_runtime;
mod state;

use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use audio_runtime::AudioDebugSnapshot;
use libretracks_audio::JumpTrigger;
use libretracks_core::TrackKind;
use state::{
    DesktopError, DesktopPerformanceSnapshot, DesktopState, SongView, TransportSnapshot,
    WaveformSummaryDto,
};

const TRANSPORT_LIFECYCLE_EVENT: &str = "transport:lifecycle";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TransportLifecycleEventPayload {
    kind: String,
    snapshot: TransportSnapshot,
    anchor_position_seconds: f64,
    emitted_at_unix_ms: u64,
}

fn transport_anchor_position(snapshot: &TransportSnapshot) -> f64 {
    if snapshot.playback_state == "playing" && snapshot.transport_clock.running {
        snapshot.transport_clock.anchor_position_seconds
    } else {
        snapshot.position_seconds
    }
}

fn emit_transport_lifecycle_event(app: &AppHandle, kind: &str, snapshot: &TransportSnapshot) {
    let emitted_at_unix_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    let payload = TransportLifecycleEventPayload {
        kind: kind.to_string(),
        snapshot: snapshot.clone(),
        anchor_position_seconds: transport_anchor_position(snapshot),
        emitted_at_unix_ms,
    };

    if let Err(error) = app.emit(TRANSPORT_LIFECYCLE_EVENT, payload) {
        eprintln!("[libretracks-transport] failed to emit lifecycle event: {error}");
    }
}

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
fn get_song_view(state: State<'_, DesktopState>) -> Result<Option<SongView>, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session.song_view().map_err(|error| error.to_string())
}

#[tauri::command]
fn get_waveform_summaries(
    waveform_keys: Vec<String>,
    state: State<'_, DesktopState>,
) -> Result<Vec<WaveformSummaryDto>, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .load_waveforms(&waveform_keys)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn get_audio_debug_snapshot(state: State<'_, DesktopState>) -> Result<AudioDebugSnapshot, String> {
    state
        .audio
        .debug_snapshot()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn get_desktop_performance_snapshot(
    state: State<'_, DesktopState>,
) -> Result<DesktopPerformanceSnapshot, String> {
    let session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    Ok(session.performance_snapshot())
}

#[tauri::command]
fn report_ui_render_metric(
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
fn create_song(
    app: AppHandle,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .create_song(&app, &state.audio)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn save_project(state: State<'_, DesktopState>) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session.save_project().map_err(|error| error.to_string())
}

#[tauri::command]
fn open_project_from_dialog(
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
fn play_transport(
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
fn pause_transport(
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
fn stop_transport(
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
fn seek_transport(
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
fn schedule_section_jump(
    target_marker_id: String,
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
        .schedule_section_jump(&target_marker_id, jump_trigger, &state.audio)
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

#[tauri::command]
fn delete_clip(
    clip_id: String,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .delete_clip(&clip_id, &state.audio)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn update_clip_window(
    clip_id: String,
    timeline_start_seconds: f64,
    source_start_seconds: f64,
    duration_seconds: f64,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .update_clip_window(
            &clip_id,
            timeline_start_seconds,
            source_start_seconds,
            duration_seconds,
            &state.audio,
        )
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn duplicate_clip(
    clip_id: String,
    timeline_start_seconds: f64,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .duplicate_clip(&clip_id, timeline_start_seconds, &state.audio)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn create_section_marker(
    start_seconds: f64,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .create_section_marker(start_seconds, &state.audio)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn update_section_marker(
    section_id: String,
    name: String,
    start_seconds: f64,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .update_section_marker(&section_id, &name, start_seconds, &state.audio)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn delete_section_marker(
    section_id: String,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .delete_section_marker(&section_id, &state.audio)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn assign_section_marker_digit(
    section_id: String,
    digit: Option<u8>,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .assign_section_marker_digit(&section_id, digit, &state.audio)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn update_song_tempo(
    bpm: f64,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .update_song_tempo(bpm, &state.audio)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn create_track(
    name: String,
    kind: TrackKind,
    insert_after_track_id: Option<String>,
    parent_track_id: Option<String>,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .create_track(
            &name,
            kind,
            insert_after_track_id.as_deref(),
            parent_track_id.as_deref(),
            &state.audio,
        )
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn move_track(
    track_id: String,
    insert_after_track_id: Option<String>,
    insert_before_track_id: Option<String>,
    parent_track_id: Option<String>,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .move_track(
            &track_id,
            insert_after_track_id.as_deref(),
            insert_before_track_id.as_deref(),
            parent_track_id.as_deref(),
            &state.audio,
        )
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn update_track(
    track_id: String,
    name: Option<String>,
    volume: Option<f64>,
    pan: Option<f64>,
    muted: Option<bool>,
    solo: Option<bool>,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .update_track(
            &track_id,
            name.as_deref(),
            volume,
            pan,
            muted,
            solo,
            &state.audio,
        )
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn delete_track(
    track_id: String,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .delete_track(&track_id, &state.audio)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn split_clip(
    clip_id: String,
    split_seconds: f64,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .split_clip(&clip_id, split_seconds, &state.audio)
        .map_err(|error| error.to_string())
}

fn parse_jump_trigger(trigger: &str, bars: Option<u32>) -> Result<JumpTrigger, DesktopError> {
    match trigger {
        "immediate" => Ok(JumpTrigger::Immediate),
        "section_end" | "next_marker" => Ok(JumpTrigger::NextMarker),
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
            get_song_view,
            get_waveform_summaries,
            get_audio_debug_snapshot,
            get_desktop_performance_snapshot,
            report_ui_render_metric,
            create_song,
            save_project,
            open_project_from_dialog,
            pick_and_import_song_from_dialog,
            play_transport,
            pause_transport,
            stop_transport,
            seek_transport,
            schedule_section_jump,
            cancel_section_jump,
            move_clip,
            delete_clip,
            update_clip_window,
            duplicate_clip,
            split_clip,
            create_section_marker,
            update_section_marker,
            delete_section_marker,
            assign_section_marker_digit,
            update_song_tempo,
            create_track,
            move_track,
            update_track,
            delete_track
        ])
        .run(tauri::generate_context!())
        .expect("failed to run LibreTracks desktop application");
}
