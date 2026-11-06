//! Pilot tone (redundancy steps 07-08): the tone a hardware switcher listens
//! to. Only a healthy main emits it (the backup only if the user turns it on
//! there), never by itself after an unclean exit (R4). The oscillator is in
//! the engine (`PilotTone`, C++); this decides when it is armed and with
//! which output, frequency and level (`redundancy.json`).

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use lt_audio_engine_v2::EngineCommand;
use tauri::{AppHandle, Manager};

use crate::link::redundancy_config::{self, RedundancyConfig};
use crate::state::DesktopState;

pub const DEFAULT_FREQUENCY_HZ: f64 = 1000.0;
pub const DEFAULT_LEVEL_DB: f32 = -12.0;

static ARMED: AtomicBool = AtomicBool::new(false);
/// «Cut the tone for 3 s» test in progress.
static CUT: AtomicBool = AtomicBool::new(false);

pub fn is_armed() -> bool {
    ARMED.load(Ordering::Relaxed)
}

/// The engine command for this configuration. No output chosen (channel 0)
/// = off whatever `armed` says.
pub fn pilot_command(config: &RedundancyConfig, armed: bool) -> EngineCommand {
    EngineCommand::SetPilotTone {
        enabled: armed && config.pilot_tone_channel > 0,
        channel: config.pilot_tone_channel as i32,
        frequency_hz: config.pilot_tone_frequency_hz.unwrap_or(DEFAULT_FREQUENCY_HZ),
        level_db: config.pilot_tone_level_db.unwrap_or(DEFAULT_LEVEL_DB),
    }
}

/// Send the current state to the engine (after arming, a settings change or
/// an engine restart).
pub fn apply(app: &AppHandle) {
    let config = redundancy_config::load(app);
    let armed = is_armed() && !CUT.load(Ordering::Relaxed);
    let command = pilot_command(&config, armed);
    let _ = app.state::<DesktopState>().audio.send_engine_command(&command, "set_pilot_tone");
}

pub fn set_armed(app: &AppHandle, armed: bool) {
    ARMED.store(armed, Ordering::Relaxed);
    apply(app);
    super::role::publish_status(app, |status| status.pilot_tone_on = armed);
}

/// What the engine says: the tone really on an output, and why not.
pub fn engine_state(app: &AppHandle) -> Option<(bool, String)> {
    let snapshot = app.state::<DesktopState>().audio.light_snapshot()?;
    Some((
        snapshot.device.pilot_tone_active,
        snapshot.device.pilot_tone_error,
    ))
}

/// Re-arm the tone after an unclean exit (the user confirms this machine
/// is the main again).
#[tauri::command]
pub fn rearm_pilot_tone(app: AppHandle) {
    set_armed(&app, true);
    super::role::publish_status(&app, |status| status.unclean_exit_warning = false);
}

#[tauri::command]
pub fn set_pilot_tone_armed(app: AppHandle, armed: bool) {
    set_armed(&app, armed);
}

/// «Cortar el tono 3 s»: check that the switcher jumps to the backup.
#[tauri::command]
pub async fn cut_pilot_tone_for_test(app: AppHandle) -> Result<(), String> {
    if CUT.swap(true, Ordering::Relaxed) {
        return Err("alreadyCutting".into());
    }
    apply(&app);
    tokio::time::sleep(Duration::from_secs(3)).await;
    CUT.store(false, Ordering::Relaxed);
    apply(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_one_kilohertz_at_minus_12_on_the_chosen_output() {
        let config = RedundancyConfig {
            pilot_tone_channel: 8,
            ..RedundancyConfig::default()
        };
        let EngineCommand::SetPilotTone {
            enabled,
            channel,
            frequency_hz,
            level_db,
        } = pilot_command(&config, true)
        else {
            unreachable!()
        };
        assert!(enabled);
        assert_eq!(channel, 8);
        assert_eq!(frequency_hz, 1000.0);
        assert_eq!(level_db, -12.0);
        let EngineCommand::SetPilotTone { enabled, .. } = pilot_command(&config, false) else {
            unreachable!()
        };
        assert!(!enabled);
    }

    #[test]
    fn without_an_output_the_tone_stays_off() {
        let EngineCommand::SetPilotTone { enabled, .. } =
            pilot_command(&RedundancyConfig::default(), true)
        else {
            unreachable!()
        };
        assert!(!enabled);
    }

    #[test]
    fn the_command_reaches_the_engine_as_set_pilot_tone_json() {
        let json = serde_json::to_value(pilot_command(
            &RedundancyConfig {
                pilot_tone_channel: 13,
                pilot_tone_frequency_hz: Some(440.0),
                pilot_tone_level_db: Some(-18.0),
                ..RedundancyConfig::default()
            },
            true,
        ))
        .unwrap();
        assert_eq!(json["type"], "SetPilotTone");
        assert_eq!(json["channel"], 13);
        assert_eq!(json["frequency_hz"], 440.0);
        assert_eq!(json["level_db"], -18.0);
    }
}
