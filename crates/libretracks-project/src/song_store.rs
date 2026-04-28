use std::{
    fs,
    path::{Path, PathBuf},
};

use libretracks_core::{
    validate_song, Clip, DomainError, Marker, Song, SongRegion, TempoMetadata, Track,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

pub const SONG_FILE_NAME: &str = "song.ltsession";
const SONG_FORMAT_VERSION: u32 = 4;

#[derive(Debug, Error)]
pub enum ProjectError {
    #[error("song is invalid: {0}")]
    InvalidSong(#[from] DomainError),
    #[error("unsupported song format version: {0}")]
    UnsupportedVersion(u32),
    #[error("song folder name is empty")]
    EmptySongFolderName,
    #[error("wav import requires at least one audio file")]
    EmptyImportSet,
    #[error("unsupported audio format for file: {path}")]
    UnsupportedAudioFormat { path: PathBuf },
    #[error("invalid file name for path: {0}")]
    InvalidFileName(PathBuf),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error(
        "Este proyecto usa el formato anterior de grupos y no es compatible con la version actual"
    )]
    LegacyGroupFormatUnsupported,
    #[error("wav error: {0}")]
    Wav(#[from] hound::Error),
    #[error("audio decode error: {0}")]
    AudioDecode(String),
    #[error("waveform summary is invalid or stale: {0}")]
    InvalidWaveformSummary(PathBuf),
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SongDocument {
    version: u32,
    #[serde(flatten)]
    song: Song,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacySongDocumentV2 {
    id: String,
    title: String,
    artist: Option<String>,
    bpm: f64,
    key: Option<String>,
    time_signature: String,
    duration_seconds: f64,
    tracks: Vec<Track>,
    clips: Vec<Clip>,
    sections: Vec<LegacySectionV2>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacySongDocumentV3 {
    id: String,
    title: String,
    artist: Option<String>,
    bpm: f64,
    #[serde(default)]
    tempo_metadata: TempoMetadata,
    key: Option<String>,
    time_signature: String,
    duration_seconds: f64,
    tracks: Vec<Track>,
    clips: Vec<Clip>,
    #[serde(default)]
    section_markers: Vec<Marker>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacySectionV2 {
    id: String,
    name: String,
    start_seconds: f64,
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
    save_song_to_file(song_file_path(song_dir), song)
}

pub fn save_song_to_file(
    song_file: impl AsRef<Path>,
    song: &Song,
) -> Result<PathBuf, ProjectError> {
    validate_song(song)?;

    let song_file = song_file.as_ref();
    let song_dir = song_file.parent().ok_or_else(|| {
        ProjectError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "song file must live inside a folder",
        ))
    })?;
    fs::create_dir_all(song_dir)?;

    let document = SongDocument {
        version: SONG_FORMAT_VERSION,
        song: song.clone(),
    };

    let json = serde_json::to_string_pretty(&document)?;
    fs::write(song_file, json)?;

    Ok(song_file.to_path_buf())
}

pub fn load_song(song_dir: impl AsRef<Path>) -> Result<Song, ProjectError> {
    load_song_from_file(song_file_path(song_dir))
}

pub fn load_song_from_file(song_file: impl AsRef<Path>) -> Result<Song, ProjectError> {
    let json = fs::read_to_string(song_file)?;
    let raw_document: Value = serde_json::from_str(&json)?;
    reject_legacy_group_format(&raw_document)?;
    match document_version(&raw_document)? {
        SONG_FORMAT_VERSION => {
            let document: SongDocument = serde_json::from_str(&json)?;
            validate_song(&document.song)?;
            Ok(document.song)
        }
        3 => {
            let legacy_document: LegacySongDocumentV3 = serde_json::from_str(&json)?;
            migrate_v3_song(legacy_document)
        }
        2 => {
            let legacy_document: LegacySongDocumentV2 = serde_json::from_str(&json)?;
            migrate_v2_song(legacy_document)
        }
        version => Err(ProjectError::UnsupportedVersion(version)),
    }
}

fn document_version(document: &Value) -> Result<u32, ProjectError> {
    document
        .get("version")
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .ok_or(ProjectError::UnsupportedVersion(0))
}

fn migrate_v2_song(document: LegacySongDocumentV2) -> Result<Song, ProjectError> {
    let mut section_markers = document
        .sections
        .into_iter()
        .map(|section| Marker {
            id: section.id,
            name: section.name,
            start_seconds: section.start_seconds,
            digit: None,
        })
        .collect::<Vec<_>>();
    section_markers.sort_by(|left, right| {
        left.start_seconds
            .partial_cmp(&right.start_seconds)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let song = Song {
        id: document.id,
        title: document.title,
        artist: document.artist,
        key: document.key,
        bpm: document.bpm,
        time_signature: document.time_signature.clone(),
        duration_seconds: document.duration_seconds,
        tempo_markers: vec![],
        regions: vec![SongRegion {
            id: "region_1".into(),
            name: "Song 1".into(),
            start_seconds: 0.0,
            end_seconds: document.duration_seconds,
        }],
        tracks: document.tracks,
        clips: document.clips,
        section_markers,
    };

    validate_song(&song)?;
    Ok(song)
}

fn migrate_v3_song(document: LegacySongDocumentV3) -> Result<Song, ProjectError> {
    let region_name = document.title.clone();
    let song = Song {
        id: document.id,
        title: document.title,
        artist: document.artist,
        key: document.key,
        bpm: document.bpm,
        time_signature: document.time_signature.clone(),
        duration_seconds: document.duration_seconds,
        tempo_markers: vec![],
        regions: vec![SongRegion {
            id: "region_1".into(),
            name: region_name,
            start_seconds: 0.0,
            end_seconds: document.duration_seconds,
        }],
        tracks: document.tracks,
        clips: document.clips,
        section_markers: document.section_markers,
    };

    let _ = document.tempo_metadata;
    validate_song(&song)?;
    Ok(song)
}

fn reject_legacy_group_format(document: &Value) -> Result<(), ProjectError> {
    let Some(object) = document.as_object() else {
        return Ok(());
    };

    if object.contains_key("groups") {
        return Err(ProjectError::LegacyGroupFormatUnsupported);
    }

    let Some(tracks) = object.get("tracks").and_then(Value::as_array) else {
        return Ok(());
    };

    if tracks.iter().any(|track| {
        track
            .as_object()
            .map(|track| track.contains_key("groupId") || track.contains_key("group_id"))
            .unwrap_or(false)
    }) {
        return Err(ProjectError::LegacyGroupFormatUnsupported);
    }

    Ok(())
}
