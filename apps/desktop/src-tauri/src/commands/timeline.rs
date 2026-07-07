use tauri::State;

use crate::automation::{AutomationCue, MixScene};
use crate::error::DesktopError;
use crate::models::TransportSnapshot;
use crate::state::{ClipMoveRequest, DesktopState};
use libretracks_core::{MarkerKind, TrackKind};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateClipPlacement {
    clip_id: String,
    timeline_start_seconds: f64,
}

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

/// Reassign a clip to a different track. Backs the compact view's right-
/// click "Mover a track…" submenu. If the original track was auto-created
/// and loses its only clip in the process, it is removed automatically.
#[tauri::command]
pub fn move_clip_to_track(
    clip_id: String,
    target_track_id: String,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .move_clip_to_track(&clip_id, &target_track_id, &state.audio)
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
pub fn move_clips_batch(
    moves: Vec<ClipMoveRequest>,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .move_clips_batch(&moves, &state.audio)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn move_clips_live_batch(
    moves: Vec<ClipMoveRequest>,
    state: State<'_, DesktopState>,
) -> Result<(), String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .move_clips_live_batch(&moves, &state.audio)
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
pub fn delete_clips(
    clip_ids: Vec<String>,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .delete_clips(&clip_ids, &state.audio)
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
pub fn update_clip_color(
    clip_id: String,
    color: Option<String>,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .update_clip_color(&clip_id, color.as_deref(), &state.audio)
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
pub fn duplicate_clips(
    placements: Vec<DuplicateClipPlacement>,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;
    let placements = placements
        .into_iter()
        .map(|placement| (placement.clip_id, placement.timeline_start_seconds))
        .collect::<Vec<_>>();

    session
        .duplicate_clips(&placements, &state.audio)
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
pub fn split_clips(
    clip_ids: Vec<String>,
    split_seconds: f64,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .split_clips(&clip_ids, split_seconds, &state.audio)
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
    kind: Option<MarkerKind>,
    variant: Option<u8>,
    name: Option<String>,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .create_section_marker(start_seconds, kind, variant, name, &state.audio)
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

/// Append a fresh empty song to the project. Backs the compact view's
/// "+ Nueva canción" button. The new song is placed one bar after the
/// previous one's end (or at t=0 for the first song) and is itself one
/// bar wide so it's visible in the DAW view immediately; it resizes to
/// fit the first clip dropped into it.
#[tauri::command]
pub fn create_empty_song(
    name: Option<String>,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .create_empty_song(name.as_deref(), &state.audio)
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
pub fn move_song_region(
    region_id: String,
    delta_seconds: f64,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .move_song_region(&region_id, delta_seconds, &state.audio)
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
pub fn update_song_region_warp(
    region_id: String,
    warp_enabled: bool,
    warp_source_bpm: Option<f64>,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .update_song_region_warp(&region_id, warp_enabled, warp_source_bpm, &state.audio)
        .map_err(|error| error.to_string())
}

/// Realtime master-gain stream during drag. Bridge-only: pushes the value to
/// the engine and returns immediately. No model write, no snapshot, no undo.
/// Use `update_song_region_master_gain` on pointer-up to commit the value.
#[tauri::command]
pub fn update_live_region_master_gain(
    region_id: String,
    master_gain: f64,
    state: State<'_, DesktopState>,
) -> Result<(), String> {
    if !master_gain.is_finite() || master_gain < 0.0 {
        return Err("master gain must be a finite, non-negative number".into());
    }
    state
        .audio
        .update_live_region_master_gain(&region_id, master_gain as f32)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn update_song_region_master_gain(
    region_id: String,
    master_gain: f64,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .update_song_region_master_gain(&region_id, master_gain, &state.audio)
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
pub fn split_song_region(
    region_id: String,
    split_seconds: f64,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .split_song_region(&region_id, split_seconds, &state.audio)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn upsert_automation_cue(
    cue: AutomationCue,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .upsert_automation_cue(cue, &state.audio)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn delete_automation_cue(
    cue_id: String,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .delete_automation_cue(&cue_id, &state.audio)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn add_automation_track(
    after_track_id: Option<String>,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .add_automation_track(after_track_id, &state.audio)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn remove_automation_track(
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .remove_automation_track(&state.audio)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn set_automation_track_position(
    after_track_id: Option<String>,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .set_automation_track_position(after_track_id, &state.audio)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn upsert_mix_scene(
    scene: MixScene,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .upsert_mix_scene(scene, &state.audio)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn delete_mix_scene(
    scene_id: String,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .delete_mix_scene(&scene_id, &state.audio)
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
pub fn set_section_marker_kind(
    section_id: String,
    kind: MarkerKind,
    variant: Option<u8>,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .set_section_marker_kind(&section_id, kind, variant, &state.audio)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn set_section_marker_color(
    section_id: String,
    color: Option<String>,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .set_section_marker_color(&section_id, color, &state.audio)
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
pub fn update_song_region_key(
    region_id: String,
    key: Option<String>,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .update_song_region_key(&region_id, key, &state.audio)
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
pub fn update_track_color(
    track_id: String,
    color: Option<String>,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .update_track_color(&track_id, color.as_deref(), &state.audio)
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

/// Delete a multi-track selection in one transaction (single engine sync +
/// snapshot + history entry), instead of the frontend looping `delete_track`
/// per id, which made the tracks disappear one by one.
#[tauri::command]
pub fn delete_tracks(
    track_ids: Vec<String>,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;

    session
        .delete_tracks(&track_ids, &state.audio)
        .map_err(|error| error.to_string())
}
