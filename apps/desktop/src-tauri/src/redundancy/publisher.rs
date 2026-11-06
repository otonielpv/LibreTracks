//! The main's publisher (redundancy step 04): forwards every transport intent
//! to the backup, sends the state stamped with the audio clock 20 times a
//! second and after every intent, and the session fingerprint when the backup
//! connects and whenever it changes. Heartbeats go from the link server on
//! their own; this only keeps their health summary current.
//!
//! - Never takes the session lock in its 20 Hz loop: the clock comes from the
//!   engine's lock-free stamp (step 02, `AudioController::audio_clock_sample`
//!   with `try_lock` on the controller), song/vamp/jumps from the session
//!   feed's latest snapshot.
//! - Without a backup connected it does no work at all: no ticks, no feed
//!   subscription.
//!
//! The decisions live in [`PublisherCore`], tested with a fake [`PublisherIo`].

use std::time::{Duration, Instant};

use libretracks_link::redundancy::{
    HealthSummary, PendingJump, RedundancyMessage, TransportClock, VampState,
};
use libretracks_link::HostHandle;
use tauri::{AppHandle, Manager};
use tokio::sync::broadcast;

use crate::models::{SongView, TransportSnapshot};
use crate::session_feed::SessionFeed;
use crate::state::{DesktopState, IntentOrigin, OriginatedIntent};

/// State to the backup this often (and right after every intent).
pub const STATE_INTERVAL: Duration = Duration::from_millis(50);
/// Wait this long after the session or settings change before recomputing
/// the fingerprint (step 03 §4).
pub const FINGERPRINT_DEBOUNCE: Duration = Duration::from_secs(1);

/// What the publisher needs from the outside world.
pub trait PublisherIo {
    fn backup_connected(&self) -> bool;
    fn next_seq(&self) -> u64;
    fn send(&self, message: &RedundancyMessage) -> bool;
    /// The audio clock on the link's monotonic base. None = no reading now.
    fn audio_clock(&self) -> Option<TransportClock>;
    /// Whether the engine runs on its fallback clock (no real output).
    fn fallback_active(&self) -> bool;
    fn set_health(&self, health: HealthSummary);
    /// An `Instant` on the link's monotonic base, in ns.
    fn monotonic_ns_of(&self, at: Instant) -> u64;
}

/// What the latest session-feed frame says about the transport.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct FeedView {
    pub song_id: Option<String>,
    pub vamp: Option<VampState>,
    pub pending_jumps: Vec<PendingJump>,
}

impl FeedView {
    pub fn from_snapshot(snapshot: &TransportSnapshot, song: Option<&SongView>) -> Self {
        let position = snapshot.position_seconds;
        let song_id = song.and_then(|song| {
            song.regions
                .iter()
                .find(|region| position >= region.start_seconds && position < region.end_seconds)
                .map(|region| region.id.clone())
        });
        Self {
            song_id,
            vamp: Some(VampState {
                enabled: snapshot.active_vamp.is_some(),
                mode: None,
                bars: None,
            }),
            pending_jumps: snapshot
                .pending_marker_jump
                .iter()
                .map(|jump| PendingJump::Marker {
                    marker_id: jump.target_marker_id.clone(),
                    execute_at_seconds: Some(jump.execute_at_seconds),
                })
                .collect(),
        }
    }
}

#[derive(Debug, Default)]
pub struct PublisherCore {
    feed: FeedView,
    last_fingerprint: Option<String>,
}

impl PublisherCore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_feed(&mut self, feed: FeedView) {
        self.feed = feed;
    }

    /// A transport change at the session. Followers' changes never go back.
    /// Returns whether anything was sent.
    pub fn on_intent(&mut self, io: &impl PublisherIo, intent: &OriginatedIntent) -> bool {
        if intent.origin == IntentOrigin::Follower || !io.backup_connected() {
            return false;
        }
        let message = RedundancyMessage::Intent {
            seq: io.next_seq(),
            intent: intent.intent.clone(),
            monotonic_ns: io.monotonic_ns_of(intent.at),
        };
        let sent = io.send(&message);
        self.send_state(io);
        sent
    }

    /// One 20 Hz tick. Without a backup: nothing, not even a clock read.
    pub fn on_tick(&mut self, io: &impl PublisherIo) -> bool {
        if !io.backup_connected() {
            return false;
        }
        let fallback = io.fallback_active();
        io.set_health(HealthSummary {
            audio_ok: !fallback,
            fallback_active: fallback,
            pilot_tone_on: false,
        });
        self.send_state(io)
    }

    fn send_state(&mut self, io: &impl PublisherIo) -> bool {
        let Some(clock) = io.audio_clock() else {
            return false;
        };
        io.send(&RedundancyMessage::State {
            seq: io.next_seq(),
            clock,
            song_id: self.feed.song_id.clone(),
            vamp: self.feed.vamp.clone(),
            pending_jumps: self.feed.pending_jumps.clone(),
        })
    }

    /// A (re)connected backup gets the fingerprint at once, even unchanged.
    pub fn on_backup_connected(&mut self, io: &impl PublisherIo, fingerprint: Option<String>) {
        self.last_fingerprint = None;
        if let Some(fingerprint) = fingerprint {
            self.on_fingerprint(io, fingerprint);
        }
    }

    /// Sends the fingerprint when it differs from the last one sent.
    pub fn on_fingerprint(&mut self, io: &impl PublisherIo, fingerprint: String) -> bool {
        if self.last_fingerprint.as_deref() == Some(fingerprint.as_str()) || !io.backup_connected()
        {
            return false;
        }
        let sent = io.send(&RedundancyMessage::Fingerprint {
            version: libretracks_core::session_fingerprint::FINGERPRINT_VERSION,
            fingerprint: fingerprint.clone(),
        });
        if sent {
            self.last_fingerprint = Some(fingerprint);
        }
        sent
    }
}

/// The real IO: the link server and the audio controller.
pub struct LiveIo {
    pub handle: HostHandle,
    pub app: AppHandle,
}

impl PublisherIo for LiveIo {
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
        let state = self.app.state::<DesktopState>();
        let reading = state.audio.audio_clock_reading()?;
        let now_ns = self.monotonic_ns_of(Instant::now());
        let sample = libretracks_core::audio_clock::AudioClockSample::from_engine(
            reading.frame,
            reading.sample_rate,
            reading.callback_age_ns,
            now_ns,
            reading.moving,
            reading.output_latency_samples,
        )?;
        Some(TransportClock {
            playing: sample.playing,
            position_seconds: sample.position_seconds,
            callback_monotonic_ns: sample.sampled_at_ns,
            output_latency_seconds: sample.output_latency_seconds,
            sample_rate: reading.sample_rate,
        })
    }

    fn fallback_active(&self) -> bool {
        self.app
            .state::<DesktopState>()
            .audio
            .audio_clock_reading()
            .is_some_and(|reading| reading.fallback_active)
    }

    fn set_health(&self, health: HealthSummary) {
        self.handle.set_health(health);
    }

    fn monotonic_ns_of(&self, at: Instant) -> u64 {
        at.saturating_duration_since(self.handle.clock_origin())
            .as_nanos() as u64
    }
}

/// The fingerprint as one string for the wire (its JSON; the backup parses
/// it to explain differences).
pub fn current_fingerprint(app: &AppHandle) -> Option<String> {
    let state = app.state::<DesktopState>();
    let fingerprint = super::fingerprint::current(&state).ok()??;
    serde_json::to_string(&fingerprint).ok()
}

/// Runs until aborted. Idle (no ticks, no feed) while no backup is connected.
pub async fn run(
    app: AppHandle,
    handle: HostHandle,
    mut intents: broadcast::Receiver<OriginatedIntent>,
) {
    let io = LiveIo {
        handle: handle.clone(),
        app: app.clone(),
    };
    let mut core = PublisherCore::new();
    let mut backup = handle.subscribe_backup();
    loop {
        // Idle: wait for a backup, draining intents so they do not pile up.
        while backup.borrow_and_update().is_none() {
            tokio::select! {
                changed = backup.changed() => if changed.is_err() { return },
                received = intents.recv() => if let Err(broadcast::error::RecvError::Closed) = received { return },
            }
        }
        core.on_backup_connected(&io, current_fingerprint(&app));
        let mut feed = app.state::<SessionFeed>().subscribe();
        let mut tick = tokio::time::interval(STATE_INTERVAL);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut fingerprint_due: Option<tokio::time::Instant> = None;
        let mut last_revisions: Option<(u64, u64, u64)> = None;
        loop {
            tokio::select! {
                changed = backup.changed() => {
                    if changed.is_err() { return }
                    if backup.borrow_and_update().is_none() { break }
                    // Another backup replaced the old one.
                    core.on_backup_connected(&io, current_fingerprint(&app));
                }
                received = intents.recv() => match received {
                    Ok(intent) => { core.on_intent(&io, &intent); }
                    Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => return,
                },
                _ = tick.tick() => {
                    core.on_tick(&io);
                    if fingerprint_due.is_some_and(|due| tokio::time::Instant::now() >= due) {
                        fingerprint_due = None;
                        if let Some(fingerprint) = current_fingerprint(&app) {
                            core.on_fingerprint(&io, fingerprint);
                        }
                    }
                }
                changed = feed.changed() => {
                    if changed.is_err() { continue }
                    let frame = feed.borrow_and_update().clone();
                    if let Some(snapshot) = frame.snapshot.as_deref() {
                        let song = frame.song.as_deref().and_then(Option::as_ref);
                        core.set_feed(FeedView::from_snapshot(snapshot, song));
                        let revisions = (
                            snapshot.project_revision,
                            snapshot.mix_revision,
                            frame.settings_seq,
                        );
                        if last_revisions.is_some_and(|last| last != revisions) {
                            fingerprint_due =
                                Some(tokio::time::Instant::now() + FINGERPRINT_DEBOUNCE);
                        }
                        last_revisions = Some(revisions);
                    }
                }
            }
        }
    }
}

/// Spawned publisher, aborted on drop.
pub struct PublisherTask(tauri::async_runtime::JoinHandle<()>);

impl Drop for PublisherTask {
    fn drop(&mut self) {
        self.0.abort();
    }
}

pub fn spawn(app: &AppHandle, handle: HostHandle) -> Option<PublisherTask> {
    let intents = app
        .state::<DesktopState>()
        .session
        .lock()
        .ok()?
        .subscribe_intents();
    Some(PublisherTask(tauri::async_runtime::spawn(run(
        app.clone(),
        handle,
        intents,
    ))))
}

#[cfg(test)]
#[path = "publisher_tests.rs"]
mod tests;
