use std::{
    io,
    net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket},
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, RwLock,
    },
    time::{Duration, Instant},
};

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    response::{Html, IntoResponse},
    routing::get,
    serve, Json, Router,
};
use futures::{sink::SinkExt, stream::StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::{
    net::TcpListener,
    sync::{broadcast, mpsc},
};
use tower_http::{
    cors::CorsLayer,
    services::{ServeDir, ServeFile},
};

const DEFAULT_BIND_IP: IpAddr = IpAddr::V4(Ipv4Addr::UNSPECIFIED);
const METER_FRAME_INTERVAL: Duration = Duration::from_millis(33);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteServerInfo {
    pub bind_ip: String,
    pub local_ip: String,
    pub hostname: String,
    pub local_hostname_origin: Option<String>,
    pub port: u16,
    pub origin: String,
    pub ws_url: String,
}

#[derive(Debug, Clone)]
pub struct RemoteServerHandle {
    info: RemoteServerInfo,
    events_tx: broadcast::Sender<ServerEvent>,
    command_tx: mpsc::Sender<RemoteCommand>,
    cache: Arc<RwLock<RemoteStateCache>>,
    last_meter_emit_at: Arc<RwLock<Option<Instant>>>,
}

#[derive(Debug)]
pub struct RemoteServerRuntime {
    pub handle: RemoteServerHandle,
    pub command_rx: mpsc::Receiver<RemoteCommand>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTrackMixUpdate {
    pub track_id: String,
    pub volume: Option<f64>,
    pub pan: Option<f64>,
    pub muted: Option<bool>,
    pub solo: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "cmd", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum RemoteCommand {
    Play,
    Pause,
    Stop,
    Seek {
        position_seconds: f64,
    },
    ScheduleMarkerJump {
        target_marker_id: String,
        trigger: String,
        bars: Option<u32>,
        transition: Option<String>,
        duration_seconds: Option<f64>,
    },
    ScheduleRegionJump {
        target_region_id: String,
        trigger: String,
        bars: Option<u32>,
        transition: Option<String>,
        duration_seconds: Option<f64>,
    },
    ToggleVamp {
        mode: String,
        bars: Option<u32>,
    },
    CancelMarkerJump,
    UpdateTrackMixLive {
        track_id: String,
        volume: Option<f64>,
        pan: Option<f64>,
        muted: Option<bool>,
        solo: Option<bool>,
    },
    UpdateTrack {
        track_id: String,
        volume: Option<f64>,
        pan: Option<f64>,
        muted: Option<bool>,
        solo: Option<bool>,
    },
    Ping,
}

#[derive(Debug, Clone)]
enum ServerEvent {
    Snapshot(Value),
    SongView(Value),
    Meters(Vec<u8>),
}

#[derive(Debug, Clone, Default)]
struct RemoteStateCache {
    latest_snapshot: Option<Value>,
    latest_song_view: Option<Value>,
}

#[derive(Debug, Clone)]
struct AppState {
    events_tx: broadcast::Sender<ServerEvent>,
    command_tx: mpsc::Sender<RemoteCommand>,
    cache: Arc<RwLock<RemoteStateCache>>,
    connection_count: Arc<AtomicU64>,
    info: RemoteServerInfo,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    ok: bool,
    clients: u64,
    ws_url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OutboundEnvelope<'a> {
    event: &'a str,
    payload: Value,
}

pub async fn spawn_remote_server(
    port: u16,
    static_dir: Option<PathBuf>,
) -> Result<RemoteServerRuntime, io::Error> {
    let local_ip = resolve_local_ip().unwrap_or(IpAddr::V4(Ipv4Addr::LOCALHOST));
    let hostname = resolve_hostname().unwrap_or_else(|| "libretracks".to_string());
    let bind_addr = SocketAddr::new(DEFAULT_BIND_IP, port);
    let listener = TcpListener::bind(bind_addr).await?;
    let bound_addr = listener.local_addr()?;
    let local_hostname_origin = if hostname.is_empty() {
        None
    } else {
        Some(format!("http://{}.local:{}", hostname, bound_addr.port()))
    };
    let info = RemoteServerInfo {
        bind_ip: bound_addr.ip().to_string(),
        local_ip: local_ip.to_string(),
        hostname,
        local_hostname_origin,
        port: bound_addr.port(),
        origin: format!("http://{}:{}", local_ip, bound_addr.port()),
        ws_url: format!("ws://{}:{}/ws", local_ip, bound_addr.port()),
    };

    let (events_tx, _) = broadcast::channel(256);
    let (command_tx, command_rx) = mpsc::channel(256);
    let cache = Arc::new(RwLock::new(RemoteStateCache::default()));
    let connection_count = Arc::new(AtomicU64::new(0));
    let last_meter_emit_at = Arc::new(RwLock::new(None));

    let handle = RemoteServerHandle {
        info: info.clone(),
        events_tx: events_tx.clone(),
        command_tx: command_tx.clone(),
        cache: cache.clone(),
        last_meter_emit_at,
    };

    let state = AppState {
        events_tx,
        command_tx,
        cache,
        connection_count,
        info,
    };
    let app = build_router(state, static_dir);

    tokio::spawn(async move {
        if let Err(error) = serve(listener, app).tcp_nodelay(true).await {
            eprintln!("[libretracks-remote] server error: {error}");
        }
    });

    Ok(RemoteServerRuntime { handle, command_rx })
}

impl RemoteServerHandle {
    pub fn info(&self) -> &RemoteServerInfo {
        &self.info
    }

    pub fn command_sender(&self) -> &mpsc::Sender<RemoteCommand> {
        &self.command_tx
    }

    pub fn publish_transport_snapshot<T: Serialize>(&self, snapshot: &T) {
        if let Ok(value) = serde_json::to_value(snapshot) {
            if let Ok(mut cache) = self.cache.write() {
                cache.latest_snapshot = Some(value.clone());
            }
            let _ = self.events_tx.send(ServerEvent::Snapshot(value));
        }
    }

    pub fn publish_song_view<T: Serialize>(&self, song_view: &T) {
        if let Ok(value) = serde_json::to_value(song_view) {
            if let Ok(mut cache) = self.cache.write() {
                cache.latest_song_view = Some(value.clone());
            }
            let _ = self.events_tx.send(ServerEvent::SongView(value));
        }
    }

    pub fn publish_meters<T: Serialize>(&self, meters: &T) {
        let Ok(mut guard) = self.last_meter_emit_at.write() else {
            return;
        };
        let now = Instant::now();
        if let Some(last_emit_at) = *guard {
            if now.duration_since(last_emit_at) < METER_FRAME_INTERVAL {
                return;
            }
        }
        *guard = Some(now);

        let Ok(payload) = serde_json::to_vec(&json!({
            "event": "meters",
            "payload": meters
        })) else {
            return;
        };

        let _ = self.events_tx.send(ServerEvent::Meters(payload));
    }
}

fn build_router(state: AppState, static_dir: Option<PathBuf>) -> Router {
    let mut router = Router::new()
        .route(
            "/api/health",
            get({
                let state = state.clone();
                move || async move {
                    Json(HealthResponse {
                        ok: true,
                        clients: state.connection_count.load(Ordering::Relaxed),
                        ws_url: state.info.ws_url.clone(),
                    })
                }
            }),
        )
        .route("/ws", get(handle_ws_upgrade))
        .with_state(state)
        .layer(CorsLayer::permissive());

    if let Some(static_dir) = static_dir {
        let index_path = static_dir.join("index.html");
        if index_path.exists() {
            router = router
                .route_service("/", ServeFile::new(index_path.clone()))
                .route_service("/index.html", ServeFile::new(index_path.clone()))
                .route_service("/manifest.json", ServeFile::new(static_dir.join("manifest.json")))
                .nest_service("/assets", ServeDir::new(static_dir.join("assets")))
                .fallback_service(ServeFile::new(index_path));
        }
    }

    router.fallback(|| async {
        Html(
            "<!doctype html><html><body style=\"font-family: sans-serif; background:#131313; color:#e5e2e1; padding:2rem\">LibreTracks Remote server is running.</body></html>",
        )
    })
}

async fn handle_ws_upgrade(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    state.connection_count.fetch_add(1, Ordering::Relaxed);
    let (mut sender, mut receiver) = socket.split();
    let mut events_rx = state.events_tx.subscribe();

    let (latest_snapshot, latest_song_view) = if let Ok(cache) = state.cache.read() {
        (cache.latest_snapshot.clone(), cache.latest_song_view.clone())
    } else {
        (None, None)
    };

    if let Some(snapshot) = latest_snapshot {
        let _ = sender
            .send(Message::Text(
                serde_json::to_string(&OutboundEnvelope {
                    event: "transportSnapshot",
                    payload: snapshot,
                })
                .unwrap_or_default(),
            ))
            .await;
    }
    if let Some(song_view) = latest_song_view {
        let _ = sender
            .send(Message::Text(
                serde_json::to_string(&OutboundEnvelope {
                    event: "songView",
                    payload: song_view,
                })
                .unwrap_or_default(),
            ))
            .await;
    }

    let write_task = tokio::spawn(async move {
        loop {
            match events_rx.recv().await {
                Ok(ServerEvent::Snapshot(payload)) => {
                    let _ = sender
                        .send(Message::Text(
                            serde_json::to_string(&OutboundEnvelope {
                                event: "transportSnapshot",
                                payload,
                            })
                            .unwrap_or_default(),
                        ))
                        .await;
                }
                Ok(ServerEvent::SongView(payload)) => {
                    let _ = sender
                        .send(Message::Text(
                            serde_json::to_string(&OutboundEnvelope {
                                event: "songView",
                                payload,
                            })
                            .unwrap_or_default(),
                        ))
                        .await;
                }
                Ok(ServerEvent::Meters(payload)) => {
                    if sender.send(Message::Binary(payload.into())).await.is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    while let Some(Ok(message)) = receiver.next().await {
        match message {
            Message::Text(text) => {
                if let Ok(command) = serde_json::from_str::<RemoteCommand>(&text) {
                    let _ = state.command_tx.send(command).await;
                }
            }
            Message::Binary(bytes) => {
                if let Ok(text) = String::from_utf8(bytes.to_vec()) {
                    if let Ok(command) = serde_json::from_str::<RemoteCommand>(&text) {
                        let _ = state.command_tx.send(command).await;
                    }
                }
            }
            Message::Close(_) => break,
            Message::Ping(payload) => {
                let _ = state.command_tx.send(RemoteCommand::Ping).await;
                let _ = state
                    .events_tx
                    .send(ServerEvent::Meters(
                        json!({ "event": "pong", "payload": payload }).to_string().into_bytes(),
                    ));
            }
            Message::Pong(_) => {}
        }
    }

    write_task.abort();
    state.connection_count.fetch_sub(1, Ordering::Relaxed);
}

fn resolve_local_ip() -> Option<IpAddr> {
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    socket.connect((Ipv4Addr::new(8, 8, 8, 8), 80)).ok()?;
    socket.local_addr().ok().map(|addr| addr.ip())
}

fn resolve_hostname() -> Option<String> {
    let raw_value = std::env::var("COMPUTERNAME")
        .ok()
        .or_else(|| std::env::var("HOSTNAME").ok())?;
    let hostname = raw_value.trim().trim_matches('.').to_lowercase();
    if hostname.is_empty() {
        None
    } else {
        Some(hostname)
    }
}
