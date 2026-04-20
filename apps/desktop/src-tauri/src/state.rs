use std::{
    path::PathBuf,
    sync::Mutex,
    time::{Instant, SystemTime, UNIX_EPOCH},
};

use libretracks_audio::{
    AudioEngine, AudioEngineError, JumpTrigger, PendingSectionJump, PlaybackState,
};
use libretracks_core::{Clip, OutputBus, Section, Song, TrackGroup};
use libretracks_project::{
    create_song_folder, import_wav_song, load_song, load_waveform_summary, read_wav_metadata,
    save_song, ImportedSong, ProjectError, ProjectImportRequest,
};
use rfd::FileDialog;
use rodio::{decoder::DecoderError, PlayError, StreamError};
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::audio_runtime::{AudioController, PlaybackStartReason};

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
    #[error("clip not found: {0}")]
    ClipNotFound(String),
    #[error("track not found: {0}")]
    TrackNotFound(String),
    #[error("group not found: {0}")]
    GroupNotFound(String),
    #[error("section not found: {0}")]
    SectionNotFound(String),
    #[error("section range is invalid")]
    InvalidSectionRange,
    #[error("clip range is invalid")]
    InvalidClipRange,
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
    pub source_start_seconds: f64,
    pub source_duration_seconds: f64,
    pub duration_seconds: f64,
    pub gain: f64,
    pub waveform_peaks: Vec<f32>,
    pub waveform_min_peaks: Vec<f32>,
    pub waveform_max_peaks: Vec<f32>,
}

impl DesktopSession {
    pub fn create_song(
        &mut self,
        app: &AppHandle,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let title = "Nueva Cancion".to_string();
        let song_id = format!("song_{}", timestamp_suffix());
        let folder_name = format!("{}-{}", slugify(&title), timestamp_suffix());
        let song_dir = create_song_folder(project_root(app).join("songs"), &folder_name)?;
        let song = build_empty_song(song_id, title);

        save_song(&song_dir, &song)?;
        self.load_song_from_path(song, song_dir, audio)?;

        Ok(self.snapshot())
    }

    pub fn save_project(&mut self) -> Result<TransportSnapshot, DesktopError> {
        let song_dir = self.song_dir.clone().ok_or(DesktopError::NoSongLoaded)?;
        let song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;

        save_song(song_dir, &song)?;
        Ok(self.snapshot())
    }

    pub fn open_project_from_dialog(
        &mut self,
        audio: &AudioController,
    ) -> Result<Option<TransportSnapshot>, DesktopError> {
        let song_file = FileDialog::new()
            .add_filter("LibreTracks Song", &["json"])
            .set_title("Selecciona song.json")
            .pick_file();

        let Some(song_file) = song_file else {
            return Ok(None);
        };

        let song_dir = song_file
            .parent()
            .map(std::path::Path::to_path_buf)
            .ok_or_else(|| {
                DesktopError::AudioCommand("song.json must live inside a folder".into())
            })?;
        let song = load_song(&song_dir)?;

        self.load_song_from_path(song, song_dir, audio)?;

        Ok(Some(self.snapshot()))
    }

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
        let current_position = self.current_position();
        let song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        if current_position >= song.duration_seconds {
            self.engine.stop()?;
        }

        let song_dir = self.song_dir.clone().ok_or(DesktopError::NoSongLoaded)?;
        let start_reason = if self.engine.position_seconds() > 0.0 {
            PlaybackStartReason::ResumePlay
        } else {
            PlaybackStartReason::InitialPlay
        };

        audio.play(song_dir, song, self.engine.position_seconds(), start_reason)?;
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
            return self.play_with_reason(audio, PlaybackStartReason::Seek);
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
            self.restart_audio(audio, PlaybackStartReason::ImmediateJump)?;
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

    pub fn move_clip(
        &mut self,
        clip_id: &str,
        timeline_start_seconds: f64,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        let clip = song
            .clips
            .iter_mut()
            .find(|clip| clip.id == clip_id)
            .ok_or_else(|| DesktopError::ClipNotFound(clip_id.to_string()))?;

        clip.timeline_start_seconds = timeline_start_seconds.max(0.0);
        refresh_song_duration(&mut song);

        self.persist_song_update(song, audio, AudioChangeImpact::TimelineWindow)?;

        Ok(self.snapshot())
    }

    pub fn delete_clip(
        &mut self,
        clip_id: &str,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        let clip_count = song.clips.len();
        song.clips.retain(|clip| clip.id != clip_id);

        if song.clips.len() == clip_count {
            return Err(DesktopError::ClipNotFound(clip_id.to_string()));
        }

        refresh_song_duration(&mut song);
        self.persist_song_update(song, audio, AudioChangeImpact::StructureRebuild)?;

        Ok(self.snapshot())
    }

    pub fn update_clip_window(
        &mut self,
        clip_id: &str,
        timeline_start_seconds: f64,
        source_start_seconds: f64,
        duration_seconds: f64,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        let song_dir = self.song_dir.clone().ok_or(DesktopError::NoSongLoaded)?;
        let clip = song
            .clips
            .iter_mut()
            .find(|clip| clip.id == clip_id)
            .ok_or_else(|| DesktopError::ClipNotFound(clip_id.to_string()))?;

        validate_clip_window(
            &song_dir,
            &clip.file_path,
            timeline_start_seconds,
            source_start_seconds,
            duration_seconds,
        )?;

        clip.timeline_start_seconds = timeline_start_seconds.max(0.0);
        clip.source_start_seconds = source_start_seconds.max(0.0);
        clip.duration_seconds = duration_seconds;
        refresh_song_duration(&mut song);

        self.persist_song_update(song, audio, AudioChangeImpact::TimelineWindow)?;

        Ok(self.snapshot())
    }

    pub fn duplicate_clip(
        &mut self,
        clip_id: &str,
        timeline_start_seconds: f64,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        let source_clip = song
            .clips
            .iter()
            .find(|clip| clip.id == clip_id)
            .cloned()
            .ok_or_else(|| DesktopError::ClipNotFound(clip_id.to_string()))?;

        let mut duplicated_clip = source_clip;
        duplicated_clip.id = format!("clip_{}", timestamp_suffix());
        duplicated_clip.timeline_start_seconds = timeline_start_seconds.max(0.0);
        song.clips.push(duplicated_clip);
        refresh_song_duration(&mut song);

        self.persist_song_update(song, audio, AudioChangeImpact::StructureRebuild)?;

        Ok(self.snapshot())
    }

    pub fn create_section(
        &mut self,
        start_seconds: f64,
        end_seconds: f64,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        let start_seconds = start_seconds.min(end_seconds).max(0.0);
        let end_seconds = end_seconds.max(start_seconds).min(song.duration_seconds);

        if end_seconds - start_seconds < 0.05 {
            return Err(DesktopError::InvalidSectionRange);
        }

        let section_number = song.sections.len() + 1;
        song.sections.push(Section {
            id: format!("section_{}", timestamp_suffix()),
            name: format!("Seccion {section_number}"),
            start_seconds,
            end_seconds,
        });
        song.sections.sort_by(|left, right| {
            left.start_seconds
                .partial_cmp(&right.start_seconds)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        self.persist_song_update(song, audio, AudioChangeImpact::TransportOnly)?;

        Ok(self.snapshot())
    }

    pub fn update_section(
        &mut self,
        section_id: &str,
        name: &str,
        start_seconds: f64,
        end_seconds: f64,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        let trimmed_name = name.trim();
        if trimmed_name.is_empty() {
            return Err(DesktopError::AudioCommand(
                "section name must not be empty".into(),
            ));
        }

        let start_seconds = start_seconds.min(end_seconds).max(0.0);
        let end_seconds = end_seconds.max(start_seconds).min(song.duration_seconds);

        if end_seconds - start_seconds < 0.05 {
            return Err(DesktopError::InvalidSectionRange);
        }

        let section = song
            .sections
            .iter_mut()
            .find(|section| section.id == section_id)
            .ok_or_else(|| DesktopError::SectionNotFound(section_id.to_string()))?;

        section.name = trimmed_name.to_string();
        section.start_seconds = start_seconds;
        section.end_seconds = end_seconds;
        song.sections.sort_by(|left, right| {
            left.start_seconds
                .partial_cmp(&right.start_seconds)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        self.persist_song_update(song, audio, AudioChangeImpact::TransportOnly)?;

        Ok(self.snapshot())
    }

    pub fn delete_section(
        &mut self,
        section_id: &str,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        let section_count = song.sections.len();
        song.sections.retain(|section| section.id != section_id);

        if song.sections.len() == section_count {
            return Err(DesktopError::SectionNotFound(section_id.to_string()));
        }

        self.persist_song_update(song, audio, AudioChangeImpact::TransportOnly)?;

        Ok(self.snapshot())
    }

    pub fn create_group(
        &mut self,
        name: &str,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        let trimmed_name = name.trim();
        if trimmed_name.is_empty() {
            return Err(DesktopError::AudioCommand(
                "group name must not be empty".into(),
            ));
        }

        song.groups.push(TrackGroup {
            id: format!("group_{}", timestamp_suffix()),
            name: trimmed_name.to_string(),
            volume: 1.0,
            muted: false,
            output_bus_id: OutputBus::Main.id(),
        });

        self.persist_song_update(song, audio, AudioChangeImpact::MixOnly)?;

        Ok(self.snapshot())
    }

    pub fn assign_track_to_group(
        &mut self,
        track_id: &str,
        group_id: Option<&str>,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;

        if let Some(group_id) = group_id {
            if !song.groups.iter().any(|group| group.id == group_id) {
                return Err(DesktopError::GroupNotFound(group_id.to_string()));
            }
        }

        let track = song
            .tracks
            .iter_mut()
            .find(|track| track.id == track_id)
            .ok_or_else(|| DesktopError::TrackNotFound(track_id.to_string()))?;

        track.group_id = group_id.map(std::string::ToString::to_string);

        self.persist_song_update(song, audio, AudioChangeImpact::MixOnly)?;

        Ok(self.snapshot())
    }

    pub fn set_track_volume(
        &mut self,
        track_id: &str,
        volume: f64,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        let track = song
            .tracks
            .iter_mut()
            .find(|track| track.id == track_id)
            .ok_or_else(|| DesktopError::TrackNotFound(track_id.to_string()))?;

        track.volume = volume.clamp(0.0, 1.0);

        self.persist_song_update(song, audio, AudioChangeImpact::MixOnly)?;

        Ok(self.snapshot())
    }

    pub fn toggle_track_mute(
        &mut self,
        track_id: &str,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        let track = song
            .tracks
            .iter_mut()
            .find(|track| track.id == track_id)
            .ok_or_else(|| DesktopError::TrackNotFound(track_id.to_string()))?;

        track.muted = !track.muted;

        self.persist_song_update(song, audio, AudioChangeImpact::MixOnly)?;

        Ok(self.snapshot())
    }

    pub fn set_group_volume(
        &mut self,
        group_id: &str,
        volume: f64,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        let group = song
            .groups
            .iter_mut()
            .find(|group| group.id == group_id)
            .ok_or_else(|| DesktopError::GroupNotFound(group_id.to_string()))?;

        group.volume = volume.clamp(0.0, 1.0);

        self.persist_song_update(song, audio, AudioChangeImpact::MixOnly)?;

        Ok(self.snapshot())
    }

    pub fn toggle_group_mute(
        &mut self,
        group_id: &str,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        let group = song
            .groups
            .iter_mut()
            .find(|group| group.id == group_id)
            .ok_or_else(|| DesktopError::GroupNotFound(group_id.to_string()))?;

        group.muted = !group.muted;

        self.persist_song_update(song, audio, AudioChangeImpact::MixOnly)?;

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
        self.load_song_from_path(imported_song.song, imported_song.song_dir, audio)
    }

    fn load_song_from_path(
        &mut self,
        song: Song,
        song_dir: PathBuf,
        audio: &AudioController,
    ) -> Result<(), DesktopError> {
        audio.stop()?;

        self.started_at = None;
        self.song_dir = Some(song_dir);
        self.engine.load_song(song)?;

        Ok(())
    }

    fn play_with_reason(
        &mut self,
        audio: &AudioController,
        reason: PlaybackStartReason,
    ) -> Result<TransportSnapshot, DesktopError> {
        self.sync_position(audio)?;
        let current_position = self.current_position();
        let song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        if current_position >= song.duration_seconds {
            self.engine.stop()?;
        }

        let song_dir = self.song_dir.clone().ok_or(DesktopError::NoSongLoaded)?;
        audio.play(song_dir, song, self.engine.position_seconds(), reason)?;
        self.engine.play()?;
        self.started_at = Some(Instant::now());

        Ok(self.snapshot())
    }

    fn persist_song_update(
        &mut self,
        song: Song,
        audio: &AudioController,
        impact: AudioChangeImpact,
    ) -> Result<(), DesktopError> {
        self.sync_position(audio)?;

        let playback_state = self.engine.playback_state();
        let position_seconds = self.current_position();
        let pending_jump = self.engine.pending_section_jump().cloned();
        let song_dir = self.song_dir.clone().ok_or(DesktopError::NoSongLoaded)?;

        save_song(&song_dir, &song)?;
        self.engine.load_song(song)?;

        let restored_position = position_seconds.min(
            self.engine
                .song()
                .map(|loaded_song| loaded_song.duration_seconds)
                .ok_or(DesktopError::NoSongLoaded)?,
        );
        self.engine.seek(restored_position)?;

        let loaded_song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;

        if let Some(pending_jump) = pending_jump {
            let target_section_exists = loaded_song
                .sections
                .iter()
                .any(|section| section.id == pending_jump.target_section_id);

            if target_section_exists {
                self.engine
                    .schedule_section_jump(&pending_jump.target_section_id, pending_jump.trigger)?;
            }
        }

        match playback_state {
            PlaybackState::Playing => {
                self.engine.play()?;
                match impact {
                    AudioChangeImpact::MixOnly => audio.sync_song(loaded_song)?,
                    AudioChangeImpact::TransportOnly => {}
                    AudioChangeImpact::TimelineWindow => {
                        self.restart_audio(audio, PlaybackStartReason::TimelineWindow)?
                    }
                    AudioChangeImpact::StructureRebuild => {
                        self.restart_audio(audio, PlaybackStartReason::StructureRebuild)?
                    }
                }
                self.started_at = Some(Instant::now());
            }
            PlaybackState::Paused => {
                self.engine.pause()?;
                self.started_at = None;
            }
            PlaybackState::Stopped | PlaybackState::Empty => {
                self.started_at = None;
            }
        }

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
            self.restart_audio(audio, PlaybackStartReason::TransportResync)?;
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
            current_section: self
                .engine
                .current_section()
                .ok()
                .flatten()
                .map(section_to_summary),
            pending_section_jump: self
                .engine
                .pending_section_jump()
                .map(pending_jump_to_summary),
            song_dir: self
                .song_dir
                .as_ref()
                .map(|value| value.display().to_string()),
            is_native_runtime: true,
        }
    }

    fn restart_audio(
        &mut self,
        audio: &AudioController,
        reason: PlaybackStartReason,
    ) -> Result<(), DesktopError> {
        let song_dir = self.song_dir.clone().ok_or(DesktopError::NoSongLoaded)?;
        let song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        audio.play(song_dir, song, self.engine.position_seconds(), reason)?;
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AudioChangeImpact {
    MixOnly,
    TransportOnly,
    TimelineWindow,
    StructureRebuild,
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

fn build_empty_song(song_id: String, title: String) -> Song {
    Song {
        id: song_id,
        title,
        artist: None,
        bpm: 120.0,
        key: None,
        time_signature: "4/4".into(),
        duration_seconds: 60.0,
        tracks: vec![],
        groups: vec![],
        clips: vec![],
        sections: vec![],
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
    let (waveform_peaks, waveform_min_peaks, waveform_max_peaks, source_duration_seconds) = song_dir
        .and_then(|dir| load_waveform_summary(dir, &clip.file_path).ok())
        .map(|summary| {
            let source_duration_seconds = if summary.duration_seconds > 0.0 {
                summary.duration_seconds
            } else {
                clip.source_start_seconds + clip.duration_seconds
            };
            let waveform_peaks = summary.peaks.clone();
            let waveform_min_peaks = if summary.min_peaks.len() == summary.bucket_count {
                summary.min_peaks.clone()
            } else {
                waveform_peaks.iter().map(|peak| -*peak).collect()
            };
            let waveform_max_peaks = if summary.max_peaks.len() == summary.bucket_count {
                summary.max_peaks.clone()
            } else {
                waveform_peaks.clone()
            };

            (
                waveform_peaks,
                waveform_min_peaks,
                waveform_max_peaks,
                source_duration_seconds,
            )
        })
        .unwrap_or_else(|| {
            (
                Vec::new(),
                Vec::new(),
                Vec::new(),
                clip.source_start_seconds + clip.duration_seconds,
            )
        });

    ClipSummary {
        id: clip.id.clone(),
        track_id: clip.track_id.clone(),
        track_name,
        file_path: clip.file_path.clone(),
        timeline_start_seconds: clip.timeline_start_seconds,
        source_start_seconds: clip.source_start_seconds,
        source_duration_seconds,
        duration_seconds: clip.duration_seconds,
        gain: clip.gain,
        waveform_peaks,
        waveform_min_peaks,
        waveform_max_peaks,
    }
}

fn validate_clip_window(
    song_dir: &std::path::Path,
    clip_file_path: &str,
    timeline_start_seconds: f64,
    source_start_seconds: f64,
    duration_seconds: f64,
) -> Result<(), DesktopError> {
    if timeline_start_seconds < 0.0 || source_start_seconds < 0.0 || duration_seconds < 0.05 {
        return Err(DesktopError::InvalidClipRange);
    }

    let wav_metadata = read_wav_metadata(song_dir.join(clip_file_path))?;
    if source_start_seconds + duration_seconds > wav_metadata.duration_seconds + 0.0001 {
        return Err(DesktopError::InvalidClipRange);
    }

    Ok(())
}

fn refresh_song_duration(song: &mut Song) {
    let max_clip_end = song
        .clips
        .iter()
        .map(|clip| clip.timeline_start_seconds + clip.duration_seconds)
        .fold(0.0_f64, f64::max);
    let max_section_end = song
        .sections
        .iter()
        .map(|section| section.end_seconds)
        .fold(0.0_f64, f64::max);

    song.duration_seconds = max_clip_end.max(max_section_end).max(1.0);
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

#[cfg(test)]
mod tests {
    use std::fs;

    use libretracks_audio::{JumpTrigger, PlaybackState};
    use libretracks_core::{Clip, OutputBus, Section, Song, Track, TrackGroup};
    use libretracks_project::{create_song_folder, load_song};
    use tempfile::tempdir;

    use super::DesktopSession;

    fn demo_song() -> Song {
        Song {
            id: "song_move".into(),
            title: "Move Demo".into(),
            artist: None,
            bpm: 120.0,
            key: None,
            time_signature: "4/4".into(),
            duration_seconds: 12.0,
            tracks: vec![Track {
                id: "track_1".into(),
                name: "Track 1".into(),
                group_id: Some("group_main".into()),
                volume: 1.0,
                pan: 0.0,
                muted: false,
                solo: false,
                output_bus_id: OutputBus::Main.id(),
            }],
            groups: vec![TrackGroup {
                id: "group_main".into(),
                name: "Main".into(),
                volume: 1.0,
                muted: false,
                output_bus_id: OutputBus::Main.id(),
            }],
            clips: vec![Clip {
                id: "clip_1".into(),
                track_id: "track_1".into(),
                file_path: "audio/test.wav".into(),
                timeline_start_seconds: 1.0,
                source_start_seconds: 0.0,
                duration_seconds: 4.0,
                gain: 1.0,
                fade_in_seconds: None,
                fade_out_seconds: None,
            }],
            sections: vec![],
        }
    }

    fn demo_song_with_section() -> Song {
        let mut song = demo_song();
        song.sections.push(Section {
            id: "section_1".into(),
            name: "Intro".into(),
            start_seconds: 1.0,
            end_seconds: 4.0,
        });
        song
    }

    #[test]
    fn moving_a_clip_updates_song_json_and_snapshot() {
        let root = tempdir().expect("temp dir should exist");
        let song_dir = create_song_folder(root.path(), "move-demo").expect("song dir should exist");
        fs::create_dir_all(song_dir.join("audio")).expect("audio dir should exist");

        let mut session = DesktopSession::default();
        session.song_dir = Some(song_dir.clone());
        session
            .engine
            .load_song(demo_song())
            .expect("song should load into engine");

        let audio = crate::audio_runtime::AudioController::default();
        let snapshot = session
            .move_clip("clip_1", 6.5, &audio)
            .expect("clip should move");

        assert_eq!(snapshot.playback_state, "stopped");
        assert_eq!(
            snapshot
                .song
                .expect("song summary should exist")
                .clips
                .first()
                .expect("clip summary should exist")
                .timeline_start_seconds,
            6.5
        );

        let saved_song = load_song(&song_dir).expect("song json should load");
        assert_eq!(saved_song.clips[0].timeline_start_seconds, 6.5);
        assert_eq!(session.engine.playback_state(), PlaybackState::Stopped);
    }

    #[test]
    fn creating_a_section_updates_song_json_and_snapshot() {
        let root = tempdir().expect("temp dir should exist");
        let song_dir =
            create_song_folder(root.path(), "section-demo").expect("song dir should exist");
        fs::create_dir_all(song_dir.join("audio")).expect("audio dir should exist");

        let mut session = DesktopSession::default();
        session.song_dir = Some(song_dir.clone());
        session
            .engine
            .load_song(demo_song())
            .expect("song should load into engine");

        let audio = crate::audio_runtime::AudioController::default();
        let snapshot = session
            .create_section(2.0, 5.5, &audio)
            .expect("section should be created");

        assert_eq!(
            snapshot
                .song
                .expect("song summary should exist")
                .sections
                .len(),
            1
        );

        let saved_song = load_song(&song_dir).expect("song json should load");
        assert_eq!(saved_song.sections.len(), 1);
        assert_eq!(saved_song.sections[0].start_seconds, 2.0);
        assert_eq!(saved_song.sections[0].end_seconds, 5.5);
    }

    #[test]
    fn deleting_a_clip_updates_song_json_and_snapshot() {
        let root = tempdir().expect("temp dir should exist");
        let song_dir =
            create_song_folder(root.path(), "clip-delete-demo").expect("song dir should exist");
        fs::create_dir_all(song_dir.join("audio")).expect("audio dir should exist");

        let mut session = DesktopSession::default();
        session.song_dir = Some(song_dir.clone());
        session
            .engine
            .load_song(demo_song())
            .expect("song should load into engine");

        let audio = crate::audio_runtime::AudioController::default();
        let snapshot = session
            .delete_clip("clip_1", &audio)
            .expect("clip should delete");

        assert!(snapshot
            .song
            .expect("song summary should exist")
            .clips
            .is_empty());

        let saved_song = load_song(&song_dir).expect("song json should load");
        assert!(saved_song.clips.is_empty());
        assert_eq!(session.engine.playback_state(), PlaybackState::Stopped);
    }

    #[test]
    fn updating_a_clip_window_updates_song_json_and_snapshot() {
        let root = tempdir().expect("temp dir should exist");
        let song_dir =
            create_song_folder(root.path(), "clip-window-demo").expect("song dir should exist");
        fs::create_dir_all(song_dir.join("audio")).expect("audio dir should exist");

        let wav_path = song_dir.join("audio").join("test.wav");
        let spec = hound::WavSpec {
            channels: 2,
            sample_rate: 44_100,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(&wav_path, spec).expect("wav should be created");
        for _ in 0..(44_100 * 8) {
            writer.write_sample(0_i16).expect("sample should write");
            writer.write_sample(0_i16).expect("sample should write");
        }
        writer.finalize().expect("wav should finalize");

        let mut session = DesktopSession::default();
        session.song_dir = Some(song_dir.clone());
        session
            .engine
            .load_song(demo_song())
            .expect("song should load into engine");

        let audio = crate::audio_runtime::AudioController::default();
        let snapshot = session
            .update_clip_window("clip_1", 2.0, 1.5, 2.25, &audio)
            .expect("clip window should update");

        let updated_clip = snapshot
            .song
            .expect("song summary should exist")
            .clips
            .into_iter()
            .find(|clip| clip.id == "clip_1")
            .expect("updated clip should exist");
        assert_eq!(updated_clip.timeline_start_seconds, 2.0);
        assert_eq!(updated_clip.source_start_seconds, 1.5);
        assert_eq!(updated_clip.duration_seconds, 2.25);

        let saved_song = load_song(&song_dir).expect("song json should load");
        assert_eq!(saved_song.clips[0].timeline_start_seconds, 2.0);
        assert_eq!(saved_song.clips[0].source_start_seconds, 1.5);
        assert_eq!(saved_song.clips[0].duration_seconds, 2.25);
    }

    #[test]
    fn duplicating_a_clip_updates_song_json_and_snapshot() {
        let root = tempdir().expect("temp dir should exist");
        let song_dir =
            create_song_folder(root.path(), "clip-duplicate-demo").expect("song dir should exist");
        fs::create_dir_all(song_dir.join("audio")).expect("audio dir should exist");

        let mut session = DesktopSession::default();
        session.song_dir = Some(song_dir.clone());
        session
            .engine
            .load_song(demo_song())
            .expect("song should load into engine");

        let audio = crate::audio_runtime::AudioController::default();
        let snapshot = session
            .duplicate_clip("clip_1", 6.0, &audio)
            .expect("clip should duplicate");

        let snapshot_song = snapshot.song.expect("song summary should exist");
        assert_eq!(snapshot_song.clips.len(), 2);
        assert!(snapshot_song
            .clips
            .iter()
            .any(|clip| clip.id != "clip_1" && clip.timeline_start_seconds == 6.0));

        let saved_song = load_song(&song_dir).expect("song json should load");
        assert_eq!(saved_song.clips.len(), 2);
        assert!(saved_song
            .clips
            .iter()
            .any(|clip| clip.id != "clip_1" && clip.timeline_start_seconds == 6.0));
    }

    #[test]
    fn scheduling_and_cancelling_a_section_jump_updates_snapshot() {
        let mut session = DesktopSession::default();
        session
            .engine
            .load_song(demo_song_with_section())
            .expect("song should load into engine");

        let audio = crate::audio_runtime::AudioController::default();
        let scheduled_snapshot = session
            .schedule_section_jump("section_1", JumpTrigger::AfterBars(6), &audio)
            .expect("jump should schedule");

        let pending_jump = scheduled_snapshot
            .pending_section_jump
            .expect("pending jump should exist");
        assert_eq!(pending_jump.target_section_id, "section_1");
        assert_eq!(pending_jump.target_section_name, "Intro");
        assert_eq!(pending_jump.trigger, "after_bars:6");

        let cancelled_snapshot = session
            .cancel_section_jump(&audio)
            .expect("jump should cancel");
        assert!(cancelled_snapshot.pending_section_jump.is_none());
    }

    #[test]
    fn scheduling_an_immediate_section_jump_updates_position_and_current_section() {
        let mut session = DesktopSession::default();
        session
            .engine
            .load_song(demo_song_with_section())
            .expect("song should load into engine");
        session.engine.seek(0.0).expect("seek should work");

        let audio = crate::audio_runtime::AudioController::default();
        let snapshot = session
            .schedule_section_jump("section_1", JumpTrigger::Immediate, &audio)
            .expect("immediate jump should execute");

        assert!(snapshot.pending_section_jump.is_none());
        assert_eq!(snapshot.position_seconds, 1.0);
        assert_eq!(
            snapshot
                .current_section
                .expect("current section should exist")
                .name,
            "Intro"
        );
    }

    #[test]
    fn updating_a_section_updates_song_json_and_snapshot() {
        let root = tempdir().expect("temp dir should exist");
        let song_dir =
            create_song_folder(root.path(), "section-update-demo").expect("song dir should exist");
        fs::create_dir_all(song_dir.join("audio")).expect("audio dir should exist");

        let mut session = DesktopSession::default();
        session.song_dir = Some(song_dir.clone());
        session
            .engine
            .load_song(demo_song_with_section())
            .expect("song should load into engine");

        let audio = crate::audio_runtime::AudioController::default();
        let snapshot = session
            .update_section("section_1", "Verse", 2.5, 7.0, &audio)
            .expect("section should update");

        let updated_section = snapshot
            .song
            .expect("song summary should exist")
            .sections
            .into_iter()
            .find(|section| section.id == "section_1")
            .expect("updated section should exist");
        assert_eq!(updated_section.name, "Verse");
        assert_eq!(updated_section.start_seconds, 2.5);
        assert_eq!(updated_section.end_seconds, 7.0);

        let saved_song = load_song(&song_dir).expect("song json should load");
        assert_eq!(saved_song.sections[0].name, "Verse");
        assert_eq!(saved_song.sections[0].start_seconds, 2.5);
        assert_eq!(saved_song.sections[0].end_seconds, 7.0);
    }

    #[test]
    fn deleting_a_section_updates_song_json_and_snapshot() {
        let root = tempdir().expect("temp dir should exist");
        let song_dir =
            create_song_folder(root.path(), "section-delete-demo").expect("song dir should exist");
        fs::create_dir_all(song_dir.join("audio")).expect("audio dir should exist");

        let mut session = DesktopSession::default();
        session.song_dir = Some(song_dir.clone());
        session
            .engine
            .load_song(demo_song_with_section())
            .expect("song should load into engine");

        let audio = crate::audio_runtime::AudioController::default();
        let snapshot = session
            .delete_section("section_1", &audio)
            .expect("section should delete");

        assert!(snapshot
            .song
            .expect("song summary should exist")
            .sections
            .is_empty());

        let saved_song = load_song(&song_dir).expect("song json should load");
        assert!(saved_song.sections.is_empty());
    }
}
