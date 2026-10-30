//! Cloud transfer commands: sign in to the user's own Google Drive, OneDrive or
//! Dropbox and move `.ltpkg` / `.ltset` packages in and out of it.
//!
//! LibreTracks stores nothing and hosts nothing. The files land in an account
//! the user owns, under a folder of the app's own with `Songs/` and `Sessions/`
//! inside, reached with a token that never leaves this device. See
//! [`libretracks_cloud`] for the shape of all that.
//!
//! Every command but the status takes the provider's key (`google-drive`,
//! `onedrive`, `dropbox`). Several accounts can be connected at once, one per
//! provider, and each export or import says which one it is for.
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

use libretracks_cloud::token::{TokenManager, TokenStore};
use libretracks_cloud::{CloudError, CloudProvider, CloudStorage, RemoteFolder};

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
    /// Stable key the other commands take: `google-drive`, `onedrive`, `dropbox`.
    pub provider: String,
    /// Product name, for display.
    pub name: String,
    /// Whether this build can talk to the provider at all.
    ///
    /// Separate from `connected` on purpose: a build without the OAuth client
    /// secret or id completes the whole consent screen and only then fails, so
    /// the UI must be able to hide or disable the provider up front rather
    /// than walking the user into that.
    pub configured: bool,
    pub connected: bool,
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

fn provider_from(key: &str) -> Result<CloudProvider, String> {
    CloudProvider::from_key(key).ok_or_else(|| format!("unknown cloud provider: {key}"))
}

/// The credential store for this platform.
///
/// Three different mechanisms behind one trait, because no single crate covers
/// them: `keyring` reaches Credential Manager, Keychain and Secret Service on
/// desktop but has no mobile backend at all, so Android goes through
/// `AndroidKeyStore` over JNI and iOS through its own Keychain.
///
/// A refresh token is standing authorisation to reach part of a real person's
/// cloud storage until they revoke it, which is why none of these is "a file
/// in app storage".
///
/// One entry per provider, named by its key, so disconnecting one account
/// never touches another's credentials.
fn token_store(app: &AppHandle, provider: CloudProvider) -> Result<Box<dyn TokenStore>, String> {
    // Only the iOS branch needs it; the others reach their store without one.
    let _ = app;
    #[cfg(target_os = "android")]
    {
        Ok(Box::new(
            crate::platform::android_token_store::AndroidTokenStore::new(provider.key()),
        ))
    }
    #[cfg(target_os = "ios")]
    {
        Ok(Box::new(crate::platform::ios_token_store::IosTokenStore::new(
            app.clone(),
            provider.key(),
        )))
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        Ok(Box::new(
            libretracks_cloud::keychain::KeychainTokenStore::new(provider.key())
                .map_err(describe)?,
        ))
    }
}

fn token_manager(app: &AppHandle, provider: CloudProvider) -> Result<TokenManager, String> {
    TokenManager::new(provider.oauth(), token_store(app, provider)?).map_err(describe)
}

fn storage(app: &AppHandle, provider: &str) -> Result<Box<dyn CloudStorage>, String> {
    let provider = provider_from(provider)?;
    let manager = token_manager(app, provider)?;
    provider.storage(Box::new(manager)).map_err(describe)
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
/// ever sees or keeps, so neither is worth a location prompt in a flow they
/// experience as one step.
///
/// # Why the app cache dir and not the OS temp dir
///
/// Because on Android there is no OS temp dir to speak of: `/tmp` does not
/// exist and the root filesystem is read-only, so `temp_dir()` resolves to a
/// path the app cannot create — which is exactly how this failed on a real
/// device with `could not create the staging directory: Permission denied`.
/// The per-app cache directory is writable on every platform, and on Android
/// the system may reclaim it under pressure, which is the right behaviour for
/// files nobody keeps.
#[tauri::command]
pub async fn cloud_staging_dir(app: AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("no cache directory available: {e}"))?
        .join("cloud-staging");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("could not create the staging directory: {e}"))?;
    Ok(dir.to_string_lossy().into_owned())
}

/// Delete a staged package once its transfer is done.
///
/// These are whole `.ltset` packages — gigabytes, on devices that have little
/// room. Leaving them to whatever eventually clears the cache is not good
/// enough, so each flow drops its own file as soon as it is finished with it.
///
/// Refuses anything outside the staging directory: the path comes back from the
/// frontend, and a delete command that takes an arbitrary path is not something
/// to leave lying around.
#[tauri::command]
pub async fn cloud_discard_staged(app: AppHandle, path: String) -> Result<(), String> {
    let staging = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("no cache directory available: {e}"))?
        .join("cloud-staging");
    let target = PathBuf::from(&path);

    if !target.starts_with(&staging) {
        return Err("refusing to delete a file outside the staging directory".to_string());
    }
    match std::fs::remove_file(&target) {
        Ok(()) => Ok(()),
        // Already gone is the desired end state.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("could not delete the staged package: {e}")),
    }
}

/// Every provider this app knows, in display order, with its state.
///
/// Unconfigured ones are included rather than filtered out so the frontend can
/// decide how to present them; it hides them today.
#[tauri::command]
pub async fn cloud_status(app: AppHandle) -> Result<Vec<CloudStatus>, String> {
    Ok(CloudProvider::ALL
        .into_iter()
        .map(|provider| {
            let configured = provider.is_configured();
            let connected = configured
                && token_manager(&app, provider)
                    .map(|manager| manager.is_connected())
                    .unwrap_or(false);
            CloudStatus {
                provider: provider.key().to_string(),
                name: provider.display_name().to_string(),
                configured,
                connected,
            }
        })
        .collect())
}

/// Run the sign-in: open the system browser, catch the redirect, store the
/// token in the OS credential store.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
pub async fn cloud_connect(app: AppHandle, provider: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    use libretracks_cloud::token::exchange_code;

    let provider = provider_from(&provider)?;
    // Checked before anything is opened. Failing here shows a plain "cloud not
    // configured in this build"; failing after the consent screen shows an
    // opaque OAuth error to someone who already granted access.
    if !provider.is_configured() {
        return Err(format!(
            "this build has no {} OAuth credentials configured",
            provider.display_name()
        ));
    }

    let oauth = provider.oauth();
    let listener = provider.bind_loopback().await.map_err(describe)?;
    let session = provider
        .begin_sign_in(listener.port())
        .map_err(|e| e.to_string())?;

    app.opener()
        .open_url(oauth.authorization_url(&session), None::<&str>)
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

    let token = exchange_code(oauth.as_ref(), &session, &params.code)
        .await
        .map_err(describe)?;

    token_manager(&app, provider)?
        .adopt(&token)
        .map_err(describe)
}

/// Where a sign-in in progress is waiting for its redirect.
///
/// The deep-link handler is registered ONCE at start-up rather than per
/// attempt: `on_open_url` has no way to unregister, so installing one each time
/// someone pressed Connect would pile up handlers for the life of the process.
/// A sign-in drops its sender here, the single handler finds it, and anything
/// arriving with no sign-in in flight is discarded.
#[cfg(any(target_os = "android", target_os = "ios"))]
static PENDING_REDIRECT: std::sync::OnceLock<
    std::sync::Mutex<Option<tokio::sync::oneshot::Sender<String>>>,
> = std::sync::OnceLock::new();

#[cfg(any(target_os = "android", target_os = "ios"))]
fn pending_redirect() -> &'static std::sync::Mutex<Option<tokio::sync::oneshot::Sender<String>>> {
    PENDING_REDIRECT.get_or_init(|| std::sync::Mutex::new(None))
}

/// Route OAuth redirects to whichever sign-in is waiting. Call once, at setup.
#[cfg(any(target_os = "android", target_os = "ios"))]
pub fn register_deep_link_handler(app: &AppHandle) {
    use tauri_plugin_deep_link::DeepLinkExt;

    app.deep_link().on_open_url(|event| {
        let Some(url) = event.urls().first().map(|url| url.to_string()) else {
            return;
        };
        // Taken, not cloned: a redirect is consumed once. A second link arriving
        // with nothing waiting is dropped, which is what should happen to a
        // stale one the system replays after the app was killed.
        if let Some(sender) = pending_redirect().lock().ok().and_then(|mut slot| slot.take()) {
            let _ = sender.send(url);
        }
    });
}

/// Mobile signs in through a deep link rather than a loopback socket, which
/// Google deprecated for the Android and iOS client types.
///
/// The browser is the SYSTEM browser, opened through the opener plugin. Google
/// rejects an embedded WebView outright with `disallowed_useragent`, so this is
/// not a stylistic choice.
#[cfg(any(target_os = "android", target_os = "ios"))]
#[tauri::command]
pub async fn cloud_connect(app: AppHandle, provider: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    use libretracks_cloud::redirect::parse_redirect_str;
    use libretracks_cloud::token::exchange_code;

    let provider = provider_from(&provider)?;
    if !provider.is_configured() {
        return Err(format!(
            "this build has no {} OAuth credentials configured",
            provider.display_name()
        ));
    }
    let oauth = provider.oauth();
    // Port is ignored on mobile: the redirect is a private URI scheme, not a
    // socket. Passing 0 keeps one signature for every platform.
    let session = provider.begin_sign_in(0).map_err(|e| e.to_string())?;

    let (sender, receiver) = tokio::sync::oneshot::channel();
    {
        let mut slot = pending_redirect()
            .lock()
            .map_err(|_| "the deep link slot is poisoned".to_string())?;
        // Replaces any abandoned attempt: the old receiver is gone, so its
        // sender would fail anyway, and leaving it would make THIS sign-in the
        // one that never receives anything.
        *slot = Some(sender);
    }

    app.opener()
        .open_url(oauth.authorization_url(&session), None::<&str>)
        .map_err(|e| format!("could not open the browser: {e}"))?;

    let raw = tokio::time::timeout(SIGN_IN_TIMEOUT, receiver)
        .await
        .map_err(|_| "the sign-in timed out".to_string())?
        .map_err(|_| "the sign-in was interrupted".to_string())?;

    let params = parse_redirect_str(&raw).map_err(describe)?;
    // Never skip. Only the flow that started this sign-in knows the state.
    session
        .verify_state(&params.state)
        .map_err(|e| e.to_string())?;

    let token = exchange_code(oauth.as_ref(), &session, &params.code)
        .await
        .map_err(describe)?;

    token_manager(&app, provider)?
        .adopt(&token)
        .map_err(describe)
}

/// Forget one provider's account. The others stay connected.
#[tauri::command]
pub async fn cloud_disconnect(app: AppHandle, provider: String) -> Result<(), String> {
    let provider = provider_from(&provider)?;
    // Drive's folder ids belong to the account they came from. Keeping them
    // across a sign-out would have the next account writing into ids that are
    // not its own.
    provider.forget_cached_state().await;
    token_manager(&app, provider)?
        .disconnect()
        .map_err(describe)
}

#[tauri::command]
pub async fn cloud_quota(app: AppHandle, provider: String) -> Result<CloudQuota, String> {
    let quota = storage(&app, &provider)?.quota().await.map_err(describe)?;
    Ok(CloudQuota {
        used_bytes: quota.used_bytes,
        limit_bytes: quota.limit_bytes,
        free_bytes: quota.free_bytes(),
    })
}

#[tauri::command]
pub async fn cloud_list(
    app: AppHandle,
    provider: String,
    folder: String,
) -> Result<Vec<CloudFile>, String> {
    let files = storage(&app, &provider)?
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
pub async fn cloud_upload(
    app: AppHandle,
    provider: String,
    local_path: String,
) -> Result<CloudFile, String> {
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
    let uploaded = storage(&app, &provider)?
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
    provider: String,
    file_id: String,
    file_name: String,
    dest_dir: String,
) -> Result<String, String> {
    let dest = PathBuf::from(dest_dir).join(&file_name);
    let transfer = TransferGuard::begin()?;
    let handle = app.clone();
    storage(&app, &provider)?
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
pub async fn cloud_delete(app: AppHandle, provider: String, file_id: String) -> Result<(), String> {
    storage(&app, &provider)?
        .delete(&file_id)
        .await
        .map_err(describe)
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

    #[test]
    fn provider_keys_from_the_frontend_resolve() {
        assert_eq!(provider_from("google-drive").unwrap(), CloudProvider::GoogleDrive);
        assert_eq!(provider_from("onedrive").unwrap(), CloudProvider::OneDrive);
        assert_eq!(provider_from("dropbox").unwrap(), CloudProvider::Dropbox);
        assert!(provider_from("Google Drive").is_err());
    }
}
