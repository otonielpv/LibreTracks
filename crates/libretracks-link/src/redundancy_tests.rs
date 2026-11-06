//! Redundancy backup peer over loopback (docs/plans/redundancy step 01):
//! a real host and real backup / guest clients on 127.0.0.1. Timeouts only
//! bound how long a test waits for something that must happen.

use std::net::{IpAddr, Ipv4Addr};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::{connect_async, tungstenite::Message};

use crate::client::{connect_as_backup, join, GuestConfig, GuestEvent, GuestRuntime, GuestState};
use crate::protocol::{CommandRejection, LinkCommand, RejectReason};
use crate::redundancy::{
    BackupPhase, RedundancyMessage, TransportClock, REDUNDANCY_PROTOCOL_VERSION,
};
use crate::server::{start_host, HostConfig, HostRuntime};
use crate::version::PROTOCOL_VERSION;
use crate::CommandError;

const WAIT: Duration = Duration::from_secs(5);

fn host_config() -> HostConfig {
    HostConfig {
        bind_ip: IpAddr::from(Ipv4Addr::LOCALHOST),
        preferred_port: 0,
        port_attempts: 1,
        host_id: "main-1".into(),
        control_pin: Some("1111".into()),
        edit_pin: Some("2222".into()),
        accept_backup: true,
        backup_pin: Some("4321".into()),
        instance_id: "instance-a".into(),
        ..HostConfig::new("PC principal")
    }
}

async fn host() -> HostRuntime {
    start_host(host_config()).await.expect("host")
}

fn backup_config(port: u16, device_id: &str, pin: Option<&str>) -> GuestConfig {
    GuestConfig {
        device_name: format!("backup {device_id}"),
        platform: "windows".into(),
        app_version: "1.15.0".into(),
        pin: pin.map(str::to_string),
        ping_interval: Duration::from_millis(50),
        ..GuestConfig::new(format!("ws://127.0.0.1:{port}"), device_id)
    }
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

async fn final_state(runtime: &mut GuestRuntime) -> GuestState {
    match next_event(runtime, |event| {
        matches!(
            event,
            GuestEvent::State(GuestState::Rejected { .. } | GuestState::Connected)
        )
    })
    .await
    {
        GuestEvent::State(state) => state,
        _ => unreachable!(),
    }
}

async fn connected_backup(port: u16, device_id: &str) -> GuestRuntime {
    let mut backup = connect_as_backup(backup_config(port, device_id, Some("4321"))).unwrap();
    assert_eq!(final_state(&mut backup).await, GuestState::Connected);
    backup
}

/// Raw backup hello, to read fields the client does not surface.
async fn raw_backup_hello(port: u16, device_id: &str, pin: &str) -> Value {
    let (mut socket, _) = connect_async(format!("ws://127.0.0.1:{port}"))
        .await
        .unwrap();
    let hello = json!({
        "type": "hello",
        "protocolVersion": PROTOCOL_VERSION,
        "deviceId": device_id,
        "deviceName": format!("backup {device_id}"),
        "platform": "macos",
        "appVersion": "1.15.0",
        "pin": pin,
        "peerKind": "backup",
    });
    socket.send(Message::Text(hello.to_string())).await.unwrap();
    tokio::time::timeout(WAIT, async {
        while let Some(Ok(message)) = socket.next().await {
            if let Message::Text(text) = message {
                return serde_json::from_str::<Value>(&text).unwrap();
            }
        }
        Value::Null
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn backup_with_the_right_pin_gets_in_and_gets_the_redundancy_welcome() {
    let runtime = host().await;
    let mut backup = connect_as_backup(backup_config(runtime.handle.port(), "b1", Some("4321")))
        .unwrap();
    let event = next_event(&mut backup, |event| {
        matches!(
            event,
            GuestEvent::Redundancy(RedundancyMessage::Welcome { .. })
        )
    })
    .await;
    let GuestEvent::Redundancy(RedundancyMessage::Welcome {
        version,
        main_name,
        instance_id,
        ..
    }) = event
    else {
        unreachable!()
    };
    assert_eq!(version, REDUNDANCY_PROTOCOL_VERSION);
    assert_eq!(main_name, "PC principal");
    assert_eq!(instance_id, "instance-a");
    assert_eq!(
        runtime.handle.backup().map(|backup| backup.device_id),
        Some("b1".to_string())
    );
}

#[tokio::test]
async fn backup_with_a_wrong_or_missing_pin_is_rejected() {
    let runtime = host().await;
    let port = runtime.handle.port();
    let mut wrong = connect_as_backup(backup_config(port, "b1", Some("0000"))).unwrap();
    assert_eq!(
        final_state(&mut wrong).await,
        GuestState::Rejected {
            reason: RejectReason::BadPin,
            expected_protocol: None
        }
    );
    // The guests' PINs do not open the backup door.
    let mut guest_pin = connect_as_backup(backup_config(port, "b2", Some("2222"))).unwrap();
    assert!(matches!(
        final_state(&mut guest_pin).await,
        GuestState::Rejected {
            reason: RejectReason::BadPin,
            ..
        }
    ));
    let mut none = connect_as_backup(backup_config(port, "b3", None)).unwrap();
    assert!(matches!(
        final_state(&mut none).await,
        GuestState::Rejected {
            reason: RejectReason::BadPin,
            ..
        }
    ));
    assert!(runtime.handle.backup().is_none());
}

#[tokio::test]
async fn trusted_backup_token_gets_in_without_pin() {
    let runtime = host().await;
    let port = runtime.handle.port();
    let mut first = connect_as_backup(GuestConfig {
        remember: true,
        ..backup_config(port, "b1", Some("4321"))
    })
    .unwrap();
    let GuestEvent::Welcome { token, .. } =
        next_event(&mut first, |event| matches!(event, GuestEvent::Welcome { .. })).await
    else {
        unreachable!()
    };
    let token = token.expect("token issued");
    assert_eq!(runtime.handle.backup_trusted_devices().len(), 1);
    // Trusted backups are not trusted guests.
    assert!(runtime.handle.trusted_devices().is_empty());
    first.handle.leave();
    tokio::time::timeout(WAIT, async {
        while runtime.handle.backup().is_some() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();

    let mut again = connect_as_backup(GuestConfig {
        token: Some(token),
        ..backup_config(port, "b1", None)
    })
    .unwrap();
    assert_eq!(final_state(&mut again).await, GuestState::Connected);
}

#[tokio::test]
async fn a_second_backup_is_rejected_naming_the_current_one() {
    let runtime = host().await;
    let port = runtime.handle.port();
    let _first = connected_backup(port, "b1").await;
    let rejected = raw_backup_hello(port, "b2", "4321").await;
    assert_eq!(rejected["type"], "rejected");
    assert_eq!(rejected["reason"], "backupAlreadyConnected");
    assert_eq!(rejected["detail"], "backup b1");

    let mut second = connect_as_backup(backup_config(port, "b2", Some("4321"))).unwrap();
    assert!(matches!(
        final_state(&mut second).await,
        GuestState::Rejected {
            reason: RejectReason::BackupAlreadyConnected,
            ..
        }
    ));

    // The main can kick the current one to take another.
    assert!(runtime.handle.kick_backup());
    let mut third = connect_as_backup(backup_config(port, "b3", Some("4321"))).unwrap();
    assert_eq!(final_state(&mut third).await, GuestState::Connected);
}

#[tokio::test]
async fn backups_are_refused_until_the_app_asks_for_them() {
    let runtime = start_host(HostConfig {
        accept_backup: false,
        ..host_config()
    })
    .await
    .unwrap();
    let rejected = raw_backup_hello(runtime.handle.port(), "b1", "4321").await;
    assert_eq!(rejected["reason"], "backupNotAccepted");
    assert!(!HostConfig::new("x").accept_backup, "off by default");
}

#[tokio::test]
async fn a_backup_is_not_in_the_guests_peer_list() {
    let runtime = host().await;
    let port = runtime.handle.port();
    let mut editor = join(GuestConfig {
        pin: Some("2222".into()),
        ..backup_config(port, "guest-1", None)
    })
    .unwrap();
    assert_eq!(final_state(&mut editor).await, GuestState::Connected);
    let _backup = connected_backup(port, "b1").await;
    // A later guest makes the host publish the peer list again: the backup
    // must still be missing from it.
    let mut viewer = join(backup_config(port, "guest-2", None)).unwrap();
    assert_eq!(final_state(&mut viewer).await, GuestState::Connected);
    let GuestEvent::Peers(peers) = next_event(&mut editor, |event| {
        matches!(event, GuestEvent::Peers(peers) if peers.len() == 2)
    })
    .await
    else {
        unreachable!()
    };
    let ids: Vec<_> = peers.iter().map(|peer| peer.device_id.as_str()).collect();
    assert_eq!(ids.len(), 2);
    assert!(!ids.contains(&"b1"), "{ids:?}");
    assert!(runtime
        .handle
        .guests()
        .iter()
        .all(|guest| guest.device_id != "b1"));
    assert!(runtime.handle.backup().is_some());
}

#[tokio::test]
async fn backup_commands_need_the_forwarding_permission() {
    let mut runtime = host().await;
    let port = runtime.handle.port();
    let backup = connected_backup(port, "b1").await;
    let refused = backup.handle.send_command(LinkCommand::Play, None).await;
    assert_eq!(
        refused,
        Err(CommandError::Rejected(CommandRejection::Forbidden))
    );

    runtime.handle.set_backup_may_forward(true);
    let handle = backup.handle.clone();
    let sent = tokio::spawn(async move { handle.send_command(LinkCommand::Play, None).await });
    let incoming = tokio::time::timeout(WAIT, runtime.commands.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(incoming.from_backup);
    assert_eq!(incoming.command, LinkCommand::Play);
    incoming.reply.send(Ok(Value::Null)).unwrap();
    assert_eq!(sent.await.unwrap(), Ok(Value::Null));

    // Even with forwarding on, a backup never edits nor mixes the main.
    let mix = backup
        .handle
        .send_command(
            LinkCommand::ReorderSong {
                region_id: "r".into(),
                target_index: 1,
            },
            None,
        )
        .await;
    assert_eq!(mix, Err(CommandError::Rejected(CommandRejection::Forbidden)));
}

#[tokio::test]
async fn heartbeats_and_messages_flow_both_ways() {
    let mut runtime = host().await;
    let port = runtime.handle.port();
    let mut backup = connected_backup(port, "b1").await;

    next_event(&mut backup, |event| {
        matches!(
            event,
            GuestEvent::Redundancy(RedundancyMessage::Heartbeat { .. })
        )
    })
    .await;
    let from_backup = tokio::time::timeout(WAIT, runtime.backup_messages.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(from_backup, RedundancyMessage::Heartbeat { .. }));

    let seq = runtime.handle.next_redundancy_seq();
    let state = RedundancyMessage::State {
        seq,
        clock: TransportClock {
            playing: true,
            position_seconds: 4.0,
            callback_monotonic_ns: runtime.handle.monotonic_ns(),
            output_latency_seconds: 0.005,
            sample_rate: 48_000,
        },
        song_id: Some("s1".into()),
        vamp: None,
        pending_jumps: Vec::new(),
    };
    assert!(runtime.handle.send_to_backup(&state));
    let received = next_event(&mut backup, |event| {
        matches!(event, GuestEvent::Redundancy(RedundancyMessage::State { .. }))
    })
    .await;
    assert_eq!(received, GuestEvent::Redundancy(state));

    let status = RedundancyMessage::BackupStatus {
        phase: BackupPhase::Following,
        offset_ms: Some(1.0),
        last_correction_ms: None,
        fingerprint: None,
    };
    assert!(backup.handle.send_redundancy(status.clone()));
    let got = tokio::time::timeout(WAIT, async {
        loop {
            let message = runtime.backup_messages.recv().await.unwrap();
            if matches!(message, RedundancyMessage::BackupStatus { .. }) {
                return message;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(got, status);
}
