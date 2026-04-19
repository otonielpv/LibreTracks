use std::{
    path::PathBuf,
    sync::Mutex,
    time::{Instant, SystemTime, UNIX_EPOCH},
};

use libretracks_audio::{AudioEngine, AudioEngineError, PlaybackState};
use libretracks_core::Song;
use libretracks_project::{import_wav_song, ImportedSong, ProjectError, ProjectImportRequest};
use rodio::{decoder::DecoderError, PlayError, StreamError};
use rfd::FileDialog;
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::audio_runtime::AudioController;

pub struct DesktopState {
    pub audio: AudioController,
    pub session: Mutex<DesktopSession>,
}

impl Default for DesktopState {
    fn default() -> Self {
        Self {
            audio: AudioController::default(),
            session: Mutex::new(DesktopSession::default()),
        }
    }
}

#[derive(Default)]
pub struct DesktopSession {
    pub engine: AudioEngine,
    pub started_at: Option<Instant>,
    pub song_dir: Option<PathBuf>,
}

#[derive(Debug, thiserror::Error)]
pub enum DesktopError {
    #[error("transport state is unavailable")]
    StatePoisoned,
    #[error("no song is loaded")]
    NoSongLoaded,
    #[error("audio thread is unavailable")]
    AudioThreadUnavailable,
    #[error("audio command failed: {0}")]
    AudioCommand(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("project error: {0}")]
    Project(#[from] ProjectError),
    #[error("audio engine error: {0}")]
    Audio(#[from] AudioEngineError),
    #[error("audio stream error: {0}")]
    Stream(#[from] StreamError),
    #[error("audio playback error: {0}")]
    Play(#[from] PlayError),
    #[error("audio decode error: {0}")]
    Decode(#[from] DecoderError),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransportSnapshot {
    pub playback_state: String,
    pub position_seconds: f64,
    pub song: Option<SongSummary>,
    pub song_dir: Option<String>,
    pub is_native_runtime: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SongSummary {
    pub id: String,
    pub title: String,
    pub artist: Option<String>,
    pub bpm: f64,
    pub key: Option<String>,
    pub time_signature: String,
    pub duration_seconds: f64,
    pub tracks: Vec<TrackSummary>,
    pub groups: Vec<GroupSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackSummary {
    pub id: String,
    pub name: String,
    pub group_name: Option<String>,
    pub volume: f64,
    pub muted: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupSummary {
    pub id: String,
    pub name: String,
    pub volume: f64,
    pub muted: bool,
}

impl DesktopSession {
    pub fn import_song_from_dialog(
        &mut self,
        app: &AppHandle,
        audio: &AudioController,
    ) -> Result<Option<TransportSnapshot>, DesktopError> {
        let files = FileDialog::new()
            .add_filter("Wave Audio", &["wav"])
            .set_title("Selecciona las pistas WAV")
            .pick_files();

        let Some(files) = files else {
            return Ok(None);
        };

        let import_root = project_root(app);
        let request = build_import_request(&files);
        let folder_name = format!("{}-{}", slugify(&request.title), timestamp_suffix());
        let imported_song = import_wav_song(import_root.join("songs"), &folder_name, &request)?;

        self.load_imported_song(imported_song, audio)?;

        Ok(Some(self.snapshot()))
    }

    pub fn play(&mut self, audio: &AudioController) -> Result<TransportSnapshot, DesktopError> {
        self.sync_position(audio)?;
        let song = self.engine.song().ok_or(DesktopError::NoSongLoaded)?;
        if self.current_position() >= song.duration_seconds {
            self.engine.stop()?;
        }

        let song_dir = self.song_dir.clone().ok_or(DesktopError::NoSongLoaded)?;
        let active_clips = self.engine.active_clips()?;
        audio.play(song_dir, active_clips)?;
        self.engine.play()?;
        self.started_at = Some(Instant::now());

        Ok(self.snapshot())
    }

    pub fn pause(&mut self, audio: &AudioController) -> Result<TransportSnapshot, DesktopError> {
        self.sync_position(audio)?;

        audio.stop()?;

        self.engine.pause()?;
        self.started_at = None;

        Ok(self.snapshot())
    }

    pub fn stop(&mut self, audio: &AudioController) -> Result<TransportSnapshot, DesktopError> {
        audio.stop()?;

        self.engine.stop()?;
        self.started_at = None;

        Ok(self.snapshot())
    }

    pub fn seek(
        &mut self,
        position_seconds: f64,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let was_playing = self.engine.playback_state() == PlaybackState::Playing;

        audio.stop()?;

        self.engine.seek(position_seconds)?;
        self.started_at = None;

        if was_playing {
            return self.play(audio);
        }

        Ok(self.snapshot())
    }

    pub fn snapshot_with_sync(
        &mut self,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        self.sync_position(audio)?;
        Ok(self.snapshot())
    }

    fn load_imported_song(
        &mut self,
        imported_song: ImportedSong,
        audio: &AudioController,
    ) -> Result<(), DesktopError> {
        audio.stop()?;

        self.started_at = None;
        self.song_dir = Some(imported_song.song_dir);
        self.engine.load_song(imported_song.song)?;

        Ok(())
    }

    fn current_position(&self) -> f64 {
        let base = self.engine.position_seconds();
        if self.engine.playback_state() != PlaybackState::Playing {
            return base;
        }

        let elapsed = self
            .started_at
            .map(|started_at| started_at.elapsed().as_secs_f64())
            .unwrap_or(0.0);

        match self.engine.song() {
            Some(song) => (base + elapsed).min(song.duration_seconds),
            None => base,
        }
    }

    fn sync_position(&mut self, audio: &AudioController) -> Result<(), DesktopError> {
        if self.engine.playback_state() != PlaybackState::Playing {
            return Ok(());
        }

        let position = self.current_position();
        let song_duration = self
            .engine
            .song()
            .map(|song| song.duration_seconds)
            .ok_or(DesktopError::NoSongLoaded)?;

        if position >= song_duration {
            audio.stop()?;
            self.engine.stop()?;
            self.started_at = None;
            return Ok(());
        }

        self.engine.seek(position)?;
        self.started_at = Some(Instant::now());

        Ok(())
    }

    fn snapshot(&self) -> TransportSnapshot {
        TransportSnapshot {
            playback_state: playback_state_label(self.engine.playback_state()).to_string(),
            position_seconds: self.current_position(),
            song: self.engine.song().map(song_to_summary),
            song_dir: self.song_dir.as_ref().map(|value| value.display().to_string()),
            is_native_runtime: true,
        }
    }
}

fn build_import_request(files: &[PathBuf]) -> ProjectImportRequest {
    let title = infer_song_title(files);
    let song_id = format!("song_{}", timestamp_suffix());

    ProjectImportRequest {
        song_id,
        title,
        artist: None,
        bpm: 120.0,
        key: None,
        time_signature: "4/4".into(),
        wav_files: files.to_vec(),
    }
}

fn infer_song_title(files: &[PathBuf]) -> String {
    let shared_parent = files
        .first()
        .and_then(|path| path.parent())
        .and_then(|path| path.file_name())
        .and_then(|name| name.to_str())
        .map(humanize);

    shared_parent.unwrap_or_else(|| {
        files
            .first()
            .and_then(|path| path.file_stem())
            .and_then(|name| name.to_str())
            .map(humanize)
            .unwrap_or_else(|| "Imported Song".to_string())
    })
}

fn project_root(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("LibreTracks"))
}

fn timestamp_suffix() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn playback_state_label(state: PlaybackState) -> &'static str {
    match state {
        PlaybackState::Empty => "empty",
        PlaybackState::Stopped => "stopped",
        PlaybackState::Playing => "playing",
        PlaybackState::Paused => "paused",
    }
}

fn song_to_summary(song: &Song) -> SongSummary {
    SongSummary {
        id: song.id.clone(),
        title: song.title.clone(),
        artist: song.artist.clone(),
        bpm: song.bpm,
        key: song.key.clone(),
        time_signature: song.time_signature.clone(),
        duration_seconds: song.duration_seconds,
        tracks: song
            .tracks
            .iter()
            .map(|track| TrackSummary {
                id: track.id.clone(),
                name: track.name.clone(),
                group_name: track.group_id.as_ref().and_then(|group_id| {
                    song.groups
                        .iter()
                        .find(|group| &group.id == group_id)
                        .map(|group| group.name.clone())
                }),
                volume: track.volume,
                muted: track.muted,
            })
            .collect(),
        groups: song
            .groups
            .iter()
            .map(|group| GroupSummary {
                id: group.id.clone(),
                name: group.name.clone(),
                volume: group.volume,
                muted: group.muted,
            })
            .collect(),
    }
}

fn slugify(value: &str) -> String {
    let mut slug = String::new();
    let mut last_was_dash = false;

    for character in value.chars() {
        if character.is_ascii_alphanumeric() {
            slug.push(character.to_ascii_lowercase());
            last_was_dash = false;
        } else if !last_was_dash {
            slug.push('-');
            last_was_dash = true;
        }
    }

    let trimmed = slug.trim_matches('-');
    if trimmed.is_empty() {
        "song".to_string()
    } else {
        trimmed.to_string()
    }
}

fn humanize(value: &str) -> String {
    let words: Vec<String> = value
        .split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => {
                    let mut word = String::new();
                    word.push(first.to_ascii_uppercase());
                    word.push_str(&chars.as_str().to_ascii_lowercase());
                    word
                }
                None => String::new(),
            }
        })
        .collect();

    if words.is_empty() {
        "Imported Song".to_string()
    } else {
        words.join(" ")
    }
}
