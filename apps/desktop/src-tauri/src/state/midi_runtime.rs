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
use libretracks_core::lead_plan::LeadItem;
use libretracks_core::lead_time::LeadGrid;
use libretracks_core::midi_schedule::{
    collect_events_in_window, collect_events_in_window_from, has_enabled_midi_events,
    step_control_curves, take_due_note_offs, PendingControlCurve, PendingNoteOff,
    ScheduledMidiMessage,
};
use libretracks_core::MidiClip;

use crate::infra::error::DesktopError;
use crate::midi::output::{MidiOutputManager, OutboundMidiMessage};

use super::lead_runtime::{midi_lead_items, song_has_midi_leads};
use super::DesktopSession;

/// A tick longer than this is treated as a discontinuity rather than playback:
/// firing every event in between would dump a burst of messages at a lighting
/// desk. Jumps and seeks reset the cursor explicitly, so this only guards
/// against a stalled tick (a hitched frame, a machine coming back from sleep).
const MAX_CONTINUOUS_TICK_SECONDS: f64 = 1.0;

/// How far behind a landing point the MIDI cursor is put back, so the
/// half-open tick window includes the events placed exactly on it.
const MIDI_LANDING_EPSILON_SECONDS: f64 = 0.001;

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
    pub(super) fn midi_runtime_should_tick(&self) -> bool {
        if self.engine.playback_state() != PlaybackState::Playing {
            return false;
        }
        if !self.active_midi_notes.is_empty() || !self.active_midi_curves.is_empty() {
            return true;
        }
        self.engine.song().is_some_and(has_enabled_midi_events)
    }

    /// The output port handle, if one is wired. Returned as an owned `Arc` so
    /// callers can send while still holding `&mut self`.
    fn midi_output_handle(&self) -> Option<Arc<MidiOutputManager>> {
        self.midi_output.clone()
    }

    /// Reset the MIDI cursor to `position_seconds` without firing anything, and
    /// silence whatever is currently sounding. Called on seek, jump, stop and
    /// pause — any time the playhead moves discontinuously.
    pub(super) fn reset_midi_cursor(&mut self, position_seconds: f64) {
        self.reset_midi_cursor_keeping_leads(position_seconds);
        self.midi_lead_planner.reset();
    }

    /// [`Self::reset_midi_cursor`] without forgetting what the lead planner
    /// pre-fired for a pending jump, for paths where a landing may still
    /// follow (a stalled tick).
    fn reset_midi_cursor_keeping_leads(&mut self, position_seconds: f64) {
        self.midi_cursor_seconds = position_seconds.max(0.0);
        self.release_all_midi_notes();
        self.active_midi_curves.clear();
    }

    /// Re-anchor MIDI where the playhead just landed (a jump, a vamp wrap, a
    /// seek, Play) so the events sitting exactly on that point still go out:
    /// the tick window is `(cursor, now]`, and a cursor left ON the landing
    /// point would skip the lyrics change placed on the chorus marker.
    ///
    /// Clips with a lead (plan lead-time): one pre-fired before the jump is
    /// not sent again, and one whose lead window contains the landing goes out
    /// now. Notes a pre-fired clip started are released here like any other
    /// (the landing cuts them); its events still ahead play from the landing.
    pub(super) fn land_midi_cursor(&mut self, landing_seconds: f64) {
        let fired_until = self.midi_cursor_seconds;
        self.reset_midi_cursor_keeping_leads(landing_seconds);
        self.midi_cursor_seconds = landing_seconds.max(0.0) - MIDI_LANDING_EPSILON_SECONDS;
        match self.engine.song().filter(|song| song_has_midi_leads(song)) {
            Some(song) => {
                let grid = LeadGrid::new(song);
                self.midi_lead_planner.on_landing(
                    &grid,
                    midi_lead_items(song),
                    landing_seconds.max(0.0),
                    self.midi_cursor_seconds,
                    fired_until,
                );
            }
            None => self.midi_lead_planner.reset(),
        }
        // Lyrics land at the same points (plan lyrics-sync, D16).
        self.land_lyrics(landing_seconds);
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
            // Keep the lead planner: a jump's landing usually follows, and it
            // needs to know what went out before it.
            self.reset_midi_cursor_keeping_leads(now_seconds);
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

        let tick = if song_has_midi_leads(&song) {
            // Clips with a lead start where the planner says, given the jump
            // that is pending right now (plan lead-time).
            let grid = LeadGrid::new(&song);
            let pending = self.pending_lead_discontinuity(&song);
            self.midi_lead_planner.sync_pending(
                &grid,
                midi_lead_items(&song),
                pending,
                previous_seconds,
            );
            let planner = &self.midi_lead_planner;
            collect_events_in_window_from(&song, previous_seconds, now_seconds, |clip| {
                planner.starts(
                    &grid,
                    LeadItem {
                        id: &clip.id,
                        anchor: clip.timeline_start_seconds,
                        lead: clip.lead.as_ref(),
                    },
                )
            })
        } else {
            if !self.midi_lead_planner.is_idle() {
                self.midi_lead_planner.reset();
            }
            collect_events_in_window(&song, previous_seconds, now_seconds)
        };
        if self.timeline_midi_suppressed() {
            // Backup following its main: the main sends. The cursor and the
            // lead planner still advance, so taking over later carries on
            // from here instead of bursting everything held back. Only the
            // note-offs above go out (they release notes this device sent
            // before it started following).
            self.active_midi_curves.clear();
        } else {
            scheduled.extend(tick.messages);
            self.active_midi_notes.extend(tick.started_notes);
            self.active_midi_curves.extend(tick.started_curves);

            let curves = std::mem::take(&mut self.active_midi_curves);
            let (curve_messages, still_running) = step_control_curves(curves, now_seconds);
            self.active_midi_curves = still_running;
            scheduled.extend(curve_messages);
        }

        dispatch(&output, scheduled);

        self.midi_cursor_seconds = now_seconds;
        Ok(())
    }
}

/// Re-exported so `state/mod.rs` can type its session fields without importing
/// the core scheduling module directly.
pub(super) type ActiveMidiNote = PendingNoteOff;
pub(super) type ActiveMidiCurve = PendingControlCurve;
