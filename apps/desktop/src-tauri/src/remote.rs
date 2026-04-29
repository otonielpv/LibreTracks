use std::{path::PathBuf, time::Duration};

use libretracks_audio::{JumpTrigger, TransitionType};
use libretracks_remote::{
    spawn_remote_server, RemoteCommand, RemoteServerHandle, RemoteServerInfo,
};
use tauri::{App, AppHandle, Manager};

use crate::{
    commands::events::emit_transport_lifecycle_event,
    commands::transport::{parse_jump_trigger, parse_transition_type, parse_vamp_mode},
    settings::AppSettingsStore,
    state::DesktopState,
};

const DEFAULT_REMOTE_PORT: u16 = 3030;

pub struct RemoteServiceState {
    pub handle: RemoteServerHandle,
}

pub fn initialize_remote(app: &App) -> Result<(), String> {
    let static_dir = resolve_remote_static_dir(app);
    let runtime =
        tauri::async_runtime::block_on(spawn_remote_server(DEFAULT_REMOTE_PORT, static_dir))
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

fn resolve_remote_static_dir(app: &App) -> Option<PathBuf> {
    #[cfg(not(debug_assertions))]
    {
        if let Ok(resource_dir) = app.path().resource_dir() {
            let remote_dist = resource_dir.join("remote-dist");
            if remote_dist.exists() {
                return Some(remote_dist);
            }
        }
    }

    #[cfg(debug_assertions)]
    {
        let _ = app; // unused in dev
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let candidate_roots = [
            std::env::current_dir().ok(),
            Some(manifest_dir.clone()),
            manifest_dir.parent().map(PathBuf::from),
            manifest_dir
                .parent()
                .and_then(|path| path.parent())
                .map(PathBuf::from),
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
    }

    None
}

async fn run_remote_sync_poller(app: AppHandle, handle: RemoteServerHandle) {
    let mut interval = tokio::time::interval(Duration::from_millis(90));
    let mut last_snapshot_json = String::new();
    let mut last_song_revision = u64::MAX;
    let mut last_song_json = String::new();
    let mut last_settings_json = String::new();

    loop {
        interval.tick().await;
        let state = app.state::<DesktopState>();
        if let Ok(settings) = state.audio.current_settings() {
            if let Ok(settings_json) = serde_json::to_string(&settings) {
                if settings_json != last_settings_json {
                    handle.publish_settings(&settings);
                    last_settings_json = settings_json;
                }
            }
        }
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
            RemoteCommand::Seek { position_seconds } => {
                session.seek(*position_seconds, &state.audio)
            }
            RemoteCommand::ScheduleMarkerJump {
                target_marker_id,
                trigger,
                bars,
                transition,
                duration_seconds,
            } => session.schedule_marker_jump(
                target_marker_id,
                parse_jump_trigger(trigger, *bars).unwrap_or(JumpTrigger::Immediate),
                parse_transition_type(transition.as_deref(), *duration_seconds)
                    .unwrap_or(TransitionType::Instant),
                &state.audio,
            ),
            RemoteCommand::ScheduleRegionJump {
                target_region_id,
                trigger,
                bars,
                transition,
                duration_seconds,
            } => session.schedule_region_jump(
                target_region_id,
                parse_jump_trigger(trigger, *bars).unwrap_or(JumpTrigger::Immediate),
                parse_transition_type(transition.as_deref(), *duration_seconds)
                    .unwrap_or(TransitionType::Instant),
                &state.audio,
            ),
            RemoteCommand::ToggleVamp { mode, bars } => session.toggle_vamp(
                parse_vamp_mode(mode, *bars).unwrap_or(libretracks_audio::VampMode::Section),
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
            RemoteCommand::UpdateMetronome { enabled, volume } => {
                let settings_store = app.state::<AppSettingsStore>();
                let mut next_settings = match state.audio.current_settings() {
                    Ok(settings) => settings,
                    Err(_) => continue,
                };

                if let Some(enabled) = enabled {
                    next_settings.metronome_enabled = *enabled;
                }

                if let Some(volume) = volume {
                    next_settings.metronome_volume = volume.clamp(0.0, 1.0);
                }

                let result = session.update_audio_settings(next_settings.clone(), &state.audio);
                let Ok(saved_settings) = result else {
                    continue;
                };

                if settings_store.set(saved_settings.clone()).is_err() {
                    continue;
                }

                handle.publish_settings(&saved_settings);
                session.snapshot_with_sync(&state.audio)
            }
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
            RemoteCommand::ToggleVamp { .. } => {
                emit_transport_lifecycle_event(&app, "vamp", &snapshot)
            }
            _ => {}
        }

        handle.publish_transport_snapshot(&snapshot);
        if let Ok(song_view) = session.song_view() {
            handle.publish_song_view(&song_view);
        }
    }
}
