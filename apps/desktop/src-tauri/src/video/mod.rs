//! Video in the app: the output (libmpv on the desktop, AVPlayer / Media3 on
//! iOS / Android), the sync runtime, the thumbnail worker.
//!
//! Everything here tolerates the backend being absent: the app starts, audio
//! plays, and video reports itself unavailable with the reason.

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod displays;
pub mod device_import;
pub mod import_question;
pub mod live;
pub mod native_events;
#[cfg(any(target_os = "android", target_os = "ios"))]
pub mod native_media;
pub mod runtime;
pub mod thumbnail_queue;

use std::path::PathBuf;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use std::sync::Arc;
use std::sync::OnceLock;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use libretracks_video::output::UnavailableBackend;
use libretracks_video::output::{OutputCommand, OutputStatus, VideoOutput};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use libretracks_video::MpvLibrary;
use serde::Serialize;

use thumbnail_queue::ThumbnailQueue;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[derive(Clone)]
struct LoadedLibrary {
    library: Arc<MpvLibrary>,
    path: PathBuf,
}

/// Process-wide video services, owned by `DesktopState`.
#[derive(Default)]
pub struct VideoSystem {
    resource_dir: OnceLock<PathBuf>,
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    library: OnceLock<Result<LoadedLibrary, String>>,
    /// macOS: how the output reaches the AppKit main thread (Tauri's).
    #[cfg(target_os = "macos")]
    main_thread: OnceLock<libretracks_video::surface_macos::MainThread>,
    pub thumbnails: ThumbnailQueue,
    output: OnceLock<VideoOutput>,
    /// Output settings in force (the runtime reads the latency offset and
    /// the stopped-screen choice from here).
    settings: std::sync::Mutex<libretracks_video::settings::VideoOutputSettings>,
    /// Emergency black and forced idle screen (paso 13). Volatile by design:
    /// never saved, a restart starts with the picture.
    live: std::sync::Mutex<live::LiveState>,
    pub runtime: runtime::VideoRuntimeHandle,
    calibration: std::sync::Mutex<Option<runtime::CalibrationGrid>>,
    /// Videos this device cannot decode (plan video-mobile, paso 07 §1), by
    /// `thumbs::source_identity` of the file on disk, with the reason. Per
    /// device and per run: never written to the session, which may open on a
    /// machine that plays them.
    unplayable: std::sync::Mutex<std::collections::HashMap<String, String>>,
}

/// Whether video works on this machine, and why not if it does not. Shown by
/// the settings tab, the wizard and the diagnostics panel.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VideoLibraryStatus {
    /// Video is played on this platform (every platform since plan
    /// video-mobile; kept for the UI, which still reads it).
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

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
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
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    pub fn libmpv(&self) -> Result<Arc<MpvLibrary>, String> {
        self.loaded()
            .as_ref()
            .map(|loaded| Arc::clone(&loaded.library))
            .map_err(Clone::clone)
    }

    /// Start the output thread. With libmpv it drives the real surface;
    /// without, every attempt to open reports `Unavailable` with the reason.
    /// Idempotent.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    pub fn start_output(&self) -> &VideoOutput {
        self.output.get_or_init(|| match self.libmpv() {
            Ok(library) => VideoOutput::spawn(self.backend(library)),
            Err(reason) => VideoOutput::spawn(UnavailableBackend(reason)),
        })
    }

    /// Start the output thread over the native players (plan video-mobile,
    /// paso 03). The event sink is installed before the native side starts
    /// listening for displays, so the first list is not lost. Idempotent.
    #[cfg(any(target_os = "android", target_os = "ios"))]
    pub fn start_output(&self) -> &VideoOutput {
        self.output.get_or_init(|| {
            use libretracks_video::native::{native_event_channel, NativeOutputBackend};
            let (sink, events) = native_event_channel();
            native_events::install_sink(sink);
            #[cfg(target_os = "android")]
            let (bridge, start): (_, fn()) = (
                crate::platform::android_video::AndroidVideoBridge,
                crate::platform::android_video::AndroidVideoBridge::start,
            );
            #[cfg(target_os = "ios")]
            let (bridge, start): (_, fn()) = (
                crate::platform::ios_video::IosVideoBridge,
                crate::platform::ios_video::IosVideoBridge::start,
            );
            let output = VideoOutput::spawn(NativeOutputBackend::new(bridge, events));
            start();
            output
        })
    }

    #[cfg(not(any(target_os = "macos", target_os = "android", target_os = "ios")))]
    fn backend(&self, library: Arc<MpvLibrary>) -> libretracks_video::mpv_backend::MpvOutputBackend {
        libretracks_video::mpv_backend::MpvOutputBackend::new(library)
    }

    /// macOS draws in a panel of ours, created on the main thread (paso 15).
    #[cfg(target_os = "macos")]
    fn backend(&self, library: Arc<MpvLibrary>) -> libretracks_video::mpv_backend::MpvOutputBackend {
        match self.main_thread.get() {
            Some(main) => libretracks_video::mpv_backend::MpvOutputBackend::new_macos(library, Arc::clone(main)),
            None => libretracks_video::mpv_backend::MpvOutputBackend::new(library),
        }
    }

    /// macOS: set before [`VideoSystem::start_output`], from the app's setup.
    #[cfg(target_os = "macos")]
    pub fn set_main_thread(&self, main: libretracks_video::surface_macos::MainThread) {
        let _ = self.main_thread.set(main);
    }

    pub fn set_settings(&self, settings: libretracks_video::settings::VideoOutputSettings) {
        if let Ok(mut current) = self.settings.lock() {
            *current = settings.clone();
        }
        self.send(OutputCommand::ApplySettings(settings));
        self.runtime.notify();
    }

    /// Start (`Some`) or end (`None`) the latency calibration. `flash_image`
    /// is the white picture the output shows meanwhile.
    pub fn set_calibration(
        &self,
        grid: Option<runtime::CalibrationGrid>,
        flash_image: Option<String>,
    ) {
        if let Ok(mut current) = self.calibration.lock() {
            *current = grid;
        }
        self.send(OutputCommand::Overlay(grid.and(flash_image)));
        if grid.is_none() {
            self.send(OutputCommand::SetBrightness(0.0));
        }
        self.runtime.notify();
    }

    /// The live-control state (forced black / idle).
    pub fn live(&self) -> live::LiveState {
        self.live.lock().map(|state| *state).unwrap_or_default()
    }

    pub(crate) fn update_live(&self, change: impl FnOnce(&mut live::LiveState)) -> live::LiveState {
        let state = match self.live.lock() {
            Ok(mut state) => {
                change(&mut state);
                *state
            }
            Err(_) => live::LiveState::default(),
        };
        self.runtime.notify();
        state
    }

    /// Analyse a video with this platform's decoder (libmpv on the desktop,
    /// the system's on a phone). Blocking: off the session lock. A codec the
    /// device cannot decode is remembered, so the library can say "not
    /// playable on this device" without calling it missing.
    pub fn probe(
        &self,
        path: &std::path::Path,
    ) -> Result<libretracks_core::VideoAssetInfo, libretracks_video::media::ProbeError> {
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        let result = self
            .libmpv()
            .map_err(libretracks_video::media::ProbeError::Failed)
            .and_then(|library| {
                libretracks_video::extract::probe(&library, path)
                    .map_err(|error| libretracks_video::media::ProbeError::Failed(error.to_string()))
            });
        #[cfg(any(target_os = "android", target_os = "ios"))]
        let result = {
            use libretracks_video::media::VideoProbe;
            native_media::NativeVideoProbe.probe(path)
        };
        if let Ok(mut unplayable) = self.unplayable.lock() {
            let key = libretracks_video::thumbs::source_identity(path);
            match &result {
                Err(error @ libretracks_video::media::ProbeError::Unsupported { .. }) => {
                    unplayable.insert(key, error.message());
                }
                Ok(_) => {
                    unplayable.remove(&key);
                }
                Err(_) => {}
            }
        }
        result
    }

    /// Why the file at `path` does not play on this device, if a probe said
    /// so this run.
    pub fn unplayable_reason(&self, path: &std::path::Path) -> Option<String> {
        self.unplayable
            .lock()
            .ok()?
            .get(&libretracks_video::thumbs::source_identity(path))
            .cloned()
    }

    pub fn calibration(&self) -> Option<runtime::CalibrationGrid> {
        self.calibration.lock().ok().and_then(|grid| *grid)
    }

    pub fn settings(&self) -> libretracks_video::settings::VideoOutputSettings {
        self.settings
            .lock()
            .map(|settings| settings.clone())
            .unwrap_or_default()
    }

    /// Queue a command for the output, if it was started. Never blocks.
    pub fn send(&self, command: OutputCommand) {
        if let Some(output) = self.output.get() {
            output.send(command);
        }
    }

    /// Latest output status (`Disabled` if the output never started).
    pub fn output_status(&self) -> OutputStatus {
        self.output
            .get()
            .map(VideoOutput::status)
            .unwrap_or_default()
    }

    #[cfg(any(target_os = "android", target_os = "ios"))]
    pub fn status(&self) -> VideoLibraryStatus {
        mobile_library_status(self.output.get().map(VideoOutput::status).as_ref())
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    pub fn status(&self) -> VideoLibraryStatus {
        let supported_platform = true;
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

/// [`VideoSystem::probe`] as a [`libretracks_video::media::VideoProbe`], for
/// the thumbnail worker.
pub struct SystemProbe(pub std::sync::Arc<VideoSystem>);

impl libretracks_video::media::VideoProbe for SystemProbe {
    fn probe(
        &self,
        path: &std::path::Path,
    ) -> Result<libretracks_core::VideoAssetInfo, libretracks_video::media::ProbeError> {
        self.0.probe(path)
    }
}

/// What the settings tab and the timeline are told on a phone (paso 03 §4):
/// the native players are there unless the output said otherwise. The libmpv
/// fields stay `None`; the UI already treats them as optional.
#[cfg_attr(not(any(target_os = "android", target_os = "ios")), allow(dead_code))]
fn mobile_library_status(output: Option<&OutputStatus>) -> VideoLibraryStatus {
    use libretracks_video::output::OutputState;
    let (available, reason) = match output.map(|status| &status.state) {
        None => (false, Some("la salida de vídeo no ha arrancado".to_string())),
        Some(OutputState::Unavailable(reason)) => (false, Some(reason.clone())),
        Some(_) => (true, None),
    };
    VideoLibraryStatus {
        supported_platform: true,
        available,
        reason,
        library_path: None,
        client_api_version: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Paso 03 C4/C7: on a phone the status follows the native output.
    #[test]
    fn the_mobile_status_follows_the_native_output() {
        use libretracks_video::output::OutputState;
        let ready = OutputStatus {
            state: OutputState::NoDisplay,
            ..Default::default()
        };
        let status = mobile_library_status(Some(&ready));
        assert!(status.supported_platform && status.available);
        assert_eq!(status.library_path, None);

        let missing = OutputStatus {
            state: OutputState::Unavailable("VideoOutputBridge no está".into()),
            ..Default::default()
        };
        let status = mobile_library_status(Some(&missing));
        assert!(!status.available);
        assert_eq!(status.reason.as_deref(), Some("VideoOutputBridge no está"));

        assert!(!mobile_library_status(None).available);
    }

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
