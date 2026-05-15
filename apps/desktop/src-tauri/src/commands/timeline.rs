use tauri::State;

use crate::error::DesktopError;
use crate::models::TransportSnapshot;
use crate::state::DesktopState;
use libretracks_core::TrackKind;

#[tauri::command]
pub fn move_clip(
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
pub fn move_clip_live(
    clip_id: String,
    timeline_start_seconds: f64,
    state: State<'_, DesktopState>,
) -> Result<(), String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .move_clip_live(&clip_id, timeline_start_seconds, &state.audio)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn delete_clip(
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
pub fn update_clip_window(
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
pub fn duplicate_clip(
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
pub fn split_clip(
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

#[tauri::command]
pub fn undo_action(state: State<'_, DesktopState>) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .undo_action(&state.audio)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn redo_action(state: State<'_, DesktopState>) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .redo_action(&state.audio)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn create_section_marker(
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
pub fn update_section_marker(
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
pub fn delete_section_marker(
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
pub fn create_song_region(
    start_seconds: f64,
    end_seconds: f64,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .create_song_region(start_seconds, end_seconds, &state.audio)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn update_song_region(
    region_id: String,
    name: String,
    start_seconds: f64,
    end_seconds: f64,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .update_song_region(&region_id, &name, start_seconds, end_seconds, &state.audio)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn update_song_region_transpose(
    region_id: String,
    transpose_semitones: i32,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .update_song_region_transpose(&region_id, transpose_semitones, &state.audio)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn delete_song_region(
    region_id: String,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .delete_song_region(&region_id, &state.audio)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn assign_section_marker_digit(
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
pub fn update_song_tempo(
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
pub fn upsert_song_tempo_marker(
    start_seconds: f64,
    bpm: f64,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .upsert_song_tempo_marker(start_seconds, bpm, &state.audio)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn delete_song_tempo_marker(
    marker_id: String,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .delete_song_tempo_marker(&marker_id, &state.audio)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn update_song_time_signature(
    signature: String,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .update_song_time_signature(&signature, &state.audio)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn upsert_song_time_signature_marker(
    start_seconds: f64,
    signature: String,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .upsert_song_time_signature_marker(start_seconds, &signature, &state.audio)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn delete_song_time_signature_marker(
    marker_id: String,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .delete_song_time_signature_marker(&marker_id, &state.audio)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn create_track(
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
pub fn move_track(
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

/// RuntimeUpdateKind: ModelOnly — only name/metadata changes are accepted here.
/// Mix fields (volume/pan/muted/solo/audioTo) must use `commit_track_mix_change`.
#[tauri::command]
pub fn update_track(
    track_id: String,
    name: Option<String>,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    let name = name.unwrap_or_default();
    session
        .update_track_metadata(&track_id, &name, &state.audio)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn update_track_transpose_enabled(
    track_id: String,
    transpose_enabled: bool,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .update_track_transpose_enabled(&track_id, transpose_enabled, &state.audio)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn update_track_mix_realtime(
    track_id: String,
    volume: Option<f64>,
    pan: Option<f64>,
    muted: Option<bool>,
    solo: Option<bool>,
    state: State<'_, DesktopState>,
) -> Result<(), String> {
    state
        .audio
        .update_live_track_mix(&track_id, volume, pan, muted, solo, None)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn commit_track_mix_change(
    track_id: String,
    volume: Option<f64>,
    pan: Option<f64>,
    muted: Option<bool>,
    solo: Option<bool>,
    audio_to: Option<String>,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .commit_track_mix_model_and_command(
            &track_id,
            volume,
            pan,
            muted,
            solo,
            audio_to.as_deref(),
            &state.audio,
        )
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn delete_track(
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
