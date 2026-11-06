//! Which redundancy role this device plays, and the server the main uses
//! (redundancy step 04; the follower comes in step 06, the UI in step 10).
//!
//! The main reuses the network-session server when the user is hosting one
//! (same port, R1) and runs its own, guests refused, when not (R2). Hosting
//! starting or stopping while this device is the main moves the publisher
//! between the two: `host.rs` calls [`before_hosting_starts`],
//! [`hosting_started`] and [`hosting_stopped`].

use std::sync::Mutex;

use libretracks_link::{start_host, HostConfig, HostHandle};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use super::publisher::{self, PublisherTask};
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
    persist: Option<tauri::async_runtime::JoinHandle<()>>,
}

impl MainRuntime {
    fn shut_down(&mut self) {
        self.publisher = None;
        if let Some(task) = self.persist.take() {
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
}

impl RedundancyState {
    pub fn role(&self) -> RedundancyRole {
        self.role.lock().map(|role| *role).unwrap_or_default()
    }
}

/// What a link server needs to take a backup, from `redundancy.json`.
pub fn apply_backup_settings(config: &RedundancyConfig, host: &mut HostConfig) {
    host.accept_backup = true;
    host.backup_pin = crate::link::config::NetworkSessionConfig::pin(&config.backup_pin);
    host.backup_trusted = config.backup_trusted.clone();
}

fn configure_shared(handle: &HostHandle, config: &RedundancyConfig) {
    handle.set_backup_pin(crate::link::config::NetworkSessionConfig::pin(
        &config.backup_pin,
    ));
    handle.set_accept_backup(true);
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

fn attach(app: &AppHandle, main: &mut MainRuntime, slot: ServerSlot) {
    let handle = slot.handle().clone();
    main.publisher = publisher::spawn(app, handle.clone());
    main.persist = Some(spawn_persist(app, &handle));
    main.server = Some(slot);
}

fn hosting_handle(app: &AppHandle) -> Option<HostHandle> {
    crate::link::host::with_handle(app, HostHandle::clone)
}

async fn start_own_server(app: &AppHandle, config: &RedundancyConfig) -> Result<HostHandle, String> {
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
    Ok(runtime.handle)
}

pub async fn set_role(app: &AppHandle, role: RedundancyRole) -> Result<RedundancyRole, String> {
    let state = app.state::<RedundancyState>();
    let current = state.role();
    if current == role {
        return Ok(role);
    }
    if let Ok(mut main) = state.main.lock() {
        main.shut_down();
    };
    if role == RedundancyRole::Main {
        let config = redundancy_config::load(app);
        let slot = match hosting_handle(app) {
            Some(handle) => {
                configure_shared(&handle, &config);
                ServerSlot::Shared(handle)
            }
            None => ServerSlot::Own(start_own_server(app, &config).await?),
        };
        let mut main = state.main.lock().map_err(|_| "state poisoned")?;
        attach(app, &mut main, slot);
    }
    if let Ok(mut current) = state.role.lock() {
        *current = role;
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
pub fn hosting_started(app: &AppHandle, handle: &HostHandle) {
    let state = app.state::<RedundancyState>();
    if state.role() != RedundancyRole::Main {
        return;
    }
    let config = redundancy_config::load(app);
    configure_shared(handle, &config);
    if let Ok(mut main) = state.main.lock() {
        main.shut_down();
        attach(app, &mut main, ServerSlot::Shared(handle.clone()));
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
        main.server = None;
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let config = redundancy_config::load(&app);
        if let Ok(handle) = start_own_server(&app, &config).await {
            let state = app.state::<RedundancyState>();
            if let Ok(mut main) = state.main.lock() {
                if state.role() == RedundancyRole::Main && main.server.is_none() {
                    attach(&app, &mut main, ServerSlot::Own(handle));
                } else {
                    handle.stop();
                }
            };
        }
    });
}

#[tauri::command]
pub async fn set_redundancy_role(
    app: AppHandle,
    role: RedundancyRole,
) -> Result<RedundancyRole, String> {
    set_role(&app, role).await
}

#[tauri::command]
pub fn get_redundancy_role(app: AppHandle) -> RedundancyRole {
    app.state::<RedundancyState>().role()
}
