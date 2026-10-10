//! Network sessions between LibreTracks apps (docs/plans/network-sessions).
//!
//! Not the remote: `crate::remote` serves the browser SPA and stays as it is.
//! This module adapts `libretracks-link` to the app on every platform: it
//! keeps the per-install configuration, runs the host, and (step 05) the
//! guest client. Everything here only does something when the user starts
//! it from the UI, which lives behind `FEATURE_FLAGS.networkSessions`.

pub mod commands;
pub mod config;
pub mod host;

use std::sync::Mutex;

use tauri::{App, Manager};

use config::NetworkSessionConfig;

pub struct LinkState {
    pub config: Mutex<NetworkSessionConfig>,
    pub host: Mutex<Option<host::ActiveHost>>,
}

pub fn initialize_link(app: &App) {
    let config = config::load(app.handle());
    let resume_hosting = config.keep_hosting_after_restart && config.was_hosting;
    app.manage(LinkState {
        config: Mutex::new(config),
        host: Mutex::new(None),
    });
    if resume_hosting {
        let handle = app.handle().clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = host::start(&handle).await {
                eprintln!("[libretracks-link] could not resume hosting: {error}");
            }
        });
    }
}
