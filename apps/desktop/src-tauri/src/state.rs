use std::{
    path::PathBuf,
    sync::Mutex,
    time::{Instant, SystemTime, UNIX_EPOCH},
};

use libretracks_audio::{
    AudioEngine, AudioEngineError, JumpTrigger, PlaybackState, PendingSectionJump,
};
use libretracks_core::{Clip, Section, Song};
use libretracks_project::{
    import_wav_song, load_waveform_summary, ImportedSong, ProjectError, ProjectImportRequest,
};
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
    pub current_section: Option<SectionSummary>,
    pub pending_section_jump: Option<PendingJumpSummary>,
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
    pub sections: Vec<SectionSummary>,
    pub clips: Vec<ClipSummary>,
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SectionSummary {
    pub id: String,
    pub name: String,
    pub start_seconds: f64,
    pub end_seconds: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingJumpSummary {
    pub target_section_id: String,
    pub target_section_name: String,
    pub trigger: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipSummary {
    pub id: String,
    pub track_id: String,
    pub track_name: String,
    pub file_path: String,
    pub timeline_start_seconds: f64,
    pub duration_seconds: f64,
    pub gain: f64,
    pub waveform_peaks: Vec<f32>,
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

    pub fn schedule_section_jump(
        &mut self,
        target_section_id: &str,
        trigger: JumpTrigger,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        self.sync_position(audio)?;
        let was_playing = self.engine.playback_state() == PlaybackState::Playing;

        self.engine
            .schedule_section_jump(target_section_id, trigger.clone())?;

        if was_playing && trigger == JumpTrigger::Immediate {
            self.restart_audio(audio)?;
            self.started_at = Some(Instant::now());
        }

        Ok(self.snapshot())
    }

    pub fn cancel_section_jump(
        &mut self,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        self.sync_position(audio)?;
        self.engine.cancel_section_jump();
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

        let base_position = self.engine.position_seconds();
        let elapsed = self
            .started_at
            .map(|started_at| started_at.elapsed().as_secs_f64())
            .unwrap_or(0.0);
        let linear_position = base_position + elapsed;
        let song_duration = self
            .engine
            .song()
            .map(|song| song.duration_seconds)
            .ok_or(DesktopError::NoSongLoaded)?;

        if linear_position >= song_duration {
            audio.stop()?;
            self.engine.stop()?;
            self.started_at = None;
            return Ok(());
        }

        let advanced_position = self.engine.advance_transport(elapsed)?;
        let jump_executed = (advanced_position - linear_position).abs() > 0.001;

        if jump_executed {
            self.restart_audio(audio)?;
        }

        self.started_at = Some(Instant::now());

        Ok(())
    }

    fn snapshot(&self) -> TransportSnapshot {
        TransportSnapshot {
            playback_state: playback_state_label(self.engine.playback_state()).to_string(),
            position_seconds: self.current_position(),
            song: self
                .engine
                .song()
                .map(|song| song_to_summary(song, self.song_dir.as_deref())),
            current_section: self.engine.current_section().ok().flatten().map(section_to_summary),
            pending_section_jump: self
                .engine
                .pending_section_jump()
                .map(pending_jump_to_summary),
            song_dir: self.song_dir.as_ref().map(|value| value.display().to_string()),
            is_native_runtime: true,
        }
    }

    fn restart_audio(&mut self, audio: &AudioController) -> Result<(), DesktopError> {
        let song_dir = self.song_dir.clone().ok_or(DesktopError::NoSongLoaded)?;
        let active_clips = self.engine.active_clips()?;
        audio.play(song_dir, active_clips)?;
        Ok(())
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

fn song_to_summary(song: &Song, song_dir: Option<&std::path::Path>) -> SongSummary {
    SongSummary {
        id: song.id.clone(),
        title: song.title.clone(),
        artist: song.artist.clone(),
        bpm: song.bpm,
        key: song.key.clone(),
        time_signature: song.time_signature.clone(),
        duration_seconds: song.duration_seconds,
        sections: song.sections.iter().map(section_to_summary).collect(),
        clips: song
            .clips
            .iter()
            .map(|clip| clip_to_summary(song, clip, song_dir))
            .collect(),
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

fn clip_to_summary(song: &Song, clip: &Clip, song_dir: Option<&std::path::Path>) -> ClipSummary {
    let track_name = song
        .tracks
        .iter()
        .find(|track| track.id == clip.track_id)
        .map(|track| track.name.clone())
        .unwrap_or_else(|| clip.track_id.clone());
    let waveform_peaks = song_dir
        .and_then(|dir| load_waveform_summary(dir, &clip.file_path).ok())
        .map(|summary| summary.peaks)
        .unwrap_or_default();

    ClipSummary {
        id: clip.id.clone(),
        track_id: clip.track_id.clone(),
        track_name,
        file_path: clip.file_path.clone(),
        timeline_start_seconds: clip.timeline_start_seconds,
        duration_seconds: clip.duration_seconds,
        gain: clip.gain,
        waveform_peaks,
    }
}

fn section_to_summary(section: &Section) -> SectionSummary {
    SectionSummary {
        id: section.id.clone(),
        name: section.name.clone(),
        start_seconds: section.start_seconds,
        end_seconds: section.end_seconds,
    }
}

fn pending_jump_to_summary(pending_jump: &PendingSectionJump) -> PendingJumpSummary {
    PendingJumpSummary {
        target_section_id: pending_jump.target_section_id.clone(),
        target_section_name: pending_jump.target_section_name.clone(),
        trigger: pending_jump_trigger_label(&pending_jump.trigger),
    }
}

fn pending_jump_trigger_label(trigger: &JumpTrigger) -> String {
    match trigger {
        JumpTrigger::Immediate => "immediate".to_string(),
        JumpTrigger::SectionEnd => "section_end".to_string(),
        JumpTrigger::AfterBars(bars) => format!("after_bars:{bars}"),
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
