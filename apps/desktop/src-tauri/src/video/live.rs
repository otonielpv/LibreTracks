//! Live control of the video output (paso 13): emergency black, fade to
//! black, forced idle screen and output on/off.
//!
//! The same four actions come from a keyboard shortcut, a MIDI-learn binding
//! and the remote; each path calls [`run`]. None touches the session lock.
//! Black and idle are volatile: they live in `VideoSystem`, are never saved,
//! and a restart starts with the picture. Every change is announced with
//! `video:live-state` so the badge shows "NEGRO" whoever pressed it.

use std::str::FromStr;
use std::time::Instant;

use libretracks_core::video_schedule::forced_black_amount;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::state::DesktopState;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VideoLiveAction {
    /// Cut to black; pressed again, back to the picture.
    ToggleBlack,
    /// The same with the configured fade (1 s by default) both ways.
    ToggleFadeBlack,
    /// Show the idle screen instead of the timeline's video.
    ToggleIdle,
    /// Open or close the output window (persisted, like the settings switch).
    ToggleOutput,
}

impl FromStr for VideoLiveAction {
    type Err = String;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "black" => Ok(Self::ToggleBlack),
            "fadeBlack" => Ok(Self::ToggleFadeBlack),
            "idle" => Ok(Self::ToggleIdle),
            "output" => Ok(Self::ToggleOutput),
            other => Err(format!("acción de vídeo desconocida: {other}")),
        }
    }
}

impl VideoLiveAction {
    /// MIDI-learn binding keys (`action:video_*`).
    pub fn from_midi_key(key: &str) -> Option<Self> {
        match key {
            "action:video_black" => Some(Self::ToggleBlack),
            "action:video_fade_black" => Some(Self::ToggleFadeBlack),
            "action:video_idle" => Some(Self::ToggleIdle),
            "action:video_output" => Some(Self::ToggleOutput),
            _ => None,
        }
    }
}

/// Forced black and idle. `Copy` so readers never hold the lock.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LiveState {
    /// Black is wanted (the target of the current move).
    pub black: bool,
    /// Where the last move started, 0–1, when, and how long it lasts.
    black_from: f64,
    black_changed_at: Option<Instant>,
    black_fade_seconds: f64,
    pub forced_idle: bool,
}

impl Default for LiveState {
    fn default() -> Self {
        Self {
            black: false,
            black_from: 0.0,
            black_changed_at: None,
            black_fade_seconds: 0.0,
            forced_idle: false,
        }
    }
}

impl LiveState {
    /// 0 = picture, 1 = black, in between while fading.
    pub fn black_amount(&self, now: Instant) -> f64 {
        let target = if self.black { 1.0 } else { 0.0 };
        match self.black_changed_at {
            None => target,
            Some(at) => forced_black_amount(
                self.black_from,
                target,
                now.saturating_duration_since(at).as_secs_f64(),
                self.black_fade_seconds,
            ),
        }
    }

    /// Flip the black, from wherever a running fade has got to.
    pub fn toggle_black(&mut self, now: Instant, fade_seconds: f64) {
        self.black_from = self.black_amount(now);
        self.black = !self.black;
        self.black_changed_at = Some(now);
        self.black_fade_seconds = fade_seconds;
    }
}

/// What the UI shows: the badge's "NEGRO", the idle and output toggles.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VideoLiveStateDto {
    pub forced_black: bool,
    pub forced_idle: bool,
    pub output_enabled: bool,
}

pub fn state_dto(app: &AppHandle) -> VideoLiveStateDto {
    let state = app.state::<DesktopState>();
    let live = state.video.live();
    VideoLiveStateDto {
        forced_black: live.black,
        forced_idle: live.forced_idle,
        output_enabled: state.video.settings().enabled,
    }
}

/// Apply one action and announce the new state.
pub fn run(app: &AppHandle, action: VideoLiveAction) -> Result<VideoLiveStateDto, String> {
    let state = app.state::<DesktopState>();
    let now = Instant::now();
    match action {
        VideoLiveAction::ToggleBlack => {
            state.video.update_live(|live| live.toggle_black(now, 0.0));
        }
        VideoLiveAction::ToggleFadeBlack => {
            let fade = state.video.settings().black_fade_seconds();
            state.video.update_live(|live| live.toggle_black(now, fade));
        }
        VideoLiveAction::ToggleIdle => {
            state
                .video
                .update_live(|live| live.forced_idle = !live.forced_idle);
        }
        VideoLiveAction::ToggleOutput => {
            let mut settings = state.video.settings();
            settings.enabled = !settings.enabled;
            crate::commands::video::persist_and_apply_output_settings(app, settings)?;
        }
    }
    let dto = state_dto(app);
    let _ = app.emit("video:live-state", dto);
    Ok(dto)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn actions_parse_from_the_ui_and_from_midi() {
        assert_eq!("black".parse(), Ok(VideoLiveAction::ToggleBlack));
        assert_eq!("fadeBlack".parse(), Ok(VideoLiveAction::ToggleFadeBlack));
        assert!("nope".parse::<VideoLiveAction>().is_err());
        assert_eq!(
            VideoLiveAction::from_midi_key("action:video_black"),
            Some(VideoLiveAction::ToggleBlack)
        );
        assert_eq!(VideoLiveAction::from_midi_key("action:play"), None);
    }

    #[test]
    fn a_fade_to_black_reverses_from_where_it_was() {
        let start = Instant::now();
        let mut live = LiveState::default();
        assert_eq!(live.black_amount(start), 0.0);
        live.toggle_black(start, 1.0);
        let half = start + Duration::from_millis(500);
        assert!((live.black_amount(half) - 0.5).abs() < 0.01);
        // Pressed again half way: back to the picture from 0.5, not from 1.
        live.toggle_black(half, 1.0);
        assert!((live.black_amount(half) - 0.5).abs() < 0.01);
        assert_eq!(live.black_amount(half + Duration::from_secs(2)), 0.0);
        // A plain black is a cut.
        live.toggle_black(half, 0.0);
        assert_eq!(live.black_amount(half), 1.0);
    }
}
