//! The output backend for Android and iOS (plan `video-mobile`, paso 03): the
//! surface and the players live in native code (Media3 in a `Presentation`,
//! AVPlayer in a `UIWindow` on the external screen) and this side only talks
//! to them through [`NativeVideoBridge`].
//!
//! Compiled on every platform on purpose: it holds the only logic of the
//! mobile output that can be wrong (which call each command becomes, and how
//! the events that come back are folded), and behind a `cfg` of Android or iOS
//! no desktop test would ever run it. The per-platform adapters
//! (`platform/android_video.rs`, `platform/ios_video.rs` in the app) are thin.
//!
//! Nothing here waits for the native side. Every bridge call queues work on
//! the main thread (`Handler.post`, `DispatchQueue.main.async`) and returns;
//! the native code answers later with [`BackendEvent`]s pushed into a
//! [`NativeEventSink`], which [`NativeOutputBackend::poll`] drains.

use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::time::Duration;

use libretracks_core::VideoFit;

use crate::monitors::SurfacePlan;
use crate::output::{BackendError, BackendEvent, OutputBackend, PlayerCommand, Slot};
use crate::settings::VideoOutputSettings;

/// What each platform's native code knows how to do. No call waits: each one
/// queues on the main thread and returns.
pub trait NativeVideoBridge: Send {
    /// Create the surface on the external display called `display` (the
    /// `MonitorInfo::name` the native side reported). `Unavailable` when the
    /// native part is missing altogether.
    fn open(&self, display: &str, fit: VideoFit) -> Result<(), BackendError>;
    fn close(&self);
    fn player(&self, slot: Slot, command: &PlayerCommand);
    fn show_slot(&self, slot: Slot);
    /// −100 (black) … 0 (normal): the opacity of a black layer on top.
    fn set_brightness(&self, value: f64);
    fn set_fit(&self, fit: VideoFit);
    fn show_image(&self, slot: Slot, path: Option<&str>);
    /// Whether two players can be had at all on this device. Media3 learns it
    /// at run time and corrects it with [`BackendEvent::DualPlayers`]
    /// (00-DISENO §4.3).
    fn dual_players(&self) -> bool;
    /// Keep the phone from sleeping (and so from switching the projector
    /// off) while the output shows the session's video (paso 06 §4). The
    /// previous value is restored with `false`.
    fn set_keep_awake(&self, _on: bool) {}
}

/// Where the native side pushes its events. Cloned into the JNI / FFI
/// callbacks; sending never blocks.
#[derive(Clone)]
pub struct NativeEventSink(Sender<BackendEvent>);

impl NativeEventSink {
    pub fn send(&self, event: BackendEvent) {
        let _ = self.0.send(event);
    }
}

/// A channel for native events: the sink for the adapters, the receiver for
/// [`NativeOutputBackend::new`].
pub fn native_event_channel() -> (NativeEventSink, Receiver<BackendEvent>) {
    let (sender, receiver) = mpsc::channel();
    (NativeEventSink(sender), receiver)
}

/// [`OutputBackend`] over a [`NativeVideoBridge`].
pub struct NativeOutputBackend<B: NativeVideoBridge> {
    bridge: B,
    events: Receiver<BackendEvent>,
    open: bool,
    dual: bool,
    keep_awake: bool,
    /// The session has video: only then is the phone kept awake.
    has_content: bool,
}

impl<B: NativeVideoBridge> NativeOutputBackend<B> {
    pub fn new(bridge: B, events: Receiver<BackendEvent>) -> Self {
        let dual = bridge.dual_players();
        Self {
            bridge,
            events,
            open: false,
            dual,
            keep_awake: false,
            has_content: false,
        }
    }

    pub fn bridge(&self) -> &B {
        &self.bridge
    }

    fn set_keep_awake(&mut self, on: bool) {
        if self.keep_awake != on {
            self.keep_awake = on;
            self.bridge.set_keep_awake(on);
        }
    }
}

/// Keep only the last `TimePos` of each slot, where it was. The native side
/// reports once per display frame (60 Hz); between two polls only the newest
/// matters, and the queue must not grow while the output thread is busy.
pub fn coalesce_time_positions(events: Vec<BackendEvent>) -> Vec<BackendEvent> {
    let mut last = [None, None];
    for (index, event) in events.iter().enumerate() {
        if let BackendEvent::TimePos { slot, .. } = event {
            last[slot_index(*slot)] = Some(index);
        }
    }
    events
        .into_iter()
        .enumerate()
        .filter(|(index, event)| match event {
            BackendEvent::TimePos { slot, .. } => last[slot_index(*slot)] == Some(*index),
            _ => true,
        })
        .map(|(_, event)| event)
        .collect()
}

fn slot_index(slot: Slot) -> usize {
    match slot {
        Slot::A => 0,
        Slot::B => 1,
    }
}

impl<B: NativeVideoBridge> OutputBackend for NativeOutputBackend<B> {
    fn open(
        &mut self,
        plan: &SurfacePlan,
        settings: &VideoOutputSettings,
    ) -> Result<(), BackendError> {
        self.bridge.open(&plan.monitor_name, settings.fit)?;
        self.open = true;
        // The surface also opens for the idle screen of a session without
        // video; the phone is kept awake only for video (paso 06 §4).
        self.set_keep_awake(self.has_content);
        Ok(())
    }

    fn reposition(&mut self, plan: &SurfacePlan) -> Result<(), BackendError> {
        // A phone has no window to move: the plan only ever changes by
        // display. Another display means another surface.
        self.bridge.close();
        self.bridge.open(&plan.monitor_name, VideoFit::default())
    }

    fn close(&mut self) {
        if self.open {
            self.bridge.close();
            self.open = false;
        }
        self.set_keep_awake(false);
    }

    fn is_open(&self) -> bool {
        self.open
    }

    fn player(&mut self, slot: Slot, command: &PlayerCommand) -> Result<(), BackendError> {
        self.bridge.player(slot, command);
        Ok(())
    }

    fn show_slot(&mut self, slot: Slot) -> Result<(), BackendError> {
        self.bridge.show_slot(slot);
        Ok(())
    }

    fn set_brightness(&mut self, value: f64) -> Result<(), BackendError> {
        self.bridge.set_brightness(value);
        Ok(())
    }

    fn set_fit(&mut self, fit: VideoFit) -> Result<(), BackendError> {
        self.bridge.set_fit(fit);
        Ok(())
    }

    fn show_image(&mut self, slot: Slot, path: Option<&str>) -> Result<(), BackendError> {
        self.bridge.show_image(slot, path);
        Ok(())
    }

    fn poll(&mut self, max_wait: Duration) -> Vec<BackendEvent> {
        let mut events = Vec::new();
        match self.events.recv_timeout(max_wait) {
            Ok(event) => events.push(event),
            Err(RecvTimeoutError::Timeout) | Err(RecvTimeoutError::Disconnected) => {}
        }
        while let Ok(event) = self.events.try_recv() {
            events.push(event);
        }
        for event in &events {
            match event {
                BackendEvent::DualPlayers { available, .. } => self.dual = *available,
                // The native side tore the surface down by itself.
                BackendEvent::Closed => self.open = false,
                _ => {}
            }
        }
        coalesce_time_positions(events)
    }

    fn dual_players(&self) -> bool {
        self.dual
    }

    fn auto_display(&self) -> bool {
        true
    }

    fn polls_while_closed(&self) -> bool {
        true
    }

    fn opens_without_content(&self) -> bool {
        true
    }

    fn content_changed(&mut self, has_content: bool) {
        self.has_content = has_content;
        if self.open {
            self.set_keep_awake(has_content);
        }
    }
}

#[cfg(test)]
pub(crate) mod fake {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// What the fake bridge was asked, in order, as text: easy to assert.
    #[derive(Clone, Default)]
    pub struct FakeBridge {
        pub calls: Arc<Mutex<Vec<String>>>,
        pub unavailable: Option<String>,
        pub dual: bool,
    }

    impl FakeBridge {
        pub fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }
        fn record(&self, call: String) {
            self.calls.lock().unwrap().push(call);
        }
    }

    impl NativeVideoBridge for FakeBridge {
        fn open(&self, display: &str, fit: VideoFit) -> Result<(), BackendError> {
            if let Some(reason) = &self.unavailable {
                return Err(BackendError::Unavailable(reason.clone()));
            }
            self.record(format!("open {display} {fit:?}"));
            Ok(())
        }
        fn close(&self) {
            self.record("close".into());
        }
        fn player(&self, slot: Slot, command: &PlayerCommand) {
            self.record(format!("player {slot:?} {command:?}"));
        }
        fn show_slot(&self, slot: Slot) {
            self.record(format!("show {slot:?}"));
        }
        fn set_brightness(&self, value: f64) {
            self.record(format!("brightness {value}"));
        }
        fn set_fit(&self, fit: VideoFit) {
            self.record(format!("fit {fit:?}"));
        }
        fn show_image(&self, slot: Slot, path: Option<&str>) {
            self.record(format!("image {slot:?} {path:?}"));
        }
        fn dual_players(&self) -> bool {
            self.dual
        }
        fn set_keep_awake(&self, on: bool) {
            self.record(format!("keep-awake {on}"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fake::FakeBridge;
    use super::*;
    use crate::monitors::MonitorInfo;
    use crate::output::{OutputCommand, OutputController, OutputState};

    fn external(name: &str) -> MonitorInfo {
        MonitorInfo {
            name: name.into(),
            width: 1920,
            height: 1080,
            x: 0,
            y: 0,
            is_primary: false,
        }
    }

    fn enabled() -> VideoOutputSettings {
        VideoOutputSettings {
            enabled: true,
            ..Default::default()
        }
    }

    fn backend(bridge: FakeBridge) -> (NativeOutputBackend<FakeBridge>, NativeEventSink) {
        let (sink, events) = native_event_channel();
        (NativeOutputBackend::new(bridge, events), sink)
    }

    fn ready(
        bridge: FakeBridge,
    ) -> (
        OutputController<NativeOutputBackend<FakeBridge>>,
        NativeEventSink,
    ) {
        let (backend, sink) = backend(bridge);
        let mut controller = OutputController::new(backend);
        controller.handle(OutputCommand::SetContent(true));
        controller.handle(OutputCommand::ApplySettings(enabled()));
        sink.send(BackendEvent::DisplaysChanged(vec![external("HDMI")]));
        let events = controller_poll(&mut controller);
        controller.absorb(events);
        (controller, sink)
    }

    fn controller_poll(
        controller: &mut OutputController<NativeOutputBackend<FakeBridge>>,
    ) -> Vec<BackendEvent> {
        controller.backend_mut().poll(Duration::from_millis(1))
    }

    /// C2: every output command becomes the expected bridge call.
    #[test]
    fn each_command_becomes_the_expected_bridge_call() {
        let bridge = FakeBridge {
            dual: true,
            ..Default::default()
        };
        let (mut controller, _sink) = ready(bridge.clone());
        assert_eq!(controller.status().state, OutputState::Ready);
        controller.handle(OutputCommand::Player {
            slot: Slot::A,
            command: PlayerCommand::Load {
                path: "/v.mp4".into(),
                start_seconds: 2.0,
                paused: true,
            },
        });
        controller.handle(OutputCommand::Player {
            slot: Slot::A,
            command: PlayerCommand::SetSpeed(1.01),
        });
        controller.handle(OutputCommand::ShowSlot(Slot::B));
        controller.handle(OutputCommand::SetBrightness(-100.0));
        controller.handle(OutputCommand::SetFit(Some(VideoFit::Cover)));
        controller.handle(OutputCommand::ShowIdle);
        let calls = bridge.calls();
        assert_eq!(calls[0], "open HDMI Contain");
        assert!(calls.contains(&"keep-awake true".to_string()));
        let tail: Vec<&str> = calls
            .iter()
            .rev()
            .take(6)
            .rev()
            .map(String::as_str)
            .collect();
        assert_eq!(
            tail,
            [
                "player A Load { path: \"/v.mp4\", start_seconds: 2.0, paused: true }",
                "player A SetSpeed(1.01)",
                "show B",
                "brightness -100",
                "fit Cover",
                "image B None",
            ]
        );
        assert!(controller.status().dual_players);
    }

    /// C2: `poll` returns what the native side pushed, in order.
    #[test]
    fn poll_returns_the_injected_events() {
        let (mut backend, sink) = backend(FakeBridge::default());
        sink.send(BackendEvent::FileLoaded { slot: Slot::A });
        sink.send(BackendEvent::PlaybackRestart { slot: Slot::A });
        sink.send(BackendEvent::LoadFailed {
            slot: Slot::B,
            reason: "códec".into(),
        });
        assert_eq!(
            backend.poll(Duration::from_millis(1)),
            vec![
                BackendEvent::FileLoaded { slot: Slot::A },
                BackendEvent::PlaybackRestart { slot: Slot::A },
                BackendEvent::LoadFailed {
                    slot: Slot::B,
                    reason: "códec".into()
                },
            ]
        );
        assert!(backend.poll(Duration::from_millis(1)).is_empty());
    }

    /// C2: at 60 Hz only the newest `TimePos` of each slot survives a poll.
    #[test]
    fn time_positions_are_coalesced_per_slot() {
        let (mut backend, sink) = backend(FakeBridge::default());
        for frame in 0..60 {
            sink.send(BackendEvent::TimePos {
                slot: Slot::A,
                seconds: f64::from(frame) / 60.0,
            });
        }
        sink.send(BackendEvent::PlaybackRestart { slot: Slot::B });
        sink.send(BackendEvent::TimePos {
            slot: Slot::B,
            seconds: 7.0,
        });
        sink.send(BackendEvent::TimePos {
            slot: Slot::B,
            seconds: 7.5,
        });
        assert_eq!(
            backend.poll(Duration::from_millis(1)),
            vec![
                BackendEvent::TimePos {
                    slot: Slot::A,
                    seconds: 59.0 / 60.0
                },
                BackendEvent::PlaybackRestart { slot: Slot::B },
                BackendEvent::TimePos {
                    slot: Slot::B,
                    seconds: 7.5
                },
            ]
        );
    }

    /// C4: no native part → `Unavailable(reason)`, nothing panics, and the
    /// commands that follow are dropped quietly.
    #[test]
    fn an_unavailable_bridge_leaves_the_output_unavailable() {
        let bridge = FakeBridge {
            unavailable: Some("VideoOutputBridge no está en esta build".into()),
            ..Default::default()
        };
        let (mut controller, _sink) = ready(bridge.clone());
        assert!(matches!(
            controller.status().state,
            OutputState::Unavailable(ref reason) if reason.contains("VideoOutputBridge")
        ));
        controller.handle(OutputCommand::Player {
            slot: Slot::A,
            command: PlayerCommand::SetPause(false),
        });
        controller.handle(OutputCommand::SetBrightness(-100.0));
        assert!(bridge.calls().is_empty());
    }

    #[test]
    fn a_native_dual_players_report_overrides_the_initial_guess() {
        let (mut controller, sink) = ready(FakeBridge {
            dual: true,
            ..Default::default()
        });
        assert!(controller.status().dual_players);
        sink.send(BackendEvent::DualPlayers {
            available: false,
            note: Some("un solo reproductor".into()),
        });
        let events = controller_poll(&mut controller);
        controller.absorb(events);
        assert!(!controller.status().dual_players);
        assert!(!controller.backend().dual_players());
    }

    /// Paso 04/05 C6: a corrupt file is reported by the native player after
    /// the load was queued; the status shows it and the next good clip
    /// recovers.
    #[test]
    fn a_native_load_failure_errors_and_the_next_clip_recovers() {
        let (mut controller, sink) = ready(FakeBridge::default());
        let load = |path: &str| OutputCommand::Player {
            slot: Slot::A,
            command: PlayerCommand::Load {
                path: path.into(),
                start_seconds: 0.0,
                paused: false,
            },
        };
        controller.handle(load("/broken.mov"));
        sink.send(BackendEvent::LoadFailed {
            slot: Slot::A,
            reason: "The operation could not be completed".into(),
        });
        let events = controller_poll(&mut controller);
        controller.absorb(events);
        assert!(matches!(
            controller.status().state,
            OutputState::Error(ref reason) if reason.contains("could not be completed")
        ));
        assert_eq!(controller.status().player(Slot::A).file, None);
        assert!(controller.status().player(Slot::A).last_error.is_some());

        controller.handle(load("/ok.mp4"));
        assert_eq!(controller.status().state, OutputState::Ready);
        assert_eq!(
            controller.status().player(Slot::A).file.as_deref(),
            Some("/ok.mp4")
        );
    }

    fn last_keep_awake(bridge: &FakeBridge) -> Option<String> {
        bridge
            .calls()
            .into_iter()
            .rev()
            .find(|call| call.starts_with("keep-awake"))
    }

    /// Paso 06 C3: the keep-awake is asked when the output opens with the
    /// session's video and released when it closes or the video goes.
    #[test]
    fn the_keep_awake_follows_the_output_with_content() {
        let bridge = FakeBridge::default();
        let (mut controller, sink) = ready(bridge.clone());
        assert_eq!(
            bridge
                .calls()
                .iter()
                .filter(|call| call.starts_with("keep-awake"))
                .collect::<Vec<_>>(),
            ["keep-awake true"]
        );
        // The projector is unplugged: closed, released.
        sink.send(BackendEvent::DisplaysChanged(Vec::new()));
        let events = controller_poll(&mut controller);
        controller.absorb(events);
        assert_eq!(
            bridge.calls().last().map(String::as_str),
            Some("keep-awake false")
        );
        // Back: asked again.
        sink.send(BackendEvent::DisplaysChanged(vec![external("HDMI")]));
        let events = controller_poll(&mut controller);
        controller.absorb(events);
        assert_eq!(last_keep_awake(&bridge).as_deref(), Some("keep-awake true"));
        // Output switched off in the settings: released.
        controller.handle(OutputCommand::ApplySettings(VideoOutputSettings::default()));
        assert_eq!(
            last_keep_awake(&bridge).as_deref(),
            Some("keep-awake false")
        );
    }

    /// Found on the Android emulator: with the display on "automatic",
    /// unplugging the projector said "connect a projector" instead of
    /// "display disconnected".
    #[test]
    fn an_automatic_display_that_goes_away_is_lost_not_missing() {
        let (mut controller, sink) = ready(FakeBridge::default());
        assert_eq!(controller.status().state, OutputState::Ready);
        sink.send(BackendEvent::DisplaysChanged(Vec::new()));
        let events = controller_poll(&mut controller);
        controller.absorb(events);
        assert_eq!(controller.status().state, OutputState::DisplayLost);
        // Still lost while nothing comes back (another replan on the way).
        controller.handle(OutputCommand::SetBrightness(-100.0));
        controller.handle(OutputCommand::ApplySettings(enabled()));
        assert_eq!(controller.status().state, OutputState::DisplayLost);
        sink.send(BackendEvent::DisplaysChanged(vec![external("HDMI")]));
        let events = controller_poll(&mut controller);
        controller.absorb(events);
        assert_eq!(controller.status().state, OutputState::Ready);
    }

    #[test]
    fn with_no_projector_ever_plugged_it_asks_for_one() {
        let (backend, _sink) = backend(FakeBridge::default());
        let mut controller = OutputController::new(backend);
        controller.handle(OutputCommand::SetContent(true));
        controller.handle(OutputCommand::ApplySettings(enabled()));
        assert_eq!(controller.status().state, OutputState::NoDisplay);
    }

    #[test]
    fn losing_the_video_releases_the_keep_awake_but_keeps_the_idle_screen() {
        let bridge = FakeBridge::default();
        let (mut controller, _sink) = ready(bridge.clone());
        controller.handle(OutputCommand::SetContent(false));
        let calls = bridge.calls();
        assert_eq!(last_keep_awake(&bridge).as_deref(), Some("keep-awake false"));
        assert!(!calls.contains(&"close".to_string()));
        assert_eq!(controller.status().state, OutputState::Ready);
    }

    #[test]
    fn switching_the_output_off_closes_it_and_releases_the_keep_awake() {
        let bridge = FakeBridge::default();
        let (mut controller, _sink) = ready(bridge.clone());
        controller.handle(OutputCommand::ApplySettings(VideoOutputSettings::default()));
        let calls = bridge.calls();
        assert_eq!(&calls[calls.len() - 2..], ["close", "keep-awake false"]);
        assert_eq!(controller.status().state, OutputState::Disabled);
    }

    /// A phone opens the output for its idle screen even without video in
    /// the session (otherwise the system mirrors the phone's UI on the
    /// projector), but never keeps the phone awake for it.
    #[test]
    fn without_video_a_phone_shows_the_idle_screen_and_may_sleep() {
        let bridge = FakeBridge::default();
        let (backend, sink) = backend(bridge.clone());
        let mut controller = OutputController::new(backend);
        controller.handle(OutputCommand::ApplySettings(enabled()));
        sink.send(BackendEvent::DisplaysChanged(vec![external("HDMI")]));
        let events = controller_poll(&mut controller);
        controller.absorb(events);
        assert_eq!(controller.status().state, OutputState::Ready);
        let calls = bridge.calls();
        assert_eq!(calls.first().map(String::as_str), Some("open HDMI Contain"));
        assert!(!calls.iter().any(|call| call == "keep-awake true"));
        controller.handle(OutputCommand::ShowIdle);
        assert_eq!(
            bridge.calls().last().map(String::as_str),
            Some("image A None")
        );
    }
}
