//! The bundled demo song.
//!
//! A DAW that opens to an empty timeline gives a first-time user nothing to
//! press, and gives an App Store reviewer no way to evaluate the app at all —
//! which is a 2.1 rejection, not a bad review. Shipping one small song fixes
//! both: one tap produces a real session with four stems, sections and a key,
//! playable immediately.
//!
//! The demo is a plain session folder (`song.ltsession` + `audio/`), so
//! creating one is a directory copy rather than a second code path that builds
//! arrangements programmatically. Clip paths inside it are relative, which is
//! what lets the copy land under any name without rewriting the document.
//!
//! Mobile only in practice: desktop keeps the guided tour, and
//! `tauri.conf.json` deliberately does not bundle `resources/demo`. The code
//! stays platform-neutral so the dev source tree can exercise it anywhere.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager};

const DEMO_SESSION_NAME: &str = "Cancion de demostracion";

/// Resolve the bundled demo folder.
///
/// Mirrors `voice_guide_voices_dir` in [`crate::commands::settings`]: Android
/// reads the copy `MainActivity` makes into `filesDir` (Tauri's resource
/// bundler does not ship `resources` into an APK), every other platform reads
/// the Tauri resource dir, and the crate source tree is the dev fallback.
///
/// Returns `None` unless the session document is really there. A desktop
/// release has no `resources/demo` at all, and a path that merely looks right
/// would surface later as a confusing copy failure instead of a clear answer
/// here.
fn bundled_demo_dir(app: &AppHandle) -> Option<PathBuf> {
    fn with_session(dir: PathBuf) -> Option<PathBuf> {
        dir.join("song.ltsession").is_file().then_some(dir)
    }

    #[cfg(target_os = "android")]
    {
        // app_local_data_dir() is the data BASE (/data/data/<pkg>);
        // MainActivity copies to filesDir = <base>/files/demo.
        return app
            .path()
            .app_local_data_dir()
            .ok()
            .and_then(|base| with_session(base.join("files").join("demo")));
    }

    #[cfg(not(target_os = "android"))]
    {
        if let Some(dir) = app
            .path()
            .resource_dir()
            .ok()
            .and_then(|resources| with_session(resources.join("demo")))
        {
            return Some(dir);
        }
        with_session(Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/demo"))
    }
}

/// A folder name inside `parent` that is not taken yet.
///
/// Creating the demo twice is a normal thing to do — someone wrecks the first
/// copy experimenting, which is exactly what a demo is for — so the second
/// request must neither fail nor overwrite the first.
fn available_session_name(parent: &Path) -> String {
    if !parent.join(DEMO_SESSION_NAME).exists() {
        return DEMO_SESSION_NAME.to_string();
    }
    // Bounded: past a few dozen copies something is wrong with the caller, and
    // an unbounded loop would spin forever on a directory we cannot write to.
    for suffix in 2..100 {
        let name = format!("{DEMO_SESSION_NAME} {suffix}");
        if !parent.join(&name).exists() {
            return name;
        }
    }
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or_default();
    format!("{DEMO_SESSION_NAME} {stamp}")
}

/// Copy `src` into `dst` recursively, renaming the session document to match
/// the destination folder.
///
/// LibreTracks locates a session by scanning its folder for any `.ltsession`,
/// so the name is cosmetic — but a folder called "… 2" holding a document
/// named after the original reads as a bug to whoever opens it.
fn copy_demo_tree(src: &Path, dst: &Path, session_name: &str) -> std::io::Result<PathBuf> {
    fs::create_dir_all(dst)?;
    let mut session_file = None;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        if entry.file_type()?.is_dir() {
            copy_demo_tree(&from, &dst.join(entry.file_name()), session_name)?;
            continue;
        }
        let is_session = from
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("ltsession"));
        let to = if is_session {
            dst.join(format!("{session_name}.ltsession"))
        } else {
            dst.join(entry.file_name())
        };
        fs::copy(&from, &to)?;
        if is_session {
            session_file = Some(to);
        }
    }
    Ok(session_file.unwrap_or_else(|| dst.join(format!("{session_name}.ltsession"))))
}

/// Create a fresh copy of the demo song in the device's songs folder and return
/// its `.ltsession` path.
///
/// Deliberately stops at "created": the caller opens it through the same path
/// the landing screen already uses for every other session, so the demo cannot
/// drift into having loading behaviour of its own.
#[tauri::command(async)]
pub fn create_demo_session(app: AppHandle) -> Result<String, String> {
    let demo_dir = bundled_demo_dir(&app)
        .ok_or_else(|| "Esta version no incluye la cancion de demostracion.".to_string())?;

    let parent = crate::state::create_song_default_directory(&app);
    fs::create_dir_all(&parent)
        .map_err(|error| format!("no se pudo preparar la carpeta de canciones: {error}"))?;

    let session_name = available_session_name(&parent);
    let target = parent.join(&session_name);
    let session_file = copy_demo_tree(&demo_dir, &target, &session_name).map_err(|error| {
        // Leave nothing half-copied behind: a folder holding three of the four
        // stems would appear on the landing screen as a broken session.
        let _ = fs::remove_dir_all(&target);
        format!("no se pudo crear la cancion de demostracion: {error}")
    })?;

    Ok(session_file.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use libretracks_core::model::Song;

    fn shipped_demo_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/demo")
    }

    /// The shipped document has to deserialize into the *current* model. It is
    /// generated by scripts/generate-demo-song.py against the format as it was
    /// on the day it ran, so this is the guardrail that catches the day a
    /// required field appears and the demo silently stops opening on a phone.
    #[test]
    fn shipped_demo_session_parses_into_the_current_model() {
        let path = shipped_demo_dir().join("song.ltsession");
        let raw = fs::read_to_string(&path).expect("la sesion de demo debe existir");
        let song: Song = serde_json::from_str(&raw).expect("la sesion de demo debe deserializar");

        assert_eq!(song.tracks.len(), 4, "la demo tiene cuatro stems");
        assert_eq!(song.clips.len(), 4, "un clip por stem");
        assert_eq!(
            song.section_markers.len(),
            4,
            "intro, estrofa, estribillo y final"
        );
        assert!(song.duration_seconds > 30.0);
    }

    /// Every clip must point at a file that is actually bundled, by a relative
    /// path. An absolute path would work on the machine that generated it and
    /// break on every device that installs the app.
    #[test]
    fn shipped_demo_clips_resolve_inside_the_bundle() {
        let dir = shipped_demo_dir();
        let raw = fs::read_to_string(dir.join("song.ltsession")).unwrap();
        let song: Song = serde_json::from_str(&raw).unwrap();

        for clip in &song.clips {
            let path = Path::new(&clip.file_path);
            assert!(path.is_relative(), "{} debe ser relativa", clip.file_path);
            assert!(
                dir.join(path).is_file(),
                "falta el audio {} en el paquete",
                clip.file_path
            );
        }
    }

    #[test]
    fn second_copy_gets_its_own_folder() {
        let temp = std::env::temp_dir().join(format!("lt-demo-{}", std::process::id()));
        let _ = fs::remove_dir_all(&temp);
        fs::create_dir_all(&temp).unwrap();

        let first = available_session_name(&temp);
        fs::create_dir_all(temp.join(&first)).unwrap();
        let second = available_session_name(&temp);

        assert_eq!(first, DEMO_SESSION_NAME);
        assert_ne!(first, second, "la segunda copia no puede pisar la primera");

        let _ = fs::remove_dir_all(&temp);
    }
}
