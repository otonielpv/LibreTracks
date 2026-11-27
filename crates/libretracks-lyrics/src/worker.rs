//! The sending side of the lyrics sync (D17, D18): turns the schedule's
//! events into orders from each song's cached plan and sends them, off the
//! 10 ms MIDI thread.
//!
//! - **Coalescing**: everything queued is drained at once; a newer section,
//!   landing or song end makes older sections and slide changes moot, so
//!   they are dropped unsent. A slide change of a section no longer on
//!   screen is dropped too.
//! - **No retries of orders**: each request has its timeout; a late lyric is
//!   worse than none. Only the connection is retried (plans resolve again).
//! - **Plans are cached**: built when a song changes, the program connects or
//!   on Refresh; a live event only ever costs one request. An event for a
//!   song whose plan is not ready keeps only the last landing until it is.
//!
//! The desktop owns the channel and implements [`WorkerHost`]; tests drive it
//! against the fake HTTP server.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use libretracks_core::lyrics_match::{match_presentation, PresentationCandidate, PresentationMatch};
use libretracks_core::lyrics_schedule::{region_section_markers, LyricsEvent, START_SLACK_SECONDS};
use libretracks_core::section_vocab::normalize_title;
use libretracks_core::{LyricsLink, LyricsSoftware, Marker, Song, SongRegion};
use serde::Serialize;
use tokio::sync::mpsc::UnboundedReceiver;

use crate::clients::{client_for, Connection, LyricsClient, Presentation};
use crate::plan::{build_plan, LyricsCommand, MarkerStatus, SongLyricsPlan};
use crate::LyricsError;

/// How often status reaches the UI, at most.
const STATUS_INTERVAL: Duration = Duration::from_millis(100);
/// Idle wait while some song still has to be resolved.
const RESOLVE_STEP: Duration = Duration::from_millis(50);
/// After the program could not be reached, wait this long before resolving
/// again.
const RETRY_CONNECTION: Duration = Duration::from_secs(3);
/// The program is busy projecting (OpenLP): look again after this.
const RETRY_BUSY: Duration = Duration::from_secs(5);
/// What `showing` holds while a song's start slide is up.
const START_MARKER: &str = "#start";

#[derive(Debug, Clone, PartialEq)]
pub struct WorkerConfig {
    pub software: LyricsSoftware,
    pub connection: Connection,
    pub clear_on_song_end: bool,
    pub clear_on_stop: bool,
}

#[derive(Debug, Clone)]
pub enum WorkerInput {
    /// `None` = lyrics off: empty the queue and the caches.
    Configure(Option<WorkerConfig>),
    Paused(bool),
    /// The session changed (load, edit): plans of changed songs go stale.
    Song(Arc<Song>),
    Event(LyricsEvent),
    /// Landed outside every song with lyrics.
    Outside,
    /// The transport stopped.
    Stopped,
    /// The panel's "Test" button: send this section (and slide) now.
    TestSend {
        region_id: String,
        marker_id: String,
        k: u32,
    },
    /// Read the catalogue and every presentation again.
    Refresh,
    /// The slide-change recorder is open on this song (`None`: closed).
    /// Meanwhile its slide changes are not sent by playback: only the
    /// user's taps move the slides, so nothing mixes with them.
    Recording(Option<String>),
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ConnectionState {
    Disabled,
    Paused,
    Connecting,
    Ok,
    Unreachable,
    Unauthorized { missing: Vec<String> },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastSent {
    pub region_id: String,
    pub marker_id: Option<String>,
    /// The marker's name and the group it showed ("Coro → Chorus").
    pub marker_name: Option<String>,
    pub label: Option<String>,
    pub latency_ms: f64,
    pub at_unix_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricsStatus {
    pub connection: ConnectionState,
    pub last_sent: Option<LastSent>,
    pub last_error: Option<String>,
    /// Songs with lyrics on whose presentation could not be found.
    pub unlinked_songs: usize,
}

impl Default for LyricsStatus {
    fn default() -> Self {
        Self {
            connection: ConnectionState::Disabled,
            last_sent: None,
            last_error: None,
            unlinked_songs: 0,
        }
    }
}

/// What the worker tells the app.
pub trait WorkerHost: Send + Sync + 'static {
    fn status(&self, status: &LyricsStatus);
    /// A song's link was found or its id went stale on this machine: store
    /// it in the session WITHOUT an undo step (D10).
    fn link_resolved(&self, region_id: &str, link: LyricsLink);
    /// Slides of each marker's group (for the automatic slide changes).
    fn slide_counts(&self, counts: HashMap<String, u32>);
}

#[derive(Default)]
struct PlanSlot {
    fingerprint: String,
    /// `None`: tried and not found (unlinked).
    plan: Option<SongLyricsPlan>,
    resolved: bool,
}

pub struct LyricsWorker {
    host: Arc<dyn WorkerHost>,
    config: Option<WorkerConfig>,
    client: Option<Box<dyn LyricsClient>>,
    paused: bool,
    song: Option<Arc<Song>>,
    plans: HashMap<String, PlanSlot>,
    catalog: Option<Vec<Presentation>>,
    /// The section on screen, as (region, marker).
    showing: Option<(String, String)>,
    entered: Option<String>,
    /// An event for a song whose plan was not ready: sent once it is.
    pending_land: Option<LyricsEvent>,
    retry_after: Option<Instant>,
    /// Region whose recorder is open.
    recording: Option<String>,
    status: LyricsStatus,
    last_emit: Option<Instant>,
    dirty: bool,
}

/// `Section`, `Land`, song end and leaving make what came before moot.
fn anchors(input: &WorkerInput) -> bool {
    matches!(
        input,
        WorkerInput::Outside
            | WorkerInput::Stopped
            | WorkerInput::Event(
                LyricsEvent::Section { .. } | LyricsEvent::Land { .. } | LyricsEvent::ExitSong { .. }
            )
    )
}

fn droppable(input: &WorkerInput) -> bool {
    matches!(
        input,
        WorkerInput::Outside
            | WorkerInput::Event(
                LyricsEvent::Section { .. }
                    | LyricsEvent::Step { .. }
                    | LyricsEvent::EnterSong { .. }
                    | LyricsEvent::Land { .. }
                    | LyricsEvent::ExitSong { .. }
            )
    )
}

/// Drop the events a newer anchoring one makes moot.
pub fn coalesce(batch: Vec<WorkerInput>) -> Vec<WorkerInput> {
    let Some(last_anchor) = batch.iter().rposition(anchors) else {
        return batch;
    };
    batch
        .into_iter()
        .enumerate()
        .filter(|(index, input)| *index >= last_anchor || !droppable(input))
        .map(|(_, input)| input)
        .collect()
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64)
}

fn fingerprint(song: &Song, region: &SongRegion) -> String {
    let markers: Vec<&Marker> = region_section_markers(song, region);
    serde_json::to_string(&(&region.name, &region.lyrics, markers)).unwrap_or_default()
}

impl LyricsWorker {
    pub fn new(host: Arc<dyn WorkerHost>) -> Self {
        Self {
            host,
            config: None,
            client: None,
            paused: false,
            song: None,
            plans: HashMap::new(),
            catalog: None,
            showing: None,
            entered: None,
            pending_land: None,
            retry_after: None,
            recording: None,
            status: LyricsStatus::default(),
            last_emit: None,
            dirty: false,
        }
    }

    /// Serve the channel until it closes.
    pub async fn run(mut self, mut inbox: UnboundedReceiver<WorkerInput>) {
        loop {
            let wait = if self.dirty {
                STATUS_INTERVAL
            } else if self.has_stale_plans() {
                RESOLVE_STEP
            } else if self.needs_connection_check() {
                RETRY_CONNECTION
            } else {
                Duration::from_secs(3600)
            };
            let first = match tokio::time::timeout(wait, inbox.recv()).await {
                Ok(Some(input)) => Some(input),
                Ok(None) => return,
                Err(_) => None,
            };
            let mut batch: Vec<WorkerInput> = first.into_iter().collect();
            while let Ok(input) = inbox.try_recv() {
                batch.push(input);
            }
            if batch.is_empty() {
                self.idle().await;
            } else {
                self.handle(batch).await;
            }
            self.emit(false);
        }
    }

    pub fn status(&self) -> &LyricsStatus {
        &self.status
    }

    /// Process one drained batch (public for tests).
    pub async fn handle(&mut self, batch: Vec<WorkerInput>) {
        for input in coalesce(batch) {
            self.apply(input).await;
        }
    }

    /// Nothing queued: check the connection if it is not known to work,
    /// then resolve the next stale song, one per call.
    pub async fn idle(&mut self) {
        if self.retry_after.is_some_and(|at| Instant::now() < at) {
            return;
        }
        if self.needs_connection_check() {
            self.check_connection().await;
            return;
        }
        let next = self.stale_region();
        if let Some(region_id) = next {
            let _ = self.ensure_plan(&region_id).await;
        }
    }

    /// Lyrics are on but nobody has confirmed the program answers (just
    /// configured, or it stopped answering). Without a session there are no
    /// songs to resolve, so this is what tells the pill.
    fn needs_connection_check(&self) -> bool {
        self.client.is_some()
            && !self.paused
            && matches!(
                self.status.connection,
                ConnectionState::Connecting | ConnectionState::Unreachable
            )
    }

    /// Ask the program whether it is there (and, in Holyrics, allowed).
    pub async fn check_connection(&mut self) {
        let Some(client) = self.client.as_ref() else {
            return;
        };
        match client.probe().await {
            Ok(_) => {
                self.retry_after = None;
                self.status.last_error = None;
                self.set_connection(ConnectionState::Ok);
            }
            Err(error) => {
                self.fail(error);
                // Not reachable: try again later, not on every loop.
                self.retry_after = Some(Instant::now() + RETRY_CONNECTION);
            }
        }
    }

    fn has_stale_plans(&self) -> bool {
        self.client.is_some()
            && !self.paused
            && self.retry_after.is_none_or(|at| Instant::now() >= at)
            && self.stale_region().is_some()
    }

    fn stale_region(&self) -> Option<String> {
        let song = self.song.as_ref()?;
        self.client.as_ref()?;
        song.regions
            .iter()
            .filter(|region| region.lyrics.as_ref().is_none_or(|lyrics| lyrics.enabled))
            .find(|region| {
                self.plans.get(&region.id).is_none_or(|slot| {
                    !slot.resolved || slot.fingerprint != fingerprint(song, region)
                })
            })
            .map(|region| region.id.clone())
    }

    async fn apply(&mut self, input: WorkerInput) {
        match input {
            WorkerInput::Configure(config) => {
                self.configure(config);
                if self.needs_connection_check() {
                    self.check_connection().await;
                }
            }
            WorkerInput::Recording(region_id) => self.recording = region_id,
            WorkerInput::Paused(paused) => {
                self.paused = paused;
                self.set_connection(if paused {
                    ConnectionState::Paused
                } else if self.client.is_some() {
                    ConnectionState::Connecting
                } else {
                    ConnectionState::Disabled
                });
                if self.needs_connection_check() {
                    self.retry_after = None;
                    self.check_connection().await;
                }
            }
            WorkerInput::Song(song) => {
                self.song = Some(song);
            }
            WorkerInput::Refresh => {
                self.catalog = None;
                self.plans.clear();
                self.retry_after = None;
            }
            WorkerInput::Event(event) => {
                if self.sending() {
                    self.on_event(event).await;
                }
            }
            WorkerInput::Outside => {
                if self.sending() {
                    self.leave_song(None).await;
                }
            }
            WorkerInput::Stopped => {
                let clear = self.config.as_ref().is_some_and(|config| config.clear_on_stop);
                if clear && self.sending() && self.showing.is_some() {
                    self.send_clear(None).await;
                }
            }
            WorkerInput::TestSend {
                region_id,
                marker_id,
                k,
            } => {
                if self.client.is_some() {
                    let event = LyricsEvent::Land {
                        region_id: region_id.clone(),
                        marker_id: Some(marker_id.clone()),
                        occurrence: 0,
                        k_passed: k,
                    };
                    self.show(region_id, marker_id, k, event, false).await;
                }
            }
        }
    }

    fn sending(&self) -> bool {
        self.client.is_some() && !self.paused
    }

    fn configure(&mut self, config: Option<WorkerConfig>) {
        self.plans.clear();
        self.catalog = None;
        self.showing = None;
        self.entered = None;
        self.pending_land = None;
        self.retry_after = None;
        self.status.last_sent = None;
        self.status.last_error = None;
        self.client = None;
        if let Some(config) = &config {
            match client_for(config.software, config.connection.clone()) {
                Ok(client) => self.client = Some(client),
                Err(error) => self.status.last_error = Some(error.to_string()),
            }
        }
        self.config = config;
        self.publish_slide_counts();
        self.set_connection(match (&self.client, self.paused) {
            (None, _) => ConnectionState::Disabled,
            (Some(_), true) => ConnectionState::Paused,
            (Some(_), false) => ConnectionState::Connecting,
        });
    }

    async fn on_event(&mut self, event: LyricsEvent) {
        match &event {
            LyricsEvent::EnterSong {
                region_id,
                show_start,
            } => {
                let region_id = region_id.clone();
                self.entered = Some(region_id.clone());
                // The song starts now: its presentation may take the screen.
                if let Some(client) = &self.client {
                    client.set_may_take_screen(true);
                }
                let plan = self.ensure_plan(&region_id).await;
                if let Some(client) = &self.client {
                    client.set_may_take_screen(false);
                }
                if let Ok(Some(plan)) = plan {
                    let prepare = plan.prepare.clone();
                    self.send(&prepare, &region_id, None, None).await;
                }
                if *show_start {
                    self.show_start(&region_id).await;
                }
            }
            LyricsEvent::Section {
                region_id,
                marker_id,
                ..
            } => {
                self.show(region_id.clone(), marker_id.clone(), 0, event.clone(), true)
                    .await;
            }
            LyricsEvent::Land {
                region_id,
                marker_id: Some(marker_id),
                k_passed,
                ..
            } => {
                self.show(region_id.clone(), marker_id.clone(), *k_passed, event.clone(), true)
                    .await;
            }
            LyricsEvent::Land {
                region_id,
                marker_id: None,
                ..
            } => {
                // Inside a song, before its first section: its start slide
                // (or a blank screen), not what another song left up.
                let region_id = region_id.clone();
                self.show_start(&region_id).await;
            }
            LyricsEvent::Step {
                region_id,
                marker_id,
                k,
            } => {
                if self.recording.as_deref() == Some(region_id.as_str()) {
                    return;
                }
                let current = self
                    .showing
                    .as_ref()
                    .is_some_and(|(r, m)| r == region_id && m == marker_id);
                if !current {
                    return;
                }
                let step = self
                    .plan_for(region_id)
                    .and_then(|plan| plan.markers.get(marker_id))
                    .and_then(|marker| marker.steps.get(*k as usize - 1).cloned());
                if let Some(step) = step {
                    let (region_id, marker_id) = (region_id.clone(), marker_id.clone());
                    self.send(&step, &region_id, Some(&marker_id), None).await;
                }
            }
            LyricsEvent::ExitSong { region_id } => {
                if self.entered.as_deref() == Some(region_id.as_str()) {
                    self.leave_song(Some(region_id.clone())).await;
                }
            }
        }
    }

    fn plan_for(&self, region_id: &str) -> Option<&SongLyricsPlan> {
        self.plans.get(region_id)?.plan.as_ref()
    }

    /// Show a marker's section, then `k` of its slide changes.
    async fn show(&mut self, region_id: String, marker_id: String, k: u32, event: LyricsEvent, playback: bool) {
        self.entered = Some(region_id.clone());
        let plan = match self.ensure_plan(&region_id).await {
            Ok(Some(plan)) => plan,
            Ok(None) => return,
            Err(_) => {
                // Not ready (program unreachable): keep only the last landing.
                self.pending_land = Some(match event {
                    LyricsEvent::Section {
                        region_id,
                        marker_id,
                        occurrence,
                    } => LyricsEvent::Land {
                        region_id,
                        marker_id: Some(marker_id),
                        occurrence,
                        k_passed: 0,
                    },
                    other => other,
                });
                return;
            }
        };
        let Some(marker) = plan.markers.get(&marker_id) else {
            return;
        };
        let show_initial_slide = playback
            && !plan.start_automatic
            && matches!(plan.start, LyricsCommand::Slide { .. })
            && self.song.as_ref().is_some_and(|song| {
                song.regions.iter().find(|region| region.id == region_id).is_some_and(|region| {
                    region_section_markers(song, region).first().is_some_and(|first| {
                        first.id == marker_id
                            && first.start_seconds <= region.start_seconds + START_SLACK_SECONDS
                    })
                })
            });
        if show_initial_slide {
            let already_showing = self.showing.as_ref().is_some_and(|(region, marker)| {
                region == &region_id && marker == START_MARKER
            });
            if !already_showing || matches!(event, LyricsEvent::Land { .. }) {
                self.show_start(&region_id).await;
            }
            return;
        }
        let label = match &marker.status {
            MarkerStatus::Matched { group_label, .. } => Some(group_label.clone()),
            _ => None,
        };
        let Some(section) = marker.section.clone() else {
            // Unmatched or "send nothing": the screen is left alone, except
            // when this song has shown nothing yet. Then what is up is the
            // previous song's screen (or a blank one): its start slide goes
            // up instead. A song opening on an intro with no slide used to
            // stay blank (its start was skipped because it "opens on a
            // section").
            let fresh = !self
                .showing
                .as_ref()
                .is_some_and(|(showing, _)| showing == &region_id);
            if fresh {
                self.show_start(&region_id).await;
            }
            return;
        };
        let absolute = marker
            .steps
            .first()
            .is_some_and(|step| matches!(step, LyricsCommand::Step { index: Some(_), .. }));
        let steps: Vec<LyricsCommand> = match plan.software {
            // Relative steps: one "next" per slide passed.
            LyricsSoftware::ProPresenter if !absolute => {
                marker.steps.iter().take(k as usize).cloned().collect()
            }
            _ => marker
                .steps
                .get((k as usize).wrapping_sub(1))
                .cloned()
                .into_iter()
                .collect(),
        };
        if section == LyricsCommand::Clear {
            self.send_clear(Some(&region_id)).await;
            return;
        }
        self.showing = Some((region_id.clone(), marker_id.clone()));
        self.send(&section, &region_id, Some(&marker_id), label.as_deref())
            .await;
        for step in steps {
            self.send(&step, &region_id, Some(&marker_id), label.as_deref())
                .await;
        }
    }

    /// The song starts before its first section: its start slide goes up, or
    /// the screen is blanked if something else is on it.
    async fn show_start(&mut self, region_id: &str) {
        self.entered = Some(region_id.to_string());
        let start = match self.ensure_plan(region_id).await {
            Ok(Some(plan)) => plan.start.clone(),
            _ => LyricsCommand::Clear,
        };
        if start == LyricsCommand::Clear {
            if self.showing.is_some() {
                self.send_clear(Some(region_id)).await;
            }
            return;
        }
        self.showing = Some((region_id.to_string(), START_MARKER.to_string()));
        self.send(&start, region_id, None, None).await;
    }

    async fn leave_song(&mut self, region_id: Option<String>) {
        let clear = self
            .config
            .as_ref()
            .is_some_and(|config| config.clear_on_song_end);
        self.entered = None;
        if clear && self.showing.is_some() {
            self.send_clear(region_id.as_deref()).await;
        }
        self.showing = None;
    }

    async fn send_clear(&mut self, region_id: Option<&str>) {
        self.showing = None;
        let region = region_id.unwrap_or_default().to_string();
        self.send(&LyricsCommand::Clear, &region, None, None).await;
    }

    async fn send(
        &mut self,
        command: &LyricsCommand,
        region_id: &str,
        marker_id: Option<&str>,
        label: Option<&str>,
    ) {
        let Some(client) = self.client.as_ref() else {
            return;
        };
        match client.send(command).await {
            Ok(latency) => {
                let marker_name = marker_id.and_then(|id| {
                    self.song
                        .as_ref()?
                        .section_markers
                        .iter()
                        .find(|marker| marker.id == id)
                        .map(|marker| marker.name.clone())
                });
                self.status.last_sent = Some(LastSent {
                    region_id: region_id.to_string(),
                    marker_id: marker_id.map(str::to_string),
                    marker_name,
                    label: label.map(str::to_string),
                    latency_ms: latency.as_secs_f64() * 1000.0,
                    at_unix_ms: now_unix_ms(),
                });
                self.status.last_error = None;
                self.retry_after = None;
                self.set_connection(ConnectionState::Ok);
                self.dirty = true;
            }
            Err(error) => self.fail(error),
        }
    }

    fn fail(&mut self, error: LyricsError) {
        if !matches!(error, LyricsError::Busy { .. }) {
            self.status.last_error = Some(error.to_string());
        }
        match error {
            LyricsError::Unreachable { .. } | LyricsError::Timeout => {
                self.retry_after = Some(Instant::now() + RETRY_CONNECTION);
                self.set_connection(ConnectionState::Unreachable);
            }
            LyricsError::Unauthorized { missing } => {
                self.set_connection(ConnectionState::Unauthorized { missing });
            }
            // Not a failure: the song is read once the screen is free, or
            // when it starts. Without the pause the idle loop would ask
            // again at once, over and over.
            LyricsError::Busy { .. } => {
                self.retry_after = Some(Instant::now() + RETRY_BUSY);
                self.dirty = true;
            }
            _ => self.dirty = true,
        }
    }

    fn set_connection(&mut self, connection: ConnectionState) {
        let connection = if self.paused && self.client.is_some() {
            ConnectionState::Paused
        } else {
            connection
        };
        if self.status.connection != connection {
            self.status.connection = connection;
            self.emit(true);
        }
    }

    fn emit(&mut self, force: bool) {
        let due = self
            .last_emit
            .is_none_or(|last| last.elapsed() >= STATUS_INTERVAL);
        if force || (self.dirty && due) {
            self.status.unlinked_songs = self
                .plans
                .values()
                .filter(|slot| slot.resolved && slot.plan.is_none())
                .count();
            self.host.status(&self.status);
            self.last_emit = Some(Instant::now());
            self.dirty = false;
        }
    }

    async fn catalog(&mut self) -> Result<Vec<Presentation>, LyricsError> {
        if let Some(catalog) = &self.catalog {
            return Ok(catalog.clone());
        }
        let client = self.client.as_ref().ok_or(LyricsError::Timeout)?;
        let catalog = client.list_presentations().await?;
        self.catalog = Some(catalog.clone());
        Ok(catalog)
    }

    /// The plan of a song, resolving it when stale. `Ok(None)`: the song has
    /// no presentation in this program (or lyrics are off for it).
    pub async fn ensure_plan(&mut self, region_id: &str) -> Result<Option<SongLyricsPlan>, LyricsError> {
        let Some(song) = self.song.clone() else {
            return Ok(None);
        };
        let Some(region) = song.regions.iter().find(|region| region.id == region_id) else {
            return Ok(None);
        };
        let print = fingerprint(&song, region);
        if let Some(slot) = self.plans.get(region_id) {
            if slot.resolved && slot.fingerprint == print {
                return Ok(slot.plan.clone());
            }
        }
        match self.resolve(&song, region).await {
            Ok(plan) => {
                self.plans.insert(
                    region_id.to_string(),
                    PlanSlot {
                        fingerprint: print,
                        plan: plan.clone(),
                        resolved: true,
                    },
                );
                if self.status.connection == ConnectionState::Connecting
                    || self.status.connection == ConnectionState::Unreachable
                {
                    self.set_connection(ConnectionState::Ok);
                }
                self.publish_slide_counts();
                self.dirty = true;
                if let Some(LyricsEvent::Land { region_id: pending, .. }) = &self.pending_land {
                    if pending == region_id && plan.is_some() {
                        let event = self.pending_land.take().expect("checked");
                        Box::pin(self.on_event(event)).await;
                    }
                }
                Ok(plan)
            }
            Err(error) => {
                self.fail(error.clone());
                Err(error)
            }
        }
    }

    async fn resolve(
        &mut self,
        song: &Song,
        region: &SongRegion,
    ) -> Result<Option<SongLyricsPlan>, LyricsError> {
        let Some(config) = self.config.clone() else {
            return Ok(None);
        };
        if region.lyrics.as_ref().is_some_and(|lyrics| !lyrics.enabled) {
            return Ok(None);
        }
        let stored = region
            .lyrics
            .as_ref()
            .and_then(|lyrics| lyrics.link_for(config.software))
            .cloned();
        let mut link = match stored {
            Some(link) => link,
            None => LyricsLink {
                software: config.software,
                presentation_id: None,
                presentation_name: String::new(),
                overrides: Vec::new(),
                slides: Vec::new(),
                start: None,
            },
        };
        let client = self.client.as_ref().ok_or(LyricsError::Timeout)?;
        // The stored id, if it is still the same presentation here.
        let mut structure = None;
        if let Some(id) = link.presentation_id.clone() {
            match client.structure(&id).await {
                Ok(found)
                    if link.presentation_name.is_empty()
                        || normalize_title(&found.title) == normalize_title(&link.presentation_name)
                        || found.title.is_empty() =>
                {
                    structure = Some(found)
                }
                Ok(_) | Err(LyricsError::NotFound { .. }) => {}
                Err(error) => return Err(error),
            }
        }
        if structure.is_none() {
            // By name (D10): the stored name, or the song's for a new link.
            let wanted = if link.presentation_name.is_empty() {
                region.name.clone()
            } else {
                link.presentation_name.clone()
            };
            let catalog = self.catalog().await?;
            let candidates: Vec<PresentationCandidate> = catalog
                .iter()
                .map(|presentation| PresentationCandidate {
                    id: presentation.id.clone(),
                    name: presentation.name.clone(),
                })
                .collect();
            let PresentationMatch::Exact(id) = match_presentation(&wanted, &candidates) else {
                return Ok(None);
            };
            let client = self.client.as_ref().ok_or(LyricsError::Timeout)?;
            let found = client.structure(&id).await?;
            let name = catalog
                .iter()
                .find(|presentation| presentation.id == id)
                .map_or_else(|| found.title.clone(), |presentation| presentation.name.clone());
            link.presentation_id = Some(id);
            link.presentation_name = name;
            self.host.link_resolved(&region.id, link.clone());
            structure = Some(found);
        }
        let structure = structure.expect("set above");
        let markers = region_section_markers(song, region);
        Ok(Some(build_plan(config.software, &markers, &structure, &link)))
    }

    fn publish_slide_counts(&self) {
        let mut counts = HashMap::new();
        for slot in self.plans.values() {
            if let Some(plan) = &slot.plan {
                counts.extend(plan.slide_counts());
            }
        }
        self.host.slide_counts(counts);
    }
}
