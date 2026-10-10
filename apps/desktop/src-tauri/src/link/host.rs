//! Hosting a network session: start/stop the `libretracks-link` server, feed
//! it from `session_feed`, apply the guests' commands to the session, and
//! keep the host UI and the trusted-device file up to date.

use std::net::IpAddr;

use libretracks_audio::{JumpTrigger, TransitionType};
use libretracks_core::SongChart;
use libretracks_link::{
    net::local_ip, start_host, CommandRejection, GuestSummary, HostConfig, HostHandle,
    IncomingCommand, LinkCommand, Role, TrustedDevice,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::{config, LinkState};
use crate::{
    commands::events::emit_transport_lifecycle_event,
    commands::transport::{parse_jump_trigger, parse_transition_type, parse_vamp_mode},
    infra::settings::{save_app_settings, AppSettings, AppSettingsStore},
    models::TransportSnapshot,
    session_feed::SessionFeed,
    state::DesktopState,
};

pub const HOST_STATUS_EVENT: &str = "link://host";

pub struct ActiveHost {
    pub handle: HostHandle,
    tasks: Vec<tauri::async_runtime::JoinHandle<()>>,
}

impl ActiveHost {
    fn shutdown(self) {
        self.handle.stop();
        for task in self.tasks {
            task.abort();
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustedDeviceView {
    pub device_id: String,
    pub device_name: String,
    pub role: Role,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostStatus {
    pub hosting: bool,
    pub host_name: String,
    pub port: u16,
    /// `ip:port` other devices can type, best guess first.
    pub addresses: Vec<String>,
    /// `libretracks://join?...` for the QR code.
    pub join_url: Option<String>,
    pub guests: Vec<GuestSummary>,
    pub trusted: Vec<TrustedDeviceView>,
}

/// Only what the guest screen paints: the live view's jump modes and, for
/// editors' mix panel, the metronome. Never the whole `AppSettings` (device,
/// paths, MIDI mappings are none of a guest's business).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveSettings {
    pub global_jump_mode: String,
    pub global_jump_bars: u32,
    pub song_jump_trigger: String,
    pub song_jump_bars: u32,
    pub song_transition_mode: String,
    pub vamp_mode: String,
    pub vamp_bars: u32,
    pub metronome_enabled: bool,
    /// Linear gain on the +20 dB aux fader scale, as the host stores it.
    pub metronome_volume: f64,
}

impl From<&AppSettings> for LiveSettings {
    fn from(settings: &AppSettings) -> Self {
        Self {
            global_jump_mode: settings.global_jump_mode.clone(),
            global_jump_bars: settings.global_jump_bars,
            song_jump_trigger: settings.song_jump_trigger.clone(),
            song_jump_bars: settings.song_jump_bars,
            song_transition_mode: settings.song_transition_mode.clone(),
            vamp_mode: settings.vamp_mode.clone(),
            vamp_bars: settings.vamp_bars,
            metronome_enabled: settings.metronome_enabled,
            metronome_volume: settings.metronome_volume,
        }
    }
}

pub fn join_url(ip: &IpAddr, port: u16, host_name: &str) -> String {
    let host = match ip {
        IpAddr::V6(v6) => format!("[{v6}]"),
        IpAddr::V4(v4) => v4.to_string(),
    };
    let name: String = host_name
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (byte as char).to_string()
            }
            other => format!("%{other:02X}"),
        })
        .collect();
    format!("libretracks://join?host={host}:{port}&name={name}")
}

fn trusted_view(trusted: Vec<TrustedDevice>) -> Vec<TrustedDeviceView> {
    trusted
        .into_iter()
        .map(|device| TrustedDeviceView {
            device_id: device.device_id,
            device_name: device.device_name,
            role: device.role,
        })
        .collect()
}

pub fn status(app: &AppHandle) -> HostStatus {
    let link = app.state::<LinkState>();
    let host_name = link
        .config
        .lock()
        .map(|config| config.device_name.clone())
        .unwrap_or_default();
    let host = link.host.lock().ok();
    let Some(handle) = host
        .as_ref()
        .and_then(|host| host.as_ref())
        .map(|host| host.handle.clone())
    else {
        let trusted = link
            .config
            .lock()
            .map(|config| trusted_view(config.trusted.clone()))
            .unwrap_or_default();
        return HostStatus {
            hosting: false,
            host_name,
            port: 0,
            addresses: Vec::new(),
            join_url: None,
            guests: Vec::new(),
            trusted,
        };
    };
    drop(host);
    let port = handle.port();
    let ip = local_ip();
    HostStatus {
        hosting: true,
        host_name: handle.host_name().to_string(),
        port,
        addresses: ip.iter().map(|ip| format!("{ip}:{port}")).collect(),
        join_url: ip.map(|ip| join_url(&ip, port, handle.host_name())),
        guests: handle.guests(),
        trusted: trusted_view(handle.trusted_devices()),
    }
}

fn emit_status(app: &AppHandle) {
    let _ = app.emit(HOST_STATUS_EVENT, status(app));
}

fn set_was_hosting(app: &AppHandle, was_hosting: bool) {
    let link = app.state::<LinkState>();
    let Ok(mut config) = link.config.lock() else {
        return;
    };
    if config.was_hosting != was_hosting {
        config.was_hosting = was_hosting;
        config::save(app, &config);
    }
}

pub async fn start(app: &AppHandle) -> Result<HostStatus, String> {
    if app
        .state::<LinkState>()
        .guest
        .lock()
        .map(|guest| guest.is_some())
        .unwrap_or(false)
    {
        return Err("joinedAsGuest".into());
    }
    if app
        .state::<LinkState>()
        .host
        .lock()
        .map(|host| host.is_some())
        .unwrap_or(false)
    {
        return Ok(status(app));
    }

    let host_config = {
        let link = app.state::<LinkState>();
        let config = link.config.lock().map_err(|_| "state poisoned")?;
        HostConfig {
            host_id: config.device_id.clone(),
            control_pin: config::NetworkSessionConfig::pin(&config.control_pin),
            edit_pin: config::NetworkSessionConfig::pin(&config.edit_pin),
            trusted: config.trusted.clone(),
            ..HostConfig::new(config.device_name.clone())
        }
    };
    let runtime = start_host(host_config)
        .await
        .map_err(|error| format!("no se pudo abrir el puerto: {error}"))?;
    let handle = runtime.handle.clone();

    let tasks = vec![
        tauri::async_runtime::spawn(forward_session(app.clone(), handle.clone())),
        tauri::async_runtime::spawn(apply_commands(app.clone(), runtime.commands)),
        tauri::async_runtime::spawn(watch_guests(app.clone(), handle.clone())),
        tauri::async_runtime::spawn(persist_trusted(app.clone(), handle.clone())),
    ];

    {
        let link = app.state::<LinkState>();
        let mut host = link.host.lock().map_err(|_| "state poisoned")?;
        if let Some(previous) = host.replace(ActiveHost { handle, tasks }) {
            previous.shutdown();
        }
    }
    set_was_hosting(app, true);
    emit_status(app);
    Ok(status(app))
}

pub fn stop(app: &AppHandle) {
    let active = app
        .state::<LinkState>()
        .host
        .lock()
        .ok()
        .and_then(|mut host| host.take());
    if let Some(active) = active {
        active.shutdown();
    }
    set_was_hosting(app, false);
    emit_status(app);
}

pub fn with_handle<T>(app: &AppHandle, f: impl FnOnce(&HostHandle) -> T) -> Option<T> {
    let link = app.state::<LinkState>();
    let host = link.host.lock().ok()?;
    host.as_ref().map(|host| f(&host.handle))
}

async fn forward_session(app: AppHandle, handle: HostHandle) {
    let mut feed = app.state::<SessionFeed>().subscribe();
    let (mut settings_seq, mut snapshot_seq, mut song_seq) = (0, 0, 0);
    let mut last_live: Option<LiveSettings> = None;

    loop {
        let frame = feed.borrow_and_update().clone();
        if frame.settings_seq != settings_seq {
            settings_seq = frame.settings_seq;
            if let Some(settings) = &frame.settings {
                let live = LiveSettings::from(settings.as_ref());
                if last_live.as_ref() != Some(&live) {
                    handle.publish_live_settings(&live);
                    last_live = Some(live);
                }
            }
        }
        if frame.song_seq != song_seq {
            song_seq = frame.song_seq;
            if let Some(song) = &frame.song {
                handle.publish_song(song.as_ref());
            }
        }
        if frame.snapshot_seq != snapshot_seq {
            snapshot_seq = frame.snapshot_seq;
            if let Some(snapshot) = &frame.snapshot {
                handle.publish_transport(snapshot.as_ref());
            }
        }
        if feed.changed().await.is_err() {
            return;
        }
    }
}

async fn watch_guests(app: AppHandle, handle: HostHandle) {
    let mut guests = handle.subscribe_guests();
    while guests.changed().await.is_ok() {
        emit_status(&app);
    }
}

async fn persist_trusted(app: AppHandle, handle: HostHandle) {
    let mut trusted = handle.subscribe_trusted();
    while trusted.changed().await.is_ok() {
        let devices = trusted.borrow_and_update().clone();
        let link = app.state::<LinkState>();
        if let Ok(mut config) = link.config.lock() {
            config.trusted = devices;
            config::save(&app, &config);
        }
        emit_status(&app);
    }
}

async fn apply_commands(
    app: AppHandle,
    mut commands: tokio::sync::mpsc::Receiver<IncomingCommand>,
) {
    while let Some(incoming) = commands.recv().await {
        let result = apply(&app, &incoming);
        let _ = incoming.reply.send(result);
    }
}

/// Lifecycle kind the host UI expects after a command, so its transport and
/// song view refresh exactly as for a local action. `sync` makes it pick up a
/// new `projectRevision` for edits.
fn lifecycle_kind(command: &LinkCommand) -> &'static str {
    match command {
        LinkCommand::Play => "play",
        LinkCommand::Pause => "pause",
        LinkCommand::Stop => "stop",
        LinkCommand::Seek { .. } => "seek",
        LinkCommand::ToggleVamp { .. } => "vamp",
        _ => "sync",
    }
}

/// Edits that change song content check `baseRevision`; transport and mix
/// commands do not (the last one wins, as with two hands on one console).
fn checks_revision(command: &LinkCommand) -> bool {
    matches!(
        command,
        LinkCommand::SetSongChart { .. } | LinkCommand::SetSongTranspose { .. }
    )
}

pub fn is_stale(base_revision: Option<u64>, current_revision: u64) -> bool {
    base_revision.is_some_and(|base| base != current_revision)
}

fn apply_settings_change(
    app: &AppHandle,
    session: &mut crate::state::DesktopSession,
    state: &DesktopState,
    mutate: impl FnOnce(&mut AppSettings),
) -> Result<TransportSnapshot, CommandRejection> {
    let store = app.state::<AppSettingsStore>();
    let mut next = store.current().map_err(|_| CommandRejection::Invalid)?;
    mutate(&mut next);
    let saved = session
        .update_audio_settings(next, &state.audio)
        .map_err(|_| CommandRejection::Invalid)?;
    store
        .set(saved.clone())
        .map_err(|_| CommandRejection::Invalid)?;
    let _ = save_app_settings(app, &saved);
    let _ = app.emit("settings:updated", saved);
    session
        .snapshot_with_sync(&state.audio)
        .map_err(|_| CommandRejection::Invalid)
}

fn apply(app: &AppHandle, incoming: &IncomingCommand) -> Result<(), CommandRejection> {
    let state = app.state::<DesktopState>();
    let mut session = state
        .session
        .lock()
        .map_err(|_| CommandRejection::Invalid)?;
    let audio = &state.audio;
    let invalid = |_| CommandRejection::Invalid;

    if checks_revision(&incoming.command) {
        let current = session.snapshot_with_sync(audio).map_err(invalid)?;
        if is_stale(incoming.base_revision, current.project_revision) {
            return Err(CommandRejection::Stale);
        }
    }

    let snapshot = match &incoming.command {
        LinkCommand::Play => session.play(audio).map_err(invalid)?,
        LinkCommand::Pause => session.pause(audio).map_err(invalid)?,
        LinkCommand::Stop => session.stop(audio).map_err(invalid)?,
        LinkCommand::FadeOutStop => {
            let seconds = app
                .state::<AppSettingsStore>()
                .current()
                .map(|settings| settings.fade_out_stop_seconds)
                .unwrap_or(crate::infra::settings::DEFAULT_FADE_OUT_STOP_SECONDS);
            session.fade_out_and_stop(seconds, audio).map_err(invalid)?
        }
        LinkCommand::Seek { position_seconds } => {
            session.seek(*position_seconds, audio).map_err(invalid)?
        }
        LinkCommand::JumpToMarker {
            marker_id,
            trigger,
            bars,
        } => {
            let trigger: JumpTrigger = parse_jump_trigger(trigger, *bars).map_err(invalid)?;
            session
                .schedule_marker_jump(marker_id, trigger, TransitionType::Instant, audio)
                .map_err(invalid)?
        }
        LinkCommand::JumpToSong {
            region_id,
            trigger,
            bars,
            transition,
            duration_seconds,
        } => {
            let trigger = parse_jump_trigger(trigger, *bars).map_err(invalid)?;
            let transition =
                parse_transition_type(transition.as_deref(), *duration_seconds).map_err(invalid)?;
            session
                .schedule_region_jump(region_id, trigger, transition, audio)
                .map_err(invalid)?
        }
        LinkCommand::ToggleVamp { mode, bars } => {
            let mode = parse_vamp_mode(mode, *bars).map_err(invalid)?;
            session.toggle_vamp(mode, audio).map_err(invalid)?
        }
        LinkCommand::CancelJump => session.cancel_marker_jump(audio).map_err(invalid)?,
        LinkCommand::SetJumpSettings {
            global_jump_mode,
            global_jump_bars,
            song_jump_trigger,
            song_jump_bars,
            song_transition_mode,
            vamp_mode,
            vamp_bars,
        } => apply_settings_change(app, &mut session, &state, |settings| {
            if let Some(value) = global_jump_mode {
                settings.global_jump_mode = value.clone();
            }
            if let Some(value) = global_jump_bars {
                settings.global_jump_bars = (*value).max(1);
            }
            if let Some(value) = song_jump_trigger {
                settings.song_jump_trigger = value.clone();
            }
            if let Some(value) = song_jump_bars {
                settings.song_jump_bars = (*value).max(1);
            }
            if let Some(value) = song_transition_mode {
                settings.song_transition_mode = value.clone();
            }
            if let Some(value) = vamp_mode {
                settings.vamp_mode = value.clone();
            }
            if let Some(value) = vamp_bars {
                settings.vamp_bars = (*value).max(1);
            }
        })?,
        LinkCommand::ReorderSong {
            region_id,
            target_index,
        } => session
            .reorder_song_region(region_id, *target_index as usize, audio)
            .map_err(invalid)?,
        LinkCommand::SetSongChart { region_id, chart } => {
            let chart = chart
                .clone()
                .map(serde_json::from_value::<SongChart>)
                .transpose()
                .map_err(|_| CommandRejection::Invalid)?;
            session
                .set_song_region_chart(region_id, chart, audio)
                .map_err(invalid)?
        }
        LinkCommand::SetSongTranspose {
            region_id,
            semitones,
        } => session
            .update_song_region_transpose(region_id, *semitones, audio)
            .map_err(invalid)?,
        LinkCommand::SetTrackMix {
            track_id,
            volume,
            pan,
            muted,
            solo,
            live,
        } => {
            if *live {
                // Fader drag: straight to the engine, no model change, no undo
                // entry. The release arrives as `live: false`.
                audio
                    .update_live_track_mix(track_id, *volume, *pan, *muted, *solo, None)
                    .map_err(invalid)?;
                session.snapshot_with_sync(audio).map_err(invalid)?
            } else {
                session
                    .update_track(track_id, None, *volume, *pan, *muted, *solo, None, audio)
                    .map_err(invalid)?
            }
        }
        LinkCommand::SetSongMasterGain {
            region_id,
            master_gain,
            live,
        } => {
            if *live {
                audio
                    .update_live_region_master_gain(region_id, *master_gain as f32)
                    .map_err(invalid)?;
                session.snapshot_with_sync(audio).map_err(invalid)?
            } else {
                session
                    .update_song_region_master_gain(region_id, *master_gain, audio)
                    .map_err(invalid)?
            }
        }
        LinkCommand::SetMetronome { enabled, volume } => {
            apply_settings_change(app, &mut session, &state, |settings| {
                if let Some(enabled) = enabled {
                    settings.metronome_enabled = *enabled;
                }
                if let Some(volume) = volume {
                    // Same +20 dB linear scale as the desktop fader.
                    settings.metronome_volume = volume.clamp(0.0, 10.0);
                }
            })?
        }
    };
    drop(session);

    emit_transport_lifecycle_event(app, lifecycle_kind(&incoming.command), &snapshot);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr};

    #[test]
    fn join_url_escapes_the_name() {
        let url = join_url(
            &IpAddr::V4(Ipv4Addr::new(192, 168, 1, 5)),
            3040,
            "PC de Ána",
        );
        assert_eq!(
            url,
            "libretracks://join?host=192.168.1.5:3040&name=PC%20de%20%C3%81na"
        );
    }

    #[test]
    fn join_url_brackets_ipv6() {
        let url = join_url(&IpAddr::V6(Ipv6Addr::LOCALHOST), 1, "x");
        assert!(url.contains("host=[::1]:1"));
    }

    #[test]
    fn stale_only_when_the_base_differs() {
        assert!(!is_stale(None, 5));
        assert!(!is_stale(Some(5), 5));
        assert!(is_stale(Some(4), 5));
    }

    #[test]
    fn only_content_edits_check_the_revision() {
        assert!(checks_revision(&LinkCommand::SetSongChart {
            region_id: "r".into(),
            chart: None
        }));
        assert!(!checks_revision(&LinkCommand::Play));
        assert!(!checks_revision(&LinkCommand::SetMetronome {
            enabled: Some(true),
            volume: None
        }));
    }

    #[test]
    fn transport_commands_refresh_the_host_ui_with_their_own_kind() {
        assert_eq!(lifecycle_kind(&LinkCommand::Play), "play");
        assert_eq!(lifecycle_kind(&LinkCommand::Stop), "stop");
        assert_eq!(
            lifecycle_kind(&LinkCommand::ReorderSong {
                region_id: "r".into(),
                target_index: 0
            }),
            "sync"
        );
    }

    #[test]
    fn live_settings_carry_only_jump_and_metronome_fields() {
        let settings = AppSettings::default();
        let live = serde_json::to_value(LiveSettings::from(&settings)).unwrap();
        let keys: Vec<_> = live.as_object().unwrap().keys().cloned().collect();
        assert_eq!(keys.len(), 9);
        assert!(live.get("metronomeEnabled").is_some());
        assert!(live.get("globalJumpMode").is_some());
        assert!(live.get("vampBars").is_some());
    }
}
