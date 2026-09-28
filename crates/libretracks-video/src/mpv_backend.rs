//! The real output backend: libmpv players on the platform surface.
//!
//! | Platform | Surface |
//! | --- | --- |
//! | Windows | our own non-activating window with one child per slot, mpv embedded with `wid` (paso 01, C3/C8) |
//! | Linux | mpv's own window, fullscreen on the monitor by `fs-screen-name`; one player serves both slots. Not tested on Linux yet |
//! | macOS | our own non-activating `NSPanel` with one OpenGL view per slot; mpv draws through its render API on a thread per slot (`surface_macos.rs`, paso 15). Persistent: closing hides it |
//!
//! Every player runs with `ao=null` and no audio decoding: the audio of a
//! video is extracted to a normal audio clip (paso 11), so there are never two
//! sources of the same sound.
//!
//! A double-click on the output toggles fullscreen <-> window (as in Ableton).
//! Where mpv owns the window that gets the clicks (Windows, Linux) it reports
//! it through a `keybind` + `script-message`; on macOS our own view does.

use std::sync::Arc;
use std::time::Duration;

use libretracks_core::VideoFit;

use crate::monitors::SurfacePlan;
use crate::mpv::{EndFileReason, Mpv, MpvEvent, MpvLibrary, ObserveAs, PropertyValue};
use crate::output::{BackendError, BackendEvent, OutputBackend, PlayerCommand, Slot};
use crate::settings::{fit_mpv_options, VideoOutputSettings};

const PROP_TIME_POS: u64 = 1;
const PROP_FRAME_DROPS: u64 = 2;
const PROP_HWDEC: u64 = 3;

/// `script-message` the double-click binding sends.
const TOGGLE_MESSAGE: &str = "libretracks-toggle-fullscreen";

fn failed(error: crate::VideoError) -> BackendError {
    BackendError::Failed(error.to_string())
}

fn slots() -> [Slot; 2] {
    [Slot::A, Slot::B]
}

pub struct MpvOutputBackend {
    api: Arc<MpvLibrary>,
    #[cfg(windows)]
    surface: Option<crate::surface_win32::Win32Surface>,
    /// macOS: the panel outlives open/close (see `surface_macos.rs`).
    #[cfg(target_os = "macos")]
    surface: Option<crate::surface_macos::MacSurface>,
    #[cfg(target_os = "macos")]
    main_thread: Option<crate::surface_macos::MainThread>,
    players: [Option<Mpv>; 2],
    /// Linux: one player (mpv's own window) serves both slots.
    single_player: bool,
    open: bool,
}

impl MpvOutputBackend {
    pub fn new(api: Arc<MpvLibrary>) -> Self {
        Self {
            api,
            #[cfg(windows)]
            surface: None,
            #[cfg(target_os = "macos")]
            surface: None,
            #[cfg(target_os = "macos")]
            main_thread: None,
            players: [None, None],
            single_player: !cfg!(any(windows, target_os = "macos")),
            open: false,
        }
    }

    /// macOS: AppKit calls go through `main_thread` (the app's main thread;
    /// Tauri owns it). Without it the output reports itself unavailable.
    #[cfg(target_os = "macos")]
    pub fn new_macos(api: Arc<MpvLibrary>, main_thread: crate::surface_macos::MainThread) -> Self {
        let mut backend = Self::new(api);
        backend.main_thread = Some(main_thread);
        backend
    }

    #[cfg(target_os = "macos")]
    fn open_macos(&mut self, plan: &SurfacePlan, settings: &VideoOutputSettings) -> Result<(), BackendError> {
        use crate::surface_macos::MacSurface;
        let main = self.main_thread.clone().ok_or_else(|| {
            BackendError::Unavailable("la salida de vídeo de macOS necesita el hilo principal de la app".into())
        })?;
        let render_api = crate::render::RenderApi::load(&self.api)
            .map(Arc::new)
            .ok_or_else(|| BackendError::Unavailable("esta libmpv no tiene la API de render".into()))?;

        // The panel is persistent and restyles itself between modes.
        match self.surface.as_mut() {
            Some(surface) => {
                surface.apply(plan);
                surface.show();
            }
            None => {
                self.surface = Some(MacSurface::create(plan, main, "LibreTracks — Vídeo").map_err(BackendError::Failed)?);
            }
        }
        for index in 0..2 {
            let player = self.new_player(settings, &[("vo", "libmpv".into()), ("force-window", "no".into())])?;
            let surface = self.surface.as_mut().expect("created above");
            surface
                .attach(index, &player, Arc::clone(&render_api))
                .map_err(BackendError::Failed)?;
            self.players[index] = Some(player);
        }
        if let Some(surface) = self.surface.as_mut() {
            surface.show_slot(0);
        }
        Ok(())
    }

    fn slot_index(&self, slot: Slot) -> usize {
        if self.single_player {
            0
        } else {
            match slot {
                Slot::A => 0,
                Slot::B => 1,
            }
        }
    }

    fn mpv_for(&self, slot: Slot) -> Result<&Mpv, BackendError> {
        self.players[self.slot_index(slot)]
            .as_ref()
            .ok_or_else(|| BackendError::Failed("la salida de vídeo no está abierta".into()))
    }

    fn new_player(&self, settings: &VideoOutputSettings, surface_options: &[(&str, String)]) -> Result<Mpv, BackendError> {
        let mpv = Mpv::create(&self.api).map_err(failed)?;
        let base: [(&str, &str); 16] = [
            ("config", "no"),
            ("terminal", "no"),
            ("osd-level", "0"),
            ("input-default-bindings", "no"),
            ("input-vo-keyboard", "no"),
            // Pointer events reach mpv only for the double-click binding
            // below; nothing else is bound.
            ("input-cursor", "yes"),
            ("cursor-autohide", "always"),
            ("ao", "null"),
            ("audio", "no"),
            ("sub", "no"),
            ("idle", "yes"),
            ("keep-open", "always"),
            ("force-window", "yes"),
            ("image-display-duration", "inf"),
            ("hr-seek", "yes"),
            ("hwdec", settings.hwdec.mpv_value()),
        ];
        for (name, value) in base {
            mpv.set_option(name, value).map_err(failed)?;
        }
        // The script switches do not exist without Lua/JavaScript (our macOS
        // build), where scripts are off anyway.
        for (name, value) in crate::mpv::SCRIPT_OPTIONS {
            mpv.set_option_if_known(name, value).map_err(failed)?;
        }
        // Newer mpv (0.38+): an older libmpv (the system one on Linux) lacks
        // them or reads `background` as a colour and rejects "color". Our
        // surfaces never take the focus, and mpv's background is black by
        // default, so any failure here is harmless.
        for (name, value) in [
            ("focus-on", "never"),
            ("background", "color"),
            ("background-color", "#000000"),
        ] {
            let _ = mpv.set_option(name, value);
        }
        for (name, value) in fit_mpv_options(settings.fit) {
            mpv.set_option(name, value).map_err(failed)?;
        }
        for (name, value) in surface_options {
            mpv.set_option(name, value).map_err(failed)?;
        }
        mpv.initialize().map_err(failed)?;
        // Best effort: without it (an old libmpv) the mode is still changed
        // from the settings.
        let _ = mpv.command(&["keybind", "MBTN_LEFT_DBL", &format!("script-message {TOGGLE_MESSAGE}")]);
        mpv.observe_property(PROP_TIME_POS, "time-pos", ObserveAs::Double)
            .map_err(failed)?;
        mpv.observe_property(PROP_FRAME_DROPS, "frame-drop-count", ObserveAs::Int)
            .map_err(failed)?;
        mpv.observe_property(PROP_HWDEC, "hwdec-current", ObserveAs::String)
            .map_err(failed)?;
        Ok(mpv)
    }

    fn each_player(&self, mut action: impl FnMut(&Mpv) -> Result<(), crate::VideoError>) -> Result<(), BackendError> {
        for player in self.players.iter().flatten() {
            action(player).map_err(failed)?;
        }
        Ok(())
    }

    fn translate(slot: Slot, event: MpvEvent) -> Option<BackendEvent> {
        match event {
            MpvEvent::PropertyChange { id, value, .. } => match (id, value) {
                (PROP_TIME_POS, PropertyValue::Double(seconds)) => {
                    Some(BackendEvent::TimePos { slot, seconds })
                }
                (PROP_FRAME_DROPS, PropertyValue::Int(count)) => {
                    Some(BackendEvent::FrameDrops { slot, count })
                }
                (PROP_HWDEC, PropertyValue::String(name)) => Some(BackendEvent::Hwdec { slot, name }),
                _ => None,
            },
            MpvEvent::PlaybackRestart => Some(BackendEvent::PlaybackRestart { slot }),
            MpvEvent::FileLoaded => Some(BackendEvent::FileLoaded { slot }),
            MpvEvent::EndFile(EndFileReason::Error(reason)) => {
                Some(BackendEvent::LoadFailed { slot, reason })
            }
            MpvEvent::ClientMessage(args) if args.first().map(String::as_str) == Some(TOGGLE_MESSAGE) => {
                Some(BackendEvent::ToggleFullscreen)
            }
            _ => None,
        }
    }
}

impl OutputBackend for MpvOutputBackend {
    fn open(&mut self, plan: &SurfacePlan, settings: &VideoOutputSettings) -> Result<(), BackendError> {
        self.close();

        #[cfg(target_os = "macos")]
        if let Err(error) = self.open_macos(plan, settings) {
            self.close();
            return Err(error);
        }

        #[cfg(windows)]
        {
            let surface = crate::surface_win32::Win32Surface::create(plan, "LibreTracks — Vídeo")
                .map_err(BackendError::Failed)?;
            for index in 0..2 {
                let wid = surface.slot_wid(index).to_string();
                self.players[index] = Some(self.new_player(settings, &[("wid", wid)])?);
            }
            self.surface = Some(surface);
        }

        #[cfg(not(any(windows, target_os = "macos")))]
        {
            // Window geometry always, so leaving fullscreen (double-click)
            // lands on a sensible window on the same display.
            let geometry = if plan.fullscreen {
                // Half the display, centred: what window mode plans too.
                crate::monitors::SurfaceRect {
                    x: plan.rect.x + plan.rect.width as i32 / 4,
                    y: plan.rect.y + plan.rect.height as i32 / 4,
                    width: plan.rect.width / 2,
                    height: plan.rect.height / 2,
                }
            } else {
                plan.rect
            };
            let options: Vec<(&str, String)> = vec![
                ("fs", if plan.fullscreen { "yes" } else { "no" }.into()),
                ("fs-screen-name", plan.monitor_name.clone()),
                ("screen-name", plan.monitor_name.clone()),
                ("ontop", if plan.on_top { "yes" } else { "no" }.into()),
                (
                    "geometry",
                    format!("{}x{}+{}+{}", geometry.width, geometry.height, geometry.x, geometry.y),
                ),
            ];
            self.players[0] = Some(self.new_player(settings, &options)?);
        }

        self.open = true;
        Ok(())
    }

    fn reposition(&mut self, plan: &SurfacePlan) -> Result<(), BackendError> {
        #[cfg(windows)]
        if let Some(surface) = self.surface.as_mut() {
            surface.apply(plan);
            return Ok(());
        }
        #[cfg(target_os = "macos")]
        if let Some(surface) = self.surface.as_mut() {
            surface.apply(plan);
            return Ok(());
        }
        // Linux: mpv's own window; it remembers its window geometry across
        // fullscreen, so only the fullscreen screen, the state and on-top move.
        #[cfg(not(any(windows, target_os = "macos")))]
        if let Some(player) = &self.players[0] {
            player
                .set_property_string("fs-screen-name", &plan.monitor_name)
                .map_err(failed)?;
            player.set_property_flag("ontop", plan.on_top).map_err(failed)?;
            player
                .set_property_flag("fullscreen", plan.fullscreen)
                .map_err(failed)?;
        }
        let _ = plan;
        Ok(())
    }

    fn close(&mut self) {
        // macOS: stop drawing first — each render context must be freed
        // before its player is destroyed (render.h) — and keep the panel.
        #[cfg(target_os = "macos")]
        if let Some(surface) = self.surface.as_mut() {
            surface.detach(0);
            surface.detach(1);
        }
        // Players first: mpv must let go of its child windows before they die.
        self.players = [None, None];
        #[cfg(windows)]
        {
            self.surface = None;
        }
        #[cfg(target_os = "macos")]
        if let Some(surface) = self.surface.as_mut() {
            surface.hide();
        }
        self.open = false;
    }

    fn is_open(&self) -> bool {
        self.open
    }

    fn player(&mut self, slot: Slot, command: &PlayerCommand) -> Result<(), BackendError> {
        let player = self.mpv_for(slot)?;
        match command {
            PlayerCommand::Load {
                path,
                start_seconds,
                paused,
            } => {
                player.set_property_flag("pause", *paused).map_err(failed)?;
                player
                    .set_property_string("start", &format!("{:.6}", start_seconds.max(0.0)))
                    .map_err(failed)?;
                player.command(&["loadfile", path, "replace"]).map_err(failed)?;
            }
            PlayerCommand::Seek { seconds } => {
                player
                    .command_async(0, &["seek", &format!("{:.6}", seconds.max(0.0)), "absolute+exact"])
                    .map_err(failed)?;
            }
            PlayerCommand::SetPause(paused) => {
                player.set_property_flag("pause", *paused).map_err(failed)?;
            }
            PlayerCommand::SetSpeed(speed) => {
                player
                    .set_property_f64("speed", speed.clamp(0.01, 100.0))
                    .map_err(failed)?;
            }
            PlayerCommand::Stop => {
                player.command(&["stop"]).map_err(failed)?;
            }
        }
        Ok(())
    }

    fn show_slot(&mut self, slot: Slot) -> Result<(), BackendError> {
        #[cfg(windows)]
        if let Some(surface) = &self.surface {
            surface.show_slot(self.slot_index(slot));
        }
        #[cfg(target_os = "macos")]
        {
            let index = self.slot_index(slot);
            if let Some(surface) = self.surface.as_mut() {
                surface.show_slot(index);
            }
        }
        let _ = slot;
        Ok(())
    }

    fn set_brightness(&mut self, value: f64) -> Result<(), BackendError> {
        self.each_player(|player| player.set_property_f64("brightness", value))
    }

    fn set_fit(&mut self, fit: VideoFit) -> Result<(), BackendError> {
        self.each_player(|player| {
            for (name, value) in fit_mpv_options(fit) {
                player.set_property_string(name, value)?;
            }
            Ok(())
        })
    }

    fn show_image(&mut self, slot: Slot, path: Option<&str>) -> Result<(), BackendError> {
        let player = self.mpv_for(slot)?;
        match path {
            Some(path) => {
                player.set_property_string("start", "0").map_err(failed)?;
                player.set_property_flag("pause", false).map_err(failed)?;
                player.command(&["loadfile", path, "replace"]).map_err(failed)
            }
            None => player.command(&["stop"]).map_err(failed),
        }
    }

    fn dual_players(&self) -> bool {
        !self.single_player
    }

    fn poll(&mut self, max_wait: Duration) -> Vec<BackendEvent> {
        let mut events = Vec::new();
        let player_count = if self.single_player { 1 } else { 2 };
        for (index, slot) in slots().into_iter().enumerate().take(player_count) {
            let Some(player) = &self.players[index] else {
                continue;
            };
            // Block on the first player only; drain the other.
            let mut wait = if index == 0 { max_wait.as_secs_f64() } else { 0.0 };
            #[cfg(target_os = "macos")]
            if index == 0 && self.surface.as_ref().is_some_and(|surface| surface.take_double_click()) {
                events.push(BackendEvent::ToggleFullscreen);
                wait = 0.0;
            }
            while let Some(event) = player.wait_event(wait) {
                wait = 0.0;
                if let Some(event) = Self::translate(slot, event) {
                    events.push(event);
                }
            }
        }
        if self.single_player {
            // Mirror slot A's events to B so a swap on Linux sees the same
            // (single) player.
            let mirrored: Vec<_> = events
                .iter()
                .map(|event| match event.clone() {
                    BackendEvent::TimePos { seconds, .. } => BackendEvent::TimePos {
                        slot: Slot::B,
                        seconds,
                    },
                    other => other,
                })
                .filter(|event| matches!(event, BackendEvent::TimePos { slot: Slot::B, .. }))
                .collect();
            events.extend(mirrored);
        }
        events
    }
}

impl Drop for MpvOutputBackend {
    fn drop(&mut self) {
        self.close();
    }
}
