//! The bundled demo session.
//!
//! A DAW that opens to an empty timeline gives a first-time user nothing to
//! press, and gives an App Store reviewer no way to evaluate the app at all —
//! which is a 2.1 rejection, not a bad review. Shipping a small two-song set
//! fixes both: one tap produces a real session with recorded stems, sections,
//! keys and an already-shaped mix, playable immediately.
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

/// The demo session already sitting in the songs folder, if any.
///
/// Pressing "canción de demostración" twice means "open the demo", not "make me
/// another copy": copying it on every press left a trail of `Demo`, `Demo 2`,
/// `Demo 3`… and a new entry in the recents list each time. To start over from
/// scratch, delete it from the landing screen and press again.
fn existing_demo_session(parent: &Path) -> Option<PathBuf> {
    let dir = parent.join(DEMO_SESSION_NAME);
    if !dir.is_dir() {
        return None;
    }
    fs::read_dir(&dir)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .find(|path| {
            path.extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("ltsession"))
        })
}

/// A folder name inside `parent` that is not taken yet.
///
/// Only reached when the demo folder is there but unusable (no `.ltsession`
/// inside): a half-copied folder must not stop the button from working.
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

/// The demo song's `.ltsession` path, copying it into the device's songs folder
/// the first time.
///
/// Deliberately stops at "here it is": the caller opens it through the same path
/// the landing screen already uses for every other session, so the demo cannot
/// drift into having loading behaviour of its own.
#[tauri::command(async)]
pub fn open_demo_session(app: AppHandle) -> Result<String, String> {
    let demo_dir = bundled_demo_dir(&app)
        .ok_or_else(|| "Esta version no incluye la cancion de demostracion.".to_string())?;

    let parent = crate::state::create_song_default_directory(&app);
    fs::create_dir_all(&parent)
        .map_err(|error| format!("no se pudo preparar la carpeta de canciones: {error}"))?;

    // Ya esta: se abre la de siempre. Copiarla en cada pulsacion dejaba un
    // rastro de "Demo 2", "Demo 3"... y una entrada nueva en recientes.
    if let Some(existing) = existing_demo_session(&parent) {
        return Ok(existing.to_string_lossy().into_owned());
    }

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
    use libretracks_core::{validate_song, Song, TrackKind};

    fn shipped_demo_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/demo")
    }

    /// The shipped document has to deserialize into the *current* model. It is
    /// generated by scripts/pack-demo-session.py against the format as it was
    /// on the day it ran, so this is the guardrail that catches the day a
    /// required field appears and the demo silently stops opening on a phone.
    #[test]
    fn shipped_demo_session_parses_into_the_current_model() {
        let path = shipped_demo_dir().join("song.ltsession");
        let raw = fs::read_to_string(&path).expect("la sesion de demo debe existir");
        let song: Song = serde_json::from_str(&raw).expect("la sesion de demo debe deserializar");
        validate_song(&song).expect("la sesion de demo debe cumplir los invariantes");

        assert_eq!(
            song.tracks.len(),
            6,
            "cinco stems y una carpeta compartidos"
        );
        assert_eq!(
            song.regions.len(),
            2,
            "la demo es un repertorio de dos canciones"
        );
        assert_eq!(song.clips.len(), 10, "cinco clips por cancion");
        assert_eq!(
            song.section_markers.len(),
            7,
            "marcas musicales de las dos canciones"
        );
        let jump_digits: Vec<_> = song
            .section_markers
            .iter()
            .filter_map(|marker| marker.digit)
            .collect();
        assert_eq!(jump_digits, vec![1, 2, 3, 4, 5, 6, 7]);
        assert!(
            song.section_markers.windows(2).all(|pair| {
                pair[1].start_seconds - pair[0].start_seconds >= 4.0
            }),
            "cada marca debe dejar sitio para anunciar seccion y conteo"
        );
        assert!(song.duration_seconds > 120.0);
    }

    /// The point of shipping two songs instead of one is that a session is a
    /// setlist: each song carries its own key and tempo. If a future
    /// edit collapses them into one uniform block the demo still plays, but it
    /// stops demonstrating the thing the app exists for — so pin the contrast.
    #[test]
    fn the_two_demo_songs_differ_in_key_and_tempo() {
        let raw = fs::read_to_string(shipped_demo_dir().join("song.ltsession")).unwrap();
        let song: Song = serde_json::from_str(&raw).unwrap();

        let keys: Vec<_> = song
            .regions
            .iter()
            .map(|region| region.key.clone())
            .collect();
        assert!(
            keys.iter().all(Option::is_some),
            "cada cancion declara tonalidad"
        );
        assert_ne!(keys[0], keys[1], "dos tonalidades distintas");

        assert_eq!(
            song.tempo_markers.len(),
            2,
            "un cambio de tempo por cancion"
        );
        assert_ne!(
            song.tempo_markers[0].bpm, song.tempo_markers[1].bpm,
            "dos tempos distintos"
        );

        assert_eq!(song.time_signature_markers.len(), 1);
        assert_eq!(song.time_signature_markers[0].signature, "4/4");

        // The second song must actually start after the first ends, or the
        // regions overlap and the transport cannot tell them apart.
        assert!(
            song.regions[1].start_seconds >= song.regions[0].end_seconds,
            "las regiones no pueden solaparse"
        );
    }

    /// The demo should expose the controls that are otherwise easy to miss on
    /// a fresh mobile session: hierarchy, group routing and a non-flat mix.
    #[test]
    fn shipped_demo_showcases_folders_volume_and_pan() {
        let raw = fs::read_to_string(shipped_demo_dir().join("song.ltsession")).unwrap();
        let song: Song = serde_json::from_str(&raw).unwrap();

        let folder = song
            .tracks
            .iter()
            .find(|track| track.id == "track-guitarras")
            .expect("la demo debe incluir la carpeta Guitarras");
        assert_eq!(folder.kind, TrackKind::Folder);

        let guitars: Vec<_> = song
            .tracks
            .iter()
            .filter(|track| track.parent_track_id.as_deref() == Some(folder.id.as_str()))
            .collect();
        assert_eq!(guitars.len(), 2, "la carpeta agrupa las dos guitarras");
        assert!(guitars.iter().all(|track| track.audio_to == "inherit"));
        assert!(guitars.iter().any(|track| track.pan < 0.0));
        assert!(guitars.iter().any(|track| track.pan > 0.0));
        assert!(song.tracks.iter().any(|track| track.volume < 1.0));
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
    fn shipped_demo_library_groups_assets_by_song() {
        let dir = shipped_demo_dir();
        let raw = fs::read_to_string(dir.join("library.json"))
            .expect("la demo debe incluir el manifiesto de biblioteca");
        let manifest: serde_json::Value =
            serde_json::from_str(&raw).expect("library.json debe ser valido");

        assert_eq!(
            manifest["folders"],
            serde_json::json!(["Costa Norte", "Callejón Blues"])
        );
        let assets = manifest["assets"]
            .as_array()
            .expect("library.json debe declarar sus assets");
        assert_eq!(assets.len(), 10, "cinco stems por carpeta de cancion");
        for asset in assets {
            let path = asset["filePath"].as_str().expect("ruta de asset");
            let folder = asset["folderPath"].as_str().expect("carpeta de asset");
            assert!(matches!(folder, "Costa Norte" | "Callejón Blues"));
            assert!(dir.join(path).is_file(), "falta {path}");
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
