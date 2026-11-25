//! Global settings of the lyrics sync (`lyrics.json`, plan `lyrics-sync`
//! D11): which program, where it is and how early sections go out. Not in
//! `AppSettings`, which is published to the remote's browser clients. The
//! token or key of Holyrics and FreeShow is not here either: it goes to the
//! keychain.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::lead_time::LeadTime;
use crate::model::LyricsSoftware;

pub const DEFAULT_HOST: &str = "127.0.0.1";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricsConfig {
    pub enabled: bool,
    /// `None` until the user picks one.
    pub software: Option<LyricsSoftware>,
    pub host: String,
    /// `None` = the program's default (ProPresenter has none: the user reads
    /// it in ProPresenter's network settings).
    pub port: Option<u16>,
    pub lead: LeadTime,
    pub clear_on_song_end: bool,
    pub clear_on_stop: bool,
    pub paused: bool,
    /// The user has seen (or skipped) the setup tutorial of each program.
    pub tutorial_done: Vec<LyricsSoftware>,
}

impl Default for LyricsConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            software: None,
            host: DEFAULT_HOST.to_string(),
            port: None,
            lead: LeadTime::Beats { count: 1.0 },
            clear_on_song_end: true,
            clear_on_stop: false,
            paused: false,
            tutorial_done: Vec::new(),
        }
    }
}

/// The port a program listens on out of the box. ProPresenter picks its own.
pub fn default_port(software: LyricsSoftware) -> Option<u16> {
    match software {
        LyricsSoftware::FreeShow => Some(5506),
        LyricsSoftware::Holyrics => Some(8091),
        LyricsSoftware::OpenLp => Some(4316),
        LyricsSoftware::ProPresenter | LyricsSoftware::Unknown => None,
    }
}

/// Whether the program asks for a token or key.
pub fn uses_token(software: LyricsSoftware) -> bool {
    matches!(
        software,
        LyricsSoftware::FreeShow | LyricsSoftware::Holyrics | LyricsSoftware::OpenLp
    )
}

impl LyricsConfig {
    /// The port to connect to: the one set, or the program's default.
    pub fn effective_port(&self) -> Option<u16> {
        self.port
            .or_else(|| self.software.and_then(default_port))
    }

    /// Reads `lyrics.json` tolerantly: missing or corrupt → defaults; a field
    /// that does not parse keeps its default and the rest are kept; unknown
    /// fields are ignored.
    pub fn parse(text: &str) -> Self {
        let Ok(Value::Object(fields)) = serde_json::from_str::<Value>(text) else {
            return Self::default();
        };
        let mut config = Self::default();
        read(&fields, "enabled", &mut config.enabled);
        read(&fields, "software", &mut config.software);
        read(&fields, "host", &mut config.host);
        read(&fields, "port", &mut config.port);
        read(&fields, "lead", &mut config.lead);
        read(&fields, "clearOnSongEnd", &mut config.clear_on_song_end);
        read(&fields, "clearOnStop", &mut config.clear_on_stop);
        read(&fields, "paused", &mut config.paused);
        read(&fields, "tutorialDone", &mut config.tutorial_done);
        if config.host.trim().is_empty() {
            config.host = DEFAULT_HOST.to_string();
        }
        config
    }
}

fn read<T: serde::de::DeserializeOwned>(fields: &Map<String, Value>, key: &str, target: &mut T) {
    if let Some(value) = fields.get(key) {
        if let Ok(parsed) = serde_json::from_value(value.clone()) {
            *target = parsed;
        }
    }
}
