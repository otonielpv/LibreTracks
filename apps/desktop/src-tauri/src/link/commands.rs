//! Tauri commands of network sessions. The UI calling them lives behind
//! `FEATURE_FLAGS.networkSessions`.

use libretracks_link::{Grants, LinkCommand, Role};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use super::{config, guest, host, LinkState};

/// What the settings form edits. Tokens and trusted hashes stay out.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkSessionSettings {
    pub device_name: String,
    pub control_pin: String,
    pub edit_pin: String,
    pub keep_hosting_after_restart: bool,
}

#[tauri::command]
pub fn link_get_settings(app: AppHandle) -> Result<NetworkSessionSettings, String> {
    let link = app.state::<LinkState>();
    let config = link.config.lock().map_err(|_| "state poisoned")?;
    Ok(NetworkSessionSettings {
        device_name: config.device_name.clone(),
        control_pin: config.control_pin.clone(),
        edit_pin: config.edit_pin.clone(),
        keep_hosting_after_restart: config.keep_hosting_after_restart,
    })
}

#[tauri::command]
pub fn link_save_settings(
    app: AppHandle,
    settings: NetworkSessionSettings,
) -> Result<NetworkSessionSettings, String> {
    {
        let link = app.state::<LinkState>();
        let mut config = link.config.lock().map_err(|_| "state poisoned")?;
        let name = settings.device_name.trim();
        config.device_name = if name.is_empty() {
            config::machine_name()
        } else {
            name.to_string()
        };
        config.control_pin = settings.control_pin.trim().to_string();
        config.edit_pin = settings.edit_pin.trim().to_string();
        config.keep_hosting_after_restart = settings.keep_hosting_after_restart;
        config::save(&app, &config);
        let (control, edit) = (
            config::NetworkSessionConfig::pin(&config.control_pin),
            config::NetworkSessionConfig::pin(&config.edit_pin),
        );
        drop(config);
        host::with_handle(&app, |handle| handle.set_pins(control, edit));
    }
    link_get_settings(app)
}

#[tauri::command]
pub async fn link_start_hosting(app: AppHandle) -> Result<host::HostStatus, String> {
    host::start(&app).await
}

#[tauri::command]
pub fn link_stop_hosting(app: AppHandle) {
    host::stop(&app);
}

#[tauri::command]
pub fn link_host_status(app: AppHandle) -> host::HostStatus {
    host::status(&app)
}

#[tauri::command]
pub fn link_set_guest_role(app: AppHandle, device_id: String, role: Role) -> bool {
    host::with_handle(&app, |handle| {
        handle.set_grants(&device_id, Grants { role })
    })
    .unwrap_or(false)
}

#[tauri::command]
pub fn link_kick_guest(app: AppHandle, device_id: String) -> bool {
    host::with_handle(&app, |handle| handle.kick(&device_id)).unwrap_or(false)
}

#[tauri::command]
pub fn link_revoke_trusted(app: AppHandle, device_id: String) -> bool {
    // Hosting: the handle forgets it and the persist task saves the file.
    if let Some(revoked) = host::with_handle(&app, |handle| handle.revoke_trusted(&device_id)) {
        return revoked;
    }
    // Not hosting: edit the file directly.
    let link = app.state::<LinkState>();
    let Ok(mut config) = link.config.lock() else {
        return false;
    };
    let before = config.trusted.len();
    config
        .trusted
        .retain(|device| device.device_id != device_id);
    let revoked = config.trusted.len() != before;
    if revoked {
        config::save(&app, &config);
    }
    revoked
}

/// Async on purpose: the connection is a Tokio task, and a sync command runs
/// on the IPC thread outside the runtime (that crashed the app on Android).
#[tauri::command]
pub async fn link_join(
    app: AppHandle,
    target: String,
    pin: Option<String>,
    remember: bool,
    host_id: Option<String>,
) -> Result<guest::GuestStatus, String> {
    let hosting = host::with_handle(&app, |_| ()).is_some();
    if hosting {
        return Err("hosting".into());
    }
    guest::join_host(&app, &target, pin, remember, host_id)
}

#[tauri::command]
pub fn link_leave(app: AppHandle) {
    guest::leave(&app);
}

/// Everything the guest screen needs when it mounts: the events it missed
/// before it was listening.
#[tauri::command]
pub fn link_guest_snapshot(app: AppHandle) -> guest::GuestSnapshot {
    guest::snapshot(&app)
}

#[tauri::command]
pub async fn link_guest_command(
    app: AppHandle,
    command: LinkCommand,
    base_revision: Option<u64>,
) -> Result<(), String> {
    guest::send_command(&app, command, base_revision).await
}

/// Start looking for hosts (the «Join» tab is open). Returns what is already
/// known; changes arrive on `link://discovered`.
#[tauri::command]
pub fn link_start_discovery() -> Vec<libretracks_link::discovery::DiscoveredHost> {
    super::discovery::start_browsing()
}

#[tauri::command]
pub fn link_stop_discovery() {
    super::discovery::stop_browsing();
}
