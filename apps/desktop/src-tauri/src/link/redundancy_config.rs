//! What a device remembers about redundancy (docs/plans/redundancy), in its
//! own `redundancy.json` next to `network-session.json`. NOT inside
//! `AppSettings`: the settings are published to the remote's browser clients,
//! and the backup PIN or trusted-backup hashes must not be.

use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
};

use libretracks_link::TrustedDevice;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

pub const REDUNDANCY_FILE_NAME: &str = "redundancy.json";

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RedundancyConfig {
    /// Main side: PIN a backup needs. Empty = only a trusted backup.
    pub backup_pin: String,
    /// Main side: backups that may reconnect without the PIN.
    pub backup_trusted: Vec<TrustedDevice>,
    /// Backup side: token per main host id, from a `welcome` with remember.
    pub main_tokens: HashMap<String, String>,
    /// Main side: the backup may forward transport orders here.
    pub backup_may_forward: bool,
    /// Backup side: drift correction threshold, 2-20 ms. None = 5 ms.
    pub correction_threshold_ms: Option<f64>,
    /// Backup side: `host:port` of the main.
    pub main_address: String,
    /// Backup side: send local transport orders to the main instead of
    /// refusing them. Off by default: a MIDI controller wired to both
    /// machines (the usual rig) would reach the main twice.
    pub forward_local_inputs_to_main: bool,
    /// Backup side: calibration from step 11, how much later the backup
    /// should sound, in ms.
    pub manual_offset_ms: f64,
    /// The role this device had last (step 07: a main that crashed resumes
    /// as main with the pilot tone off).
    pub last_role: crate::redundancy::role::RedundancyRole,
    /// Main side: emit the pilot tone (step 08).
    pub pilot_tone_enabled: bool,
    /// Physical output for the tone, 1-based as on the interface. 0 = none.
    pub pilot_tone_channel: u32,
    /// None = 1 kHz.
    pub pilot_tone_frequency_hz: Option<f64>,
    /// None = -12 dBFS.
    pub pilot_tone_level_db: Option<f32>,
    /// Also emit it while this device is the backup (off by default: useful
    /// when the switcher watches both, or right before a role swap).
    pub pilot_tone_on_backup: bool,
    /// Backup side: 2 or 3 raw MIDI bytes sent once on losing the main (a
    /// program change or CC for switchers that listen to MIDI). Empty = off.
    pub on_main_lost_midi: Vec<u8>,
    /// Backup side: silence after which the main counts as lost, 500-5000
    /// ms. 0 = the default (1 s).
    pub heartbeat_timeout_ms: u64,
}

fn path_in(dir: &Path) -> PathBuf {
    dir.join(REDUNDANCY_FILE_NAME)
}

pub fn load_from(dir: &Path) -> RedundancyConfig {
    fs::read_to_string(path_in(dir))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub fn save_to(dir: &Path, config: &RedundancyConfig) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    let text = serde_json::to_string_pretty(config).map_err(std::io::Error::other)?;
    fs::write(path_in(dir), text)
}

fn data_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok()
}

pub fn load(app: &AppHandle) -> RedundancyConfig {
    data_dir(app).map(|dir| load_from(&dir)).unwrap_or_default()
}

pub fn save(app: &AppHandle, config: &RedundancyConfig) {
    let Some(dir) = data_dir(app) else {
        return;
    };
    if let Err(error) = save_to(&dir, config) {
        eprintln!("[redundancy] could not save {REDUNDANCY_FILE_NAME}: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use libretracks_link::Role;

    fn sample() -> RedundancyConfig {
        RedundancyConfig {
            backup_pin: "4321".into(),
            backup_trusted: vec![TrustedDevice {
                device_id: "b1".into(),
                device_name: "Portátil B".into(),
                role: Role::Controller,
                token_hash: "deadbeef".into(),
            }],
            main_tokens: HashMap::from([("main-1".into(), "secret-token".into())]),
            ..Default::default()
        }
    }

    #[test]
    fn pin_and_tokens_round_trip_through_redundancy_json() {
        let dir = tempfile::tempdir().unwrap();
        save_to(dir.path(), &sample()).unwrap();
        let text = fs::read_to_string(dir.path().join(REDUNDANCY_FILE_NAME)).unwrap();
        assert!(text.contains("\"backupPin\": \"4321\""), "{text}");
        assert!(text.contains("deadbeef"));
        assert_eq!(load_from(dir.path()), sample());
    }

    #[test]
    fn secrets_never_reach_settings_json() {
        // AppSettings is what goes to settings.json AND to the remote's
        // clients: none of the redundancy secrets may have a field there.
        let settings =
            serde_json::to_string(&crate::infra::settings::AppSettings::default()).unwrap();
        for key in ["backupPin", "backupTrusted", "mainTokens", "tokenHash"] {
            assert!(!settings.contains(key), "{key} leaked into AppSettings");
        }
    }

    #[test]
    fn missing_or_older_file_gives_defaults() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load_from(dir.path()), RedundancyConfig::default());
        fs::write(dir.path().join(REDUNDANCY_FILE_NAME), r#"{ "backupPin": "1" }"#).unwrap();
        let config = load_from(dir.path());
        assert_eq!(config.backup_pin, "1");
        assert!(config.backup_trusted.is_empty());
    }
}
