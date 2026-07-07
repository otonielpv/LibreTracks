//! Android stub for the remote-control module. On mobile the app itself is
//! the handheld device, so the embedded remote server (and its
//! `libretracks-remote` dependency) is excluded from the build entirely.

use tauri::App;

pub fn initialize_remote(_app: &App) -> Result<(), String> {
    Ok(())
}
