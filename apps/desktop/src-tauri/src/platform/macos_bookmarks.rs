//! macOS security-scoped bookmarks for session folders.
//!
//! # Why this exists
//!
//! A LibreTracks session is a folder: `<name>.ltsession` (the JSON project
//! file) lives next to an `audio/` subfolder holding every clip. When the user
//! opens a session, the native open panel grants access to the file (or folder)
//! they *explicitly* picked — but macOS scopes that grant to that item only.
//! Reading the sibling audio files then trips TCC (Transparency, Consent and
//! Control), which prompts *per file*. Reopening a saved session later (from a
//! stored path, with no fresh panel) is worse: every audio read prompts, and if
//! a decode runs on the main thread the prompt freezes the app so "Allow" looks
//! like it did nothing.
//!
//! A security-scoped bookmark captures the access the user granted to a folder
//! and lets us re-acquire it later — across relaunches and, with a stable
//! signing identity, across app updates. We create one for the session's
//! containing folder the moment the open panel grants access, persist it, and
//! resolve + `startAccessingSecurityScopedResource` before reopening from a
//! stored path. One grant per session, not one prompt per file.
//!
//! # Cross-platform shape
//!
//! The public API compiles everywhere so call sites in `project.rs` stay free
//! of `#[cfg]`. On non-macOS targets every function is a cheap no-op: folder
//! access there isn't gated by TCC, so there's nothing to bookmark.

use std::path::Path;

/// A live security-scoped access grant. Dropping it calls
/// `stopAccessingSecurityScopedResource`, so hold it for as long as the session
/// (and its audio files) must stay readable — typically for the lifetime of the
/// open session. On non-macOS targets this is a zero-sized placeholder.
#[cfg(target_os = "macos")]
pub struct ScopedAccess {
    url: objc2::rc::Retained<objc2_foundation::NSURL>,
}

#[cfg(not(target_os = "macos"))]
pub struct ScopedAccess;

#[cfg(target_os = "macos")]
impl Drop for ScopedAccess {
    fn drop(&mut self) {
        // SAFETY: `url` came from `startAccessingSecurityScopedResource`
        // returning true, so the balancing stop call is required and safe.
        unsafe { self.url.stopAccessingSecurityScopedResource() };
    }
}

/// Record a bookmark for `folder`, given fresh access from a native open panel.
///
/// Call this right after the user picks a session via the file dialog: at that
/// moment macOS has granted access to the picked item, so a bookmark of the
/// containing folder captures a grant broad enough to cover the audio inside.
/// Failures are logged and swallowed — bookmarking is an optimization; the app
/// still works (with prompts) without it.
pub fn remember_folder(app: &tauri::AppHandle, folder: &Path) {
    let _ = (app, folder);
    #[cfg(target_os = "macos")]
    macos::remember_folder(app, folder);
}

/// Re-acquire access to `folder` from a previously stored bookmark.
///
/// Returns `Some(ScopedAccess)` when a bookmark existed and resolved: hold the
/// guard to keep the folder readable. Returns `None` when there's no bookmark
/// yet (first open on this machine, or a session created before bookmarks
/// shipped) — the caller proceeds normally and may still be prompted. Keeping
/// the guard alive is the caller's responsibility.
#[must_use]
pub fn acquire_folder(app: &tauri::AppHandle, folder: &Path) -> Option<ScopedAccess> {
    let _ = (app, folder);
    #[cfg(target_os = "macos")]
    {
        return macos::acquire_folder(app, folder);
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::ScopedAccess;
    use objc2::rc::Retained;
    use objc2::runtime::Bool;
    use objc2_foundation::{NSData, NSString, NSURL, NSURLBookmarkCreationOptions,
        NSURLBookmarkResolutionOptions};
    use serde::{Deserialize, Serialize};
    use std::collections::BTreeMap;
    use std::path::{Path, PathBuf};
    use tauri::Manager;

    /// Persisted bookmark store: session folder (as a string path) -> base64
    /// bookmark blob. Keyed by path so reopening the same folder finds it; the
    /// blob itself is what actually re-grants access even if the path is stale.
    #[derive(Default, Serialize, Deserialize)]
    struct BookmarkStore {
        folders: BTreeMap<String, String>,
    }

    fn store_path(app: &tauri::AppHandle) -> Option<PathBuf> {
        let dir = app.path().app_data_dir().ok()?;
        Some(dir.join("session_bookmarks.json"))
    }

    fn load_store(app: &tauri::AppHandle) -> BookmarkStore {
        let Some(path) = store_path(app) else {
            return BookmarkStore::default();
        };
        let Ok(bytes) = std::fs::read(&path) else {
            return BookmarkStore::default();
        };
        serde_json::from_slice(&bytes).unwrap_or_default()
    }

    fn save_store(app: &tauri::AppHandle, store: &BookmarkStore) {
        let Some(path) = store_path(app) else {
            return;
        };
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        match serde_json::to_vec_pretty(store) {
            Ok(bytes) => {
                if let Err(error) = std::fs::write(&path, bytes) {
                    log_warn(&format!("failed to persist bookmark store: {error}"));
                }
            }
            Err(error) => log_warn(&format!("failed to serialize bookmark store: {error}")),
        }
    }

    fn log_warn(message: &str) {
        crate::infra::error_log::write_error(&format!("[macos-bookmarks] {message}"));
    }

    fn url_for_folder(folder: &Path) -> Option<Retained<NSURL>> {
        let path = folder.to_str()?;
        let ns_path = NSString::from_str(path);
        // fileURLWithPath treats the string as a filesystem path (not a URL to
        // parse), which is what we want for local session folders. Mark it a
        // directory so the bookmark scopes to the folder, not a file.
        Some(NSURL::fileURLWithPath_isDirectory(&ns_path, true))
    }

    pub(super) fn remember_folder(app: &tauri::AppHandle, folder: &Path) {
        let Some(url) = url_for_folder(folder) else {
            log_warn("could not build NSURL for folder");
            return;
        };

        // Create a security-scoped bookmark. `WithSecurityScope` is the option
        // that makes the grant re-acquirable later; without it the bookmark
        // resolves but does not re-open the sandbox door.
        let data: Retained<NSData> = match url
            .bookmarkDataWithOptions_includingResourceValuesForKeys_relativeToURL_error(
                NSURLBookmarkCreationOptions::WithSecurityScope,
                None,
                None,
            ) {
            Ok(data) => data,
            Err(error) => {
                log_warn(&format!(
                    "bookmarkDataWithOptions failed for {}: {error}",
                    folder.display()
                ));
                return;
            }
        };

        let blob = data_to_base64(&data);
        let mut store = load_store(app);
        store
            .folders
            .insert(folder.to_string_lossy().into_owned(), blob);
        save_store(app, &store);
    }

    pub(super) fn acquire_folder(app: &tauri::AppHandle, folder: &Path) -> Option<ScopedAccess> {
        let store = load_store(app);
        let blob = store.folders.get(&folder.to_string_lossy().into_owned())?;
        let data = base64_to_data(blob)?;

        // `is_stale` is an out-param the API sets to true when the bookmark
        // still resolves but should be regenerated (e.g. the folder moved).
        let mut is_stale = Bool::NO;
        let url: Retained<NSURL> = unsafe {
            NSURL::URLByResolvingBookmarkData_options_relativeToURL_bookmarkDataIsStale_error(
                &data,
                NSURLBookmarkResolutionOptions::WithSecurityScope,
                None,
                &mut is_stale,
            )
        }
        .map_err(|error| {
            log_warn(&format!(
                "URLByResolvingBookmarkData failed for {}: {error}",
                folder.display()
            ))
        })
        .ok()?;

        // SAFETY: `url` is a freshly resolved security-scoped file URL; the
        // balancing stop happens in ScopedAccess::drop.
        let started = unsafe { url.startAccessingSecurityScopedResource() };
        if !started {
            log_warn(&format!(
                "startAccessingSecurityScopedResource returned false for {}",
                folder.display()
            ));
            return None;
        }

        if is_stale.as_bool() {
            remember_folder(app, folder);
        }

        Some(ScopedAccess { url })
    }

    fn data_to_base64(data: &NSData) -> String {
        use base64::Engine;
        // SAFETY: the slice is read and copied into the base64 string
        // immediately; the NSData is not mutated while the borrow is alive.
        // `as_bytes_unchecked` needs only the `NSData` feature (unlike
        // `to_vec`, which pulls in `alloc` + `block2`).
        let bytes = unsafe { data.as_bytes_unchecked() };
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    fn base64_to_data(blob: &str) -> Option<Retained<NSData>> {
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(blob)
            .ok()?;
        Some(NSData::with_bytes(&bytes))
    }
}
