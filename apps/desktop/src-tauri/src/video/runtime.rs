//! The video sync runtime: the stateful shell around
//! `libretracks_core::video_schedule`.
//!
//! One thread, started with the app. Each tick it reads where the transport
//! is, what the visible player shows, asks `step` what to do and sends that to
//! the output — which never blocks. It ticks every 10 ms while the transport
//! runs, every 100 ms while stopped, and parks (no sync ticks at all) while the
//! output is not ready or the session has no video.
//!
//! It never takes the session lock per tick: the transport clock comes from a
//! mirror the session publishes (`TransportClockMirror`), and the video
//! timeline is rebuilt with a `try_lock` only when an edit is announced (or at
//! most twice a second) — a busy session just keeps the previous timeline.
//!
//! Target time = transport position − audio output latency + the user's
//! offset. The latency comes from the open device's buffer (one buffer; the
//! calibration of paso 09 covers the rest of the chain, projector included).

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use libretracks_core::video_schedule::{
    step, PlayerAction, PlayerInput, SyncParams, SyncState, TransportInput, VideoTimeline,
};
use libretracks_core::VideoFit;
use libretracks_video::output::{OutputCommand, OutputState, OutputStatus, PlayerCommand};
use libretracks_video::settings::{StoppedScreen, VideoOutputSettings};
use serde::Serialize;

use crate::state::VideoTransportClock;

/// Where the runtime reads the transport and the song from.
pub trait RuntimeInputs: Send {
    /// A copy of the published transport clock (never blocks on the session).
    fn clock(&mut self) -> VideoTransportClock;
    /// The timeline and the project revision, or `None` if the session is
    /// busy right now (keep the previous one).
    fn timeline(&mut self) -> Option<(VideoTimeline, u64)>;
    /// Audio output latency in seconds.
    fn output_latency(&mut self) -> f64;
}

/// Where the runtime sends to and reads the output state from.
pub trait RuntimeOutput: Send {
    fn status(&self) -> OutputStatus;
    fn send(&self, command: OutputCommand);
    fn settings(&self) -> VideoOutputSettings;
    fn forced_black(&self) -> bool;
}

/// How soon the next tick should come.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TickRate {
    /// Nothing to sync: wait for a wake-up.
    Park,
    Slow,
    Fast,
}

/// Diagnostics shown in the settings tab and the diagnostics panel.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoSyncStats {
    /// |error| percentiles over the last 30 s of playback, in milliseconds.
    pub error_p50_ms: Option<f64>,
    pub error_p95_ms: Option<f64>,
    pub forced_seeks: u64,
    pub frame_drops: i64,
    pub hwdec: Option<String>,
    pub sync_ticks: u64,
}

/// Errors kept for the percentiles: 30 s at 100 Hz.
const ERROR_WINDOW: usize = 3000;
/// Errors above this are logged in release as `[LT_VIDEO_SYNC]`.
const LOG_ERROR_SECONDS: f64 = 0.100;
/// A load/seek counts as settled after its first frame, or after this.
const SETTLE_TIMEOUT: Duration = Duration::from_secs(1);
const TIMELINE_REFRESH: Duration = Duration::from_millis(500);
const DEFAULT_FRAME: f64 = 1.0 / 30.0;

pub struct RuntimeCore {
    params: SyncParams,
    state: SyncState,
    timeline: VideoTimeline,
    revision: Option<u64>,
    last_timeline_fetch: Option<Instant>,
    timeline_dirty: bool,
    last_generation: Option<u64>,
    /// (restarts seen when the load/seek was sent, when).
    pending_settle: Option<(u64, Instant)>,
    brightness: Option<f64>,
    fit: Option<Option<VideoFit>>,
    stopped_idle_shown: bool,
    idle_sent: bool,
    errors: VecDeque<f64>,
    last_log: Option<Instant>,
    pub stats: VideoSyncStats,
}

impl Default for RuntimeCore {
    fn default() -> Self {
        Self {
            params: SyncParams::default(),
            state: SyncState::default(),
            timeline: VideoTimeline::default(),
            revision: None,
            last_timeline_fetch: None,
            timeline_dirty: true,
            last_generation: None,
            pending_settle: None,
            brightness: None,
            fit: None,
            stopped_idle_shown: false,
            idle_sent: false,
            errors: VecDeque::with_capacity(ERROR_WINDOW),
            last_log: None,
            stats: VideoSyncStats::default(),
        }
    }
}

fn percentile(sorted: &[f64], fraction: f64) -> Option<f64> {
    if sorted.is_empty() {
        return None;
    }
    Some(sorted[((sorted.len() - 1) as f64 * fraction).round() as usize])
}

impl RuntimeCore {
    /// Something changed (edit, settings, transport command): refresh the
    /// timeline on the next tick.
    pub fn mark_dirty(&mut self) {
        self.timeline_dirty = true;
    }

    fn refresh_timeline(&mut self, inputs: &mut dyn RuntimeInputs, now: Instant) {
        let due = self.timeline_dirty
            || self
                .last_timeline_fetch
                .is_none_or(|at| now.duration_since(at) >= TIMELINE_REFRESH);
        if !due {
            return;
        }
        if let Some((timeline, revision)) = inputs.timeline() {
            self.last_timeline_fetch = Some(now);
            self.timeline_dirty = false;
            if self.revision != Some(revision) || timeline != self.timeline {
                self.timeline = timeline;
                self.revision = Some(revision);
            }
        }
    }

    fn send_brightness(&mut self, output: &dyn RuntimeOutput, value: f64) {
        if self.brightness.is_none_or(|current| (current - value).abs() >= 0.5) {
            self.brightness = Some(value);
            output.send(OutputCommand::SetBrightness(value));
        }
    }

    pub fn tick(
        &mut self,
        inputs: &mut dyn RuntimeInputs,
        output: &dyn RuntimeOutput,
        now: Instant,
    ) -> TickRate {
        let status = output.status();
        if status.state != OutputState::Ready {
            // The surface is gone or off: whatever the players had is gone
            // too, so start from scratch when it comes back.
            self.state = SyncState::default();
            self.pending_settle = None;
            self.brightness = None;
            self.fit = None;
            self.idle_sent = false;
            return TickRate::Park;
        }

        self.refresh_timeline(inputs, now);
        if self.timeline.is_empty() {
            if !self.idle_sent {
                output.send(OutputCommand::ShowIdle);
                self.idle_sent = true;
                self.state = SyncState::default();
            }
            return TickRate::Park;
        }
        self.idle_sent = false;

        let settings = output.settings();
        let clock = inputs.clock();
        let discontinuity = self
            .last_generation
            .is_some_and(|generation| generation != clock.generation);
        self.last_generation = Some(clock.generation);
        let latency = inputs.output_latency();
        let position = (clock.position_at(now) - latency
            + f64::from(settings.latency_offset_ms) / 1000.0)
            .max(0.0);
        let running = clock.running();

        let slot = status.visible_slot;
        let player_status = status.player(slot).clone();
        self.stats.frame_drops = player_status.frame_drops;
        self.stats.hwdec = player_status.hwdec.clone();

        let settled = match self.pending_settle {
            None => true,
            Some((restarts, at)) => {
                if player_status.restarts > restarts || now.duration_since(at) >= SETTLE_TIMEOUT {
                    self.pending_settle = None;
                    true
                } else {
                    false
                }
            }
        };
        let time_pos = player_status.time_pos.map(|time| {
            match (player_status.paused || !running, player_status.time_pos_at) {
                (false, Some(at)) => {
                    time + now.duration_since(at).as_secs_f64() * player_status.speed.max(0.0)
                }
                _ => time,
            }
        });

        // Stopped with "idle screen" chosen: show it once and hold.
        if !running && settings.when_stopped == StoppedScreen::Idle {
            if !self.stopped_idle_shown {
                output.send(OutputCommand::ShowIdle);
                self.stopped_idle_shown = true;
                self.state = SyncState::default();
            }
            self.send_brightness(output, if output.forced_black() { -100.0 } else { 0.0 });
            return TickRate::Slow;
        }
        self.stopped_idle_shown = false;

        let input = PlayerInput {
            file: player_status.file.clone(),
            time_pos,
            settled,
            frame_duration: DEFAULT_FRAME,
        };
        let transport = TransportInput {
            position,
            running,
            discontinuity,
        };
        let out = step(&mut self.state, &self.params, &self.timeline, transport, &input);

        for action in out.actions {
            let command = match action {
                PlayerAction::Load { path, at, paused } => {
                    self.pending_settle = Some((player_status.restarts, now));
                    PlayerCommand::Load {
                        path,
                        start_seconds: at,
                        paused,
                    }
                }
                PlayerAction::Seek { at } => {
                    self.pending_settle = Some((player_status.restarts, now));
                    PlayerCommand::Seek { seconds: at }
                }
                PlayerAction::SetSpeed(speed) => PlayerCommand::SetSpeed(speed),
                PlayerAction::Pause { at } => {
                    output.send(OutputCommand::Player {
                        slot,
                        command: PlayerCommand::SetPause(true),
                    });
                    self.pending_settle = Some((player_status.restarts, now));
                    PlayerCommand::Seek { seconds: at }
                }
                PlayerAction::Resume => PlayerCommand::SetPause(false),
                PlayerAction::Idle => {
                    output.send(OutputCommand::ShowIdle);
                    continue;
                }
            };
            output.send(OutputCommand::Player { slot, command });
        }

        let stopped_black = !running && settings.when_stopped == StoppedScreen::Black;
        let brightness = if output.forced_black() || stopped_black {
            -100.0
        } else {
            out.brightness
        };
        self.send_brightness(output, brightness);
        if self.fit != Some(out.fit) {
            self.fit = Some(out.fit);
            output.send(OutputCommand::SetFit(out.fit));
        }

        if let (Some(error), true) = (out.error, running) {
            if self.errors.len() == ERROR_WINDOW {
                self.errors.pop_front();
            }
            self.errors.push_back(error.abs());
            if error.abs() > LOG_ERROR_SECONDS
                && self
                    .last_log
                    .is_none_or(|at| now.duration_since(at) >= Duration::from_secs(1))
            {
                self.last_log = Some(now);
                eprintln!(
                    "[LT_VIDEO_SYNC] error={:.0}ms position={position:.3}s file={:?}",
                    error * 1000.0,
                    player_status.file
                );
            }
        }
        self.stats.forced_seeks = self.state.seeks;
        self.stats.sync_ticks += 1;
        if self.stats.sync_ticks % 50 == 0 {
            let mut sorted: Vec<f64> = self.errors.iter().copied().collect();
            sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            self.stats.error_p50_ms = percentile(&sorted, 0.5).map(|value| value * 1000.0);
            self.stats.error_p95_ms = percentile(&sorted, 0.95).map(|value| value * 1000.0);
        }

        if running {
            TickRate::Fast
        } else {
            TickRate::Slow
        }
    }
}

/// The runtime's real inputs: the published transport clock, the session
/// (only ever `try_lock`ed) and the audio device's latency.
pub struct SessionInputs {
    pub clock: Arc<Mutex<VideoTransportClock>>,
    pub session: Arc<Mutex<crate::state::DesktopSession>>,
    pub audio: Arc<crate::audio::engine::AudioController>,
    latency: Option<(f64, Instant)>,
}

impl SessionInputs {
    pub fn new(
        clock: Arc<Mutex<VideoTransportClock>>,
        session: Arc<Mutex<crate::state::DesktopSession>>,
        audio: Arc<crate::audio::engine::AudioController>,
    ) -> Self {
        Self {
            clock,
            session,
            audio,
            latency: None,
        }
    }
}

impl RuntimeInputs for SessionInputs {
    fn clock(&mut self) -> VideoTransportClock {
        self.clock.lock().map(|clock| *clock).unwrap_or_default()
    }

    fn timeline(&mut self) -> Option<(VideoTimeline, u64)> {
        self.session
            .try_lock()
            .ok()
            .map(|session| session.video_timeline())
    }

    fn output_latency(&mut self) -> f64 {
        // The device only changes when the user opens another: sample the
        // engine every few seconds, not every tick.
        let now = Instant::now();
        if let Some((latency, at)) = self.latency {
            if now.duration_since(at) < Duration::from_secs(3) {
                return latency;
            }
        }
        let latency = self
            .audio
            .engine_snapshot()
            .ok()
            .filter(|snapshot| snapshot.device.sample_rate > 0 && snapshot.device.buffer_size > 0)
            .map(|snapshot| {
                f64::from(snapshot.device.buffer_size) / f64::from(snapshot.device.sample_rate)
            })
            .or(self.latency.map(|(latency, _)| latency))
            .unwrap_or(0.0);
        self.latency = Some((latency, now));
        latency
    }
}

/// The runtime's real output: the `VideoSystem`.
pub struct SystemOutput(pub Arc<super::VideoSystem>);

impl RuntimeOutput for SystemOutput {
    fn status(&self) -> OutputStatus {
        self.0.output_status()
    }
    fn send(&self, command: OutputCommand) {
        self.0.send(command);
    }
    fn settings(&self) -> VideoOutputSettings {
        self.0.settings()
    }
    fn forced_black(&self) -> bool {
        self.0.forced_black.load(Ordering::Relaxed)
    }
}

/// Owned by `VideoSystem`: wakes, starts and stops the runtime thread and
/// exposes its stats.
#[derive(Default)]
pub struct VideoRuntimeHandle {
    wake: Arc<(Mutex<bool>, Condvar)>,
    started: AtomicBool,
    stop: Arc<AtomicBool>,
    stats: Arc<Mutex<VideoSyncStats>>,
    parked_wakeups: Arc<AtomicU64>,
}

impl VideoRuntimeHandle {
    pub fn notify(&self) {
        let (requested, condition) = &*self.wake;
        if let Ok(mut requested) = requested.lock() {
            *requested = true;
            condition.notify_one();
        }
    }

    pub fn stats(&self) -> VideoSyncStats {
        self.stats
            .lock()
            .map(|stats| stats.clone())
            .unwrap_or_default()
    }

    pub fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
        self.notify();
    }

    /// Start the thread. Idempotent.
    pub fn start(&self, mut inputs: Box<dyn RuntimeInputs>, output: Box<dyn RuntimeOutput>) {
        if self.started.swap(true, Ordering::SeqCst) {
            return;
        }
        let wake = Arc::clone(&self.wake);
        let stop = Arc::clone(&self.stop);
        let stats = Arc::clone(&self.stats);
        let parked_wakeups = Arc::clone(&self.parked_wakeups);
        let _ = std::thread::Builder::new()
            .name("lt-video-sync".into())
            .spawn(move || {
                let mut core = RuntimeCore::default();
                while !stop.load(Ordering::Relaxed) {
                    let rate = core.tick(inputs.as_mut(), output.as_ref(), Instant::now());
                    if rate == TickRate::Park {
                        parked_wakeups.fetch_add(1, Ordering::Relaxed);
                    }
                    if let Ok(mut shared) = stats.lock() {
                        shared.clone_from(&core.stats);
                    }
                    let wait = match rate {
                        TickRate::Fast => Duration::from_millis(10),
                        TickRate::Slow => Duration::from_millis(100),
                        // Parked: a notify wakes it at once; the timeout only
                        // notices the output coming back (display replugged).
                        TickRate::Park => Duration::from_millis(500),
                    };
                    let (requested, condition) = &*wake;
                    let Ok(guard) = requested.lock() else { break };
                    let (mut guard, _) = match condition.wait_timeout_while(guard, wait, |requested| {
                        !*requested
                    }) {
                        Ok(result) => result,
                        Err(_) => break,
                    };
                    if *guard {
                        *guard = false;
                        core.mark_dirty();
                    }
                }
            });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use libretracks_core::video_schedule::TimelineVideoClip;
    use libretracks_video::output::{PlayerStatus, Slot};
    use std::cell::RefCell;

    struct FakeInputs {
        clock: VideoTransportClock,
        timeline: VideoTimeline,
        fetches: u32,
    }

    impl RuntimeInputs for FakeInputs {
        fn clock(&mut self) -> VideoTransportClock {
            self.clock
        }
        fn timeline(&mut self) -> Option<(VideoTimeline, u64)> {
            self.fetches += 1;
            Some((self.timeline.clone(), 1))
        }
        fn output_latency(&mut self) -> f64 {
            0.0
        }
    }

    #[derive(Default)]
    struct FakeOutput {
        status: RefCell<OutputStatus>,
        sent: RefCell<Vec<OutputCommand>>,
        settings: VideoOutputSettings,
        black: bool,
    }

    // SAFETY-free: tests are single-threaded; the trait wants Send.
    unsafe impl Send for FakeOutput {}

    impl RuntimeOutput for FakeOutput {
        fn status(&self) -> OutputStatus {
            self.status.borrow().clone()
        }
        fn send(&self, command: OutputCommand) {
            // Mirror loads into the status like the real output does.
            if let OutputCommand::Player {
                slot,
                command: PlayerCommand::Load { path, start_seconds, paused },
            } = &command
            {
                let mut status = self.status.borrow_mut();
                let index = if *slot == Slot::A { 0 } else { 1 };
                status.players[index] = PlayerStatus {
                    file: Some(path.clone()),
                    time_pos: Some(*start_seconds),
                    time_pos_at: Some(Instant::now()),
                    paused: *paused,
                    speed: 1.0,
                    restarts: status.players[index].restarts + 1,
                    ..Default::default()
                };
            }
            self.sent.borrow_mut().push(command);
        }
        fn settings(&self) -> VideoOutputSettings {
            self.settings.clone()
        }
        fn forced_black(&self) -> bool {
            self.black
        }
    }

    fn ready_output() -> FakeOutput {
        let output = FakeOutput::default();
        output.status.borrow_mut().state = OutputState::Ready;
        output
    }

    fn one_clip_timeline() -> VideoTimeline {
        VideoTimeline {
            clips: vec![TimelineVideoClip {
                clip_id: "a".into(),
                track_order: 0,
                file_path: "D:/a.mp4".into(),
                start: 0.0,
                end: 100.0,
                media_start: 0.0,
                rate: 1.0,
                fade_in: 0.0,
                fade_out: 0.0,
                fit: None,
            }],
        }
    }

    fn running_clock(at: f64) -> VideoTransportClock {
        VideoTransportClock {
            anchor_position_seconds: at,
            anchor_started_at: Some(Instant::now()),
            generation: 1,
        }
    }

    #[test]
    fn a_session_without_video_parks_the_runtime() {
        let mut core = RuntimeCore::default();
        let mut inputs = FakeInputs {
            clock: running_clock(3.0),
            timeline: VideoTimeline::default(),
            fetches: 0,
        };
        let output = ready_output();
        for _ in 0..100 {
            assert_eq!(core.tick(&mut inputs, &output, Instant::now()), TickRate::Park);
        }
        // C6: not a single sync tick in a second's worth of iterations.
        assert_eq!(core.stats.sync_ticks, 0);
    }

    #[test]
    fn an_output_that_is_not_ready_parks_it_too() {
        let mut core = RuntimeCore::default();
        let mut inputs = FakeInputs {
            clock: running_clock(3.0),
            timeline: one_clip_timeline(),
            fetches: 0,
        };
        let output = FakeOutput::default();
        assert_eq!(core.tick(&mut inputs, &output, Instant::now()), TickRate::Park);
        assert!(output.sent.borrow().is_empty());
    }

    #[test]
    fn playing_loads_the_clip_and_ticks_fast() {
        let mut core = RuntimeCore::default();
        let mut inputs = FakeInputs {
            clock: running_clock(12.0),
            timeline: one_clip_timeline(),
            fetches: 0,
        };
        let output = ready_output();
        assert_eq!(core.tick(&mut inputs, &output, Instant::now()), TickRate::Fast);
        assert!(output.sent.borrow().iter().any(|command| matches!(
            command,
            OutputCommand::Player { command: PlayerCommand::Load { path, .. }, .. } if path == "D:/a.mp4"
        )));
    }

    #[test]
    fn forced_black_overrides_the_picture() {
        let mut core = RuntimeCore::default();
        let mut inputs = FakeInputs {
            clock: running_clock(12.0),
            timeline: one_clip_timeline(),
            fetches: 0,
        };
        let mut output = ready_output();
        output.black = true;
        core.tick(&mut inputs, &output, Instant::now());
        assert!(output
            .sent
            .borrow()
            .contains(&OutputCommand::SetBrightness(-100.0)));
    }

    #[test]
    fn a_new_transport_generation_is_a_discontinuity() {
        let mut core = RuntimeCore::default();
        let mut inputs = FakeInputs {
            clock: running_clock(12.0),
            timeline: one_clip_timeline(),
            fetches: 0,
        };
        let output = ready_output();
        core.tick(&mut inputs, &output, Instant::now());
        output.sent.borrow_mut().clear();
        // A seek to 40 s: new generation.
        inputs.clock = VideoTransportClock {
            anchor_position_seconds: 40.0,
            anchor_started_at: Some(Instant::now()),
            generation: 2,
        };
        core.tick(&mut inputs, &output, Instant::now());
        assert!(output.sent.borrow().iter().any(|command| matches!(
            command,
            OutputCommand::Player { command: PlayerCommand::Seek { seconds }, .. } if (*seconds - 40.05).abs() < 0.02
        )));
    }

    /// C5: the runtime never needs the session lock per tick. The test holds
    /// the real session lock while 100 ticks run against a timeline source
    /// that only ever `try_lock`s it: every tick completes (a blocking lock
    /// would deadlock this single-threaded test).
    #[test]
    fn a_hundred_ticks_run_while_the_session_lock_is_held() {
        struct SessionInputs {
            session: Arc<Mutex<crate::state::DesktopSession>>,
            clock: Arc<Mutex<VideoTransportClock>>,
            busy: u32,
        }
        impl RuntimeInputs for SessionInputs {
            fn clock(&mut self) -> VideoTransportClock {
                *self.clock.lock().unwrap()
            }
            fn timeline(&mut self) -> Option<(VideoTimeline, u64)> {
                match self.session.try_lock() {
                    Ok(session) => Some(session.video_timeline()),
                    Err(_) => {
                        self.busy += 1;
                        None
                    }
                }
            }
            fn output_latency(&mut self) -> f64 {
                0.0
            }
        }

        let session = Arc::new(Mutex::new(crate::state::DesktopSession::default()));
        let clock = session.lock().unwrap().transport_clock_mirror();
        let mut inputs = SessionInputs {
            session: Arc::clone(&session),
            clock,
            busy: 0,
        };
        let output = ready_output();
        let mut core = RuntimeCore::default();
        // Seed a timeline, as if fetched before the session got busy.
        core.timeline = one_clip_timeline();
        core.revision = Some(0);
        let _held = session.lock().unwrap();
        for tick in 0..100 {
            core.mark_dirty();
            let now = Instant::now() + Duration::from_millis(10 * tick);
            core.tick(&mut inputs, &output, now);
        }
        assert_eq!(inputs.busy, 100, "every refresh found the session busy");
        // …and every tick still synced, from the timeline it already had.
        assert_eq!(core.stats.sync_ticks, 100);
    }
}
