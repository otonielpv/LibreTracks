//! Video clip editing commands. Every command is `(async)` for the reason
//! `commands/timeline.rs` documents: they take the session lock, and inline
//! they would run on the main thread.

use tauri::State;

use crate::infra::error::DesktopError;
use crate::models::TransportSnapshot;
use crate::state::{DesktopState, VideoClipProps};

fn with_session<T>(
    state: &State<'_, DesktopState>,
    edit: impl FnOnce(
        &mut crate::state::DesktopSession,
        &crate::audio::engine::AudioController,
    ) -> Result<T, DesktopError>,
) -> Result<T, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;
    edit(&mut session, &state.audio).map_err(|error| error.to_string())
}

#[tauri::command(async)]
pub fn create_video_clip(
    track_id: String,
    file_path: String,
    timeline_start_seconds: f64,
    source_start_seconds: f64,
    duration_seconds: f64,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    with_session(&state, |session, audio| {
        session.create_video_clip(
            &track_id,
            &file_path,
            timeline_start_seconds,
            source_start_seconds,
            duration_seconds,
            audio,
        )
    })
}

#[tauri::command(async)]
pub fn update_video_clip(
    clip_id: String,
    props: VideoClipProps,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    with_session(&state, |session, audio| {
        session.update_video_clip(&clip_id, props, audio)
    })
}

#[tauri::command(async)]
pub fn move_video_clip(
    clip_id: String,
    timeline_start_seconds: f64,
    target_track_id: Option<String>,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    with_session(&state, |session, audio| {
        session.move_video_clip(
            &clip_id,
            timeline_start_seconds,
            target_track_id.as_deref(),
            audio,
        )
    })
}

#[tauri::command(async)]
pub fn trim_video_clip(
    clip_id: String,
    start_seconds: f64,
    end_seconds: f64,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    with_session(&state, |session, audio| {
        session.trim_video_clip(&clip_id, start_seconds, end_seconds, audio)
    })
}

#[tauri::command(async)]
pub fn split_video_clips(
    clip_ids: Vec<String>,
    split_seconds: f64,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    with_session(&state, |session, audio| {
        session.split_video_clips(&clip_ids, split_seconds, audio)
    })
}

#[tauri::command(async)]
pub fn duplicate_video_clips(
    clip_ids: Vec<String>,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    with_session(&state, |session, audio| {
        session.duplicate_video_clips(&clip_ids, audio)
    })
}

#[tauri::command(async)]
pub fn delete_video_clips(
    clip_ids: Vec<String>,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    with_session(&state, |session, audio| {
        session.delete_video_clips(&clip_ids, audio)
    })
}
