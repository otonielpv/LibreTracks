use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::models::{LibraryAssetSummary, TransportSnapshot};
use crate::state::{DesktopSession, DesktopState, WaveformReadyEvent, WAVEFORM_READY_EVENT};

const TRANSPORT_LIFECYCLE_EVENT: &str = "transport:lifecycle";
const PROJECT_LOAD_COMPLETE_EVENT: &str = "project:load-complete";
const LIBRARY_IMPORT_COMPLETE_EVENT: &str = "library:import-complete";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TransportLifecycleEventPayload {
    kind: String,
    snapshot: TransportSnapshot,
    anchor_position_seconds: f64,
    emitted_at_unix_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectLoadCompleteEventPayload {
    pub snapshot: Option<TransportSnapshot>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LibraryImportCompleteEventPayload {
    pub assets: Option<Vec<LibraryAssetSummary>>,
    pub error: Option<String>,
}

fn transport_anchor_position(snapshot: &TransportSnapshot) -> f64 {
    if snapshot.playback_state == "playing" && snapshot.transport_clock.running {
        snapshot.transport_clock.anchor_position_seconds
    } else {
        snapshot.position_seconds
    }
}

pub(crate) fn emit_transport_lifecycle_event(
    app: &AppHandle,
    kind: &str,
    snapshot: &TransportSnapshot,
) {
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

pub(crate) fn emit_project_load_complete_event(
    app: &AppHandle,
    payload: ProjectLoadCompleteEventPayload,
) {
    if let Err(error) = app.emit(PROJECT_LOAD_COMPLETE_EVENT, payload) {
        eprintln!("[libretracks-project] failed to emit load-complete event: {error}");
    }
}

pub(crate) fn emit_library_import_complete_event(
    app: &AppHandle,
    payload: LibraryImportCompleteEventPayload,
) {
    if let Err(error) = app.emit(LIBRARY_IMPORT_COMPLETE_EVENT, payload) {
        eprintln!("[libretracks-library] failed to emit import-complete event: {error}");
    }
}

pub(crate) fn emit_ready_library_waveforms(
    app: &AppHandle,
    state: &DesktopState,
    session: &mut DesktopSession,
    song_dir: &str,
    file_paths: &[String],
) -> Result<(), String> {
    let normalized_paths = file_paths
        .iter()
        .map(|file_path| file_path.replace('\\', "/"))
        .collect::<Vec<_>>();
    let summaries = session
        .load_library_waveforms(&normalized_paths, &state.waveform_jobs, app, &state.audio)
        .map_err(|error| error.to_string())?;
    let normalized_song_dir = song_dir.replace('\\', "/");

    for summary in summaries {
        let waveform_key = summary.waveform_key.clone();
        app.emit(
            WAVEFORM_READY_EVENT,
            WaveformReadyEvent {
                song_dir: normalized_song_dir.clone(),
                waveform_key,
                summary,
            },
        )
        .map_err(|error| error.to_string())?;
    }

    Ok(())
}
