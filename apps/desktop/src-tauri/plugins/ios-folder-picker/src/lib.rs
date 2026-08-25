//! iOS folder picker with persistent security-scoped access.
//!
//! Tauri's dialog plugin intentionally does not implement folder selection on
//! mobile yet. LibreTracks sessions are directories (manifest, audio and
//! sidecars), so selecting only the `.ltsession` file is insufficient on iOS:
//! the sandbox would not grant access to its siblings.

#![cfg(target_os = "ios")]

use serde::Deserialize;
use tauri::{
    plugin::{Builder, PluginHandle, TauriPlugin},
    AppHandle, Manager, Runtime,
};

tauri::ios_plugin_binding!(init_plugin_libretracks_ios_folder_picker);

#[derive(Debug, Deserialize)]
struct PickFolderResponse {
    folder: Option<String>,
}

pub struct IosFolderPicker<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> IosFolderPicker<R> {
    pub fn pick_folder(&self) -> Result<Option<String>, String> {
        self.0
            .run_mobile_plugin::<PickFolderResponse>("pickFolder", ())
            .map(|response| response.folder)
            .map_err(|error| error.to_string())
    }
}

/// `run_mobile_plugin` waits synchronously until Swift resolves its Invoke.
/// Run that wait away from Tauri's main thread: UIKit needs the main queue to
/// present UIDocumentPickerViewController, so blocking it here deadlocks the
/// Rust -> Swift -> UIKit -> Rust round trip on a physical iPhone.
pub async fn pick_folder<R: Runtime>(app: AppHandle<R>) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<IosFolderPicker<R>>().pick_folder()
    })
    .await
    .map_err(|error| format!("iOS folder picker worker failed: {error}"))?
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("libretracks-ios-folder-picker")
        .setup(|app, api| {
            let handle = api.register_ios_plugin(init_plugin_libretracks_ios_folder_picker)?;
            app.manage(IosFolderPicker(handle));
            Ok(())
        })
        .build()
}
