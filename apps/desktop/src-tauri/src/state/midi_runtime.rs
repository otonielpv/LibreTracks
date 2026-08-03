//! Playback of the timeline's MIDI tracks: a cursor that walks the song's
//! `midi_clips` as the playhead advances and pushes messages to the open
//! output port.
//!
//! Split out of `state/mod.rs` as a sibling `impl DesktopSession` block, the
//! same shape as `state/automation_runtime.rs`.
//!
//! The *decisions* (which events fall in this tick, how a sweep interpolates)
//! live in `libretracks_core::midi_schedule`, which is unit-tested; this module
//! is the stateful shell around them — cursor, sounding notes, device handle.
//! That split exists because the desktop crate links the native engine and so
//! its tests do not run in CI.
//!
//! Timing note: this runs on a dedicated 10 ms transport worker, not on the
//! audio thread. That keeps cue latency low without putting device I/O in the
//! real-time audio callback.

use std::sync::Arc;

use libretracks_audio::PlaybackState;
use libretracks_core::midi_schedule::{
    collect_events_in_window, step_control_curves, take_due_note_offs, PendingControlCurve,
    PendingNoteOff, ScheduledMidiMessage,
};
use libretracks_core::MidiClip;

use crate::infra::error::DesktopError;
use crate::midi::output::{MidiOutputManager, OutboundMidiMessage};

use super::DesktopSession;

/// A tick longer than this is treated as a discontinuity rather than playback:
/// firing every event in between would dump a burst of messages at a lighting
/// desk. Jumps and seeks reset the cursor explicitly, so this only guards
/// against a stalled tick (a hitched frame, a machine coming back from sleep).
const MAX_CONTINUOUS_TICK_SECONDS: f64 = 1.0;

/// Translate a scheduling decision into the wire-level message plus the port
/// it must leave by (`None` = the app-wide output).
fn to_outbound(message: ScheduledMidiMessage) -> (Option<String>, OutboundMidiMessage) {
    match message {
        ScheduledMidiMessage::NoteOn {
            port,
            channel,
            note,
            velocity,
        } => (port, OutboundMidiMessage::note_on(channel, note, velocity)),
        ScheduledMidiMessage::NoteOff {
            port,
            channel,
            note,
        } => (port, OutboundMidiMessage::note_off(channel, note)),
        ScheduledMidiMessage::ControlChange {
            port,
            channel,
            controller,
            value,
        } => (
            port,
            OutboundMidiMessage::control_change(channel, controller, value),
        ),
        ScheduledMidiMessage::ProgramChange {
            port,
            channel,
            program,
        } => (port, OutboundMidiMessage::program_change(channel, program)),
    }
}

/// Group messages by port and hand each group to its output, so a tick costs
/// one send per port rather than one per message.
fn dispatch(output: &MidiOutputManager, messages: Vec<ScheduledMidiMessage>) {
    if messages.is_empty() {
        return;
    }
    let mut by_port: Vec<(Option<String>, Vec<OutboundMidiMessage>)> = Vec::new();
    for message in messages {
        let (port, outbound) = to_outbound(message);
        match by_port.iter_mut().find(|(existing, _)| *existing == port) {
            Some((_, group)) => group.push(outbound),
            None => by_port.push((port, vec![outbound])),
        }
    }
    for (port, group) in by_port {
        output.send_to(port.as_deref(), &group);
    }
}

impl DesktopSession {
    /// The output port handle, if one is wired. Returned as an owned `Arc` so
    /// callers can send while still holding `&mut self`.
    fn midi_output_handle(&self) -> Option<Arc<MidiOutputManager>> {
        self.midi_output.clone()
    }

    /// Reset the MIDI cursor to `position_seconds` without firing anything, and
    /// silence whatever is currently sounding. Called on seek, jump, stop and
    /// pause — any time the playhead moves discontinuously.
    pub(super) fn reset_midi_cursor(&mut self, position_seconds: f64) {
        self.midi_cursor_seconds = position_seconds.max(0.0);
        self.release_all_midi_notes();
        self.active_midi_curves.clear();
    }

    /// Send note-offs for every sounding note and forget them.
    pub(super) fn release_all_midi_notes(&mut self) {
        if self.active_midi_notes.is_empty() {
            return;
        }
        let messages = self
            .active_midi_notes
            .drain(..)
            .map(|note: PendingNoteOff| ScheduledMidiMessage::NoteOff {
                port: note.port,
                channel: note.channel,
                note: note.note,
            })
            .collect::<Vec<_>>();
        if let Some(output) = self.midi_output_handle() {
            dispatch(&output, messages);
        }
    }

    /// Silence the output port entirely (All Sound Off + All Notes Off on every
    /// channel) and drop tracked state. Stronger than `release_all_midi_notes`
    /// — used on stop, where notes started before a reload may still ring.
    pub(super) fn panic_midi(&mut self) {
        self.active_midi_notes.clear();
        self.active_midi_curves.clear();
        if let Some(output) = self.midi_output_handle() {
            // Covers every open port, not just the app-wide one.
            output.panic();
        }
    }

    /// Fire a MIDI clip's whole bundle right now, for the editor's "test"
    /// button, so the user can verify the cabling without playing the song.
    ///
    /// This is a PREVIEW, not playback: every message goes out at once and the
    /// notes are released immediately afterwards. Honouring each note's
    /// duration and stepping the controller sweeps would need the transport's
    /// clock, and the point here is instant confirmation that something
    /// arrives — a sweep still sends its start and end so the receiving device
    /// visibly reacts.
    pub fn preview_midi_clip(&mut self, clip: MidiClip) -> Result<(), DesktopError> {
        let Some(output) = self.midi_output_handle() else {
            return Ok(());
        };
        let song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;

        // Reuse the scheduler rather than re-deriving channels and ports here,
        // so a preview can never disagree with what playback would emit. The
        // scheduler walks EVERY clip in the song, so hand it a copy holding
        // only this one — otherwise a neighbouring clip inside the same time
        // window would fire too.
        let start = clip.timeline_start_seconds;
        let end = clip.end_seconds();
        let mut isolated = song.clone();
        isolated.midi_clips = vec![clip];
        let tick = collect_events_in_window(&isolated, start - 1.0, end.max(start) + 1.0);

        let mut scheduled = tick.messages;
        // Land the sweeps on their target instead of leaving them mid-fade.
        let (curve_tail, _) = step_control_curves(tick.started_curves, f64::MAX);
        scheduled.extend(curve_tail);
        // Release every note the preview just started.
        let (note_offs, _) = take_due_note_offs(tick.started_notes, f64::MAX);
        scheduled.extend(note_offs);

        dispatch(&output, scheduled);
        Ok(())
    }

    /// Advance the MIDI cursor to the playhead, emitting everything crossed.
    ///
    /// Called by the dedicated MIDI worker and by `sync_position`. Cheap when
    /// there is nothing to do: returns immediately if no port is open.
    pub(super) fn advance_midi_playback(&mut self) -> Result<(), DesktopError> {
        let Some(output) = self.midi_output_handle() else {
            return Ok(());
        };
        if self.engine.playback_state() != PlaybackState::Playing {
            return Ok(());
        }
        let Some(song) = self.engine.song() else {
            return Ok(());
        };
        // Gate on there being MIDI to send, NOT on a port being open: tracks
        // that name their own port have it opened lazily by `send_to`, so a
        // song using only per-track ports must still reach the walk below.
        if song.midi_clips.is_empty()
            && self.active_midi_notes.is_empty()
            && self.active_midi_curves.is_empty()
        {
            return Ok(());
        }

        // The core engine position is synchronized by the much slower UI
        // snapshot path. The transport clock advances continuously between
        // snapshots and is therefore the right clock for this 10 ms worker.
        let now_seconds = self.current_position();
        let previous_seconds = self.midi_cursor_seconds;

        // A native-clock correction can move the transport clock a few ms
        // behind the MIDI cursor. Keep the cursor where it is until the clock
        // catches up; moving it backwards would fire that tiny window twice.
        if now_seconds < previous_seconds {
            return Ok(());
        }

        // A wildly-forward movement is a discontinuity: re-anchor without
        // firing, so a stalled tick can't machine-gun the receiving device.
        if now_seconds - previous_seconds > MAX_CONTINUOUS_TICK_SECONDS {
            self.reset_midi_cursor(now_seconds);
            return Ok(());
        }

        let song = song.clone();
        let mut scheduled: Vec<ScheduledMidiMessage> = Vec::new();

        // Note-offs first: a note ending exactly where another starts should
        // release before the new one sounds.
        let held = std::mem::take(&mut self.active_midi_notes);
        let (note_offs, still_held) = take_due_note_offs(held, now_seconds);
        self.active_midi_notes = still_held;
        scheduled.extend(note_offs);

        let tick = collect_events_in_window(&song, previous_seconds, now_seconds);
        scheduled.extend(tick.messages);
        self.active_midi_notes.extend(tick.started_notes);
        self.active_midi_curves.extend(tick.started_curves);

        let curves = std::mem::take(&mut self.active_midi_curves);
        let (curve_messages, still_running) = step_control_curves(curves, now_seconds);
        self.active_midi_curves = still_running;
        scheduled.extend(curve_messages);

        dispatch(&output, scheduled);

        self.midi_cursor_seconds = now_seconds;
        Ok(())
    }
}

/// Re-exported so `state/mod.rs` can type its session fields without importing
/// the core scheduling module directly.
pub(super) type ActiveMidiNote = PendingNoteOff;
pub(super) type ActiveMidiCurve = PendingControlCurve;
