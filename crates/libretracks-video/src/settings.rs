//! Video output settings. They belong to the machine, not the song: the same
//! `.ltset` opens on the rehearsal laptop and on the stage laptop, each with
//! its own projector. Stored in `AppSettings` (desktop `infra/settings.rs`).
//!
//! Everything has a serde default, so a settings file from before video opens
//! with the output switched off.

use libretracks_core::VideoFit;
use serde::{Deserialize, Serialize};

/// A display, identified robustly: the OS name plus its geometry. The index
/// alone is useless (it changes when a monitor is plugged in) and the name
/// alone can move to another physical screen after a replug.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DisplayId {
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub x: i32,
    pub y: i32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum VideoOutputMode {
    #[default]
    Fullscreen,
    Window,
}

/// What the output shows when no clip is under the playhead.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum IdleScreen {
    #[default]
    Black,
    Image { path: String },
}

/// What the output shows while the transport is stopped.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum StoppedScreen {
    /// Hold the frame at the playhead (pre-rolled, so play starts on it).
    #[default]
    LastFrame,
    Idle,
    Black,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum HwDecMode {
    #[default]
    Auto,
    Off,
}

impl HwDecMode {
    /// Value for mpv's `hwdec` option.
    pub fn mpv_value(self) -> &'static str {
        match self {
            HwDecMode::Auto => "auto-safe",
            HwDecMode::Off => "no",
        }
    }
}

/// Range the latency compensation slider allows, in milliseconds.
pub const MIN_LATENCY_OFFSET_MS: i32 = -500;
pub const MAX_LATENCY_OFFSET_MS: i32 = 500;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VideoOutputSettings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub display: Option<DisplayId>,
    #[serde(default)]
    pub mode: VideoOutputMode,
    /// Fullscreen stays above every other window (the projector never shows
    /// a notification or another app). Off: it behaves like a normal window
    /// and other windows can come in front. Window mode is never on top.
    #[serde(default = "default_true")]
    pub fullscreen_on_top: bool,
    #[serde(default)]
    pub fit: VideoFit,
    #[serde(default)]
    pub idle: IdleScreen,
    #[serde(default)]
    pub when_stopped: StoppedScreen,
    /// Added to the picture's target time. Positive shows the picture
    /// earlier (makes up for a projector or TV that lags), negative later.
    /// Paso 09 calibrates it.
    #[serde(default)]
    pub latency_offset_ms: i32,
    #[serde(default)]
    pub hwdec: HwDecMode,
    /// Length of "fade to black" (paso 13); `None` = 1 s.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub black_fade_ms: Option<u32>,
}

fn default_true() -> bool {
    true
}

impl Default for VideoOutputSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            display: None,
            mode: VideoOutputMode::default(),
            fullscreen_on_top: true,
            fit: VideoFit::default(),
            idle: IdleScreen::default(),
            when_stopped: StoppedScreen::default(),
            latency_offset_ms: 0,
            hwdec: HwDecMode::default(),
            black_fade_ms: None,
        }
    }
}

impl VideoOutputSettings {
    pub fn black_fade_seconds(&self) -> f64 {
        f64::from(self.black_fade_ms.unwrap_or(1000).min(10_000)) / 1000.0
    }

    pub fn clamped(mut self) -> Self {
        self.latency_offset_ms = self
            .latency_offset_ms
            .clamp(MIN_LATENCY_OFFSET_MS, MAX_LATENCY_OFFSET_MS);
        self
    }
}

/// mpv options that implement a fit: `contain` keeps the aspect with bars,
/// `cover` keeps it and crops (`panscan=1`), `stretch` ignores it.
pub fn fit_mpv_options(fit: VideoFit) -> [(&'static str, &'static str); 2] {
    match fit {
        VideoFit::Contain => [("keepaspect", "yes"), ("panscan", "0")],
        VideoFit::Cover => [("keepaspect", "yes"), ("panscan", "1")],
        VideoFit::Stretch => [("keepaspect", "no"), ("panscan", "0")],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_old_settings_file_opens_with_video_off() {
        let settings: VideoOutputSettings = serde_json::from_str("{}").expect("parse");
        assert_eq!(settings, VideoOutputSettings::default());
        assert!(!settings.enabled);
        assert_eq!(settings.fit, VideoFit::Contain);
        assert_eq!(settings.when_stopped, StoppedScreen::LastFrame);
        // Before the setting existed fullscreen was always on top.
        assert!(settings.fullscreen_on_top);
    }

    #[test]
    fn settings_round_trip_in_camel_case() {
        let settings = VideoOutputSettings {
            enabled: true,
            display: Some(DisplayId {
                name: "\\\\.\\DISPLAY2".into(),
                width: 1920,
                height: 1080,
                x: -1920,
                y: 0,
            }),
            mode: VideoOutputMode::Window,
            fullscreen_on_top: false,
            fit: VideoFit::Cover,
            idle: IdleScreen::Image {
                path: "D:/logo.png".into(),
            },
            when_stopped: StoppedScreen::Black,
            latency_offset_ms: -80,
            hwdec: HwDecMode::Off,
            black_fade_ms: Some(1500),
        };
        let json = serde_json::to_value(&settings).expect("serialize");
        assert_eq!(json["idle"]["kind"], "image");
        assert_eq!(json["whenStopped"], "black");
        assert_eq!(json["latencyOffsetMs"], -80);
        assert_eq!(json["fullscreenOnTop"], false);
        let back: VideoOutputSettings = serde_json::from_value(json).expect("parse");
        assert_eq!(back, settings);
    }

    #[test]
    fn latency_is_clamped_to_the_slider_range() {
        let settings = VideoOutputSettings {
            latency_offset_ms: 9000,
            ..Default::default()
        };
        assert_eq!(settings.clamped().latency_offset_ms, MAX_LATENCY_OFFSET_MS);
    }
}
