//! Library asset and virtual-folder management: the `DesktopSession` methods for
//! importing audio, listing/moving/deleting assets and editing the virtual
//! folder tree, plus the free helpers that back them — the `library.json`
//! manifest read/write, path allocation/sanitization, and the bytes/paths/staged
//! import entry points shared with the package-import flow in `mod.rs`.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use libretracks_core::Song;
use libretracks_project::{
    global_waveform_file_path, import_wav_files_to_library, read_audio_metadata,
    audio_folder_for_seconds, PackageLibraryAssetEntry,
};

use serde::{Deserialize, Serialize};

use crate::infra::error::DesktopError;
use crate::models::LibraryAssetSummary;

use super::{
    decoding_cache_root, resolve_audio_file_path, slugify, AudioFileImportPayload,
    AudioFilePathImportPayload, DesktopSession, LIBRARY_MANIFEST_FILE_NAME,
};

impl DesktopSession {
    #[cfg_attr(not(test), allow(dead_code))]
    pub(super) fn import_audio_files_into_library(
        &mut self,
        files: &[PathBuf],
        mut on_progress: impl FnMut(u8, String),
    ) -> Result<Vec<LibraryAssetSummary>, DesktopError> {
        let song_dir = self.song_dir.clone().ok_or(DesktopError::NoSongLoaded)?;
        let imported_assets = import_wav_files_to_library(&song_dir, files, &mut on_progress)?;
        let current_song = self.engine.song().cloned();
        let mut library_assets = list_library_assets(&song_dir, current_song.as_ref())?;
        for asset in &imported_assets.assets {
            let normalized_path = normalize_library_file_path(
                asset.imported_relative_path.to_string_lossy().as_ref(),
            );
            let file_name = Path::new(&normalized_path)
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or(&normalized_path)
                .to_string();
            if let Some(existing_asset) = library_assets
                .iter_mut()
                .find(|existing_asset| existing_asset.file_path == normalized_path)
            {
                existing_asset.duration_seconds = asset.duration_seconds;
                existing_asset.file_name = file_name.clone();
            } else {
                library_assets.push(LibraryAssetSummary {
                    file_name,
                    file_path: normalized_path,
                    duration_seconds: asset.duration_seconds,
                    is_missing: false,
                    folder_path: asset.folder_path.clone(),
                });
            }
        }
        library_assets.sort_by(|left, right| {
            left.folder_path
                .cmp(&right.folder_path)
                .then_with(|| left.file_name.cmp(&right.file_name))
        });
        write_library_manifest_assets(&song_dir, &library_assets)?;
        self.record_import_metrics(&imported_assets.metrics);
        Ok(library_assets)
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn import_audio_files_from_bytes(
        &mut self,
        files: &[AudioFileImportPayload],
    ) -> Result<Vec<LibraryAssetSummary>, DesktopError> {
        let song_dir = self.song_dir.clone().ok_or(DesktopError::NoSongLoaded)?;
        import_audio_files_from_bytes_to_library(&song_dir, self.engine.song(), files)
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn import_audio_files_from_paths(
        &mut self,
        files: &[AudioFilePathImportPayload],
    ) -> Result<Vec<LibraryAssetSummary>, DesktopError> {
        let song_dir = self.song_dir.clone().ok_or(DesktopError::NoSongLoaded)?;
        import_audio_files_from_paths_to_library(&song_dir, self.engine.song(), files)
    }

    pub fn get_library_assets(&self) -> Result<Vec<LibraryAssetSummary>, DesktopError> {
        let song_dir = self.song_dir.clone().ok_or(DesktopError::NoSongLoaded)?;
        list_library_assets(&song_dir, self.engine.song())
    }

    pub fn get_library_folders(&self) -> Result<Vec<String>, DesktopError> {
        let song_dir = self.song_dir.clone().ok_or(DesktopError::NoSongLoaded)?;
        let assets = list_library_assets(&song_dir, self.engine.song())?;
        list_library_folders(&song_dir, &assets)
    }

    pub fn delete_library_asset(
        &mut self,
        file_path: &str,
    ) -> Result<Vec<LibraryAssetSummary>, DesktopError> {
        let song_dir = self.song_dir.clone().ok_or(DesktopError::NoSongLoaded)?;
        let song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        let normalized_file_path = normalize_library_file_path(file_path);
        let doomed_key = library_file_identity(&song_dir, &normalized_file_path);

        if song
            .clips
            .iter()
            .any(|clip| library_file_identity(&song_dir, &clip.file_path) == doomed_key)
        {
            return Err(DesktopError::AudioCommand(
                "cannot delete a library asset that is already used on the timeline".into(),
            ));
        }

        let mut library_assets = list_library_assets(&song_dir, Some(&song))?;
        library_assets.retain(|asset| asset.file_path != normalized_file_path);
        write_library_manifest_assets(&song_dir, &library_assets)?;

        let audio_file_path = resolve_audio_file_path(&song_dir, &normalized_file_path);
        // A session written before the allocator folded case can hold two
        // manifest entries that name the SAME file on disk. Forgetting the
        // entry is fine; unlinking the bytes another entry still points at is
        // not, so the physical delete only happens when nothing else claims it.
        let still_claimed_by_another_asset = library_assets
            .iter()
            .any(|asset| library_file_identity(&song_dir, &asset.file_path) == doomed_key);
        let deleted_local_audio = !Path::new(&normalized_file_path).is_absolute()
            && audio_file_path.exists()
            && !still_claimed_by_another_asset;
        // The global waveform entry is keyed by the audio's path+size+mtime, so
        // capture its path BEFORE removing the audio (stat must still succeed).
        let global_waveform_path =
            global_waveform_file_path(&decoding_cache_root(), &audio_file_path);
        if deleted_local_audio {
            fs::remove_file(&audio_file_path)?;
        }

        // Only reclaim the shared waveform when the underlying audio was a
        // project-local file we just deleted; for external (absolute) audio the
        // file lives on and other projects may still use its cached waveform.
        if deleted_local_audio && global_waveform_path.exists() {
            let _ = fs::remove_file(&global_waveform_path);
        }

        self.waveform_cache.remove(&song_dir, &normalized_file_path);

        list_library_assets(&song_dir, Some(&song))
    }

    /// Undo a library import whose timeline placement was then rejected.
    ///
    /// Importing runs before placement, so a drop that the region rules refuse
    /// still left its files sitting in the library — the user was told nothing
    /// was imported while the assets were in fact there. This removes those
    /// manifest entries again.
    ///
    /// Unlike [`Self::delete_library_asset`] this NEVER touches the audio on
    /// disk: undoing an import that only registered a path must not delete the
    /// user's original file. Entries that are referenced by a clip are kept —
    /// if some of the batch did land on the timeline, those assets are in
    /// legitimate use.
    pub fn forget_library_assets(
        &mut self,
        file_paths: &[String],
    ) -> Result<Vec<LibraryAssetSummary>, DesktopError> {
        let song_dir = self.song_dir.clone().ok_or(DesktopError::NoSongLoaded)?;
        let song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;

        let doomed: HashSet<String> = file_paths
            .iter()
            .map(|path| normalize_library_file_path(path))
            .collect();
        let in_use: HashSet<String> = song
            .clips
            .iter()
            .map(|clip| normalize_library_file_path(&clip.file_path))
            .collect();

        let mut library_assets = list_library_assets(&song_dir, Some(&song))?;
        library_assets
            .retain(|asset| !doomed.contains(&asset.file_path) || in_use.contains(&asset.file_path));
        write_library_manifest_assets(&song_dir, &library_assets)?;

        list_library_assets(&song_dir, Some(&song))
    }

    pub fn move_library_asset(
        &mut self,
        file_path: &str,
        new_folder_path: Option<String>,
    ) -> Result<Vec<LibraryAssetSummary>, DesktopError> {
        let song_dir = self.song_dir.clone().ok_or(DesktopError::NoSongLoaded)?;
        let song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        let normalized_file_path = normalize_library_file_path(file_path);
        let normalized_folder_path = new_folder_path
            .as_deref()
            .and_then(normalize_library_folder_path);
        let mut library_assets = list_library_assets(&song_dir, Some(&song))?;
        let target_asset = library_assets
            .iter_mut()
            .find(|asset| asset.file_path == normalized_file_path)
            .ok_or_else(|| DesktopError::AudioCommand("library asset was not found".into()))?;
        target_asset.folder_path = normalized_folder_path;

        let folders = list_library_folders(&song_dir, &library_assets)?;
        write_library_manifest_state(&song_dir, &library_assets, &folders)?;

        list_library_assets(&song_dir, Some(&song))
    }

    pub fn create_library_folder(
        &mut self,
        folder_path: &str,
    ) -> Result<Vec<String>, DesktopError> {
        let song_dir = self.song_dir.clone().ok_or(DesktopError::NoSongLoaded)?;
        let assets = list_library_assets(&song_dir, self.engine.song())?;
        let normalized_folder_path = normalize_library_folder_path(folder_path)
            .ok_or_else(|| DesktopError::AudioCommand("folder path cannot be empty".into()))?;
        let mut folders = list_library_folders(&song_dir, &assets)?;
        folders.push(normalized_folder_path);
        folders.sort();
        folders.dedup();
        write_library_manifest_state(&song_dir, &assets, &folders)?;
        Ok(folders)
    }

    pub fn rename_library_folder(
        &mut self,
        old_folder_path: &str,
        new_folder_path: &str,
    ) -> Result<Vec<LibraryAssetSummary>, DesktopError> {
        let song_dir = self.song_dir.clone().ok_or(DesktopError::NoSongLoaded)?;
        let song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        let normalized_old_folder_path = normalize_library_folder_path(old_folder_path)
            .ok_or_else(|| DesktopError::AudioCommand("folder path cannot be empty".into()))?;
        let normalized_new_folder_path = normalize_library_folder_path(new_folder_path)
            .ok_or_else(|| DesktopError::AudioCommand("folder path cannot be empty".into()))?;

        if normalized_new_folder_path == normalized_old_folder_path
            || is_library_folder_in_branch(&normalized_new_folder_path, &normalized_old_folder_path)
        {
            return Err(DesktopError::AudioCommand(
                "new folder path must not target the same folder or one of its descendants".into(),
            ));
        }

        let mut library_assets = list_library_assets(&song_dir, Some(&song))?;
        let mut folders = list_library_folders(&song_dir, &library_assets)?;
        if !folders
            .iter()
            .any(|folder_path| folder_path == &normalized_old_folder_path)
        {
            return Err(DesktopError::AudioCommand(
                "library folder was not found".into(),
            ));
        }

        for asset in &mut library_assets {
            if let Some(folder_path) = asset.folder_path.clone() {
                if is_library_folder_in_branch(&folder_path, &normalized_old_folder_path) {
                    asset.folder_path = Some(rename_library_folder_branch(
                        &folder_path,
                        &normalized_old_folder_path,
                        &normalized_new_folder_path,
                    ));
                }
            }
        }

        folders = folders
            .into_iter()
            .map(|folder_path| {
                if is_library_folder_in_branch(&folder_path, &normalized_old_folder_path) {
                    rename_library_folder_branch(
                        &folder_path,
                        &normalized_old_folder_path,
                        &normalized_new_folder_path,
                    )
                } else {
                    folder_path
                }
            })
            .collect::<Vec<_>>();
        folders.sort();
        folders.dedup();

        write_library_manifest_state(&song_dir, &library_assets, &folders)?;

        list_library_assets(&song_dir, Some(&song))
    }

    pub fn delete_library_folder(
        &mut self,
        folder_path: &str,
    ) -> Result<Vec<LibraryAssetSummary>, DesktopError> {
        let song_dir = self.song_dir.clone().ok_or(DesktopError::NoSongLoaded)?;
        let song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        let normalized_folder_path = normalize_library_folder_path(folder_path)
            .ok_or_else(|| DesktopError::AudioCommand("folder path cannot be empty".into()))?;
        let mut library_assets = list_library_assets(&song_dir, Some(&song))?;
        let folders = list_library_folders(&song_dir, &library_assets)?;
        if !folders
            .iter()
            .any(|existing_folder_path| existing_folder_path == &normalized_folder_path)
        {
            return Err(DesktopError::AudioCommand(
                "library folder was not found".into(),
            ));
        }

        for asset in &mut library_assets {
            if let Some(existing_folder_path) = asset.folder_path.as_deref() {
                if is_library_folder_in_branch(existing_folder_path, &normalized_folder_path) {
                    asset.folder_path = None;
                }
            }
        }

        let next_folders = folders
            .into_iter()
            .filter(|existing_folder_path| {
                !is_library_folder_in_branch(existing_folder_path, &normalized_folder_path)
            })
            .collect::<Vec<_>>();
        write_library_manifest_state(&song_dir, &library_assets, &next_folders)?;

        list_library_assets(&song_dir, Some(&song))
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LibraryManifest {
    #[serde(default)]
    pub(super) file_paths: Vec<String>,
    #[serde(default)]
    pub(super) assets: Vec<LibraryManifestAssetEntry>,
    #[serde(default)]
    pub(super) folders: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LibraryManifestAssetEntry {
    pub(super) file_path: String,
    #[serde(default)]
    pub(super) folder_path: Option<String>,
}

pub(super) fn library_manifest_path(song_dir: &Path) -> PathBuf {
    song_dir.join(LIBRARY_MANIFEST_FILE_NAME)
}

pub(super) fn normalize_library_file_path(file_path: &str) -> String {
    file_path.replace('\\', "/")
}

/// Key that answers "do these two library paths name the same audio file?".
///
/// Comparing the stored strings is not enough: the same file can be spelled
/// relative (`audio/bajo.wav`, how imports register it) or absolute (how a
/// desktop drag-and-drop registers the user's original), and on a
/// case-insensitive filesystem — NTFS, APFS, Android's emulated external
/// storage — it can be spelled in different casings. Deciding on the raw
/// string is what let a delete unlink audio that another song's clip was
/// still playing.
///
/// Folding case makes the comparison conservative on a case-sensitive
/// filesystem: two genuinely distinct files whose names differ only in case
/// are treated as one, so a delete is REFUSED rather than performed. Refusing
/// to delete is the safe direction; unlinking someone else's audio is not.
pub(super) fn library_file_identity(song_dir: &Path, file_path: &str) -> String {
    let normalized = normalize_library_file_path(file_path);
    let resolved = resolve_audio_file_path(song_dir, &normalized);
    let canonical = fs::canonicalize(&resolved).unwrap_or(resolved);
    let key = normalize_library_file_path(canonical.to_string_lossy().as_ref()).to_lowercase();
    // Windows canonicalize returns the `\\?\` verbatim form; a path that could
    // not be canonicalized (the file is gone) does not carry it. Drop it so the
    // two spellings still compare equal.
    key.strip_prefix("//?/").map(str::to_string).unwrap_or(key)
}

fn sanitize_import_file_name(file_name: &str) -> Result<String, DesktopError> {
    let trimmed = file_name.trim();
    if trimmed.is_empty() {
        return Err(DesktopError::AudioCommand(
            "imported file name must not be empty".into(),
        ));
    }

    let source_path = Path::new(trimmed);
    let stem = source_path
        .file_stem()
        .and_then(|value| value.to_str())
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| DesktopError::AudioCommand("imported file name is invalid".into()))?;
    let extension = source_path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| DesktopError::AudioCommand("imported file extension is invalid".into()))?;
    let sanitized_stem = slugify(stem);

    Ok(format!("{}.{}", sanitized_stem, extension))
}

/// Pick a free `audio/<name>` for a file being brought into the session.
///
/// A candidate is only free when NOTHING already claims it, and "claims" is
/// deliberately broader than a string match on `reserved_paths`:
///
/// - **Case-folded comparison.** On a case-insensitive filesystem — NTFS,
///   APFS, and Android's emulated external storage, where sessions live —
///   `audio/Bajo.wav` and `audio/bajo.wav` are the SAME file. Imports run
///   their name through [`sanitize_import_file_name`], which lowercases, so a
///   session that arrived from a `.ltset` (extraction preserves the original
///   casing) had every capitalised name shadowed by its slug: importing
///   `Bajo.wav` into a set that already had `audio/Bajo.wav` handed out
///   `audio/bajo.wav` as "free" and the write silently REPLACED the other
///   song's audio. Reported from the field on Android — a bass and a guide
///   track of untouched songs lost their audio.
/// - **What is actually on disk.** The reserved set comes from the manifest
///   plus the clips; a file that is in `audio/` but in neither (an import the
///   user later "forgot", leftovers from an interrupted extraction) would
///   otherwise be overwritten too — and the rollback path of a failed import
///   would then delete it.
fn allocate_library_audio_path(
    song_dir: &Path,
    reserved_paths: &HashSet<String>,
    folder: Option<&str>,
    file_name: &str,
) -> String {
    let source_path = Path::new(file_name);
    let stem = source_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("audio");
    let extension = source_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("wav");

    let reserved_lower = reserved_paths
        .iter()
        .map(|path| path.to_lowercase())
        .collect::<HashSet<_>>();

    let mut index = 0_u32;
    loop {
        let next_name = if index == 0 {
            format!("{stem}.{extension}")
        } else {
            format!("{stem}-{index}.{extension}")
        };
        let candidate = match folder {
            Some(folder) => format!("audio/{folder}/{next_name}"),
            None => format!("audio/{next_name}"),
        };
        if !reserved_lower.contains(&candidate.to_lowercase())
            && !resolve_audio_file_path(song_dir, &candidate).exists()
        {
            return candidate;
        }
        index += 1;
    }
}

/// Place audio files bundled in a self-contained `.ltpkg` into the destination
/// project's `audio/` folder and re-point the imported clips to those copies.
///
/// `bundled_audio` maps each original audio file name to its bytes.
///
/// For each clip whose audio is bundled we prefer to REUSE the clip's original
/// absolute path when that file still exists on this machine: copying it into
/// `audio/` would leave the same audio referenced twice (the original library
/// entry plus the new copy), which shows up as duplicated assets. Only when the
/// original is missing (e.g. the package was opened on another machine) do we
/// materialise the bundled bytes into a collision-free `audio/<name>` and
/// re-point the clip there. Clips whose audio wasn't bundled are left untouched
/// (light packages reference audio by their original path).
pub(super) fn place_bundled_audio_and_repoint(
    song_dir: &Path,
    song: &mut Song,
    bundled_audio: &HashMap<String, Vec<u8>>,
) -> Result<(), DesktopError> {
    if bundled_audio.is_empty() {
        return Ok(());
    }

    let audio_dir = song_dir.join("audio");
    fs::create_dir_all(&audio_dir)?;
    let mut reserved_paths = collect_library_file_paths(song_dir, Some(song))?
        .into_iter()
        .collect::<HashSet<_>>();

    // Materialise bundled bytes lazily: only the first clip that actually needs
    // a copy (original missing) writes the file, and the result is cached here
    // by original file name so sibling clips of the same source reuse it.
    // file name -> "audio/<final>" relative path of the written copy.
    let mut copied: HashMap<String, String> = HashMap::new();
    // Where each imported clip's audio goes: under the folder of the song it
    // lands in, so `audio/` says whose stems are whose. `song` here is the
    // MERGED session (the destination's regions plus the imported one), which
    // is why the folder comes from each clip's own position rather than from a
    // single name passed in. Audio that lands outside any region keeps the flat
    // `audio/` root, exactly as before.
    let folder_for_clip: HashMap<String, Option<String>> = song
        .clips
        .iter()
        .map(|clip| {
            (
                clip.id.clone(),
                audio_folder_for_seconds(song, clip.timeline_start_seconds),
            )
        })
        .collect();

    for clip in &mut song.clips {
        let Some(file_name) = Path::new(&clip.file_path)
            .file_name()
            .and_then(|value| value.to_str())
            .map(str::to_string)
        else {
            continue;
        };
        let Some(bytes) = bundled_audio.get(&file_name) else {
            // Audio for this clip isn't bundled (light package): leave as-is.
            continue;
        };

        // Prefer the clip's original absolute path when it still resolves on
        // disk — reuse it instead of copying, so the asset isn't duplicated.
        let original = resolve_audio_file_path(song_dir, &clip.file_path);
        if original.is_file() {
            continue;
        }

        // Original is gone: write the bundled copy (once per source) and
        // re-point the clip to it.
        let folder = folder_for_clip.get(&clip.id).cloned().flatten();
        // Keyed by folder + name: the same file name coming from two songs
        // gets one copy per song, not one shared copy.
        let copy_key = format!("{}/{file_name}", folder.as_deref().unwrap_or(""));
        let relative_path = if let Some(existing) = copied.get(&copy_key) {
            existing.clone()
        } else {
            let relative_path = allocate_library_audio_path(
                song_dir,
                &reserved_paths,
                folder.as_deref(),
                &file_name,
            );
            reserved_paths.insert(relative_path.clone());
            let destination = song_dir.join(&relative_path);
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::write(&destination, bytes)?;
            copied.insert(copy_key, relative_path.clone());
            relative_path
        };
        clip.file_path = relative_path;
    }

    Ok(())
}

pub fn import_audio_files_from_bytes_to_library(
    song_dir: &Path,
    song: Option<&Song>,
    files: &[AudioFileImportPayload],
) -> Result<Vec<LibraryAssetSummary>, DesktopError> {
    if files.is_empty() {
        return Err(DesktopError::AudioCommand(
            "at least one audio file is required".into(),
        ));
    }

    let audio_dir = song_dir.join("audio");
    fs::create_dir_all(&audio_dir)?;

    let mut written_paths = Vec::with_capacity(files.len());
    let import_result = (|| {
        let mut imported_assets = Vec::with_capacity(files.len());
        let mut reserved_paths = collect_library_file_paths(song_dir, song)?
            .into_iter()
            .collect::<HashSet<_>>();

        for file in files {
            let sanitized_file_name = sanitize_import_file_name(&file.file_name)?;
            let relative_path = allocate_library_audio_path(song_dir, &reserved_paths, None, &sanitized_file_name);
            reserved_paths.insert(relative_path.clone());

            let absolute_path = resolve_audio_file_path(song_dir, &relative_path);
            fs::write(&absolute_path, &file.bytes)?;
            written_paths.push(absolute_path.clone());

            let metadata = read_audio_metadata(&absolute_path)?;
            let file_name = Path::new(&relative_path)
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or(&relative_path)
                .to_string();

            imported_assets.push(LibraryAssetSummary {
                file_name,
                file_path: relative_path,
                duration_seconds: metadata.duration_seconds,
                is_missing: false,
                folder_path: None,
            });
        }

        let mut library_assets = list_library_assets(song_dir, song)?;
        for asset in &imported_assets {
            if let Some(existing_asset) = library_assets
                .iter_mut()
                .find(|existing_asset| existing_asset.file_path == asset.file_path)
            {
                *existing_asset = asset.clone();
            } else {
                library_assets.push(asset.clone());
            }
        }

        library_assets.sort_by(|left, right| {
            left.folder_path
                .cmp(&right.folder_path)
                .then_with(|| left.file_name.cmp(&right.file_name))
        });
        write_library_manifest_assets(song_dir, &library_assets)?;
        Ok::<Vec<LibraryAssetSummary>, DesktopError>(imported_assets)
    })();

    if import_result.is_err() {
        for path in written_paths {
            let _ = fs::remove_file(path);
        }
    }

    import_result
}

/// Android staged-import variant: like the bytes import above — the asset is
/// moved INTO the session's audio/ folder and registered by RELATIVE path —
/// but the source is a staged temp file (see `stage_imported_audio_chunk`)
/// that gets consumed (rename, or copy+delete across filesystems).
///
/// This must NOT go through `import_audio_files_from_paths_to_library`: that
/// one registers the ABSOLUTE source path (desktop assets reference the
/// user's original files), and staged temp files are ephemeral — the next
/// import batch cleans the staging area, which surfaced phantom
/// "missing file" warnings for assets that played back fine (the clip's
/// session copy existed; the library provenance path didn't).
pub fn import_staged_audio_files_to_library(
    song_dir: &Path,
    song: Option<&Song>,
    files: &[AudioFilePathImportPayload],
) -> Result<Vec<LibraryAssetSummary>, DesktopError> {
    if files.is_empty() {
        return Err(DesktopError::AudioCommand(
            "at least one audio file is required".into(),
        ));
    }

    let audio_dir = song_dir.join("audio");
    fs::create_dir_all(&audio_dir)?;

    let mut written_paths = Vec::with_capacity(files.len());
    let import_result = (|| {
        let mut imported_assets = Vec::with_capacity(files.len());
        let mut reserved_paths = collect_library_file_paths(song_dir, song)?
            .into_iter()
            .collect::<HashSet<_>>();

        for file in files {
            let source_path = PathBuf::from(file.source_path.trim());
            if !source_path.is_file() {
                return Err(DesktopError::AudioCommand(format!(
                    "staged import source not found: {}",
                    source_path.display()
                )));
            }

            let sanitized_file_name = sanitize_import_file_name(&file.file_name)?;
            let relative_path = allocate_library_audio_path(song_dir, &reserved_paths, None, &sanitized_file_name);
            reserved_paths.insert(relative_path.clone());

            let absolute_path = resolve_audio_file_path(song_dir, &relative_path);
            if fs::rename(&source_path, &absolute_path).is_err() {
                fs::copy(&source_path, &absolute_path)?;
                let _ = fs::remove_file(&source_path);
            }
            written_paths.push(absolute_path.clone());
            // Best-effort cleanup of the per-file staging folder.
            if let Some(parent) = source_path.parent() {
                let _ = fs::remove_dir(parent);
            }

            let metadata = read_audio_metadata(&absolute_path)?;
            let file_name = Path::new(&relative_path)
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or(&relative_path)
                .to_string();

            imported_assets.push(LibraryAssetSummary {
                file_name,
                file_path: relative_path,
                duration_seconds: metadata.duration_seconds,
                is_missing: false,
                folder_path: None,
            });
        }

        let mut library_assets = list_library_assets(song_dir, song)?;
        for asset in &imported_assets {
            if let Some(existing_asset) = library_assets
                .iter_mut()
                .find(|existing_asset| existing_asset.file_path == asset.file_path)
            {
                *existing_asset = asset.clone();
            } else {
                library_assets.push(asset.clone());
            }
        }

        library_assets.sort_by(|left, right| {
            left.folder_path
                .cmp(&right.folder_path)
                .then_with(|| left.file_name.cmp(&right.file_name))
        });
        write_library_manifest_assets(song_dir, &library_assets)?;
        Ok(imported_assets)
    })();

    if import_result.is_err() {
        for path in written_paths {
            let _ = fs::remove_file(path);
        }
    }
    import_result
}

pub fn import_audio_files_from_paths_to_library(
    song_dir: &Path,
    song: Option<&Song>,
    files: &[AudioFilePathImportPayload],
) -> Result<Vec<LibraryAssetSummary>, DesktopError> {
    if files.is_empty() {
        return Err(DesktopError::AudioCommand(
            "at least one audio file is required".into(),
        ));
    }

    let mut imported_assets = Vec::with_capacity(files.len());
    let mut seen_import_paths = HashSet::new();

    for file in files {
        let trimmed_source_path = file.source_path.trim();
        if trimmed_source_path.is_empty() {
            return Err(DesktopError::AudioCommand(
                "source path is required for audio import".into(),
            ));
        }

        let source_path = PathBuf::from(trimmed_source_path);
        let source_path = source_path
            .canonicalize()
            .unwrap_or_else(|_| source_path.clone());
        let metadata = read_audio_metadata(&source_path)?;
        let normalized_path = normalize_library_file_path(source_path.to_string_lossy().as_ref());

        if !seen_import_paths.insert(normalized_path.clone()) {
            continue;
        }

        let file_name = source_path
            .file_name()
            .and_then(|value| value.to_str())
            .or_else(|| {
                Path::new(&file.file_name)
                    .file_name()
                    .and_then(|value| value.to_str())
            })
            .unwrap_or(&normalized_path)
            .to_string();

        imported_assets.push(LibraryAssetSummary {
            file_name,
            file_path: normalized_path,
            duration_seconds: metadata.duration_seconds,
            is_missing: false,
            folder_path: None,
        });
    }

    let mut library_assets = list_library_assets(song_dir, song)?;
    for asset in &imported_assets {
        if let Some(existing_asset) = library_assets
            .iter_mut()
            .find(|existing_asset| existing_asset.file_path == asset.file_path)
        {
            *existing_asset = asset.clone();
        } else {
            library_assets.push(asset.clone());
        }
    }

    library_assets.sort_by(|left, right| {
        left.folder_path
            .cmp(&right.folder_path)
            .then_with(|| left.file_name.cmp(&right.file_name))
    });
    write_library_manifest_assets(song_dir, &library_assets)?;
    Ok(imported_assets)
}

pub(super) fn normalize_library_folder_path(folder_path: &str) -> Option<String> {
    let normalized = folder_path.trim().replace('\\', "/");
    let normalized = normalized.trim_matches('/');
    if normalized.is_empty() {
        return None;
    }

    Some(
        normalized
            .split('/')
            .filter(|segment| !segment.trim().is_empty())
            .collect::<Vec<_>>()
            .join("/"),
    )
}

pub(super) fn is_library_folder_in_branch(folder_path: &str, branch_root: &str) -> bool {
    folder_path == branch_root || folder_path.starts_with(&format!("{branch_root}/"))
}

pub(super) fn rename_library_folder_branch(
    folder_path: &str,
    old_folder_path: &str,
    new_folder_path: &str,
) -> String {
    if folder_path == old_folder_path {
        return new_folder_path.to_string();
    }

    let suffix = folder_path
        .strip_prefix(old_folder_path)
        .unwrap_or_default()
        .trim_start_matches('/');
    if suffix.is_empty() {
        new_folder_path.to_string()
    } else {
        format!("{new_folder_path}/{suffix}")
    }
}

pub(super) fn read_library_manifest(
    song_dir: &Path,
) -> Result<Option<LibraryManifest>, DesktopError> {
    let manifest_path = library_manifest_path(song_dir);
    if !manifest_path.exists() {
        return Ok(None);
    }

    let manifest = serde_json::from_slice::<LibraryManifest>(&fs::read(&manifest_path)?)
        .map_err(|error| DesktopError::AudioCommand(error.to_string()))?;
    Ok(Some(manifest))
}

pub(super) fn write_library_manifest(
    song_dir: &Path,
    file_paths: &[String],
) -> Result<(), DesktopError> {
    let assets = file_paths
        .iter()
        .map(|file_path| LibraryAssetSummary {
            file_name: String::new(),
            file_path: normalize_library_file_path(file_path),
            duration_seconds: 0.0,
            is_missing: !Path::new(file_path).exists(),
            folder_path: None,
        })
        .collect::<Vec<_>>();
    write_library_manifest_state(song_dir, &assets, &[])
}

pub(super) fn write_library_manifest_assets(
    song_dir: &Path,
    assets: &[LibraryAssetSummary],
) -> Result<(), DesktopError> {
    let folders = read_library_manifest(song_dir)?
        .map(|manifest| manifest.folders)
        .unwrap_or_default();
    write_library_manifest_state(song_dir, assets, &folders)
}

pub(super) fn merge_package_library_meta(
    song_dir: &Path,
    assets: &mut Vec<LibraryAssetSummary>,
    package_meta: &[PackageLibraryAssetEntry],
    fallback_folder: Option<&str>,
) -> Result<(), DesktopError> {
    let mut meta_by_path = package_meta
        .iter()
        .map(|entry| (normalize_library_file_path(&entry.file_path), entry))
        .collect::<HashMap<_, _>>();

    for asset in assets.iter_mut() {
        if let Some(entry) = meta_by_path.remove(&asset.file_path) {
            asset.folder_path = entry
                .folder_path
                .as_deref()
                .and_then(normalize_library_folder_path)
                .or_else(|| fallback_folder.and_then(normalize_library_folder_path));
        } else if asset.folder_path.is_none() {
            asset.folder_path = fallback_folder.and_then(normalize_library_folder_path);
        }
    }

    for entry in package_meta {
        let normalized_file_path = normalize_library_file_path(&entry.file_path);
        if assets
            .iter()
            .any(|asset| asset.file_path == normalized_file_path)
        {
            continue;
        }

        let path = resolve_audio_file_path(song_dir, &normalized_file_path);
        if !path.is_file() {
            continue;
        }

        let file_name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or(&normalized_file_path)
            .to_string();
        let metadata = read_audio_metadata(&path)?;
        assets.push(LibraryAssetSummary {
            file_name,
            file_path: normalized_file_path,
            duration_seconds: metadata.duration_seconds,
            is_missing: false,
            folder_path: entry
                .folder_path
                .as_deref()
                .and_then(normalize_library_folder_path)
                .or_else(|| fallback_folder.and_then(normalize_library_folder_path)),
        });
    }

    assets.sort_by(|left, right| {
        left.folder_path
            .cmp(&right.folder_path)
            .then_with(|| left.file_name.cmp(&right.file_name))
    });
    Ok(())
}

pub(super) fn write_library_manifest_state(
    song_dir: &Path,
    assets: &[LibraryAssetSummary],
    folders: &[String],
) -> Result<(), DesktopError> {
    let mut normalized_paths = assets
        .iter()
        .map(|asset| normalize_library_file_path(&asset.file_path))
        .collect::<Vec<_>>();
    normalized_paths.sort();
    normalized_paths.dedup();

    let mut normalized_assets = assets
        .iter()
        .map(|asset| LibraryManifestAssetEntry {
            file_path: normalize_library_file_path(&asset.file_path),
            folder_path: asset
                .folder_path
                .as_deref()
                .and_then(normalize_library_folder_path),
        })
        .collect::<Vec<_>>();
    normalized_assets.sort_by(|left, right| left.file_path.cmp(&right.file_path));
    normalized_assets.dedup_by(|left, right| left.file_path == right.file_path);

    let mut normalized_folders = folders
        .iter()
        .filter_map(|folder_path| normalize_library_folder_path(folder_path))
        .collect::<Vec<_>>();
    normalized_folders.extend(
        normalized_assets
            .iter()
            .filter_map(|asset| asset.folder_path.clone()),
    );
    normalized_folders.sort();
    normalized_folders.dedup();

    let manifest = LibraryManifest {
        file_paths: normalized_paths,
        assets: normalized_assets,
        folders: normalized_folders,
    };
    let manifest_json = serde_json::to_vec_pretty(&manifest)
        .map_err(|error| DesktopError::AudioCommand(error.to_string()))?;
    fs::write(library_manifest_path(song_dir), manifest_json)?;
    Ok(())
}

pub(super) fn list_library_folders(
    song_dir: &Path,
    assets: &[LibraryAssetSummary],
) -> Result<Vec<String>, DesktopError> {
    let mut folders = read_library_manifest(song_dir)?
        .map(|manifest| manifest.folders)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|folder_path| normalize_library_folder_path(&folder_path))
        .collect::<Vec<_>>();
    folders.extend(
        assets
            .iter()
            .filter_map(|asset| asset.folder_path.as_deref())
            .filter_map(normalize_library_folder_path),
    );
    folders.sort();
    folders.dedup();
    Ok(folders)
}

fn collect_scanned_library_file_paths(song_dir: &Path) -> Result<Vec<String>, DesktopError> {
    let audio_dir = song_dir.join("audio");
    if !audio_dir.exists() {
        return Ok(Vec::new());
    }

    // Recursive: packages group their audio by song (`audio/<Canción>/x.wav`),
    // so a flat listing would report an imported set as having no library at
    // all. Sessions written before that are flat and still list the same.
    let mut file_paths = Vec::new();
    scan_audio_dir_into(&audio_dir, "audio", &mut file_paths)?;
    file_paths.sort();
    Ok(file_paths)
}

fn scan_audio_dir_into(
    dir: &Path,
    relative_prefix: &str,
    file_paths: &mut Vec<String>,
) -> Result<(), DesktopError> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let entry_name = entry.file_name().to_string_lossy().to_string();

        if path.is_dir() {
            scan_audio_dir_into(&path, &format!("{relative_prefix}/{entry_name}"), file_paths)?;
            continue;
        }
        if !path.is_file() {
            continue;
        }

        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        if !extension.eq_ignore_ascii_case("wav") {
            continue;
        }

        file_paths.push(format!("{relative_prefix}/{entry_name}"));
    }
    Ok(())
}

pub(super) fn collect_library_file_paths(
    song_dir: &Path,
    song: Option<&Song>,
) -> Result<Vec<String>, DesktopError> {
    let manifest = read_library_manifest(song_dir)?;
    let mut file_paths = if let Some(manifest) = manifest {
        if !manifest.assets.is_empty() {
            manifest
                .assets
                .into_iter()
                .map(|entry| normalize_library_file_path(&entry.file_path))
                .collect::<Vec<_>>()
        } else {
            manifest.file_paths
        }
    } else {
        collect_scanned_library_file_paths(song_dir)?
    };

    if let Some(song) = song {
        for clip in &song.clips {
            file_paths.push(normalize_library_file_path(&clip.file_path));
        }
    }

    file_paths.sort();
    file_paths.dedup();
    Ok(file_paths)
}

pub(crate) fn list_library_assets(
    song_dir: &Path,
    song: Option<&Song>,
) -> Result<Vec<LibraryAssetSummary>, DesktopError> {
    let manifest_assets = read_library_manifest(song_dir)?
        .map(|manifest| {
            manifest
                .assets
                .into_iter()
                .map(|entry| (normalize_library_file_path(&entry.file_path), entry))
                .collect::<HashMap<_, _>>()
        })
        .unwrap_or_default();
    let mut assets = Vec::new();
    for file_path in collect_library_file_paths(song_dir, song)? {
        let path = resolve_audio_file_path(song_dir, &file_path);
        let file_name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or(&file_path)
            .to_string();
        let is_missing = !path.exists();
        let duration_seconds = if path.is_file() {
            read_audio_metadata(&path)?.duration_seconds
        } else {
            0.0
        };
        let manifest_entry = manifest_assets.get(&file_path);
        assets.push(LibraryAssetSummary {
            file_name: file_name.clone(),
            file_path: file_path.clone(),
            duration_seconds,
            is_missing,
            folder_path: manifest_entry
                .and_then(|entry| entry.folder_path.clone())
                .and_then(|folder_path| normalize_library_folder_path(&folder_path)),
        });
    }

    assets.sort_by(|left, right| {
        left.folder_path
            .cmp(&right.folder_path)
            .then_with(|| left.file_name.cmp(&right.file_name))
    });
    Ok(assets)
}
