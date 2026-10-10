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
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::Value;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot, watch};
use tokio_tungstenite::tungstenite::Message;

use crate::pairing::{HelloOutcome, HelloRequest, Pairing, TrustedDevice};
use crate::permissions::{is_allowed, Grants, Role};
use crate::protocol::{
    ClientMessage, CommandRejection, LinkCommand, PeerInfo, RejectReason, ServerMessage,
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
    });

    tokio::spawn(accept_loop(listener, shared.clone()));
    Ok(HostRuntime {
        handle: HostHandle { shared },
        commands,
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
        self.shared.publish_guests();
    }
}

impl Shared {
    fn now_ms(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
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
        self.peers_tx.send_replace(to_text(&peers));
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
    if let Some(text) = to_text(&ServerMessage::Rejected {
        reason,
        expected_protocol: expected,
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
    let Ok(mut ws) = tokio_tungstenite::accept_async(stream).await else {
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
    }) = read_hello(&mut ws, shared.hello_timeout).await
    else {
        reject_and_close(&mut ws, RejectReason::BadHello, None).await;
        return;
    };

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
            ClientMessage::Hello { .. } => {}
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
    };
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
