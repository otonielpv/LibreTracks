//! Library asset and virtual-folder management for `DesktopSession`: importing
//! audio into the per-song library, listing/moving/deleting assets, and the
//! virtual folder tree (create/rename/delete). The heavy manifest and path
//! helpers stay in `mod.rs` as `pub(super)` free functions.

use std::fs;
use std::path::{Path, PathBuf};

use libretracks_project::{global_waveform_file_path, import_wav_files_to_library};

use crate::error::DesktopError;
use crate::models::LibraryAssetSummary;

use super::{
    decoding_cache_root, import_audio_files_from_bytes_to_library,
    import_audio_files_from_paths_to_library, is_library_folder_in_branch, list_library_assets,
    list_library_folders, normalize_library_file_path, normalize_library_folder_path,
    rename_library_folder_branch, resolve_audio_file_path, write_library_manifest_assets,
    write_library_manifest_state, AudioFileImportPayload, AudioFilePathImportPayload,
    DesktopSession,
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

        if song
            .clips
            .iter()
            .any(|clip| normalize_library_file_path(&clip.file_path) == normalized_file_path)
        {
            return Err(DesktopError::AudioCommand(
                "cannot delete a library asset that is already used on the timeline".into(),
            ));
        }

        let mut library_assets = list_library_assets(&song_dir, Some(&song))?;
        library_assets.retain(|asset| asset.file_path != normalized_file_path);
        write_library_manifest_assets(&song_dir, &library_assets)?;

        let audio_file_path = resolve_audio_file_path(&song_dir, &normalized_file_path);
        let deleted_local_audio =
            !Path::new(&normalized_file_path).is_absolute() && audio_file_path.exists();
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
