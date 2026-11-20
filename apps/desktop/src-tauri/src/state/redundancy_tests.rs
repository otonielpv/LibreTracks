//! Redundancy step 04: every public transport method emits exactly one
//! intent after a successful change, none after a failed one, tagged with
//! where it came from. Runs on the no-link engine stubs.

use libretracks_audio::{JumpTrigger, TransitionType, VampMode};
use libretracks_link::redundancy::TransportIntent;
use tokio::sync::broadcast::error::TryRecvError;

use super::super::tests::{
    demo_song_with_region_changes_and_sections, demo_song_with_two_sections,
    session_with_song_dir,
};
use super::*;

fn audio() -> AudioController {
    AudioController::default()
}

/// The one intent the call produced (fails on zero or more than one).
fn only_intent(rx: &mut broadcast::Receiver<OriginatedIntent>) -> OriginatedIntent {
    let first = rx.try_recv().expect("one intent");
    assert_eq!(rx.try_recv(), Err(TryRecvError::Empty), "exactly one intent");
    first
}

fn no_intent(rx: &mut broadcast::Receiver<OriginatedIntent>) {
    assert_eq!(rx.try_recv(), Err(TryRecvError::Empty));
}

fn session() -> DesktopSession {
    session_with_song_dir("redundancy-intents", demo_song_with_two_sections())
}

#[test]
fn play_pause_stop_emit_one_intent_each() {
    let mut session = session();
    let audio = audio();
    let mut rx = session.subscribe_intents();

    let snapshot = session.play(&audio).unwrap();
    let intent = only_intent(&mut rx);
    assert_eq!(
        intent.intent,
        TransportIntent::Play {
            from_seconds: snapshot.position_seconds
        }
    );
    assert_eq!(intent.origin, IntentOrigin::Local);

    let snapshot = session.pause(&audio).unwrap();
    assert_eq!(
        only_intent(&mut rx).intent,
        TransportIntent::Pause {
            at_seconds: snapshot.position_seconds
        }
    );

    session.stop(&audio).unwrap();
    assert_eq!(only_intent(&mut rx).intent, TransportIntent::Stop);
}

#[test]
fn seek_carries_the_requested_view_position() {
    let mut session = session();
    let audio = audio();
    let mut rx = session.subscribe_intents();
    session.seek(3.25, &audio).unwrap();
    assert_eq!(
        only_intent(&mut rx).intent,
        TransportIntent::Seek { to_seconds: 3.25 }
    );
}

#[test]
fn marker_jump_carries_marker_trigger_and_transition() {
    let mut session = session();
    let audio = audio();
    session.play(&audio).unwrap();
    let mut rx = session.subscribe_intents();
    session
        .schedule_marker_jump(
            "section_2",
            JumpTrigger::AfterBars(2),
            TransitionType::Instant,
            &audio,
        )
        .unwrap();
    assert_eq!(
        only_intent(&mut rx).intent,
        TransportIntent::ScheduleMarkerJump {
            marker_id: "section_2".into(),
            trigger: "after_bars".into(),
            bars: Some(2),
            transition: Some("instant".into()),
            duration_seconds: None,
        }
    );

    session.cancel_marker_jump(&audio).unwrap();
    assert_eq!(only_intent(&mut rx).intent, TransportIntent::CancelJump);
}

#[test]
fn region_jump_carries_region_trigger_and_fade() {
    let mut session = session_with_song_dir(
        "redundancy-region-jump",
        demo_song_with_region_changes_and_sections(),
    );
    let audio = audio();
    session.play(&audio).unwrap();
    let mut rx = session.subscribe_intents();
    session
        .schedule_region_jump(
            "region_2",
            JumpTrigger::RegionEnd,
            TransitionType::FadeOut {
                duration_seconds: 0.5,
            },
            &audio,
        )
        .unwrap();
    assert_eq!(
        only_intent(&mut rx).intent,
        TransportIntent::ScheduleRegionJump {
            region_id: "region_2".into(),
            trigger: "region_end".into(),
            bars: None,
            transition: Some("fade_out".into()),
            duration_seconds: Some(0.5),
        }
    );
}

#[test]
fn vamp_goes_out_as_the_resulting_state() {
    let mut session = session();
    let audio = audio();
    session.play(&audio).unwrap();
    let mut rx = session.subscribe_intents();
    let on = session.toggle_vamp(VampMode::Section, &audio).unwrap();
    let intent = only_intent(&mut rx).intent;
    assert_eq!(
        intent,
        TransportIntent::ToggleVamp {
            enabled: on.active_vamp.is_some(),
            mode: Some("section".into()),
            bars: None,
        }
    );
    let off = session.toggle_vamp(VampMode::Section, &audio).unwrap();
    let TransportIntent::ToggleVamp { enabled, .. } = only_intent(&mut rx).intent else {
        panic!("vamp intent");
    };
    assert_eq!(enabled, off.active_vamp.is_some());
    assert_ne!(on.active_vamp.is_some(), off.active_vamp.is_some());
}

#[test]
fn fade_out_then_second_press_goes_out_as_stop() {
    let mut session = session();
    let audio = audio();
    let mut rx = session.subscribe_intents();
    // Not playing: nothing changes, nothing goes out.
    session.fade_out_and_stop(2.0, &audio).unwrap();
    no_intent(&mut rx);

    session.play(&audio).unwrap();
    let _ = only_intent(&mut rx);
    session.fade_out_and_stop(2.0, &audio).unwrap();
    assert_eq!(
        only_intent(&mut rx).intent,
        TransportIntent::FadeOutStop { duration_ms: 2000 }
    );
    // The second press stops at once (inner `stop` does not add its own).
    session.fade_out_and_stop(2.0, &audio).unwrap();
    assert_eq!(only_intent(&mut rx).intent, TransportIntent::Stop);
}

#[test]
fn a_rejected_change_emits_nothing() {
    let audio = audio();
    let mut empty = DesktopSession::default();
    let mut rx = empty.subscribe_intents();
    assert!(empty.play(&audio).is_err(), "no song loaded");
    no_intent(&mut rx);

    let mut session = session();
    let mut rx = session.subscribe_intents();
    assert!(session
        .schedule_marker_jump(
            "no-such-marker",
            JumpTrigger::Immediate,
            TransitionType::Instant,
            &audio
        )
        .is_err());
    assert!(session
        .schedule_region_jump(
            "no-such-region",
            JumpTrigger::Immediate,
            TransitionType::Instant,
            &audio
        )
        .is_err());
    no_intent(&mut rx);
}

#[test]
fn the_origin_scope_tags_and_then_restores() {
    let mut session = session();
    let audio = audio();
    let mut rx = session.subscribe_intents();
    {
        let _link = session.intent_origin_scope(IntentOrigin::Link);
        session.seek(1.0, &audio).unwrap();
        {
            let _follower = session.intent_origin_scope(IntentOrigin::Follower);
            session.seek(2.0, &audio).unwrap();
        }
        session.seek(3.0, &audio).unwrap();
    }
    session.seek(4.0, &audio).unwrap();
    let origins: Vec<_> = (0..4).map(|_| rx.try_recv().unwrap().origin).collect();
    assert_eq!(
        origins,
        vec![
            IntentOrigin::Link,
            IntentOrigin::Follower,
            IntentOrigin::Link,
            IntentOrigin::Local
        ]
    );
}

#[test]
fn no_subscriber_or_a_full_channel_never_blocks_nor_fails_the_change() {
    let mut session = session();
    let audio = audio();
    // No subscriber at all.
    session.seek(1.0, &audio).unwrap();
    // A subscriber that never reads: the channel fills and keeps going.
    let mut rx = session.subscribe_intents();
    for index in 0..(INTENT_CHANNEL_CAPACITY * 3) {
        let snapshot = session.seek(index as f64 * 0.01, &audio).unwrap();
        assert!(snapshot.position_seconds >= 0.0);
    }
    // The slow reader lost the oldest, and is told so.
    assert!(matches!(rx.try_recv(), Err(TryRecvError::Lagged(_))));
}

/// The origin each external entry point tags its changes with. Checked on
/// the source because those entry points need a running Tauri app; the
/// tagging itself is `the_origin_scope_tags_and_then_restores`.
#[test]
fn external_entry_points_tag_their_origin() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let expectations = [
        ("link/host.rs", "fn apply(", "IntentOrigin::Link"),
        ("midi/dispatch.rs", "fn dispatch_midi_action(", "IntentOrigin::Midi"),
        ("remote/mod.rs", "RemoteCommand::Play => session.play", "IntentOrigin::Remote"),
    ];
    for (file, anchor, origin) in expectations {
        let text = std::fs::read_to_string(root.join(file)).unwrap();
        let at = text.find(anchor).unwrap_or_else(|| panic!("{anchor} in {file}"));
        // The scope opens in that function, before its transport calls.
        let window_start = at.saturating_sub(400);
        let window = &text[window_start..(at + 1600).min(text.len())];
        assert!(
            window.contains(&format!("intent_origin_scope(crate::state::{origin})")),
            "{file} must tag its transport changes as {origin}"
        );
    }
}

/// Every transport Tauri command maps to a session method that emits an
/// intent. A new command in `commands/transport.rs` turns this red until it
/// is listed here (and, if it changes the transport, goes through a public
/// method of `state/redundancy.rs`).
#[test]
fn transport_command_coverage() {
    let text = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/commands/transport.rs"),
    )
    .unwrap();
    let mut commands = Vec::new();
    let mut lines = text.lines();
    while let Some(line) = lines.next() {
        if line.trim_start().starts_with("#[tauri::command") {
            for next in lines.by_ref() {
                if let Some(rest) = next.trim_start().strip_prefix("pub fn ") {
                    commands.push(rest.split('(').next().unwrap().to_string());
                    break;
                }
            }
        }
    }
    let known: &[(&str, Option<&str>)] = &[
        ("get_transport_snapshot", None),
        ("prewarm_timeline_seek", None),
        ("play_transport", Some("play")),
        ("pause_transport", Some("pause")),
        ("stop_transport", Some("stop")),
        ("fade_out_and_stop", Some("fade_out_and_stop")),
        ("seek_transport", Some("seek")),
        ("schedule_marker_jump", Some("schedule_marker_jump")),
        ("schedule_region_jump", Some("schedule_region_jump")),
        ("cancel_marker_jump", Some("cancel_marker_jump")),
        ("toggle_vamp", Some("toggle_vamp")),
    ];
    for command in &commands {
        let entry = known
            .iter()
            .find(|(name, _)| name == command)
            .unwrap_or_else(|| panic!("new transport command `{command}`: classify it here"));
        if let Some(method) = entry.1 {
            let intents = [
                TransportIntent::Play { from_seconds: 0.0 },
                TransportIntent::Pause { at_seconds: 0.0 },
                TransportIntent::Stop,
                TransportIntent::FadeOutStop { duration_ms: 0 },
                TransportIntent::Seek { to_seconds: 0.0 },
                TransportIntent::ScheduleMarkerJump {
                    marker_id: String::new(),
                    trigger: String::new(),
                    bars: None,
                    transition: None,
                    duration_seconds: None,
                },
                TransportIntent::ScheduleRegionJump {
                    region_id: String::new(),
                    trigger: String::new(),
                    bars: None,
                    transition: None,
                    duration_seconds: None,
                },
                TransportIntent::CancelJump,
                TransportIntent::ToggleVamp {
                    enabled: false,
                    mode: None,
                    bars: None,
                },
            ];
            assert!(
                intents.iter().any(|intent| method_for(intent) == method),
                "`{command}` calls `{method}`, which emits no intent"
            );
        }
    }
    assert_eq!(commands.len(), known.len(), "{commands:?}");
}

/// MIDI output whose only port, "Out", records every byte written to it.
struct RecordingTransport(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

struct RecordingOutput(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

impl crate::midi::transport::OutputConnection for RecordingOutput {
    fn send(&mut self, bytes: &[u8]) -> Result<(), String> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(())
    }
}

impl crate::midi::transport::MidiTransport for RecordingTransport {
    fn input_names(&self) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }

    fn output_names(&self) -> Result<Vec<String>, String> {
        Ok(vec!["Out".into()])
    }

    fn open_input(
        &self,
        name: &str,
        _on_bytes: crate::midi::transport::OnBytes,
    ) -> Result<Box<dyn crate::midi::transport::InputConnection>, String> {
        Err(format!("no inputs: {name}"))
    }

    fn open_output(
        &self,
        _name: &str,
    ) -> Result<Box<dyn crate::midi::transport::OutputConnection>, String> {
        Ok(Box::new(RecordingOutput(std::sync::Arc::clone(&self.0))))
    }

    fn capabilities(&self) -> crate::midi::transport::MidiCapabilities {
        crate::midi::transport::MidiCapabilities {
            available: true,
            ..Default::default()
        }
    }
}

/// A playing session with one MIDI clip (a program change) at 0 s, wired to
/// a recording port. Returns the bytes the port received.
fn playing_session_with_midi_clip() -> (
    DesktopSession,
    std::sync::Arc<std::sync::Mutex<Vec<u8>>>,
) {
    use libretracks_core::model::{MidiClip, MidiEvent, MidiEventKind, TrackKind};

    let mut song = demo_song_with_two_sections();
    let mut midi_track = song.tracks[0].clone();
    midi_track.id = "m1".into();
    midi_track.kind = TrackKind::Midi;
    song.tracks.push(midi_track);
    song.midi_clips.push(MidiClip {
        lead: None,
        id: "mc1".into(),
        track_id: "m1".into(),
        timeline_start_seconds: 0.0,
        name: String::new(),
        events: vec![MidiEvent {
            id: "e1".into(),
            at_seconds: 0.0,
            channel: None,
            kind: MidiEventKind::ProgramChange { program: 5 },
        }],
        color: None,
    });
    let mut session = session_with_song_dir("redundancy-midi", song);

    let sent = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let output = crate::midi::output::MidiOutputManager::with_transport(std::sync::Arc::new(
        RecordingTransport(std::sync::Arc::clone(&sent)),
    ));
    output.restart(Some("Out".into())).unwrap();
    session.midi_output = Some(std::sync::Arc::new(output));
    session.play(&audio()).unwrap();
    // Whatever opening the port or starting playback wrote is not ours.
    drain_midi(&session, &sent);
    (session, sent)
}

/// MIDI goes out on its own thread. Send a sentinel note behind whatever the
/// session queued, wait for it to arrive (the thread keeps order) and return
/// the bytes that came before it, leaving the record empty.
fn drain_midi(
    session: &DesktopSession,
    sent: &std::sync::Arc<std::sync::Mutex<Vec<u8>>>,
) -> Vec<u8> {
    use crate::midi::message::OutboundMidiMessage;

    const SENTINEL: [u8; 3] = [0x9F, 127, 1];
    session
        .midi_output
        .as_ref()
        .expect("port wired")
        .send(&[OutboundMidiMessage::note_on(16, 127, 1)]);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        {
            let mut bytes = sent.lock().unwrap();
            if bytes.ends_with(&SENTINEL) {
                let before = bytes[..bytes.len() - SENTINEL.len()].to_vec();
                bytes.clear();
                return before;
            }
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the sentinel never reached the port"
        );
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
}

#[test]
fn a_backup_following_its_main_sends_no_timeline_midi() {
    let (mut session, sent) = playing_session_with_midi_clip();
    session.set_transport_locked(true, None);

    // The tick window (cursor, now] covers the clip at 0 s.
    session.midi_cursor_seconds = -0.01;
    session.advance_midi_playback().unwrap();

    assert_eq!(
        drain_midi(&session, &sent),
        Vec::<u8>::new(),
        "the main sends, not the backup"
    );
    assert!(
        session.midi_cursor_seconds >= 0.0,
        "the cursor still advances, so taking over does not burst held messages"
    );
}

#[test]
fn a_backup_that_carries_the_show_sends_timeline_midi() {
    let (mut session, sent) = playing_session_with_midi_clip();
    // Main lost or "Ahora mando yo": the follower lifts the lock.
    session.set_transport_locked(true, None);
    session.set_transport_locked(false, None);

    session.midi_cursor_seconds = -0.01;
    session.advance_midi_playback().unwrap();

    // Program change on the track's channel: status 0xC?, program 5.
    let bytes = drain_midi(&session, &sent);
    assert_eq!(bytes.len(), 2, "one program change, got {bytes:?}");
    assert_eq!(bytes[0] & 0xF0, 0xC0);
    assert_eq!(bytes[1], 5);
}
