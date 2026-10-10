//! Guest tests against a real host on loopback.

use std::net::{IpAddr, Ipv4Addr};

use serde_json::json;

use super::*;
use crate::permissions::Role;
use crate::server::{start_host, HostConfig, HostRuntime};

const WAIT: Duration = Duration::from_secs(5);

fn host_config(port: u16) -> HostConfig {
    HostConfig {
        bind_ip: IpAddr::from(Ipv4Addr::LOCALHOST),
        preferred_port: port,
        port_attempts: 1,
        host_id: "host-1".into(),
        control_pin: Some("1111".into()),
        edit_pin: Some("2222".into()),
        ..HostConfig::new("PC del director")
    }
}

async fn host() -> HostRuntime {
    start_host(host_config(0)).await.expect("host")
}

fn guest_config(port: u16, device_id: &str) -> GuestConfig {
    GuestConfig {
        device_name: format!("dev {device_id}"),
        platform: "ios".into(),
        app_version: "1.15.0".into(),
        ping_interval: Duration::from_millis(50),
        ..GuestConfig::new(format!("ws://127.0.0.1:{port}"), device_id)
    }
}

fn join_ok(config: GuestConfig) -> GuestRuntime {
    join(config).expect("inside a runtime")
}

#[test]
fn joining_outside_a_runtime_is_an_error_not_a_panic() {
    assert!(join(guest_config(1, "x")).is_err());
}

async fn next_event(
    runtime: &mut GuestRuntime,
    mut matches: impl FnMut(&GuestEvent) -> bool,
) -> GuestEvent {
    tokio::time::timeout(WAIT, async {
        loop {
            let event = runtime.events.recv().await.expect("events closed");
            if matches(&event) {
                return event;
            }
        }
    })
    .await
    .expect("timed out waiting for an event")
}

async fn until_state(runtime: &mut GuestRuntime, state: GuestState) {
    next_event(runtime, |event| *event == GuestEvent::State(state.clone())).await;
}

#[test]
fn backoff_grows_and_caps() {
    let mut backoff = Backoff::new();
    let delays: Vec<u64> = (0..6)
        .map(|_| backoff.next_delay().as_millis() as u64)
        .collect();
    assert_eq!(delays, vec![500, 1000, 2000, 4000, 4000, 4000]);
    backoff.reset();
    assert_eq!(backoff.next_delay(), Duration::from_millis(500));
}

#[tokio::test]
async fn joins_and_receives_the_session() {
    let host = host().await;
    host.handle.publish_song(&json!({ "regions": ["a"] }));
    host.handle
        .publish_transport(&json!({ "playbackState": "playing" }));
    let mut guest = join_ok(guest_config(host.handle.port(), "g"));

    let welcome = next_event(&mut guest, |event| {
        matches!(event, GuestEvent::Welcome { .. })
    })
    .await;
    let GuestEvent::Welcome {
        host_id,
        host_name,
        grants,
        ..
    } = welcome
    else {
        unreachable!()
    };
    assert_eq!(host_id, "host-1");
    assert_eq!(host_name, "PC del director");
    assert_eq!(grants.role, Role::Viewer);
    assert_eq!(guest.handle.state(), GuestState::Connected);

    let song = next_event(&mut guest, |event| matches!(event, GuestEvent::Song(_))).await;
    assert_eq!(song, GuestEvent::Song(json!({ "regions": ["a"] })));
    next_event(&mut guest, |event| {
        matches!(event, GuestEvent::Transport { .. })
    })
    .await;
}

#[tokio::test]
async fn clock_offset_and_round_trip_appear() {
    let host = host().await;
    let guest = join_ok(guest_config(host.handle.port(), "c"));
    tokio::time::timeout(WAIT, async {
        while guest.handle.host_offset_ms().is_none() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("no clock sample");
    assert!(guest.handle.round_trip_ms().is_some());
}

#[tokio::test]
async fn bad_pin_is_final() {
    let host = host().await;
    let mut guest = join_ok(GuestConfig {
        pin: Some("0000".into()),
        ..guest_config(host.handle.port(), "b")
    });
    until_state(
        &mut guest,
        GuestState::Rejected {
            reason: RejectReason::BadPin,
            expected_protocol: None,
        },
    )
    .await;
    // No further attempt: the events channel closes because the task ended.
    let rest = tokio::time::timeout(WAIT, async {
        while let Some(event) = guest.events.recv().await {
            assert!(
                !matches!(event, GuestEvent::State(GuestState::Connecting { .. })),
                "reconnected after a rejection"
            );
        }
    })
    .await;
    assert!(rest.is_ok());
}

#[tokio::test]
async fn command_round_trip_and_local_permission_check() {
    let mut host = host().await;
    let mut guest = join_ok(GuestConfig {
        pin: Some("1111".into()),
        ..guest_config(host.handle.port(), "ctl")
    });
    until_state(&mut guest, GuestState::Connected).await;

    let handle = guest.handle.clone();
    let send = tokio::spawn(async move { handle.send_command(LinkCommand::Play, None).await });
    let incoming = tokio::time::timeout(WAIT, host.commands.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(incoming.command, LinkCommand::Play);
    incoming.reply.send(Ok(())).unwrap();
    assert_eq!(send.await.unwrap(), Ok(()));

    // An editor-only command is refused locally, without a round trip.
    let refused = guest
        .handle
        .send_command(
            LinkCommand::SetSongTranspose {
                region_id: "r".into(),
                semitones: 1,
            },
            Some(1),
        )
        .await;
    assert_eq!(
        refused,
        Err(CommandError::Rejected(CommandRejection::Forbidden))
    );
    assert!(host.commands.try_recv().is_err());
}

#[tokio::test]
async fn reconnects_with_its_token_after_the_host_restarts() {
    let host = host().await;
    let port = host.handle.port();
    let mut guest = join_ok(GuestConfig {
        pin: Some("2222".into()),
        remember: true,
        ..guest_config(port, "ipad")
    });
    until_state(&mut guest, GuestState::Connected).await;
    let trusted = host.handle.trusted_devices();
    assert_eq!(trusted.len(), 1);

    host.handle.stop();
    drop(host);
    until_state(&mut guest, GuestState::Lost).await;

    // Same port, same trusted list, and the PIN changed: only the token can
    // bring the guest back as editor.
    let restarted = start_host(HostConfig {
        trusted,
        edit_pin: Some("9999".into()),
        ..host_config(port)
    })
    .await
    .expect("restart on the same port");

    let welcome = next_event(&mut guest, |event| {
        matches!(event, GuestEvent::Welcome { .. })
    })
    .await;
    let GuestEvent::Welcome { grants, .. } = welcome else {
        unreachable!()
    };
    assert_eq!(grants.role, Role::Editor);
    assert_eq!(restarted.handle.guests().len(), 1);
}

#[tokio::test]
async fn pending_command_fails_when_the_connection_drops() {
    let mut host = host().await;
    let mut guest = join_ok(GuestConfig {
        pin: Some("1111".into()),
        ..guest_config(host.handle.port(), "drop")
    });
    until_state(&mut guest, GuestState::Connected).await;

    let handle = guest.handle.clone();
    let send = tokio::spawn(async move { handle.send_command(LinkCommand::Stop, None).await });
    // The host receives it but never answers; then the host goes away.
    let _unanswered = host.commands.recv().await.unwrap();
    host.handle.stop();
    assert_eq!(send.await.unwrap(), Err(CommandError::Disconnected));
    assert_eq!(
        guest.handle.send_command(LinkCommand::Stop, None).await,
        Err(CommandError::NotConnected)
    );
}

/// A host whose socket stays open but says nothing after `welcome`: what a
/// dead peer looks like before the OS notices.
async fn mute_host() -> u16 {
    let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
        let _hello = socket.next().await;
        let welcome = json!({
            "type": "welcome", "protocolVersion": PROTOCOL_VERSION, "sessionId": "s",
            "hostId": "mute", "hostName": "mute", "grants": { "role": "viewer" },
            "hostMonotonicMs": 0
        });
        socket
            .send(Message::Text(welcome.to_string()))
            .await
            .unwrap();
        // Keep the socket open, read and ignore everything.
        while socket.next().await.is_some() {}
    });
    port
}

#[tokio::test]
async fn silent_host_counts_as_lost() {
    let port = mute_host().await;
    let mut guest = join_ok(GuestConfig {
        silence_timeout: Duration::from_millis(300),
        ..guest_config(port, "quiet")
    });
    until_state(&mut guest, GuestState::Connected).await;
    until_state(&mut guest, GuestState::Lost).await;
}

#[tokio::test]
async fn a_live_host_is_not_silent() {
    // Pongs answer the pings, so a host with nothing to publish still keeps
    // the guest connected past the silence timeout.
    let host = start_host(HostConfig {
        heartbeat: Duration::from_secs(3600),
        ..host_config(0)
    })
    .await
    .unwrap();
    let mut guest = join_ok(GuestConfig {
        silence_timeout: Duration::from_millis(300),
        ..guest_config(host.handle.port(), "alive")
    });
    until_state(&mut guest, GuestState::Connected).await;
    tokio::time::sleep(Duration::from_millis(900)).await;
    assert_eq!(guest.handle.state(), GuestState::Connected);
}

#[tokio::test]
async fn leaving_closes_and_the_host_forgets_the_guest() {
    let host = host().await;
    let mut guest = join_ok(guest_config(host.handle.port(), "bye"));
    until_state(&mut guest, GuestState::Connected).await;
    guest.handle.leave();
    until_state(&mut guest, GuestState::Closed).await;
    tokio::time::timeout(WAIT, async {
        while !host.handle.guests().is_empty() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("host still lists the guest");
}

#[tokio::test]
async fn kick_is_final_for_the_guest() {
    let host = host().await;
    let mut guest = join_ok(guest_config(host.handle.port(), "k"));
    until_state(&mut guest, GuestState::Connected).await;
    host.handle.kick("k");
    until_state(
        &mut guest,
        GuestState::Rejected {
            reason: RejectReason::Kicked,
            expected_protocol: None,
        },
    )
    .await;
}
