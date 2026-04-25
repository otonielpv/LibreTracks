use std::{
    fs,
    io,
    path::PathBuf,
    sync::Mutex,
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const SETTINGS_FILE_NAME: &str = "settings.json";

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default)]
    pub selected_output_device: Option<String>,
    #[serde(default)]
    pub split_stereo_enabled: bool,
    #[serde(default)]
    pub locale: Option<String>,
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