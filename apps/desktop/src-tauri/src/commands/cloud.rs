//! Cloud transfer commands: sign in to the user's own Google Drive and move
//! `.ltpkg` / `.ltset` packages in and out of it.
//!
//! LibreTracks stores nothing and hosts nothing. The files land in an account
//! the user owns, under a `LibreTracks/` folder with `Songs/` and `Sessions/`
//! inside, reached with a token that never leaves this device. See
//! [`libretracks_cloud`] for the shape of all that.
//!
//! # These are explicit transfers, not sync
//!
//! Nothing here runs in the background and nothing reconciles. The user presses
//! upload or download and knows exactly what happened, which is why there are
//! no conflicts to resolve.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use libretracks_cloud::google::client_config;
use libretracks_cloud::google::drive::DriveClient;
use libretracks_cloud::token::{TokenManager, TokenStore};
use libretracks_cloud::{CloudError, CloudStorage, RemoteFolder};

const TRANSFER_PROGRESS_EVENT: &str = "cloud:transfer-progress";

/// Exactly one foreground cloud transfer is allowed. The command that owns the
/// token drops it on every success/error path; the cancel command only flips
/// the token and never has to own or abort another async task directly.
static ACTIVE_TRANSFER: OnceLock<Mutex<Option<Arc<AtomicBool>>>> = OnceLock::new();

fn active_transfer() -> &'static Mutex<Option<Arc<AtomicBool>>> {
    ACTIVE_TRANSFER.get_or_init(|| Mutex::new(None))
}

struct TransferGuard {
    cancelled: Arc<AtomicBool>,
}

impl TransferGuard {
    fn begin() -> Result<Self, String> {
        let mut active = active_transfer()
            .lock()
            .map_err(|_| "cloud transfer state is unavailable".to_string())?;
        if active.is_some() {
            return Err("another cloud transfer is already running".to_string());
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        *active = Some(Arc::clone(&cancelled));
        Ok(Self { cancelled })
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
}

impl Drop for TransferGuard {
    fn drop(&mut self) {
        if let Ok(mut active) = active_transfer().lock() {
            if active
                .as_ref()
                .is_some_and(|token| Arc::ptr_eq(token, &self.cancelled))
            {
                *active = None;
            }
        }
    }
}

/// How long a sign-in may sit waiting for the browser.
///
/// Someone who closes the consent tab never comes back, and without a bound the
/// loopback listener would hold a task and a port for the life of the process.
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(300);

// ── DTOs ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudStatus {
    /// Whether this build can talk to Google at all.
    ///
    /// Separate from `connected` on purpose: a build without the OAuth client
    /// secret completes the whole consent screen and only then fails, so the UI
    /// must be able to hide or disable the feature up front rather than walking
    /// the user into that.
    pub configured: bool,
    pub connected: bool,
    pub provider: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudQuota {
    pub used_bytes: u64,
    /// `None` on an account with no ceiling.
    pub limit_bytes: Option<u64>,
    pub free_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudFile {
    pub id: String,
    pub name: String,
    pub size_bytes: u64,
    pub modified: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TransferProgress {
    done_bytes: u64,
    total_bytes: u64,
    percent: u8,
    emitted_at_unix_ms: u128,
}

// ── Plumbing ─────────────────────────────────────────────────────────────────

fn describe(error: CloudError) -> String {
    error.to_string()
}

/// Whether this build carries the credentials it needs.
///
/// Google requires the client secret for desktop clients despite documenting it
/// as optional, and it is injected at build time rather than committed, so a
/// clone built without `LIBRETRACKS_GOOGLE_CLIENT_SECRET` legitimately has
/// none. Mobile client types are issued no secret and are always configured.
fn is_configured() -> bool {
    if cfg!(any(target_os = "android", target_os = "ios")) {
        true
    } else {
        client_config::CLIENT_SECRET.is_some()
    }
}

/// The credential store for this platform.
///
/// Three different mechanisms behind one trait, because no single crate covers
/// them: `keyring` reaches Credential Manager, Keychain and Secret Service on
/// desktop but has no mobile backend at all, so Android goes through
/// `AndroidKeyStore` over JNI and iOS through its own Keychain.
///
/// A refresh token is standing authorisation to reach part of a real person's
/// Drive until they revoke it, which is why none of these is "a file in app
/// storage".
fn token_store(app: &AppHandle) -> Result<Box<dyn TokenStore>, String> {
    // Only the iOS branch needs it; the others reach their store without one.
    let _ = app;
    #[cfg(target_os = "android")]
    {
        Ok(Box::new(
            crate::platform::android_token_store::AndroidTokenStore::google_drive(),
        ))
    }
    #[cfg(target_os = "ios")]
    {
        Ok(Box::new(
            crate::platform::ios_token_store::IosTokenStore::google_drive(app.clone()),
        ))
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        Ok(Box::new(
            libretracks_cloud::keychain::KeychainTokenStore::google_drive().map_err(describe)?,
        ))
    }
}

fn drive(app: &AppHandle) -> Result<DriveClient, String> {
    let manager = TokenManager::new(token_store(app)?).map_err(describe)?;
    DriveClient::new(Box::new(manager)).map_err(describe)
}

fn folder_from(name: &str) -> Result<RemoteFolder, String> {
    match name {
        "songs" => Ok(RemoteFolder::Songs),
        "sessions" => Ok(RemoteFolder::Sessions),
        other => Err(format!("unknown cloud folder: {other}")),
    }
}

fn emit_progress(app: &AppHandle, done: u64, total: u64) {
    let percent = if total == 0 {
        0
    } else {
        ((done.min(total) * 100) / total) as u8
    };
    let payload = TransferProgress {
        done_bytes: done,
        total_bytes: total,
        percent,
        emitted_at_unix_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0),
    };
    if let Err(error) = app.emit(TRANSFER_PROGRESS_EVENT, payload) {
        eprintln!("[libretracks-cloud] failed to emit transfer progress: {error}");
    }
}

// ── Commands ─────────────────────────────────────────────────────────────────

/// Scratch directory for packages on their way to or from the cloud.
///
/// An upload has to be written somewhere before it can be sent, and a download
/// has to land somewhere before it can be imported. Neither is a file the user
/// ever sees or keeps, so both use the OS temp directory rather than asking for
/// a location that would only be noise in a flow they think of as one step.
///
/// Stale files here are the price of a transfer that died mid-way; the OS
/// reclaims them, and reusing the same directory keeps them from multiplying.
#[tauri::command]
pub async fn cloud_staging_dir(app: AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .temp_dir()
        .map_err(|e| format!("no temp directory available: {e}"))?
        .join("libretracks-cloud");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("could not create the staging directory: {e}"))?;
    Ok(dir.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn cloud_status(app: AppHandle) -> Result<CloudStatus, String> {
    let connected = token_store(&app)
        .ok()
        .and_then(|store| TokenManager::new(store).ok())
        .map(|manager| manager.is_connected())
        .unwrap_or(false);

    Ok(CloudStatus {
        configured: is_configured(),
        connected,
        provider: "Google Drive".to_string(),
    })
}

/// Run the sign-in: open the system browser, catch the redirect, store the
/// token in the OS credential store.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
pub async fn cloud_connect(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    use libretracks_cloud::google::oauth::AuthSession;
    use libretracks_cloud::loopback::LoopbackListener;
    use libretracks_cloud::token::exchange_code;

    // Checked before anything is opened. Failing here shows a plain "cloud not
    // configured in this build"; failing after the consent screen shows an
    // opaque OAuth error to someone who already granted access.
    if !is_configured() {
        return Err("this build has no Google OAuth client secret configured".to_string());
    }

    let listener = LoopbackListener::bind().await.map_err(describe)?;
    let session = AuthSession::begin(listener.port()).map_err(|e| e.to_string())?;

    app.opener()
        .open_url(session.authorization_url(), None::<&str>)
        .map_err(|e| format!("could not open the browser: {e}"))?;

    let params = tokio::time::timeout(SIGN_IN_TIMEOUT, listener.wait_for_redirect())
        .await
        .map_err(|_| "the sign-in timed out".to_string())?
        .map_err(describe)?;

    // Never skip. Anything running on this machine can reach the loopback
    // socket; only the flow that started this sign-in knows the state value.
    session
        .verify_state(&params.state)
        .map_err(|e| e.to_string())?;

    let token = exchange_code(&session, &params.code)
        .await
        .map_err(describe)?;

    TokenManager::new(token_store(&app)?)
        .map_err(describe)?
        .adopt(&token)
        .map_err(describe)
}

/// Mobile signs in through a deep link rather than a loopback socket, which
/// Google deprecated for the Android and iOS client types. Not wired yet, so it
/// says so instead of failing in a way that looks like a bug.
#[cfg(any(target_os = "android", target_os = "ios"))]
#[tauri::command]
pub async fn cloud_connect(_app: AppHandle) -> Result<(), String> {
    Err("cloud sign-in is not available on mobile yet".to_string())
}

#[tauri::command]
pub async fn cloud_disconnect(app: AppHandle) -> Result<(), String> {
    // Folder ids belong to the Drive they came from. Keeping them across a
    // sign-out would have the next account writing into ids that are not its
    // own.
    libretracks_cloud::google::drive::forget_cached_folders().await;
    TokenManager::new(token_store(&app)?)
        .map_err(describe)?
        .disconnect()
        .map_err(describe)
}

#[tauri::command]
pub async fn cloud_quota(app: AppHandle) -> Result<CloudQuota, String> {
    let quota = drive(&app)?.quota().await.map_err(describe)?;
    Ok(CloudQuota {
        used_bytes: quota.used_bytes,
        limit_bytes: quota.limit_bytes,
        free_bytes: quota.free_bytes(),
    })
}

#[tauri::command]
pub async fn cloud_list(app: AppHandle, folder: String) -> Result<Vec<CloudFile>, String> {
    let files = drive(&app)?
        .list(folder_from(&folder)?)
        .await
        .map_err(describe)?;
    Ok(files
        .into_iter()
        .map(|f| CloudFile {
            id: f.id,
            name: f.name,
            size_bytes: f.size_bytes,
            modified: f.modified,
        })
        .collect())
}

/// Upload a local package, routed to `Songs` or `Sessions` by its extension.
#[tauri::command]
pub async fn cloud_upload(app: AppHandle, local_path: String) -> Result<CloudFile, String> {
    let path = PathBuf::from(&local_path);
    let folder = RemoteFolder::for_path(&path)
        .ok_or_else(|| "only .ltpkg and .ltset packages can be uploaded".to_string())?;
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "the file has no usable name".to_string())?
        .to_string();

    let transfer = TransferGuard::begin()?;
    let handle = app.clone();
    let uploaded = drive(&app)?
        .upload(folder, &path, &name, &move |done, total| {
            emit_progress(&handle, done, total)
        }, &move || transfer.is_cancelled())
        .await
        .map_err(describe)?;

    Ok(CloudFile {
        id: uploaded.id,
        name: uploaded.name,
        size_bytes: uploaded.size_bytes,
        modified: uploaded.modified,
    })
}

/// Download a package into `dest_dir`, returning the local path it landed on.
#[tauri::command]
pub async fn cloud_download(
    app: AppHandle,
    file_id: String,
    file_name: String,
    dest_dir: String,
) -> Result<String, String> {
    let dest = PathBuf::from(dest_dir).join(&file_name);
    let transfer = TransferGuard::begin()?;
    let handle = app.clone();
    drive(&app)?
        .download(&file_id, &dest, &move |done, total| {
            emit_progress(&handle, done, total)
        }, &move || transfer.is_cancelled())
        .await
        .map_err(describe)?;
    Ok(dest.to_string_lossy().into_owned())
}

/// Ask the active upload/download to abort. It is intentionally idempotent so
/// a double-click or a completion racing the click is harmless.
/// `async` keeps even this tiny mutex acquisition off the webview/main thread,
/// matching the invariant enforced for every non-dialog command in this app.
#[tauri::command(async)]
pub fn cloud_cancel_transfer() -> Result<(), String> {
    let active = active_transfer()
        .lock()
        .map_err(|_| "cloud transfer state is unavailable".to_string())?;
    if let Some(cancelled) = active.as_ref() {
        cancelled.store(true, Ordering::Release);
    }
    Ok(())
}

#[tauri::command]
pub async fn cloud_delete(app: AppHandle, file_id: String) -> Result<(), String> {
    drive(&app)?.delete(&file_id).await.map_err(describe)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folder_names_from_the_frontend_map_to_the_two_folders() {
        assert_eq!(folder_from("songs").unwrap(), RemoteFolder::Songs);
        assert_eq!(folder_from("sessions").unwrap(), RemoteFolder::Sessions);
        assert!(folder_from("templates").is_err());
        assert!(folder_from("").is_err());
    }
}
