use std::{
    fs,
    path::{Path, PathBuf},
};

use libretracks_core::{validate_song, DomainError, Song};
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const SONG_FILE_NAME: &str = "song.json";
const SONG_FORMAT_VERSION: u32 = 1;

#[derive(Debug, Error)]
pub enum ProjectError {
    #[error("song is invalid: {0}")]
    InvalidSong(#[from] DomainError),
    #[error("unsupported song format version: {0}")]
    UnsupportedVersion(u32),
    #[error("song folder name is empty")]
    EmptySongFolderName,
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SongDocument {
    version: u32,
    #[serde(flatten)]
    song: Song,
}

pub fn song_file_path(song_dir: impl AsRef<Path>) -> PathBuf {
    song_dir.as_ref().join(SONG_FILE_NAME)
}

pub fn create_song_folder(
    root: impl AsRef<Path>,
    folder_name: &str,
) -> Result<PathBuf, ProjectError> {
    let trimmed = folder_name.trim();
    if trimmed.is_empty() {
        return Err(ProjectError::EmptySongFolderName);
    }

    let song_dir = root.as_ref().join(trimmed);
    fs::create_dir_all(song_dir.join("audio"))?;
    fs::create_dir_all(song_dir.join("cache").join("waveforms"))?;

    Ok(song_dir)
}

pub fn save_song(song_dir: impl AsRef<Path>, song: &Song) -> Result<PathBuf, ProjectError> {
    validate_song(song)?;

    let song_dir = song_dir.as_ref();
    fs::create_dir_all(song_dir)?;

    let document = SongDocument {
        version: SONG_FORMAT_VERSION,
        song: song.clone(),
    };

    let path = song_file_path(song_dir);
    let json = serde_json::to_string_pretty(&document)?;
    fs::write(&path, json)?;

    Ok(path)
}

pub fn load_song(song_dir: impl AsRef<Path>) -> Result<Song, ProjectError> {
    let json = fs::read_to_string(song_file_path(song_dir))?;
    let document: SongDocument = serde_json::from_str(&json)?;

    if document.version != SONG_FORMAT_VERSION {
        return Err(ProjectError::UnsupportedVersion(document.version));
    }

    validate_song(&document.song)?;

    Ok(document.song)
}
