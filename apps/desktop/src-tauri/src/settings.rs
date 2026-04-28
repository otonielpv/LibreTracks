use std::{collections::HashMap, fs, io, path::PathBuf, sync::Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const SETTINGS_FILE_NAME: &str = "settings.json";

fn default_metronome_volume() -> f64 {
    0.8
}

fn default_global_jump_mode() -> String {
    "immediate".into()
}

fn default_global_jump_bars() -> u32 {
    4
}

fn default_song_jump_trigger() -> String {
    "immediate".into()
}

fn default_song_jump_bars() -> u32 {
    4
}

fn default_song_transition_mode() -> String {
    "instant".into()
}

fn default_vamp_mode() -> String {
    "section".into()
}

fn default_vamp_bars() -> u32 {
    4
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MidiBinding {
    pub status: u8,
    pub data1: u8,
    pub is_cc: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default)]
    pub selected_output_device: Option<String>,
    #[serde(default)]
    pub selected_midi_device: Option<String>,
    #[serde(default)]
    pub split_stereo_enabled: bool,
    #[serde(default)]
    pub locale: Option<String>,
    #[serde(default)]
    pub metronome_enabled: bool,
    #[serde(default = "default_metronome_volume")]
    pub metronome_volume: f64,
    #[serde(default = "default_global_jump_mode")]
    pub global_jump_mode: String,
    #[serde(default = "default_global_jump_bars")]
    pub global_jump_bars: u32,
    #[serde(default = "default_song_jump_trigger")]
    pub song_jump_trigger: String,
    #[serde(default = "default_song_jump_bars")]
    pub song_jump_bars: u32,
    #[serde(default = "default_song_transition_mode")]
    pub song_transition_mode: String,
    #[serde(default = "default_vamp_mode")]
    pub vamp_mode: String,
    #[serde(default = "default_vamp_bars")]
    pub vamp_bars: u32,
    #[serde(default)]
    pub midi_mappings: HashMap<String, MidiBinding>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            selected_output_device: None,
            selected_midi_device: None,
            split_stereo_enabled: false,
            locale: None,
            metronome_enabled: false,
            metronome_volume: default_metronome_volume(),
            global_jump_mode: default_global_jump_mode(),
            global_jump_bars: default_global_jump_bars(),
            song_jump_trigger: default_song_jump_trigger(),
            song_jump_bars: default_song_jump_bars(),
            song_transition_mode: default_song_transition_mode(),
            vamp_mode: default_vamp_mode(),
            vamp_bars: default_vamp_bars(),
            midi_mappings: HashMap::new(),
        }
    }
}

pub struct AppSettingsStore {
    settings: Mutex<AppSettings>,
}

impl AppSettingsStore {
    pub fn new(settings: AppSettings) -> Self {
        Self {
            settings: Mutex::new(settings),
        }
    }

    pub fn current(&self) -> Result<AppSettings, io::Error> {
        self.settings
            .lock()
            .map(|settings| settings.clone())
            .map_err(|_| io::Error::other("settings state lock poisoned"))
    }

    pub fn set(&self, settings: AppSettings) -> Result<(), io::Error> {
        let mut current = self
            .settings
            .lock()
            .map_err(|_| io::Error::other("settings state lock poisoned"))?;
        *current = settings;
        Ok(())
    }
}

pub fn load_app_settings(app: &AppHandle) -> Result<AppSettings, io::Error> {
    let settings_path = settings_file_path(app)?;
    if !settings_path.exists() {
        return Ok(AppSettings::default());
    }

    let contents = fs::read_to_string(settings_path)?;
    serde_json::from_str(&contents).map_err(|error| io::Error::other(error.to_string()))
}

pub fn save_app_settings(app: &AppHandle, settings: &AppSettings) -> Result<PathBuf, io::Error> {
    let settings_path = settings_file_path(app)?;
    if let Some(parent_dir) = settings_path.parent() {
        fs::create_dir_all(parent_dir)?;
    }

    let contents = serde_json::to_string_pretty(settings)
        .map_err(|error| io::Error::other(error.to_string()))?;
    fs::write(&settings_path, contents)?;
    Ok(settings_path)
}

fn settings_file_path(app: &AppHandle) -> Result<PathBuf, io::Error> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| io::Error::other(error.to_string()))?;
    Ok(app_data_dir.join(SETTINGS_FILE_NAME))
}
