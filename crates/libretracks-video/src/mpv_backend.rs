//! The real output backend: libmpv players on the platform surface.
//!
//! | Platform | Surface |
//! | --- | --- |
//! | Windows | our own non-activating window with one child per slot, mpv embedded with `wid` (paso 01, C3/C8) |
//! | Linux | mpv's own window, fullscreen on the monitor by `fs-screen-name`; one player serves both slots. Not tested on Linux yet |
//! | macOS | not available yet: needs mpv's render API in an `NSWindow` |
//!
//! Every player runs with `ao=null` and no audio decoding: the audio of a
//! video is extracted to a normal audio clip (paso 11), so there are never two
//! sources of the same sound.

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
            players: [None, None],
            single_player: !cfg!(windows),
            open: false,
        }
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
        let base: [(&str, &str); 22] = [
            ("config", "no"),
            ("load-scripts", "no"),
            ("ytdl", "no"),
            ("terminal", "no"),
            ("osc", "no"),
            ("osd-level", "0"),
            ("input-default-bindings", "no"),
            ("input-vo-keyboard", "no"),
            ("input-cursor", "no"),
            ("cursor-autohide", "always"),
            ("ao", "null"),
            ("audio", "no"),
            ("sub", "no"),
            ("idle", "yes"),
            ("keep-open", "always"),
            ("force-window", "yes"),
            ("focus-on", "never"),
            ("background", "color"),
            ("background-color", "#000000"),
            ("image-display-duration", "inf"),
            ("hr-seek", "yes"),
            ("hwdec", settings.hwdec.mpv_value()),
        ];
        for (name, value) in base {
            mpv.set_option(name, value).map_err(failed)?;
        }
        for (name, value) in fit_mpv_options(settings.fit) {
            mpv.set_option(name, value).map_err(failed)?;
        }
        for (name, value) in surface_options {
            mpv.set_option(name, value).map_err(failed)?;
        }
        mpv.initialize().map_err(failed)?;
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
            _ => None,
        }
    }
}

impl OutputBackend for MpvOutputBackend {
    fn open(&mut self, plan: &SurfacePlan, settings: &VideoOutputSettings) -> Result<(), BackendError> {
        self.close();
        if cfg!(target_os = "macos") {
            return Err(BackendError::Unavailable(
                "la salida de vídeo aún no está disponible en macOS".into(),
            ));
        }

        #[cfg(windows)]
        {
            let surface = crate::surface_win32::Win32Surface::create(
                plan.rect,
                plan.fullscreen,
                "LibreTracks — Vídeo",
            )
            .map_err(BackendError::Failed)?;
            for index in 0..2 {
                let wid = surface.slot_wid(index).to_string();
                self.players[index] = Some(self.new_player(settings, &[("wid", wid)])?);
            }
            self.surface = Some(surface);
        }

        #[cfg(not(windows))]
        {
            let options: Vec<(&str, String)> = if plan.fullscreen {
                vec![
                    ("fs", "yes".into()),
                    ("fs-screen-name", plan.monitor_name.clone()),
                    ("screen-name", plan.monitor_name.clone()),
                    ("border", "no".into()),
                    ("ontop", "yes".into()),
                ]
            } else {
                vec![(
                    "geometry",
                    format!(
                        "{}x{}+{}+{}",
                        plan.rect.width, plan.rect.height, plan.rect.x, plan.rect.y
                    ),
                )]
            };
            self.players[0] = Some(self.new_player(settings, &options)?);
        }

        self.open = true;
        Ok(())
    }

    fn reposition(&mut self, plan: &SurfacePlan) -> Result<(), BackendError> {
        #[cfg(windows)]
        if let Some(surface) = &self.surface {
            surface.reposition(plan.rect);
            return Ok(());
        }
        #[cfg(not(windows))]
        if let Some(player) = &self.players[0] {
            if plan.fullscreen {
                player
                    .set_property_string("fs-screen-name", &plan.monitor_name)
                    .map_err(failed)?;
            }
        }
        let _ = plan;
        Ok(())
    }

    fn close(&mut self) {
        // Players first: mpv must let go of its child windows before they die.
        self.players = [None, None];
        #[cfg(windows)]
        {
            self.surface = None;
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

    fn poll(&mut self, max_wait: Duration) -> Vec<BackendEvent> {
        let mut events = Vec::new();
        let player_count = if self.single_player { 1 } else { 2 };
        for (index, slot) in slots().into_iter().enumerate().take(player_count) {
            let Some(player) = &self.players[index] else {
                continue;
            };
            // Block on the first player only; drain the other.
            let mut wait = if index == 0 { max_wait.as_secs_f64() } else { 0.0 };
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
