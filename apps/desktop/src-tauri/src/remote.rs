use std::{path::PathBuf, time::Duration};

use libretracks_audio::JumpTrigger;
use libretracks_remote::{
    spawn_remote_server, RemoteCommand, RemoteServerHandle, RemoteServerInfo,
};
use tauri::{App, AppHandle, Manager};

use crate::{
    commands::events::emit_transport_lifecycle_event,
    error::DesktopError,
    state::DesktopState,
};

const DEFAULT_REMOTE_PORT: u16 = 3030;

pub struct RemoteServiceState {
    pub handle: RemoteServerHandle,
}

pub fn initialize_remote(app: &App) -> Result<(), String> {
    let static_dir = resolve_remote_static_dir();
    let runtime = tauri::async_runtime::block_on(spawn_remote_server(
        DEFAULT_REMOTE_PORT,
        static_dir,
    ))
    .map_err(|error| error.to_string())?;
    let handle = runtime.handle.clone();

    app.manage(RemoteServiceState {
        handle: handle.clone(),
    });

    let desktop_state = app.state::<DesktopState>();
    desktop_state.audio.attach_remote_handle(handle.clone());

    let app_handle = app.handle().clone();
    tauri::async_runtime::spawn(run_remote_command_bridge(
        app_handle.clone(),
        runtime.command_rx,
        handle.clone(),
    ));
    tauri::async_runtime::spawn(run_remote_sync_poller(app_handle, handle));

    Ok(())
}

pub fn remote_server_info(app: &AppHandle) -> RemoteServerInfo {
    app.state::<RemoteServiceState>().handle.info().clone()
}

fn resolve_remote_static_dir() -> Option<PathBuf> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let candidate_roots = [
        std::env::current_dir().ok(),
        Some(manifest_dir.clone()),
        manifest_dir.parent().map(PathBuf::from),
        manifest_dir.parent().and_then(|path| path.parent()).map(PathBuf::from),
        manifest_dir
            .parent()
            .and_then(|path| path.parent())
            .and_then(|path| path.parent())
            .map(PathBuf::from),
    ];

    for candidate_root in candidate_roots.into_iter().flatten() {
        let direct_dist = candidate_root.join("apps").join("remote").join("dist");
        if direct_dist.join("index.html").exists() {
            return Some(direct_dist);
        }

        let sibling_dist = candidate_root.join("remote").join("dist");
        if sibling_dist.join("index.html").exists() {
            return Some(sibling_dist);
        }
    }

    None
}

async fn run_remote_sync_poller(app: AppHandle, handle: RemoteServerHandle) {
    let mut interval = tokio::time::interval(Duration::from_millis(90));
    let mut last_snapshot_json = String::new();
    let mut last_song_revision = u64::MAX;
    let mut last_song_json = String::new();

    loop {
        interval.tick().await;
        let state = app.state::<DesktopState>();
        let mut session = match state.session.lock() {
            Ok(session) => session,
            Err(_) => continue,
        };

        let snapshot = match session.snapshot_with_sync(&state.audio) {
            Ok(snapshot) => snapshot,
            Err(_) => continue,
        };
        let snapshot_json = match serde_json::to_string(&snapshot) {
            Ok(json) => json,
            Err(_) => continue,
        };

        if snapshot_json != last_snapshot_json {
            handle.publish_transport_snapshot(&snapshot);
            last_snapshot_json = snapshot_json;
        }

        if snapshot.project_revision != last_song_revision {
            let song_view = session.song_view().ok().flatten();
            if let Ok(song_json) = serde_json::to_string(&song_view) {
                if song_json != last_song_json {
                    handle.publish_song_view(&song_view);
                    last_song_json = song_json;
                }
            }
            last_song_revision = snapshot.project_revision;
        }
    }
}

async fn run_remote_command_bridge(
    app: AppHandle,
    mut command_rx: tokio::sync::mpsc::Receiver<RemoteCommand>,
    handle: RemoteServerHandle,
) {
    while let Some(command) = command_rx.recv().await {
        let state = app.state::<DesktopState>();
        let mut session = match state.session.lock() {
            Ok(session) => session,
            Err(_) => continue,
        };

        let snapshot_result = match &command {
            RemoteCommand::Play => session.play(&state.audio),
            RemoteCommand::Pause => session.pause(&state.audio),
            RemoteCommand::Stop => session.stop(&state.audio),
            RemoteCommand::Seek { position_seconds } => session.seek(*position_seconds, &state.audio),
            RemoteCommand::ScheduleMarkerJump {
                target_marker_id,
                trigger,
                bars,
            } => session.schedule_marker_jump(
                target_marker_id,
                parse_jump_trigger(trigger, *bars).unwrap_or(JumpTrigger::Immediate),
                &state.audio,
            ),
            RemoteCommand::CancelMarkerJump => session.cancel_marker_jump(&state.audio),
            RemoteCommand::UpdateTrackMixLive {
                track_id,
                volume,
                pan,
                muted,
                solo,
            } => {
                if session
                    .update_track_mix_live(track_id, *volume, *pan, *muted, *solo, &state.audio)
                    .is_err()
                {
                    continue;
                }
                session.snapshot_with_sync(&state.audio)
            }
            RemoteCommand::UpdateTrack {
                track_id,
                volume,
                pan,
                muted,
                solo,
            } => session.update_track(track_id, None, *volume, *pan, *muted, *solo, &state.audio),
            RemoteCommand::Ping => continue,
        };

        let Ok(snapshot) = snapshot_result else {
            continue;
        };

        match &command {
            RemoteCommand::Play => emit_transport_lifecycle_event(&app, "play", &snapshot),
            RemoteCommand::Pause => emit_transport_lifecycle_event(&app, "pause", &snapshot),
            RemoteCommand::Stop => emit_transport_lifecycle_event(&app, "stop", &snapshot),
            RemoteCommand::Seek { .. } => emit_transport_lifecycle_event(&app, "seek", &snapshot),
            _ => {}
        }

        handle.publish_transport_snapshot(&snapshot);
        if let Ok(song_view) = session.song_view() {
            handle.publish_song_view(&song_view);
        }
    }
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
