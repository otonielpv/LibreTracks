//! Lyrics sync glue on the MIDI thread (plan lyrics-sync, D17): the 10 ms
//! tick collects the schedule's events and pushes them to the worker's
//! channel. **Nothing else**: no network, no await, no blocking lock, no I/O.
//! The decisions live in `libretracks_core::lyrics_schedule` and
//! `libretracks_lyrics` (tested in CI); this only reads state.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use libretracks_audio::PlaybackState;
use libretracks_core::lead_plan::LeadPlanner;
use libretracks_core::lead_time::{LeadGrid, LeadTime};
use libretracks_core::lyrics_schedule::{
    collect_lyrics_events, land_lyrics, lyrics_items, LyricsScheduleState,
};
use libretracks_lyrics::gate::{role_from_transport, should_send_lyrics};
use libretracks_lyrics::worker::WorkerInput;
use tokio::sync::mpsc::UnboundedSender;

use super::DesktopSession;

/// Same guard as the MIDI walk: a longer tick is a discontinuity.
const MAX_CONTINUOUS_TICK_SECONDS: f64 = 1.0;
const LANDING_EPSILON_SECONDS: f64 = 0.001;

/// What the session keeps for the lyrics sync.
pub(crate) struct LyricsRuntime {
    /// The worker's inbox; `None` while lyrics are off.
    pub(crate) sender: Option<UnboundedSender<WorkerInput>>,
    pub(crate) lead: LeadTime,
    pub(crate) paused: bool,
    cursor: f64,
    planner: LeadPlanner,
    schedule: LyricsScheduleState,
    /// Written by the worker; read here with `try_lock` only.
    pub(crate) slide_counts: Arc<Mutex<HashMap<String, u32>>>,
    counts_cache: HashMap<String, u32>,
}

impl Default for LyricsRuntime {
    fn default() -> Self {
        Self {
            sender: None,
            lead: LeadTime::Beats { count: 1.0 },
            paused: false,
            cursor: 0.0,
            planner: LeadPlanner::new(),
            schedule: LyricsScheduleState::default(),
            slide_counts: Arc::default(),
            counts_cache: HashMap::new(),
        }
    }
}

impl LyricsRuntime {
    pub(crate) fn enabled(&self) -> bool {
        self.sender.is_some()
    }

    fn push(&self, input: WorkerInput) {
        if let Some(sender) = &self.sender {
            // Unbounded: never blocks; a closed worker just drops it.
            let _ = sender.send(input);
        }
    }

    pub(crate) fn reset(&mut self) {
        self.planner.reset();
        self.schedule.reset();
    }
}

impl DesktopSession {
    fn lyrics_may_send(&self) -> bool {
        should_send_lyrics(
            role_from_transport(self.timeline_midi_suppressed(), false),
            self.lyrics.enabled(),
            self.lyrics.paused,
        )
    }

    /// The MIDI thread must keep ticking while lyrics are on and playing.
    pub(super) fn lyrics_should_tick(&self) -> bool {
        self.lyrics.enabled() && self.engine.playback_state() == PlaybackState::Playing
    }

    /// Tell the worker the session changed (load, edit): stale plans resolve
    /// again in the background.
    pub(super) fn lyrics_song_changed(&self) {
        if !self.lyrics.enabled() {
            return;
        }
        if let Some(song) = self.engine.song() {
            self.lyrics.push(WorkerInput::Song(Arc::new(song.clone())));
        }
    }

    fn refresh_slide_counts(&mut self) {
        // Never wait: if the worker holds it, use last tick's copy.
        if let Ok(counts) = self.lyrics.slide_counts.try_lock() {
            if *counts != self.lyrics.counts_cache {
                self.lyrics.counts_cache = counts.clone();
            }
        }
    }

    /// One tick of the lyrics walk, on the MIDI thread. Pushes events only.
    pub(super) fn advance_lyrics(&mut self) {
        if !self.lyrics_should_tick() {
            return;
        }
        let now = self.current_position();
        let previous = self.lyrics.cursor;
        if now < previous {
            return;
        }
        if now - previous > MAX_CONTINUOUS_TICK_SECONDS {
            // A discontinuity; the landing that follows re-anchors.
            self.lyrics.cursor = now;
            return;
        }
        self.refresh_slide_counts();
        let Some(song) = self.engine.song() else {
            return;
        };
        let grid = LeadGrid::new(song);
        let items = lyrics_items(song, &grid, &self.lyrics.lead, Some(&self.lyrics.counts_cache));
        if items.is_empty() {
            self.lyrics.cursor = now;
            return;
        }
        let pending = self.pending_lead_discontinuity(song);
        let lyrics = &mut self.lyrics;
        lyrics.planner.sync_pending(
            &grid,
            items.iter().map(|item| item.lead_item()),
            pending,
            previous,
        );
        let events =
            collect_lyrics_events(&items, &grid, &lyrics.planner, previous, now, &mut lyrics.schedule);
        lyrics.cursor = now;
        if events.is_empty() || !self.lyrics_may_send() {
            return;
        }
        for event in events {
            self.lyrics.push(WorkerInput::Event(event));
        }
    }

    /// The playhead landed (Play, seek, jump, vamp wrap): re-anchor and send
    /// what should be on screen now (D16). Called with `land_midi_cursor`.
    pub(super) fn land_lyrics(&mut self, landing_seconds: f64) {
        if !self.lyrics.enabled() {
            return;
        }
        let landing = landing_seconds.max(0.0);
        let fired_until = self.lyrics.cursor;
        self.lyrics.cursor = landing - LANDING_EPSILON_SECONDS;
        self.refresh_slide_counts();
        let Some(song) = self.engine.song() else {
            return;
        };
        let grid = LeadGrid::new(song);
        let items = lyrics_items(song, &grid, &self.lyrics.lead, Some(&self.lyrics.counts_cache));
        let cursor = self.lyrics.cursor;
        self.lyrics.planner.on_landing(
            &grid,
            items.iter().map(|item| item.lead_item()),
            landing,
            cursor,
            fired_until,
        );
        if self.engine.playback_state() != PlaybackState::Playing || !self.lyrics_may_send() {
            return;
        }
        match land_lyrics(song, &items, landing) {
            Some(event) => {
                self.lyrics.schedule.note(&event);
                self.lyrics.push(WorkerInput::Event(event));
            }
            None => self.lyrics.push(WorkerInput::Outside),
        }
    }

    /// The transport stopped: the worker clears if the user asked to.
    pub(super) fn lyrics_stopped(&mut self) {
        self.lyrics.reset();
        self.lyrics.cursor = self.engine.position_seconds().max(0.0);
        if self.lyrics_may_send() {
            self.lyrics.push(WorkerInput::Stopped);
        }
    }

    /// Re-send what should be showing (resuming after "Pause sending", or a
    /// backup taking over).
    pub(crate) fn lyrics_take_over(&mut self) {
        let position = self.current_position();
        self.land_lyrics(position);
    }

    /// The transport position in source seconds (the clock the MIDI thread
    /// uses), for the slide-change recorder.
    pub(crate) fn lyrics_tap_position(&self) -> f64 {
        self.current_position()
    }

    pub(crate) fn lyrics_push(&self, input: WorkerInput) {
        self.lyrics.push(input);
    }
}
