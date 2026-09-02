//! iOS folder picker with persistent security-scoped access.
//!
//! Tauri's dialog plugin intentionally does not implement folder selection on
//! mobile yet. LibreTracks sessions are directories (manifest, audio and
//! sidecars), so selecting only the `.ltsession` file is insufficient on iOS:
//! the sandbox would not grant access to its siblings.

#![cfg(target_os = "ios")]

use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder, PluginHandle, TauriPlugin},
    AppHandle, Manager, Runtime,
};

tauri::ios_plugin_binding!(init_plugin_libretracks_ios_folder_picker);

#[derive(Debug, Deserialize)]
struct PickFolderResponse {
    folder: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PickFileResponse {
    file: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ExportFileResponse {
    exported: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportFileArgs<'a> {
    source_path: &'a str,
}

#[derive(Debug, Deserialize)]
struct SecureStoreGetResponse {
    /// Absent when nothing is stored, and also when what is stored can no
    /// longer be decrypted. Both mean "ask the user to sign in again".
    value: Option<String>,
}

#[derive(Debug, Serialize)]
struct SecureStoreSetArgs<'a> {
    name: &'a str,
    value: &'a str,
}

#[derive(Debug, Serialize)]
struct SecureStoreNameArgs<'a> {
    name: &'a str,
}

pub struct IosFolderPicker<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> IosFolderPicker<R> {
    pub fn pick_folder(&self) -> Result<Option<String>, String> {
        self.0
            .run_mobile_plugin::<PickFolderResponse>("pickFolder", ())
            .map(|response| response.folder)
            .map_err(|error| error.to_string())
    }

    pub fn pick_file(&self) -> Result<Option<String>, String> {
        self.0
            .run_mobile_plugin::<PickFileResponse>("pickFile", ())
            .map(|response| response.file)
            .map_err(|error| error.to_string())
    }

    pub fn export_file(&self, source_path: &str) -> Result<bool, String> {
        self.0
            .run_mobile_plugin::<ExportFileResponse>(
                "exportFile",
                ExportFileArgs { source_path },
            )
            .map(|response| response.exported)
            .map_err(|error| error.to_string())
    }

    // The keychain calls need no `spawn_blocking`, unlike the pickers above:
    // nothing here presents a UIViewController, so there is no main-queue round
    // trip to deadlock on. They are also called from async commands, which
    // Tauri already runs off the main thread.

    pub fn secure_store_set(&self, name: &str, value: &str) -> Result<(), String> {
        self.0
            .run_mobile_plugin::<()>("secureStoreSet", SecureStoreSetArgs { name, value })
            .map_err(|error| error.to_string())
    }

    pub fn secure_store_get(&self, name: &str) -> Result<Option<String>, String> {
        self.0
            .run_mobile_plugin::<SecureStoreGetResponse>(
                "secureStoreGet",
                SecureStoreNameArgs { name },
            )
            .map(|response| response.value)
            .map_err(|error| error.to_string())
    }

    pub fn secure_store_delete(&self, name: &str) -> Result<(), String> {
        self.0
            .run_mobile_plugin::<()>("secureStoreDelete", SecureStoreNameArgs { name })
            .map_err(|error| error.to_string())
    }
}

/// Keychain access for the signed-in cloud account.
///
/// Synchronous on purpose: the caller is [`libretracks_cloud::token::TokenStore`],
/// which is a synchronous trait because a token read happens in the middle of
/// building an HTTP request.
pub fn secure_store_set<R: Runtime>(
    app: &AppHandle<R>,
    name: &str,
    value: &str,
) -> Result<(), String> {
    app.state::<IosFolderPicker<R>>().secure_store_set(name, value)
}

pub fn secure_store_get<R: Runtime>(
    app: &AppHandle<R>,
    name: &str,
) -> Result<Option<String>, String> {
    app.state::<IosFolderPicker<R>>().secure_store_get(name)
}

pub fn secure_store_delete<R: Runtime>(app: &AppHandle<R>, name: &str) -> Result<(), String> {
    app.state::<IosFolderPicker<R>>().secure_store_delete(name)
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

pub async fn pick_file<R: Runtime>(app: AppHandle<R>) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<IosFolderPicker<R>>().pick_file())
        .await
        .map_err(|error| format!("iOS file picker worker failed: {error}"))?
}

/// Exporting also waits for a UIKit document picker result, so keep the
/// synchronous mobile-plugin bridge off the main thread just like pickFolder.
pub async fn export_file<R: Runtime>(
    app: AppHandle<R>,
    source_path: String,
) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<IosFolderPicker<R>>().export_file(&source_path)
    })
    .await
    .map_err(|error| format!("iOS diagnostics export worker failed: {error}"))?
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
