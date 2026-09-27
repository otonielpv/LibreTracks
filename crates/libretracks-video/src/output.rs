//! The video output: one thread that owns the surface and the players, fed by
//! a command channel.
//!
//! Whoever calls never waits for mpv: [`VideoOutput::send`] pushes onto an
//! unbounded channel and returns. The thread applies the commands, drains the
//! players' events and publishes an [`OutputStatus`] snapshot that readers copy
//! out under a lock held for microseconds.
//!
//! What it survives, because it is the piece that fails in front of the
//! audience if it fails: the display disappearing (the surface closes, the
//! state says so, it reopens by itself when the display comes back), libmpv
//! missing (state `Unavailable`), and a file that will not load (state
//! `Error`, and the next good load recovers). None of it touches the audio.
//!
//! Two player slots, A and B, share the surface; only one is visible. Paso 08
//! preloads the next target in the hidden one and swaps.

use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use libretracks_core::VideoFit;
use serde::Serialize;

use crate::monitors::{plan_surface, MonitorInfo, PlacementOutcome, SurfacePlan};
use crate::settings::{IdleScreen, VideoOutputSettings};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Slot {
    A,
    B,
}

impl Slot {
    pub fn other(self) -> Slot {
        match self {
            Slot::A => Slot::B,
            Slot::B => Slot::A,
        }
    }

    fn index(self) -> usize {
        match self {
            Slot::A => 0,
            Slot::B => 1,
        }
    }
}

/// What a player is told to do.
#[derive(Debug, Clone, PartialEq)]
pub enum PlayerCommand {
    /// Open `path` and land on `start_seconds` exactly, paused or playing.
    Load {
        path: String,
        start_seconds: f64,
        paused: bool,
    },
    Seek { seconds: f64 },
    SetPause(bool),
    SetSpeed(f64),
    /// Unload: the surface shows its black background.
    Stop,
}

#[derive(Debug, Clone, PartialEq)]
pub enum OutputCommand {
    /// Monitors now connected, and the one the app window is on.
    Displays {
        monitors: Vec<MonitorInfo>,
        app_monitor: Option<String>,
    },
    ApplySettings(VideoOutputSettings),
    Player { slot: Slot, command: PlayerCommand },
    /// Make `slot` the visible one.
    ShowSlot(Slot),
    /// −100 (black) … 0 (normal). Fades and "black" ride on this: it answers
    /// at once, while unloading takes time and leaves a stale frame.
    SetBrightness(f64),
    /// Per-clip fit override; `None` returns to the settings' fit.
    SetFit(Option<VideoFit>),
    /// Show the idle screen (image or black) on the visible slot.
    ShowIdle,
    /// Show an image (the test pattern) until `None`.
    Overlay(Option<String>),
    Shutdown,
}

/// Why a backend could not do something.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BackendError {
    /// Video cannot work here at all (no libmpv, unsupported platform).
    Unavailable(String),
    Failed(String),
}

impl BackendError {
    pub fn message(&self) -> &str {
        match self {
            BackendError::Unavailable(message) | BackendError::Failed(message) => message,
        }
    }
}

/// What the players report back.
#[derive(Debug, Clone, PartialEq)]
pub enum BackendEvent {
    TimePos { slot: Slot, seconds: f64 },
    /// First frame after a load or seek is on screen.
    PlaybackRestart { slot: Slot },
    FileLoaded { slot: Slot },
    LoadFailed { slot: Slot, reason: String },
    Hwdec { slot: Slot, name: String },
    FrameDrops { slot: Slot, count: i64 },
}

/// The surface plus its two players. Implemented over libmpv by
/// [`crate::mpv_backend`], and by a fake in tests.
pub trait OutputBackend: Send {
    fn open(&mut self, plan: &SurfacePlan, settings: &VideoOutputSettings) -> Result<(), BackendError>;
    /// Move/resize an open surface without recreating the players.
    fn reposition(&mut self, plan: &SurfacePlan) -> Result<(), BackendError>;
    fn close(&mut self);
    fn is_open(&self) -> bool;
    fn player(&mut self, slot: Slot, command: &PlayerCommand) -> Result<(), BackendError>;
    fn show_slot(&mut self, slot: Slot) -> Result<(), BackendError>;
    fn set_brightness(&mut self, value: f64) -> Result<(), BackendError>;
    fn set_fit(&mut self, fit: VideoFit) -> Result<(), BackendError>;
    /// Show a still image (idle picture or test pattern) on `slot`, or clear
    /// it (black background) with `None`.
    fn show_image(&mut self, slot: Slot, path: Option<&str>) -> Result<(), BackendError>;
    /// Wait up to `max_wait` for player events and return them.
    fn poll(&mut self, max_wait: Duration) -> Vec<BackendEvent>;
    /// Whether slots A and B are two real players (preload + swap possible).
    fn dual_players(&self) -> bool {
        true
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "state", content = "detail")]
pub enum OutputState {
    Disabled,
    /// libmpv missing or unsupported platform; the reason is shown.
    Unavailable(String),
    /// Enabled but no display chosen yet.
    NoDisplay,
    Ready,
    /// The configured display is not connected; reopens by itself.
    DisplayLost,
    Error(String),
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerStatus {
    pub file: Option<String>,
    /// Last `time-pos` the player reported, in media seconds.
    pub time_pos: Option<f64>,
    #[serde(skip)]
    pub time_pos_at: Option<Instant>,
    pub paused: bool,
    pub speed: f64,
    pub loads: u64,
    pub restarts: u64,
    pub hwdec: Option<String>,
    pub frame_drops: i64,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputStatus {
    pub state: OutputState,
    pub visible_slot: Slot,
    pub players: [PlayerStatus; 2],
    pub brightness: f64,
    /// The chosen display is the app's: shown in a window, and the UI warns.
    pub shares_app_display: bool,
    pub monitor_name: Option<String>,
    /// Times the surface was opened (tests; a fit change must not reopen).
    pub opens: u32,
    /// Two real players: the runtime may preload in the hidden one.
    pub dual_players: bool,
}

impl Default for OutputStatus {
    fn default() -> Self {
        Self {
            state: OutputState::Disabled,
            visible_slot: Slot::A,
            players: Default::default(),
            brightness: 0.0,
            shares_app_display: false,
            monitor_name: None,
            opens: 0,
            dual_players: false,
        }
    }
}

impl OutputStatus {
    pub fn player(&self, slot: Slot) -> &PlayerStatus {
        &self.players[slot.index()]
    }
}

/// The state machine the thread runs, separate from the thread so tests can
/// drive it step by step.
pub struct OutputController<B: OutputBackend> {
    backend: B,
    settings: VideoOutputSettings,
    monitors: Vec<MonitorInfo>,
    app_monitor: Option<String>,
    plan: Option<SurfacePlan>,
    overlay: Option<String>,
    fit_override: Option<VideoFit>,
    status: OutputStatus,
}

impl<B: OutputBackend> OutputController<B> {
    pub fn new(backend: B) -> Self {
        Self {
            backend,
            settings: VideoOutputSettings::default(),
            monitors: Vec::new(),
            app_monitor: None,
            plan: None,
            overlay: None,
            fit_override: None,
            status: OutputStatus::default(),
        }
    }

    pub fn status(&self) -> &OutputStatus {
        &self.status
    }

    pub fn backend(&self) -> &B {
        &self.backend
    }

    fn fail(&mut self, error: BackendError) {
        self.status.state = match error {
            BackendError::Unavailable(reason) => OutputState::Unavailable(reason),
            BackendError::Failed(message) => OutputState::Error(message),
        };
    }

    /// Open, move or close the surface to match settings and monitors.
    fn replan(&mut self) {
        if !self.settings.enabled {
            if self.backend.is_open() {
                self.backend.close();
            }
            self.plan = None;
            self.status.state = OutputState::Disabled;
            self.status.players = Default::default();
            return;
        }
        let outcome = plan_surface(
            self.settings.display.as_ref(),
            self.settings.mode,
            &self.monitors,
            self.app_monitor.as_deref(),
        );
        match outcome {
            PlacementOutcome::NoDisplay | PlacementOutcome::DisplayLost => {
                if self.backend.is_open() {
                    self.backend.close();
                }
                self.plan = None;
                // Whatever the players had is gone with the surface; the sync
                // runtime sees `file: None` and reloads when it comes back.
                self.status.players = Default::default();
                self.status.monitor_name = None;
                self.status.state = if outcome == PlacementOutcome::NoDisplay {
                    OutputState::NoDisplay
                } else {
                    OutputState::DisplayLost
                };
            }
            PlacementOutcome::Place(plan) => {
                let same_mode = self
                    .plan
                    .as_ref()
                    .is_some_and(|current| current.fullscreen == plan.fullscreen);
                let result = if self.backend.is_open() && same_mode {
                    if self.plan.as_ref() == Some(&plan) {
                        Ok(())
                    } else {
                        self.backend.reposition(&plan)
                    }
                } else {
                    if self.backend.is_open() {
                        self.backend.close();
                        self.status.players = Default::default();
                    }
                    self.status.opens += 1;
                    self.backend.open(&plan, &self.settings)
                };
                match result {
                    Ok(()) => {
                        self.status.shares_app_display = plan.shares_app_display;
                        self.status.dual_players = self.backend.dual_players();
                        self.status.monitor_name = Some(plan.monitor_name.clone());
                        self.plan = Some(plan);
                        self.status.state = OutputState::Ready;
                        let _ = self.backend.show_slot(self.status.visible_slot);
                        let _ = self.backend.set_brightness(self.status.brightness);
                        let _ = self
                            .backend
                            .set_fit(self.fit_override.unwrap_or(self.settings.fit));
                        if let Some(overlay) = self.overlay.clone() {
                            let _ = self.backend.show_image(self.status.visible_slot, Some(&overlay));
                        }
                    }
                    Err(error) => {
                        self.plan = None;
                        self.fail(error);
                    }
                }
            }
        }
    }

    pub fn handle(&mut self, command: OutputCommand) {
        match command {
            OutputCommand::Displays {
                monitors,
                app_monitor,
            } => {
                if monitors != self.monitors || app_monitor != self.app_monitor {
                    self.monitors = monitors;
                    self.app_monitor = app_monitor;
                    self.replan();
                }
            }
            OutputCommand::ApplySettings(settings) => {
                let settings = settings.clamped();
                let placement_changed = settings.enabled != self.settings.enabled
                    || settings.display != self.settings.display
                    || settings.mode != self.settings.mode
                    || settings.hwdec != self.settings.hwdec;
                let fit_changed = settings.fit != self.settings.fit;
                self.settings = settings;
                if placement_changed || !self.backend.is_open() {
                    // hwdec is an mpv init option: changing it reopens.
                    if self.backend.is_open() && self.settings.enabled {
                        self.backend.close();
                        self.status.players = Default::default();
                        self.plan = None;
                    }
                    self.replan();
                } else if fit_changed && self.fit_override.is_none() {
                    if let Err(error) = self.backend.set_fit(self.settings.fit) {
                        self.fail(error);
                    }
                }
            }
            OutputCommand::Player { slot, command } => {
                if !self.backend.is_open() {
                    return;
                }
                let player = &mut self.status.players[slot.index()];
                match &command {
                    PlayerCommand::Load {
                        path,
                        start_seconds,
                        paused,
                    } => {
                        player.file = Some(path.clone());
                        player.time_pos = Some(*start_seconds);
                        player.time_pos_at = Some(Instant::now());
                        player.paused = *paused;
                        player.loads += 1;
                        player.last_error = None;
                    }
                    PlayerCommand::Seek { seconds } => {
                        player.time_pos = Some(*seconds);
                        player.time_pos_at = Some(Instant::now());
                    }
                    PlayerCommand::SetPause(paused) => {
                        // A paused player's time is exact; re-anchor so the
                        // reader's extrapolation starts from now.
                        player.paused = *paused;
                        player.time_pos_at = Some(Instant::now());
                    }
                    PlayerCommand::SetSpeed(speed) => player.speed = *speed,
                    PlayerCommand::Stop => {
                        player.file = None;
                        player.time_pos = None;
                    }
                }
                match self.backend.player(slot, &command) {
                    Ok(()) => {
                        if matches!(command, PlayerCommand::Load { .. })
                            && matches!(self.status.state, OutputState::Error(_))
                        {
                            self.status.state = OutputState::Ready;
                        }
                    }
                    Err(error) => {
                        let player = &mut self.status.players[slot.index()];
                        player.last_error = Some(error.message().to_string());
                        if matches!(command, PlayerCommand::Load { .. }) {
                            player.file = None;
                        }
                        self.fail(error);
                    }
                }
            }
            OutputCommand::ShowSlot(slot) => {
                self.status.visible_slot = slot;
                if self.backend.is_open() {
                    if let Err(error) = self.backend.show_slot(slot) {
                        self.fail(error);
                    }
                }
            }
            OutputCommand::SetBrightness(value) => {
                let value = value.clamp(-100.0, 0.0);
                if (value - self.status.brightness).abs() < 0.05 {
                    return;
                }
                self.status.brightness = value;
                if self.backend.is_open() {
                    let _ = self.backend.set_brightness(value);
                }
            }
            OutputCommand::SetFit(fit) => {
                if fit == self.fit_override {
                    return;
                }
                self.fit_override = fit;
                if self.backend.is_open() {
                    let _ = self.backend.set_fit(fit.unwrap_or(self.settings.fit));
                }
            }
            OutputCommand::ShowIdle => {
                if !self.backend.is_open() {
                    return;
                }
                let slot = self.status.visible_slot;
                let image = match &self.settings.idle {
                    IdleScreen::Black => None,
                    IdleScreen::Image { path } => Some(path.clone()),
                };
                let player = &mut self.status.players[slot.index()];
                player.file = image.clone();
                player.time_pos = None;
                if let Err(error) = self.backend.show_image(slot, image.as_deref()) {
                    self.fail(error);
                }
            }
            OutputCommand::Overlay(path) => {
                self.overlay = path.clone();
                if !self.backend.is_open() {
                    return;
                }
                let slot = self.status.visible_slot;
                self.status.players[slot.index()].file = path.clone();
                if let Err(error) = self.backend.show_image(slot, path.as_deref()) {
                    self.fail(error);
                }
            }
            OutputCommand::Shutdown => {
                if self.backend.is_open() {
                    self.backend.close();
                }
            }
        }
    }

    /// Fold player events into the status.
    pub fn absorb(&mut self, events: Vec<BackendEvent>) {
        for event in events {
            match event {
                BackendEvent::TimePos { slot, seconds } => {
                    let player = &mut self.status.players[slot.index()];
                    player.time_pos = Some(seconds);
                    player.time_pos_at = Some(Instant::now());
                }
                BackendEvent::PlaybackRestart { slot } => {
                    self.status.players[slot.index()].restarts += 1;
                }
                BackendEvent::FileLoaded { .. } => {}
                BackendEvent::LoadFailed { slot, reason } => {
                    let player = &mut self.status.players[slot.index()];
                    player.last_error = Some(reason.clone());
                    player.file = None;
                    self.status.state = OutputState::Error(reason);
                }
                BackendEvent::Hwdec { slot, name } => {
                    self.status.players[slot.index()].hwdec = Some(name);
                }
                BackendEvent::FrameDrops { slot, count } => {
                    self.status.players[slot.index()].frame_drops = count;
                }
            }
        }
    }

    fn poll_backend(&mut self, max_wait: Duration) {
        let events = self.backend.poll(max_wait);
        self.absorb(events);
    }
}

/// Handle to the output thread.
pub struct VideoOutput {
    sender: Sender<OutputCommand>,
    status: Arc<Mutex<OutputStatus>>,
    thread: Option<thread::JoinHandle<()>>,
}

/// How long the thread waits for player events per turn while the surface is
/// open. Bounds how late a command can be applied.
const OPEN_POLL: Duration = Duration::from_millis(4);
/// Idle wait for commands when the surface is closed.
const CLOSED_POLL: Duration = Duration::from_millis(100);

impl VideoOutput {
    /// Spawn the output thread around `backend`.
    pub fn spawn<B: OutputBackend + 'static>(backend: B) -> Self {
        let (sender, receiver) = mpsc::channel();
        let status = Arc::new(Mutex::new(OutputStatus::default()));
        let shared = Arc::clone(&status);
        let thread = thread::Builder::new()
            .name("lt-video-output".into())
            .spawn(move || run(OutputController::new(backend), receiver, shared))
            .ok();
        Self {
            sender,
            status,
            thread,
        }
    }

    /// Queue a command. Never blocks: the channel is unbounded and the
    /// thread applies it on its next turn. A stopped thread drops it.
    pub fn send(&self, command: OutputCommand) {
        let _ = self.sender.send(command);
    }

    /// A copy of the latest status.
    pub fn status(&self) -> OutputStatus {
        self.status
            .lock()
            .map(|status| status.clone())
            .unwrap_or_default()
    }

    pub fn shutdown(&mut self) {
        self.send(OutputCommand::Shutdown);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for VideoOutput {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn publish<B: OutputBackend>(controller: &OutputController<B>, shared: &Mutex<OutputStatus>) {
    if let Ok(mut status) = shared.lock() {
        status.clone_from(&controller.status);
    }
}

fn run<B: OutputBackend>(
    mut controller: OutputController<B>,
    receiver: Receiver<OutputCommand>,
    shared: Arc<Mutex<OutputStatus>>,
) {
    loop {
        // Everything queued so far, in order.
        loop {
            match receiver.try_recv() {
                Ok(OutputCommand::Shutdown) => {
                    controller.handle(OutputCommand::Shutdown);
                    publish(&controller, &shared);
                    return;
                }
                Ok(command) => controller.handle(command),
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => {
                    controller.handle(OutputCommand::Shutdown);
                    return;
                }
            }
        }
        publish(&controller, &shared);

        if controller.backend.is_open() {
            controller.poll_backend(OPEN_POLL);
        } else {
            match receiver.recv_timeout(CLOSED_POLL) {
                Ok(OutputCommand::Shutdown) => {
                    controller.handle(OutputCommand::Shutdown);
                    publish(&controller, &shared);
                    return;
                }
                Ok(command) => controller.handle(command),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
    }
}

/// A backend that can never open, for platforms or machines without video.
pub struct UnavailableBackend(pub String);

impl OutputBackend for UnavailableBackend {
    fn open(&mut self, _: &SurfacePlan, _: &VideoOutputSettings) -> Result<(), BackendError> {
        Err(BackendError::Unavailable(self.0.clone()))
    }
    fn reposition(&mut self, _: &SurfacePlan) -> Result<(), BackendError> {
        Err(BackendError::Unavailable(self.0.clone()))
    }
    fn close(&mut self) {}
    fn is_open(&self) -> bool {
        false
    }
    fn player(&mut self, _: Slot, _: &PlayerCommand) -> Result<(), BackendError> {
        Err(BackendError::Unavailable(self.0.clone()))
    }
    fn show_slot(&mut self, _: Slot) -> Result<(), BackendError> {
        Ok(())
    }
    fn set_brightness(&mut self, _: f64) -> Result<(), BackendError> {
        Ok(())
    }
    fn set_fit(&mut self, _: VideoFit) -> Result<(), BackendError> {
        Ok(())
    }
    fn show_image(&mut self, _: Slot, _: Option<&str>) -> Result<(), BackendError> {
        Ok(())
    }
    fn poll(&mut self, _: Duration) -> Vec<BackendEvent> {
        Vec::new()
    }
}

#[cfg(test)]
pub(crate) mod fake {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// Records what it is asked to do. Optionally slow, and optionally
    /// failing loads of paths containing "broken".
    #[derive(Default)]
    pub struct FakeBackend {
        pub open: bool,
        pub opens: u32,
        pub repositions: u32,
        pub commands: Vec<(Slot, PlayerCommand)>,
        pub fits: Vec<VideoFit>,
        pub brightness: Vec<f64>,
        pub visible: Vec<Slot>,
        pub images: Vec<(Slot, Option<String>)>,
        pub delay: Duration,
        pub pending_events: Vec<BackendEvent>,
        pub polls: Arc<AtomicU32>,
    }

    impl OutputBackend for FakeBackend {
        fn open(&mut self, _: &SurfacePlan, _: &VideoOutputSettings) -> Result<(), BackendError> {
            std::thread::sleep(self.delay);
            self.open = true;
            self.opens += 1;
            Ok(())
        }
        fn reposition(&mut self, _: &SurfacePlan) -> Result<(), BackendError> {
            self.repositions += 1;
            Ok(())
        }
        fn close(&mut self) {
            self.open = false;
        }
        fn is_open(&self) -> bool {
            self.open
        }
        fn player(&mut self, slot: Slot, command: &PlayerCommand) -> Result<(), BackendError> {
            std::thread::sleep(self.delay);
            if let PlayerCommand::Load { path, .. } = command {
                if path.contains("broken") {
                    return Err(BackendError::Failed(format!("{path}: códec no soportado")));
                }
            }
            self.commands.push((slot, command.clone()));
            Ok(())
        }
        fn show_slot(&mut self, slot: Slot) -> Result<(), BackendError> {
            self.visible.push(slot);
            Ok(())
        }
        fn set_brightness(&mut self, value: f64) -> Result<(), BackendError> {
            self.brightness.push(value);
            Ok(())
        }
        fn set_fit(&mut self, fit: VideoFit) -> Result<(), BackendError> {
            self.fits.push(fit);
            Ok(())
        }
        fn show_image(&mut self, slot: Slot, path: Option<&str>) -> Result<(), BackendError> {
            self.images.push((slot, path.map(str::to_string)));
            Ok(())
        }
        fn poll(&mut self, max_wait: Duration) -> Vec<BackendEvent> {
            self.polls.fetch_add(1, Ordering::Relaxed);
            std::thread::sleep(max_wait.min(Duration::from_millis(1)));
            std::mem::take(&mut self.pending_events)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fake::FakeBackend;
    use super::*;
    use crate::settings::{DisplayId, VideoOutputMode};

    fn monitors() -> Vec<MonitorInfo> {
        vec![
            MonitorInfo {
                name: "M1".into(),
                width: 1920,
                height: 1080,
                x: 0,
                y: 0,
                is_primary: true,
            },
            MonitorInfo {
                name: "M2".into(),
                width: 1280,
                height: 720,
                x: 1920,
                y: 0,
                is_primary: false,
            },
        ]
    }

    fn enabled_on_m2() -> VideoOutputSettings {
        VideoOutputSettings {
            enabled: true,
            display: Some(DisplayId {
                name: "M2".into(),
                width: 1280,
                height: 720,
                x: 1920,
                y: 0,
            }),
            mode: VideoOutputMode::Fullscreen,
            ..Default::default()
        }
    }

    fn ready_controller() -> OutputController<FakeBackend> {
        let mut controller = OutputController::new(FakeBackend::default());
        controller.handle(OutputCommand::Displays {
            monitors: monitors(),
            app_monitor: Some("M1".into()),
        });
        controller.handle(OutputCommand::ApplySettings(enabled_on_m2()));
        assert_eq!(controller.status().state, OutputState::Ready);
        controller
    }

    fn load(path: &str) -> OutputCommand {
        OutputCommand::Player {
            slot: Slot::A,
            command: PlayerCommand::Load {
                path: path.into(),
                start_seconds: 0.0,
                paused: false,
            },
        }
    }

    /// C2: `send` returns without waiting even when every backend call takes
    /// two seconds. Proven by construction — the channel is unbounded and
    /// `send` is `Sender::send` — and observed by sending a burst while the
    /// thread is stuck in the first slow call. No clock is measured.
    #[test]
    fn sending_never_waits_for_a_slow_backend() {
        let backend = FakeBackend {
            delay: Duration::from_secs(2),
            ..Default::default()
        };
        let mut output = VideoOutput::spawn(backend);
        output.send(OutputCommand::Displays {
            monitors: monitors(),
            app_monitor: None,
        });
        output.send(OutputCommand::ApplySettings(enabled_on_m2()));
        // The thread is now inside a 2 s open(). These return immediately
        // or the test would take 100 × 2 s.
        for index in 0..100 {
            output.send(load(&format!("clip{index}.mp4")));
        }
        // Shutdown is processed in order, after the 100 slow loads: detach the
        // thread instead of joining it so the test does not wait for them.
        let _ = output.thread.take();
    }

    /// C3: a load that fails puts the state in error; the next good load
    /// recovers it.
    #[test]
    fn a_failed_load_errors_and_the_next_good_one_recovers() {
        let mut controller = ready_controller();
        controller.handle(load("D:/broken.mp4"));
        assert!(matches!(controller.status().state, OutputState::Error(ref message) if message.contains("broken")));
        assert_eq!(controller.status().player(Slot::A).file, None);
        controller.handle(load("D:/ok.mp4"));
        assert_eq!(controller.status().state, OutputState::Ready);
        assert_eq!(controller.status().player(Slot::A).file.as_deref(), Some("D:/ok.mp4"));
    }

    #[test]
    fn losing_the_display_closes_the_surface_and_it_comes_back_by_itself() {
        let mut controller = ready_controller();
        controller.handle(load("D:/ok.mp4"));
        controller.handle(OutputCommand::Displays {
            monitors: monitors()[..1].to_vec(),
            app_monitor: Some("M1".into()),
        });
        assert_eq!(controller.status().state, OutputState::DisplayLost);
        assert!(!controller.backend().open);
        // The player state is gone with the surface, so the sync runtime
        // reloads once it is back.
        assert_eq!(controller.status().player(Slot::A).file, None);

        controller.handle(OutputCommand::Displays {
            monitors: monitors(),
            app_monitor: Some("M1".into()),
        });
        assert_eq!(controller.status().state, OutputState::Ready);
        assert!(controller.backend().open);
        assert_eq!(controller.backend().opens, 2);
    }

    #[test]
    fn changing_the_fit_does_not_reopen_the_window() {
        let mut controller = ready_controller();
        let opens = controller.backend().opens;
        let mut settings = enabled_on_m2();
        settings.fit = VideoFit::Cover;
        controller.handle(OutputCommand::ApplySettings(settings.clone()));
        settings.fit = VideoFit::Stretch;
        controller.handle(OutputCommand::ApplySettings(settings));
        assert_eq!(controller.backend().opens, opens);
        assert_eq!(controller.backend().fits.last(), Some(&VideoFit::Stretch));
    }

    #[test]
    fn changing_the_display_moves_or_reopens_but_disabling_closes() {
        let mut controller = ready_controller();
        let mut settings = enabled_on_m2();
        settings.display = Some(monitors()[0].id());
        controller.handle(OutputCommand::ApplySettings(settings.clone()));
        // M1 is the app's display: window mode, flagged.
        assert!(controller.status().shares_app_display);
        settings.enabled = false;
        controller.handle(OutputCommand::ApplySettings(settings));
        assert_eq!(controller.status().state, OutputState::Disabled);
        assert!(!controller.backend().open);
    }

    #[test]
    fn without_libmpv_everything_reports_unavailable_and_nothing_panics() {
        let mut controller = OutputController::new(UnavailableBackend("libmpv no disponible: x".into()));
        controller.handle(OutputCommand::Displays {
            monitors: monitors(),
            app_monitor: None,
        });
        controller.handle(OutputCommand::ApplySettings(enabled_on_m2()));
        assert!(matches!(controller.status().state, OutputState::Unavailable(ref reason) if reason.contains("libmpv")));
        controller.handle(load("D:/ok.mp4"));
        controller.handle(OutputCommand::ShowIdle);
        controller.handle(OutputCommand::SetBrightness(-100.0));
        assert!(matches!(controller.status().state, OutputState::Unavailable(_)));
    }

    #[test]
    fn idle_shows_the_configured_image_or_black_and_black_is_brightness() {
        let mut controller = ready_controller();
        controller.handle(OutputCommand::ShowIdle);
        assert_eq!(controller.backend().images.last(), Some(&(Slot::A, None)));
        let mut settings = enabled_on_m2();
        settings.idle = IdleScreen::Image {
            path: "D:/logo.png".into(),
        };
        controller.handle(OutputCommand::ApplySettings(settings));
        controller.handle(OutputCommand::ShowIdle);
        assert_eq!(
            controller.backend().images.last(),
            Some(&(Slot::A, Some("D:/logo.png".into())))
        );
        controller.handle(OutputCommand::SetBrightness(-100.0));
        assert_eq!(controller.backend().brightness.last(), Some(&-100.0));
    }

    #[test]
    fn player_events_update_the_status() {
        let mut controller = ready_controller();
        controller.absorb(vec![
            BackendEvent::TimePos {
                slot: Slot::B,
                seconds: 12.5,
            },
            BackendEvent::PlaybackRestart { slot: Slot::B },
            BackendEvent::Hwdec {
                slot: Slot::B,
                name: "d3d11va".into(),
            },
        ]);
        let player = controller.status().player(Slot::B);
        assert_eq!(player.time_pos, Some(12.5));
        assert_eq!(player.restarts, 1);
        assert_eq!(player.hwdec.as_deref(), Some("d3d11va"));
    }
}
