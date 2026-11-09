//! Redundancy step 06.
//!
//! Two `DesktopSession`s in one process cannot give a moving clock: under
//! the no-link stubs the engine's audio clock is a fixed reading. So the
//! end-to-end test (C1) runs the REAL publisher core, link server, backup
//! client and follower core between two engine doubles that share a virtual
//! clock; a separate test applies every action to a real `DesktopSession`.

use std::cell::RefCell;
use std::net::{IpAddr, Ipv4Addr};
use std::rc::Rc;
use std::time::{Duration, Instant};

use libretracks_core::session_fingerprint::SessionFingerprint;
use libretracks_link::redundancy::{
    HealthSummary, PendingJump as LinkJump, RedundancyMessage, TransportClock, TransportIntent,
};
use libretracks_link::{
    connect_as_backup, start_host, GuestConfig, GuestEvent, GuestRuntime, HostConfig, HostHandle,
    LinkCommand,
};

use super::*;
use crate::audio::engine::AudioController;
use crate::redundancy::publisher::{FeedView, PublisherCore, PublisherIo};
use crate::state::{OriginatedIntent, DesktopSession};

const MS: u64 = 1_000_000;

fn two_song_session() -> Song {
    serde_json::from_value(serde_json::json!({
        "id": "s", "title": "Set", "durationSeconds": 200.0,
        "regions": [
            { "id": "song-1", "name": "Uno", "startSeconds": 0.0, "endSeconds": 100.0 },
            { "id": "song-2", "name": "Dos", "startSeconds": 100.0, "endSeconds": 200.0 }
        ],
        "tracks": [], "clips": [], "sectionMarkers": []
    }))
    .unwrap()
}

fn fingerprint(setlist: &str) -> SessionFingerprint {
    SessionFingerprint {
        version: libretracks_core::session_fingerprint::FINGERPRINT_VERSION,
        setlist: setlist.into(),
        songs: Vec::new(),
        timing_settings: Default::default(),
    }
}

/// Markers of the shared "session": id → (fires at, lands at).
fn marker(id: &str) -> (f64, f64) {
    match id {
        "chorus" => (12.0, 40.0),
        _ => (0.0, 0.0),
    }
}

/// An engine with a virtual clock.
#[derive(Debug, Clone, Default)]
struct EngineDouble {
    playing: bool,
    position: f64,
    since_ns: u64,
    vamp: bool,
    pending: Option<(String, f64, f64)>,
    latency: f64,
    applied: Vec<Action>,
}

impl EngineDouble {
    fn position_at(&self, now: u64) -> f64 {
        if self.playing {
            self.position + (now - self.since_ns) as f64 / 1e9
        } else {
            self.position
        }
    }

    fn set_position(&mut self, now: u64, position: f64) {
        self.position = position;
        self.since_ns = now;
    }

    /// Fire a pending jump the playhead crossed.
    fn advance(&mut self, now: u64) {
        if let Some((_, at, target)) = self.pending.clone() {
            let position = self.position_at(now);
            if self.playing && position >= at {
                self.set_position(now, target + (position - at));
                self.pending = None;
            }
        }
    }

    fn clock(&self, now: u64) -> AudioClockSample {
        AudioClockSample {
            position_seconds: self.position_at(now),
            sampled_at_ns: now,
            playing: self.playing,
            output_latency_seconds: self.latency,
        }
    }

    fn audible(&self, now: u64) -> f64 {
        self.position_at(now) - if self.playing { self.latency } else { 0.0 }
    }
}

/// The backup's engine as a `FollowTarget`.
struct BackupTarget {
    engine: Rc<RefCell<EngineDouble>>,
    now: Rc<RefCell<u64>>,
}

impl FollowTarget for BackupTarget {
    fn apply(&mut self, action: &Action, _vamp: Option<(String, Option<u32>)>) -> Result<(), String> {
        let now = *self.now.borrow();
        let mut engine = self.engine.borrow_mut();
        engine.applied.push(action.clone());
        match action {
            Action::None | Action::Freewheel(_) => {}
            Action::Play { from_seconds } => {
                engine.set_position(now, *from_seconds);
                engine.playing = true;
            }
            Action::Pause { at_seconds } => {
                engine.playing = false;
                engine.set_position(now, *at_seconds);
            }
            Action::Stop => {
                engine.playing = false;
                engine.set_position(now, 0.0);
                engine.pending = None;
            }
            Action::FadeOutStop { .. } => {}
            Action::SeekAbsolute { to_seconds } => engine.set_position(now, *to_seconds),
            Action::Nudge { delta_seconds } => {
                let position = engine.position_at(now) + delta_seconds;
                engine.set_position(now, position);
            }
            Action::ScheduleJump(jump) => {
                let id = jump.target.trim_start_matches("marker:").to_string();
                let (at, target) = marker(&id);
                engine.pending = Some((id, at, target));
            }
            Action::CancelJump => engine.pending = None,
            Action::SetVamp(enabled) => engine.vamp = *enabled,
        }
        Ok(())
    }
}

/// The publisher's IO over a real server, with the main double's clock.
struct MainIo {
    handle: HostHandle,
    engine: Rc<RefCell<EngineDouble>>,
    now: Rc<RefCell<u64>>,
    sent: RefCell<u32>,
}

impl PublisherIo for MainIo {
    fn backup_connected(&self) -> bool {
        self.handle.backup().is_some()
    }
    fn next_seq(&self) -> u64 {
        self.handle.next_redundancy_seq()
    }
    fn send(&self, message: &RedundancyMessage) -> bool {
        let sent = self.handle.send_to_backup(message);
        if sent {
            *self.sent.borrow_mut() += 1;
        }
        sent
    }
    fn audio_clock(&self) -> Option<TransportClock> {
        let now = *self.now.borrow();
        let engine = self.engine.borrow();
        Some(TransportClock {
            playing: engine.playing,
            position_seconds: engine.position_at(now),
            callback_monotonic_ns: now,
            output_latency_seconds: engine.latency,
            sample_rate: 48_000,
        })
    }
    fn fallback_active(&self) -> bool {
        false
    }
    fn pilot_tone_on(&self) -> bool {
        false
    }
    fn set_health(&self, _health: HealthSummary) {}
    fn monotonic_ns_of(&self, _at: std::time::Instant) -> u64 {
        *self.now.borrow()
    }
}

struct Rig {
    now: Rc<RefCell<u64>>,
    main: Rc<RefCell<EngineDouble>>,
    backup: Rc<RefCell<EngineDouble>>,
    io: MainIo,
    publisher: PublisherCore,
    follower: FollowerCore,
    target: BackupTarget,
    client: GuestRuntime,
    received: u32,
    song: Song,
}

impl Rig {
    async fn new() -> Rig {
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
        let client = connect_as_backup(GuestConfig {
            pin: Some("4321".into()),
            ..GuestConfig::new(format!("ws://127.0.0.1:{port}"), "backup")
        })
        .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while runtime.handle.backup().is_none() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let now = Rc::new(RefCell::new(0));
        let main = Rc::new(RefCell::new(EngineDouble {
            latency: 0.010,
            ..EngineDouble::default()
        }));
        let backup = Rc::new(RefCell::new(EngineDouble {
            latency: 0.004,
            ..EngineDouble::default()
        }));
        let mut follower = FollowerCore::new(Policy::default(), 0.0);
        follower.set_own_fingerprint(fingerprint("same"));
        let mut rig = Rig {
            io: MainIo {
                handle: runtime.handle.clone(),
                engine: main.clone(),
                now: now.clone(),
                sent: RefCell::new(0),
            },
            target: BackupTarget {
                engine: backup.clone(),
                now: now.clone(),
            },
            now,
            main,
            backup,
            publisher: PublisherCore::new(),
            follower,
            client,
            received: 0,
            song: two_song_session(),
        };
        rig.publisher
            .on_backup_connected(&rig.io, serde_json::to_string(&fingerprint("same")).ok());
        rig.drain().await;
        rig
    }

    fn now(&self) -> u64 {
        *self.now.borrow()
    }

    /// Deliver everything the publisher sent so far to the follower.
    async fn drain(&mut self) {
        let expected = *self.io.sent.borrow();
        tokio::time::timeout(Duration::from_secs(5), async {
            while self.received < expected {
                let Some(event) = self.client.events.recv().await else { break };
                if let GuestEvent::Redundancy(message) = event {
                    let counted = !matches!(message, RedundancyMessage::Heartbeat { .. }
                        | RedundancyMessage::Welcome { .. });
                    let now = self.now();
                    self.follower.on_message(message, now, Some(0.0), Some(&self.song));
                    if counted {
                        self.received += 1;
                    }
                }
            }
        })
        .await
        .expect("messages delivered");
    }

    fn feed(&mut self) {
        let now = self.now();
        let main = self.main.borrow().clone();
        let position = main.position_at(now);
        self.publisher.set_feed(FeedView {
            song_id: region_at(Some(&self.song), position).map(|(id, _, _)| id),
            vamp: Some(libretracks_link::redundancy::VampState {
                enabled: main.vamp,
                mode: None,
                bars: None,
            }),
            pending_jumps: main
                .pending
                .iter()
                .map(|(id, at, _)| LinkJump::Marker {
                    marker_id: id.clone(),
                    execute_at_seconds: Some(*at),
                })
                .collect(),
        });
    }

    async fn intent(&mut self, intent: TransportIntent) {
        self.feed();
        let message = OriginatedIntent {
            intent,
            origin: crate::state::IntentOrigin::Local,
            at: std::time::Instant::now(),
        };
        self.publisher.on_intent(&self.io, &message);
        self.drain().await;
    }

    async fn run_ms(&mut self, ms: u64) {
        for _ in 0..ms {
            *self.now.borrow_mut() += MS;
            let now = self.now();
            self.main.borrow_mut().advance(now);
            self.backup.borrow_mut().advance(now);
            if now % (50 * MS) == 0 {
                self.feed();
                self.publisher.on_tick(&self.io);
                self.drain().await;
            }
            if now % (20 * MS) == 0 {
                let backup = self.backup.borrow().clone();
                let local = LocalInputs {
                    clock: Some(backup.clock(now)),
                    vamp: backup.vamp,
                    pending_jump: backup.pending.as_ref().map(|(id, at, _)| CoreJump {
                        target: format!("marker:{id}"),
                        trigger: "next_marker".into(),
                        bars: None,
                        transition: None,
                        duration_seconds: None,
                        execute_at_seconds: Some(*at),
                        target_seconds: None,
                    }),
                };
                tick(&mut self.follower, &mut self.target, now, &local, Some(&self.song));
            }
        }
    }

    fn offset(&self) -> f64 {
        let now = self.now();
        self.main.borrow().audible(now) - self.backup.borrow().audible(now)
    }

    fn assert_same(&self, label: &str) {
        let (main, backup) = (self.main.borrow(), self.backup.borrow());
        assert_eq!(backup.playing, main.playing, "{label}: playing");
        assert_eq!(backup.vamp, main.vamp, "{label}: vamp");
        assert!(
            self.offset().abs() <= 0.001,
            "{label}: offset {:.3} ms",
            self.offset() * 1000.0
        );
    }
}

#[test]
fn the_backup_ends_where_the_main_is_after_every_transition() {
    tauri::async_runtime::block_on(async {
        let mut rig = Rig::new().await;
        rig.run_ms(300).await;
        assert_eq!(rig.follower.phase(), FollowerPhase::Following);

        // play
        let now = rig.now();
        rig.main.borrow_mut().playing = true;
        rig.main.borrow_mut().set_position(now, 5.0);
        rig.intent(TransportIntent::Play { from_seconds: 5.0 }).await;
        rig.run_ms(500).await;
        rig.assert_same("play");

        // seek
        let now = rig.now();
        rig.main.borrow_mut().set_position(now, 8.0);
        rig.intent(TransportIntent::Seek { to_seconds: 8.0 }).await;
        rig.run_ms(500).await;
        rig.assert_same("seek");

        // marker jump (fires at 12 s, lands at 40 s)
        rig.main.borrow_mut().pending = Some(("chorus".into(), 12.0, 40.0));
        rig.intent(TransportIntent::ScheduleMarkerJump {
            marker_id: "chorus".into(),
            trigger: "next_marker".into(),
            bars: None,
            transition: Some("instant".into()),
            duration_seconds: None,
        })
        .await;
        rig.run_ms(4000).await;
        assert!(rig.backup.borrow().position_at(rig.now()) > 40.0, "backup jumped");
        rig.assert_same("marker jump");

        // vamp on, vamp off
        rig.main.borrow_mut().vamp = true;
        rig.intent(TransportIntent::ToggleVamp {
            enabled: true,
            mode: Some("section".into()),
            bars: None,
        })
        .await;
        rig.run_ms(200).await;
        rig.assert_same("vamp on");
        rig.main.borrow_mut().vamp = false;
        rig.intent(TransportIntent::ToggleVamp {
            enabled: false,
            mode: Some("section".into()),
            bars: None,
        })
        .await;
        rig.run_ms(200).await;
        rig.assert_same("vamp off");

        // song change (a seek into the next song)
        let now = rig.now();
        rig.main.borrow_mut().set_position(now, 110.0);
        rig.intent(TransportIntent::Seek { to_seconds: 110.0 }).await;
        rig.run_ms(500).await;
        rig.assert_same("song change");
        assert_eq!(
            region_at(Some(&rig.song), rig.backup.borrow().position_at(rig.now())).map(|r| r.0),
            Some("song-2".into())
        );

        // stop
        let now = rig.now();
        rig.main.borrow_mut().playing = false;
        rig.main.borrow_mut().set_position(now, 0.0);
        rig.intent(TransportIntent::Stop).await;
        rig.run_ms(300).await;
        rig.assert_same("stop");
    });
}

#[test]
fn a_dropped_connection_never_stops_the_backup() {
    tauri::async_runtime::block_on(async {
        let mut rig = Rig::new().await;
        let now = rig.now();
        rig.main.borrow_mut().playing = true;
        rig.main.borrow_mut().set_position(now, 5.0);
        rig.intent(TransportIntent::Play { from_seconds: 5.0 }).await;
        rig.run_ms(1000).await;
        rig.assert_same("before the drop");

        // The network goes: the client socket closes, nothing else arrives.
        rig.client.handle.leave();
        rig.io.handle.stop();
        let before = rig.backup.borrow().applied.len();
        let position = rig.backup.borrow().position_at(rig.now());
        // Ticks go on (the publisher can send nothing now).
        for _ in 0..(30_000 / 20) {
            *rig.now.borrow_mut() += 20 * MS;
            let now = rig.now();
            let backup = rig.backup.borrow().clone();
            let local = LocalInputs {
                clock: Some(backup.clock(now)),
                vamp: backup.vamp,
                pending_jump: None,
            };
            tick(&mut rig.follower, &mut rig.target, now, &local, Some(&rig.song));
        }
        let backup = rig.backup.borrow();
        assert!(backup.playing, "still playing");
        assert!(backup.position_at(rig.now()) > position + 29.0, "still advancing");
        assert!(
            !backup.applied[before..]
                .iter()
                .any(|action| matches!(action, Action::Pause { .. } | Action::Stop)),
            "{:?}",
            &backup.applied[before..]
        );
        assert_eq!(rig.follower.phase(), FollowerPhase::MainLost);
        assert!(!rig.follower.locks_local_inputs(), "R6: local inputs free again");
    });
}

fn fresh_main_view_core(own: &str, main: &str) -> FollowerCore {
    let mut core = FollowerCore::new(Policy::default(), 0.0);
    core.set_own_fingerprint(fingerprint(own));
    core.on_message(
        RedundancyMessage::Fingerprint {
            version: 1,
            fingerprint: serde_json::to_string(&fingerprint(main)).unwrap(),
        },
        0,
        Some(0.0),
        None,
    );
    core.on_message(
        RedundancyMessage::State {
            seq: 1,
            clock: TransportClock {
                playing: true,
                position_seconds: 3.0,
                callback_monotonic_ns: 0,
                output_latency_seconds: 0.0,
                sample_rate: 48_000,
            },
            song_id: None,
            vamp: None,
            pending_jumps: Vec::new(),
        },
        0,
        Some(0.0),
        None,
    );
    core
}

fn stopped_local() -> LocalInputs {
    LocalInputs {
        clock: Some(AudioClockSample {
            position_seconds: 0.0,
            sampled_at_ns: 0,
            playing: false,
            output_latency_seconds: 0.0,
        }),
        vamp: false,
        pending_jump: None,
    }
}

#[derive(Default)]
struct CountingTarget {
    applied: u32,
}

impl FollowTarget for CountingTarget {
    fn apply(&mut self, _action: &Action, _vamp: Option<(String, Option<u32>)>) -> Result<(), String> {
        self.applied += 1;
        Ok(())
    }
}

#[test]
fn a_different_session_blocks_every_transport_action() {
    let mut core = fresh_main_view_core("mine", "theirs");
    let mut target = CountingTarget::default();
    for step in 0..50 {
        tick(&mut core, &mut target, step * 20 * MS, &stopped_local(), None);
    }
    assert_eq!(core.phase(), FollowerPhase::SessionMismatch);
    assert_eq!(target.applied, 0);
    assert!(!core.locks_local_inputs());
}

#[test]
fn only_a_mix_difference_does_not_block() {
    let mut own = fingerprint("same");
    own.songs.push(libretracks_core::session_fingerprint::SongFingerprint {
        song_id: "a".into(),
        title: "A".into(),
        timeline: "t".into(),
        audio: "x".into(),
        mix: "mine".into(),
    });
    let mut theirs = own.clone();
    theirs.songs[0].mix = "theirs".into();
    let mut core = FollowerCore::new(Policy::default(), 0.0);
    core.set_own_fingerprint(own);
    core.on_message(
        RedundancyMessage::Fingerprint {
            version: 1,
            fingerprint: serde_json::to_string(&theirs).unwrap(),
        },
        0,
        Some(0.0),
        None,
    );
    let mut fresh = fresh_main_view_core("same", "same");
    std::mem::swap(&mut fresh.main, &mut core.main);
    core.main = fresh.main.take().or(core.main.take());
    let mut target = CountingTarget::default();
    tick(&mut core, &mut target, 0, &stopped_local(), None);
    assert_eq!(core.phase(), FollowerPhase::Following, "{:?}", core.diffs());
    assert_eq!(target.applied, 1, "the main plays and we do not: play");
}

#[test]
fn a_none_tick_never_reaches_the_target() {
    // Following, both stopped at the same spot: every decision is None.
    let mut core = fresh_main_view_core("same", "same");
    core.on_message(
        RedundancyMessage::State {
            seq: 2,
            clock: TransportClock {
                playing: false,
                position_seconds: 0.0,
                callback_monotonic_ns: 0,
                output_latency_seconds: 0.0,
                sample_rate: 48_000,
            },
            song_id: None,
            vamp: None,
            pending_jumps: Vec::new(),
        },
        0,
        Some(0.0),
        None,
    );
    let mut target = CountingTarget::default();
    for step in 0..40 {
        let decision = tick(&mut core, &mut target, step * 20 * MS, &stopped_local(), None);
        assert_eq!(decision.action, Action::None);
    }
    assert_eq!(target.applied, 0, "no lock taken for None");
}

// --- the real session ---

fn backup_session() -> DesktopSession {
    crate::state::tests::session_with_song_dir(
        "redundancy-follower",
        crate::state::tests::demo_song_with_two_sections(),
    )
}

#[test]
fn every_action_reaches_a_real_session_as_the_follower() {
    let mut session = backup_session();
    let audio = AudioController::default();
    session.set_transport_locked(true, None);
    let mut intents = session.subscribe_intents();

    apply_to_session(&mut session, &audio, &Action::Play { from_seconds: 1.0 }, None).unwrap();
    assert_eq!(session.snapshot().playback_state, "playing");
    apply_to_session(&mut session, &audio, &Action::SetVamp(true), None).unwrap();
    assert!(session.snapshot().active_vamp.is_some());
    apply_to_session(&mut session, &audio, &Action::SetVamp(true), None).unwrap();
    assert!(session.snapshot().active_vamp.is_some(), "idempotent");
    apply_to_session(&mut session, &audio, &Action::SetVamp(false), None).unwrap();
    assert!(session.snapshot().active_vamp.is_none());
    let jump = CoreJump {
        target: "marker:section_2".into(),
        trigger: "next_marker".into(),
        bars: None,
        transition: Some("instant".into()),
        duration_seconds: None,
        execute_at_seconds: None,
        target_seconds: None,
    };
    apply_to_session(&mut session, &audio, &Action::ScheduleJump(jump), None).unwrap();
    assert!(session.snapshot().pending_marker_jump.is_some());
    apply_to_session(&mut session, &audio, &Action::CancelJump, None).unwrap();
    assert!(session.snapshot().pending_marker_jump.is_none());
    apply_to_session(&mut session, &audio, &Action::SeekAbsolute { to_seconds: 3.0 }, None).unwrap();
    apply_to_session(&mut session, &audio, &Action::Pause { at_seconds: 2.0 }, None).unwrap();
    let snapshot = session.snapshot();
    assert_eq!(snapshot.playback_state, "paused");
    assert!((snapshot.position_seconds - 2.0).abs() < 0.01);
    apply_to_session(&mut session, &audio, &Action::Stop, None).unwrap();
    assert_eq!(session.snapshot().playback_state, "stopped");

    // Everything went out tagged as the follower's.
    while let Ok(intent) = intents.try_recv() {
        assert_eq!(intent.origin, IntentOrigin::Follower, "{:?}", intent.intent);
    }
}

#[test]
fn a_nudge_is_one_relative_seek_and_nothing_else() {
    let mut session = backup_session();
    let audio = AudioController::default();
    apply_to_session(&mut session, &audio, &Action::Play { from_seconds: 1.0 }, None).unwrap();
    let before = audio.debug_snapshot().unwrap().command_count;
    let mut intents = session.subscribe_intents();
    apply_to_session(&mut session, &audio, &Action::Nudge { delta_seconds: 0.004 }, None).unwrap();
    let debug = audio.debug_snapshot().unwrap();
    assert_eq!(debug.command_count, before + 1, "one engine command");
    assert_eq!(debug.last_command.unwrap().kind, "nudge");
    assert!(intents.try_recv().is_err(), "no intent, no UI lifecycle");
}

#[test]
fn a_following_backup_refuses_local_orders() {
    let mut session = backup_session();
    let audio = AudioController::default();
    session.set_transport_locked(true, None);
    let locked = |result: Result<crate::models::TransportSnapshot, crate::infra::error::DesktopError>| {
        matches!(result, Err(crate::infra::error::DesktopError::TransportLockedByRedundancy))
    };
    // The UI (play_transport calls this with the default origin).
    assert!(locked(session.play(&audio)));
    // A MIDI note mapped to play, and a guest of the backup's own session.
    for origin in [IntentOrigin::Midi, IntentOrigin::Link, IntentOrigin::Remote] {
        let _scope = session.intent_origin_scope(origin);
        assert!(locked(session.play(&audio)), "{origin:?}");
        assert!(locked(session.seek(2.0, &audio)), "{origin:?}");
    }
    assert_eq!(session.snapshot().playback_state, "stopped");
    // Unlocked (main lost): the operator has the transport back.
    session.set_transport_locked(false, None);
    assert!(session.play(&audio).is_ok());
}

#[test]
fn with_forwarding_the_main_gets_the_order_and_the_backup_does_not_apply_it() {
    let mut session = backup_session();
    let audio = AudioController::default();
    let forwarded = std::sync::Arc::new(std::sync::Mutex::new(Vec::<LinkCommand>::new()));
    let sink = forwarded.clone();
    session.set_transport_locked(
        true,
        Some(std::sync::Arc::new(move |command| sink.lock().unwrap().push(command))),
    );
    session.play(&audio).unwrap();
    {
        let _midi = session.intent_origin_scope(IntentOrigin::Midi);
        session.seek(4.0, &audio).unwrap();
    }
    assert_eq!(session.snapshot().playback_state, "stopped", "not applied here");
    assert_eq!(
        *forwarded.lock().unwrap(),
        vec![LinkCommand::Play, LinkCommand::Seek { position_seconds: 4.0 }]
    );
}

#[test]
fn the_backup_says_why_it_cannot_connect() {
    use super::super::follower_runtime::connection_error;
    use libretracks_link::{GuestState, RejectReason};
    let rejected = |reason| GuestState::Rejected {
        reason,
        expected_protocol: None,
    };
    assert_eq!(connection_error(&rejected(RejectReason::BadPin)).as_deref(), Some("badPin"));
    assert_eq!(
        connection_error(&rejected(RejectReason::BackupNotAccepted)).as_deref(),
        Some("backupNotAccepted")
    );
    assert_eq!(
        connection_error(&rejected(RejectReason::BackupAlreadyConnected)).as_deref(),
        Some("backupAlreadyConnected")
    );
    assert_eq!(connection_error(&GuestState::Connecting { attempt: 1 }), None);
    assert_eq!(
        connection_error(&GuestState::Connecting { attempt: 3 }).as_deref(),
        Some("unreachable")
    );
    assert_eq!(connection_error(&GuestState::Lost), None);
}

#[test]
fn without_an_audio_clock_the_lifecycle_still_moves_and_says_why() {
    let mut core = FollowerCore::new(Policy::default(), 0.0);
    core.on_message(
        RedundancyMessage::Fingerprint {
            version: 1,
            fingerprint: serde_json::to_string(&fingerprint("same")).unwrap(),
        },
        0,
        Some(0.0),
        None,
    );
    let no_clock = LocalInputs::default();
    core.decide(0, &no_clock, None);
    assert_eq!(core.phase(), FollowerPhase::CheckingSession, "connected, not stuck in pairing");
    assert_eq!(core.waiting_for(), Some("ownSession"));
    core.set_own_fingerprint(fingerprint("same"));
    core.decide(20 * MS, &no_clock, None);
    assert_eq!(core.phase(), FollowerPhase::Following);
    assert_eq!(core.waiting_for(), Some("audioClock"));
}

#[test]
fn an_unanswered_copy_request_is_sent_again_then_given_up() {
    use super::super::follower_runtime::CopyWatch;
    let start = Instant::now();
    let mut watch = CopyWatch::new(RedundancyMessage::SessionRequest { request_id: 1 });
    assert_eq!(watch.due(start), Ok(None), "just sent");
    let mut now = start;
    for _ in 0..5 {
        now += Duration::from_secs(5);
        assert!(matches!(watch.due(now), Ok(Some(RedundancyMessage::SessionRequest { request_id: 1 }))));
    }
    now += Duration::from_secs(5);
    assert_eq!(watch.due(now), Err(()));
}

#[test]
fn main_urls_default_the_link_port() {
    use super::super::follower_runtime::main_url;
    assert_eq!(main_url("192.168.1.20"), "ws://192.168.1.20:3040");
    assert_eq!(main_url("192.168.1.20:3041"), "ws://192.168.1.20:3041");
    assert_eq!(main_url(" ws://pc-a:3040/ "), "ws://pc-a:3040");
}
