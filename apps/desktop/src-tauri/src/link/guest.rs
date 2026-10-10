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

/// Field the host adds to each pushed song view: `[projectRevision,
/// mixRevision]` it was read at. Never reaches the UI.
pub const SONG_REVISION_FIELD: &str = "linkRevision";

pub struct ActiveGuest {
    handle: GuestHandle,
    task: tauri::async_runtime::JoinHandle<()>,
    status: GuestStatus,
    /// Last song view the host pushed, without the revision tag.
    song: Option<Value>,
    song_revision: Option<(u64, u64)>,
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
    host_id: Option<String>,
) -> Result<GuestStatus, String> {
    let (url, address) =
        parse_join_target(target, DEFAULT_LINK_PORT).ok_or_else(|| "invalidAddress".to_string())?;
    leave(app);

    let link = app.state::<LinkState>();
    let guest_config = {
        let config = link.config.lock().map_err(|_| "state poisoned")?;
        // By the host's id when discovery told us who it is (its address may
        // have changed since), else by the address it answered at before.
        let known_host_id = host_id
            .filter(|id| !id.is_empty())
            .or_else(|| config.host_ids_by_address.get(&address).cloned());
        let token = known_host_id
            .and_then(|host_id| config.host_tokens.get(&host_id))
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

    let runtime = join(guest_config)?;
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
        song_revision: None,
        transport: None,
        live_settings: None,
    });
    super::keep_awake("link-guest", true);
    emit_status(app);
    Ok(status)
}

pub fn leave(app: &AppHandle) {
    let link = app.state::<LinkState>();
    let previous = link.guest.lock().ok().and_then(|mut guest| guest.take());
    if let Some(previous) = previous {
        super::keep_awake("link-guest", false);
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
            GuestEvent::Event {
                name,
                payload,
                host_monotonic_ms,
            } => {
                // Mirror mode: the host's app event, under a prefixed name so
                // it never mixes with this device's own (idle) engine events.
                let payload = if name == "transport:lifecycle" {
                    with_guest(&app, |guest| {
                        rewrite_lifecycle(
                            payload.clone(),
                            host_monotonic_ms,
                            guest.handle.now_ms(),
                            guest.handle.host_offset_ms(),
                            unix_ms(),
                        )
                    })
                    .unwrap_or(payload)
                } else {
                    payload
                };
                let _ = app.emit(&format!("{MIRROR_EVENT_PREFIX}{name}"), payload);
            }
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
                let (song, revision) = untag_song(song);
                with_guest(&app, |guest| {
                    guest.song = Some(song.clone());
                    guest.song_revision = revision;
                });
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

/// Prefix of the host's app events re-emitted on a guest (mirror mode).
pub const MIRROR_EVENT_PREFIX: &str = "link-mirror://";

/// Prefix of the errors a guest's UI translates (`guest:forbidden`, …).
/// A command that ran on the host and failed returns the host's own error
/// text instead, exactly as if it had failed locally.
pub const GUEST_ERROR_PREFIX: &str = "guest:";

/// A host's `transport:lifecycle` re-anchored for this device: the UI
/// extrapolates the playhead from `anchorPositionSeconds` at
/// `emittedAtUnixMs` on ITS clock, so both are moved to now on this device,
/// across the network delay and the clock offset.
pub fn rewrite_lifecycle(
    mut payload: Value,
    host_instant_ms: u64,
    guest_now_ms: f64,
    offset_ms: Option<f64>,
    guest_unix_ms: u64,
) -> Value {
    let snapshot = &payload["snapshot"];
    let running = snapshot["playbackState"] == "playing"
        && snapshot["transportClock"]["running"]
            .as_bool()
            .unwrap_or(false);
    let rate = snapshot["transportClock"]["playbackRate"]
        .as_f64()
        .unwrap_or(1.0);
    if let Some(anchor) = payload["anchorPositionSeconds"].as_f64() {
        let offset = offset_ms.unwrap_or(host_instant_ms as f64 - guest_now_ms);
        let moved = extrapolate_position(
            anchor,
            host_instant_ms as f64,
            rate,
            running,
            guest_now_ms,
            offset,
        );
        payload["anchorPositionSeconds"] = Value::from(moved);
    }
    payload["emittedAtUnixMs"] = Value::from(guest_unix_ms);
    payload
}

/// Error codes the UI translates.
pub fn command_error_code(error: &CommandError) -> String {
    match error {
        CommandError::NotConnected => "notConnected".into(),
        CommandError::Disconnected => "disconnected".into(),
        CommandError::TimedOut => "timedOut".into(),
        CommandError::Rejected(CommandRejection::Forbidden) => "forbidden".into(),
        CommandError::Rejected(CommandRejection::Stale) => "stale".into(),
        CommandError::Rejected(CommandRejection::Invalid) => "invalid".into(),
        CommandError::Rejected(CommandRejection::Failed) => "invalid".into(),
        CommandError::Rejected(CommandRejection::NotAvailable) => "notAvailable".into(),
        CommandError::Failed(message) => message.clone(),
    }
}

pub async fn send_command(
    app: &AppHandle,
    command: LinkCommand,
    base_revision: Option<u64>,
) -> Result<Value, String> {
    let handle =
        with_guest(app, |guest| guest.handle.clone()).ok_or_else(|| "notConnected".to_string())?;
    handle
        .send_command(command, base_revision)
        .await
        .map_err(|error| command_error_code(&error))
}

/// Mirror mode: run one of the desktop UI's commands on the host. The
/// host's own error text comes back as is; refusals come back as
/// `guest:<code>` so the UI can say why in the user's language.
pub async fn proxy_invoke(app: &AppHandle, command: String, args: Value) -> Result<Value, String> {
    // The UI polls the transport four times a second. Answered here, from the
    // snapshot the host pushes every 90 ms moved forward to now: the playhead
    // no longer waits behind the host's session lock (a warp or key change
    // holds it for a while, and the guest's playhead froze, then jumped), and
    // the host is spared those requests exactly when it is busiest.
    if command == "get_transport_snapshot" {
        let now = unix_ms();
        if let Some(Some(snapshot)) = with_guest(app, |guest| {
            guest.transport.as_ref().map(|t| local_snapshot(t, now))
        }) {
            return Ok(snapshot);
        }
    }

    // Same for the song view the UI refetches after every revision bump (and
    // twice after a warp or key change): the host already pushed it, tagged
    // with its revision. Only used when that is the revision the UI saw;
    // otherwise (the push is still on its way) ask the host as before.
    if command == "get_song_view" && args["includeWaveforms"] != Value::Bool(true) {
        if let Some(Some(song)) = with_guest(app, |guest| {
            let wanted = guest
                .transport
                .as_ref()
                .and_then(|t| snapshot_revision(&t.snapshot));
            (wanted.is_some() && wanted == guest.song_revision)
                .then(|| guest.song.clone())
                .flatten()
        }) {
            return Ok(song);
        }
    }

    let handle = with_guest(app, |guest| guest.handle.clone())
        .ok_or_else(|| format!("{GUEST_ERROR_PREFIX}notConnected"))?;
    let started = std::time::Instant::now();
    let logged_command = command.clone();
    let value = handle
        .send_command(LinkCommand::Invoke { command, args }, None)
        .await
        .map_err(|error| match error {
            CommandError::Failed(message) => message,
            other => format!("{GUEST_ERROR_PREFIX}{}", command_error_code(&other)),
        })?;
    // Diagnosis of slow round trips on real devices (adb logcat / Console).
    let elapsed = started.elapsed().as_millis();
    if elapsed >= 300 {
        eprintln!("[libretracks-link] {logged_command} took {elapsed} ms on the host");
    }

    // Most session commands answer with the transport snapshot they left
    // behind (play, seek, a jump…): keep it, so the next poll does not hand
    // back the state from before the command for a moment.
    if is_transport_snapshot(&value) {
        let transport = GuestTransport {
            anchor_position_seconds: snapshot_anchor(&value),
            snapshot: value.clone(),
            emitted_at_unix_ms: unix_ms(),
        };
        with_guest(app, |guest| guest.transport = Some(transport));
    }
    Ok(value)
}

/// Host side: the song view as pushed, with the revision it was read at.
pub fn tag_song<T: Serialize>(song: &T, revision: Option<(u64, u64)>) -> Value {
    let mut value = serde_json::to_value(song).unwrap_or(Value::Null);
    if let (Value::Object(map), Some((project, mix))) = (&mut value, revision) {
        map.insert(
            SONG_REVISION_FIELD.into(),
            serde_json::json!([project, mix]),
        );
    }
    value
}

/// Guest side: the song view as the UI expects it, and its revision when the
/// host tagged it (an older host does not).
pub fn untag_song(mut song: Value) -> (Value, Option<(u64, u64)>) {
    let revision = song
        .as_object_mut()
        .and_then(|map| map.remove(SONG_REVISION_FIELD))
        .and_then(|tag| Some((tag[0].as_u64()?, tag[1].as_u64()?)));
    (song, revision)
}

fn snapshot_revision(snapshot: &Value) -> Option<(u64, u64)> {
    Some((
        snapshot["projectRevision"].as_u64()?,
        snapshot["mixRevision"].as_u64()?,
    ))
}

fn is_transport_snapshot(value: &Value) -> bool {
    value.get("playbackState").is_some() && value.get("transportClock").is_some()
}

fn snapshot_running(snapshot: &Value) -> bool {
    snapshot["playbackState"] == "playing"
        && snapshot["transportClock"]["running"]
            .as_bool()
            .unwrap_or(false)
}

/// Where a snapshot says the playhead was when it was taken.
fn snapshot_anchor(snapshot: &Value) -> f64 {
    if snapshot_running(snapshot) {
        snapshot["transportClock"]["anchorPositionSeconds"].as_f64()
    } else {
        snapshot["positionSeconds"].as_f64()
    }
    .unwrap_or(0.0)
}

/// The cached host snapshot as of `now_unix_ms` on this device: when playing,
/// the position moves on at the playback rate from where the host was when
/// it arrived (already corrected for the network and the clock offset).
pub fn local_snapshot(transport: &GuestTransport, now_unix_ms: u64) -> Value {
    let mut snapshot = transport.snapshot.clone();
    if snapshot_running(&snapshot) {
        let rate = snapshot["transportClock"]["playbackRate"]
            .as_f64()
            .unwrap_or(1.0);
        let elapsed = now_unix_ms.saturating_sub(transport.emitted_at_unix_ms) as f64 / 1000.0;
        let position = transport.anchor_position_seconds + elapsed * rate;
        snapshot["positionSeconds"] = Value::from(position);
        snapshot["transportClock"]["anchorPositionSeconds"] = Value::from(position);
    }
    snapshot
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
            command_error_code(&CommandError::NotConnected),
            "notConnected"
        );
        assert_eq!(
            command_error_code(&CommandError::Rejected(CommandRejection::Stale)),
            "stale"
        );
        assert_eq!(
            command_error_code(&CommandError::Failed("clip not found".into())),
            "clip not found"
        );
    }

    #[test]
    fn the_cached_snapshot_moves_on_while_playing() {
        let transport = GuestTransport {
            snapshot: playing(10.0, 1.0),
            anchor_position_seconds: 10.25,
            emitted_at_unix_ms: 1_000,
        };
        let now = local_snapshot(&transport, 1_500);
        assert!((now["positionSeconds"].as_f64().unwrap() - 10.75).abs() < 1e-9);
        assert!(
            (now["transportClock"]["anchorPositionSeconds"]
                .as_f64()
                .unwrap()
                - 10.75)
                .abs()
                < 1e-9
        );
        // Half speed (warp): half as far.
        let slow = GuestTransport {
            snapshot: playing(10.0, 0.5),
            ..transport.clone()
        };
        assert!(
            (local_snapshot(&slow, 2_000)["positionSeconds"]
                .as_f64()
                .unwrap()
                - 10.75)
                .abs()
                < 1e-9
        );
    }

    #[test]
    fn a_stopped_cached_snapshot_stays_put() {
        let transport = GuestTransport {
            snapshot: json!({
                "playbackState": "stopped",
                "positionSeconds": 42.0,
                "transportClock": { "running": false, "anchorPositionSeconds": 1.0 }
            }),
            anchor_position_seconds: 42.0,
            emitted_at_unix_ms: 0,
        };
        assert_eq!(local_snapshot(&transport, 99_000)["positionSeconds"], 42.0);
    }

    #[test]
    fn pushed_song_carries_its_revision_and_the_ui_never_sees_it() {
        let tagged = tag_song(&json!({ "title": "Song" }), Some((12, 3)));
        assert_eq!(tagged[SONG_REVISION_FIELD], json!([12, 3]));
        let (song, revision) = untag_song(tagged);
        assert_eq!(song, json!({ "title": "Song" }));
        assert_eq!(revision, Some((12, 3)));
        // An older host: no tag, so the guest keeps asking it.
        assert_eq!(untag_song(json!({ "title": "Song" })).1, None);
        // No song loaded on the host.
        assert_eq!(
            untag_song(tag_song(&Value::Null, Some((1, 0)))),
            (Value::Null, None)
        );
        assert_eq!(
            snapshot_revision(&json!({ "projectRevision": 12, "mixRevision": 3 })),
            Some((12, 3))
        );
    }

    #[test]
    fn command_results_are_recognised_as_snapshots() {
        assert!(is_transport_snapshot(&playing(1.0, 1.0)));
        assert!(!is_transport_snapshot(&json!({ "title": "song view" })));
        assert_eq!(snapshot_anchor(&playing(7.0, 1.0)), 7.0);
    }

    #[test]
    fn lifecycle_is_reanchored_to_this_device() {
        let payload = json!({
            "kind": "play",
            "snapshot": playing(10.0, 1.0),
            "anchorPositionSeconds": 10.0,
            "emittedAtUnixMs": 1u64,
        });
        // Host stamped it at host-ms 5_000; now it is guest-ms 2_250 and the
        // host is 3_000 ms ahead: 250 ms later on the host clock.
        let moved = rewrite_lifecycle(payload, 5_000, 2_250.0, Some(3_000.0), 777);
        assert!((moved["anchorPositionSeconds"].as_f64().unwrap() - 10.25).abs() < 1e-9);
        assert_eq!(moved["emittedAtUnixMs"], 777);
        assert_eq!(moved["kind"], "play");
    }

    #[test]
    fn a_stopped_lifecycle_keeps_its_position() {
        let payload = json!({
            "snapshot": { "playbackState": "stopped", "transportClock": { "running": false } },
            "anchorPositionSeconds": 42.0,
            "emittedAtUnixMs": 1u64,
        });
        let moved = rewrite_lifecycle(payload, 0, 99_999.0, Some(0.0), 5);
        assert_eq!(moved["anchorPositionSeconds"], 42.0);
    }
}
