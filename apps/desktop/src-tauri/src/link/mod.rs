//! Network sessions between LibreTracks apps (docs/plans/network-sessions).
//!
//! Not the remote: `crate::remote` serves the browser SPA and stays as it is.
//! This module adapts `libretracks-link` to the app on every platform: it
//! keeps the per-install configuration, runs the host, and (step 05) the
//! guest client. Everything here only does something when the user starts
//! it from the UI, which lives behind `FEATURE_FLAGS.networkSessions`.

pub mod commands;
pub mod config;
pub mod discovery;
pub mod guest;
pub mod host;
pub mod lifecycle;

use std::sync::Mutex;

use tauri::{App, Manager};

use config::NetworkSessionConfig;

pub struct LinkState {
    pub config: Mutex<NetworkSessionConfig>,
    pub host: Mutex<Option<host::ActiveHost>>,
    /// A device is host or guest, never both at once.
    pub guest: Mutex<Option<guest::ActiveGuest>>,
    pub phase: Mutex<lifecycle::HostPhase>,
}

/// Keep the screen from auto-locking while hosting or following a host
/// (paso 03). Android already keeps it on for the whole app (MainActivity)
/// and desktop does not auto-lock under a running app, so only iOS acts.
pub fn keep_awake(reason: &str, on: bool) {
    #[cfg(target_os = "ios")]
    crate::platform::ios_link::keep_awake(reason, on);
    #[cfg(not(target_os = "ios"))]
    let _ = (reason, on);
}

/// The WebView's visibility (`set_app_hidden`), for the host's lifecycle.
pub fn app_visibility_changed(app: &tauri::AppHandle, hidden: bool) {
    host::visibility_changed(app, hidden);
}

pub fn initialize_link(app: &App) {
    let config = config::load(app.handle());
    let resume_hosting = config.keep_hosting_after_restart && config.was_hosting;
    let device_id = config.device_id.clone();
    app.manage(LinkState {
        config: Mutex::new(config),
        host: Mutex::new(None),
        guest: Mutex::new(None),
        phase: Mutex::new(lifecycle::HostPhase::Stopped),
    });
    discovery::init(app.handle(), &device_id);
    if resume_hosting {
        let handle = app.handle().clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = host::start(&handle).await {
                eprintln!("[libretracks-link] could not resume hosting: {error}");
            }
        });
    }
}
