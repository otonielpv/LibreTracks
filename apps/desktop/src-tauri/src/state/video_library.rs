//! Video files in the session library.
//!
//! Videos are **referenced where they are**, never copied into the session:
//! they are large, and the paquete export (paso 12) decides separately whether
//! to carry them. What the library stores per video is its analysis
//! ([`VideoAssetInfo`]), so listing never has to open a file.
//!
//! They live in their own `videoAssets` list of `library.json`, apart from the
//! audio lists, because the audio listing reads audio metadata from every path
//! it knows and one video there would fail the whole listing.

use std::path::Path;

use libretracks_core::VideoAssetInfo;
use serde::{Deserialize, Serialize};

use crate::infra::error::DesktopError;

use super::library::{
    library_file_identity, library_manifest_path, normalize_library_file_path,
    normalize_library_folder_path, read_library_manifest, LibraryManifest,
};
use super::{resolve_audio_file_path, DesktopSession};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VideoLibraryEntry {
    pub file_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder_path: Option<String>,
    pub info: VideoAssetInfo,
}

/// A video as the library panel shows it.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VideoAssetSummary {
    pub file_name: String,
    pub file_path: String,
    pub is_missing: bool,
    pub folder_path: Option<String>,
    pub info: VideoAssetInfo,
    /// Keyframes further apart than two seconds: jumps into this video can lag.
    pub has_slow_seeks: bool,
}

fn file_name_of(file_path: &str) -> String {
    let normalized = normalize_library_file_path(file_path);
    normalized
        .rsplit('/')
        .next()
        .unwrap_or(&normalized)
        .to_string()
}

pub(super) fn read_video_entries(song_dir: &Path) -> Result<Vec<VideoLibraryEntry>, DesktopError> {
    Ok(read_library_manifest(song_dir)?
        .map(|manifest| manifest.video_assets)
        .unwrap_or_default())
}

fn write_video_entries(
    song_dir: &Path,
    entries: Vec<VideoLibraryEntry>,
) -> Result<(), DesktopError> {
    let mut manifest: LibraryManifest = read_library_manifest(song_dir)?.unwrap_or_default();
    manifest.video_assets = entries;
    let json = serde_json::to_vec_pretty(&manifest)
        .map_err(|error| DesktopError::AudioCommand(error.to_string()))?;
    libretracks_project::write_file_atomically(&library_manifest_path(song_dir), &json)?;
    Ok(())
}

/// Add analysed videos to the library. A file already there (same file on
/// disk: separators, casing and canonical path folded, the library's usual
/// identity) is refreshed rather than duplicated. Returns the entries for
/// the given files, in order.
pub(super) fn register_video_entries(
    song_dir: &Path,
    analysed: Vec<(String, VideoAssetInfo)>,
    folder_path: Option<&str>,
) -> Result<Vec<VideoLibraryEntry>, DesktopError> {
    let mut entries = read_video_entries(song_dir)?;
    let folder_path = folder_path.and_then(normalize_library_folder_path);
    let mut registered = Vec::with_capacity(analysed.len());
    for (file_path, info) in analysed {
        let file_path = normalize_library_file_path(&file_path);
        let identity = library_file_identity(song_dir, &file_path);
        let existing = entries
            .iter_mut()
            .find(|entry| library_file_identity(song_dir, &entry.file_path) == identity);
        let entry = match existing {
            Some(entry) => {
                entry.info = info;
                entry.clone()
            }
            None => {
                let entry = VideoLibraryEntry {
                    file_path,
                    folder_path: folder_path.clone(),
                    info,
                };
                entries.push(entry.clone());
                entry
            }
        };
        registered.push(entry);
    }
    entries.sort_by(|left, right| left.file_path.cmp(&right.file_path));
    write_video_entries(song_dir, entries)?;
    Ok(registered)
}

/// Point library entries that named `old_path` at `new_path` (relink).
pub(super) fn relink_video_entries(
    song_dir: &Path,
    old_path: &str,
    new_path: &str,
) -> Result<(), DesktopError> {
    let mut entries = read_video_entries(song_dir)?;
    let old_path = normalize_library_file_path(old_path);
    let mut changed = false;
    for entry in &mut entries {
        if normalize_library_file_path(&entry.file_path) == old_path {
            entry.file_path = normalize_library_file_path(new_path);
            changed = true;
        }
    }
    if changed {
        write_video_entries(song_dir, entries)?;
    }
    Ok(())
}

pub(super) fn summarize(song_dir: &Path, entry: &VideoLibraryEntry) -> VideoAssetSummary {
    VideoAssetSummary {
        file_name: file_name_of(&entry.file_path),
        file_path: entry.file_path.clone(),
        is_missing: !resolve_audio_file_path(song_dir, &entry.file_path).is_file(),
        folder_path: entry.folder_path.clone(),
        has_slow_seeks: entry.info.has_slow_seeks(),
        info: entry.info.clone(),
    }
}

impl DesktopSession {
    pub fn list_video_assets(&self) -> Result<Vec<VideoAssetSummary>, DesktopError> {
        let Some(song_dir) = self.song_dir.as_deref() else {
            return Ok(Vec::new());
        };
        let mut assets: Vec<_> = read_video_entries(song_dir)?
            .iter()
            .map(|entry| summarize(song_dir, entry))
            .collect();
        assets.sort_by(|left, right| {
            left.folder_path
                .cmp(&right.folder_path)
                .then_with(|| left.file_name.cmp(&right.file_name))
        });
        Ok(assets)
    }

    /// Register already-analysed videos. The analysis itself happens before
    /// this, off the session lock (it opens the files with libmpv); this only
    /// writes `library.json`.
    pub fn register_video_assets(
        &mut self,
        analysed: Vec<(String, VideoAssetInfo)>,
        folder_path: Option<&str>,
    ) -> Result<Vec<VideoAssetSummary>, DesktopError> {
        let song_dir = self.song_dir.clone().ok_or(DesktopError::NoSongLoaded)?;
        let entries = register_video_entries(&song_dir, analysed, folder_path)?;
        Ok(entries
            .iter()
            .map(|entry| summarize(&song_dir, entry))
            .collect())
    }

    /// Analysis stored for a video path, if the library knows it.
    pub fn video_asset_info(&self, file_path: &str) -> Option<VideoAssetInfo> {
        let song_dir = self.song_dir.as_deref()?;
        let identity = library_file_identity(song_dir, file_path);
        read_video_entries(song_dir)
            .ok()?
            .into_iter()
            .find(|entry| library_file_identity(song_dir, &entry.file_path) == identity)
            .map(|entry| entry.info)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(duration: f64) -> VideoAssetInfo {
        VideoAssetInfo {
            duration_seconds: duration,
            width: 1920,
            height: 1080,
            fps: 30.0,
            rotation_degrees: 0,
            codec: "h264".into(),
            hardware_decode: true,
            has_audio: true,
            keyframe_interval_seconds: Some(10.0),
        }
    }

    #[test]
    fn registering_the_same_file_twice_refreshes_instead_of_duplicating() {
        let dir = tempfile::tempdir().expect("temp dir");
        let video = dir.path().join("Visuales").join("Letras.mp4");
        std::fs::create_dir_all(video.parent().unwrap()).unwrap();
        std::fs::write(&video, b"x").unwrap();
        let path = video.to_string_lossy().into_owned();

        register_video_entries(dir.path(), vec![(path.clone(), info(10.0))], None).unwrap();
        // Same file, other spelling (case + separators).
        let respelled = path.replace('\\', "/").to_uppercase();
        register_video_entries(dir.path(), vec![(respelled, info(12.0))], None).unwrap();

        let entries = read_video_entries(dir.path()).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].info.duration_seconds, 12.0);
    }

    #[test]
    fn two_files_with_the_same_name_in_different_folders_are_two_assets() {
        let dir = tempfile::tempdir().expect("temp dir");
        let a = dir.path().join("a").join("clip.mp4");
        let b = dir.path().join("b").join("clip.mp4");
        for path in [&a, &b] {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, b"x").unwrap();
        }
        register_video_entries(
            dir.path(),
            vec![
                (a.to_string_lossy().into_owned(), info(1.0)),
                (b.to_string_lossy().into_owned(), info(2.0)),
            ],
            None,
        )
        .unwrap();
        assert_eq!(read_video_entries(dir.path()).unwrap().len(), 2);
    }

    #[test]
    fn audio_library_writes_keep_the_video_list() {
        let dir = tempfile::tempdir().expect("temp dir");
        register_video_entries(
            dir.path(),
            vec![("D:/v.mp4".into(), info(3.0))],
            Some("Vídeos"),
        )
        .unwrap();
        // Any audio-side write goes through write_library_manifest_state.
        super::super::library::write_library_manifest_state(dir.path(), &[], &[]).unwrap();
        let entries = read_video_entries(dir.path()).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].folder_path.as_deref(), Some("Vídeos"));
    }

    #[test]
    fn relinking_updates_the_library_entry() {
        let dir = tempfile::tempdir().expect("temp dir");
        register_video_entries(dir.path(), vec![("D:/old/v.mp4".into(), info(3.0))], None).unwrap();
        relink_video_entries(dir.path(), "D:/old/v.mp4", "E:/new/v.mp4").unwrap();
        assert_eq!(
            read_video_entries(dir.path()).unwrap()[0].file_path,
            "E:/new/v.mp4"
        );
    }
}

impl DesktopSession {
    /// The transport clock as published outside the session lock.
    pub(crate) fn transport_clock_mirror(
        &self,
    ) -> std::sync::Arc<std::sync::Mutex<super::TransportClockMirror>> {
        self.transport_clock.mirror()
    }

    /// The visible video clips in view time, with their files resolved against
    /// the session folder, and the project revision it was built from.
    pub(crate) fn video_timeline(&self) -> (libretracks_core::video_schedule::VideoTimeline, u64) {
        let timeline = match (self.engine.song(), self.song_dir.as_deref()) {
            (Some(song), Some(song_dir)) => {
                libretracks_core::video_schedule::VideoTimeline::from_song(song, |path| {
                    resolve_audio_file_path(song_dir, path)
                        .to_string_lossy()
                        .into_owned()
                })
            }
            (Some(song), None) => {
                libretracks_core::video_schedule::VideoTimeline::from_song(song, str::to_string)
            }
            _ => Default::default(),
        };
        (timeline, self.project_revision)
    }
}

/// What a package import leaves out (paso 12): phones cannot play video, so
/// they keep the video clips in the document but never write the files.
pub(crate) fn package_extract_options() -> libretracks_project::ExtractOptions {
    libretracks_project::ExtractOptions {
        skip_video: cfg!(any(target_os = "android", target_os = "ios")),
    }
}

/// Place the videos a `.ltpkg` carried and register every video its clips use
/// (paso 12). A video whose original path still exists here (same machine) is
/// reused, like the audio; otherwise the staged copy moves into `video/`
/// under a name no other file uses, and the imported clips follow it. Videos
/// that did not travel keep their path and read as missing, to relink.
pub(super) fn place_bundled_videos_and_register(
    song_dir: &Path,
    song: &mut libretracks_core::Song,
    staged: &libretracks_project::StagedPackageAudio,
    videos: &[libretracks_project::PackageVideoEntry],
) -> Result<(), DesktopError> {
    for entry in videos {
        let original = resolve_audio_file_path(song_dir, &entry.file_path);
        let staged_video = entry
            .bundled_entry
            .as_deref()
            .and_then(|name| staged.video(name).map(|path| (name, path)));
        let final_path = match staged_video {
            Some((entry_name, staged_path)) if !original.is_file() => {
                let file_name = Path::new(entry_name)
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("video.mp4");
                let relative = free_video_path(song_dir, file_name);
                let destination = resolve_audio_file_path(song_dir, &relative);
                if let Some(parent) = destination.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                if std::fs::rename(staged_path, &destination).is_err() {
                    std::fs::copy(staged_path, &destination)?;
                }
                relative
            }
            _ => entry.file_path.clone(),
        };
        if final_path != entry.file_path {
            for clip in &mut song.video_clips {
                if clip.file_path == entry.file_path {
                    clip.file_path = final_path.clone();
                }
            }
        }
        if let Some(info) = entry.info.clone() {
            register_video_entries(
                song_dir,
                vec![(final_path, info)],
                entry.folder_path.as_deref(),
            )?;
        }
    }
    Ok(())
}

/// `video/<name>`, suffixed `-1`, `-2`… while the name is taken on disk (the
/// check folds case wherever the filesystem does).
fn free_video_path(song_dir: &Path, file_name: &str) -> String {
    let path = Path::new(file_name);
    let stem = path.file_stem().and_then(|v| v.to_str()).unwrap_or("video");
    let extension = path.extension().and_then(|v| v.to_str()).unwrap_or("mp4");
    let mut index = 0_u32;
    loop {
        let candidate = if index == 0 {
            format!("video/{stem}.{extension}")
        } else {
            format!("video/{stem}-{index}.{extension}")
        };
        if !resolve_audio_file_path(song_dir, &candidate).exists() {
            return candidate;
        }
        index += 1;
    }
}
