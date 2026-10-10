//! Joining a host as a guest: run the `libretracks-link` client, relay what
//! the host publishes to the guest UI, and send its commands.
//!
//! The guest's own session is never touched (plan rule 5): nothing here
//! reads or writes `DesktopState`. The guest UI mounts a separate screen fed
//! only by these events.

use std::time::{SystemTime, UNIX_EPOCH};

use libretracks_core::net_clock::extrapolate_position;
use libretracks_link::{
    join, net::parse_join_target, server::DEFAULT_LINK_PORT, CommandError, CommandRejection,
    GuestConfig, GuestEvent, GuestHandle, GuestState, LinkCommand, PeerInfo, Role,
};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use super::{config, LinkState};

pub const GUEST_STATUS_EVENT: &str = "link://guest";
pub const GUEST_SONG_EVENT: &str = "link://guest-song";
pub const GUEST_TRANSPORT_EVENT: &str = "link://guest-transport";
pub const GUEST_LIVE_SETTINGS_EVENT: &str = "link://guest-live-settings";

pub struct ActiveGuest {
    handle: GuestHandle,
    task: tauri::async_runtime::JoinHandle<()>,
    status: GuestStatus,
    song: Option<Value>,
    transport: Option<GuestTransport>,
    live_settings: Option<Value>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuestStatus {
    pub joined: bool,
    /// `host:port` as joined.
    pub address: String,
    /// `connecting`, `connected`, `lost`, `rejected`, `closed`.
    pub state: String,
    /// For `rejected`: `badPin`, `kicked`, …
    pub reason: Option<String>,
    pub expected_protocol: Option<u32>,
    pub host_name: String,
    pub role: Option<Role>,
    pub rtt_ms: Option<u32>,
    pub peers: Vec<PeerInfo>,
}

/// Same shape as the local transport lifecycle event, so the guest screen
/// can extrapolate the playhead exactly like the host's own UI does.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuestTransport {
    pub snapshot: Value,
    /// The host's playhead at `emitted_at_unix_ms`, already corrected for
    /// network delay and clock offset.
    pub anchor_position_seconds: f64,
    pub emitted_at_unix_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuestSnapshot {
    pub status: GuestStatus,
    pub song: Option<Value>,
    pub transport: Option<GuestTransport>,
    pub live_settings: Option<Value>,
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// Where the host's playhead is now, from a snapshot taken at
/// `host_instant_ms` on the host clock. Without a clock sample yet the
/// snapshot is taken as fresh (an error of one network trip, a few ms).
pub fn host_position_now(
    snapshot: &Value,
    host_instant_ms: u64,
    guest_now_ms: f64,
    offset_ms: Option<f64>,
) -> f64 {
    let number = |value: &Value| value.as_f64();
    let clock = &snapshot["transportClock"];
    let playing = snapshot["playbackState"] == "playing";
    let running = playing && clock["running"].as_bool().unwrap_or(false);
    let anchor = if running {
        number(&clock["anchorPositionSeconds"])
    } else {
        number(&snapshot["positionSeconds"])
    }
    .unwrap_or(0.0);
    let rate = number(&clock["playbackRate"]).unwrap_or(1.0);
    let offset = offset_ms.unwrap_or(host_instant_ms as f64 - guest_now_ms);
    extrapolate_position(
        anchor,
        host_instant_ms as f64,
        rate,
        running,
        guest_now_ms,
        offset,
    )
}

fn state_name(state: &GuestState) -> (&'static str, Option<String>, Option<u32>) {
    match state {
        GuestState::Connecting { .. } => ("connecting", None, None),
        GuestState::Connected => ("connected", None, None),
        GuestState::Lost => ("lost", None, None),
        GuestState::Rejected {
            reason,
            expected_protocol,
        } => (
            "rejected",
            serde_json::to_value(reason)
                .ok()
                .and_then(|value| value.as_str().map(str::to_string)),
            *expected_protocol,
        ),
        GuestState::Closed => ("closed", None, None),
    }
}

fn platform() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "ios") {
        "ios"
    } else if cfg!(target_os = "android") {
        "android"
    } else {
        "linux"
    }
}

fn with_guest<T>(app: &AppHandle, f: impl FnOnce(&mut ActiveGuest) -> T) -> Option<T> {
    let link = app.state::<LinkState>();
    let mut guest = link.guest.lock().ok()?;
    guest.as_mut().map(f)
}

pub fn snapshot(app: &AppHandle) -> GuestSnapshot {
    with_guest(app, |guest| GuestSnapshot {
        status: guest.status.clone(),
        song: guest.song.clone(),
        transport: guest.transport.clone(),
        live_settings: guest.live_settings.clone(),
    })
    .unwrap_or(GuestSnapshot {
        status: GuestStatus::default(),
        song: None,
        transport: None,
        live_settings: None,
    })
}

fn emit_status(app: &AppHandle) {
    if let Some(status) = with_guest(app, |guest| guest.status.clone()) {
        let _ = app.emit(GUEST_STATUS_EVENT, status);
    }
}

pub fn join_host(
    app: &AppHandle,
    target: &str,
    pin: Option<String>,
    remember: bool,
) -> Result<GuestStatus, String> {
    let (url, address) =
        parse_join_target(target, DEFAULT_LINK_PORT).ok_or_else(|| "invalidAddress".to_string())?;
    leave(app);

    let link = app.state::<LinkState>();
    let guest_config = {
        let config = link.config.lock().map_err(|_| "state poisoned")?;
        let token = config
            .host_ids_by_address
            .get(&address)
            .and_then(|host_id| config.host_tokens.get(host_id))
            .cloned();
        GuestConfig {
            device_name: config.device_name.clone(),
            platform: platform().into(),
            app_version: app.package_info().version.to_string(),
            pin: pin.and_then(|pin| config::NetworkSessionConfig::pin(&pin)),
            remember,
            token,
            ..GuestConfig::new(url, config.device_id.clone())
        }
    };

    let runtime = join(guest_config);
    let handle = runtime.handle.clone();
    let task = tauri::async_runtime::spawn(relay(app.clone(), address.clone(), runtime.events));
    let status = GuestStatus {
        joined: true,
        address,
        state: "connecting".into(),
        ..GuestStatus::default()
    };
    *link.guest.lock().map_err(|_| "state poisoned")? = Some(ActiveGuest {
        handle,
        task,
        status: status.clone(),
        song: None,
        transport: None,
        live_settings: None,
    });
    emit_status(app);
    Ok(status)
}

pub fn leave(app: &AppHandle) {
    let link = app.state::<LinkState>();
    let previous = link.guest.lock().ok().and_then(|mut guest| guest.take());
    if let Some(previous) = previous {
        previous.handle.leave();
        previous.task.abort();
        let _ = app.emit(
            GUEST_STATUS_EVENT,
            GuestStatus {
                state: "closed".into(),
                ..GuestStatus::default()
            },
        );
    }
}

fn remember_token(app: &AppHandle, address: &str, host_id: &str, token: Option<&str>) {
    if host_id.is_empty() {
        return;
    }
    let link = app.state::<LinkState>();
    let Ok(mut config) = link.config.lock() else {
        return;
    };
    let mut changed = config
        .host_ids_by_address
        .insert(address.to_string(), host_id.to_string())
        .as_deref()
        != Some(host_id);
    if let Some(token) = token {
        changed |= config
            .host_tokens
            .insert(host_id.to_string(), token.to_string())
            .as_deref()
            != Some(token);
    }
    if changed {
        config::save(app, &config);
    }
}

async fn relay(
    app: AppHandle,
    address: String,
    mut events: tokio::sync::mpsc::Receiver<GuestEvent>,
) {
    let mut rtt_tick = tokio::time::interval(std::time::Duration::from_secs(1));
    loop {
        let event = tokio::select! {
            event = events.recv() => match event {
                Some(event) => event,
                None => return,
            },
            _ = rtt_tick.tick() => {
                let rtt = with_guest(&app, |guest| {
                    let rtt = guest.handle.round_trip_ms().map(|rtt| rtt.round() as u32);
                    let changed = guest.status.rtt_ms != rtt;
                    guest.status.rtt_ms = rtt;
                    changed
                });
                if rtt == Some(true) {
                    emit_status(&app);
                }
                continue;
            }
        };
        match event {
            GuestEvent::State(state) => {
                let (name, reason, expected) = state_name(&state);
                with_guest(&app, |guest| {
                    guest.status.state = name.into();
                    guest.status.reason = reason;
                    guest.status.expected_protocol = expected;
                });
                emit_status(&app);
            }
            GuestEvent::Welcome {
                host_id,
                host_name,
                grants,
                token,
                ..
            } => {
                remember_token(&app, &address, &host_id, token.as_deref());
                with_guest(&app, |guest| {
                    guest.status.host_name = host_name;
                    guest.status.role = Some(grants.role);
                });
                emit_status(&app);
            }
            GuestEvent::GrantsChanged(grants) => {
                with_guest(&app, |guest| guest.status.role = Some(grants.role));
                emit_status(&app);
            }
            GuestEvent::Peers(peers) => {
                with_guest(&app, |guest| guest.status.peers = peers);
                emit_status(&app);
            }
            GuestEvent::Song(song) => {
                with_guest(&app, |guest| guest.song = Some(song.clone()));
                let _ = app.emit(GUEST_SONG_EVENT, song);
            }
            GuestEvent::LiveSettings(settings) => {
                with_guest(&app, |guest| guest.live_settings = Some(settings.clone()));
                let _ = app.emit(GUEST_LIVE_SETTINGS_EVENT, settings);
            }
            GuestEvent::Transport {
                snapshot,
                host_monotonic_ms,
            } => {
                let transport = with_guest(&app, |guest| {
                    let position = host_position_now(
                        &snapshot,
                        host_monotonic_ms,
                        guest.handle.now_ms(),
                        guest.handle.host_offset_ms(),
                    );
                    let transport = GuestTransport {
                        snapshot,
                        anchor_position_seconds: position,
                        emitted_at_unix_ms: unix_ms(),
                    };
                    guest.transport = Some(transport.clone());
                    transport
                });
                if let Some(transport) = transport {
                    let _ = app.emit(GUEST_TRANSPORT_EVENT, transport);
                }
            }
        }
    }
}

/// Error codes the UI translates.
pub fn command_error_code(error: CommandError) -> &'static str {
    match error {
        CommandError::NotConnected => "notConnected",
        CommandError::Disconnected => "disconnected",
        CommandError::TimedOut => "timedOut",
        CommandError::Rejected(CommandRejection::Forbidden) => "forbidden",
        CommandError::Rejected(CommandRejection::Stale) => "stale",
        CommandError::Rejected(CommandRejection::Invalid) => "invalid",
    }
}

pub async fn send_command(
    app: &AppHandle,
    command: LinkCommand,
    base_revision: Option<u64>,
) -> Result<(), String> {
    let handle =
        with_guest(app, |guest| guest.handle.clone()).ok_or_else(|| "notConnected".to_string())?;
    handle
        .send_command(command, base_revision)
        .await
        .map_err(|error| command_error_code(error).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn playing(anchor: f64, rate: f64) -> Value {
        json!({
            "playbackState": "playing",
            "positionSeconds": anchor - 0.5,
            "transportClock": { "anchorPositionSeconds": anchor, "playbackRate": rate, "running": true }
        })
    }

    #[test]
    fn playing_snapshot_advances_with_the_host_clock() {
        // Host stamped it at host-ms 10_000; guest is 3_000 ms behind and
        // it is now guest-ms 7_500 = host-ms 10_500.
        let position = host_position_now(&playing(12.0, 1.0), 10_000, 7_500.0, Some(3_000.0));
        assert!((position - 12.5).abs() < 1e-9);
    }

    #[test]
    fn stopped_snapshot_stays_at_its_position() {
        let snapshot = json!({
            "playbackState": "stopped",
            "positionSeconds": 42.0,
            "transportClock": { "anchorPositionSeconds": 1.0, "playbackRate": 1.0, "running": false }
        });
        assert_eq!(host_position_now(&snapshot, 0, 99_999.0, Some(0.0)), 42.0);
    }

    #[test]
    fn without_a_clock_sample_the_snapshot_counts_as_fresh() {
        let position = host_position_now(&playing(12.0, 1.0), 50_000, 7.0, None);
        assert!((position - 12.0).abs() < 1e-9);
    }

    #[test]
    fn warped_rate_is_followed() {
        let position = host_position_now(&playing(10.0, 0.5), 0, 2_000.0, Some(0.0));
        assert!((position - 11.0).abs() < 1e-9);
    }

    #[test]
    fn command_errors_have_stable_codes() {
        assert_eq!(
            command_error_code(CommandError::NotConnected),
            "notConnected"
        );
        assert_eq!(
            command_error_code(CommandError::Rejected(CommandRejection::Stale)),
            "stale"
        );
    }
}
