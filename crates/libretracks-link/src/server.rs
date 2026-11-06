//! The host side: a WebSocket server on the LAN that lets guests in with a
//! role, mirrors the session to them and forwards their commands to the app.
//!
//! Design points (docs/plans/network-sessions/02-servidor-anfitrion.md):
//! - Only runs while the user hosts; `stop()` closes every guest.
//! - Each published payload is serialized ONCE and shared as `Arc<str>`.
//! - Each guest has its own writer that follows the latest transport / song /
//!   live settings through `watch` channels: latest-wins, so a slow guest
//!   skips stale frames and never holds anyone else back.
//! - Permissions are checked here, against the guest's CURRENT grants (the
//!   host can change them live), before a command reaches the app.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::Value;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot, watch};
use tokio_tungstenite::tungstenite::Message;

use crate::pairing::{HelloOutcome, HelloRequest, Pairing, TrustedDevice};
use crate::permissions::{backup_may_send, is_allowed, Grants, Role};
use crate::protocol::{
    ClientMessage, CommandRejection, LinkCommand, PeerInfo, RejectReason, ServerMessage,
};
use crate::redundancy::{
    HealthSummary, PeerKind, RedundancyMessage, RedundancySettingsInfo,
    DEFAULT_HEARTBEAT_TIMEOUT_MS, HEARTBEAT_INTERVAL_MS, REDUNDANCY_PROTOCOL_VERSION,
};
use crate::version::PROTOCOL_VERSION;

/// The port hosts try first; the next `port_attempts - 1` are fallbacks.
/// Not 3030: that one is the remote's.
pub const DEFAULT_LINK_PORT: u16 = 3040;
pub const DEFAULT_MAX_GUESTS: usize = 32;

#[derive(Debug, Clone)]
pub struct HostConfig {
    pub bind_ip: IpAddr,
    pub preferred_port: u16,
    pub port_attempts: u16,
    /// Stable id of this install; sent in `welcome` and the mDNS record.
    pub host_id: String,
    pub host_name: String,
    pub control_pin: Option<String>,
    pub edit_pin: Option<String>,
    pub trusted: Vec<TrustedDevice>,
    pub max_guests: usize,
    pub hello_timeout: Duration,
    /// With nothing else to send, the latest transport frame is resent this
    /// often so guests can tell a quiet host from a dead connection.
    pub heartbeat: Duration,
    /// How long the app has to apply a command before the guest is told it
    /// failed.
    pub command_timeout: Duration,
    /// Guests (viewer/controller/editor). Off when the server only runs for
    /// a redundancy backup (docs/plans/redundancy R2).
    pub accept_guests: bool,
    /// Redundancy: let ONE backup in. Off by default; the app turns it on.
    pub accept_backup: bool,
    /// PIN a backup needs (its own, not the guests'). None = only a trusted
    /// backup token gets in.
    pub backup_pin: Option<String>,
    pub backup_trusted: Vec<TrustedDevice>,
    /// The backup may forward transport commands to this host.
    pub backup_may_forward: bool,
    /// New on every launch of the app (not of hosting): sent to the backup
    /// so it knows when the main restarted.
    pub instance_id: String,
}

impl HostConfig {
    pub fn new(host_name: impl Into<String>) -> Self {
        Self {
            bind_ip: IpAddr::from([0, 0, 0, 0]),
            preferred_port: DEFAULT_LINK_PORT,
            port_attempts: 10,
            host_id: String::new(),
            host_name: host_name.into(),
            control_pin: None,
            edit_pin: None,
            trusted: Vec::new(),
            max_guests: DEFAULT_MAX_GUESTS,
            hello_timeout: Duration::from_secs(2),
            heartbeat: Duration::from_secs(1),
            // Generous: an `invoke` can be a whole song view with peaks.
            command_timeout: Duration::from_secs(30),
            accept_guests: true,
            accept_backup: false,
            backup_pin: None,
            backup_trusted: Vec::new(),
            backup_may_forward: false,
            instance_id: random_hex(16),
        }
    }
}

/// Why a command did not go through, as the guest will see it.
#[derive(Debug, Clone, PartialEq)]
pub struct CommandFailure {
    pub reason: CommandRejection,
    pub message: Option<String>,
}

impl From<CommandRejection> for CommandFailure {
    fn from(reason: CommandRejection) -> Self {
        Self {
            reason,
            message: None,
        }
    }
}

/// What the app answers for a command: the command's return value (Null
/// for the typed commands) or why it failed.
pub type CommandReply = Result<Value, CommandFailure>;

/// A command a guest is allowed to send, for the app to apply.
#[derive(Debug)]
pub struct IncomingCommand {
    pub device_id: String,
    pub device_name: String,
    pub grants: Grants,
    pub base_revision: Option<u64>,
    pub command: LinkCommand,
    pub reply: oneshot::Sender<CommandReply>,
    /// Forwarded by the redundancy backup, not sent by a guest.
    pub from_backup: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuestSummary {
    pub device_id: String,
    pub device_name: String,
    pub platform: String,
    pub app_version: String,
    pub grants: Grants,
    pub connected_at_ms: u64,
    pub rtt_ms: Option<u32>,
    pub trusted: bool,
}

pub struct HostRuntime {
    pub handle: HostHandle,
    pub commands: mpsc::Receiver<IncomingCommand>,
    /// Redundancy messages from the backup (heartbeats, status), in order.
    pub backup_messages: mpsc::Receiver<RedundancyMessage>,
}

#[derive(Debug)]
enum Control {
    Send(Arc<str>),
    /// Send this, then close the socket.
    Close(Arc<str>),
}

struct GuestConn {
    conn_id: u64,
    summary: GuestSummary,
    control: mpsc::Sender<Control>,
}

struct BackupConn {
    conn_id: u64,
    summary: GuestSummary,
    control: mpsc::Sender<Control>,
}

struct Shared {
    port: u16,
    session_id: String,
    host_id: String,
    host_name: String,
    started: Instant,
    max_guests: usize,
    hello_timeout: Duration,
    heartbeat: Duration,
    command_timeout: Duration,
    pairing: Mutex<Pairing>,
    guests: Mutex<HashMap<String, GuestConn>>,
    next_conn: AtomicU64,
    transport_tx: watch::Sender<Option<Arc<str>>>,
    song_tx: watch::Sender<Option<Arc<str>>>,
    live_settings_tx: watch::Sender<Option<Arc<str>>>,
    peers_tx: watch::Sender<Option<Arc<str>>>,
    guests_tx: watch::Sender<Vec<GuestSummary>>,
    trusted_tx: watch::Sender<Vec<TrustedDevice>>,
    commands_tx: mpsc::Sender<IncomingCommand>,
    shutdown_tx: watch::Sender<bool>,
    /// Relayed app events, in order. A guest that falls this far behind
    /// skips the oldest (it will catch up from the next snapshot).
    events_tx: tokio::sync::broadcast::Sender<Arc<str>>,
    accept_guests: AtomicBool,
    // --- redundancy (docs/plans/redundancy) ---
    accept_backup: AtomicBool,
    backup_may_forward: AtomicBool,
    instance_id: String,
    backup_pairing: Mutex<Pairing>,
    backup: Mutex<Option<BackupConn>>,
    backup_tx: watch::Sender<Option<GuestSummary>>,
    backup_trusted_tx: watch::Sender<Vec<TrustedDevice>>,
    backup_in_tx: mpsc::Sender<RedundancyMessage>,
    /// One counter for every numbered message to the backup (states,
    /// intents, heartbeats), so one gate on the backup orders them all.
    redundancy_seq: AtomicU64,
    health_tx: watch::Sender<HealthSummary>,
}

#[derive(Clone)]
pub struct HostHandle {
    shared: Arc<Shared>,
}

fn to_text<T: Serialize>(value: &T) -> Option<Arc<str>> {
    serde_json::to_string(value).ok().map(Arc::from)
}

pub fn random_hex(bytes: usize) -> String {
    let mut buffer = vec![0u8; bytes];
    // getrandom only fails on platforms without an entropy source; fall back
    // to the clock rather than refuse to host.
    if getrandom::getrandom(&mut buffer).is_err() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default();
        for (index, byte) in buffer.iter_mut().enumerate() {
            *byte = (nanos >> ((index % 16) * 8)) as u8;
        }
    }
    buffer.iter().map(|byte| format!("{byte:02x}")).collect()
}

async fn bind_with_fallback(config: &HostConfig) -> std::io::Result<TcpListener> {
    let mut last_error = None;
    for offset in 0..config.port_attempts.max(1) {
        let port = if config.preferred_port == 0 {
            0
        } else {
            config.preferred_port.saturating_add(offset)
        };
        match TcpListener::bind(SocketAddr::new(config.bind_ip, port)).await {
            Ok(listener) => return Ok(listener),
            Err(error) => last_error = Some(error),
        }
        if config.preferred_port == 0 {
            break;
        }
    }
    Err(last_error.unwrap_or_else(|| std::io::Error::other("no port to bind")))
}

/// Start hosting. The returned `commands` receiver must be drained by the
/// app: every command a guest is allowed to send arrives there.
pub async fn start_host(config: HostConfig) -> std::io::Result<HostRuntime> {
    let listener = bind_with_fallback(&config).await?;
    let port = listener.local_addr()?.port();
    let pairing = Pairing::new(
        config.control_pin.clone(),
        config.edit_pin.clone(),
        config.trusted.clone(),
    );
    let (commands_tx, commands) = mpsc::channel(64);
    let (shutdown_tx, _) = watch::channel(false);
    let trusted = pairing.trusted_devices();
    let backup_pairing = Pairing::new(
        config.backup_pin.clone(),
        None,
        config.backup_trusted.clone(),
    );
    let backup_trusted = backup_pairing.trusted_devices();
    let (backup_in_tx, backup_messages) = mpsc::channel(256);

    let shared = Arc::new(Shared {
        port,
        session_id: random_hex(8),
        host_id: config.host_id.clone(),
        host_name: config.host_name.clone(),
        started: Instant::now(),
        max_guests: config.max_guests,
        hello_timeout: config.hello_timeout,
        heartbeat: config.heartbeat,
        command_timeout: config.command_timeout,
        pairing: Mutex::new(pairing),
        guests: Mutex::new(HashMap::new()),
        next_conn: AtomicU64::new(1),
        transport_tx: watch::channel(None).0,
        song_tx: watch::channel(None).0,
        live_settings_tx: watch::channel(None).0,
        peers_tx: watch::channel(None).0,
        guests_tx: watch::channel(Vec::new()).0,
        trusted_tx: watch::channel(trusted).0,
        commands_tx,
        shutdown_tx,
        events_tx: tokio::sync::broadcast::channel(512).0,
        accept_guests: AtomicBool::new(config.accept_guests),
        accept_backup: AtomicBool::new(config.accept_backup),
        backup_may_forward: AtomicBool::new(config.backup_may_forward),
        instance_id: config.instance_id.clone(),
        backup_pairing: Mutex::new(backup_pairing),
        backup: Mutex::new(None),
        backup_tx: watch::channel(None).0,
        backup_trusted_tx: watch::channel(backup_trusted).0,
        backup_in_tx,
        redundancy_seq: AtomicU64::new(1),
        health_tx: watch::channel(HealthSummary::default()).0,
    });

    tokio::spawn(accept_loop(listener, shared.clone()));
    Ok(HostRuntime {
        handle: HostHandle { shared },
        commands,
        backup_messages,
    })
}

async fn accept_loop(listener: TcpListener, shared: Arc<Shared>) {
    let mut shutdown = shared.shutdown_tx.subscribe();
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let Ok((stream, addr)) = accepted else { continue };
                let _ = stream.set_nodelay(true);
                tokio::spawn(handle_connection(stream, addr, shared.clone()));
            }
            _ = shutdown.changed() => return,
        }
    }
}

impl HostHandle {
    pub fn port(&self) -> u16 {
        self.shared.port
    }

    pub fn session_id(&self) -> &str {
        &self.shared.session_id
    }

    pub fn host_id(&self) -> &str {
        &self.shared.host_id
    }

    pub fn host_name(&self) -> &str {
        &self.shared.host_name
    }

    fn now_ms(&self) -> u64 {
        self.shared.now_ms()
    }

    /// Publish the transport snapshot. Serialized once for every guest.
    pub fn publish_transport<T: Serialize>(&self, snapshot: &T) {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Out<'a, T> {
            #[serde(rename = "type")]
            kind: &'static str,
            host_monotonic_ms: u64,
            snapshot: &'a T,
        }
        if let Some(text) = to_text(&Out {
            kind: "transport",
            host_monotonic_ms: self.now_ms(),
            snapshot,
        }) {
            self.shared.transport_tx.send_replace(Some(text));
        }
    }

    /// Publish the song view (without waveform peaks).
    pub fn publish_song<T: Serialize>(&self, song: &T) {
        #[derive(Serialize)]
        struct Out<'a, T> {
            #[serde(rename = "type")]
            kind: &'static str,
            song: &'a T,
        }
        if let Some(text) = to_text(&Out { kind: "song", song }) {
            self.shared.song_tx.send_replace(Some(text));
        }
    }

    /// Same as [`publish_song`](Self::publish_song) for a view the caller
    /// already serialized (the session feed serializes it once per revision
    /// to detect changes). `song_json` must be one valid JSON value; it goes
    /// out as is, without parsing it again.
    pub fn publish_song_json(&self, song_json: &str) {
        let text = format!(r#"{{"type":"song","song":{song_json}}}"#);
        self.shared.song_tx.send_replace(Some(Arc::from(text)));
    }

    pub fn publish_live_settings<T: Serialize>(&self, settings: &T) {
        #[derive(Serialize)]
        struct Out<'a, T> {
            #[serde(rename = "type")]
            kind: &'static str,
            settings: &'a T,
        }
        if let Some(text) = to_text(&Out {
            kind: "liveSettings",
            settings,
        }) {
            self.shared.live_settings_tx.send_replace(Some(text));
        }
    }

    /// Relay an app event to every guest (mirror mode). Serialized once.
    pub fn publish_event<T: Serialize>(&self, name: &str, payload: &T) {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Out<'a, T> {
            #[serde(rename = "type")]
            kind: &'static str,
            name: &'a str,
            payload: &'a T,
            host_monotonic_ms: u64,
        }
        if self.shared.events_tx.receiver_count() == 0 {
            return;
        }
        if let Some(text) = to_text(&Out {
            kind: "event",
            name,
            payload,
            host_monotonic_ms: self.now_ms(),
        }) {
            let _ = self.shared.events_tx.send(text);
        }
    }

    pub fn guests(&self) -> Vec<GuestSummary> {
        self.shared.guests_tx.borrow().clone()
    }

    /// Follow the guest list (for the host UI).
    pub fn subscribe_guests(&self) -> watch::Receiver<Vec<GuestSummary>> {
        self.shared.guests_tx.subscribe()
    }

    pub fn trusted_devices(&self) -> Vec<TrustedDevice> {
        self.shared.trusted_tx.borrow().clone()
    }

    /// Follow the trusted-device list (for the app to persist it).
    pub fn subscribe_trusted(&self) -> watch::Receiver<Vec<TrustedDevice>> {
        self.shared.trusted_tx.subscribe()
    }

    pub fn set_pins(&self, control_pin: Option<String>, edit_pin: Option<String>) {
        if let Ok(mut pairing) = self.shared.pairing.lock() {
            pairing.set_pins(control_pin, edit_pin);
        }
    }

    /// Change a connected guest's role live. Also updates the stored role of
    /// a trusted device. Returns whether the device was connected.
    pub fn set_grants(&self, device_id: &str, grants: Grants) -> bool {
        if let Ok(mut pairing) = self.shared.pairing.lock() {
            pairing.update_trusted_role(device_id, grants.role);
        }
        self.shared.publish_trusted();
        self.shared.apply_grants(device_id, grants)
    }

    /// Disconnect a guest. It can rejoin (as viewer, or with its token if it
    /// is still trusted); revoke it too to keep it at viewer.
    pub fn kick(&self, device_id: &str) -> bool {
        let removed = self
            .shared
            .guests
            .lock()
            .ok()
            .and_then(|mut guests| guests.remove(device_id));
        let Some(guest) = removed else {
            return false;
        };
        if let Some(text) = to_text(&ServerMessage::Rejected {
            reason: RejectReason::Kicked,
            expected_protocol: None,
            detail: None,
        }) {
            let _ = guest.control.try_send(Control::Close(text));
        }
        self.shared.publish_guests();
        true
    }

    /// Forget a trusted device. If it is connected it drops to viewer at once.
    pub fn revoke_trusted(&self, device_id: &str) -> bool {
        let revoked = self
            .shared
            .pairing
            .lock()
            .map(|mut pairing| pairing.revoke(device_id))
            .unwrap_or(false);
        self.shared.publish_trusted();
        self.shared.apply_grants(device_id, Grants::VIEWER);
        self.shared.publish_guests();
        revoked
    }

    /// Stop hosting: no new connections, every guest disconnected.
    pub fn stop(&self) {
        self.shared.shutdown_tx.send_replace(true);
        if let Ok(mut guests) = self.shared.guests.lock() {
            guests.clear();
        }
        if let Ok(mut backup) = self.shared.backup.lock() {
            *backup = None;
        }
        self.shared.publish_guests();
        self.shared.backup_tx.send_replace(None);
    }

    pub fn set_accept_guests(&self, accept: bool) {
        self.shared.accept_guests.store(accept, Ordering::Relaxed);
    }

    // --- redundancy ---

    pub fn instance_id(&self) -> &str {
        &self.shared.instance_id
    }

    pub fn set_accept_backup(&self, accept: bool) {
        self.shared.accept_backup.store(accept, Ordering::Relaxed);
        if !accept {
            self.kick_backup();
        }
    }

    pub fn set_backup_may_forward(&self, allow: bool) {
        self.shared.backup_may_forward.store(allow, Ordering::Relaxed);
    }

    pub fn set_backup_pin(&self, pin: Option<String>) {
        if let Ok(mut pairing) = self.shared.backup_pairing.lock() {
            pairing.set_pins(pin, None);
        }
    }

    /// The connected backup, if any. Never part of [`guests`](Self::guests).
    pub fn backup(&self) -> Option<GuestSummary> {
        self.shared.backup_tx.borrow().clone()
    }

    pub fn subscribe_backup(&self) -> watch::Receiver<Option<GuestSummary>> {
        self.shared.backup_tx.subscribe()
    }

    pub fn backup_trusted_devices(&self) -> Vec<TrustedDevice> {
        self.shared.backup_trusted_tx.borrow().clone()
    }

    pub fn subscribe_backup_trusted(&self) -> watch::Receiver<Vec<TrustedDevice>> {
        self.shared.backup_trusted_tx.subscribe()
    }

    pub fn revoke_backup_trusted(&self, device_id: &str) -> bool {
        let revoked = self
            .shared
            .backup_pairing
            .lock()
            .map(|mut pairing| pairing.revoke(device_id))
            .unwrap_or(false);
        self.shared.publish_backup_trusted();
        revoked
    }

    /// Disconnect the backup (to let another one in). Returns whether there
    /// was one.
    pub fn kick_backup(&self) -> bool {
        let removed = self
            .shared
            .backup
            .lock()
            .ok()
            .and_then(|mut backup| backup.take());
        let Some(backup) = removed else {
            return false;
        };
        if let Some(text) = to_text(&ServerMessage::Rejected {
            reason: RejectReason::Kicked,
            expected_protocol: None,
            detail: None,
        }) {
            let _ = backup.control.try_send(Control::Close(text));
        }
        self.shared.backup_tx.send_replace(None);
        true
    }

    /// Next number for a state or intent to the backup (heartbeats draw from
    /// the same counter).
    pub fn next_redundancy_seq(&self) -> u64 {
        self.shared.next_redundancy_seq()
    }

    /// Send one message to the backup. False when there is none or its queue
    /// is full (it is behind; the next state catches it up).
    pub fn send_to_backup(&self, message: &RedundancyMessage) -> bool {
        let control = self
            .shared
            .backup
            .lock()
            .ok()
            .and_then(|backup| backup.as_ref().map(|backup| backup.control.clone()));
        let (Some(control), Some(text)) = (
            control,
            to_text(&ServerMessage::Redundancy {
                message: message.clone(),
            }),
        ) else {
            return false;
        };
        control.try_send(Control::Send(text)).is_ok()
    }

    /// Health carried by the heartbeats to the backup.
    pub fn set_health(&self, health: HealthSummary) {
        self.shared.health_tx.send_replace(health);
    }

    /// The link's monotonic clock, in ms: the base of clock pongs, so of
    /// every `monotonicNs` the backup receives (divided by 1e6).
    pub fn monotonic_ms(&self) -> u64 {
        self.shared.now_ms()
    }

    /// Same clock as [`monotonic_ms`](Self::monotonic_ms), in ns.
    pub fn monotonic_ns(&self) -> u64 {
        self.shared.started.elapsed().as_nanos() as u64
    }

    /// The instant this host's link clock counts from, to translate an
    /// engine `Instant` into link ns.
    pub fn clock_origin(&self) -> Instant {
        self.shared.started
    }
}

impl Shared {
    fn now_ms(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }

    fn next_redundancy_seq(&self) -> u64 {
        self.redundancy_seq.fetch_add(1, Ordering::Relaxed)
    }

    fn publish_backup_trusted(&self) {
        if let Ok(pairing) = self.backup_pairing.lock() {
            self.backup_trusted_tx.send_replace(pairing.trusted_devices());
        }
    }

    fn publish_trusted(&self) {
        if let Ok(pairing) = self.pairing.lock() {
            self.trusted_tx.send_replace(pairing.trusted_devices());
        }
    }

    fn publish_guests(&self) {
        let trusted: Vec<String> = self
            .pairing
            .lock()
            .map(|pairing| {
                pairing
                    .trusted_devices()
                    .into_iter()
                    .map(|device| device.device_id)
                    .collect()
            })
            .unwrap_or_default();
        let mut list: Vec<GuestSummary> = self
            .guests
            .lock()
            .map(|guests| guests.values().map(|guest| guest.summary.clone()).collect())
            .unwrap_or_default();
        for guest in &mut list {
            guest.trusted = trusted.contains(&guest.device_id);
        }
        list.sort_by(|a, b| a.device_name.cmp(&b.device_name));

        let peers = ServerMessage::Peers {
            peers: list
                .iter()
                .map(|guest| PeerInfo {
                    device_id: guest.device_id.clone(),
                    device_name: guest.device_name.clone(),
                    platform: guest.platform.clone(),
                    grants: guest.grants,
                })
                .collect(),
        };
        // Only when the list itself changed: this also runs on every guest's
        // new round-trip time (about once a second each), which the peers
        // list does not carry, and resending it then woke every guest's UI
        // for nothing.
        let text = to_text(&peers);
        self.peers_tx.send_if_modified(|current| {
            let changed = *current != text;
            if changed {
                *current = text;
            }
            changed
        });
        self.guests_tx.send_replace(list);
    }

    fn apply_grants(&self, device_id: &str, grants: Grants) -> bool {
        let control = self.guests.lock().ok().and_then(|mut guests| {
            let guest = guests.get_mut(device_id)?;
            guest.summary.grants = grants;
            Some(guest.control.clone())
        });
        let Some(control) = control else {
            return false;
        };
        if let Some(text) = to_text(&ServerMessage::GrantsChanged { grants }) {
            let _ = control.try_send(Control::Send(text));
        }
        self.publish_guests();
        true
    }

    fn current_grants(&self, device_id: &str, conn_id: u64) -> Option<(Grants, String)> {
        let guests = self.guests.lock().ok()?;
        let guest = guests.get(device_id)?;
        (guest.conn_id == conn_id)
            .then(|| (guest.summary.grants, guest.summary.device_name.clone()))
    }
}

type WsStream = tokio_tungstenite::WebSocketStream<TcpStream>;

async fn reject_and_close(ws: &mut WsStream, reason: RejectReason, expected: Option<u32>) {
    reject_and_close_with(ws, reason, expected, None).await
}

async fn reject_and_close_with(
    ws: &mut WsStream,
    reason: RejectReason,
    expected: Option<u32>,
    detail: Option<String>,
) {
    if let Some(text) = to_text(&ServerMessage::Rejected {
        reason,
        expected_protocol: expected,
        detail,
    }) {
        let _ = ws.send(Message::Text(text.to_string())).await;
    }
    let _ = ws.close(None).await;
}

async fn read_hello(ws: &mut WsStream, timeout: Duration) -> Option<ClientMessage> {
    let next = tokio::time::timeout(timeout, async {
        loop {
            match ws.next().await? {
                Ok(Message::Text(text)) => return serde_json::from_str(&text).ok(),
                Ok(Message::Ping(_) | Message::Pong(_)) => continue,
                _ => return None,
            }
        }
    })
    .await
    .ok()??;
    matches!(next, ClientMessage::Hello { .. }).then_some(next)
}

async fn handle_connection(stream: TcpStream, addr: SocketAddr, shared: Arc<Shared>) {
    let Ok(mut ws) =
        tokio_tungstenite::accept_async_with_config(stream, Some(crate::websocket_config())).await
    else {
        return;
    };

    let Some(ClientMessage::Hello {
        protocol_version,
        device_id,
        device_name,
        platform,
        app_version,
        pin,
        remember,
        token,
        peer_kind,
    }) = read_hello(&mut ws, shared.hello_timeout).await
    else {
        reject_and_close(&mut ws, RejectReason::BadHello, None).await;
        return;
    };

    if peer_kind == PeerKind::Backup {
        let hello = BackupHello {
            protocol_version,
            device_id,
            device_name,
            platform,
            app_version,
            pin,
            remember,
            token,
        };
        handle_backup(ws, addr, shared, hello).await;
        return;
    }
    if !shared.accept_guests.load(Ordering::Relaxed) {
        reject_and_close(&mut ws, RejectReason::HostFull, None).await;
        return;
    }

    let full = shared
        .guests
        .lock()
        .map(|guests| guests.len() >= shared.max_guests && !guests.contains_key(&device_id))
        .unwrap_or(true);
    if full {
        reject_and_close(&mut ws, RejectReason::HostFull, None).await;
        return;
    }

    let outcome = {
        let Ok(mut pairing) = shared.pairing.lock() else {
            return;
        };
        pairing.evaluate(
            addr.ip(),
            shared.now_ms(),
            PROTOCOL_VERSION,
            &HelloRequest {
                protocol_version,
                device_id: &device_id,
                device_name: &device_name,
                pin: pin.as_deref(),
                remember,
                token: token.as_deref(),
            },
            || random_hex(32),
        )
    };

    let (protocol_version, grants, new_token) = match outcome {
        HelloOutcome::Accepted {
            protocol_version,
            grants,
            new_token,
        } => (protocol_version, grants, new_token),
        HelloOutcome::Rejected {
            reason,
            expected_protocol,
        } => {
            reject_and_close(&mut ws, reason, expected_protocol).await;
            return;
        }
    };
    if new_token.is_some() {
        shared.publish_trusted();
    }

    let conn_id = shared.next_conn.fetch_add(1, Ordering::Relaxed);
    let (control_tx, control_rx) = mpsc::channel::<Control>(64);
    let replaced = shared.guests.lock().ok().and_then(|mut guests| {
        guests.insert(
            device_id.clone(),
            GuestConn {
                conn_id,
                summary: GuestSummary {
                    device_id: device_id.clone(),
                    device_name: device_name.clone(),
                    platform,
                    app_version,
                    grants,
                    connected_at_ms: shared.now_ms(),
                    rtt_ms: None,
                    trusted: false,
                },
                control: control_tx.clone(),
            },
        )
    });
    // The same device reconnecting before its old socket died: the old one
    // goes, quietly.
    if let Some(old) = replaced {
        let _ = old.control.try_send(Control::Close(Arc::from("")));
    }
    shared.publish_guests();

    let Some(welcome) = to_text(&ServerMessage::Welcome {
        protocol_version,
        session_id: shared.session_id.clone(),
        host_id: shared.host_id.clone(),
        host_name: shared.host_name.clone(),
        grants,
        token: new_token,
        host_monotonic_ms: shared.now_ms(),
    }) else {
        return;
    };
    if ws.send(Message::Text(welcome.to_string())).await.is_err() {
        drop_guest(&shared, &device_id, conn_id);
        return;
    }

    let (sink, mut source) = ws.split();
    let writer = tokio::spawn(run_writer(
        sink,
        control_rx,
        shared.clone(),
        device_id.clone(),
        conn_id,
    ));

    while let Some(Ok(message)) = source.next().await {
        let text = match message {
            Message::Text(text) => text,
            Message::Close(_) => break,
            _ => continue,
        };
        let Ok(message) = serde_json::from_str::<ClientMessage>(&text) else {
            continue;
        };
        match message {
            ClientMessage::Command {
                request_id,
                base_revision,
                command,
            } => handle_command(
                &shared,
                &control_tx,
                &device_id,
                conn_id,
                request_id,
                base_revision,
                command,
            ),
            ClientMessage::ClockPing { t0, rtt_ms } => {
                let t1 = shared.now_ms();
                if rtt_ms.is_some() {
                    let changed = shared
                        .guests
                        .lock()
                        .ok()
                        .and_then(|mut guests| {
                            let guest = guests.get_mut(&device_id)?;
                            (guest.conn_id == conn_id && guest.summary.rtt_ms != rtt_ms).then(
                                || {
                                    guest.summary.rtt_ms = rtt_ms;
                                },
                            )
                        })
                        .is_some();
                    if changed {
                        shared.publish_guests();
                    }
                }
                let pong = ServerMessage::ClockPong {
                    t0,
                    t1,
                    t2: shared.now_ms(),
                };
                if let Some(text) = to_text(&pong) {
                    let _ = control_tx.try_send(Control::Send(text));
                }
            }
            ClientMessage::Hello { .. } | ClientMessage::Redundancy { .. } => {}
        }
    }

    drop(control_tx);
    drop_guest(&shared, &device_id, conn_id);
    writer.abort();
}

fn drop_guest(shared: &Shared, device_id: &str, conn_id: u64) {
    let removed = shared
        .guests
        .lock()
        .map(|mut guests| {
            if guests
                .get(device_id)
                .is_some_and(|guest| guest.conn_id == conn_id)
            {
                guests.remove(device_id);
                true
            } else {
                false
            }
        })
        .unwrap_or(false);
    if removed {
        shared.publish_guests();
    }
}

fn handle_command(
    shared: &Arc<Shared>,
    control: &mpsc::Sender<Control>,
    device_id: &str,
    conn_id: u64,
    request_id: u64,
    base_revision: Option<u64>,
    command: LinkCommand,
) {
    let reply_with =
        |result: CommandReply| to_text(&result_message(request_id, result)).map(Control::Send);

    let Some((grants, device_name)) = shared.current_grants(device_id, conn_id) else {
        return;
    };
    if !is_allowed(&grants, &command) {
        if let Some(message) = reply_with(Err(CommandRejection::Forbidden.into())) {
            let _ = control.try_send(message);
        }
        return;
    }

    let (reply_tx, reply_rx) = oneshot::channel();
    let incoming = IncomingCommand {
        device_id: device_id.to_string(),
        device_name,
        grants,
        base_revision,
        command,
        reply: reply_tx,
        from_backup: false,
    };
    forward_command(shared, control, request_id, incoming, reply_rx);
}

/// Hand an allowed command to the app and answer the peer when it is done.
fn forward_command(
    shared: &Arc<Shared>,
    control: &mpsc::Sender<Control>,
    request_id: u64,
    incoming: IncomingCommand,
    reply_rx: oneshot::Receiver<CommandReply>,
) {
    let control = control.clone();
    let commands_tx = shared.commands_tx.clone();
    let timeout = shared.command_timeout;
    tokio::spawn(async move {
        let result = if commands_tx.send(incoming).await.is_err() {
            Err(CommandRejection::Invalid.into())
        } else {
            match tokio::time::timeout(timeout, reply_rx).await {
                Ok(Ok(result)) => result,
                _ => Err(CommandRejection::Invalid.into()),
            }
        };
        if let Some(text) = to_text(&result_message(request_id, result)) {
            let _ = control.send(Control::Send(text)).await;
        }
    });
}

fn result_message(request_id: u64, result: CommandReply) -> ServerMessage {
    match result {
        Ok(value) => ServerMessage::CommandResult {
            request_id,
            ok: true,
            reason: None,
            value: (!value.is_null()).then_some(value),
            message: None,
        },
        Err(failure) => ServerMessage::CommandResult {
            request_id,
            ok: false,
            reason: Some(failure.reason),
            value: None,
            message: failure.message,
        },
    }
}

async fn run_writer(
    mut sink: futures_util::stream::SplitSink<WsStream, Message>,
    mut control: mpsc::Receiver<Control>,
    shared: Arc<Shared>,
    device_id: String,
    conn_id: u64,
) {
    let mut transport = shared.transport_tx.subscribe();
    let mut song = shared.song_tx.subscribe();
    let mut live = shared.live_settings_tx.subscribe();
    let mut peers = shared.peers_tx.subscribe();
    let mut shutdown = shared.shutdown_tx.subscribe();
    let mut events = shared.events_tx.subscribe();
    let mut heartbeat = tokio::time::interval(shared.heartbeat);
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    let is_editor = |shared: &Shared| {
        shared
            .current_grants(&device_id, conn_id)
            .is_some_and(|(grants, _)| grants.role == Role::Editor)
    };

    // Catch up with what was published before this guest arrived.
    let mut initial: Vec<Arc<str>> = Vec::new();
    initial.extend(song.borrow_and_update().clone());
    initial.extend(live.borrow_and_update().clone());
    initial.extend(transport.borrow_and_update().clone());
    let initial_peers = peers.borrow_and_update().clone();
    if is_editor(&shared) {
        initial.extend(initial_peers);
    }
    for text in initial {
        if sink.send(Message::Text(text.to_string())).await.is_err() {
            return;
        }
    }

    let mut last_sent = Instant::now();
    loop {
        let outgoing: Option<Arc<str>> = tokio::select! {
            message = control.recv() => match message {
                Some(Control::Send(text)) => Some(text),
                Some(Control::Close(text)) => {
                    if !text.is_empty() {
                        let _ = sink.send(Message::Text(text.to_string())).await;
                    }
                    let _ = sink.close().await;
                    return;
                }
                None => return,
            },
            changed = transport.changed() => {
                if changed.is_err() { return; }
                transport.borrow_and_update().clone()
            }
            changed = song.changed() => {
                if changed.is_err() { return; }
                song.borrow_and_update().clone()
            }
            changed = live.changed() => {
                if changed.is_err() { return; }
                live.borrow_and_update().clone()
            }
            changed = peers.changed() => {
                if changed.is_err() { return; }
                let text = peers.borrow_and_update().clone();
                if is_editor(&shared) { text } else { None }
            }
            event = events.recv() => match event {
                Ok(text) => Some(text),
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => None,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
            },
            _ = heartbeat.tick() => {
                if last_sent.elapsed() >= shared.heartbeat {
                    transport.borrow().clone()
                } else {
                    None
                }
            }
            _ = shutdown.changed() => {
                let _ = sink.close().await;
                return;
            }
        };
        if let Some(text) = outgoing {
            if sink.send(Message::Text(text.to_string())).await.is_err() {
                return;
            }
            last_sent = Instant::now();
        }
    }
}

#[cfg(test)]
#[path = "server_tests.rs"]
mod tests;

// --- redundancy backup connection (docs/plans/redundancy step 01) ---

struct BackupHello {
    protocol_version: u32,
    device_id: String,
    device_name: String,
    platform: String,
    app_version: String,
    pin: Option<String>,
    remember: bool,
    token: Option<String>,
}

/// Name of the current backup when it is not this device.
fn other_backup_name(shared: &Shared, device_id: &str) -> Option<String> {
    shared.backup.lock().ok().and_then(|backup| {
        backup
            .as_ref()
            .filter(|backup| backup.summary.device_id != device_id)
            .map(|backup| backup.summary.device_name.clone())
    })
}

async fn handle_backup(
    mut ws: WsStream,
    addr: SocketAddr,
    shared: Arc<Shared>,
    hello: BackupHello,
) {
    if !shared.accept_backup.load(Ordering::Relaxed) {
        reject_and_close(&mut ws, RejectReason::BackupNotAccepted, None).await;
        return;
    }
    // Only one backup. The same device reconnecting replaces its old socket.
    if let Some(current) = other_backup_name(&shared, &hello.device_id) {
        reject_and_close_with(
            &mut ws,
            RejectReason::BackupAlreadyConnected,
            None,
            Some(current),
        )
        .await;
        return;
    }

    let outcome = {
        let Ok(mut pairing) = shared.backup_pairing.lock() else {
            return;
        };
        pairing.evaluate(
            addr.ip(),
            shared.now_ms(),
            PROTOCOL_VERSION,
            &HelloRequest {
                protocol_version: hello.protocol_version,
                device_id: &hello.device_id,
                device_name: &hello.device_name,
                pin: hello.pin.as_deref(),
                remember: hello.remember,
                token: hello.token.as_deref(),
            },
            || random_hex(32),
        )
    };
    // The backup pairing has one PIN, in the controller slot: anything below
    // that (no PIN, no valid token) is not a paired backup.
    let (protocol_version, grants, new_token) = match outcome {
        HelloOutcome::Accepted {
            protocol_version,
            grants,
            new_token,
        } if grants.role >= Role::Controller => (protocol_version, grants, new_token),
        HelloOutcome::Accepted { .. } => {
            reject_and_close(&mut ws, RejectReason::BadPin, None).await;
            return;
        }
        HelloOutcome::Rejected {
            reason,
            expected_protocol,
        } => {
            reject_and_close(&mut ws, reason, expected_protocol).await;
            return;
        }
    };
    if new_token.is_some() {
        shared.publish_backup_trusted();
    }

    let conn_id = shared.next_conn.fetch_add(1, Ordering::Relaxed);
    let (control_tx, control_rx) = mpsc::channel::<Control>(256);
    let summary = GuestSummary {
        device_id: hello.device_id.clone(),
        device_name: hello.device_name.clone(),
        platform: hello.platform,
        app_version: hello.app_version,
        grants,
        connected_at_ms: shared.now_ms(),
        rtt_ms: None,
        trusted: hello.token.is_some() || new_token.is_some(),
    };
    // Checked again under the lock: two backups may pass the PIN at once.
    let inserted = shared.backup.lock().ok().map(|mut backup| {
        if let Some(current) = backup
            .as_ref()
            .filter(|backup| backup.summary.device_id != hello.device_id)
        {
            return Err(current.summary.device_name.clone());
        }
        Ok(backup.replace(BackupConn {
            conn_id,
            summary: summary.clone(),
            control: control_tx.clone(),
        }))
    });
    match inserted {
        Some(Ok(Some(old))) => {
            let _ = old.control.try_send(Control::Close(Arc::from("")));
        }
        Some(Ok(None)) => {}
        Some(Err(current)) => {
            reject_and_close_with(
                &mut ws,
                RejectReason::BackupAlreadyConnected,
                None,
                Some(current),
            )
            .await;
            return;
        }
        None => return,
    }
    shared.backup_tx.send_replace(Some(summary));

    let welcome = to_text(&ServerMessage::Welcome {
        protocol_version,
        session_id: shared.session_id.clone(),
        host_id: shared.host_id.clone(),
        host_name: shared.host_name.clone(),
        grants,
        token: new_token,
        host_monotonic_ms: shared.now_ms(),
    });
    let redundancy_welcome = to_text(&ServerMessage::Redundancy {
        message: RedundancyMessage::Welcome {
            version: REDUNDANCY_PROTOCOL_VERSION,
            main_name: shared.host_name.clone(),
            instance_id: shared.instance_id.clone(),
            settings: RedundancySettingsInfo {
                backup_may_forward: shared.backup_may_forward.load(Ordering::Relaxed),
                heartbeat_timeout_ms: DEFAULT_HEARTBEAT_TIMEOUT_MS,
            },
        },
    });
    for text in [welcome, redundancy_welcome].into_iter().flatten() {
        if ws.send(Message::Text(text.to_string())).await.is_err() {
            drop_backup(&shared, conn_id);
            return;
        }
    }

    let (sink, mut source) = ws.split();
    let writer = tokio::spawn(run_backup_writer(sink, control_rx, shared.clone()));

    while let Some(Ok(message)) = source.next().await {
        let text = match message {
            Message::Text(text) => text,
            Message::Close(_) => break,
            _ => continue,
        };
        let Ok(message) = serde_json::from_str::<ClientMessage>(&text) else {
            continue;
        };
        match message {
            ClientMessage::Redundancy { message } => {
                let _ = shared.backup_in_tx.try_send(message);
            }
            ClientMessage::ClockPing { t0, rtt_ms } => {
                let t1 = shared.now_ms();
                if rtt_ms.is_some() {
                    let changed = shared.backup.lock().ok().and_then(|mut backup| {
                        let backup = backup.as_mut()?;
                        (backup.conn_id == conn_id && backup.summary.rtt_ms != rtt_ms).then(|| {
                            backup.summary.rtt_ms = rtt_ms;
                            backup.summary.clone()
                        })
                    });
                    if let Some(summary) = changed {
                        shared.backup_tx.send_replace(Some(summary));
                    }
                }
                if let Some(text) = to_text(&ServerMessage::ClockPong {
                    t0,
                    t1,
                    t2: shared.now_ms(),
                }) {
                    let _ = control_tx.try_send(Control::Send(text));
                }
            }
            ClientMessage::Command {
                request_id,
                base_revision,
                command,
            } => {
                let allowed = shared.backup_may_forward.load(Ordering::Relaxed)
                    && backup_may_send(&command);
                if !allowed {
                    if let Some(text) = to_text(&result_message(
                        request_id,
                        Err(CommandRejection::Forbidden.into()),
                    )) {
                        let _ = control_tx.try_send(Control::Send(text));
                    }
                    continue;
                }
                let (reply, reply_rx) = oneshot::channel();
                let incoming = IncomingCommand {
                    device_id: hello.device_id.clone(),
                    device_name: hello.device_name.clone(),
                    grants,
                    base_revision,
                    command,
                    reply,
                    from_backup: true,
                };
                forward_command(&shared, &control_tx, request_id, incoming, reply_rx);
            }
            ClientMessage::Hello { .. } => {}
        }
    }

    drop(control_tx);
    drop_backup(&shared, conn_id);
    writer.abort();
}

fn drop_backup(shared: &Shared, conn_id: u64) {
    let removed = shared
        .backup
        .lock()
        .map(|mut backup| {
            if backup.as_ref().is_some_and(|backup| backup.conn_id == conn_id) {
                *backup = None;
                true
            } else {
                false
            }
        })
        .unwrap_or(false);
    if removed {
        shared.backup_tx.send_replace(None);
    }
}

/// The backup's writer: its control queue plus a heartbeat every
/// [`HEARTBEAT_INTERVAL_MS`]. No transport/song/peers feeds: a backup gets
/// only redundancy messages (and pongs and command results).
async fn run_backup_writer(
    mut sink: futures_util::stream::SplitSink<WsStream, Message>,
    mut control: mpsc::Receiver<Control>,
    shared: Arc<Shared>,
) {
    let mut shutdown = shared.shutdown_tx.subscribe();
    let mut heartbeat = tokio::time::interval(Duration::from_millis(HEARTBEAT_INTERVAL_MS));
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        let outgoing: Option<Arc<str>> = tokio::select! {
            message = control.recv() => match message {
                Some(Control::Send(text)) => Some(text),
                Some(Control::Close(text)) => {
                    if !text.is_empty() {
                        let _ = sink.send(Message::Text(text.to_string())).await;
                    }
                    let _ = sink.close().await;
                    return;
                }
                None => return,
            },
            _ = heartbeat.tick() => to_text(&ServerMessage::Redundancy {
                message: RedundancyMessage::Heartbeat {
                    seq: shared.next_redundancy_seq(),
                    monotonic_ns: shared.started.elapsed().as_nanos() as u64,
                    health: *shared.health_tx.borrow(),
                },
            }),
            _ = shutdown.changed() => {
                let _ = sink.close().await;
                return;
            }
        };
        if let Some(text) = outgoing {
            if sink.send(Message::Text(text.to_string())).await.is_err() {
                return;
            }
        }
    }
}

#[cfg(test)]
#[path = "redundancy_tests.rs"]
mod redundancy_tests;
