//! The Redundancy settings tab's commands (step 10). Everything lives in
//! `redundancy.json`, never in `AppSettings` (which the remote receives):
//! the backup PIN included. Tokens and token hashes never leave Rust.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use super::role::{RedundancyRole, RedundancyState};
use crate::link::redundancy_config::{self, RedundancyConfig};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustedBackupView {
    pub device_id: String,
    pub device_name: String,
}

/// What the tab shows. No tokens, no hashes.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedundancySettingsView {
    pub role: RedundancyRole,
    pub backup_pin: String,
    pub backup_trusted: Vec<TrustedBackupView>,
    pub backup_may_forward: bool,
    pub main_address: String,
    pub forward_local_inputs_to_main: bool,
    pub correction_threshold_ms: f64,
    pub heartbeat_timeout_ms: u64,
    pub manual_offset_ms: f64,
    pub pilot_tone_enabled: bool,
    pub pilot_tone_channel: u32,
    pub pilot_tone_frequency_hz: f64,
    pub pilot_tone_level_db: f32,
    pub pilot_tone_on_backup: bool,
    pub on_main_lost_midi: Vec<u8>,
}

/// Only the fields present change.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RedundancySettingsPatch {
    pub backup_pin: Option<String>,
    pub backup_may_forward: Option<bool>,
    pub main_address: Option<String>,
    pub forward_local_inputs_to_main: Option<bool>,
    pub correction_threshold_ms: Option<f64>,
    pub heartbeat_timeout_ms: Option<u64>,
    pub manual_offset_ms: Option<f64>,
    pub pilot_tone_enabled: Option<bool>,
    pub pilot_tone_channel: Option<u32>,
    pub pilot_tone_frequency_hz: Option<f64>,
    pub pilot_tone_level_db: Option<f32>,
    pub pilot_tone_on_backup: Option<bool>,
    pub on_main_lost_midi: Option<Vec<u8>>,
}

pub const DEFAULT_CORRECTION_THRESHOLD_MS: f64 = 5.0;

pub fn view(config: &RedundancyConfig, role: RedundancyRole) -> RedundancySettingsView {
    RedundancySettingsView {
        role,
        backup_pin: config.backup_pin.clone(),
        backup_trusted: config
            .backup_trusted
            .iter()
            .map(|device| TrustedBackupView {
                device_id: device.device_id.clone(),
                device_name: device.device_name.clone(),
            })
            .collect(),
        backup_may_forward: config.backup_may_forward,
        main_address: config.main_address.clone(),
        forward_local_inputs_to_main: config.forward_local_inputs_to_main,
        correction_threshold_ms: config
            .correction_threshold_ms
            .unwrap_or(DEFAULT_CORRECTION_THRESHOLD_MS),
        heartbeat_timeout_ms: if config.heartbeat_timeout_ms == 0 {
            libretracks_link::redundancy::DEFAULT_HEARTBEAT_TIMEOUT_MS
        } else {
            config.heartbeat_timeout_ms
        },
        manual_offset_ms: config.manual_offset_ms,
        pilot_tone_enabled: config.pilot_tone_enabled,
        pilot_tone_channel: config.pilot_tone_channel,
        pilot_tone_frequency_hz: config
            .pilot_tone_frequency_hz
            .unwrap_or(super::pilot::DEFAULT_FREQUENCY_HZ),
        pilot_tone_level_db: config
            .pilot_tone_level_db
            .unwrap_or(super::pilot::DEFAULT_LEVEL_DB),
        pilot_tone_on_backup: config.pilot_tone_on_backup,
        on_main_lost_midi: config.on_main_lost_midi.clone(),
    }
}

/// Apply a patch with the documented ranges: PIN 4-6 digits (or empty),
/// threshold 2-20 ms, timeout 0.5-5 s, MIDI 0, 2 or 3 bytes.
pub fn apply_patch(config: &mut RedundancyConfig, patch: RedundancySettingsPatch) -> Result<(), String> {
    if let Some(pin) = patch.backup_pin {
        let pin = pin.trim().to_string();
        let valid = pin.is_empty()
            || ((4..=6).contains(&pin.len()) && pin.chars().all(|c| c.is_ascii_digit()));
        if !valid {
            return Err("invalidPin".into());
        }
        config.backup_pin = pin;
    }
    if let Some(value) = patch.backup_may_forward {
        config.backup_may_forward = value;
    }
    if let Some(value) = patch.main_address {
        config.main_address = value.trim().to_string();
    }
    if let Some(value) = patch.forward_local_inputs_to_main {
        config.forward_local_inputs_to_main = value;
    }
    if let Some(value) = patch.correction_threshold_ms {
        config.correction_threshold_ms = Some(value.clamp(2.0, 20.0));
    }
    if let Some(value) = patch.heartbeat_timeout_ms {
        config.heartbeat_timeout_ms = value.clamp(500, 5_000);
    }
    if let Some(value) = patch.manual_offset_ms {
        config.manual_offset_ms = value.clamp(-100.0, 100.0);
    }
    if let Some(value) = patch.pilot_tone_enabled {
        config.pilot_tone_enabled = value;
    }
    if let Some(value) = patch.pilot_tone_channel {
        config.pilot_tone_channel = value.min(64);
    }
    if let Some(value) = patch.pilot_tone_frequency_hz {
        config.pilot_tone_frequency_hz = Some(value.clamp(20.0, 20_000.0));
    }
    if let Some(value) = patch.pilot_tone_level_db {
        config.pilot_tone_level_db = Some(value.clamp(-60.0, 0.0));
    }
    if let Some(value) = patch.pilot_tone_on_backup {
        config.pilot_tone_on_backup = value;
    }
    if let Some(bytes) = patch.on_main_lost_midi {
        if !matches!(bytes.len(), 0 | 2 | 3) {
            return Err("invalidMidi".into());
        }
        config.on_main_lost_midi = bytes;
    }
    Ok(())
}

/// A fresh 4-digit PIN.
pub fn new_pin() -> String {
    let hex = libretracks_link::random_hex(4);
    let number = u32::from_str_radix(&hex, 16).unwrap_or(0) % 10_000;
    format!("{number:04}")
}

#[tauri::command]
pub fn get_redundancy_settings(app: AppHandle) -> RedundancySettingsView {
    let role = app.state::<RedundancyState>().role();
    view(&redundancy_config::load(&app), role)
}

#[tauri::command]
pub fn save_redundancy_settings(
    app: AppHandle,
    patch: RedundancySettingsPatch,
) -> Result<RedundancySettingsView, String> {
    let mut config = redundancy_config::load(&app);
    apply_patch(&mut config, patch)?;
    redundancy_config::save(&app, &config);
    super::role::settings_changed(&app, &config);
    super::pilot::apply(&app);
    Ok(view(&config, app.state::<RedundancyState>().role()))
}

#[tauri::command]
pub fn regenerate_backup_pin(app: AppHandle) -> Result<RedundancySettingsView, String> {
    save_redundancy_settings(
        app,
        RedundancySettingsPatch {
            backup_pin: Some(new_pin()),
            ..RedundancySettingsPatch::default()
        },
    )
}

#[tauri::command]
pub fn revoke_trusted_backup(app: AppHandle, device_id: String) -> RedundancySettingsView {
    let mut config = redundancy_config::load(&app);
    config
        .backup_trusted
        .retain(|device| device.device_id != device_id);
    redundancy_config::save(&app, &config);
    super::role::revoke_trusted(&app, &device_id);
    view(&config, app.state::<RedundancyState>().role())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_view_carries_no_token_hashes() {
        let config = RedundancyConfig {
            backup_pin: "1234".into(),
            backup_trusted: vec![libretracks_link::TrustedDevice {
                device_id: "b".into(),
                device_name: "PC B".into(),
                role: libretracks_link::Role::Controller,
                token_hash: "secret-hash".into(),
            }],
            main_tokens: [("ws://a:3040".to_string(), "secret-token".to_string())]
                .into_iter()
                .collect(),
            ..RedundancyConfig::default()
        };
        let json = serde_json::to_string(&view(&config, RedundancyRole::Main)).unwrap();
        assert!(!json.contains("secret-hash"));
        assert!(!json.contains("secret-token"));
        assert!(json.contains("\"backupPin\":\"1234\""));
        assert!(json.contains("PC B"));
    }

    #[test]
    fn patches_keep_the_documented_ranges() {
        let mut config = RedundancyConfig::default();
        apply_patch(
            &mut config,
            RedundancySettingsPatch {
                correction_threshold_ms: Some(50.0),
                heartbeat_timeout_ms: Some(100),
                pilot_tone_level_db: Some(6.0),
                ..RedundancySettingsPatch::default()
            },
        )
        .unwrap();
        assert_eq!(config.correction_threshold_ms, Some(20.0));
        assert_eq!(config.heartbeat_timeout_ms, 500);
        assert_eq!(config.pilot_tone_level_db, Some(0.0));
        assert!(apply_patch(
            &mut config,
            RedundancySettingsPatch {
                backup_pin: Some("12a4".into()),
                ..RedundancySettingsPatch::default()
            }
        )
        .is_err());
        assert!(apply_patch(
            &mut config,
            RedundancySettingsPatch {
                on_main_lost_midi: Some(vec![1]),
                ..RedundancySettingsPatch::default()
            }
        )
        .is_err());
        let pin = new_pin();
        assert_eq!(pin.len(), 4);
        assert!(pin.chars().all(|c| c.is_ascii_digit()));
    }
}
