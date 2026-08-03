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
/// `channel` is 1-16 as the user sees it; the 0-based wire nibble is produced
/// at send time by the output layer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScheduledMidiMessage {
    NoteOn {
        channel: u8,
        note: u8,
        velocity: u8,
    },
    NoteOff {
        channel: u8,
        note: u8,
    },
    ControlChange {
        channel: u8,
        controller: u8,
        value: u8,
    },
    ProgramChange {
        channel: u8,
        program: u8,
    },
}

/// A note sounding on the output, awaiting its note-off.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PendingNoteOff {
    pub channel: u8,
    pub note: u8,
    /// Timeline position (source seconds) at which the note-off is due.
    pub off_at_seconds: f64,
}

/// An in-progress controller sweep started by a `ControlCurve` event.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PendingControlCurve {
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
        let muted = song.tracks.iter().any(|track| {
            track.id == clip.track_id && track.kind == TrackKind::Midi && track.muted
        });
        if muted {
            continue;
        }

        for event in &clip.events {
            let event_seconds = clip.timeline_start_seconds + event.at_seconds.max(0.0);
            if event_seconds <= previous_seconds || event_seconds > now_seconds {
                continue;
            }

            match event.kind {
                MidiEventKind::Note {
                    note,
                    velocity,
                    duration_seconds,
                } => {
                    output.messages.push(ScheduledMidiMessage::NoteOn {
                        channel: event.channel,
                        note,
                        velocity,
                    });
                    output.started_notes.push(PendingNoteOff {
                        channel: event.channel,
                        note,
                        off_at_seconds: event_seconds + duration_seconds.max(0.0),
                    });
                }
                MidiEventKind::ControlChange { controller, value } => {
                    output.messages.push(ScheduledMidiMessage::ControlChange {
                        channel: event.channel,
                        controller,
                        value,
                    });
                }
                MidiEventKind::ProgramChange { program } => {
                    output.messages.push(ScheduledMidiMessage::ProgramChange {
                        channel: event.channel,
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
                            channel: event.channel,
                            controller,
                            value: to_value,
                        });
                        continue;
                    }
                    output.messages.push(ScheduledMidiMessage::ControlChange {
                        channel: event.channel,
                        controller,
                        value: from_value,
                    });
                    output.started_curves.push(PendingControlCurve {
                        channel: event.channel,
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
            channel: 1,
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
                    channel: 2,
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
                    channel: 1,
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
                    channel: 3,
                    kind: MidiEventKind::ProgramChange { program: 7 },
                }],
            )],
            false,
        );
        assert_eq!(
            collect_events_in_window(&song, 0.0, 2.0).messages,
            vec![ScheduledMidiMessage::ProgramChange {
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
}
