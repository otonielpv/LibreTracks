use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::models::TransportSnapshot;
use crate::state::{DesktopSession, DesktopState, WaveformReadyEvent, WAVEFORM_READY_EVENT};

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
        .load_library_waveforms(&normalized_paths, &state.waveform_jobs, app)
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
