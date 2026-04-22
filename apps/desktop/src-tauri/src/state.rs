use std::{
    collections::HashMap,
    fs,
    path::Path,
    path::PathBuf,
    sync::Mutex,
    time::{Instant, SystemTime, UNIX_EPOCH},
};

use libretracks_audio::{
    AudioEngine, AudioEngineError, JumpTrigger, PendingMarkerJump, PlaybackState,
};
use libretracks_core::{
    Clip, Marker, OutputBus, Song, TempoMetadata, TempoSource, Track, TrackKind,
};
use libretracks_project::{
    append_wav_files_to_song, generate_waveform_summary, import_wav_song, load_song_from_file,
    load_waveform_summary, read_wav_metadata, save_song_to_file, waveform_file_path,
    ImportOperationMetrics, ImportedSong, ProjectError, ProjectImportRequest, WaveformSummary,
    SONG_FILE_NAME,
};
use rfd::FileDialog;
use serde::Serialize;
use serde_json::to_vec;
use tauri::{AppHandle, Manager};

use crate::audio_runtime::{AudioController, PlaybackStartReason};

const TIMELINE_TIMEBASE_HZ: u32 = 48_000;

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

pub struct DesktopSession {
    pub engine: AudioEngine,
    transport_clock: TransportClock,
    pub song_dir: Option<PathBuf>,
    song_file_path: Option<PathBuf>,
    project_revision: u64,
    undo_stack: Vec<Song>,
    redo_stack: Vec<Song>,
    waveform_cache: WaveformMemoryCache,
    perf_metrics: DesktopPerformanceMetrics,
}

#[derive(Debug, Default)]
struct TransportClock {
    anchor_position_seconds: f64,
    anchor_started_at: Option<Instant>,
    last_seek_position_seconds: Option<f64>,
    last_start_position_seconds: Option<f64>,
    last_jump_position_seconds: Option<f64>,
}

impl Default for DesktopSession {
    fn default() -> Self {
        Self {
            engine: AudioEngine::default(),
            transport_clock: TransportClock::default(),
            song_dir: None,
            song_file_path: None,
            project_revision: 0,
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
            waveform_cache: WaveformMemoryCache::default(),
            perf_metrics: DesktopPerformanceMetrics::default(),
        }
    }
}

impl TransportClock {
    fn current_position(&self, playback_state: PlaybackState, song_duration: Option<f64>) -> f64 {
        let unclamped_position = if playback_state == PlaybackState::Playing {
            self.anchor_position_seconds + self.elapsed_since_anchor()
        } else {
            self.anchor_position_seconds
        };

        let bounded_position = unclamped_position.max(0.0);
        match song_duration {
            Some(song_duration) => bounded_position.min(song_duration),
            None => bounded_position,
        }
    }

    fn elapsed_since_anchor(&self) -> f64 {
        self.anchor_started_at
            .map(|started_at| started_at.elapsed().as_secs_f64())
            .unwrap_or(0.0)
    }

    fn start_from(&mut self, position_seconds: f64) {
        self.anchor_position_seconds = position_seconds.max(0.0);
        self.anchor_started_at = Some(Instant::now());
        self.last_start_position_seconds = Some(self.anchor_position_seconds);
    }

    fn reanchor_playing(&mut self, position_seconds: f64) {
        self.anchor_position_seconds = position_seconds.max(0.0);
        self.anchor_started_at = Some(Instant::now());
    }

    fn note_jump_while_playing(&mut self, position_seconds: f64) {
        self.last_jump_position_seconds = Some(position_seconds.max(0.0));
        self.reanchor_playing(position_seconds);
    }

    fn pause_at(&mut self, position_seconds: f64) {
        self.anchor_position_seconds = position_seconds.max(0.0);
        self.anchor_started_at = None;
    }

    fn seek_to(&mut self, position_seconds: f64) {
        self.anchor_position_seconds = position_seconds.max(0.0);
        self.anchor_started_at = None;
        self.last_seek_position_seconds = Some(self.anchor_position_seconds);
    }

    fn seek_while_playing(&mut self, position_seconds: f64) {
        self.anchor_position_seconds = position_seconds.max(0.0);
        self.anchor_started_at = Some(Instant::now());
        self.last_seek_position_seconds = Some(self.anchor_position_seconds);
    }

    fn stop(&mut self) {
        self.anchor_position_seconds = 0.0;
        self.anchor_started_at = None;
    }

    fn summary(&self) -> TransportClockSummary {
        TransportClockSummary {
            anchor_position_seconds: self.anchor_position_seconds,
            running: self.anchor_started_at.is_some(),
            last_seek_position_seconds: self.last_seek_position_seconds,
            last_start_position_seconds: self.last_start_position_seconds,
            last_jump_position_seconds: self.last_jump_position_seconds,
        }
    }
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
    #[error("clip not found: {0}")]
    ClipNotFound(String),
    #[error("track not found: {0}")]
    TrackNotFound(String),
    #[error("section not found: {0}")]
    SectionNotFound(String),
    #[error("clip range is invalid")]
    InvalidClipRange,
    #[error("track parent is invalid")]
    InvalidTrackParent,
    #[error("clip split point is invalid")]
    InvalidSplitPoint,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransportSnapshot {
    pub playback_state: String,
    pub position_seconds: f64,
    pub current_marker: Option<MarkerSummary>,
    pub pending_marker_jump: Option<PendingJumpSummary>,
    pub musical_position: MusicalPositionSummary,
    pub transport_clock: TransportClockSummary,
    pub project_revision: u64,
    pub song_dir: Option<String>,
    pub song_file_path: Option<String>,
    pub is_native_runtime: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TransportClockSummary {
    pub anchor_position_seconds: f64,
    pub running: bool,
    pub last_seek_position_seconds: Option<f64>,
    pub last_start_position_seconds: Option<f64>,
    pub last_jump_position_seconds: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SongView {
    pub id: String,
    pub title: String,
    pub artist: Option<String>,
    pub bpm: f64,
    pub tempo_metadata: TempoMetadataSummary,
    pub key: Option<String>,
    pub time_signature: String,
    pub duration_seconds: f64,
    pub section_markers: Vec<MarkerSummary>,
    pub clips: Vec<ClipSummary>,
    pub tracks: Vec<TrackSummary>,
    pub project_revision: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackSummary {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub parent_track_id: Option<String>,
    pub depth: usize,
    pub has_children: bool,
    pub volume: f64,
    pub pan: f64,
    pub muted: bool,
    pub solo: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingJumpSummary {
    pub target_marker_id: String,
    pub target_marker_name: String,
    pub target_digit: Option<u8>,
    pub trigger: String,
    pub execute_at_seconds: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkerSummary {
    pub id: String,
    pub name: String,
    pub start_seconds: f64,
    pub digit: Option<u8>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TempoMetadataSummary {
    pub source: String,
    pub confidence: Option<f64>,
    pub reference_file_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MusicalPositionSummary {
    pub bar_number: u32,
    pub beat_in_bar: u32,
    pub sub_beat: u32,
    pub display: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipSummary {
    pub id: String,
    pub track_id: String,
    pub track_name: String,
    pub file_path: String,
    pub waveform_key: String,
    pub timeline_start_seconds: f64,
    pub source_start_seconds: f64,
    pub source_duration_seconds: f64,
    pub duration_seconds: f64,
    pub gain: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaveformSummaryDto {
    pub waveform_key: String,
    pub version: u32,
    pub duration_seconds: f64,
    pub bucket_count: usize,
    pub min_peaks: Vec<f32>,
    pub max_peaks: Vec<f32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPerformanceSnapshot {
    pub copy_millis: u128,
    pub wav_analysis_millis: u128,
    pub waveform_write_millis: u128,
    pub song_save_millis: u128,
    pub transport_snapshot_build_millis: u128,
    pub song_view_build_millis: u128,
    pub waveform_cache_hits: u64,
    pub waveform_cache_misses: u64,
    pub transport_snapshot_bytes: usize,
    pub song_view_bytes: usize,
    pub last_react_render_millis: f64,
    pub project_revision: u64,
    pub cached_waveforms: usize,
}

#[derive(Debug, Clone, Default)]
struct DesktopPerformanceMetrics {
    copy_millis: u128,
    wav_analysis_millis: u128,
    waveform_write_millis: u128,
    song_save_millis: u128,
    transport_snapshot_build_millis: u128,
    song_view_build_millis: u128,
    waveform_cache_hits: u64,
    waveform_cache_misses: u64,
    transport_snapshot_bytes: usize,
    song_view_bytes: usize,
    last_react_render_millis: f64,
}

#[derive(Debug, Clone, Default)]
struct WaveformMemoryCache {
    song_dir: Option<PathBuf>,
    entries: HashMap<String, CachedWaveformSummary>,
}

#[derive(Debug, Clone)]
struct CachedWaveformSummary {
    token: WaveformCacheToken,
    summary: WaveformSummary,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct WaveformCacheToken {
    audio_size: u64,
    audio_modified_millis: u128,
    waveform_size: u64,
    waveform_modified_millis: u128,
}

impl DesktopSession {
    pub fn create_song(
        &mut self,
        app: &AppHandle,
        audio: &AudioController,
    ) -> Result<Option<TransportSnapshot>, DesktopError> {
        let title = "Nueva Cancion".to_string();
        let song_id = format!("song_{}", timestamp_suffix());
        let song = build_empty_song(song_id, title);

        let default_directory = project_root(app).join("songs");
        let target_song_file = FileDialog::new()
            .set_title("Crear proyecto")
            .set_directory(&default_directory)
            .add_filter("LibreTracks Song", &["json"])
            .set_file_name(&default_project_file_name(&song.title))
            .save_file();

        let Some(target_song_file) = target_song_file else {
            return Ok(None);
        };

        let song_dir = target_song_file
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| {
                DesktopError::AudioCommand(
                    "el archivo del proyecto debe vivir dentro de una carpeta".into(),
                )
            })?;
        fs::create_dir_all(song_dir.join("audio"))?;
        fs::create_dir_all(song_dir.join("cache").join("waveforms"))?;

        let save_started_at = Instant::now();
        save_song_to_file(&target_song_file, &song)?;
        self.perf_metrics.song_save_millis = save_started_at.elapsed().as_millis();
        self.load_song_from_path(song, song_dir, audio)?;
        self.song_file_path = Some(target_song_file);

        Ok(Some(self.snapshot()))
    }

    pub fn save_project(&mut self) -> Result<TransportSnapshot, DesktopError> {
        let song_file_path = self.current_song_file_path()?;
        let song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;

        let save_started_at = Instant::now();
        save_song_to_file(&song_file_path, &song)?;
        self.perf_metrics.song_save_millis = save_started_at.elapsed().as_millis();
        Ok(self.snapshot())
    }

    pub fn save_project_as(&mut self) -> Result<Option<TransportSnapshot>, DesktopError> {
        let source_song_dir = self.song_dir.clone().ok_or(DesktopError::NoSongLoaded)?;
        let song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;

        let target_song_file = FileDialog::new()
            .add_filter("LibreTracks Song", &["json"])
            .set_title("Guardar proyecto como")
            .set_file_name(&default_project_file_name(&song.title))
            .save_file();

        let Some(target_song_file) = target_song_file else {
            return Ok(None);
        };

        let target_song_dir = target_song_file
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| {
                DesktopError::AudioCommand(
                    "el archivo del proyecto debe vivir dentro de una carpeta".into(),
                )
            })?;

        let save_started_at = Instant::now();
        copy_project_audio_files(&source_song_dir, &target_song_dir, &song)?;
        save_song_to_file(&target_song_file, &song)?;
        self.perf_metrics.song_save_millis = save_started_at.elapsed().as_millis();

        self.song_dir = Some(target_song_dir.clone());
        self.song_file_path = Some(target_song_file);
        self.prime_waveform_cache(&target_song_dir, &song)?;

        Ok(Some(self.snapshot()))
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
        let song = load_song_from_file(&song_file)?;

        self.load_song_from_path(song, song_dir, audio)?;
        self.song_file_path = Some(song_file);

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

        if self.song_dir.is_some() && self.engine.song().is_some() {
            return Ok(Some(
                self.import_audio_files_into_current_song(&files, audio)?,
            ));
        }

        let import_root = project_root(app);
        let request = build_import_request(&files);
        let folder_name = format!("{}-{}", slugify(&request.title), timestamp_suffix());
        let imported_song = import_wav_song(import_root.join("songs"), &folder_name, &request)?;

        self.load_imported_song(imported_song, audio)?;

        Ok(Some(self.snapshot()))
    }

    fn import_audio_files_into_current_song(
        &mut self,
        files: &[PathBuf],
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let song_dir = self.song_dir.clone().ok_or(DesktopError::NoSongLoaded)?;
        let song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        let updated_song = append_wav_files_to_song(&song_dir, &song, files)?;
        self.record_import_metrics(&updated_song.metrics);
        self.persist_song_update(
            updated_song.song,
            audio,
            AudioChangeImpact::StructureRebuild,
        )?;
        Ok(self.snapshot())
    }

    pub fn song_view(&mut self) -> Result<Option<SongView>, DesktopError> {
        let started_at = Instant::now();
        let song_view = self
            .engine
            .song()
            .map(|song| song_to_view(song, &self.waveform_cache, self.project_revision));
        self.perf_metrics.song_view_build_millis = started_at.elapsed().as_millis();
        self.perf_metrics.song_view_bytes = song_view
            .as_ref()
            .map(|view| to_vec(view).map(|bytes| bytes.len()))
            .transpose()
            .map_err(|error| DesktopError::AudioCommand(error.to_string()))?
            .unwrap_or(0);
        Ok(song_view)
    }

    pub fn load_waveforms(
        &mut self,
        waveform_keys: &[String],
    ) -> Result<Vec<WaveformSummaryDto>, DesktopError> {
        let song_dir = self.song_dir.clone().ok_or(DesktopError::NoSongLoaded)?;
        let valid_waveform_keys = self
            .engine
            .song()
            .ok_or(DesktopError::NoSongLoaded)?
            .clips
            .iter()
            .map(|clip| waveform_key_for_file_path(&clip.file_path))
            .collect::<std::collections::HashSet<_>>();
        let mut summaries = Vec::new();

        for waveform_key in waveform_keys {
            if !valid_waveform_keys.contains(waveform_key) {
                continue;
            }

            let summary = self.load_waveform_summary_cached(&song_dir, waveform_key, true)?;
            summaries.push(waveform_summary_to_dto(waveform_key, summary));
        }

        Ok(summaries)
    }

    pub fn performance_snapshot(&self) -> DesktopPerformanceSnapshot {
        DesktopPerformanceSnapshot {
            copy_millis: self.perf_metrics.copy_millis,
            wav_analysis_millis: self.perf_metrics.wav_analysis_millis,
            waveform_write_millis: self.perf_metrics.waveform_write_millis,
            song_save_millis: self.perf_metrics.song_save_millis,
            transport_snapshot_build_millis: self.perf_metrics.transport_snapshot_build_millis,
            song_view_build_millis: self.perf_metrics.song_view_build_millis,
            waveform_cache_hits: self.perf_metrics.waveform_cache_hits,
            waveform_cache_misses: self.perf_metrics.waveform_cache_misses,
            transport_snapshot_bytes: self.perf_metrics.transport_snapshot_bytes,
            song_view_bytes: self.perf_metrics.song_view_bytes,
            last_react_render_millis: self.perf_metrics.last_react_render_millis,
            project_revision: self.project_revision,
            cached_waveforms: self.waveform_cache.entries.len(),
        }
    }

    pub fn report_ui_render_metric(&mut self, render_millis: f64) {
        self.perf_metrics.last_react_render_millis = render_millis.max(0.0);
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

        audio.replace_song_buffers(&song_dir, &song)?;
        audio.play(song_dir, song, self.engine.position_seconds(), start_reason)?;
        self.engine.play()?;
        self.transport_clock
            .start_from(self.engine.position_seconds());

        Ok(self.snapshot())
    }

    pub fn pause(&mut self, audio: &AudioController) -> Result<TransportSnapshot, DesktopError> {
        self.sync_position(audio)?;

        audio.stop()?;

        self.engine.pause()?;
        self.transport_clock
            .pause_at(self.engine.position_seconds());

        Ok(self.snapshot())
    }

    pub fn stop(&mut self, audio: &AudioController) -> Result<TransportSnapshot, DesktopError> {
        audio.stop()?;

        self.engine.stop()?;
        self.transport_clock.stop();

        Ok(self.snapshot())
    }

    pub fn seek(
        &mut self,
        position_seconds: f64,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let was_playing = self.engine.playback_state() == PlaybackState::Playing;
        self.engine.seek(position_seconds)?;
        if was_playing {
            self.reposition_audio(audio, PlaybackStartReason::Seek)?;
            self.transport_clock
                .seek_while_playing(self.engine.position_seconds());
            return Ok(self.snapshot());
        }

        self.transport_clock.seek_to(self.engine.position_seconds());

        Ok(self.snapshot())
    }

    pub fn schedule_marker_jump(
        &mut self,
        target_marker_id: &str,
        trigger: JumpTrigger,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        self.sync_position(audio)?;
        let was_playing = self.engine.playback_state() == PlaybackState::Playing;

        self.engine
            .schedule_marker_jump(target_marker_id, trigger.clone())?;

        if trigger == JumpTrigger::Immediate {
            if was_playing {
                self.reposition_audio(audio, PlaybackStartReason::ImmediateJump)?;
                self.transport_clock
                    .note_jump_while_playing(self.engine.position_seconds());
            } else {
                self.transport_clock.seek_to(self.engine.position_seconds());
            }
        }

        Ok(self.snapshot())
    }

    pub fn cancel_marker_jump(
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

    pub fn create_section_marker(
        &mut self,
        start_seconds: f64,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        let start_seconds = start_seconds
            .max(0.0)
            .min((song.duration_seconds - 0.0001).max(0.0));
        let marker_name = song.next_marker_name();
        song.section_markers.push(Marker {
            id: format!("section_{}", timestamp_suffix()),
            name: marker_name,
            start_seconds,
            digit: None,
        });
        song.section_markers.sort_by(|left, right| {
            left.start_seconds
                .partial_cmp(&right.start_seconds)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        self.persist_song_update(song, audio, AudioChangeImpact::TransportOnly)?;

        Ok(self.snapshot())
    }

    pub fn update_section_marker(
        &mut self,
        section_id: &str,
        name: &str,
        start_seconds: f64,
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

        let start_seconds = start_seconds
            .max(0.0)
            .min((song.duration_seconds - 0.0001).max(0.0));

        let section = song
            .section_markers
            .iter_mut()
            .find(|section| section.id == section_id)
            .ok_or_else(|| DesktopError::SectionNotFound(section_id.to_string()))?;

        section.name = trimmed_name.to_string();
        section.start_seconds = start_seconds;
        song.section_markers.sort_by(|left, right| {
            left.start_seconds
                .partial_cmp(&right.start_seconds)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        self.persist_song_update(song, audio, AudioChangeImpact::TransportOnly)?;

        Ok(self.snapshot())
    }

    pub fn delete_section_marker(
        &mut self,
        section_id: &str,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        let section_count = song.section_markers.len();
        song.section_markers
            .retain(|section| section.id != section_id);

        if song.section_markers.len() == section_count {
            return Err(DesktopError::SectionNotFound(section_id.to_string()));
        }

        self.persist_song_update(song, audio, AudioChangeImpact::TransportOnly)?;

        Ok(self.snapshot())
    }

    pub fn assign_section_marker_digit(
        &mut self,
        section_id: &str,
        digit: Option<u8>,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;

        if let Some(digit) = digit {
            for marker in song.section_markers.iter_mut() {
                if marker.id != section_id && marker.digit == Some(digit) {
                    marker.digit = None;
                }
            }
        }

        let marker = song
            .section_markers
            .iter_mut()
            .find(|section| section.id == section_id)
            .ok_or_else(|| DesktopError::SectionNotFound(section_id.to_string()))?;
        marker.digit = digit;

        self.persist_song_update(song, audio, AudioChangeImpact::TransportOnly)?;

        Ok(self.snapshot())
    }

    pub fn update_song_tempo(
        &mut self,
        bpm: f64,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        if !bpm.is_finite() || bpm <= 0.0 {
            return Err(DesktopError::AudioCommand(
                "song bpm must be greater than zero".into(),
            ));
        }

        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        song.bpm = bpm;
        song.tempo_metadata = TempoMetadata {
            source: TempoSource::Manual,
            confidence: None,
            reference_file_path: None,
        };

        self.persist_song_update(song, audio, AudioChangeImpact::TransportOnly)?;

        Ok(self.snapshot())
    }

    pub fn create_track(
        &mut self,
        name: &str,
        kind: TrackKind,
        insert_after_track_id: Option<&str>,
        parent_track_id: Option<&str>,
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
                "track name must not be empty".into(),
            ));
        }

        let output_bus_id = parent_track_id
            .and_then(|parent_id| {
                song.tracks
                    .iter()
                    .find(|track| track.id == parent_id)
                    .map(|track| track.output_bus_id.clone())
            })
            .unwrap_or_else(|| OutputBus::Main.id());

        let track = Track {
            id: format!("track_{}", timestamp_suffix()),
            name: trimmed_name.to_string(),
            kind,
            parent_track_id: parent_track_id.map(str::to_string),
            volume: 1.0,
            pan: 0.0,
            muted: false,
            solo: false,
            output_bus_id,
        };

        insert_track(
            &mut song.tracks,
            track,
            insert_after_track_id,
            parent_track_id,
        )?;
        self.persist_song_update(song, audio, AudioChangeImpact::StructureRebuild)?;

        Ok(self.snapshot())
    }

    pub fn move_track(
        &mut self,
        track_id: &str,
        insert_after_track_id: Option<&str>,
        insert_before_track_id: Option<&str>,
        parent_track_id: Option<&str>,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;

        reparent_track(
            &mut song.tracks,
            track_id,
            insert_after_track_id,
            insert_before_track_id,
            parent_track_id,
        )?;
        self.persist_song_update(song, audio, AudioChangeImpact::StructureRebuild)?;

        Ok(self.snapshot())
    }

    pub fn update_track(
        &mut self,
        track_id: &str,
        name: Option<&str>,
        volume: Option<f64>,
        pan: Option<f64>,
        muted: Option<bool>,
        solo: Option<bool>,
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

        if let Some(name) = name {
            let trimmed_name = name.trim();
            if trimmed_name.is_empty() {
                return Err(DesktopError::AudioCommand(
                    "track name must not be empty".into(),
                ));
            }
            track.name = trimmed_name.to_string();
        }

        if let Some(volume) = volume {
            track.volume = volume.clamp(0.0, 1.0);
        }

        if let Some(pan) = pan {
            track.pan = pan.clamp(-1.0, 1.0);
        }

        if let Some(muted) = muted {
            track.muted = muted;
        }

        if let Some(solo) = solo {
            track.solo = solo;
        }

        self.persist_song_update(song, audio, AudioChangeImpact::MixOnly)?;

        Ok(self.snapshot())
    }

    pub fn delete_track(
        &mut self,
        track_id: &str,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        let deleted_track = delete_track_and_repair_hierarchy(&mut song.tracks, track_id)?;

        if deleted_track.kind == TrackKind::Audio {
            song.clips.retain(|clip| clip.track_id != track_id);
            refresh_song_duration(&mut song);
        }

        self.persist_song_update(song, audio, AudioChangeImpact::StructureRebuild)?;

        Ok(self.snapshot())
    }

    pub fn split_clip(
        &mut self,
        clip_id: &str,
        split_seconds: f64,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        let clip_index = song
            .clips
            .iter()
            .position(|clip| clip.id == clip_id)
            .ok_or_else(|| DesktopError::ClipNotFound(clip_id.to_string()))?;
        let clip = song.clips[clip_index].clone();
        let clip_end = clip.timeline_start_seconds + clip.duration_seconds;

        if split_seconds <= clip.timeline_start_seconds || split_seconds >= clip_end {
            return Err(DesktopError::InvalidSplitPoint);
        }

        let left_duration = split_seconds - clip.timeline_start_seconds;
        let right_duration = clip_end - split_seconds;

        let left_clip = Clip {
            id: format!("clip_{}", timestamp_suffix()),
            duration_seconds: left_duration,
            ..clip.clone()
        };
        let right_clip = Clip {
            id: format!("clip_{}", timestamp_suffix() + 1),
            timeline_start_seconds: split_seconds,
            source_start_seconds: clip.source_start_seconds + left_duration,
            duration_seconds: right_duration,
            ..clip
        };

        song.clips
            .splice(clip_index..=clip_index, [left_clip, right_clip]);
        self.persist_song_update(song, audio, AudioChangeImpact::StructureRebuild)?;

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
        self.record_import_metrics(&imported_song.metrics);
        self.load_song_from_path(imported_song.song, imported_song.song_dir, audio)
    }

    fn load_song_from_path(
        &mut self,
        song: Song,
        song_dir: PathBuf,
        audio: &AudioController,
    ) -> Result<(), DesktopError> {
        audio.stop()?;
        audio.replace_song_buffers(&song_dir, &song)?;

        self.transport_clock.stop();
        self.song_dir = Some(song_dir.clone());
        self.song_file_path = Some(song_dir.join(SONG_FILE_NAME));
        self.undo_stack.clear();
        self.redo_stack.clear();
        self.engine.load_song(song)?;
        self.project_revision = self.project_revision.saturating_add(1);
        let loaded_song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        self.prime_waveform_cache(&song_dir, &loaded_song)?;

        Ok(())
    }

    fn persist_song_update(
        &mut self,
        song: Song,
        audio: &AudioController,
        impact: AudioChangeImpact,
    ) -> Result<(), DesktopError> {
        self.persist_song_update_internal(song, audio, impact, true)
    }

    fn persist_song_update_internal(
        &mut self,
        song: Song,
        audio: &AudioController,
        impact: AudioChangeImpact,
        record_history: bool,
    ) -> Result<(), DesktopError> {
        self.sync_position(audio)?;

        if record_history {
            if let Some(current_song) = self.engine.song().cloned() {
                self.undo_stack.push(current_song);
                if self.undo_stack.len() > 50 {
                    self.undo_stack.remove(0);
                }
            }
            self.redo_stack.clear();
        }

        let playback_state = self.engine.playback_state();
        let position_seconds = self.current_position();
        let pending_jump = self.engine.pending_marker_jump().cloned();
        let song_dir = self.song_dir.clone().ok_or(DesktopError::NoSongLoaded)?;
        let song_file_path = self.current_song_file_path()?;

        if playback_state == PlaybackState::Playing
            && matches!(
                impact,
                AudioChangeImpact::TimelineWindow | AudioChangeImpact::StructureRebuild
            )
        {
            audio.replace_song_buffers(&song_dir, &song)?;
        }

        let save_started_at = Instant::now();
        save_song_to_file(&song_file_path, &song)?;
        self.perf_metrics.song_save_millis = save_started_at.elapsed().as_millis();
        self.engine.load_song(song)?;
        self.project_revision = self.project_revision.saturating_add(1);
        self.prune_waveform_cache_for_current_song();

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
            if loaded_song
                .marker_by_id(&pending_jump.target_marker_id)
                .is_some()
            {
                if restored_position < pending_jump.execute_at_seconds {
                    self.engine.schedule_marker_jump(
                        &pending_jump.target_marker_id,
                        pending_jump.trigger,
                    )?;
                }
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
                self.transport_clock
                    .reanchor_playing(self.engine.position_seconds());
            }
            PlaybackState::Paused => {
                self.engine.pause()?;
                self.transport_clock
                    .pause_at(self.engine.position_seconds());
            }
            PlaybackState::Stopped | PlaybackState::Empty => {
                self.transport_clock
                    .pause_at(self.engine.position_seconds());
            }
        }

        Ok(())
    }

    pub fn undo_action(
        &mut self,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let Some(previous_song) = self.undo_stack.pop() else {
            return Ok(self.snapshot());
        };

        let current_song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        self.redo_stack.push(current_song);

        self.persist_song_update_internal(
            previous_song,
            audio,
            AudioChangeImpact::StructureRebuild,
            false,
        )?;

        Ok(self.snapshot())
    }

    pub fn redo_action(
        &mut self,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let Some(next_song) = self.redo_stack.pop() else {
            return Ok(self.snapshot());
        };

        let current_song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        self.undo_stack.push(current_song);
        if self.undo_stack.len() > 50 {
            self.undo_stack.remove(0);
        }

        self.persist_song_update_internal(
            next_song,
            audio,
            AudioChangeImpact::StructureRebuild,
            false,
        )?;

        Ok(self.snapshot())
    }

    fn current_position(&self) -> f64 {
        self.transport_clock.current_position(
            self.engine.playback_state(),
            self.engine.song().map(|song| song.duration_seconds),
        )
    }

    fn sync_position(&mut self, audio: &AudioController) -> Result<(), DesktopError> {
        if self.engine.playback_state() != PlaybackState::Playing {
            return Ok(());
        }

        let song_duration = self
            .engine
            .song()
            .map(|song| song.duration_seconds)
            .ok_or(DesktopError::NoSongLoaded)?;
        let linear_position = self
            .transport_clock
            .current_position(PlaybackState::Playing, Some(song_duration));

        if linear_position >= song_duration {
            audio.stop()?;
            self.engine.stop()?;
            self.transport_clock.stop();
            return Ok(());
        }

        let elapsed = self.transport_clock.elapsed_since_anchor();
        let (advanced_position, jump_executed) = self.engine.advance_transport(elapsed)?;

        if jump_executed {
            self.reposition_audio(audio, PlaybackStartReason::TransportResync)?;
            self.transport_clock
                .note_jump_while_playing(advanced_position);
        } else {
            self.transport_clock.reanchor_playing(advanced_position);
        }

        Ok(())
    }

    fn snapshot(&mut self) -> TransportSnapshot {
        let started_at = Instant::now();
        let snapshot = TransportSnapshot {
            playback_state: playback_state_label(self.engine.playback_state()).to_string(),
            position_seconds: self.current_position(),
            current_marker: self
                .engine
                .current_marker()
                .ok()
                .flatten()
                .map(|marker| marker_to_summary(&marker)),
            pending_marker_jump: self
                .engine
                .pending_marker_jump()
                .map(pending_jump_to_summary),
            musical_position: self
                .engine
                .song()
                .map(|song| musical_position_summary(song, self.current_position()))
                .unwrap_or_else(empty_musical_position_summary),
            transport_clock: self.transport_clock.summary(),
            project_revision: self.project_revision,
            song_dir: self
                .song_dir
                .as_ref()
                .map(|value| value.display().to_string()),
            song_file_path: self
                .song_file_path
                .as_ref()
                .map(|value| value.display().to_string())
                .or_else(|| {
                    self.song_dir
                        .as_ref()
                        .map(|song_dir| song_dir.join(SONG_FILE_NAME).display().to_string())
                }),
            is_native_runtime: true,
        };
        self.perf_metrics.transport_snapshot_build_millis = started_at.elapsed().as_millis();
        self.perf_metrics.transport_snapshot_bytes = to_vec(&snapshot)
            .map(|bytes| bytes.len())
            .unwrap_or_default();
        snapshot
    }

    fn record_import_metrics(&mut self, metrics: &ImportOperationMetrics) {
        self.perf_metrics.copy_millis = metrics.copy_millis;
        self.perf_metrics.wav_analysis_millis = metrics.wav_analysis_millis;
        self.perf_metrics.waveform_write_millis = metrics.waveform_write_millis;
        self.perf_metrics.song_save_millis = metrics.song_save_millis;
    }

    fn current_song_file_path(&self) -> Result<PathBuf, DesktopError> {
        if let Some(song_file_path) = self.song_file_path.clone() {
            return Ok(song_file_path);
        }

        self.song_dir
            .as_ref()
            .map(|song_dir| song_dir.join(SONG_FILE_NAME))
            .ok_or(DesktopError::NoSongLoaded)
    }

    fn prime_waveform_cache(&mut self, song_dir: &Path, song: &Song) -> Result<(), DesktopError> {
        self.waveform_cache.reset(song_dir);

        for clip in &song.clips {
            let waveform_key = waveform_key_for_file_path(&clip.file_path);
            let _ = self.load_waveform_summary_cached(song_dir, &waveform_key, true)?;
        }

        Ok(())
    }

    fn prune_waveform_cache_for_current_song(&mut self) {
        let Some(song_dir) = self.song_dir.as_ref() else {
            self.waveform_cache.entries.clear();
            return;
        };
        if self.waveform_cache.song_dir.as_deref() != Some(song_dir.as_path()) {
            self.waveform_cache.reset(song_dir);
        }

        let Some(song) = self.engine.song() else {
            self.waveform_cache.entries.clear();
            return;
        };

        let valid_keys = song
            .clips
            .iter()
            .map(|clip| waveform_key_for_file_path(&clip.file_path))
            .collect::<std::collections::HashSet<_>>();
        self.waveform_cache
            .entries
            .retain(|key, _| valid_keys.contains(key));
    }

    fn load_waveform_summary_cached(
        &mut self,
        song_dir: &Path,
        waveform_key: &str,
        allow_regenerate: bool,
    ) -> Result<&WaveformSummary, DesktopError> {
        self.waveform_cache.reset_if_song_changed(song_dir);
        if let Ok(token) = build_waveform_cache_token(song_dir, waveform_key) {
            if self
                .waveform_cache
                .entries
                .get(waveform_key)
                .is_some_and(|entry| entry.token == token)
            {
                self.perf_metrics.waveform_cache_hits += 1;
                return Ok(&self
                    .waveform_cache
                    .entries
                    .get(waveform_key)
                    .expect("waveform cache entry should exist")
                    .summary);
            }
        }

        self.perf_metrics.waveform_cache_misses += 1;
        let summary = match load_waveform_summary(song_dir, waveform_key) {
            Ok(summary) => summary,
            Err(error)
                if allow_regenerate
                    && matches!(
                        error,
                        ProjectError::Io(_) | ProjectError::InvalidWaveformSummary(_)
                    ) =>
            {
                generate_waveform_summary(song_dir, waveform_key)?
            }
            Err(error) => return Err(error.into()),
        };
        let refreshed_token = build_waveform_cache_token(song_dir, waveform_key)?;

        self.waveform_cache.entries.insert(
            waveform_key.to_string(),
            CachedWaveformSummary {
                token: refreshed_token,
                summary,
            },
        );

        Ok(&self
            .waveform_cache
            .entries
            .get(waveform_key)
            .expect("waveform cache entry should exist")
            .summary)
    }

    fn reposition_audio(
        &mut self,
        audio: &AudioController,
        reason: PlaybackStartReason,
    ) -> Result<(), DesktopError> {
        let song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        audio.seek(song, self.engine.position_seconds(), reason)?;
        Ok(())
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
        audio.replace_song_buffers(&song_dir, &song)?;
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
        bpm: None,
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
        tempo_metadata: TempoMetadata {
            source: TempoSource::Manual,
            confidence: None,
            reference_file_path: None,
        },
        key: None,
        time_signature: "4/4".into(),
        duration_seconds: 60.0,
        tracks: vec![],
        clips: vec![],
        section_markers: vec![],
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

fn track_kind_label(kind: TrackKind) -> &'static str {
    match kind {
        TrackKind::Audio => "audio",
        TrackKind::Folder => "folder",
    }
}

fn track_depth(song: &Song, track_id: &str) -> usize {
    let mut depth = 0_usize;
    let mut cursor = song
        .tracks
        .iter()
        .find(|track| track.id == track_id)
        .and_then(|track| track.parent_track_id.as_deref());

    while let Some(parent_track_id) = cursor {
        depth += 1;
        cursor = song
            .tracks
            .iter()
            .find(|track| track.id == parent_track_id)
            .and_then(|track| track.parent_track_id.as_deref());
    }

    depth
}

fn insert_track(
    tracks: &mut Vec<Track>,
    track: Track,
    insert_after_track_id: Option<&str>,
    parent_track_id: Option<&str>,
) -> Result<(), DesktopError> {
    validate_track_parent(tracks, &track.id, parent_track_id)?;
    let insert_index = resolve_insert_index(tracks, insert_after_track_id, None, parent_track_id)?;
    tracks.insert(insert_index, track);
    Ok(())
}

fn reparent_track(
    tracks: &mut Vec<Track>,
    track_id: &str,
    insert_after_track_id: Option<&str>,
    insert_before_track_id: Option<&str>,
    parent_track_id: Option<&str>,
) -> Result<(), DesktopError> {
    let (start, end) = track_subtree_bounds(tracks, track_id)?;
    let mut moving_block = tracks.drain(start..end).collect::<Vec<_>>();
    let root_track = moving_block
        .first_mut()
        .ok_or_else(|| DesktopError::TrackNotFound(track_id.to_string()))?;

    validate_track_parent(tracks, track_id, parent_track_id)?;
    if is_descendant_of(tracks, parent_track_id, track_id) {
        return Err(DesktopError::InvalidTrackParent);
    }

    root_track.parent_track_id = parent_track_id.map(str::to_string);
    let insert_index = resolve_insert_index(
        tracks,
        insert_after_track_id,
        insert_before_track_id,
        parent_track_id,
    )?;
    tracks.splice(insert_index..insert_index, moving_block);
    Ok(())
}

fn delete_track_and_repair_hierarchy(
    tracks: &mut Vec<Track>,
    track_id: &str,
) -> Result<Track, DesktopError> {
    let track_index = tracks
        .iter()
        .position(|track| track.id == track_id)
        .ok_or_else(|| DesktopError::TrackNotFound(track_id.to_string()))?;
    let deleted_track = tracks.remove(track_index);

    if deleted_track.kind == TrackKind::Folder {
        for track in tracks.iter_mut() {
            if track.parent_track_id.as_deref() == Some(track_id) {
                track.parent_track_id = deleted_track.parent_track_id.clone();
            }
        }
    }

    Ok(deleted_track)
}

fn resolve_insert_index(
    tracks: &[Track],
    insert_after_track_id: Option<&str>,
    insert_before_track_id: Option<&str>,
    parent_track_id: Option<&str>,
) -> Result<usize, DesktopError> {
    if let Some(insert_after_track_id) = insert_after_track_id {
        let (_, end) = track_subtree_bounds(tracks, insert_after_track_id)?;
        return Ok(end);
    }

    if let Some(insert_before_track_id) = insert_before_track_id {
        let (start, _) = track_subtree_bounds(tracks, insert_before_track_id)?;
        return Ok(start);
    }

    if let Some(parent_track_id) = parent_track_id {
        let (_, end) = track_subtree_bounds(tracks, parent_track_id)?;
        return Ok(end);
    }

    Ok(tracks.len())
}

fn validate_track_parent(
    tracks: &[Track],
    track_id: &str,
    parent_track_id: Option<&str>,
) -> Result<(), DesktopError> {
    let Some(parent_track_id) = parent_track_id else {
        return Ok(());
    };

    if parent_track_id == track_id {
        return Err(DesktopError::InvalidTrackParent);
    }

    let parent_track = tracks
        .iter()
        .find(|track| track.id == parent_track_id)
        .ok_or(DesktopError::InvalidTrackParent)?;

    if parent_track.kind != TrackKind::Folder {
        return Err(DesktopError::InvalidTrackParent);
    }

    Ok(())
}

fn is_descendant_of(tracks: &[Track], candidate_parent_id: Option<&str>, track_id: &str) -> bool {
    let Some(candidate_parent_id) = candidate_parent_id else {
        return false;
    };

    if candidate_parent_id == track_id {
        return true;
    }

    let mut cursor = tracks
        .iter()
        .find(|track| track.id == candidate_parent_id)
        .and_then(|track| track.parent_track_id.as_deref());

    while let Some(parent_track_id) = cursor {
        if parent_track_id == track_id {
            return true;
        }

        cursor = tracks
            .iter()
            .find(|track| track.id == parent_track_id)
            .and_then(|track| track.parent_track_id.as_deref());
    }

    false
}

fn track_subtree_bounds(tracks: &[Track], track_id: &str) -> Result<(usize, usize), DesktopError> {
    let start = tracks
        .iter()
        .position(|track| track.id == track_id)
        .ok_or_else(|| DesktopError::TrackNotFound(track_id.to_string()))?;
    let root_depth = track_depth_from_tracks(tracks, track_id)?;
    let mut end = start + 1;

    while end < tracks.len() {
        let next_depth = track_depth_from_tracks(tracks, &tracks[end].id)?;
        if next_depth <= root_depth {
            break;
        }
        end += 1;
    }

    Ok((start, end))
}

fn track_depth_from_tracks(tracks: &[Track], track_id: &str) -> Result<usize, DesktopError> {
    let mut depth = 0_usize;
    let mut cursor = tracks
        .iter()
        .find(|track| track.id == track_id)
        .ok_or_else(|| DesktopError::TrackNotFound(track_id.to_string()))?
        .parent_track_id
        .as_deref();

    while let Some(parent_track_id) = cursor {
        depth += 1;
        cursor = tracks
            .iter()
            .find(|track| track.id == parent_track_id)
            .ok_or_else(|| DesktopError::TrackNotFound(parent_track_id.to_string()))?
            .parent_track_id
            .as_deref();
    }

    Ok(depth)
}

impl WaveformMemoryCache {
    fn reset(&mut self, song_dir: &Path) {
        self.song_dir = Some(song_dir.to_path_buf());
        self.entries.clear();
    }

    fn reset_if_song_changed(&mut self, song_dir: &Path) {
        if self.song_dir.as_deref() != Some(song_dir) {
            self.reset(song_dir);
        }
    }
}

fn song_to_view(
    song: &Song,
    waveform_cache: &WaveformMemoryCache,
    project_revision: u64,
) -> SongView {
    SongView {
        id: song.id.clone(),
        title: song.title.clone(),
        artist: song.artist.clone(),
        bpm: song.bpm,
        tempo_metadata: tempo_metadata_to_summary(&song.tempo_metadata),
        key: song.key.clone(),
        time_signature: song.time_signature.clone(),
        duration_seconds: song.duration_seconds,
        section_markers: song.section_markers.iter().map(marker_to_summary).collect(),
        clips: song
            .clips
            .iter()
            .map(|clip| clip_to_summary(song, clip, waveform_cache))
            .collect(),
        tracks: song
            .tracks
            .iter()
            .map(|track| TrackSummary {
                id: track.id.clone(),
                name: track.name.clone(),
                kind: track_kind_label(track.kind).to_string(),
                parent_track_id: track.parent_track_id.clone(),
                depth: track_depth(song, &track.id),
                has_children: song
                    .tracks
                    .iter()
                    .any(|child| child.parent_track_id.as_deref() == Some(track.id.as_str())),
                volume: track.volume,
                pan: track.pan,
                muted: track.muted,
                solo: track.solo,
            })
            .collect(),
        project_revision,
    }
}

fn clip_to_summary(song: &Song, clip: &Clip, waveform_cache: &WaveformMemoryCache) -> ClipSummary {
    let track_name = song
        .tracks
        .iter()
        .find(|track| track.id == clip.track_id)
        .map(|track| track.name.clone())
        .unwrap_or_else(|| clip.track_id.clone());
    let waveform_key = waveform_key_for_file_path(&clip.file_path);
    let source_duration_seconds = waveform_cache
        .entries
        .get(&waveform_key)
        .map(|cached| cached.summary.duration_seconds)
        .filter(|duration| *duration > 0.0)
        .unwrap_or(clip.source_start_seconds + clip.duration_seconds);

    ClipSummary {
        id: clip.id.clone(),
        track_id: clip.track_id.clone(),
        track_name,
        file_path: clip.file_path.clone(),
        waveform_key,
        timeline_start_seconds: clip.timeline_start_seconds,
        source_start_seconds: clip.source_start_seconds,
        source_duration_seconds,
        duration_seconds: clip.duration_seconds,
        gain: clip.gain,
    }
}

fn waveform_key_for_file_path(file_path: &str) -> String {
    file_path.replace('\\', "/")
}

fn waveform_summary_to_dto(waveform_key: &str, summary: &WaveformSummary) -> WaveformSummaryDto {
    WaveformSummaryDto {
        waveform_key: waveform_key.to_string(),
        version: summary.version,
        duration_seconds: summary.duration_seconds,
        bucket_count: summary.bucket_count,
        min_peaks: summary.min_peaks.clone(),
        max_peaks: summary.max_peaks.clone(),
    }
}

fn build_waveform_cache_token(
    song_dir: &Path,
    waveform_key: &str,
) -> Result<WaveformCacheToken, DesktopError> {
    let audio_metadata = fs::metadata(song_dir.join(waveform_key))?;
    let waveform_metadata = fs::metadata(waveform_file_path(song_dir, waveform_key))?;

    Ok(WaveformCacheToken {
        audio_size: audio_metadata.len(),
        audio_modified_millis: modified_millis(&audio_metadata)?,
        waveform_size: waveform_metadata.len(),
        waveform_modified_millis: modified_millis(&waveform_metadata)?,
    })
}

fn modified_millis(metadata: &fs::Metadata) -> Result<u128, DesktopError> {
    Ok(metadata
        .modified()?
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis())
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
    let max_marker_start = song
        .section_markers
        .iter()
        .map(|marker| marker.start_seconds)
        .fold(0.0_f64, f64::max);

    song.duration_seconds = max_clip_end
        .max(max_marker_start)
        .max(song.duration_seconds)
        .max(1.0);
}

fn marker_to_summary(marker: &Marker) -> MarkerSummary {
    MarkerSummary {
        id: marker.id.clone(),
        name: marker.name.clone(),
        start_seconds: marker.start_seconds,
        digit: marker.digit,
    }
}

fn pending_jump_to_summary(pending_jump: &PendingMarkerJump) -> PendingJumpSummary {
    PendingJumpSummary {
        target_marker_id: pending_jump.target_marker_id.clone(),
        target_marker_name: pending_jump.target_marker_name.clone(),
        target_digit: pending_jump.target_digit,
        trigger: pending_jump_trigger_label(&pending_jump.trigger),
        execute_at_seconds: pending_jump.execute_at_seconds,
    }
}

fn tempo_metadata_to_summary(metadata: &TempoMetadata) -> TempoMetadataSummary {
    TempoMetadataSummary {
        source: match metadata.source {
            TempoSource::Manual => "manual".to_string(),
            TempoSource::AutoImport => "auto_import".to_string(),
        },
        confidence: metadata.confidence,
        reference_file_path: metadata.reference_file_path.clone(),
    }
}

fn empty_musical_position_summary() -> MusicalPositionSummary {
    MusicalPositionSummary {
        bar_number: 1,
        beat_in_bar: 1,
        sub_beat: 0,
        display: "1.1.00".to_string(),
    }
}

fn musical_position_summary(song: &Song, position_seconds: f64) -> MusicalPositionSummary {
    let Ok((numerator, denominator)) = parse_time_signature(&song.time_signature) else {
        return empty_musical_position_summary();
    };
    if song.bpm <= 0.0 {
        return empty_musical_position_summary();
    }

    let beats_per_bar = numerator.max(1);
    let beat_frames = beat_frames_for_signature(song.bpm, denominator, TIMELINE_TIMEBASE_HZ);
    let total_frames = seconds_to_timebase_frames(position_seconds, TIMELINE_TIMEBASE_HZ);
    let total_whole_beats = total_frames / beat_frames;
    let beat_offset_frames = total_frames % beat_frames;
    let bar_number = (total_whole_beats / u64::from(beats_per_bar)) as u32 + 1;
    let beat_in_bar = (total_whole_beats % u64::from(beats_per_bar)) as u32 + 1;
    let sub_beat =
        (((u128::from(beat_offset_frames)) * 100) / u128::from(beat_frames)).min(99) as u32;

    MusicalPositionSummary {
        bar_number,
        beat_in_bar,
        sub_beat,
        display: format!("{bar_number}.{beat_in_bar}.{sub_beat:02}"),
    }
}

fn seconds_to_timebase_frames(seconds: f64, sample_rate: u32) -> u64 {
    (seconds.max(0.0) * f64::from(sample_rate.max(1))).round() as u64
}

fn beat_frames_for_signature(bpm: f64, denominator: u32, sample_rate: u32) -> u64 {
    let safe_bpm = bpm.max(1.0);
    let safe_denominator = denominator.max(1);
    let quarter_note_frames = (f64::from(sample_rate.max(1)) * 60.0) / safe_bpm;
    (quarter_note_frames * (4.0 / f64::from(safe_denominator)))
        .round()
        .max(1.0) as u64
}

fn parse_time_signature(time_signature: &str) -> Result<(u32, u32), DesktopError> {
    let (numerator, denominator) = time_signature
        .split_once('/')
        .ok_or_else(|| DesktopError::AudioCommand("time signature is invalid".into()))?;
    let numerator = numerator
        .parse::<u32>()
        .map_err(|_| DesktopError::AudioCommand("time signature is invalid".into()))?;
    let denominator = denominator
        .parse::<u32>()
        .map_err(|_| DesktopError::AudioCommand("time signature is invalid".into()))?;
    if numerator == 0 || denominator == 0 {
        return Err(DesktopError::AudioCommand(
            "time signature is invalid".into(),
        ));
    }
    Ok((numerator, denominator))
}

fn pending_jump_trigger_label(trigger: &JumpTrigger) -> String {
    match trigger {
        JumpTrigger::Immediate => "immediate".to_string(),
        JumpTrigger::NextMarker => "next_marker".to_string(),
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

fn default_project_file_name(title: &str) -> String {
    let trimmed = title.trim();
    let fallback = if trimmed.is_empty() {
        "proyecto"
    } else {
        trimmed
    };
    format!("{fallback}.json")
}

fn copy_project_audio_files(
    source_song_dir: &Path,
    target_song_dir: &Path,
    song: &Song,
) -> Result<(), DesktopError> {
    fs::create_dir_all(target_song_dir.join("audio"))?;
    fs::create_dir_all(target_song_dir.join("cache").join("waveforms"))?;

    let mut copied_relative_paths = std::collections::HashSet::new();
    for clip in &song.clips {
        let relative_path = Path::new(&clip.file_path);
        if !copied_relative_paths.insert(relative_path.to_path_buf()) {
            continue;
        }

        let source_path = source_song_dir.join(relative_path);
        let target_path = target_song_dir.join(relative_path);

        if source_path == target_path {
            continue;
        }

        if let Some(parent) = target_path.parent() {
            fs::create_dir_all(parent)?;
        }

        fs::copy(source_path, target_path)?;
    }

    Ok(())
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
    use std::{fs, path::Path, thread, time::Duration};

    use libretracks_audio::{JumpTrigger, PlaybackState};
    use libretracks_core::{
        Clip, Marker, OutputBus, Song, TempoMetadata, TempoSource, Track, TrackKind,
    };
    use libretracks_project::{
        create_song_folder, generate_waveform_summary, load_song, save_song, SONG_FILE_NAME,
    };
    use tempfile::tempdir;

    use super::{musical_position_summary, DesktopSession, TransportClock};

    fn demo_song() -> Song {
        Song {
            id: "song_move".into(),
            title: "Move Demo".into(),
            artist: None,
            bpm: 120.0,
            tempo_metadata: TempoMetadata {
                source: TempoSource::Manual,
                confidence: None,
                reference_file_path: None,
            },
            key: None,
            time_signature: "4/4".into(),
            duration_seconds: 12.0,
            tracks: vec![Track {
                id: "track_1".into(),
                name: "Track 1".into(),
                kind: TrackKind::Audio,
                parent_track_id: None,
                volume: 1.0,
                pan: 0.0,
                muted: false,
                solo: false,
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
            section_markers: vec![],
        }
    }

    fn demo_song_with_section() -> Song {
        let mut song = demo_song();
        song.section_markers.push(Marker {
            id: "section_1".into(),
            name: "Intro".into(),
            start_seconds: 1.0,
            digit: Some(1),
        });
        song
    }

    #[test]
    fn musical_position_summary_uses_time_signature_beat_unit() {
        let mut song = demo_song();
        song.time_signature = "6/8".into();
        song.bpm = 120.0;

        let summary = musical_position_summary(&song, 0.25);

        assert_eq!(summary.bar_number, 1);
        assert_eq!(summary.beat_in_bar, 2);
        assert_eq!(summary.display, "1.2.00");
    }

    #[test]
    fn musical_position_summary_remains_stable_for_long_positions() {
        let song = demo_song();

        let summary = musical_position_summary(&song, 3600.125);

        assert_eq!(summary.bar_number, 1801);
        assert_eq!(summary.beat_in_bar, 1);
        assert_eq!(summary.sub_beat, 25);
        assert_eq!(summary.display, "1801.1.25");
    }

    fn demo_song_with_two_sections() -> Song {
        let mut song = demo_song_with_section();
        song.section_markers.push(Marker {
            id: "section_2".into(),
            name: "Verse".into(),
            start_seconds: 4.0,
            digit: Some(2),
        });
        song
    }

    fn demo_song_with_three_sections() -> Song {
        let mut song = demo_song_with_two_sections();
        song.section_markers.push(Marker {
            id: "section_3".into(),
            name: "Bridge".into(),
            start_seconds: 8.0,
            digit: Some(3),
        });
        song
    }

    fn write_silent_test_wav(path: &Path, duration_seconds: u32) {
        let spec = hound::WavSpec {
            channels: 2,
            sample_rate: 44_100,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(path, spec).expect("wav should be created");
        for _ in 0..(44_100 * duration_seconds) {
            writer.write_sample(0_i16).expect("sample should write");
            writer.write_sample(0_i16).expect("sample should write");
        }
        writer.finalize().expect("wav should finalize");
    }

    fn session_with_song_dir(song_name: &str, song: Song) -> DesktopSession {
        let root = tempdir().expect("temp dir should exist");
        let root_path = root.keep();
        let song_dir = create_song_folder(&root_path, song_name).expect("song dir should exist");
        fs::create_dir_all(song_dir.join("audio")).expect("audio dir should exist");
        write_silent_test_wav(&song_dir.join("audio").join("test.wav"), 12);

        let mut session = DesktopSession::default();
        session.song_file_path = Some(song_dir.join(SONG_FILE_NAME));
        session.song_dir = Some(song_dir);
        session
            .engine
            .load_song(song)
            .expect("song should load into engine");
        session
    }

    fn hierarchy_song() -> Song {
        Song {
            id: "song_hierarchy".into(),
            title: "Hierarchy Demo".into(),
            artist: None,
            bpm: 120.0,
            tempo_metadata: TempoMetadata {
                source: TempoSource::Manual,
                confidence: None,
                reference_file_path: None,
            },
            key: None,
            time_signature: "4/4".into(),
            duration_seconds: 12.0,
            tracks: vec![
                Track {
                    id: "track_folder_a".into(),
                    name: "Folder A".into(),
                    kind: TrackKind::Folder,
                    parent_track_id: None,
                    volume: 1.0,
                    pan: 0.0,
                    muted: false,
                    solo: false,
                    output_bus_id: OutputBus::Main.id(),
                },
                Track {
                    id: "track_child_a".into(),
                    name: "Child A".into(),
                    kind: TrackKind::Audio,
                    parent_track_id: Some("track_folder_a".into()),
                    volume: 1.0,
                    pan: 0.0,
                    muted: false,
                    solo: false,
                    output_bus_id: OutputBus::Main.id(),
                },
                Track {
                    id: "track_folder_b".into(),
                    name: "Folder B".into(),
                    kind: TrackKind::Folder,
                    parent_track_id: None,
                    volume: 1.0,
                    pan: 0.0,
                    muted: false,
                    solo: false,
                    output_bus_id: OutputBus::Main.id(),
                },
                Track {
                    id: "track_child_b".into(),
                    name: "Child B".into(),
                    kind: TrackKind::Audio,
                    parent_track_id: Some("track_folder_b".into()),
                    volume: 1.0,
                    pan: 0.0,
                    muted: false,
                    solo: false,
                    output_bus_id: OutputBus::Main.id(),
                },
            ],
            clips: vec![],
            section_markers: vec![],
        }
    }

    #[test]
    fn transport_clock_advances_only_while_running() {
        let mut clock = TransportClock::default();
        clock.start_from(1.25);

        thread::sleep(Duration::from_millis(20));
        let running_position = clock.current_position(PlaybackState::Playing, Some(8.0));
        assert!(running_position > 1.25);

        clock.pause_at(running_position);
        thread::sleep(Duration::from_millis(20));

        let paused_position = clock.current_position(PlaybackState::Paused, Some(8.0));
        assert!((paused_position - running_position).abs() < 0.02);
    }

    #[test]
    fn transport_clock_seek_reanchors_without_accumulating_old_elapsed_time() {
        let mut clock = TransportClock::default();
        clock.start_from(0.5);

        thread::sleep(Duration::from_millis(12));
        let advanced_position = clock.current_position(PlaybackState::Playing, Some(8.0));
        assert!(advanced_position > 0.5);

        clock.seek_to(3.0);
        thread::sleep(Duration::from_millis(12));

        let seek_position = clock.current_position(PlaybackState::Paused, Some(8.0));
        assert!((seek_position - 3.0).abs() < 0.001);

        clock.start_from(seek_position);
        thread::sleep(Duration::from_millis(12));
        let resumed_position = clock.current_position(PlaybackState::Playing, Some(8.0));
        assert!(resumed_position > 3.0);
        assert!(resumed_position < 3.2);
    }

    #[test]
    fn snapshot_exposes_transport_clock_summary_after_immediate_jump() {
        let mut session = DesktopSession::default();
        session
            .engine
            .load_song(demo_song_with_section())
            .expect("song should load into engine");

        let audio = crate::audio_runtime::AudioController::default();
        let snapshot = session
            .schedule_marker_jump("section_1", JumpTrigger::Immediate, &audio)
            .expect("immediate jump should execute");

        assert_eq!(snapshot.transport_clock.anchor_position_seconds, 1.0);
        assert_eq!(
            snapshot.transport_clock.last_seek_position_seconds,
            Some(1.0)
        );
        assert_eq!(snapshot.transport_clock.last_start_position_seconds, None);
        assert_eq!(snapshot.transport_clock.last_jump_position_seconds, None);
        assert!(!snapshot.transport_clock.running);
    }

    #[test]
    fn snapshot_exposes_transport_clock_summary_after_seek() {
        let mut session = DesktopSession::default();
        session
            .engine
            .load_song(demo_song())
            .expect("song should load into engine");

        let audio = crate::audio_runtime::AudioController::default();
        let snapshot = session.seek(2.75, &audio).expect("seek should succeed");

        assert_eq!(snapshot.position_seconds, 2.75);
        assert_eq!(snapshot.transport_clock.anchor_position_seconds, 2.75);
        assert_eq!(
            snapshot.transport_clock.last_seek_position_seconds,
            Some(2.75)
        );
        assert_eq!(snapshot.transport_clock.last_start_position_seconds, None);
        assert_eq!(snapshot.transport_clock.last_jump_position_seconds, None);
        assert!(!snapshot.transport_clock.running);
    }

    #[test]
    fn pause_freezes_position_after_real_playback() {
        let mut session = session_with_song_dir("pause-freeze-demo", demo_song());
        let audio = crate::audio_runtime::AudioController::default();

        let playing_snapshot = session.play(&audio).expect("play should succeed");
        assert_eq!(playing_snapshot.playback_state, "playing");
        thread::sleep(Duration::from_millis(35));

        let paused_snapshot = session.pause(&audio).expect("pause should succeed");
        let paused_position = paused_snapshot.position_seconds;

        assert_eq!(paused_snapshot.playback_state, "paused");
        assert!(paused_position > 0.0);
        assert!(!paused_snapshot.transport_clock.running);

        thread::sleep(Duration::from_millis(35));
        let frozen_snapshot = session
            .snapshot_with_sync(&audio)
            .expect("snapshot should keep paused position");

        assert_eq!(frozen_snapshot.playback_state, "paused");
        assert!((frozen_snapshot.position_seconds - paused_position).abs() < 0.01);
    }

    #[test]
    fn repeated_seeks_while_playing_keep_latest_seek_anchor() {
        let mut session = session_with_song_dir("rapid-seek-demo", demo_song());
        let audio = crate::audio_runtime::AudioController::default();

        session.play(&audio).expect("play should succeed");
        thread::sleep(Duration::from_millis(15));
        session
            .seek(2.0, &audio)
            .expect("first seek should succeed");
        let snapshot = session
            .seek(3.5, &audio)
            .expect("second seek should succeed");

        assert_eq!(snapshot.playback_state, "playing");
        assert!(snapshot.position_seconds >= 3.5);
        assert!(snapshot.position_seconds < 3.65);
        assert_eq!(
            snapshot.transport_clock.last_seek_position_seconds,
            Some(3.5)
        );
        assert!(snapshot.transport_clock.running);

        let debug_snapshot = audio
            .debug_snapshot()
            .expect("debug snapshot should succeed");
        assert_eq!(debug_snapshot.command_count, 4);
        assert_eq!(
            debug_snapshot.playhead.last_start_reason.as_deref(),
            Some("seek")
        );
        assert!(debug_snapshot.playhead.running);
        assert!(
            debug_snapshot
                .playhead
                .estimated_position_seconds
                .unwrap_or_default()
                >= 3.5
        );
    }

    #[test]
    fn move_track_supports_inserting_before_another_track() {
        let mut tracks = hierarchy_song().tracks;

        super::reparent_track(
            &mut tracks,
            "track_folder_b",
            None,
            Some("track_folder_a"),
            None,
        )
        .expect("folder should move before another folder");

        let ordered_ids = tracks
            .iter()
            .map(|track| track.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            ordered_ids,
            vec![
                "track_folder_b",
                "track_child_b",
                "track_folder_a",
                "track_child_a"
            ]
        );
    }

    #[test]
    fn executing_section_jump_reanchors_transport_and_runtime() {
        let mut session =
            session_with_song_dir("jump-resync-demo", demo_song_with_three_sections());
        let audio = crate::audio_runtime::AudioController::default();

        session.seek(3.95, &audio).expect("seek should succeed");
        session.play(&audio).expect("play should succeed");
        session
            .schedule_marker_jump("section_3", JumpTrigger::NextMarker, &audio)
            .expect("jump should schedule");

        thread::sleep(Duration::from_millis(70));
        let snapshot = session
            .snapshot_with_sync(&audio)
            .expect("sync should execute jump");

        assert_eq!(snapshot.playback_state, "playing");
        assert!(snapshot.pending_marker_jump.is_none());
        assert!(snapshot.position_seconds >= 8.0);
        assert!(snapshot.position_seconds < 8.3);
        assert_eq!(
            snapshot
                .current_marker
                .expect("current marker should exist after jump")
                .name,
            "Bridge"
        );
        assert!(
            snapshot
                .transport_clock
                .last_jump_position_seconds
                .unwrap_or_default()
                >= 8.0
        );

        let debug_snapshot = audio
            .debug_snapshot()
            .expect("debug snapshot should succeed");
        assert_eq!(
            debug_snapshot.playhead.last_start_reason.as_deref(),
            Some("transport_resync")
        );
    }

    #[test]
    fn playback_stops_cleanly_when_song_end_is_reached() {
        let mut session = session_with_song_dir("song-end-demo", demo_song());
        let audio = crate::audio_runtime::AudioController::default();

        session.seek(11.98, &audio).expect("seek should succeed");
        session.play(&audio).expect("play should succeed");

        thread::sleep(Duration::from_millis(60));
        let snapshot = session
            .snapshot_with_sync(&audio)
            .expect("sync should stop transport at song end");

        assert_eq!(snapshot.playback_state, "stopped");
        assert_eq!(snapshot.position_seconds, 0.0);
        assert!(!snapshot.transport_clock.running);
        assert_eq!(snapshot.transport_clock.anchor_position_seconds, 0.0);

        let debug_snapshot = audio
            .debug_snapshot()
            .expect("debug snapshot should succeed");
        assert!(!debug_snapshot.playhead.running);
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
        let song_view = session
            .song_view()
            .expect("song view should build")
            .expect("song view should exist");

        assert_eq!(snapshot.playback_state, "stopped");
        assert_eq!(
            song_view
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
    fn importing_wavs_into_a_loaded_song_appends_tracks_instead_of_replacing_them() {
        let mut session = session_with_song_dir("append-import-demo", demo_song());
        let song_dir = session
            .song_dir
            .clone()
            .expect("song dir should exist for loaded session");
        save_song(&song_dir, &demo_song()).expect("seed song should save");

        let imports_root = tempdir().expect("temp dir should exist");
        let imported_click = imports_root.path().join("click.wav");
        write_silent_test_wav(&imported_click, 6);

        let audio = crate::audio_runtime::AudioController::default();
        let snapshot = session
            .import_audio_files_into_current_song(&[imported_click], &audio)
            .expect("import should append tracks");
        let snapshot_song = session
            .song_view()
            .expect("song view should build")
            .expect("song summary should exist");
        assert_eq!(snapshot.project_revision, snapshot_song.project_revision);
        assert_eq!(snapshot_song.tracks.len(), 2);
        assert_eq!(snapshot_song.clips.len(), 2);
        assert!(snapshot_song
            .tracks
            .iter()
            .any(|track| track.id == "track_1"));
        assert!(snapshot_song
            .tracks
            .iter()
            .any(|track| track.id == "track_click" || track.id == "track_click-1"));

        let saved_song = load_song(&song_dir).expect("song json should load");
        assert_eq!(saved_song.tracks.len(), 2);
        assert_eq!(saved_song.clips.len(), 2);
        assert!(saved_song
            .clips
            .iter()
            .any(|clip| clip.file_path.starts_with("audio/click")));
    }

    #[test]
    fn project_revision_changes_after_mutating_the_song_structure() {
        let mut session = session_with_song_dir("project-revision-demo", demo_song());
        let audio = crate::audio_runtime::AudioController::default();
        let initial_snapshot = session.snapshot();

        let updated_snapshot = session
            .move_clip("clip_1", 4.25, &audio)
            .expect("clip should move");

        assert!(updated_snapshot.project_revision > initial_snapshot.project_revision);
    }

    #[test]
    fn undo_and_redo_restore_song_state() {
        let mut session = session_with_song_dir("undo-redo-demo", demo_song());
        let audio = crate::audio_runtime::AudioController::default();

        let moved_snapshot = session
            .move_clip("clip_1", 4.25, &audio)
            .expect("clip should move");
        let moved_song = session
            .song_view()
            .expect("song view should build")
            .expect("song should exist");
        assert!(moved_snapshot.project_revision > 0);
        assert!(moved_song
            .clips
            .iter()
            .find(|clip| clip.id == "clip_1")
            .map(|clip| (clip.timeline_start_seconds - 4.25).abs() < 0.0001)
            .unwrap_or(false));

        let undone_snapshot = session.undo_action(&audio).expect("undo should succeed");
        let undone_song = session
            .song_view()
            .expect("song view should build")
            .expect("song should exist");
        assert!(undone_snapshot.project_revision > moved_snapshot.project_revision);
        assert!(undone_song
            .clips
            .iter()
            .find(|clip| clip.id == "clip_1")
            .map(|clip| clip.timeline_start_seconds.abs() < 0.0001)
            .unwrap_or(false));

        let redone_snapshot = session.redo_action(&audio).expect("redo should succeed");
        let redone_song = session
            .song_view()
            .expect("song view should build")
            .expect("song should exist");
        assert!(redone_snapshot.project_revision > undone_snapshot.project_revision);
        assert!(redone_song
            .clips
            .iter()
            .find(|clip| clip.id == "clip_1")
            .map(|clip| (clip.timeline_start_seconds - 4.25).abs() < 0.0001)
            .unwrap_or(false));
    }

    #[test]
    fn waveform_requests_reuse_the_in_memory_cache_after_song_load() {
        let root = tempdir().expect("temp dir should exist");
        let song_dir =
            create_song_folder(root.path(), "waveform-cache-demo").expect("song dir should exist");
        let wav_path = song_dir.join("audio").join("test.wav");
        write_silent_test_wav(&wav_path, 6);
        generate_waveform_summary(&song_dir, "audio/test.wav").expect("waveform should generate");
        save_song(&song_dir, &demo_song()).expect("song should save");

        let mut session = DesktopSession::default();
        let audio = crate::audio_runtime::AudioController::default();
        session
            .load_song_from_path(demo_song(), song_dir, &audio)
            .expect("song should load");

        let perf_after_load = session.performance_snapshot();
        let first_waveform = session
            .load_waveforms(&["audio/test.wav".to_string()])
            .expect("waveform should load");
        let perf_after_first_request = session.performance_snapshot();
        let second_waveform = session
            .load_waveforms(&["audio/test.wav".to_string()])
            .expect("waveform should load from cache");
        let perf_after_second_request = session.performance_snapshot();

        assert_eq!(first_waveform.len(), 1);
        assert_eq!(second_waveform.len(), 1);
        assert!(perf_after_load.waveform_cache_misses > 0);
        assert!(
            perf_after_second_request.waveform_cache_hits
                > perf_after_first_request.waveform_cache_hits
        );
    }

    #[test]
    fn creating_a_section_marker_updates_song_json_and_snapshot() {
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
            .create_section_marker(2.0, &audio)
            .expect("section marker should be created");
        let song_view = session
            .song_view()
            .expect("song view should build")
            .expect("song summary should exist");

        assert_eq!(snapshot.project_revision, song_view.project_revision);
        assert_eq!(song_view.section_markers.len(), 1);
        assert_eq!(song_view.section_markers[0].name, "Marker 0");

        let saved_song = load_song(&song_dir).expect("song json should load");
        assert_eq!(saved_song.section_markers.len(), 1);
        assert_eq!(saved_song.section_markers[0].name, "Marker 0");
        assert_eq!(saved_song.section_markers[0].start_seconds, 2.0);
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
        let song_view = session
            .song_view()
            .expect("song view should build")
            .expect("song summary should exist");

        assert_eq!(snapshot.project_revision, song_view.project_revision);
        assert!(song_view.clips.is_empty());

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
        let updated_clip = session
            .song_view()
            .expect("song view should build")
            .expect("song summary should exist")
            .clips
            .into_iter()
            .find(|clip| clip.id == "clip_1")
            .expect("updated clip should exist");

        assert!(snapshot.project_revision > 0);
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
        let snapshot_song = session
            .song_view()
            .expect("song view should build")
            .expect("song summary should exist");
        assert_eq!(snapshot.project_revision, snapshot_song.project_revision);
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
            .schedule_marker_jump("section_1", JumpTrigger::AfterBars(6), &audio)
            .expect("jump should schedule");

        let pending_jump = scheduled_snapshot
            .pending_marker_jump
            .expect("pending jump should exist");
        assert_eq!(pending_jump.target_marker_id, "section_1");
        assert_eq!(pending_jump.target_marker_name, "Intro");
        assert_eq!(pending_jump.trigger, "after_bars:6");

        let cancelled_snapshot = session
            .cancel_marker_jump(&audio)
            .expect("jump should cancel");
        assert!(cancelled_snapshot.pending_marker_jump.is_none());
    }

    #[test]
    fn scheduling_an_immediate_section_jump_updates_position_and_current_marker() {
        let mut session = DesktopSession::default();
        session
            .engine
            .load_song(demo_song_with_section())
            .expect("song should load into engine");
        session.engine.seek(0.0).expect("seek should work");

        let audio = crate::audio_runtime::AudioController::default();
        let snapshot = session
            .schedule_marker_jump("section_1", JumpTrigger::Immediate, &audio)
            .expect("immediate jump should execute");

        assert!(snapshot.pending_marker_jump.is_none());
        assert_eq!(snapshot.position_seconds, 1.0);
        assert_eq!(
            snapshot
                .current_marker
                .expect("current marker should exist")
                .name,
            "Intro"
        );
    }

    #[test]
    fn transport_only_updates_preserve_pending_jump_when_target_survives() {
        let root = tempdir().expect("temp dir should exist");
        let song_dir = create_song_folder(root.path(), "transport-only-pending-jump")
            .expect("song dir should exist");
        fs::create_dir_all(song_dir.join("audio")).expect("audio dir should exist");

        let mut session = DesktopSession::default();
        session.song_dir = Some(song_dir);
        session
            .engine
            .load_song(demo_song_with_two_sections())
            .expect("song should load into engine");

        let audio = crate::audio_runtime::AudioController::default();
        session
            .schedule_marker_jump("section_2", JumpTrigger::NextMarker, &audio)
            .expect("jump should schedule");

        let snapshot = session
            .update_section_marker("section_1", "Intro B", 1.0, &audio)
            .expect("section marker update should succeed");

        let pending_jump = snapshot
            .pending_marker_jump
            .expect("pending jump should survive transport-only change");
        assert_eq!(pending_jump.target_marker_id, "section_2");
        assert_eq!(pending_jump.target_marker_name, "Verse");
        assert_eq!(pending_jump.trigger, "next_marker");
    }

    #[test]
    fn transport_only_updates_drop_pending_jump_when_target_moves_before_position() {
        let root = tempdir().expect("temp dir should exist");
        let song_dir = create_song_folder(root.path(), "transport-only-stale-pending-jump")
            .expect("song dir should exist");
        fs::create_dir_all(song_dir.join("audio")).expect("audio dir should exist");

        let mut session = DesktopSession::default();
        session.song_dir = Some(song_dir);
        session
            .engine
            .load_song(demo_song_with_two_sections())
            .expect("song should load into engine");

        let audio = crate::audio_runtime::AudioController::default();
        session.seek(5.0, &audio).expect("seek should work");
        session
            .schedule_marker_jump("section_2", JumpTrigger::NextMarker, &audio)
            .expect("jump should schedule");

        let snapshot = session
            .update_section_marker("section_2", "Verse", 3.0, &audio)
            .expect("section marker update should succeed");

        assert_eq!(snapshot.position_seconds, 5.0);
        assert!(snapshot.pending_marker_jump.is_none());
    }

    #[test]
    fn deleting_target_section_clears_pending_jump() {
        let root = tempdir().expect("temp dir should exist");
        let song_dir = create_song_folder(root.path(), "delete-target-pending-jump")
            .expect("song dir should exist");
        fs::create_dir_all(song_dir.join("audio")).expect("audio dir should exist");

        let mut session = DesktopSession::default();
        session.song_dir = Some(song_dir);
        session
            .engine
            .load_song(demo_song_with_two_sections())
            .expect("song should load into engine");

        let audio = crate::audio_runtime::AudioController::default();
        session
            .schedule_marker_jump("section_2", JumpTrigger::AfterBars(2), &audio)
            .expect("jump should schedule");

        let snapshot = session
            .delete_section_marker("section_2", &audio)
            .expect("target section marker should delete");

        assert!(snapshot.pending_marker_jump.is_none());
    }

    #[test]
    fn seek_to_pending_jump_target_clears_pending_jump_in_snapshot() {
        let mut session = DesktopSession::default();
        session
            .engine
            .load_song(demo_song_with_two_sections())
            .expect("song should load into engine");
        session.engine.seek(1.5).expect("seek should work");

        let audio = crate::audio_runtime::AudioController::default();
        session
            .schedule_marker_jump("section_2", JumpTrigger::NextMarker, &audio)
            .expect("jump should schedule");

        let snapshot = session
            .seek(4.0, &audio)
            .expect("seek should clear pending jump");

        assert_eq!(snapshot.position_seconds, 4.0);
        assert!(snapshot.pending_marker_jump.is_none());
        assert_eq!(
            snapshot.transport_clock.last_seek_position_seconds,
            Some(4.0)
        );
    }

    #[test]
    fn updating_a_section_marker_updates_song_json_and_snapshot() {
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
            .update_section_marker("section_1", "Verse", 2.5, &audio)
            .expect("section marker should update");
        let updated_section = session
            .song_view()
            .expect("song view should build")
            .expect("song summary should exist")
            .section_markers
            .into_iter()
            .find(|section| section.id == "section_1")
            .expect("updated section should exist");
        assert!(snapshot.project_revision > 0);
        assert_eq!(updated_section.name, "Verse");
        assert_eq!(updated_section.start_seconds, 2.5);

        let saved_song = load_song(&song_dir).expect("song json should load");
        assert_eq!(saved_song.section_markers[0].name, "Verse");
        assert_eq!(saved_song.section_markers[0].start_seconds, 2.5);
    }

    #[test]
    fn deleting_a_section_marker_updates_song_json_and_snapshot() {
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
            .delete_section_marker("section_1", &audio)
            .expect("section marker should delete");
        let song_view = session
            .song_view()
            .expect("song view should build")
            .expect("song summary should exist");

        assert_eq!(snapshot.project_revision, song_view.project_revision);
        assert!(song_view.section_markers.is_empty());

        let saved_song = load_song(&song_dir).expect("song json should load");
        assert!(saved_song.section_markers.is_empty());
    }
}
