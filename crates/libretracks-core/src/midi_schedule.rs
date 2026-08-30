//! Pure scheduling logic for MIDI playback: given a song and a time window,
//! decide which events fire and how in-progress controller sweeps step.
//!
//! This lives in `libretracks-core` rather than next to the transport in the
//! desktop crate for a practical reason: `libretracks-desktop` links the native
//! audio engine, so its tests do not run in CI (or locally without the engine
//! DLL). Keeping the decision-making here — free of any device, engine or
//! session handle — means the parts that are easy to get wrong (double-firing
//! on a tick boundary, hanging notes across a jump, curve interpolation) are
//! covered by tests that actually execute.
//!
//! The desktop side owns everything stateful: opening the port, holding the
//! cursor, and pushing the resulting messages.

use crate::model::{MidiEventKind, Song, TrackKind};

/// A MIDI message to emit, in terms the caller turns into wire bytes.
///
/// Two routing facts travel with every message and are easy to conflate:
/// `port` is the cable it leaves by (a device, `None` = the app-wide default),
/// while `channel` is which of the 16 addresses *inside* that cable the
/// message is tagged with. `channel` is 1-16 as the user sees it; the 0-based
/// wire nibble is produced at send time by the output layer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScheduledMidiMessage {
    NoteOn {
        port: Option<String>,
        channel: u8,
        note: u8,
        velocity: u8,
    },
    NoteOff {
        port: Option<String>,
        channel: u8,
        note: u8,
    },
    ControlChange {
        port: Option<String>,
        channel: u8,
        controller: u8,
        value: u8,
    },
    ProgramChange {
        port: Option<String>,
        channel: u8,
        program: u8,
    },
}

/// A note sounding on the output, awaiting its note-off.
#[derive(Debug, Clone, PartialEq)]
pub struct PendingNoteOff {
    /// Port the note-on went out by; the note-off must follow it, or the note
    /// hangs on the device that actually sounded it.
    pub port: Option<String>,
    pub channel: u8,
    pub note: u8,
    /// Timeline position (source seconds) at which the note-off is due.
    pub off_at_seconds: f64,
}

/// An in-progress controller sweep started by a `ControlCurve` event.
#[derive(Debug, Clone, PartialEq)]
pub struct PendingControlCurve {
    pub port: Option<String>,
    pub channel: u8,
    pub controller: u8,
    pub from_value: u8,
    pub to_value: u8,
    pub start_seconds: f64,
    pub duration_seconds: f64,
    /// Last value actually sent, so an unchanged byte is not re-sent.
    pub last_sent_value: u8,
}

/// What one tick of the MIDI walk produced.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MidiTickOutput {
    pub messages: Vec<ScheduledMidiMessage>,
    /// Notes started this tick, to be tracked until their note-off is due.
    pub started_notes: Vec<PendingNoteOff>,
    /// Sweeps started this tick.
    pub started_curves: Vec<PendingControlCurve>,
}

/// Whether the song contains authored MIDI work on an enabled MIDI track.
/// `muted` is deliberately ignored here: automation can change it internally,
/// without an IPC command available to wake a parked worker.
pub fn has_enabled_midi_events(song: &Song) -> bool {
    song.midi_clips.iter().any(|clip| {
        !clip.events.is_empty()
            && song.tracks.iter().any(|track| {
                track.id == clip.track_id
                    && track.kind == TrackKind::Midi
                    && track.midi_enabled
            })
    })
}

/// Collect every event in the half-open window `(previous_seconds, now_seconds]`.
///
/// The window is half-open on purpose: an event landing exactly on a tick
/// boundary belongs to that tick and to no other, which is what stops the
/// classic double-fire when one tick's `now` is the next tick's `previous`.
///
/// Clips on muted MIDI tracks are skipped, matching muted audio tracks.
pub fn collect_events_in_window(
    song: &Song,
    previous_seconds: f64,
    now_seconds: f64,
) -> MidiTickOutput {
    let mut output = MidiTickOutput::default();

    for clip in &song.midi_clips {
        // Resolve the owning track once: it carries both the channel every
        // event inherits and the port the messages leave by. A clip whose
        // track is missing or muted produces nothing.
        let Some(track) = song
            .tracks
            .iter()
            .find(|track| track.id == clip.track_id && track.kind == TrackKind::Midi)
        else {
            continue;
        };
        // A MIDI track is silenced by its enable toggle (its equivalent of
        // mute); `muted` is still honoured for tracks carried over from before
        // the toggle existed.
        if !track.midi_enabled || track.muted {
            continue;
        }
        let track_channel = track.midi_channel;
        let port = track.midi_port.clone();

        for event in &clip.events {
            let event_seconds = clip.timeline_start_seconds + event.at_seconds.max(0.0);
            if event_seconds <= previous_seconds || event_seconds > now_seconds {
                continue;
            }

            let channel = event.effective_channel(track_channel);

            match event.kind {
                MidiEventKind::Note {
                    note,
                    velocity,
                    duration_seconds,
                } => {
                    output.messages.push(ScheduledMidiMessage::NoteOn {
                        port: port.clone(),
                        channel,
                        note,
                        velocity,
                    });
                    output.started_notes.push(PendingNoteOff {
                        port: port.clone(),
                        channel,
                        note,
                        off_at_seconds: event_seconds + duration_seconds.max(0.0),
                    });
                }
                MidiEventKind::ControlChange { controller, value } => {
                    output.messages.push(ScheduledMidiMessage::ControlChange {
                        port: port.clone(),
                        channel,
                        controller,
                        value,
                    });
                }
                MidiEventKind::ProgramChange { program } => {
                    output.messages.push(ScheduledMidiMessage::ProgramChange {
                        port: port.clone(),
                        channel,
                        program,
                    });
                }
                MidiEventKind::ControlCurve {
                    controller,
                    from_value,
                    to_value,
                    duration_seconds,
                } => {
                    // A zero-length sweep is just a value change; emitting the
                    // start and end would send two messages for one intent.
                    if duration_seconds <= 0.0 {
                        output.messages.push(ScheduledMidiMessage::ControlChange {
                            port: port.clone(),
                            channel,
                            controller,
                            value: to_value,
                        });
                        continue;
                    }
                    output.messages.push(ScheduledMidiMessage::ControlChange {
                        port: port.clone(),
                        channel,
                        controller,
                        value: from_value,
                    });
                    output.started_curves.push(PendingControlCurve {
                        port: port.clone(),
                        channel,
                        controller,
                        from_value,
                        to_value,
                        start_seconds: event_seconds,
                        duration_seconds,
                        last_sent_value: from_value,
                    });
                }
            }
        }
    }

    output
}

/// Split `notes` into those whose note-off is due at `now_seconds` and those
/// still held. Returns `(messages, still_held)`.
pub fn take_due_note_offs(
    notes: Vec<PendingNoteOff>,
    now_seconds: f64,
) -> (Vec<ScheduledMidiMessage>, Vec<PendingNoteOff>) {
    let mut messages = Vec::new();
    let mut still_held = Vec::new();
    for note in notes {
        if note.off_at_seconds <= now_seconds {
            messages.push(ScheduledMidiMessage::NoteOff {
                port: note.port.clone(),
                channel: note.channel,
                note: note.note,
            });
        } else {
            still_held.push(note);
        }
    }
    (messages, still_held)
}

/// The 7-bit value a sweep has reached at `now_seconds`.
pub fn curve_value_at(curve: &PendingControlCurve, now_seconds: f64) -> u8 {
    let t = if curve.duration_seconds > 0.0 {
        ((now_seconds - curve.start_seconds) / curve.duration_seconds).clamp(0.0, 1.0)
    } else {
        1.0
    };
    let span = f64::from(curve.to_value) - f64::from(curve.from_value);
    (f64::from(curve.from_value) + span * t)
        .round()
        .clamp(0.0, 127.0) as u8
}

/// Step every sweep to `now_seconds`. Returns `(messages, still_running)`.
///
/// Only changed values produce a message: a slow sweep would otherwise repeat
/// the same byte many times a second and flood the port for no visible effect.
/// A sweep whose `t` has reached 1.0 is finished and dropped.
pub fn step_control_curves(
    curves: Vec<PendingControlCurve>,
    now_seconds: f64,
) -> (Vec<ScheduledMidiMessage>, Vec<PendingControlCurve>) {
    let mut messages = Vec::new();
    let mut still_running = Vec::new();

    for mut curve in curves {
        let value = curve_value_at(&curve, now_seconds);
        if value != curve.last_sent_value {
            curve.last_sent_value = value;
            messages.push(ScheduledMidiMessage::ControlChange {
                port: curve.port.clone(),
                channel: curve.channel,
                controller: curve.controller,
                value,
            });
        }

        let finished = curve.duration_seconds <= 0.0
            || now_seconds - curve.start_seconds >= curve.duration_seconds;
        if !finished {
            still_running.push(curve);
        }
    }

    (messages, still_running)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{MidiClip, MidiEvent, Song, Track};

    fn midi_track(id: &str, muted: bool) -> Track {
        midi_track_on(id, muted, 1, None)
    }

    fn midi_track_on(id: &str, muted: bool, channel: u8, port: Option<&str>) -> Track {
        Track {
            id: id.into(),
            name: id.into(),
            kind: TrackKind::Midi,
            parent_track_id: None,
            volume: 1.0,
            pan: 0.0,
            muted,
            solo: false,
            transpose_enabled: true,
            audio_to: "master".into(),
            color: None,
            auto_created: false,
            midi_port: port.map(str::to_string),
            midi_channel: channel,
            midi_enabled: true,
            collapsed: false,
            height_offset: None,
        }
    }

    fn song_with(clips: Vec<MidiClip>, muted: bool) -> Song {
        Song {
            id: "s".into(),
            title: "S".into(),
            artist: None,
            key: None,
            bpm: 120.0,
            time_signature: "4/4".into(),
            duration_seconds: 120.0,
            tempo_markers: vec![],
            time_signature_markers: vec![],
            regions: vec![],
            tracks: vec![midi_track("midi1", muted)],
            clips: vec![],
            midi_clips: clips,
            section_markers: vec![],
        }
    }

    fn note_event(id: &str, at: f64, note: u8, velocity: u8, duration: f64) -> MidiEvent {
        MidiEvent {
            id: id.into(),
            at_seconds: at,
            channel: None,
            kind: MidiEventKind::Note {
                note,
                velocity,
                duration_seconds: duration,
            },
        }
    }

    fn clip(id: &str, start: f64, events: Vec<MidiEvent>) -> MidiClip {
        MidiClip {
            id: id.into(),
            track_id: "midi1".into(),
            timeline_start_seconds: start,
            name: String::new(),
            events,
            color: None,
        }
    }

    #[test]
    fn fires_an_event_once_as_the_window_advances() {
        let song = song_with(
            vec![clip("c", 10.0, vec![note_event("e", 0.0, 60, 100, 1.0)])],
            false,
        );

        assert!(collect_events_in_window(&song, 0.0, 9.0).messages.is_empty());
        assert_eq!(collect_events_in_window(&song, 9.0, 10.5).messages.len(), 1);
        assert!(collect_events_in_window(&song, 10.5, 12.0)
            .messages
            .is_empty());
    }

    #[test]
    fn enabled_midi_events_control_whether_a_runtime_tick_is_needed() {
        let populated = clip("c", 10.0, vec![note_event("e", 0.0, 60, 100, 1.0)]);
        let mut song = song_with(vec![populated], false);
        assert!(has_enabled_midi_events(&song));

        song.tracks[0].midi_enabled = false;
        assert!(!has_enabled_midi_events(&song));

        song.tracks[0].midi_enabled = true;
        song.tracks[0].muted = true;
        assert!(has_enabled_midi_events(&song));

        let empty = song_with(vec![clip("empty", 10.0, vec![])], false);
        assert!(!has_enabled_midi_events(&empty));
    }

    #[test]
    fn an_event_on_a_tick_boundary_fires_exactly_once() {
        // The half-open window's reason for being: `now` of one tick is
        // `previous` of the next, and the event must belong to only one.
        let song = song_with(
            vec![clip("c", 10.0, vec![note_event("e", 0.0, 60, 100, 1.0)])],
            false,
        );

        assert_eq!(collect_events_in_window(&song, 9.0, 10.0).messages.len(), 1);
        assert!(collect_events_in_window(&song, 10.0, 11.0)
            .messages
            .is_empty());
    }

    #[test]
    fn a_window_spanning_several_events_fires_all_of_them() {
        let song = song_with(
            vec![
                clip("c1", 1.0, vec![note_event("e1", 0.0, 60, 100, 0.1)]),
                clip("c2", 2.0, vec![note_event("e2", 0.0, 62, 100, 0.1)]),
                clip("c3", 3.0, vec![note_event("e3", 0.0, 64, 100, 0.1)]),
            ],
            false,
        );
        assert_eq!(collect_events_in_window(&song, 0.0, 5.0).messages.len(), 3);
    }

    #[test]
    fn stacked_notes_at_one_point_all_fire_with_their_own_velocities() {
        let song = song_with(
            vec![clip(
                "c",
                4.0,
                vec![
                    note_event("e1", 0.0, 60, 100, 1.0),
                    note_event("e2", 0.0, 64, 80, 1.0),
                    note_event("e3", 0.0, 67, 60, 1.0),
                ],
            )],
            false,
        );

        let output = collect_events_in_window(&song, 0.0, 5.0);
        assert_eq!(output.messages.len(), 3);
        assert_eq!(output.started_notes.len(), 3);
        let velocities = output
            .messages
            .iter()
            .filter_map(|message| match message {
                ScheduledMidiMessage::NoteOn { velocity, .. } => Some(*velocity),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(velocities, vec![100, 80, 60]);
    }

    #[test]
    fn event_offsets_are_relative_to_the_clip_start() {
        let song = song_with(
            vec![clip("c", 10.0, vec![note_event("e", 2.5, 60, 100, 0.5)])],
            false,
        );
        assert!(collect_events_in_window(&song, 0.0, 11.0)
            .messages
            .is_empty());
        assert_eq!(
            collect_events_in_window(&song, 12.0, 13.0).messages.len(),
            1
        );
    }

    #[test]
    fn a_muted_midi_track_stays_silent() {
        let song = song_with(
            vec![clip("c", 1.0, vec![note_event("e", 0.0, 60, 100, 1.0)])],
            true,
        );
        assert!(collect_events_in_window(&song, 0.0, 5.0).messages.is_empty());
    }

    #[test]
    fn note_offs_come_due_only_after_the_note_duration() {
        let song = song_with(
            vec![clip("c", 1.0, vec![note_event("e", 0.0, 60, 100, 2.0)])],
            false,
        );
        let held = collect_events_in_window(&song, 0.0, 1.5).started_notes;
        assert_eq!(held.len(), 1);

        let (messages, held) = take_due_note_offs(held, 2.0);
        assert!(messages.is_empty(), "note still held at 2.0s");
        assert_eq!(held.len(), 1);

        let (messages, held) = take_due_note_offs(held, 3.1);
        assert_eq!(
            messages,
            vec![ScheduledMidiMessage::NoteOff {
                port: None,
                channel: 1,
                note: 60
            }]
        );
        assert!(held.is_empty());
    }

    #[test]
    fn control_curve_emits_its_start_value_and_registers_a_sweep() {
        let song = song_with(
            vec![clip(
                "c",
                1.0,
                vec![MidiEvent {
                    id: "e".into(),
                    at_seconds: 0.0,
                    channel: Some(2),
                    kind: MidiEventKind::ControlCurve {
                        controller: 74,
                        from_value: 0,
                        to_value: 127,
                        duration_seconds: 4.0,
                    },
                }],
            )],
            false,
        );

        let output = collect_events_in_window(&song, 0.0, 1.5);
        assert_eq!(
            output.messages,
            vec![ScheduledMidiMessage::ControlChange {
                port: None,
                channel: 2,
                controller: 74,
                value: 0
            }]
        );
        assert_eq!(output.started_curves.len(), 1);
    }

    #[test]
    fn a_sweep_interpolates_and_finishes_at_its_target() {
        let curve = PendingControlCurve {
            port: None,
            channel: 1,
            controller: 74,
            from_value: 0,
            to_value: 127,
            start_seconds: 1.0,
            duration_seconds: 4.0,
            last_sent_value: 0,
        };

        assert_eq!(curve_value_at(&curve, 3.0), 64); // halfway
        assert_eq!(curve_value_at(&curve, 5.0), 127); // end
        assert_eq!(curve_value_at(&curve, 99.0), 127); // clamped past the end

        let (messages, running) = step_control_curves(vec![curve], 5.0);
        assert_eq!(messages.len(), 1);
        assert!(running.is_empty(), "finished sweep must be dropped");
    }

    #[test]
    fn a_sweep_does_not_resend_an_unchanged_value() {
        // Two ticks 5ms apart on a 100s sweep round to the same byte.
        let curve = PendingControlCurve {
            port: None,
            channel: 1,
            controller: 74,
            from_value: 0,
            to_value: 127,
            start_seconds: 0.0,
            duration_seconds: 100.0,
            last_sent_value: 0,
        };

        let (first, running) = step_control_curves(vec![curve], 1.0);
        assert_eq!(first.len(), 1);
        let (second, _) = step_control_curves(running, 1.005);
        assert!(second.is_empty(), "unchanged value must not be re-sent");
    }

    #[test]
    fn a_descending_sweep_walks_downward() {
        let curve = PendingControlCurve {
            port: None,
            channel: 1,
            controller: 74,
            from_value: 127,
            to_value: 0,
            start_seconds: 0.0,
            duration_seconds: 10.0,
            last_sent_value: 127,
        };
        assert_eq!(curve_value_at(&curve, 5.0), 64);
        assert_eq!(curve_value_at(&curve, 10.0), 0);
    }

    #[test]
    fn a_zero_length_curve_degenerates_to_one_control_change() {
        let song = song_with(
            vec![clip(
                "c",
                1.0,
                vec![MidiEvent {
                    id: "e".into(),
                    at_seconds: 0.0,
                    channel: None,
                    kind: MidiEventKind::ControlCurve {
                        controller: 74,
                        from_value: 0,
                        to_value: 90,
                        duration_seconds: 0.0,
                    },
                }],
            )],
            false,
        );

        let output = collect_events_in_window(&song, 0.0, 2.0);
        assert_eq!(
            output.messages,
            vec![ScheduledMidiMessage::ControlChange {
                port: None,
                channel: 1,
                controller: 74,
                value: 90
            }]
        );
        assert!(output.started_curves.is_empty());
    }

    #[test]
    fn program_change_carries_its_channel() {
        let song = song_with(
            vec![clip(
                "c",
                1.0,
                vec![MidiEvent {
                    id: "e".into(),
                    at_seconds: 0.0,
                    channel: Some(3),
                    kind: MidiEventKind::ProgramChange { program: 7 },
                }],
            )],
            false,
        );
        assert_eq!(
            collect_events_in_window(&song, 0.0, 2.0).messages,
            vec![ScheduledMidiMessage::ProgramChange {
                port: None,
                channel: 3,
                program: 7
            }]
        );
    }

    #[test]
    fn a_song_with_no_midi_clips_produces_nothing() {
        let song = song_with(vec![], false);
        assert_eq!(
            collect_events_in_window(&song, 0.0, 100.0),
            MidiTickOutput::default()
        );
    }

    // ── channel inheritance and per-track port ────────────────────────────

    /// Song whose single MIDI track sits on `channel` / `port`.
    fn song_on(channel: u8, port: Option<&str>, clips: Vec<MidiClip>) -> Song {
        let mut song = song_with(clips, false);
        song.tracks = vec![midi_track_on("midi1", false, channel, port)];
        song
    }

    fn channel_of(message: &ScheduledMidiMessage) -> u8 {
        match message {
            ScheduledMidiMessage::NoteOn { channel, .. }
            | ScheduledMidiMessage::NoteOff { channel, .. }
            | ScheduledMidiMessage::ControlChange { channel, .. }
            | ScheduledMidiMessage::ProgramChange { channel, .. } => *channel,
        }
    }

    fn port_of(message: &ScheduledMidiMessage) -> Option<String> {
        match message {
            ScheduledMidiMessage::NoteOn { port, .. }
            | ScheduledMidiMessage::NoteOff { port, .. }
            | ScheduledMidiMessage::ControlChange { port, .. }
            | ScheduledMidiMessage::ProgramChange { port, .. } => port.clone(),
        }
    }

    #[test]
    fn an_event_without_a_channel_inherits_the_tracks() {
        let song = song_on(
            7,
            None,
            vec![clip("c", 1.0, vec![note_event("e", 0.0, 60, 100, 1.0)])],
        );
        let fired = collect_events_in_window(&song, 0.0, 2.0).messages;
        assert_eq!(channel_of(&fired[0]), 7);
    }

    #[test]
    fn an_explicit_event_channel_overrides_the_tracks() {
        // "everything on channel 7, but this one message goes to 10".
        let mut clip_with_override = clip("c", 1.0, vec![note_event("e", 0.0, 60, 100, 1.0)]);
        clip_with_override.events[0].channel = Some(10);
        let song = song_on(7, None, vec![clip_with_override]);

        let fired = collect_events_in_window(&song, 0.0, 2.0).messages;
        assert_eq!(channel_of(&fired[0]), 10);
    }

    #[test]
    fn messages_carry_the_tracks_port() {
        let song = song_on(
            3,
            Some("loopMIDI Port 2"),
            vec![clip("c", 1.0, vec![note_event("e", 0.0, 60, 100, 1.0)])],
        );
        let output = collect_events_in_window(&song, 0.0, 2.0);
        assert_eq!(
            port_of(&output.messages[0]),
            Some("loopMIDI Port 2".to_string())
        );
        // The pending note-off must remember the same port, or the note hangs
        // on whichever device actually sounded it.
        assert_eq!(
            output.started_notes[0].port,
            Some("loopMIDI Port 2".to_string())
        );
    }

    #[test]
    fn two_tracks_can_target_different_ports_and_channels() {
        // The whole point of per-track routing: a lighting desk and lyric
        // software driven at once, each on its own cable.
        let mut song = song_with(
            vec![
                clip("lights", 1.0, vec![note_event("e1", 0.0, 60, 100, 1.0)]),
                MidiClip {
                    id: "lyrics".into(),
                    track_id: "midi2".into(),
                    timeline_start_seconds: 1.0,
                    name: String::new(),
                    events: vec![note_event("e2", 0.0, 62, 100, 1.0)],
                    color: None,
                },
            ],
            false,
        );
        song.tracks = vec![
            midi_track_on("midi1", false, 3, Some("Port A")),
            midi_track_on("midi2", false, 1, Some("Port B")),
        ];

        let fired = collect_events_in_window(&song, 0.0, 2.0).messages;
        assert_eq!(fired.len(), 2);
        assert_eq!(port_of(&fired[0]), Some("Port A".to_string()));
        assert_eq!(channel_of(&fired[0]), 3);
        assert_eq!(port_of(&fired[1]), Some("Port B".to_string()));
        assert_eq!(channel_of(&fired[1]), 1);
    }

    #[test]
    fn a_curve_keeps_the_tracks_port_and_channel_while_it_steps() {
        let song = song_on(
            5,
            Some("Port A"),
            vec![clip(
                "c",
                0.0,
                vec![MidiEvent {
                    id: "e".into(),
                    at_seconds: 0.0,
                    channel: None,
                    kind: MidiEventKind::ControlCurve {
                        controller: 74,
                        from_value: 0,
                        to_value: 127,
                        duration_seconds: 4.0,
                    },
                }],
            )],
        );

        let started = collect_events_in_window(&song, -1.0, 0.5).started_curves;
        assert_eq!(started.len(), 1);

        let (messages, _) = step_control_curves(started, 2.0);
        assert_eq!(port_of(&messages[0]), Some("Port A".to_string()));
        assert_eq!(channel_of(&messages[0]), 5);
    }

    #[test]
    fn a_disabled_track_sends_nothing() {
        // The MIDI track's equivalent of mute. Regression guard: the enable
        // flag has to be read from the track, not assumed true.
        let mut song = song_on(
            3,
            None,
            vec![clip("c", 1.0, vec![note_event("e", 0.0, 60, 100, 1.0)])],
        );
        assert_eq!(collect_events_in_window(&song, 0.0, 5.0).messages.len(), 1);

        song.tracks[0].midi_enabled = false;
        assert!(collect_events_in_window(&song, 0.0, 5.0).messages.is_empty());
    }

    #[test]
    fn a_clip_whose_track_is_missing_produces_nothing() {
        // A dangling clip must not fall back to some default channel and fire
        // at an unrelated device.
        let mut song = song_with(
            vec![clip("c", 1.0, vec![note_event("e", 0.0, 60, 100, 1.0)])],
            false,
        );
        song.tracks.clear();
        assert!(collect_events_in_window(&song, 0.0, 5.0).messages.is_empty());
    }
}
