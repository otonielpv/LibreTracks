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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct VideoOutputSettings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub display: Option<DisplayId>,
    #[serde(default)]
    pub mode: VideoOutputMode,
    #[serde(default)]
    pub fit: VideoFit,
    #[serde(default)]
    pub idle: IdleScreen,
    #[serde(default)]
    pub when_stopped: StoppedScreen,
    /// Added to the picture's target time. Positive shows later; negative
    /// earlier (to make up for a projector that lags). Paso 09 calibrates it.
    #[serde(default)]
    pub latency_offset_ms: i32,
    #[serde(default)]
    pub hwdec: HwDecMode,
}

impl VideoOutputSettings {
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
            fit: VideoFit::Cover,
            idle: IdleScreen::Image {
                path: "D:/logo.png".into(),
            },
            when_stopped: StoppedScreen::Black,
            latency_offset_ms: -80,
            hwdec: HwDecMode::Off,
        };
        let json = serde_json::to_value(&settings).expect("serialize");
        assert_eq!(json["idle"]["kind"], "image");
        assert_eq!(json["whenStopped"], "black");
        assert_eq!(json["latencyOffsetMs"], -80);
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
