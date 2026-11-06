//! Redundancy step 04: the publisher's decisions with a fake IO, and the
//! whole path session → publisher → link server → backup client over
//! loopback. Ticks are driven by hand: no sleeps measure anything.

use std::cell::{Cell, RefCell};
use std::net::{IpAddr, Ipv4Addr};
use std::time::Duration;

use libretracks_audio::VampMode;
use libretracks_link::redundancy::{RedundancyMessage, TransportIntent};
use libretracks_link::{connect_as_backup, start_host, GuestConfig, GuestEvent, HostConfig};

use super::*;
use crate::audio::engine::AudioController;

#[derive(Default)]
struct FakeIo {
    connected: Cell<bool>,
    seq: Cell<u64>,
    sent: RefCell<Vec<RedundancyMessage>>,
    clock_reads: Cell<u32>,
}

impl FakeIo {
    fn connected() -> Self {
        let io = Self::default();
        io.connected.set(true);
        io
    }
}

impl PublisherIo for FakeIo {
    fn backup_connected(&self) -> bool {
        self.connected.get()
    }
    fn next_seq(&self) -> u64 {
        self.seq.set(self.seq.get() + 1);
        self.seq.get()
    }
    fn send(&self, message: &RedundancyMessage) -> bool {
        self.sent.borrow_mut().push(message.clone());
        true
    }
    fn audio_clock(&self) -> Option<TransportClock> {
        self.clock_reads.set(self.clock_reads.get() + 1);
        Some(TransportClock {
            playing: true,
            position_seconds: 1.0,
            callback_monotonic_ns: 5,
            output_latency_seconds: 0.01,
            sample_rate: 48_000,
        })
    }
    fn fallback_active(&self) -> bool {
        false
    }
    fn set_health(&self, _health: HealthSummary) {}
    fn monotonic_ns_of(&self, _at: Instant) -> u64 {
        42
    }
}

fn intent(origin: IntentOrigin) -> OriginatedIntent {
    OriginatedIntent {
        intent: TransportIntent::Seek { to_seconds: 2.0 },
        origin,
        at: Instant::now(),
    }
}

#[test]
fn follower_intents_never_go_back_to_the_backup() {
    let io = FakeIo::connected();
    let mut core = PublisherCore::new();
    assert!(!core.on_intent(&io, &intent(IntentOrigin::Follower)));
    assert!(io.sent.borrow().is_empty());
    for origin in [
        IntentOrigin::Local,
        IntentOrigin::Link,
        IntentOrigin::Midi,
        IntentOrigin::Remote,
    ] {
        assert!(core.on_intent(&io, &intent(origin)), "{origin:?}");
    }
}

#[test]
fn an_intent_is_followed_by_a_state() {
    let io = FakeIo::connected();
    let mut core = PublisherCore::new();
    core.on_intent(&io, &intent(IntentOrigin::Local));
    let sent = io.sent.borrow();
    assert!(matches!(sent[0], RedundancyMessage::Intent { seq: 1, monotonic_ns: 42, .. }));
    assert!(matches!(sent[1], RedundancyMessage::State { seq: 2, .. }));
}

#[test]
fn without_a_backup_the_tick_does_no_work() {
    let io = FakeIo::default();
    let mut core = PublisherCore::new();
    for _ in 0..20 {
        assert!(!core.on_tick(&io));
    }
    assert_eq!(io.clock_reads.get(), 0, "not even a clock read");
    assert!(io.sent.borrow().is_empty());
    assert!(!core.on_intent(&io, &intent(IntentOrigin::Local)));
    assert!(!core.on_fingerprint(&io, "f".into()));
}

#[test]
fn every_tick_with_a_backup_sends_one_state() {
    let io = FakeIo::connected();
    let mut core = PublisherCore::new();
    for _ in 0..5 {
        assert!(core.on_tick(&io));
    }
    let states = io
        .sent
        .borrow()
        .iter()
        .filter(|message| matches!(message, RedundancyMessage::State { .. }))
        .count();
    assert_eq!(states, 5);
}

#[test]
fn the_fingerprint_goes_on_connect_and_only_when_it_changes() {
    let io = FakeIo::connected();
    let mut core = PublisherCore::new();
    core.on_backup_connected(&io, Some("a".into()));
    assert!(!core.on_fingerprint(&io, "a".into()), "unchanged");
    assert!(core.on_fingerprint(&io, "b".into()));
    // A reconnection resends even an unchanged one.
    core.on_backup_connected(&io, Some("b".into()));
    let fingerprints: Vec<_> = io
        .sent
        .borrow()
        .iter()
        .filter_map(|message| match message {
            RedundancyMessage::Fingerprint { fingerprint, .. } => Some(fingerprint.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(fingerprints, vec!["a", "b", "b"]);
}

/// IO over a real link server, with a fixed audio clock (the no-link engine
/// has none).
struct ServerIo {
    handle: HostHandle,
}

impl PublisherIo for ServerIo {
    fn backup_connected(&self) -> bool {
        self.handle.backup().is_some()
    }
    fn next_seq(&self) -> u64 {
        self.handle.next_redundancy_seq()
    }
    fn send(&self, message: &RedundancyMessage) -> bool {
        self.handle.send_to_backup(message)
    }
    fn audio_clock(&self) -> Option<TransportClock> {
        Some(TransportClock {
            playing: true,
            position_seconds: 0.0,
            callback_monotonic_ns: self.handle.monotonic_ns(),
            output_latency_seconds: 0.0,
            sample_rate: 48_000,
        })
    }
    fn fallback_active(&self) -> bool {
        false
    }
    fn set_health(&self, health: HealthSummary) {
        self.handle.set_health(health);
    }
    fn monotonic_ns_of(&self, at: Instant) -> u64 {
        at.saturating_duration_since(self.handle.clock_origin())
            .as_nanos() as u64
    }
}

#[test]
fn session_changes_reach_a_backup_in_order_with_growing_seq() {
    tauri::async_runtime::block_on(async {
        let runtime = start_host(HostConfig {
            bind_ip: IpAddr::from(Ipv4Addr::LOCALHOST),
            preferred_port: 0,
            port_attempts: 1,
            accept_guests: false,
            accept_backup: true,
            backup_pin: Some("4321".into()),
            ..HostConfig::new("Principal")
        })
        .await
        .unwrap();
        let port = runtime.handle.port();
        let mut backup = connect_as_backup(GuestConfig {
            pin: Some("4321".into()),
            ..GuestConfig::new(format!("ws://127.0.0.1:{port}"), "backup-1")
        })
        .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while runtime.handle.backup().is_none() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("backup connected");

        let mut session = crate::state::tests::session_with_song_dir(
            "redundancy-publisher",
            crate::state::tests::demo_song_with_two_sections(),
        );
        let audio = AudioController::default();
        let mut intents = session.subscribe_intents();
        session.play(&audio).unwrap();
        session.seek(2.5, &audio).unwrap();
        session.toggle_vamp(VampMode::Section, &audio).unwrap();

        let io = ServerIo {
            handle: runtime.handle.clone(),
        };
        let mut core = PublisherCore::new();
        while let Ok(intent) = intents.try_recv() {
            core.on_intent(&io, &intent);
        }
        // Three simulated 20 Hz ticks.
        for _ in 0..3 {
            core.on_tick(&io);
        }

        let mut received_intents = Vec::new();
        let mut states = 0;
        let mut last_seq = 0;
        tokio::time::timeout(Duration::from_secs(5), async {
            while received_intents.len() < 3 || states < 6 {
                let Some(event) = backup.events.recv().await else { break };
                let GuestEvent::Redundancy(message) = event else { continue };
                match message {
                    RedundancyMessage::Intent { seq, intent, .. } => {
                        assert!(seq > last_seq, "seq grows");
                        last_seq = seq;
                        received_intents.push(intent);
                    }
                    RedundancyMessage::State { seq, .. } => {
                        assert!(seq > last_seq, "seq grows");
                        last_seq = seq;
                        states += 1;
                    }
                    _ => {}
                }
            }
        })
        .await
        .expect("intents and states arrive");
        assert!(matches!(received_intents[0], TransportIntent::Play { .. }));
        assert_eq!(received_intents[1], TransportIntent::Seek { to_seconds: 2.5 });
        assert!(matches!(
            received_intents[2],
            TransportIntent::ToggleVamp { .. }
        ));
        // One after each intent plus one per tick.
        assert_eq!(states, 6);
        runtime.handle.stop();
    });
}
