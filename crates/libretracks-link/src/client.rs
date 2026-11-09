//! The guest side: join a host, stay joined through a stage Wi-Fi, follow
//! its clock and send it commands.
//!
//! - Reconnects on its own after a drop (backoff 0.5 → 1 → 2 → 4 s, capped),
//!   reusing the trusted-device token, and asks nothing of the UI meanwhile.
//! - Does NOT reconnect after a rejection (bad PIN, kicked, full, version):
//!   retrying would only repeat it.
//! - Hears from the host at least every heartbeat; three seconds of silence
//!   is treated as a lost connection, so a dead socket is noticed even when
//!   the OS has not noticed it yet.
//! - Commands only go out while connected. On a drop, the ones waiting for
//!   an answer fail with `Disconnected`: a jump the host never saw must not
//!   happen late.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use libretracks_core::net_clock::{ClockEstimator, ClockSample, CLOCK_PING_INTERVAL_MS};
use serde::Serialize;
use serde_json::Value;
use tokio::sync::{mpsc, oneshot, watch};
use tokio_tungstenite::{connect_async_with_config, tungstenite::Message};

use crate::permissions::{is_allowed, Grants};
use crate::protocol::{
    ClientMessage, CommandRejection, LinkCommand, PeerInfo, RejectReason, ServerMessage,
};
use crate::redundancy::{HealthSummary, PeerKind, RedundancyMessage, HEARTBEAT_INTERVAL_MS};
use crate::version::PROTOCOL_VERSION;

#[derive(Debug, Clone)]
pub struct GuestConfig {
    /// `ws://ip:port`
    pub url: String,
    pub device_id: String,
    pub device_name: String,
    pub platform: String,
    pub app_version: String,
    pub pin: Option<String>,
    pub remember: bool,
    pub token: Option<String>,
    pub ping_interval: Duration,
    pub silence_timeout: Duration,
    pub connect_timeout: Duration,
    pub command_timeout: Duration,
    /// `Backup` = redundancy backup (docs/plans/redundancy): gets redundancy
    /// messages instead of the guest feeds and sends heartbeats.
    pub peer_kind: PeerKind,
}

impl GuestConfig {
    pub fn new(url: impl Into<String>, device_id: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            device_id: device_id.into(),
            device_name: String::new(),
            platform: String::new(),
            app_version: String::new(),
            pin: None,
            remember: false,
            token: None,
            ping_interval: Duration::from_millis(CLOCK_PING_INTERVAL_MS),
            silence_timeout: Duration::from_secs(3),
            connect_timeout: Duration::from_secs(3),
            // Generous: an `invoke` can be a whole song view with peaks.
            command_timeout: Duration::from_secs(30),
            peer_kind: PeerKind::Guest,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum GuestState {
    Connecting {
        attempt: u32,
    },
    Connected,
    /// Dropped; reconnecting on its own.
    Lost,
    /// The host said no. Final.
    Rejected {
        reason: RejectReason,
        expected_protocol: Option<u32>,
    },
    /// The user left.
    Closed,
}

#[derive(Debug, Clone, PartialEq)]
pub enum GuestEvent {
    State(GuestState),
    Welcome {
        host_id: String,
        host_name: String,
        session_id: String,
        grants: Grants,
        /// A new trusted-device token to keep for this host.
        token: Option<String>,
    },
    GrantsChanged(Grants),
    Transport {
        snapshot: Value,
        host_monotonic_ms: u64,
    },
    Song(Value),
    LiveSettings(Value),
    Peers(Vec<PeerInfo>),
    /// An app event relayed by the host (mirror mode).
    Event {
        name: String,
        payload: Value,
        host_monotonic_ms: u64,
    },
    /// Backup mode: a redundancy message from the main, decoded.
    Redundancy(RedundancyMessage),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommandError {
    NotConnected,
    Disconnected,
    TimedOut,
    Rejected(CommandRejection),
    /// The command ran on the host and returned this error.
    Failed(String),
}

/// Reconnection delays: grow, then stay at the cap.
#[derive(Debug, Clone)]
pub struct Backoff {
    next_ms: u64,
}

impl Backoff {
    pub const FIRST_MS: u64 = 500;
    pub const CAP_MS: u64 = 4_000;

    pub fn new() -> Self {
        Self {
            next_ms: Self::FIRST_MS,
        }
    }

    pub fn next_delay(&mut self) -> Duration {
        let delay = self.next_ms;
        self.next_ms = (self.next_ms * 2).min(Self::CAP_MS);
        Duration::from_millis(delay)
    }

    pub fn reset(&mut self) {
        self.next_ms = Self::FIRST_MS;
    }
}

impl Default for Backoff {
    fn default() -> Self {
        Self::new()
    }
}

struct Outgoing {
    command: LinkCommand,
    base_revision: Option<u64>,
    reply: oneshot::Sender<Result<Value, CommandError>>,
}

struct ClientShared {
    started: Instant,
    clock: Mutex<ClockEstimator>,
    grants: Mutex<Option<Grants>>,
    state_tx: watch::Sender<GuestState>,
    /// Backup mode: health carried by its heartbeats.
    health_tx: watch::Sender<HealthSummary>,
    /// Redundancy (step 16): where to try when the host disappears, as the
    /// host announced it (`ws://…`).
    failover: Mutex<Option<String>>,
    heartbeat_seq: std::sync::atomic::AtomicU64,
}

impl ClientShared {
    fn now_ms(&self) -> f64 {
        self.started.elapsed().as_secs_f64() * 1000.0
    }
}

#[derive(Clone)]
pub struct GuestHandle {
    shared: Arc<ClientShared>,
    commands: mpsc::Sender<Outgoing>,
    redundancy: mpsc::Sender<RedundancyMessage>,
    shutdown: watch::Sender<bool>,
    command_timeout: Duration,
}

pub struct GuestRuntime {
    pub handle: GuestHandle,
    pub events: mpsc::Receiver<GuestEvent>,
}

impl GuestHandle {
    pub fn state(&self) -> GuestState {
        self.shared.state_tx.borrow().clone()
    }

    pub fn grants(&self) -> Option<Grants> {
        *self.shared.grants.lock().ok()?
    }

    /// This client's monotonic clock, in ms. The base of `host_offset_ms`.
    pub fn now_ms(&self) -> f64 {
        self.shared.now_ms()
    }

    /// The instant this client's monotonic clock counts from, to put local
    /// engine instants on the same base as `host_offset_ms`.
    pub fn clock_origin(&self) -> Instant {
        self.shared.started
    }

    /// host clock − this client's clock, once there is a sample.
    pub fn host_offset_ms(&self) -> Option<f64> {
        self.shared.clock.lock().ok()?.offset()
    }

    pub fn round_trip_ms(&self) -> Option<f64> {
        self.shared.clock.lock().ok()?.round_trip()
    }

    /// Send a command and wait for the host's answer. Refused here, without
    /// a round trip, when not connected or when the current role cannot.
    pub async fn send_command(
        &self,
        command: LinkCommand,
        base_revision: Option<u64>,
    ) -> Result<Value, CommandError> {
        if self.state() != GuestState::Connected {
            return Err(CommandError::NotConnected);
        }
        if let Some(grants) = self.grants() {
            if !is_allowed(&grants, &command) {
                return Err(CommandError::Rejected(CommandRejection::Forbidden));
            }
        }
        let (reply, answer) = oneshot::channel();
        self.commands
            .send(Outgoing {
                command,
                base_revision,
                reply,
            })
            .await
            .map_err(|_| CommandError::NotConnected)?;
        match tokio::time::timeout(self.command_timeout + Duration::from_millis(500), answer).await
        {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(CommandError::Disconnected),
            Err(_) => Err(CommandError::TimedOut),
        }
    }

    pub fn leave(&self) {
        self.shutdown.send_replace(true);
    }

    /// Backup mode: send a redundancy message (status) to the main. False
    /// when not connected or the queue is full; heartbeats go on their own.
    pub fn send_redundancy(&self, message: RedundancyMessage) -> bool {
        self.state() == GuestState::Connected && self.redundancy.try_send(message).is_ok()
    }

    /// Backup mode: health carried by the heartbeats to the main.
    pub fn set_health(&self, health: HealthSummary) {
        self.shared.health_tx.send_replace(health);
    }
}

/// Connect to a main as its redundancy BACKUP: same reconnection as a guest,
/// redundancy messages arrive as [`GuestEvent::Redundancy`], heartbeats go
/// out every [`HEARTBEAT_INTERVAL_MS`]. Same runtime rule as [`join`].
pub fn connect_as_backup(mut config: GuestConfig) -> Result<GuestRuntime, String> {
    config.peer_kind = PeerKind::Backup;
    join(config)
}

/// Start joining. Must be called from inside a Tokio runtime: the connection
/// lives in a task. Outside one this returns an error instead of panicking
/// (a sync Tauri command runs on the IPC thread with no runtime, and a panic
/// there aborts the whole app on Android).
pub fn join(config: GuestConfig) -> Result<GuestRuntime, String> {
    let runtime = tokio::runtime::Handle::try_current()
        .map_err(|_| "no async runtime to run the connection".to_string())?;
    let (events_tx, events) = mpsc::channel(256);
    let (commands_tx, commands_rx) = mpsc::channel(64);
    let (redundancy_tx, redundancy_rx) = mpsc::channel(64);
    let (shutdown, _) = watch::channel(false);
    let shared = Arc::new(ClientShared {
        started: Instant::now(),
        clock: Mutex::new(ClockEstimator::default()),
        grants: Mutex::new(None),
        state_tx: watch::channel(GuestState::Connecting { attempt: 0 }).0,
        health_tx: watch::channel(HealthSummary::default()).0,
        failover: Mutex::new(None),
        heartbeat_seq: std::sync::atomic::AtomicU64::new(1),
    });
    let handle = GuestHandle {
        shared: shared.clone(),
        commands: commands_tx,
        redundancy: redundancy_tx,
        shutdown: shutdown.clone(),
        command_timeout: config.command_timeout,
    };
    runtime.spawn(run(
        config,
        shared,
        events_tx,
        commands_rx,
        redundancy_rx,
        shutdown,
    ));
    Ok(GuestRuntime { handle, events })
}

enum Ended {
    Rejected(RejectReason, Option<u32>),
    Lost { was_connected: bool },
    /// The host handed over (redundancy): go there now.
    Redirect(String),
    Shutdown,
}

/// `ip:port` (or a `ws://` URL) → `ws://ip:port`.
pub fn address_url(address: &str) -> String {
    if address.starts_with("ws://") || address.starts_with("wss://") {
        address.to_string()
    } else {
        format!("ws://{address}")
    }
}

/// Failed attempts on the host before trying its failover address too.
pub const ATTEMPTS_BEFORE_FAILOVER: u32 = 2;

/// Which URL the next attempt goes to: the host until it failed
/// [`ATTEMPTS_BEFORE_FAILOVER`] times, then alternating with the failover
/// address (if the host announced one). Pure.
pub fn next_url<'a>(primary: &'a str, failover: Option<&'a str>, failed: u32) -> &'a str {
    match failover {
        Some(failover) if failed >= ATTEMPTS_BEFORE_FAILOVER && failed % 2 == 0 => failover,
        _ => primary,
    }
}

async fn set_state(shared: &ClientShared, events: &mpsc::Sender<GuestEvent>, state: GuestState) {
    if *shared.state_tx.borrow() == state {
        return;
    }
    shared.state_tx.send_replace(state.clone());
    let _ = events.send(GuestEvent::State(state)).await;
}

async fn run(
    mut config: GuestConfig,
    shared: Arc<ClientShared>,
    events: mpsc::Sender<GuestEvent>,
    mut commands: mpsc::Receiver<Outgoing>,
    mut redundancy: mpsc::Receiver<RedundancyMessage>,
    shutdown: watch::Sender<bool>,
) {
    let mut shutdown_rx = shutdown.subscribe();
    let mut backoff = Backoff::new();
    let mut attempt = 0u32;
    // Redundancy failover (step 16): the host we belong to, and failed
    // attempts since the last connection.
    let mut primary = config.url.clone();
    let mut failed = 0u32;
    loop {
        attempt += 1;
        set_state(&shared, &events, GuestState::Connecting { attempt }).await;
        let ended = connect_and_serve(
            &mut config,
            &shared,
            &events,
            &mut commands,
            &mut redundancy,
            &mut shutdown_rx,
        )
        .await;
        // Anything still queued would reach the host late, or never.
        while let Ok(outgoing) = commands.try_recv() {
            let _ = outgoing.reply.send(Err(CommandError::Disconnected));
        }
        match ended {
            Ended::Shutdown => {
                set_state(&shared, &events, GuestState::Closed).await;
                return;
            }
            Ended::Rejected(reason, expected_protocol) => {
                set_state(
                    &shared,
                    &events,
                    GuestState::Rejected {
                        reason,
                        expected_protocol,
                    },
                )
                .await;
                return;
            }
            Ended::Redirect(url) => {
                // No way back to the old host: it handed over.
                primary = url.clone();
                config.url = url;
                failed = 0;
                if let Ok(mut failover) = shared.failover.lock() {
                    *failover = None;
                }
                backoff.reset();
                attempt = 0;
                set_state(&shared, &events, GuestState::Lost).await;
                continue;
            }
            Ended::Lost { was_connected } => {
                if was_connected {
                    backoff.reset();
                    attempt = 0;
                    failed = 0;
                    // Connected to the failover host: that is home now (no
                    // automatic way back).
                    primary = config.url.clone();
                } else {
                    failed += 1;
                }
                let failover = shared.failover.lock().ok().and_then(|slot| slot.clone());
                config.url = next_url(&primary, failover.as_deref(), failed).to_string();
                set_state(&shared, &events, GuestState::Lost).await;
                let delay = backoff.next_delay();
                tokio::select! {
                    _ = tokio::time::sleep(delay) => {}
                    _ = shutdown_rx.changed() => {
                        set_state(&shared, &events, GuestState::Closed).await;
                        return;
                    }
                }
            }
        }
    }
}

fn text(message: &ClientMessage) -> Message {
    Message::Text(serde_json::to_string(message).unwrap_or_default())
}

async fn connect_and_serve(
    config: &mut GuestConfig,
    shared: &Arc<ClientShared>,
    events: &mpsc::Sender<GuestEvent>,
    commands: &mut mpsc::Receiver<Outgoing>,
    redundancy: &mut mpsc::Receiver<RedundancyMessage>,
    shutdown: &mut watch::Receiver<bool>,
) -> Ended {
    let lost = Ended::Lost {
        was_connected: false,
    };
    let connect = tokio::time::timeout(
        config.connect_timeout,
        connect_async_with_config(&config.url, Some(crate::websocket_config()), false),
    );
    let socket = tokio::select! {
        result = connect => match result {
            Ok(Ok((socket, _))) => socket,
            _ => return lost,
        },
        _ = shutdown.changed() => return Ended::Shutdown,
    };
    let (mut sink, mut source) = socket.split();

    let hello = ClientMessage::Hello {
        protocol_version: PROTOCOL_VERSION,
        device_id: config.device_id.clone(),
        device_name: config.device_name.clone(),
        platform: config.platform.clone(),
        app_version: config.app_version.clone(),
        pin: config.pin.clone(),
        remember: config.remember,
        token: config.token.clone(),
        peer_kind: config.peer_kind,
    };
    if sink.send(text(&hello)).await.is_err() {
        return lost;
    }

    // Wait for welcome or rejection.
    let first = tokio::time::timeout(config.connect_timeout, async {
        while let Some(Ok(message)) = source.next().await {
            if let Message::Text(text) = message {
                if let Ok(message) = serde_json::from_str::<ServerMessage>(&text) {
                    return Some(message);
                }
            }
        }
        None
    })
    .await;
    let welcome = match first {
        Ok(Some(ServerMessage::Welcome {
            host_id,
            host_name,
            session_id,
            grants,
            token,
            ..
        })) => (host_id, host_name, session_id, grants, token),
        Ok(Some(ServerMessage::Rejected {
            reason,
            expected_protocol,
            ..
        })) => return Ended::Rejected(reason, expected_protocol),
        _ => return lost,
    };
    let (host_id, host_name, session_id, grants, token) = welcome;
    if let Some(token) = &token {
        // Reconnections use the token; the PIN has done its job.
        config.token = Some(token.clone());
    }
    if let Ok(mut current) = shared.grants.lock() {
        *current = Some(grants);
    }
    if let Ok(mut clock) = shared.clock.lock() {
        // A reconnection may be to a restarted host with a new clock.
        clock.reset();
    }
    let _ = events
        .send(GuestEvent::Welcome {
            host_id,
            host_name,
            session_id,
            grants,
            token,
        })
        .await;
    // Anything queued while disconnected is stale. Dropped BEFORE saying
    // we are connected: a message sent right after that must go out.
    while redundancy.try_recv().is_ok() {}
    set_state(shared, events, GuestState::Connected).await;

    let mut pending: HashMap<u64, oneshot::Sender<Result<Value, CommandError>>> = HashMap::new();
    let mut next_request = 1u64;
    let mut ping = tokio::time::interval(config.ping_interval);
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut last_heard = Instant::now();
    let silence = config.silence_timeout;
    let is_backup = config.peer_kind == PeerKind::Backup;
    let mut heartbeat = tokio::time::interval(Duration::from_millis(HEARTBEAT_INTERVAL_MS));
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    let ended = loop {
        tokio::select! {
            message = source.next() => {
                let Some(Ok(message)) = message else {
                    break Ended::Lost { was_connected: true };
                };
                last_heard = Instant::now();
                let Message::Text(text) = message else { continue };
                let Ok(message) = serde_json::from_str::<ServerMessage>(&text) else { continue };
                match message {
                    ServerMessage::Transport { host_monotonic_ms, snapshot } => {
                        let _ = events.send(GuestEvent::Transport { snapshot, host_monotonic_ms }).await;
                    }
                    ServerMessage::Song { song } => {
                        let _ = events.send(GuestEvent::Song(song)).await;
                    }
                    ServerMessage::LiveSettings { settings } => {
                        let _ = events.send(GuestEvent::LiveSettings(settings)).await;
                    }
                    ServerMessage::Peers { peers } => {
                        let _ = events.send(GuestEvent::Peers(peers)).await;
                    }
                    ServerMessage::GrantsChanged { grants } => {
                        if let Ok(mut current) = shared.grants.lock() {
                            *current = Some(grants);
                        }
                        let _ = events.send(GuestEvent::GrantsChanged(grants)).await;
                    }
                    ServerMessage::ClockPong { t0, t1, t2 } => {
                        let t3 = shared.now_ms();
                        if let Ok(mut clock) = shared.clock.lock() {
                            clock.add(ClockSample { t0: t0 as f64, t1: t1 as f64, t2: t2 as f64, t3 });
                        }
                    }
                    ServerMessage::CommandResult { request_id, ok, reason, value, message } => {
                        if let Some(reply) = pending.remove(&request_id) {
                            let result = if ok {
                                Ok(value.unwrap_or(Value::Null))
                            } else {
                                match reason.unwrap_or(CommandRejection::Invalid) {
                                    CommandRejection::Failed => Err(CommandError::Failed(
                                        message.unwrap_or_default(),
                                    )),
                                    other => Err(CommandError::Rejected(other)),
                                }
                            };
                            let _ = reply.send(result);
                        }
                    }
                    ServerMessage::Event { name, payload, host_monotonic_ms } => {
                        let _ = events.send(GuestEvent::Event { name, payload, host_monotonic_ms }).await;
                    }
                    ServerMessage::Rejected { reason, expected_protocol, .. } => {
                        break Ended::Rejected(reason, expected_protocol);
                    }
                    ServerMessage::Redundancy { message } => {
                        let _ = events.send(GuestEvent::Redundancy(message)).await;
                    }
                    ServerMessage::Failover { address } => {
                        if let Ok(mut failover) = shared.failover.lock() {
                            *failover = address.as_deref().map(address_url);
                        }
                    }
                    ServerMessage::Redirect { address } => {
                        break Ended::Redirect(address_url(&address));
                    }
                    ServerMessage::Welcome { .. } => {}
                }
            }
            message = redundancy.recv(), if is_backup => {
                let Some(message) = message else { break Ended::Shutdown };
                if sink.send(text(&ClientMessage::Redundancy { message })).await.is_err() {
                    break Ended::Lost { was_connected: true };
                }
            }
            _ = heartbeat.tick(), if is_backup => {
                let message = RedundancyMessage::Heartbeat {
                    seq: shared
                        .heartbeat_seq
                        .fetch_add(1, std::sync::atomic::Ordering::Relaxed),
                    monotonic_ns: shared.started.elapsed().as_nanos() as u64,
                    health: *shared.health_tx.borrow(),
                };
                if sink.send(text(&ClientMessage::Redundancy { message })).await.is_err() {
                    break Ended::Lost { was_connected: true };
                }
            }
            outgoing = commands.recv() => {
                let Some(outgoing) = outgoing else { break Ended::Shutdown };
                let request_id = next_request;
                next_request += 1;
                let message = ClientMessage::Command {
                    request_id,
                    base_revision: outgoing.base_revision,
                    command: outgoing.command,
                };
                if sink.send(text(&message)).await.is_err() {
                    let _ = outgoing.reply.send(Err(CommandError::Disconnected));
                    break Ended::Lost { was_connected: true };
                }
                pending.insert(request_id, outgoing.reply);
            }
            _ = ping.tick() => {
                if last_heard.elapsed() >= silence {
                    break Ended::Lost { was_connected: true };
                }
                let rtt_ms = shared
                    .clock
                    .lock()
                    .ok()
                    .and_then(|clock| clock.round_trip())
                    .map(|rtt| rtt.round() as u32);
                let ping = ClientMessage::ClockPing { t0: shared.now_ms() as u64, rtt_ms };
                if sink.send(text(&ping)).await.is_err() {
                    break Ended::Lost { was_connected: true };
                }
            }
            _ = shutdown.changed() => {
                let _ = sink.close().await;
                break Ended::Shutdown;
            }
        }
    };

    for (_, reply) in pending.drain() {
        let _ = reply.send(Err(CommandError::Disconnected));
    }
    ended
}

#[cfg(test)]
#[path = "client_tests.rs"]
mod tests;
