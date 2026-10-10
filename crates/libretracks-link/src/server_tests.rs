//! Host tests over loopback: real sockets on 127.0.0.1, no Tauri, no LAN.
//! Nothing here measures how long something took; timeouts only bound how
//! long a test may wait for an event that must happen.

use std::net::Ipv4Addr;
use std::sync::atomic::AtomicUsize;

use futures_util::stream::{SplitSink, SplitStream};
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

use super::*;

const WAIT: Duration = Duration::from_secs(5);

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

fn config() -> HostConfig {
    HostConfig {
        bind_ip: IpAddr::from(Ipv4Addr::LOCALHOST),
        preferred_port: 0,
        port_attempts: 1,
        control_pin: Some("1111".into()),
        edit_pin: Some("2222".into()),
        hello_timeout: Duration::from_millis(200),
        ..HostConfig::new("PC del director")
    }
}

struct Guest {
    tx: SplitSink<Socket, Message>,
    rx: SplitStream<Socket>,
}

impl Guest {
    async fn connect(port: u16) -> Guest {
        let (socket, _) = connect_async(format!("ws://127.0.0.1:{port}"))
            .await
            .expect("connect");
        let (tx, rx) = socket.split();
        Guest { tx, rx }
    }

    async fn send(&mut self, value: Value) {
        self.tx
            .send(Message::Text(value.to_string()))
            .await
            .expect("send");
    }

    async fn hello(
        &mut self,
        device_id: &str,
        pin: Option<&str>,
        remember: bool,
        token: Option<&str>,
    ) {
        let mut hello = json!({
            "type": "hello",
            "protocolVersion": PROTOCOL_VERSION,
            "deviceId": device_id,
            "deviceName": format!("dev {device_id}"),
            "platform": "android",
            "appVersion": "1.15.0",
            "remember": remember,
        });
        if let Some(pin) = pin {
            hello["pin"] = json!(pin);
        }
        if let Some(token) = token {
            hello["token"] = json!(token);
        }
        self.send(hello).await;
    }

    /// Next message of the given type, skipping others. None if the socket
    /// closed first.
    async fn next_of(&mut self, kind: &str) -> Option<Value> {
        tokio::time::timeout(WAIT, async {
            while let Some(message) = self.rx.next().await {
                let Ok(Message::Text(text)) = message else {
                    if matches!(message, Ok(Message::Close(_)) | Err(_)) {
                        return None;
                    }
                    continue;
                };
                let value: Value = serde_json::from_str(&text).unwrap();
                if value["type"] == kind {
                    return Some(value);
                }
            }
            None
        })
        .await
        .expect("timed out waiting for a message")
    }

    async fn join(port: u16, device_id: &str, pin: Option<&str>) -> (Guest, Value) {
        let mut guest = Guest::connect(port).await;
        guest.hello(device_id, pin, false, None).await;
        let welcome = guest.next_of("welcome").await.expect("welcome");
        (guest, welcome)
    }

    async fn command(&mut self, request_id: u64, command: Value) {
        self.send(json!({ "type": "command", "requestId": request_id, "command": command }))
            .await;
    }
}

async fn host() -> HostRuntime {
    start_host(config()).await.expect("host")
}

#[tokio::test]
async fn guest_without_hello_is_dropped() {
    let runtime = host().await;
    let mut guest = Guest::connect(runtime.handle.port()).await;
    let rejected = guest.next_of("rejected").await.expect("rejected");
    assert_eq!(rejected["reason"], "badHello");
    assert!(runtime.handle.guests().is_empty());
}

#[tokio::test]
async fn roles_follow_the_pin() {
    let runtime = host().await;
    let port = runtime.handle.port();
    let (_viewer, welcome) = Guest::join(port, "a", None).await;
    assert_eq!(welcome["grants"]["role"], "viewer");
    assert_eq!(welcome["hostName"], "PC del director");
    let (_control, welcome) = Guest::join(port, "b", Some("1111")).await;
    assert_eq!(welcome["grants"]["role"], "controller");
    let (_editor, welcome) = Guest::join(port, "c", Some("2222")).await;
    assert_eq!(welcome["grants"]["role"], "editor");
    assert_eq!(runtime.handle.guests().len(), 3);
}

#[tokio::test]
async fn bad_pin_then_rate_limit() {
    let runtime = host().await;
    let port = runtime.handle.port();
    for _ in 0..crate::pairing::MAX_PIN_FAILURES {
        let mut guest = Guest::connect(port).await;
        guest.hello("x", Some("0000"), false, None).await;
        assert_eq!(guest.next_of("rejected").await.unwrap()["reason"], "badPin");
    }
    let mut guest = Guest::connect(port).await;
    guest.hello("x", Some("1111"), false, None).await;
    assert_eq!(
        guest.next_of("rejected").await.unwrap()["reason"],
        "rateLimited"
    );
}

#[tokio::test]
async fn incompatible_version_is_rejected() {
    let runtime = host().await;
    let mut guest = Guest::connect(runtime.handle.port()).await;
    guest
        .send(json!({
            "type": "hello", "protocolVersion": PROTOCOL_VERSION + 5,
            "deviceId": "d", "deviceName": "n", "platform": "ios", "appVersion": "9"
        }))
        .await;
    let rejected = guest.next_of("rejected").await.unwrap();
    assert_eq!(rejected["reason"], "incompatibleVersion");
    assert_eq!(rejected["expectedProtocol"], PROTOCOL_VERSION);
}

#[tokio::test]
async fn remembered_device_rejoins_without_pin() {
    let runtime = host().await;
    let port = runtime.handle.port();
    let mut first = Guest::connect(port).await;
    first.hello("ipad", Some("2222"), true, None).await;
    let welcome = first.next_of("welcome").await.unwrap();
    let token = welcome["token"].as_str().expect("token").to_string();
    assert_eq!(runtime.handle.trusted_devices().len(), 1);
    drop(first);

    let mut again = Guest::connect(port).await;
    again.hello("ipad", None, false, Some(&token)).await;
    let welcome = again.next_of("welcome").await.unwrap();
    assert_eq!(welcome["grants"]["role"], "editor");
}

#[tokio::test]
async fn viewer_command_is_forbidden_and_never_reaches_the_app() {
    let mut runtime = host().await;
    let (mut viewer, _) = Guest::join(runtime.handle.port(), "v", None).await;
    viewer.command(1, json!({ "cmd": "play" })).await;
    let result = viewer.next_of("commandResult").await.unwrap();
    assert_eq!(result["ok"], false);
    assert_eq!(result["reason"], "forbidden");
    assert!(runtime.commands.try_recv().is_err());
}

#[tokio::test]
async fn controller_command_reaches_the_app_and_gets_its_result() {
    let mut runtime = host().await;
    let (mut control, _) = Guest::join(runtime.handle.port(), "c", Some("1111")).await;
    control.command(9, json!({ "cmd": "play" })).await;
    let incoming = tokio::time::timeout(WAIT, runtime.commands.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(incoming.command, LinkCommand::Play);
    assert_eq!(incoming.device_id, "c");
    incoming.reply.send(Ok(Value::Null)).unwrap();
    let result = control.next_of("commandResult").await.unwrap();
    assert_eq!(result["requestId"], 9);
    assert_eq!(result["ok"], true);
}

#[tokio::test]
async fn app_rejection_reaches_the_guest() {
    let mut runtime = host().await;
    let (mut editor, _) = Guest::join(runtime.handle.port(), "e", Some("2222")).await;
    editor
        .send(
            json!({ "type": "command", "requestId": 4, "baseRevision": 1,
            "command": { "cmd": "setSongTranspose", "regionId": "r", "semitones": 2 } }),
        )
        .await;
    let incoming = runtime.commands.recv().await.unwrap();
    assert_eq!(incoming.base_revision, Some(1));
    incoming
        .reply
        .send(Err(CommandRejection::Stale.into()))
        .unwrap();
    let result = editor.next_of("commandResult").await.unwrap();
    assert_eq!(result["reason"], "stale");
}

#[tokio::test]
async fn live_role_change_applies_to_the_next_command() {
    let mut runtime = host().await;
    let (mut guest, _) = Guest::join(runtime.handle.port(), "g", Some("1111")).await;
    assert!(runtime.handle.set_grants("g", Grants::VIEWER));
    let changed = guest.next_of("grantsChanged").await.unwrap();
    assert_eq!(changed["grants"]["role"], "viewer");
    guest.command(2, json!({ "cmd": "stop" })).await;
    let result = guest.next_of("commandResult").await.unwrap();
    assert_eq!(result["reason"], "forbidden");
    assert!(runtime.commands.try_recv().is_err());
}

#[tokio::test]
async fn kick_closes_and_revoked_token_rejoins_as_viewer() {
    let runtime = host().await;
    let port = runtime.handle.port();
    let mut guest = Guest::connect(port).await;
    guest.hello("p", Some("1111"), true, None).await;
    let token = guest.next_of("welcome").await.unwrap()["token"]
        .as_str()
        .unwrap()
        .to_string();

    assert!(runtime.handle.kick("p"));
    assert_eq!(guest.next_of("rejected").await.unwrap()["reason"], "kicked");
    assert!(runtime.handle.revoke_trusted("p"));

    let mut again = Guest::connect(port).await;
    again.hello("p", None, false, Some(&token)).await;
    assert_eq!(
        again.next_of("welcome").await.unwrap()["grants"]["role"],
        "viewer"
    );
}

#[tokio::test]
async fn revoking_a_connected_device_drops_it_to_viewer() {
    let runtime = host().await;
    let mut guest = Guest::connect(runtime.handle.port()).await;
    guest.hello("t", Some("2222"), true, None).await;
    guest.next_of("welcome").await.unwrap();
    runtime.handle.revoke_trusted("t");
    let changed = guest.next_of("grantsChanged").await.unwrap();
    assert_eq!(changed["grants"]["role"], "viewer");
}

#[tokio::test]
async fn late_guest_gets_the_latest_song_and_transport() {
    let runtime = host().await;
    runtime.handle.publish_song(&json!({ "regions": ["old"] }));
    runtime.handle.publish_song(&json!({ "regions": ["new"] }));
    runtime
        .handle
        .publish_transport(&json!({ "playbackState": "playing" }));
    runtime
        .handle
        .publish_live_settings(&json!({ "vampMode": "bars" }));
    let (mut guest, _) = Guest::join(runtime.handle.port(), "late", None).await;
    assert_eq!(
        guest.next_of("song").await.unwrap()["song"]["regions"][0],
        "new"
    );
    assert_eq!(
        guest.next_of("liveSettings").await.unwrap()["settings"]["vampMode"],
        "bars"
    );
    let transport = guest.next_of("transport").await.unwrap();
    assert_eq!(transport["snapshot"]["playbackState"], "playing");
    assert!(transport["hostMonotonicMs"].is_u64());
}

/// Counts how many times it is serialized.
struct Counting(Arc<AtomicUsize>);

impl Serialize for Counting {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.0.fetch_add(1, Ordering::SeqCst);
        serializer.serialize_str("song")
    }
}

#[tokio::test]
async fn a_publish_is_serialized_once_for_all_guests() {
    let runtime = host().await;
    let port = runtime.handle.port();
    let mut guests = Vec::new();
    for index in 0..10 {
        guests.push(Guest::join(port, &format!("g{index}"), None).await.0);
    }
    let count = Arc::new(AtomicUsize::new(0));
    runtime.handle.publish_song(&Counting(count.clone()));
    for guest in &mut guests {
        assert_eq!(guest.next_of("song").await.unwrap()["song"], "song");
    }
    assert_eq!(count.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn a_guest_that_stops_reading_does_not_block_the_others() {
    let runtime = host().await;
    let port = runtime.handle.port();
    // Joins and then never reads again: its socket buffers fill up.
    let (_stuck, _) = Guest::join(port, "stuck", None).await;
    let (mut reader, _) = Guest::join(port, "reader", None).await;

    let big = "x".repeat(256 * 1024);
    for index in 0..64 {
        runtime
            .handle
            .publish_song(&json!({ "index": index, "padding": big }));
    }
    runtime.handle.publish_song(&json!({ "index": "last" }));

    // The reader may skip intermediate songs (latest wins) but must get the
    // last one.
    loop {
        let song = reader.next_of("song").await.expect("song");
        if song["song"]["index"] == "last" {
            break;
        }
    }
}

#[tokio::test]
async fn clock_ping_is_answered_and_rtt_shows_in_the_guest_list() {
    let runtime = host().await;
    let (mut guest, _) = Guest::join(runtime.handle.port(), "c", None).await;
    let mut list = runtime.handle.subscribe_guests();
    guest
        .send(json!({ "type": "clockPing", "t0": 42, "rttMs": 9 }))
        .await;
    let pong = guest.next_of("clockPong").await.unwrap();
    assert_eq!(pong["t0"], 42);
    assert!(pong["t2"].as_u64() >= pong["t1"].as_u64());
    tokio::time::timeout(WAIT, async {
        loop {
            if list.borrow_and_update().iter().any(|g| g.rtt_ms == Some(9)) {
                return;
            }
            list.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn host_full_is_rejected() {
    let runtime = start_host(HostConfig {
        max_guests: 1,
        ..config()
    })
    .await
    .unwrap();
    let port = runtime.handle.port();
    let (_first, _) = Guest::join(port, "one", None).await;
    let mut second = Guest::connect(port).await;
    second.hello("two", None, false, None).await;
    assert_eq!(
        second.next_of("rejected").await.unwrap()["reason"],
        "hostFull"
    );
}

/// A bound port whose next port is free right now. Ports next to an
/// ephemeral one are not guaranteed free (parallel tests, and Windows
/// reserves whole ranges for Hyper-V), so look for a pair instead of assuming.
fn occupied_port_with_free_neighbour() -> (std::net::TcpListener, u16) {
    for _ in 0..50 {
        let occupied = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let busy = occupied.local_addr().unwrap().port();
        let Some(next) = busy.checked_add(1) else {
            continue;
        };
        if std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, next)).is_ok() {
            return (occupied, busy);
        }
    }
    panic!("no pair of consecutive free ports");
}

#[tokio::test]
async fn occupied_port_falls_back_to_the_next_one() {
    let (_occupied, busy) = occupied_port_with_free_neighbour();
    let runtime = start_host(HostConfig {
        preferred_port: busy,
        port_attempts: 2,
        ..config()
    })
    .await
    .unwrap();
    assert_eq!(runtime.handle.port(), busy + 1);
}

#[tokio::test]
async fn heartbeat_resends_transport_while_quiet() {
    let runtime = start_host(HostConfig {
        heartbeat: Duration::from_millis(50),
        ..config()
    })
    .await
    .unwrap();
    runtime.handle.publish_transport(&json!({ "p": 1 }));
    let (mut guest, _) = Guest::join(runtime.handle.port(), "h", None).await;
    // Initial catch-up plus at least one heartbeat.
    guest.next_of("transport").await.unwrap();
    guest.next_of("transport").await.unwrap();
}

#[tokio::test]
async fn stop_disconnects_everyone() {
    let runtime = host().await;
    let (mut guest, _) = Guest::join(runtime.handle.port(), "s", None).await;
    runtime.handle.stop();
    assert!(guest.next_of("never").await.is_none());
    assert!(runtime.handle.guests().is_empty());
}

#[tokio::test]
async fn reconnecting_device_replaces_its_old_connection() {
    let runtime = host().await;
    let port = runtime.handle.port();
    let (mut old, _) = Guest::join(port, "same", None).await;
    let (_new, _) = Guest::join(port, "same", None).await;
    assert!(old.next_of("never").await.is_none());
    assert_eq!(runtime.handle.guests().len(), 1);
}
