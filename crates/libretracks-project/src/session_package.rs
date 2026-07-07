//! Whole-session export/import as a single portable `.ltset` archive.
//!
//! Where [`crate::package`] bundles ONE region (song) for merging into an
//! existing session, this module bundles an ENTIRE session — every region,
//! track, clip, the library manifest, automation, and (in a full package) the
//! audio used by clips — so a set built on one machine opens unchanged on
//! another. This is the "create at home, play live elsewhere" flow, modelled
//! on Ableton's "Collect All and Save" but delivered as one zip.
//!
//! Two modes mirror the `.ltpkg` chooser:
//!   - **Light**: `session.ltsession` + sidecar files + waveforms. References
//!     audio by path — only reusable on the same machine.
//!   - **Full** (`include_audio`): also bundles the audio used by clips under
//!     `audio/`, making the set self-contained.
//!
//! The archive layout:
//! ```text
//! manifest.json                  format version + title + bundledAudio flag
//! session.ltsession              the full Song document (all regions)
//! sidecars/<name>                opaque project files (library.json, automation…)
//! audio/<file_name>              full packages only — audio referenced by clips
//! cache/waveforms/<name>.ltpeaks waveform peaks for instant open on the target
//! ```

use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
};

use libretracks_core::Song;
use serde::{Deserialize, Serialize};
use zip::{write::SimpleFileOptions, ZipArchive, ZipWriter};

use crate::song_store::{ProjectError, SONG_FILE_NAME};

/// Bumped when the on-disk shape of a `.ltset` changes in a non-additive way.
/// The importer rejects versions it doesn't understand rather than guessing.
const SESSION_PACKAGE_FORMAT_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionPackageManifest {
    format_version: u32,
    session_title: String,
    /// True when the package bundles the clip audio under `audio/`, making the
    /// set self-contained and portable to another machine.
    #[serde(default)]
    bundled_audio: bool,
}

/// A project file that travels alongside the session document but whose
/// contents this crate treats as opaque bytes (e.g. `library.json`,
/// `automation.ltautomation`). The caller names them so the crate stays
/// decoupled from the desktop app's sidecar set.
#[derive(Debug, Clone)]
pub struct SidecarFile {
    /// File name as it lives in the song dir, e.g. `"library.json"`.
    pub file_name: String,
}

#[derive(Debug, Clone)]
pub struct SessionPackageExport {
    pub output_path: PathBuf,
}

/// The decompressed payload of a `.ltset`, written into a fresh destination
/// song dir by [`extract_session_package`]. The caller opens this dir as a new
/// session — no merge into an existing one.
#[derive(Debug, Clone)]
pub struct ExtractedSessionPackage {
    /// The destination song dir the package was inflated into (the `.ltsession`
    /// lives directly inside it).
    pub song_dir: PathBuf,
    /// Absolute path to the inflated `session.ltsession`.
    pub song_file: PathBuf,
    pub session_title: String,
    pub bundled_audio: bool,
}

fn normalize_zip_path(file_path: &str) -> String {
    file_path.replace('\\', "/")
}

/// Reject zip entry names that try to escape the destination dir (absolute
/// paths, `..` traversal, drive letters). A `.ltset` may come from another
/// machine or person, so the inflater must not trust entry names blindly.
fn is_safe_relative_entry(name: &str) -> bool {
    let normalized = normalize_zip_path(name);
    if normalized.is_empty() {
        return false;
    }
    if normalized.starts_with('/') {
        return false;
    }
    // Windows drive-letter or UNC-ish prefixes.
    if normalized.contains(':') {
        return false;
    }
    !normalized
        .split('/')
        .any(|segment| segment == ".." || segment.is_empty())
}

/// One distinct audio source referenced by the session's clips, mapped to the
/// unique relative path it gets inside the package.
struct PlannedAudioSource {
    /// The clip's stored path, exactly as the waveform cache keys it (relative
    /// for copied audio, absolute for referenced) — passed verbatim to
    /// `load_or_generate_global_waveform`, which resolves it against `song_dir`.
    clip_path: String,
    /// Absolute path on disk, for reading bytes and locating the cache entry.
    source_abs: PathBuf,
    /// Collision-free relative path inside the package, e.g. `audio/Bass_1.mp3`
    /// or `audio/Bass_1-1.mp3` when a basename repeats. The clip's `file_path`
    /// is rewritten to THIS so a full package opens, portably, on any machine.
    relative_path: String,
}

/// Allocate a collision-free `audio/<name>` relative path for `file_name`,
/// suffixing `-1`, `-2`… on a name (case-insensitively) already reserved. Folds
/// case so a case-insensitive filesystem on the target doesn't alias two
/// distinct sources onto one file — see the library dedup rationale.
fn allocate_audio_relative_path(reserved_lower: &mut HashSet<String>, file_name: &str) -> String {
    let path = Path::new(file_name);
    let stem = path.file_stem().and_then(|v| v.to_str()).unwrap_or("audio");
    let extension = path.extension().and_then(|v| v.to_str());

    let mut index = 0_u32;
    loop {
        let name = match (index, extension) {
            (0, Some(ext)) => format!("{stem}.{ext}"),
            (0, None) => stem.to_string(),
            (n, Some(ext)) => format!("{stem}-{n}.{ext}"),
            (n, None) => format!("{stem}-{n}"),
        };
        let candidate = format!("audio/{name}");
        if reserved_lower.insert(candidate.to_lowercase()) {
            return candidate;
        }
        index += 1;
    }
}

/// Plan how each distinct clip audio maps to a unique relative path inside the
/// package. Distinct sources with the same basename (common in a whole-session
/// set: several songs each with their own `Bass_1.mp3`) get suffixed so they
/// stay separate rather than colliding on one zip entry / one bundled file.
fn plan_audio_sources(song_dir: &Path, song: &Song) -> Vec<PlannedAudioSource> {
    let mut seen = HashSet::new();
    let mut reserved_lower = HashSet::new();
    let mut planned = Vec::new();
    for clip in &song.clips {
        if !seen.insert(clip.file_path.clone()) {
            continue;
        }
        let source_abs = if Path::new(&clip.file_path).is_absolute() {
            PathBuf::from(&clip.file_path)
        } else {
            song_dir.join(&clip.file_path)
        };
        let Some(file_name) = source_abs.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        let relative_path = allocate_audio_relative_path(&mut reserved_lower, file_name);
        planned.push(PlannedAudioSource {
            clip_path: clip.file_path.clone(),
            source_abs,
            relative_path,
        });
    }
    planned
}

/// A comparable key for a source path: forward slashes, `\\?\`/`//?/` long-path
/// prefixes stripped, lowercased (audio libraries live on case-insensitive
/// filesystems in practice). Lets library assets match the planned clip sources
/// they came from even when the two were recorded with cosmetically different
/// spellings of the same path.
fn normalize_source_key(path: &Path) -> String {
    let mut s = path.to_string_lossy().replace('\\', "/");
    for prefix in ["//?/", "//./"] {
        if let Some(rest) = s.strip_prefix(prefix) {
            s = rest.to_string();
        }
    }
    s.to_lowercase()
}

/// Rewrite a `library.json` so each asset that was bundled under `audio/` points
/// at that bundled path instead of the exporter's original (often absolute)
/// source path. Assets NOT bundled (library files no clip uses) keep their
/// original path. Returns None on parse failure so the caller falls back to the
/// verbatim bytes.
fn rewrite_library_for_package(
    bytes: &[u8],
    song_dir: &Path,
    bundled_by_source_abs: &HashMap<String, String>,
) -> Option<Vec<u8>> {
    let mut value: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    let obj = value.as_object_mut()?;

    let remap = |file_path: &str| -> Option<String> {
        let source_abs = if Path::new(file_path).is_absolute() {
            PathBuf::from(file_path)
        } else {
            song_dir.join(file_path)
        };
        bundled_by_source_abs
            .get(&normalize_source_key(&source_abs))
            .cloned()
    };

    // New-style: `assets: [{ filePath, folderPath }]`.
    if let Some(assets) = obj.get_mut("assets").and_then(|a| a.as_array_mut()) {
        for asset in assets {
            if let Some(file_path) = asset.get("filePath").and_then(|v| v.as_str()) {
                if let Some(bundled) = remap(file_path) {
                    asset["filePath"] = serde_json::Value::String(bundled);
                }
            }
        }
    }

    // Legacy: `filePaths: ["...", ...]`.
    if let Some(file_paths) = obj.get_mut("filePaths").and_then(|a| a.as_array_mut()) {
        for entry in file_paths {
            if let Some(file_path) = entry.as_str() {
                if let Some(bundled) = remap(file_path) {
                    *entry = serde_json::Value::String(bundled);
                }
            }
        }
    }

    serde_json::to_vec_pretty(&value).ok()
}

/// Export the whole session as a `.ltset` at `output_path`.
///
/// Always bundles the session document, the named sidecar files (those that
/// exist), and the waveform peaks for every clip's audio. When `include_audio`
/// is set, the audio used by clips is bundled too so the set is portable.
///
/// `cache_root` is the global decode/waveform cache; `song_dir` is the live
/// session folder; `song` is the in-memory session to serialize (so unsaved
/// edits are captured rather than whatever is on disk).
///
/// `on_progress(done, total)` fires once per processed clip audio (the bulk of
/// the work in a full package); it runs on the calling thread and must be cheap.
/// The desktop command runs this on a worker thread so it can emit live progress
/// to the UI for large sets.
pub fn export_session_as_package(
    cache_root: &Path,
    song_dir: &Path,
    song: &Song,
    sidecars: &[SidecarFile],
    output_path: &Path,
    include_audio: bool,
    mut on_progress: impl FnMut(usize, usize),
) -> Result<SessionPackageExport, ProjectError> {
    let manifest = SessionPackageManifest {
        format_version: SESSION_PACKAGE_FORMAT_VERSION,
        session_title: song.title.clone(),
        bundled_audio: include_audio,
    };

    let file = File::create(output_path)?;
    let mut zip = ZipWriter::new(file);
    let deflated = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    // Audio and waveforms are already compressed (or not worth re-deflating);
    // store them so export stays fast on large sets.
    let stored = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);

    zip.start_file("manifest.json", deflated)
        .map_err(|error| ProjectError::AudioDecode(error.to_string()))?;
    zip.write_all(serde_json::to_vec_pretty(&manifest)?.as_slice())?;

    // Plan a unique in-package path for each distinct clip audio (resolving
    // basename collisions across songs). In a FULL package we rewrite the clips'
    // file_path to these relative paths so the set opens portably on any machine
    // — the audio is shipped under the same names. A LIGHT package keeps the
    // original (often absolute) paths and bundles no audio.
    let planned = plan_audio_sources(song_dir, song);
    let relative_by_clip_path: HashMap<String, String> = planned
        .iter()
        .map(|source| (source.clip_path.clone(), source.relative_path.clone()))
        .collect();

    // The session document — serialized from the in-memory song via the same
    // versioned writer the app uses, so a freshly exported set is byte-for-byte
    // a valid session on open. For full packages we serialize a copy whose clips
    // point at the bundled `audio/<unique>` paths.
    let session_json = if include_audio {
        let mut portable = song.clone();
        for clip in &mut portable.clips {
            if let Some(relative_path) = relative_by_clip_path.get(&clip.file_path) {
                clip.file_path = relative_path.clone();
            }
        }
        crate::song_store::serialize_song_document(&portable)?
    } else {
        crate::song_store::serialize_song_document(song)?
    };
    zip.start_file(SONG_FILE_NAME, deflated)
        .map_err(|error| ProjectError::AudioDecode(error.to_string()))?;
    zip.write_all(session_json.as_bytes())?;

    // In a full package the library.json's asset paths must be rewritten to the
    // bundled `audio/<name>` paths too — otherwise the library keeps the
    // exporter's (often absolute, Windows) source paths and every asset reads as
    // "missing" on another machine even though the audio is right there in the
    // set. Keyed by the resolved source path, so an asset used by a clip maps to
    // the same bundled file the clip now points at.
    let bundled_by_source_abs: HashMap<String, String> = planned
        .iter()
        .map(|source| {
            (
                normalize_source_key(&source.source_abs),
                source.relative_path.clone(),
            )
        })
        .collect();

    // Opaque project sidecars (library.json, automation…). Missing ones are
    // simply skipped — a session may not have automation, for instance.
    for sidecar in sidecars {
        let source = song_dir.join(&sidecar.file_name);
        let Ok(bytes) = fs::read(&source) else {
            continue;
        };
        let bytes = if include_audio && sidecar.file_name == "library.json" {
            rewrite_library_for_package(&bytes, song_dir, &bundled_by_source_abs)
                .unwrap_or(bytes)
        } else {
            bytes
        };
        zip.start_file(format!("sidecars/{}", sidecar.file_name), deflated)
            .map_err(|error| ProjectError::AudioDecode(error.to_string()))?;
        zip.write_all(&bytes)?;
    }

    let mut written_waveform_entries = HashSet::new();
    let planned_total = planned.len();
    for (index, source) in planned.iter().enumerate() {
        // Report progress per source up front so every iteration counts, even
        // the ones that `continue` past a missing file or waveform below.
        on_progress(index + 1, planned_total);
        let PlannedAudioSource {
            clip_path,
            source_abs,
            relative_path,
        } = source;

        // Each planned source has a unique relative_path, so the audio entry
        // below can't collide (the `zip` crate rejects duplicate names as
        // "Duplicate filename"). The waveform entry needs its own care — see below.

        // Full packages bundle the source audio under its unique path so the set
        // opens on another machine without the originals. Independent of the
        // waveform below — a source we can't analyse for peaks should still ship.
        if include_audio {
            if let Ok(audio_bytes) = fs::read(source_abs) {
                zip.start_file(relative_path.clone(), stored)
                    .map_err(|error| ProjectError::AudioDecode(error.to_string()))?;
                zip.write_all(&audio_bytes)?;
            }
        }

        // Bundle the waveform so the set opens instantly on the target. Name the
        // `.ltpeaks` entry exactly as the loader will look for it on import — by
        // `waveform_cache_file_stem` of the clip's FINAL path (the rewritten
        // `relative_path` in a full package, the original path in a light one).
        // That stem already disambiguates: relative paths are unique here, and
        // absolute paths get a path-hash suffix. We must NOT name it by bare
        // `file_stem` — two distinct sources sharing a stem but differing only by
        // extension (e.g. `Guide.mp3` and `Guide.wav`) would both map to
        // `Guide.waveform.ltpeaks` and collide. The guard is belt-and-braces.
        let final_path = if include_audio { relative_path } else { clip_path };
        let waveform_stem = crate::waveform::waveform_cache_file_stem(Path::new(final_path));
        let waveform_entry = format!("cache/waveforms/{waveform_stem}.waveform.ltpeaks");
        if !written_waveform_entries.insert(waveform_entry.clone()) {
            continue;
        }
        if crate::load_or_generate_global_waveform(cache_root, song_dir, Path::new(clip_path))
            .is_err()
        {
            continue;
        }
        let waveform_path = crate::global_waveform_file_path(cache_root, source_abs);
        let Ok(waveform_bytes) = fs::read(&waveform_path) else {
            continue;
        };
        zip.start_file(waveform_entry, stored)
            .map_err(|error| ProjectError::AudioDecode(error.to_string()))?;
        zip.write_all(&waveform_bytes)?;
    }

    zip.finish()
        .map_err(|error| ProjectError::AudioDecode(error.to_string()))?;
    Ok(SessionPackageExport {
        output_path: output_path.to_path_buf(),
    })
}

/// Inflate a `.ltset` into `target_song_dir` (which must not already exist as a
/// session — the caller creates a fresh project folder). Validates the manifest,
/// writes the session document, sidecars, bundled audio (full packages) and
/// waveform cache, then returns where everything landed so the caller can open
/// it as a new session.
///
/// `on_progress(done, total)` fires once per zip entry as it inflates; it runs
/// on the calling thread and must be cheap. The caller runs this WITHOUT the
/// session lock so the UI stays responsive while a large set decompresses.
pub fn extract_session_package(
    target_song_dir: &Path,
    package_path: &Path,
    mut on_progress: impl FnMut(usize, usize),
) -> Result<ExtractedSessionPackage, ProjectError> {
    let file = File::open(package_path)?;
    let mut archive =
        ZipArchive::new(file).map_err(|error| ProjectError::AudioDecode(error.to_string()))?;

    let mut manifest_json = String::new();
    archive
        .by_name("manifest.json")
        .map_err(|error| ProjectError::AudioDecode(error.to_string()))?
        .read_to_string(&mut manifest_json)?;
    let manifest: SessionPackageManifest = serde_json::from_str(&manifest_json)?;
    if manifest.format_version > SESSION_PACKAGE_FORMAT_VERSION {
        return Err(ProjectError::AudioDecode(format!(
            "este archivo .ltset usa un formato mas nuevo ({}) que esta version admite ({})",
            manifest.format_version, SESSION_PACKAGE_FORMAT_VERSION
        )));
    }

    fs::create_dir_all(target_song_dir.join("audio"))?;
    fs::create_dir_all(target_song_dir.join("cache").join("waveforms"))?;

    let entry_total = archive.len();
    let mut found_session = false;
    for index in 0..entry_total {
        let mut zip_file = archive
            .by_index(index)
            .map_err(|error| ProjectError::AudioDecode(error.to_string()))?;
        let entry_name = normalize_zip_path(zip_file.name());

        // The manifest is already consumed; skip directory entries.
        if entry_name == "manifest.json" || entry_name.ends_with('/') {
            on_progress(index + 1, entry_total);
            continue;
        }

        if !is_safe_relative_entry(&entry_name) {
            return Err(ProjectError::AudioDecode(format!(
                "entrada de paquete no segura: {entry_name}"
            )));
        }

        // Map the archive path to its destination inside the new song dir.
        let destination = if entry_name == SONG_FILE_NAME {
            found_session = true;
            target_song_dir.join(SONG_FILE_NAME)
        } else if let Some(name) = entry_name.strip_prefix("sidecars/") {
            target_song_dir.join(name)
        } else if let Some(name) = entry_name.strip_prefix("audio/") {
            target_song_dir.join("audio").join(name)
        } else if let Some(name) = entry_name.strip_prefix("cache/waveforms/") {
            target_song_dir.join("cache").join("waveforms").join(name)
        } else {
            // Unknown top-level entry from a future/foreign writer — ignore it
            // rather than scattering files into the project root.
            on_progress(index + 1, entry_total);
            continue;
        };

        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut bytes = Vec::new();
        zip_file.read_to_end(&mut bytes)?;
        fs::write(&destination, bytes)?;
        on_progress(index + 1, entry_total);
    }

    if !found_session {
        return Err(ProjectError::AudioDecode(
            "el archivo .ltset no contiene una sesion (session.ltsession)".into(),
        ));
    }

    let song_file = target_song_dir.join(SONG_FILE_NAME);
    // Validate the session document loads before we report success — a corrupt
    // set should fail here, not halfway through opening.
    let song = crate::load_song_from_file(&song_file)?;

    Ok(ExtractedSessionPackage {
        song_dir: target_song_dir.to_path_buf(),
        song_file,
        session_title: if manifest.session_title.is_empty() {
            song.title
        } else {
            manifest.session_title
        },
        bundled_audio: manifest.bundled_audio,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use libretracks_core::{Clip, Song, SongRegion, Track, TrackKind};

    fn track(id: &str, name: &str) -> Track {
        Track {
            id: id.into(),
            name: name.into(),
            kind: TrackKind::Audio,
            parent_track_id: None,
            volume: 1.0,
            pan: 0.0,
            muted: false,
            solo: false,
            transpose_enabled: true,
            audio_to: "master".into(),
            color: None,
            auto_created: false,
        }
    }

    fn clip(id: &str, track_id: &str, file_path: &str, start: f64, duration: f64) -> Clip {
        Clip {
            id: id.into(),
            track_id: track_id.into(),
            file_path: file_path.into(),
            timeline_start_seconds: start,
            source_start_seconds: 0.0,
            duration_seconds: duration,
            gain: 1.0,
            fade_in_seconds: None,
            fade_out_seconds: None,
            color: None,
        }
    }

    fn region(id: &str, name: &str, start: f64, end: f64) -> SongRegion {
        SongRegion {
            id: id.into(),
            name: name.into(),
            start_seconds: start,
            end_seconds: end,
            transpose_semitones: 0,
            warp_enabled: false,
            warp_source_bpm: None,
            key: None,
            master: libretracks_core::SongMaster::default(),
        }
    }

    /// A two-song session so we can prove every region survives the round trip.
    fn session() -> Song {
        Song {
            id: "set".into(),
            title: "Mi Set".into(),
            artist: None,
            key: None,
            bpm: 120.0,
            time_signature: "4/4".into(),
            duration_seconds: 60.0,
            tempo_markers: vec![],
            time_signature_markers: vec![],
            regions: vec![
                region("r1", "Cancion 1", 0.0, 30.0),
                region("r2", "Cancion 2", 30.0, 60.0),
            ],
            tracks: vec![track("t1", "Click")],
            clips: vec![
                clip("c1", "t1", "audio/one.wav", 0.0, 10.0),
                clip("c2", "t1", "audio/two.wav", 30.0, 10.0),
            ],
            section_markers: vec![],
        }
    }

    fn write_session_dir(dir: &Path) {
        fs::create_dir_all(dir.join("audio")).expect("audio dir");
        fs::write(dir.join("audio").join("one.wav"), b"RIFF....one").expect("one");
        fs::write(dir.join("audio").join("two.wav"), b"RIFF....two").expect("two");
        // Opaque sidecars the package must carry verbatim.
        fs::write(dir.join("library.json"), br#"{"assets":[]}"#).expect("library");
        fs::write(dir.join("automation.ltautomation"), b"AUTO").expect("automation");
    }

    fn sidecars() -> Vec<SidecarFile> {
        vec![
            SidecarFile {
                file_name: "library.json".into(),
            },
            SidecarFile {
                file_name: "automation.ltautomation".into(),
            },
        ]
    }

    #[test]
    fn full_export_round_trips_into_a_new_session_dir() {
        let src = tempfile::tempdir().expect("src");
        let song_dir = src.path();
        write_session_dir(song_dir);
        let song = session();
        let package_path = song_dir.join("set.ltset");

        export_session_as_package(
            song_dir,
            song_dir,
            &song,
            &sidecars(),
            &package_path,
            true,
            |_, _| {},
        )
        .expect("export full");
        assert!(package_path.exists());

        // Inflate into a brand-new project dir (the live import flow).
        let target = tempfile::tempdir().expect("target");
        let dest_dir = target.path().join("Mi Set");
        let extracted =
            extract_session_package(&dest_dir, &package_path, |_, _| {}).expect("extract");

        assert_eq!(extracted.session_title, "Mi Set");
        assert!(extracted.bundled_audio);
        // Session document landed and loads with BOTH regions intact.
        let loaded = crate::load_song_from_file(&extracted.song_file).expect("load session");
        assert_eq!(loaded.regions.len(), 2);
        assert_eq!(loaded.clips.len(), 2);
        // Full package bundled the clip audio AND every clip points at a bundled
        // copy that exists in the new project — the portability guarantee.
        for clip in &loaded.clips {
            assert!(
                clip.file_path.starts_with("audio/"),
                "full-package clip should reference bundled audio, got {}",
                clip.file_path
            );
            assert!(
                dest_dir.join(&clip.file_path).exists(),
                "bundled audio missing for {}",
                clip.file_path
            );
        }
        // Sidecars came across verbatim.
        assert_eq!(
            fs::read(dest_dir.join("automation.ltautomation")).expect("auto"),
            b"AUTO"
        );
        assert!(dest_dir.join("library.json").exists());
    }

    #[test]
    fn full_export_rewrites_library_paths_to_bundled_audio() {
        // The library.json ships the exporter's original (often absolute) source
        // paths. A full package must rewrite the assets that were bundled to the
        // `audio/<name>` paths, or every asset reads as "missing" on another
        // machine even though the audio is right there in the set.
        let src = tempfile::tempdir().expect("src");
        let song_dir = src.path();
        write_session_dir(song_dir);
        let mut song = session();
        // Clips reference the audio by absolute source path (as after an import
        // from an external folder), matching how the library records them.
        let abs_one = song_dir
            .join("audio")
            .join("one.wav")
            .to_string_lossy()
            .replace('\\', "/");
        let abs_two = song_dir
            .join("audio")
            .join("two.wav")
            .to_string_lossy()
            .replace('\\', "/");
        song.clips = vec![
            clip("c1", "t1", &abs_one, 0.0, 10.0),
            clip("c2", "t1", &abs_two, 30.0, 10.0),
        ];
        // Library lists the same two assets by their absolute source path, in a
        // per-song folder — exactly the shape that read as "missing" on import.
        let library = format!(
            r#"{{"assets":[{{"filePath":"{abs_one}","folderPath":"Song A"}},{{"filePath":"{abs_two}","folderPath":"Song A"}}]}}"#
        );
        fs::write(song_dir.join("library.json"), library).expect("library");

        let package_path = song_dir.join("set.ltset");
        export_session_as_package(
            song_dir,
            song_dir,
            &song,
            &sidecars(),
            &package_path,
            true,
            |_, _| {},
        )
        .expect("export full");

        let target = tempfile::tempdir().expect("target");
        let dest_dir = target.path().join("Mi Set");
        extract_session_package(&dest_dir, &package_path, |_, _| {}).expect("extract");

        // The imported library must point at bundled audio that exists, and keep
        // the per-song folder assignment.
        let library_bytes = fs::read(dest_dir.join("library.json")).expect("library");
        let library: serde_json::Value =
            serde_json::from_slice(&library_bytes).expect("library json");
        let assets = library["assets"].as_array().expect("assets");
        assert_eq!(assets.len(), 2);
        for asset in assets {
            let file_path = asset["filePath"].as_str().expect("filePath");
            assert!(
                file_path.starts_with("audio/"),
                "library asset should point at bundled audio, got {file_path}"
            );
            assert!(
                dest_dir.join(file_path).exists(),
                "bundled audio missing for library asset {file_path}"
            );
            assert_eq!(asset["folderPath"].as_str(), Some("Song A"));
        }
    }

    #[test]
    fn full_export_separates_distinct_sources_that_share_a_basename() {
        // The real-world crash: a whole-session set where two songs each
        // reference a DIFFERENT audio file that happens to share a basename
        // (e.g. each song's own `LOOP_1.mp3`). They must not collide on one zip
        // entry ("Duplicate filename") nor on one bundled file — each clip has
        // to keep its own audio.
        let src = tempfile::tempdir().expect("src");
        let song_dir = src.path();
        let one = src.path().join("song-a");
        let two = src.path().join("song-b");
        fs::create_dir_all(&one).expect("a");
        fs::create_dir_all(&two).expect("b");
        // Two DISTINCT files, same basename, different absolute folders.
        fs::write(one.join("LOOP_1.mp3"), b"AAAA-distinct-a").expect("loop a");
        fs::write(two.join("LOOP_1.mp3"), b"BBBB-distinct-b").expect("loop b");
        fs::write(song_dir.join("library.json"), b"{}").expect("library");

        let path_a = one.join("LOOP_1.mp3").to_string_lossy().replace('\\', "/");
        let path_b = two.join("LOOP_1.mp3").to_string_lossy().replace('\\', "/");
        let mut song = session();
        song.clips = vec![
            clip("c1", "t1", &path_a, 0.0, 10.0),
            clip("c2", "t1", &path_b, 30.0, 10.0),
        ];

        let package_path = song_dir.join("set.ltset");
        // Must not error with "Duplicate filename".
        export_session_as_package(
            song_dir,
            song_dir,
            &song,
            &sidecars(),
            &package_path,
            true,
            |_, _| {},
        )
        .expect("export full with colliding basenames");

        let target = tempfile::tempdir().expect("target");
        let dest_dir = target.path().join("Mi Set");
        let extracted =
            extract_session_package(&dest_dir, &package_path, |_, _| {}).expect("extract");
        let loaded = crate::load_song_from_file(&extracted.song_file).expect("load session");

        // Both clips kept distinct bundled audio paths...
        let paths: HashSet<&str> = loaded.clips.iter().map(|c| c.file_path.as_str()).collect();
        assert_eq!(paths.len(), 2, "colliding basenames collapsed onto one path");
        // ...and each resolves to the ORIGINAL bytes, not a shared copy.
        let bytes: HashSet<Vec<u8>> = loaded
            .clips
            .iter()
            .map(|c| fs::read(dest_dir.join(&c.file_path)).expect("bundled audio"))
            .collect();
        assert_eq!(bytes.len(), 2, "distinct sources collapsed to one file");
    }

    #[test]
    fn light_export_handles_sources_that_share_a_stem_across_extensions() {
        // The actual user crash, in LIGHT mode: distinct absolute sources whose
        // basenames share a STEM but differ by extension (`Guide.mp3` vs
        // `Guide.wav`), and case-only variants (`Bass.mp3` vs `BASS.mp3`). The
        // waveform entry was named by bare stem → both produced
        // `cache/waveforms/Guide.waveform.ltpeaks` → "Duplicate filename".
        let src = tempfile::tempdir().expect("src");
        let song_dir = src.path();
        let a = src.path().join("song-a");
        let b = src.path().join("song-b");
        fs::create_dir_all(&a).expect("a");
        fs::create_dir_all(&b).expect("b");
        fs::write(a.join("Guide.mp3"), b"guide-mp3").expect("g1");
        fs::write(b.join("Guide.wav"), b"guide-wav").expect("g2");
        fs::write(a.join("Bass.mp3"), b"bass-1").expect("ba");
        fs::write(b.join("BASS.mp3"), b"bass-2").expect("bb");
        fs::write(song_dir.join("library.json"), b"{}").expect("library");

        let p = |path: std::path::PathBuf| path.to_string_lossy().replace('\\', "/");
        let mut song = session();
        song.regions = vec![region("r1", "C1", 0.0, 80.0)];
        song.clips = vec![
            clip("c1", "t1", &p(a.join("Guide.mp3")), 0.0, 10.0),
            clip("c2", "t1", &p(b.join("Guide.wav")), 20.0, 10.0),
            clip("c3", "t1", &p(a.join("Bass.mp3")), 40.0, 10.0),
            clip("c4", "t1", &p(b.join("BASS.mp3")), 60.0, 10.0),
        ];

        let package_path = song_dir.join("set.ltset");
        // Must not error with "Duplicate filename" in light mode.
        export_session_as_package(
            song_dir,
            song_dir,
            &song,
            &sidecars(),
            &package_path,
            false,
            |_, _| {},
        )
        .expect("light export with stem/extension collisions");

        let target = tempfile::tempdir().expect("target");
        let dest_dir = target.path().join("Mi Set");
        let extracted =
            extract_session_package(&dest_dir, &package_path, |_, _| {}).expect("extract");
        // Light package references audio by original (absolute) path — unchanged.
        let loaded = crate::load_song_from_file(&extracted.song_file).expect("load session");
        assert_eq!(loaded.clips.len(), 4);
        assert!(loaded.clips.iter().all(|c| Path::new(&c.file_path).is_absolute()));
    }

    #[test]
    fn light_export_omits_audio_but_keeps_session_and_sidecars() {
        let src = tempfile::tempdir().expect("src");
        let song_dir = src.path();
        write_session_dir(song_dir);
        let package_path = song_dir.join("set.ltset");

        export_session_as_package(
            song_dir,
            song_dir,
            &session(),
            &sidecars(),
            &package_path,
            false,
            |_, _| {},
        )
        .expect("export light");

        let target = tempfile::tempdir().expect("target");
        let dest_dir = target.path().join("Mi Set");
        let extracted =
            extract_session_package(&dest_dir, &package_path, |_, _| {}).expect("extract");

        assert!(!extracted.bundled_audio);
        assert!(extracted.song_file.exists());
        // Light package references audio by path → no bundled bytes.
        assert!(!dest_dir.join("audio").join("one.wav").exists());
        // Sidecars still travel in a light package.
        assert!(dest_dir.join("library.json").exists());
    }

    #[test]
    fn extract_rejects_a_package_without_a_session() {
        let src = tempfile::tempdir().expect("src");
        let package_path = src.path().join("empty.ltset");
        // Hand-roll a zip with only a manifest, no session.ltsession.
        let file = File::create(&package_path).expect("create");
        let mut zip = ZipWriter::new(file);
        let options = SimpleFileOptions::default();
        zip.start_file("manifest.json", options).expect("manifest");
        let manifest = SessionPackageManifest {
            format_version: SESSION_PACKAGE_FORMAT_VERSION,
            session_title: "x".into(),
            bundled_audio: false,
        };
        zip.write_all(&serde_json::to_vec(&manifest).unwrap())
            .expect("write");
        zip.finish().expect("finish");

        let target = tempfile::tempdir().expect("target");
        let result =
            extract_session_package(&target.path().join("x"), &package_path, |_, _| {});
        assert!(result.is_err());
    }

    #[test]
    fn extract_rejects_a_newer_format_version() {
        let src = tempfile::tempdir().expect("src");
        let package_path = src.path().join("future.ltset");
        let file = File::create(&package_path).expect("create");
        let mut zip = ZipWriter::new(file);
        let options = SimpleFileOptions::default();
        zip.start_file("manifest.json", options).expect("manifest");
        let manifest = SessionPackageManifest {
            format_version: SESSION_PACKAGE_FORMAT_VERSION + 99,
            session_title: "x".into(),
            bundled_audio: false,
        };
        zip.write_all(&serde_json::to_vec(&manifest).unwrap())
            .expect("write");
        zip.finish().expect("finish");

        let target = tempfile::tempdir().expect("target");
        let result =
            extract_session_package(&target.path().join("x"), &package_path, |_, _| {});
        assert!(result.is_err());
    }

    #[test]
    fn is_safe_relative_entry_blocks_traversal_and_absolute_paths() {
        assert!(is_safe_relative_entry("audio/one.wav"));
        assert!(is_safe_relative_entry("session.ltsession"));
        assert!(!is_safe_relative_entry("../escape.wav"));
        assert!(!is_safe_relative_entry("/etc/passwd"));
        assert!(!is_safe_relative_entry("C:/Windows/system32"));
        assert!(!is_safe_relative_entry("audio/../../escape.wav"));
    }
}
