use std::{collections::HashMap, fs, io, path::PathBuf, sync::Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::audio_engine::{
    AudioBackendKind, AudioBufferSizeRequest, AudioSampleFormat, OutputChannelRequest,
};

const SETTINGS_FILE_NAME: &str = "settings.json";

fn default_metronome_volume() -> f64 {
    0.8
}

fn default_metronome_accent_enabled() -> bool {
    true
}

fn default_metronome_preset() -> i32 {
    0
}

fn default_metronome_pitch() -> f32 {
    0.0
}

fn default_metronome_subdivision() -> i32 {
    1
}

fn default_metronome_subdivision_gain() -> f32 {
    0.5
}

fn default_enabled_output_channels() -> Vec<usize> {
    vec![0, 1]
}

fn default_audio_route() -> String {
    "master".into()
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

fn default_timeline_navigation_scheme() -> String {
    "ableton".into()
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
    pub selected_audio_backend: Option<AudioBackendKind>,
    #[serde(default)]
    pub selected_output_device_id: Option<String>,
    #[serde(default)]
    pub selected_output_device_name: Option<String>,
    #[serde(default)]
    pub output_sample_rate: Option<u32>,
    #[serde(default)]
    pub output_buffer_size: AudioBufferSizeRequest,
    #[serde(default)]
    pub output_channel_mapping: OutputChannelRequest,
    #[serde(default)]
    pub output_sample_format: Option<AudioSampleFormat>,
    #[serde(default)]
    pub audio_safe_mode: bool,
    #[serde(default)]
    pub selected_midi_device: Option<String>,
    #[serde(default)]
    pub suppress_missing_midi_device_warning: bool,
    #[serde(default = "default_enabled_output_channels")]
    pub enabled_output_channels: Vec<usize>,
    #[serde(default)]
    pub locale: Option<String>,
    #[serde(default)]
    pub metronome_enabled: bool,
    #[serde(default = "default_metronome_volume")]
    pub metronome_volume: f64,
    #[serde(default = "default_audio_route")]
    pub metronome_output: String,
    #[serde(default = "default_metronome_accent_enabled")]
    pub metronome_accent_enabled: bool,
    #[serde(default = "default_metronome_preset")]
    pub metronome_accent_preset: i32,
    #[serde(default = "default_metronome_preset")]
    pub metronome_beat_preset: i32,
    #[serde(default = "default_metronome_pitch")]
    pub metronome_accent_pitch: f32,
    #[serde(default = "default_metronome_pitch")]
    pub metronome_beat_pitch: f32,
    #[serde(default = "default_metronome_subdivision")]
    pub metronome_subdivision: i32,
    #[serde(default = "default_metronome_preset")]
    pub metronome_subdivision_preset: i32,
    #[serde(default = "default_metronome_pitch")]
    pub metronome_subdivision_pitch: f32,
    #[serde(default = "default_metronome_subdivision_gain")]
    pub metronome_subdivision_gain: f32,
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
    #[serde(default = "default_timeline_navigation_scheme")]
    pub timeline_navigation_scheme: String,
    #[serde(default)]
    pub midi_mappings: HashMap<String, MidiBinding>,
    /// Custom location for the decoded-PCM cache (`.rf64` files written when a
    /// non-WAV source is decoded). `None` = OS default cache dir. Maps to the
    /// engine's `LIBRETRACKS_CACHE_DIR` env override.
    #[serde(default)]
    pub decoding_cache_dir: Option<String>,
    /// Maximum decoding-cache size in GiB. `None` = automatic policy (the engine
    /// uses 10% of free disk, min 4 GiB). Maps to `LIBRETRACKS_SOURCE_DISK_CACHE_MB`.
    #[serde(default)]
    pub decoding_cache_max_gb: Option<u32>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            selected_output_device: None,
            selected_audio_backend: None,
            selected_output_device_id: None,
            selected_output_device_name: None,
            output_sample_rate: None,
            output_buffer_size: AudioBufferSizeRequest::Default,
            output_channel_mapping: OutputChannelRequest::default(),
            output_sample_format: None,
            audio_safe_mode: false,
            selected_midi_device: None,
            suppress_missing_midi_device_warning: false,
            enabled_output_channels: default_enabled_output_channels(),
            locale: None,
            metronome_enabled: false,
            metronome_volume: default_metronome_volume(),
            metronome_output: default_audio_route(),
            metronome_accent_enabled: default_metronome_accent_enabled(),
            metronome_accent_preset: default_metronome_preset(),
            metronome_beat_preset: default_metronome_preset(),
            metronome_accent_pitch: default_metronome_pitch(),
            metronome_beat_pitch: default_metronome_pitch(),
            metronome_subdivision: default_metronome_subdivision(),
            metronome_subdivision_preset: default_metronome_preset(),
            metronome_subdivision_pitch: default_metronome_pitch(),
            metronome_subdivision_gain: default_metronome_subdivision_gain(),
            global_jump_mode: default_global_jump_mode(),
            global_jump_bars: default_global_jump_bars(),
            song_jump_trigger: default_song_jump_trigger(),
            song_jump_bars: default_song_jump_bars(),
            song_transition_mode: default_song_transition_mode(),
            vamp_mode: default_vamp_mode(),
            vamp_bars: default_vamp_bars(),
            timeline_navigation_scheme: default_timeline_navigation_scheme(),
            midi_mappings: HashMap::new(),
            decoding_cache_dir: None,
            decoding_cache_max_gb: None,
        }
    }
}

/// Apply the decoding-cache preferences to the process environment so the audio
/// engine (which reads these env vars lazily on every cache operation) picks
/// them up. Call at startup before the engine is first used, and again whenever
/// the settings change — the native side re-reads `std::getenv` each call, so a
/// live update takes effect without restarting.
///
/// Note: changing the folder does NOT migrate existing `.rf64` files — the old
/// directory keeps its contents until purged (matches Ableton Live's behaviour).
pub fn apply_decoding_cache_env(settings: &AppSettings) {
    match settings.decoding_cache_dir.as_deref() {
        Some(dir) if !dir.is_empty() => std::env::set_var("LIBRETRACKS_CACHE_DIR", dir),
        _ => std::env::remove_var("LIBRETRACKS_CACHE_DIR"),
    }
    match settings.decoding_cache_max_gb {
        // The engine override is expressed in MiB.
        Some(gb) => std::env::set_var(
            "LIBRETRACKS_SOURCE_DISK_CACHE_MB",
            (u64::from(gb) * 1024).to_string(),
        ),
        None => std::env::remove_var("LIBRETRACKS_SOURCE_DISK_CACHE_MB"),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_settings_match_the_documented_values() {
        let settings = AppSettings::default();
        assert!(!settings.metronome_enabled);
        assert_eq!(settings.metronome_volume, 0.8);
        assert_eq!(settings.metronome_output, "master");
        assert_eq!(settings.enabled_output_channels, vec![0, 1]);
        assert_eq!(settings.global_jump_mode, "immediate");
        assert_eq!(settings.global_jump_bars, 4);
        assert_eq!(settings.vamp_mode, "section");
        assert_eq!(settings.timeline_navigation_scheme, "ableton");
        assert!(settings.midi_mappings.is_empty());
    }

    #[test]
    fn deserializing_an_empty_object_fills_every_default() {
        // The settings file may predate any given field; serde defaults keep
        // older files loadable. An empty object must yield the full defaults.
        let settings: AppSettings = serde_json::from_str("{}").expect("defaults");
        assert_eq!(settings, AppSettings::default());
    }

    #[test]
    fn deserializing_a_partial_object_overrides_only_named_fields() {
        let json = r#"{ "metronomeEnabled": true, "globalJumpBars": 8 }"#;
        let settings: AppSettings = serde_json::from_str(json).expect("partial");
        assert!(settings.metronome_enabled);
        assert_eq!(settings.global_jump_bars, 8);
        // Untouched fields stay at their defaults.
        assert_eq!(settings.metronome_volume, 0.8);
        assert_eq!(settings.vamp_bars, 4);
    }

    #[test]
    fn settings_round_trip_through_json() {
        let mut settings = AppSettings::default();
        settings.locale = Some("es".into());
        settings.metronome_volume = 0.42;
        settings.midi_mappings.insert(
            "play".into(),
            MidiBinding {
                status: 0x90,
                data1: 60,
                is_cc: false,
            },
        );
        let json = serde_json::to_string(&settings).expect("serialize");
        let restored: AppSettings = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(restored, settings);
    }

    #[test]
    fn camel_case_field_names_are_used_on_the_wire() {
        let json = serde_json::to_string(&AppSettings::default()).expect("serialize");
        assert!(json.contains("metronomeVolume"));
        assert!(json.contains("globalJumpMode"));
        assert!(!json.contains("metronome_volume"));
    }

    #[test]
    fn midi_binding_uses_camel_case_is_cc() {
        let json = serde_json::to_string(&MidiBinding {
            status: 1,
            data1: 2,
            is_cc: true,
        })
        .expect("serialize");
        assert!(json.contains("isCc"));
    }

    #[test]
    fn decoding_cache_fields_default_to_none_and_survive_empty_object() {
        // Older settings files predate these fields; an empty object must still
        // deserialize and leave them unset (= OS default dir / automatic limit).
        let settings: AppSettings = serde_json::from_str("{}").expect("defaults");
        assert_eq!(settings.decoding_cache_dir, None);
        assert_eq!(settings.decoding_cache_max_gb, None);
    }

    #[test]
    fn decoding_cache_fields_round_trip() {
        let mut settings = AppSettings::default();
        settings.decoding_cache_dir = Some("D:/lt-cache".into());
        settings.decoding_cache_max_gb = Some(8);
        let json = serde_json::to_string(&settings).expect("serialize");
        assert!(json.contains("decodingCacheDir"));
        assert!(json.contains("decodingCacheMaxGb"));
        let restored: AppSettings = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(restored, settings);
    }

    #[test]
    fn settings_store_reads_back_what_was_set() {
        let store = AppSettingsStore::new(AppSettings::default());
        assert_eq!(store.current().unwrap().metronome_volume, 0.8);

        let mut next = AppSettings::default();
        next.metronome_volume = 0.1;
        store.set(next).unwrap();
        assert_eq!(store.current().unwrap().metronome_volume, 0.1);
    }
}
