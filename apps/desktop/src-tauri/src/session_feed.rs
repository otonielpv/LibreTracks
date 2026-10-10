//! One reader of the session for everything that mirrors it over the network.
//!
//! The remote (desktop) and the network sessions (`libretracks-link`, every
//! platform) both need the same three things: app settings, the transport
//! snapshot and the song view without waveform peaks. Reading them takes the
//! session lock, so they are read in ONE place, every 90 ms, and published on
//! a `watch` channel that any number of consumers can follow. Two pollers
//! would take the lock twice as often.
//!
//! The feed is lazy: with no subscriber it never takes the lock. On desktop
//! the remote subscribes at startup (so the cost is what the remote's own
//! poller had before), and on mobile nobody does until the user hosts a
//! network session.
//!
//! What gets published, and when, is the same rule the remote's poller used:
//! - settings when their JSON changes;
//! - the snapshot when its JSON changes;
//! - the song view only when `(project_revision, mix_revision)` moved, and then
//!   only if its JSON changed. `mix_revision` is in there because an
//!   automation cue changes mute/solo/volume without an edit.

use std::{sync::Arc, time::Duration};

use serde::Serialize;
use tauri::{App, AppHandle, Manager};
use tokio::sync::watch;

use crate::{
    infra::settings::{AppSettings, AppSettingsStore},
    models::{SongView, TransportSnapshot},
    state::DesktopState,
};

pub const FEED_INTERVAL: Duration = Duration::from_millis(90);

/// Latest value of each part plus a counter that moves when that part
/// changes, so a subscriber can tell which of the three to republish.
#[derive(Debug)]
pub struct FeedFrame<A, S, V> {
    pub settings: Option<Arc<A>>,
    pub settings_seq: u64,
    pub snapshot: Option<Arc<S>>,
    pub snapshot_seq: u64,
    pub song: Option<Arc<V>>,
    pub song_seq: u64,
}

impl<A, S, V> Default for FeedFrame<A, S, V> {
    fn default() -> Self {
        Self {
            settings: None,
            settings_seq: 0,
            snapshot: None,
            snapshot_seq: 0,
            song: None,
            song_seq: 0,
        }
    }
}

impl<A, S, V> Clone for FeedFrame<A, S, V> {
    fn clone(&self) -> Self {
        Self {
            settings: self.settings.clone(),
            settings_seq: self.settings_seq,
            snapshot: self.snapshot.clone(),
            snapshot_seq: self.snapshot_seq,
            song: self.song.clone(),
            song_seq: self.song_seq,
        }
    }
}

/// What one read of the session (under its lock) returns.
pub struct SessionRead<S, V> {
    pub snapshot: S,
    pub revision: (u64, u64),
    /// `Some` only when the read was asked for the song view (the revision
    /// moved since the last one).
    pub song: Option<V>,
}

/// The publish rules, without Tauri, locks or timers, so they are tested.
pub struct FeedTracker<A, S, V> {
    frame: FeedFrame<A, S, V>,
    last_settings_json: String,
    last_snapshot_json: String,
    last_revision: Option<(u64, u64)>,
    last_song_json: String,
}

impl<A: Serialize, S: Serialize, V: Serialize> Default for FeedTracker<A, S, V> {
    fn default() -> Self {
        Self {
            frame: FeedFrame::default(),
            last_settings_json: String::new(),
            last_snapshot_json: String::new(),
            last_revision: None,
            last_song_json: String::new(),
        }
    }
}

impl<A: Serialize, S: Serialize, V: Serialize> FeedTracker<A, S, V> {
    pub fn frame(&self) -> &FeedFrame<A, S, V> {
        &self.frame
    }

    /// One tick. `read_session` gets the last revision it saw and must only
    /// build the song view when the session's revision differs from it
    /// (building it is the expensive part). Returns whether anything changed.
    pub fn tick(
        &mut self,
        settings: Option<A>,
        read_session: impl FnOnce(Option<(u64, u64)>) -> Option<SessionRead<S, V>>,
    ) -> bool {
        let mut changed = false;

        if let Some(settings) = settings {
            if let Ok(json) = serde_json::to_string(&settings) {
                if json != self.last_settings_json {
                    self.last_settings_json = json;
                    self.frame.settings = Some(Arc::new(settings));
                    self.frame.settings_seq += 1;
                    changed = true;
                }
            }
        }

        let Some(read) = read_session(self.last_revision) else {
            return changed;
        };

        if let Ok(json) = serde_json::to_string(&read.snapshot) {
            if json != self.last_snapshot_json {
                self.last_snapshot_json = json;
                self.frame.snapshot = Some(Arc::new(read.snapshot));
                self.frame.snapshot_seq += 1;
                changed = true;
            }
        }

        if let Some(song) = read.song {
            if let Ok(json) = serde_json::to_string(&song) {
                if json != self.last_song_json {
                    self.last_song_json = json;
                    self.frame.song = Some(Arc::new(song));
                    self.frame.song_seq += 1;
                    changed = true;
                }
            }
            self.last_revision = Some(read.revision);
        }

        changed
    }
}

pub type SessionFeedFrame = FeedFrame<AppSettings, TransportSnapshot, Option<SongView>>;

/// Managed state: subscribe to follow the session.
pub struct SessionFeed {
    tx: watch::Sender<Arc<SessionFeedFrame>>,
}

impl SessionFeed {
    pub fn subscribe(&self) -> watch::Receiver<Arc<SessionFeedFrame>> {
        self.tx.subscribe()
    }
}

/// Whether a tick should touch the session at all.
fn should_poll(subscribers: usize) -> bool {
    subscribers > 0
}

pub fn initialize_session_feed(app: &App) {
    let (tx, initial_rx) = watch::channel(Arc::new(SessionFeedFrame::default()));
    // Without this drop the feed would count one subscriber forever and
    // never go idle.
    drop(initial_rx);
    app.manage(SessionFeed { tx: tx.clone() });
    tauri::async_runtime::spawn(run_session_feed(app.handle().clone(), tx));
}

async fn run_session_feed(app: AppHandle, tx: watch::Sender<Arc<SessionFeedFrame>>) {
    let mut interval = tokio::time::interval(FEED_INTERVAL);
    let mut tracker: FeedTracker<AppSettings, TransportSnapshot, Option<SongView>> =
        FeedTracker::default();

    loop {
        interval.tick().await;
        if !should_poll(tx.receiver_count()) {
            continue;
        }

        let settings = app.state::<AppSettingsStore>().current().ok();
        let changed = tracker.tick(settings, |last_revision| {
            let state = app.state::<DesktopState>();
            let mut session = state.session.lock().ok()?;
            let snapshot = session.snapshot_with_sync(&state.audio).ok()?;
            let revision = (snapshot.project_revision, snapshot.mix_revision);
            // The remote UI and the guests never render waveform peaks: with
            // peaks this payload is ~27 MB and holds the lock for ~700 ms.
            let song = (last_revision != Some(revision))
                .then(|| session.song_view_with_options(false).ok().flatten());
            Some(SessionRead {
                snapshot,
                revision,
                song,
            })
        });

        if changed {
            tx.send_replace(Arc::new(tracker.frame().clone()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::cell::Cell;

    type Tracker = FeedTracker<Value, Value, Value>;

    fn read(
        snapshot: Value,
        revision: (u64, u64),
        song: Option<Value>,
    ) -> Option<SessionRead<Value, Value>> {
        Some(SessionRead {
            snapshot,
            revision,
            song,
        })
    }

    #[test]
    fn no_subscribers_means_no_poll() {
        assert!(!should_poll(0));
        assert!(should_poll(1));
    }

    #[test]
    fn first_tick_publishes_everything() {
        let mut tracker = Tracker::default();
        let changed = tracker.tick(Some(json!({"a": 1})), |last| {
            assert_eq!(last, None);
            read(json!({"p": 0}), (1, 0), Some(json!({"song": 1})))
        });
        assert!(changed);
        let frame = tracker.frame();
        assert_eq!(
            (frame.settings_seq, frame.snapshot_seq, frame.song_seq),
            (1, 1, 1)
        );
    }

    #[test]
    fn unchanged_values_do_not_bump_counters() {
        let mut tracker = Tracker::default();
        tracker.tick(Some(json!(1)), |_| read(json!(1), (1, 0), Some(json!(1))));
        let changed = tracker.tick(Some(json!(1)), |_| read(json!(1), (1, 0), None));
        assert!(!changed);
        let frame = tracker.frame();
        assert_eq!(
            (frame.settings_seq, frame.snapshot_seq, frame.song_seq),
            (1, 1, 1)
        );
    }

    #[test]
    fn read_is_told_the_last_revision_so_it_can_skip_the_song_view() {
        let mut tracker = Tracker::default();
        tracker.tick(None, |_| read(json!(1), (3, 4), Some(json!("s"))));
        let seen = Cell::new(None);
        tracker.tick(None, |last| {
            seen.set(last);
            read(json!(2), (3, 4), None)
        });
        assert_eq!(seen.get(), Some((3, 4)));
    }

    #[test]
    fn mix_revision_alone_counts_as_a_new_revision() {
        // An automation cue moves mix_revision without an edit; the read
        // closure compares the full pair, and the tracker records it.
        let mut tracker = Tracker::default();
        tracker.tick(None, |_| read(json!(1), (3, 4), Some(json!("a"))));
        tracker.tick(None, |last| {
            assert_ne!(last, Some((3, 5)));
            read(json!(1), (3, 5), Some(json!("b")))
        });
        assert_eq!(tracker.frame().song_seq, 2);
    }

    #[test]
    fn song_with_same_json_after_revision_bump_is_not_republished() {
        let mut tracker = Tracker::default();
        tracker.tick(None, |_| read(json!(1), (1, 0), Some(json!("same"))));
        let changed = tracker.tick(None, |_| read(json!(1), (2, 0), Some(json!("same"))));
        assert!(!changed);
        assert_eq!(tracker.frame().song_seq, 1);
    }

    #[test]
    fn failed_session_read_still_publishes_settings() {
        let mut tracker = Tracker::default();
        let changed = tracker.tick(Some(json!({"x": 1})), |_| None);
        assert!(changed);
        assert_eq!(tracker.frame().settings_seq, 1);
        assert_eq!(tracker.frame().snapshot_seq, 0);
    }

    #[test]
    fn snapshot_change_alone_does_not_touch_the_song() {
        let mut tracker = Tracker::default();
        tracker.tick(None, |_| read(json!(1), (1, 0), Some(json!("s"))));
        tracker.tick(None, |_| read(json!(2), (1, 0), None));
        let frame = tracker.frame();
        assert_eq!((frame.snapshot_seq, frame.song_seq), (2, 1));
    }
}
