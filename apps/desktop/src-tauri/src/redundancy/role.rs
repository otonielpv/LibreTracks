//! Which redundancy role this device plays, the server the main uses and
//! the lifecycle commands (redundancy steps 04, 06, 07; the UI is step 10).
//!
//! The main reuses the network-session server when the user is hosting one
//! (same port, R1) and runs its own, guests refused, when not (R2). Hosting
//! starting or stopping while this device is the main moves the publisher
//! between the two: `host.rs` calls [`before_hosting_starts`],
//! [`hosting_started`] and [`hosting_stopped`].

use std::sync::Mutex;

use libretracks_link::redundancy::RedundancyMessage;
use libretracks_link::{start_host, HostConfig, HostHandle};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc;

use super::follower_runtime::{self, FollowerCommand, FollowerTask};
use super::main_monitor::MainMonitorCore;
use super::publisher::{self, PublisherTask};
use super::status::{main_state_name, RedundancyStatus, REDUNDANCY_STATUS_EVENT};
use crate::link::redundancy_config::{self, RedundancyConfig};
use crate::link::LinkState;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RedundancyRole {
    #[default]
    Off,
    Main,
    Backup,
}

enum ServerSlot {
    /// Started by redundancy, guests refused.
    Own(HostHandle),
    /// The network session's server.
    Shared(HostHandle),
}

impl ServerSlot {
    fn handle(&self) -> &HostHandle {
        match self {
            ServerSlot::Own(handle) | ServerSlot::Shared(handle) => handle,
        }
    }
}

#[derive(Default)]
struct MainRuntime {
    server: Option<ServerSlot>,
    publisher: Option<PublisherTask>,
    tasks: Vec<tauri::async_runtime::JoinHandle<()>>,
}

impl MainRuntime {
    fn shut_down(&mut self) {
        self.publisher = None;
        for task in self.tasks.drain(..) {
            task.abort();
        }
        match self.server.take() {
            Some(ServerSlot::Own(handle)) => handle.stop(),
            Some(ServerSlot::Shared(handle)) => handle.set_accept_backup(false),
            None => {}
        }
    }
}

#[derive(Default)]
pub struct RedundancyState {
    role: Mutex<RedundancyRole>,
    main: Mutex<MainRuntime>,
    follower: Mutex<Option<FollowerTask>>,
    status: Mutex<RedundancyStatus>,
    /// The old main's address, kept when this backup becomes the main, to
    /// offer it the swap.
    pending_offer: Mutex<Option<String>>,
    /// The role-change offer this main received.
    received_offer: Mutex<Option<libretracks_core::redundancy::lifecycle::RoleOffer>>,
}

impl RedundancyState {
    pub fn role(&self) -> RedundancyRole {
        self.role.lock().map(|role| *role).unwrap_or_default()
    }

    pub fn status(&self) -> RedundancyStatus {
        self.status.lock().map(|status| status.clone()).unwrap_or_default()
    }
}

/// Replace the shared status and tell the UI.
pub fn publish_status(app: &AppHandle, update: impl FnOnce(&mut RedundancyStatus)) {
    let state = app.state::<RedundancyState>();
    let status = {
        let Ok(mut status) = state.status.lock() else {
            return;
        };
        update(&mut status);
        status.role = state.role();
        status.clone()
    };
    let _ = app.emit(REDUNDANCY_STATUS_EVENT, status);
}

/// What a link server needs to take a backup, from `redundancy.json`.
pub fn apply_backup_settings(config: &RedundancyConfig, host: &mut HostConfig) {
    host.accept_backup = true;
    host.backup_pin = crate::link::config::NetworkSessionConfig::pin(&config.backup_pin);
    host.backup_trusted = config.backup_trusted.clone();
    host.backup_may_forward = config.backup_may_forward;
}

fn configure_shared(handle: &HostHandle, config: &RedundancyConfig) {
    handle.set_backup_pin(crate::link::config::NetworkSessionConfig::pin(
        &config.backup_pin,
    ));
    handle.set_backup_may_forward(config.backup_may_forward);
    handle.set_accept_backup(true);
}

/// The settings tab saved `redundancy.json`: what a running main serves
/// changes at once.
pub fn settings_changed(app: &AppHandle, config: &RedundancyConfig) {
    let state = app.state::<RedundancyState>();
    if let Ok(main) = state.main.lock() {
        if let Some(server) = &main.server {
            let handle = server.handle();
            handle.set_backup_pin(crate::link::config::NetworkSessionConfig::pin(
                &config.backup_pin,
            ));
            handle.set_backup_may_forward(config.backup_may_forward);
        }
    };
}

/// Forget a trusted backup on the running server too.
pub fn revoke_trusted(app: &AppHandle, device_id: &str) {
    let state = app.state::<RedundancyState>();
    if let Ok(main) = state.main.lock() {
        if let Some(server) = &main.server {
            server.handle().revoke_backup_trusted(device_id);
        }
    };
}

/// Keep the trusted backups in `redundancy.json` as the server learns them.
fn spawn_persist(app: &AppHandle, handle: &HostHandle) -> tauri::async_runtime::JoinHandle<()> {
    let app = app.clone();
    let mut trusted = handle.subscribe_backup_trusted();
    tauri::async_runtime::spawn(async move {
        while trusted.changed().await.is_ok() {
            let devices = trusted.borrow_and_update().clone();
            let mut config = redundancy_config::load(&app);
            if config.backup_trusted != devices {
                config.backup_trusted = devices;
                redundancy_config::save(&app, &config);
            }
        }
    })
}

/// The main's lifecycle: what the backup says, 4 times a second.
fn spawn_monitor(
    app: &AppHandle,
    handle: &HostHandle,
    mut messages: mpsc::Receiver<RedundancyMessage>,
) -> tauri::async_runtime::JoinHandle<()> {
    let app = app.clone();
    let handle = handle.clone();
    tauri::async_runtime::spawn(async move {
        let mut core = MainMonitorCore::default();
        let mut tick = tokio::time::interval(std::time::Duration::from_millis(250));
        loop {
            tokio::select! {
                message = messages.recv() => {
                    let Some(message) = message else { return };
                    core.on_message(message, handle.monotonic_ms());
                    if let Some(offer) = core.lifecycle.accept_offer() {
                        let name = offer.new_main_name.clone();
                        if let Ok(mut slot) = app.state::<RedundancyState>().received_offer.lock() {
                            *slot = Some(offer);
                        }
                        publish_status(&app, |status| status.role_offer = Some(name));
                    }
                }
                _ = tick.tick() => {
                    let backup = handle.backup();
                    core.tick(backup.is_some(), handle.monotonic_ms());
                    let state = main_state_name(core.lifecycle.state()).to_string();
                    let offset = core.offset_ms;
                    publish_status(&app, |status| {
                        status.state = state;
                        status.offset_ms = offset;
                        status.other_name = backup.map(|backup| backup.device_name);
                    });
                }
            }
        }
    })
}

fn attach(
    app: &AppHandle,
    main: &mut MainRuntime,
    slot: ServerSlot,
    messages: Option<mpsc::Receiver<RedundancyMessage>>,
) {
    let handle = slot.handle().clone();
    main.publisher = publisher::spawn(app, handle.clone());
    main.tasks.push(spawn_persist(app, &handle));
    if let Some(messages) = messages {
        main.tasks.push(spawn_monitor(app, &handle, messages));
    }
    main.server = Some(slot);
}

fn hosting_handle(app: &AppHandle) -> Option<HostHandle> {
    crate::link::host::with_handle(app, HostHandle::clone)
}

async fn start_own_server(
    app: &AppHandle,
    config: &RedundancyConfig,
) -> Result<(HostHandle, mpsc::Receiver<RedundancyMessage>), String> {
    let link = app.state::<LinkState>();
    let (device_id, device_name) = {
        let link_config = link.config.lock().map_err(|_| "state poisoned")?;
        (link_config.device_id.clone(), link_config.device_name.clone())
    };
    let mut host = HostConfig {
        host_id: device_id,
        accept_guests: false,
        ..HostConfig::new(device_name)
    };
    apply_backup_settings(config, &mut host);
    let runtime = start_host(host)
        .await
        .map_err(|error| format!("no se pudo abrir el puerto: {error}"))?;
    Ok((runtime.handle, runtime.backup_messages))
}

fn remember_role(app: &AppHandle, role: RedundancyRole) {
    let mut config = redundancy_config::load(app);
    if config.last_role != role {
        config.last_role = role;
        redundancy_config::save(app, &config);
    }
}

/// `main_address`/`pin` only matter for `Backup` (the address is
/// remembered in `redundancy.json`; the PIN is only needed until the main
/// trusts this device).
pub async fn set_role(
    app: &AppHandle,
    role: RedundancyRole,
    main_address: Option<String>,
    pin: Option<String>,
) -> Result<RedundancyRole, String> {
    let state = app.state::<RedundancyState>();
    let current = state.role();
    if current == role && role != RedundancyRole::Backup {
        return Ok(role);
    }
    if let Ok(mut main) = state.main.lock() {
        main.shut_down();
    };
    if let Ok(mut follower) = state.follower.lock() {
        // Dropping it stops it and unlocks the local transport.
        *follower = None;
    };
    if role != RedundancyRole::Main {
        // The backup only emits it when the user asked for that there.
        let config = redundancy_config::load(app);
        super::pilot::set_armed(
            app,
            role == RedundancyRole::Backup
                && config.pilot_tone_enabled
                && config.pilot_tone_on_backup,
        );
    }
    if role == RedundancyRole::Backup {
        let mut config = redundancy_config::load(app);
        if let Some(address) = main_address.filter(|address| !address.trim().is_empty()) {
            config.main_address = address.trim().to_string();
            redundancy_config::save(app, &config);
        }
        if config.main_address.is_empty() {
            return Err("missingMainAddress".into());
        }
        let task = follower_runtime::spawn(app, &config.main_address, pin)?;
        if let Ok(mut follower) = state.follower.lock() {
            *follower = Some(task);
        };
    }
    if role == RedundancyRole::Main {
        let config = redundancy_config::load(app);
        let (slot, messages) = match hosting_handle(app) {
            Some(handle) => {
                configure_shared(&handle, &config);
                // The network session owns this server's backup messages;
                // `hosting_started` attaches the monitor when hosting starts
                // while this device is the main.
                (ServerSlot::Shared(handle), None)
            }
            None => {
                let (handle, messages) = start_own_server(app, &config).await?;
                (ServerSlot::Own(handle), Some(messages))
            }
        };
        let mut main = state.main.lock().map_err(|_| "state poisoned")?;
        attach(app, &mut main, slot, messages);
    }
    if let Ok(mut current) = state.role.lock() {
        *current = role;
    }
    remember_role(app, role);
    publish_status(app, |status| {
        *status = RedundancyStatus {
            unclean_exit_warning: status.unclean_exit_warning,
            pilot_tone_on: status.pilot_tone_on,
            state: if role == RedundancyRole::Off {
                "off".into()
            } else {
                String::new()
            },
            ..RedundancyStatus::default()
        };
    });
    // A backup that became the main offers the swap to its old main.
    if role == RedundancyRole::Main {
        let old_main = state.pending_offer.lock().ok().and_then(|mut slot| slot.take());
        if let Some(address) = old_main {
            follower_runtime::offer_role_change(app, &address);
        }
    }
    Ok(role)
}

/// Hosting is about to bind its port: our own server must let it go.
pub fn before_hosting_starts(app: &AppHandle) {
    let state = app.state::<RedundancyState>();
    if state.role() != RedundancyRole::Main {
        return;
    }
    if let Ok(mut main) = state.main.lock() {
        if matches!(main.server, Some(ServerSlot::Own(_))) {
            main.shut_down();
        }
    };
}

/// Hosting started while this device is the main: the publisher moves to it.
/// `backup_messages` is the hosting server's redundancy feed (only read when
/// this device is the main).
pub fn hosting_started(
    app: &AppHandle,
    handle: &HostHandle,
    backup_messages: mpsc::Receiver<RedundancyMessage>,
) {
    let state = app.state::<RedundancyState>();
    if state.role() != RedundancyRole::Main {
        return;
    }
    let config = redundancy_config::load(app);
    configure_shared(handle, &config);
    if let Ok(mut main) = state.main.lock() {
        main.shut_down();
        attach(
            app,
            &mut main,
            ServerSlot::Shared(handle.clone()),
            Some(backup_messages),
        );
    };
}

/// Hosting stopped: the main goes back to a server of its own.
pub fn hosting_stopped(app: &AppHandle) {
    let state = app.state::<RedundancyState>();
    if state.role() != RedundancyRole::Main {
        return;
    }
    if let Ok(mut main) = state.main.lock() {
        // The shared server is gone already; just forget it.
        main.publisher = None;
        for task in main.tasks.drain(..) {
            task.abort();
        }
        main.server = None;
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let config = redundancy_config::load(&app);
        if let Ok((handle, messages)) = start_own_server(&app, &config).await {
            let state = app.state::<RedundancyState>();
            if let Ok(mut main) = state.main.lock() {
                if state.role() == RedundancyRole::Main && main.server.is_none() {
                    attach(&app, &mut main, ServerSlot::Own(handle), Some(messages));
                } else {
                    handle.stop();
                }
            };
        }
    });
}

fn send_to_follower(app: &AppHandle, command: FollowerCommand) -> Result<(), String> {
    let state = app.state::<RedundancyState>();
    let follower = state.follower.lock().map_err(|_| "state poisoned")?;
    follower
        .as_ref()
        .ok_or_else(|| "notBackup".to_string())?
        .send(command)
}

/// At launch (R4): resume the main role if it was the last one, with the
/// pilot tone off after an unclean exit.
pub fn resume_at_startup(app: &AppHandle, unclean_exit: bool) {
    let config = redundancy_config::load(app);
    let plan = libretracks_core::redundancy::lifecycle::startup_plan(
        config.last_role == RedundancyRole::Main,
        unclean_exit,
        config.pilot_tone_enabled,
    );
    if !plan.resume_main {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = set_role(&app, RedundancyRole::Main, None, None).await;
        super::pilot::set_armed(&app, plan.pilot_tone_armed);
        publish_status(&app, |status| {
            status.unclean_exit_warning = plan.warn_unclean_exit;
        });
    });
}

#[tauri::command]
pub async fn set_redundancy_role(
    app: AppHandle,
    role: RedundancyRole,
    main_address: Option<String>,
    pin: Option<String>,
) -> Result<RedundancyRole, String> {
    set_role(&app, role, main_address, pin).await
}

#[tauri::command]
pub fn get_redundancy_role(app: AppHandle) -> RedundancyRole {
    app.state::<RedundancyState>().role()
}

#[tauri::command]
pub fn get_redundancy_status(app: AppHandle) -> RedundancyStatus {
    let state = app.state::<RedundancyState>();
    let mut status = state.status();
    status.role = state.role();
    status
}

/// «Ahora mando yo» (D1: the only way into standalone).
#[tauri::command]
pub fn redundancy_take_command(app: AppHandle) -> Result<(), String> {
    send_to_follower(&app, FollowerCommand::TakeCommand)
}

/// From `Diverged`: follow the main again.
#[tauri::command]
pub fn redundancy_follow_again(app: AppHandle) -> Result<(), String> {
    send_to_follower(&app, FollowerCommand::FollowAgain)
}

/// From standalone or diverged: this machine becomes the main (publisher,
/// pilot tone) and offers the swap to the old main.
#[tauri::command]
pub async fn redundancy_become_main(app: AppHandle) -> Result<RedundancyRole, String> {
    let state = app.state::<RedundancyState>();
    if state.role() != RedundancyRole::Backup {
        return Err("notBackup".into());
    }
    let config = redundancy_config::load(&app);
    if let Ok(mut slot) = state.pending_offer.lock() {
        *slot = (!config.main_address.is_empty()).then_some(config.main_address.clone());
    };
    let role = set_role(&app, RedundancyRole::Main, None, None).await?;
    super::pilot::set_armed(&app, config.pilot_tone_enabled);
    Ok(role)
}

/// The old main accepts the offer of the backup that took over: it becomes
/// that machine's backup (its pilot tone goes off).
#[tauri::command]
pub async fn accept_redundancy_role_change(app: AppHandle) -> Result<RedundancyRole, String> {
    let offer = app
        .state::<RedundancyState>()
        .received_offer
        .lock()
        .map_err(|_| "state poisoned")?
        .take()
        .ok_or_else(|| "noOffer".to_string())?;
    let address = offer
        .new_main_address
        .ok_or_else(|| "missingMainAddress".to_string())?;
    set_role(&app, RedundancyRole::Backup, Some(address), None).await
}

#[tauri::command]
pub fn dismiss_redundancy_role_change(app: AppHandle) {
    if let Ok(mut slot) = app.state::<RedundancyState>().received_offer.lock() {
        *slot = None;
    }
    publish_status(&app, |status| status.role_offer = None);
}

/// The startup plan from what is on disk (`redundancy.json` in `dir`) and
/// whether the previous run exited uncleanly.
pub fn startup_plan_in(
    dir: &std::path::Path,
    unclean_exit: bool,
) -> libretracks_core::redundancy::lifecycle::StartupPlan {
    let config = redundancy_config::load_from(dir);
    libretracks_core::redundancy::lifecycle::startup_plan(
        config.last_role == RedundancyRole::Main,
        unclean_exit,
        config.pilot_tone_enabled,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data_dir(last_role: RedundancyRole, pilot: bool, crashed: bool) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        redundancy_config::save_to(
            dir.path(),
            &RedundancyConfig {
                last_role,
                pilot_tone_enabled: pilot,
                ..RedundancyConfig::default()
            },
        )
        .unwrap();
        if crashed {
            std::fs::create_dir_all(dir.path().join("logs")).unwrap();
            std::fs::write(dir.path().join("logs").join("session.running"), "pid=1").unwrap();
        }
        dir
    }

    fn plan(dir: &tempfile::TempDir) -> libretracks_core::redundancy::lifecycle::StartupPlan {
        let unclean = crate::infra::crash_report::unclean_marker_present(dir.path());
        startup_plan_in(dir.path(), unclean)
    }

    #[test]
    fn a_main_that_crashed_comes_back_without_pilot_tone_and_warns() {
        let plan = plan(&data_dir(RedundancyRole::Main, true, true));
        assert!(plan.resume_main);
        assert!(!plan.pilot_tone_armed);
        assert!(plan.warn_unclean_exit);
    }

    #[test]
    fn a_clean_start_follows_the_pilot_setting() {
        let on = plan(&data_dir(RedundancyRole::Main, true, false));
        assert!(on.resume_main && on.pilot_tone_armed && !on.warn_unclean_exit);
        let off = plan(&data_dir(RedundancyRole::Main, false, false));
        assert!(!off.pilot_tone_armed);
        let backup = plan(&data_dir(RedundancyRole::Backup, true, true));
        assert!(!backup.resume_main && !backup.warn_unclean_exit);
    }
}
