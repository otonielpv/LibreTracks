//! Video on the desktop side: loading libmpv, the thumbnail worker and (later
//! steps) the output window and the sync runtime.
//!
//! Everything here tolerates libmpv being absent: the app starts, audio plays,
//! and video reports itself unavailable with the reason.

pub mod thumbnail_queue;

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use libretracks_video::MpvLibrary;
use serde::Serialize;

use thumbnail_queue::ThumbnailQueue;

#[derive(Clone)]
struct LoadedLibrary {
    library: Arc<MpvLibrary>,
    path: PathBuf,
}

/// Process-wide video services, owned by `DesktopState`.
#[derive(Default)]
pub struct VideoSystem {
    resource_dir: OnceLock<PathBuf>,
    library: OnceLock<Result<LoadedLibrary, String>>,
    pub thumbnails: ThumbnailQueue,
}

/// Whether video works on this machine, and why not if it does not. Shown by
/// the settings tab, the wizard and the diagnostics panel.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VideoLibraryStatus {
    /// False on Android/iOS: video is desktop-only.
    pub supported_platform: bool,
    pub available: bool,
    pub reason: Option<String>,
    pub library_path: Option<String>,
    pub client_api_version: Option<String>,
}

impl VideoSystem {
    /// Tauri's resource directory, where the installer puts libmpv. Set once
    /// at startup, before the first use.
    pub fn set_resource_dir(&self, dir: PathBuf) {
        let _ = self.resource_dir.set(dir);
    }

    fn loaded(&self) -> &Result<LoadedLibrary, String> {
        self.library.get_or_init(|| {
            libretracks_video::load_libmpv(self.resource_dir.get().map(PathBuf::as_path))
                .map(|loaded| LoadedLibrary {
                    library: loaded.library,
                    path: loaded.path,
                })
                .map_err(|error| error.to_string())
        })
    }

    /// libmpv, loaded on first use. The result (success or failure) is kept
    /// for the life of the process: a failed load is not retried per call.
    pub fn libmpv(&self) -> Result<Arc<MpvLibrary>, String> {
        self.loaded()
            .as_ref()
            .map(|loaded| Arc::clone(&loaded.library))
            .map_err(Clone::clone)
    }

    pub fn status(&self) -> VideoLibraryStatus {
        let supported_platform = !cfg!(any(target_os = "android", target_os = "ios"));
        match self.loaded() {
            Ok(loaded) => VideoLibraryStatus {
                supported_platform,
                available: true,
                reason: None,
                library_path: Some(loaded.path.to_string_lossy().into_owned()),
                client_api_version: Some(loaded.library.client_api_version().to_string()),
            },
            Err(reason) => VideoLibraryStatus {
                supported_platform,
                available: false,
                reason: Some(reason.clone()),
                library_path: None,
                client_api_version: None,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// C6 del paso 02: una libmpv que no existe deja el vídeo desactivado con
    /// el motivo, sin pánico, y el fallo se recuerda (no se reintenta).
    #[test]
    fn a_missing_libmpv_reports_unavailable_with_a_reason() {
        let system = VideoSystem::default();
        let dir = tempfile::tempdir().expect("temp dir");
        // No override and an empty resource dir: on Windows and macOS nothing
        // is found. (Linux may find a system libmpv, which is fine too.)
        std::env::remove_var(libretracks_video::LIBMPV_ENV_VAR);
        system.set_resource_dir(dir.path().to_path_buf());
        let status = system.status();
        if cfg!(any(windows, target_os = "macos")) && !status.available {
            assert!(status
                .reason
                .as_deref()
                .is_some_and(|reason| !reason.is_empty()));
            assert!(system.libmpv().is_err());
            assert_eq!(system.status(), status, "the failure is cached");
        }
    }
}
