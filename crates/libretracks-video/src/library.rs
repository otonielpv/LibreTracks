//! Where libmpv is looked for, and loading it.
//!
//! Order: `LIBRETRACKS_LIBMPV` (to debug with another build), then the
//! bundle, then — Linux only — the system library. The first one that loads
//! wins; if none does, the error lists every attempt so the settings tab and
//! the diagnostics panel can say why video is off.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::mpv::MpvLibrary;
use crate::VideoError;

/// Environment variable that points at a specific libmpv to load.
pub const LIBMPV_ENV_VAR: &str = "LIBRETRACKS_LIBMPV";

/// File name of libmpv as the release bundles it, per platform.
pub fn bundled_file_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "libmpv-2.dll"
    } else if cfg!(target_os = "macos") {
        "libmpv.2.dylib"
    } else {
        "libmpv.so.2"
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Windows,
    MacOs,
    Linux,
    /// Android / iOS: video is desktop-only, nothing is looked for.
    Mobile,
}

impl Platform {
    pub fn current() -> Self {
        if cfg!(any(target_os = "android", target_os = "ios")) {
            Platform::Mobile
        } else if cfg!(target_os = "windows") {
            Platform::Windows
        } else if cfg!(target_os = "macos") {
            Platform::MacOs
        } else {
            Platform::Linux
        }
    }
}

/// Every path to try, in order. Pure so the order is testable.
///
/// * `env_override` — value of [`LIBMPV_ENV_VAR`], if set. When present it is
///   the only candidate: someone debugging with a specific build wants a clear
///   failure, not a silent fall back to the bundled one.
/// * `exe_dir` — directory of the running executable.
/// * `resource_dir` — Tauri's resource directory.
pub fn candidate_paths(
    platform: Platform,
    env_override: Option<&str>,
    exe_dir: Option<&Path>,
    resource_dir: Option<&Path>,
) -> Vec<PathBuf> {
    if platform == Platform::Mobile {
        return Vec::new();
    }
    if let Some(path) = env_override.map(str::trim).filter(|path| !path.is_empty()) {
        return vec![PathBuf::from(path)];
    }

    let file_name = match platform {
        Platform::Windows => "libmpv-2.dll",
        Platform::MacOs => "libmpv.2.dylib",
        Platform::Linux | Platform::Mobile => "libmpv.so.2",
    };
    let mut candidates = Vec::new();
    let mut push = |path: PathBuf| {
        if !candidates.contains(&path) {
            candidates.push(path);
        }
    };
    if let Some(dir) = resource_dir {
        push(dir.join(file_name));
        push(dir.join("libmpv").join(file_name));
    }
    if let Some(dir) = exe_dir {
        // Windows installs resources next to the exe; the .app keeps
        // frameworks in Contents/Frameworks; the Linux packages keep private
        // libraries in ../lib/<app>.
        push(dir.join(file_name));
        match platform {
            Platform::MacOs => push(dir.join("../Frameworks").join(file_name)),
            Platform::Linux => {
                push(dir.join("../lib/libretracks").join(file_name));
                push(dir.join("../lib/LibreTracks").join(file_name));
            }
            _ => {}
        }
    }
    if platform == Platform::Linux {
        // Bare names: let the dynamic loader search the system. The .deb/.rpm
        // recommend `libmpv2 | libmpv1` / `mpv-libs`; older distros (Ubuntu
        // 22.04) only have the 1.x soname, whose API covers everything used here.
        push(PathBuf::from("libmpv.so.2"));
        push(PathBuf::from("libmpv.so.1"));
    }
    candidates
}

/// A libmpv that loaded, and from where.
pub struct LoadedLibmpv {
    pub library: Arc<MpvLibrary>,
    pub path: PathBuf,
}

/// Try every candidate. The error names each attempt and why it failed.
pub fn load_libmpv(resource_dir: Option<&Path>) -> Result<LoadedLibmpv, VideoError> {
    let platform = Platform::current();
    if platform == Platform::Mobile {
        return Err(VideoError::Unsupported);
    }
    let env_override = std::env::var(LIBMPV_ENV_VAR).ok();
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf));
    let candidates = candidate_paths(
        platform,
        env_override.as_deref(),
        exe_dir.as_deref(),
        resource_dir,
    );

    let mut attempts = Vec::new();
    for path in candidates {
        // A bare name is resolved by the loader; anything else must exist.
        let is_bare_name = path.components().count() == 1;
        if !is_bare_name && !path.exists() {
            attempts.push(format!("{}: no existe", path.display()));
            continue;
        }
        match MpvLibrary::load(&path) {
            Ok(library) => return Ok(LoadedLibmpv { library, path }),
            Err(error) => attempts.push(error.to_string()),
        }
    }
    Err(VideoError::LibraryUnavailable(if attempts.is_empty() {
        "no hay rutas candidatas".into()
    } else {
        attempts.join("; ")
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_env_override_is_the_only_candidate() {
        let paths = candidate_paths(
            Platform::Windows,
            Some("D:/mpv/libmpv-2.dll"),
            Some(Path::new("C:/App")),
            Some(Path::new("C:/App/res")),
        );
        assert_eq!(paths, vec![PathBuf::from("D:/mpv/libmpv-2.dll")]);
    }

    #[test]
    fn an_empty_override_is_ignored() {
        let paths = candidate_paths(Platform::Windows, Some("  "), Some(Path::new("C:/App")), None);
        assert_eq!(paths, vec![PathBuf::from("C:/App/libmpv-2.dll")]);
    }

    #[test]
    fn windows_looks_in_resources_then_next_to_the_exe() {
        let paths = candidate_paths(
            Platform::Windows,
            None,
            Some(Path::new("C:/App")),
            Some(Path::new("C:/App/res")),
        );
        assert_eq!(
            paths,
            vec![
                PathBuf::from("C:/App/res/libmpv-2.dll"),
                PathBuf::from("C:/App/res/libmpv/libmpv-2.dll"),
                PathBuf::from("C:/App/libmpv-2.dll"),
            ]
        );
    }

    #[test]
    fn macos_looks_in_the_bundle_frameworks() {
        let paths = candidate_paths(
            Platform::MacOs,
            None,
            Some(Path::new("/Applications/LibreTracks.app/Contents/MacOS")),
            None,
        );
        assert!(paths.contains(&PathBuf::from(
            "/Applications/LibreTracks.app/Contents/MacOS/../Frameworks/libmpv.2.dylib"
        )));
        assert!(!paths.contains(&PathBuf::from("libmpv.2.dylib")));
    }

    #[test]
    fn linux_falls_back_to_the_system_library_last() {
        let paths = candidate_paths(Platform::Linux, None, Some(Path::new("/usr/bin")), None);
        let tail = &paths[paths.len() - 2..];
        assert_eq!(
            tail,
            [PathBuf::from("libmpv.so.2"), PathBuf::from("libmpv.so.1")]
        );
        assert_eq!(paths[0], PathBuf::from("/usr/bin/libmpv.so.2"));
    }

    #[test]
    fn mobile_has_no_candidates() {
        assert!(candidate_paths(Platform::Mobile, Some("x"), None, None).is_empty());
    }

    #[test]
    fn a_missing_library_is_an_error_not_a_panic() {
        let dir = tempfile::tempdir().expect("temp dir");
        let bogus = dir.path().join("no-existe").join(bundled_file_name());
        match MpvLibrary::load(&bogus) {
            Err(VideoError::LibraryUnavailable(reason)) => assert!(!reason.is_empty()),
            Err(other) => panic!("unexpected error {other:?}"),
            Ok(_) => panic!("a missing file must not load"),
        }
    }

    #[test]
    fn a_file_that_is_not_libmpv_is_rejected() {
        let dir = tempfile::tempdir().expect("temp dir");
        let fake = dir.path().join(bundled_file_name());
        std::fs::write(&fake, b"not a library").expect("write fake");
        assert!(matches!(
            MpvLibrary::load(&fake),
            Err(VideoError::LibraryUnavailable(_))
        ));
    }
}
