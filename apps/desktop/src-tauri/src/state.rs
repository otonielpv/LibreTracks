use std::{
    collections::{HashMap, HashSet},
    fs,
    path::Path,
    path::PathBuf,
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Instant, SystemTime, UNIX_EPOCH},
};

use libretracks_audio::{AudioEngine, JumpTrigger, PlaybackState, TransitionType, VampMode};
use libretracks_core::{
    Clip, Marker, OutputBus, Song, SongRegion, TempoMarker, TimeSignatureMarker, Track, TrackKind,
};
use libretracks_project::{
    append_wav_files_to_song, generate_waveform_summary,
    import_song_package as import_song_package_into_project, import_wav_files_to_library,
    load_song_from_file, load_waveform_summary, read_audio_metadata, save_song_to_file,
    waveform_file_path, ImportOperationMetrics, ImportedSong, PackageLibraryAssetEntry,
    ProjectError, ProjectImportRequest, WaveformSummary, SONG_FILE_NAME,
};
use rfd::FileDialog;
use serde::{Deserialize, Serialize};
use serde_json::to_vec;
use tauri::{AppHandle, Emitter, Manager};

use crate::audio_runtime::{AudioController, PlaybackStartReason};
use crate::error::DesktopError;
use crate::midi::MidiManager;
use crate::models::view::{
    active_vamp_to_summary, empty_musical_position_summary, marker_to_summary,
    musical_position_summary, pending_jump_to_summary, song_to_view, waveform_key_for_file_path,
    waveform_summary_to_dto,
};
use crate::models::{
    DesktopPerformanceSnapshot, LibraryAssetSummary, SongView, TransportClockSummary,
    TransportDriftSummary, TransportSnapshot, WaveformSummaryDto,
};
use crate::settings::AppSettings;

const LIBRARY_MANIFEST_FILE_NAME: &str = "library.json";
const LIBRARY_IMPORT_PROGRESS_EVENT: &str = "library:import-progress";
pub const WAVEFORM_READY_EVENT: &str = "waveform:ready";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LibraryImportProgressEvent {
    percent: u8,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaveformReadyEvent {
    pub song_dir: String,
    pub waveform_key: String,
    pub summary: WaveformSummaryDto,
}

#[derive(Debug, Clone)]
pub struct WaveformJob {
    pub app: tauri::AppHandle,
    pub song_dir: PathBuf,
    pub waveform_key: String,
}

#[derive(Debug, Clone)]
pub struct WaveformGenerationQueue {
    sender: mpsc::Sender<WaveformJob>,
    in_flight: Arc<Mutex<HashSet<String>>>,
}

pub struct DesktopState {
    pub audio: AudioController,
    pub midi: MidiManager,
    pub waveform_jobs: WaveformGenerationQueue,
    pub session: Mutex<DesktopSession>,
}

impl Default for DesktopState {
    fn default() -> Self {
        Self {
            audio: AudioController::default(),
            midi: MidiManager::default(),
            waveform_jobs: WaveformGenerationQueue::default(),
            session: Mutex::new(DesktopSession::default()),
        }
    }
}

pub struct DesktopSession {
    pub engine: AudioEngine,
    transport_clock: TransportClock,
    pub song_dir: Option<PathBuf>,
    song_file_path: Option<PathBuf>,
    last_drift_sample: Option<TransportDriftSummary>,
    project_revision: u64,
    undo_stack: Vec<Song>,
    redo_stack: Vec<Song>,
    live_history_anchor: Option<Song>,
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
            last_drift_sample: None,
            project_revision: 0,
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
            live_history_anchor: None,
            waveform_cache: WaveformMemoryCache::default(),
            perf_metrics: DesktopPerformanceMetrics::default(),
        }
    }
}

impl WaveformGenerationQueue {
    pub fn enqueue(
        &self,
        app: AppHandle,
        song_dir: PathBuf,
        waveform_key: String,
    ) -> Result<(), DesktopError> {
        let job_key = waveform_job_key(&song_dir, &waveform_key);
        {
            let mut in_flight = self
                .in_flight
                .lock()
                .map_err(|_| DesktopError::StatePoisoned)?;
            if !in_flight.insert(job_key.clone()) {
                return Ok(());
            }
        }

        if self
            .sender
            .send(WaveformJob {
                app,
                song_dir,
                waveform_key,
            })
            .is_err()
        {
            if let Ok(mut in_flight) = self.in_flight.lock() {
                in_flight.remove(&job_key);
            }
            return Err(DesktopError::AudioCommand(
                "waveform generation worker is not available".into(),
            ));
        }

        Ok(())
    }
}

impl Default for WaveformGenerationQueue {
    fn default() -> Self {
        let (sender, receiver) = mpsc::channel::<WaveformJob>();
        let in_flight = Arc::new(Mutex::new(HashSet::new()));
        let worker_in_flight = Arc::clone(&in_flight);

        thread::spawn(move || {
            while let Ok(job) = receiver.recv() {
                let job_key = waveform_job_key(&job.song_dir, &job.waveform_key);
                process_waveform_job(job);
                if let Ok(mut in_flight) = worker_in_flight.lock() {
                    in_flight.remove(&job_key);
                }
            }
        });

        Self { sender, in_flight }
    }
}

fn waveform_job_key(song_dir: &Path, waveform_key: &str) -> String {
    format!("{}\n{waveform_key}", song_dir.to_string_lossy())
}

fn process_waveform_job(job: WaveformJob) {
    let WaveformJob {
        app,
        song_dir,
        waveform_key,
    } = job;

    let summary_result = generate_waveform_summary(&song_dir, &waveform_key);

    match summary_result {
        Ok(summary) => {
            let summary = waveform_summary_to_dto(&waveform_key, &summary);
            emit_waveform_ready(&app, &song_dir, &waveform_key, summary);
        }
        Err(error) => {
            eprintln!(
                "[libretracks-waveform] failed to generate waveform for {}: {error}",
                waveform_key
            );
        }
    }
}

fn emit_waveform_ready(
    app: &AppHandle,
    song_dir: &Path,
    waveform_key: &str,
    summary: WaveformSummaryDto,
) {
    let payload = WaveformReadyEvent {
        song_dir: song_dir.to_string_lossy().replace('\\', "/"),
        waveform_key: waveform_key.to_string(),
        summary,
    };
    if let Err(error) = app.emit(WAVEFORM_READY_EVENT, payload) {
        eprintln!("[libretracks-waveform] failed to emit waveform ready event: {error}");
    }
}

impl TransportClock {
    fn current_position(&self, playback_state: PlaybackState) -> f64 {
        let unclamped_position = if playback_state == PlaybackState::Playing {
            self.anchor_position_seconds + self.elapsed_since_anchor()
        } else {
            self.anchor_position_seconds
        };

        unclamped_position.max(0.0)
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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateClipRequest {
    pub track_id: String,
    pub file_path: String,
    pub timeline_start_seconds: f64,
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
pub(crate) struct WaveformMemoryCache {
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
            .add_filter("LibreTracks Session", &["ltsession"])
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
        write_library_manifest(&song_dir, &[])?;

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

    pub fn resolve_missing_file(
        &mut self,
        old_path: &str,
        new_path: &str,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let song_dir = self.song_dir.clone().ok_or(DesktopError::NoSongLoaded)?;
        let song_file_path = self.current_song_file_path()?;
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;

        for clip in song.clips.iter_mut() {
            if clip.file_path == old_path {
                clip.file_path = new_path.to_string();
            }
        }

        if let Some(mut manifest) = read_library_manifest(&song_dir)? {
            for file_path in manifest.file_paths.iter_mut() {
                if file_path == old_path {
                    *file_path = new_path.to_string();
                }
            }
            for asset in manifest.assets.iter_mut() {
                if asset.file_path == old_path {
                    asset.file_path = new_path.to_string();
                }
            }
            let manifest_json = serde_json::to_vec_pretty(&manifest)
                .map_err(|error| DesktopError::AudioCommand(error.to_string()))?;
            fs::write(library_manifest_path(&song_dir), manifest_json)?;
        }

        let old_waveform_path = waveform_file_path(&song_dir, old_path);
        let new_waveform_path = waveform_file_path(&song_dir, new_path);
        if old_waveform_path.exists() && old_waveform_path != new_waveform_path {
            if let Some(parent) = new_waveform_path.parent() {
                fs::create_dir_all(parent)?;
            }
            if new_waveform_path.exists() {
                fs::remove_file(&new_waveform_path)?;
            }
            fs::rename(&old_waveform_path, &new_waveform_path)?;
        }

        self.waveform_cache.remove(&song_dir, old_path);
        self.persist_song_update(song, audio, AudioChangeImpact::StructureRebuild, true)?;

        let save_started_at = Instant::now();
        let saved_song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        save_song_to_file(&song_file_path, &saved_song)?;
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
            .add_filter("LibreTracks Session", &["ltsession"])
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
        let library_assets = list_library_assets(&source_song_dir, Some(&song))?;
        let library_file_paths = library_assets
            .iter()
            .map(|asset| asset.file_path.clone())
            .collect::<Vec<_>>();
        copy_project_audio_files(
            &source_song_dir,
            &target_song_dir,
            &song,
            &library_file_paths,
        )?;
        write_library_manifest_assets(&target_song_dir, &library_assets)?;
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
            .add_filter("LibreTracks Session", &["ltsession"])
            .set_title("Selecciona session.ltsession")
            .pick_file();

        let Some(song_file) = song_file else {
            return Ok(None);
        };

        let song_dir = song_file
            .parent()
            .map(std::path::Path::to_path_buf)
            .ok_or_else(|| {
                DesktopError::AudioCommand("session.ltsession must live inside a folder".into())
            })?;
        let song = load_song_from_file(&song_file)?;

        self.load_song_from_path(song, song_dir, audio)?;
        self.song_file_path = Some(song_file);

        Ok(Some(self.snapshot()))
    }

    pub fn import_song_from_dialog(
        &mut self,
        _app: &AppHandle,
        audio: &AudioController,
    ) -> Result<Option<TransportSnapshot>, DesktopError> {
        let package_file = FileDialog::new()
            .add_filter("LibreTracks Package", &["ltpkg"])
            .set_title("Selecciona un paquete .ltpkg")
            .pick_file();

        let Some(package_file) = package_file else {
            return Ok(None);
        };

        self.song_dir.as_ref().ok_or(DesktopError::NoSongLoaded)?;
        self.engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;

        let package_path = package_file.to_string_lossy().into_owned();
        let inserted = self.import_song_package(&package_path, self.current_position(), audio)?;

        Ok(Some(inserted))
    }

    pub fn import_library_assets_from_dialog(
        &mut self,
        app: &AppHandle,
    ) -> Result<Option<Vec<LibraryAssetSummary>>, DesktopError> {
        let files = FileDialog::new()
            .add_filter("Audio", &["wav", "mp3", "flac", "m4a", "aac", "ogg"])
            .set_title("Importar audio a la libreria")
            .pick_files();

        let Some(files) = files else {
            return Ok(None);
        };

        emit_library_import_progress(
            app,
            10,
            format!("Preparando {} archivo(s) para importar...", files.len()),
        );

        let assets = self.import_audio_files_into_library(&files, |percent, message| {
            emit_library_import_progress(app, percent, message);
        })?;
        emit_library_import_progress(app, 85, "Actualizando libreria de la sesion...".into());
        emit_library_import_progress(
            app,
            100,
            format!(
                "Importacion completada. {} asset(s) disponibles.",
                assets.len()
            ),
        );
        Ok(Some(assets))
    }

    fn import_audio_files_into_current_song(
        &mut self,
        files: &[PathBuf],
        audio: &AudioController,
        mut on_progress: impl FnMut(u8, String),
    ) -> Result<TransportSnapshot, DesktopError> {
        let song_dir = self.song_dir.clone().ok_or(DesktopError::NoSongLoaded)?;
        let song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        let updated_song = append_wav_files_to_song(&song_dir, &song, files, &mut on_progress)?;
        self.record_import_metrics(&updated_song.metrics);
        self.persist_song_update(
            updated_song.song,
            audio,
            AudioChangeImpact::StructureRebuild,
            true,
        )?;
        Ok(self.snapshot())
    }

    fn import_audio_files_into_library(
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
        if !Path::new(&normalized_file_path).is_absolute() && audio_file_path.exists() {
            fs::remove_file(&audio_file_path)?;
        }

        let waveform_path = waveform_file_path(&song_dir, &normalized_file_path);
        if waveform_path.exists() {
            fs::remove_file(waveform_path)?;
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
        waveform_jobs: &WaveformGenerationQueue,
        app: &AppHandle,
    ) -> Result<Vec<WaveformSummaryDto>, DesktopError> {
        self.load_waveforms_internal(waveform_keys, Some((waveform_jobs, app)))
    }

    fn load_waveforms_internal(
        &mut self,
        waveform_keys: &[String],
        background_generation: Option<(&WaveformGenerationQueue, &AppHandle)>,
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

            match self.load_waveform_summary_cached(&song_dir, waveform_key, false) {
                Ok(summary) => summaries.push(waveform_summary_to_dto(waveform_key, summary)),
                Err(DesktopError::Project(ProjectError::Io(_)))
                | Err(DesktopError::Project(ProjectError::InvalidWaveformSummary(_))) => {
                    if let Some((waveform_jobs, app)) = background_generation {
                        waveform_jobs.enqueue(
                            app.clone(),
                            song_dir.clone(),
                            waveform_key.clone(),
                        )?;
                    }
                }
                Err(error) => return Err(error),
            }
        }

        Ok(summaries)
    }

    pub fn load_library_waveforms(
        &mut self,
        file_paths: &[String],
        waveform_jobs: &WaveformGenerationQueue,
        app: &AppHandle,
    ) -> Result<Vec<WaveformSummaryDto>, DesktopError> {
        let song_dir = self.song_dir.clone().ok_or(DesktopError::NoSongLoaded)?;
        let valid_library_paths = collect_library_file_paths(&song_dir, self.engine.song())?
            .into_iter()
            .collect::<std::collections::HashSet<_>>();
        let mut summaries = Vec::new();

        for file_path in file_paths {
            let normalized_path = normalize_library_file_path(file_path);
            if !valid_library_paths.contains(&normalized_path) {
                continue;
            }

            match self.load_waveform_summary_cached(&song_dir, &normalized_path, false) {
                Ok(summary) => summaries.push(waveform_summary_to_dto(&normalized_path, summary)),
                Err(DesktopError::Project(ProjectError::Io(_)))
                | Err(DesktopError::Project(ProjectError::InvalidWaveformSummary(_))) => {
                    waveform_jobs.enqueue(
                        app.clone(),
                        song_dir.clone(),
                        normalized_path.clone(),
                    )?;
                }
                Err(error) => return Err(error),
            }
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

    pub fn update_audio_settings(
        &mut self,
        next_settings: AppSettings,
        audio: &AudioController,
    ) -> Result<AppSettings, DesktopError> {
        let previous_settings = audio.current_settings()?;
        let device_changed =
            previous_settings.selected_output_device != next_settings.selected_output_device;
        let midi_changed =
            previous_settings.selected_midi_device != next_settings.selected_midi_device;
        let split_changed =
            previous_settings.split_stereo_enabled != next_settings.split_stereo_enabled;
        let metronome_enabled_changed =
            previous_settings.metronome_enabled != next_settings.metronome_enabled;
        let metronome_volume_changed =
            (previous_settings.metronome_volume - next_settings.metronome_volume).abs()
                > f64::EPSILON;

        if !device_changed
            && !midi_changed
            && !split_changed
            && !metronome_enabled_changed
            && !metronome_volume_changed
        {
            return Ok(next_settings);
        }

        audio.apply_settings(next_settings.clone())?;

        if device_changed && self.engine.playback_state() == PlaybackState::Playing {
            self.restart_audio(audio, PlaybackStartReason::TransportResync)?;
            self.transport_clock
                .reanchor_playing(self.engine.position_seconds());
            self.capture_transport_drift_sample(
                audio,
                "audio_settings",
                self.current_position(),
                self.engine.position_seconds(),
            );
        }

        Ok(next_settings)
    }

    pub fn play(&mut self, audio: &AudioController) -> Result<TransportSnapshot, DesktopError> {
        self.sync_position(audio)?;
        let song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;

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
        self.capture_transport_drift_sample(
            audio,
            "play",
            self.current_position(),
            self.engine.position_seconds(),
        );

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
            self.capture_transport_drift_sample(
                audio,
                "seek",
                self.current_position(),
                self.engine.position_seconds(),
            );
            return Ok(self.snapshot());
        }

        self.transport_clock.seek_to(self.engine.position_seconds());
        self.capture_transport_drift_sample(
            audio,
            "seek",
            self.current_position(),
            self.engine.position_seconds(),
        );

        Ok(self.snapshot())
    }

    pub fn schedule_marker_jump(
        &mut self,
        target_marker_id: &str,
        trigger: JumpTrigger,
        transition: TransitionType,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        self.sync_position(audio)?;
        let was_playing = self.engine.playback_state() == PlaybackState::Playing;

        self.engine
            .schedule_marker_jump(target_marker_id, trigger.clone(), transition.clone())?;

        if trigger == JumpTrigger::Immediate && transition == TransitionType::Instant {
            if was_playing {
                self.reposition_audio(audio, PlaybackStartReason::ImmediateJump)?;
                self.transport_clock
                    .note_jump_while_playing(self.engine.position_seconds());
            } else {
                self.transport_clock.seek_to(self.engine.position_seconds());
            }
            self.capture_transport_drift_sample(
                audio,
                "jump",
                self.current_position(),
                self.engine.position_seconds(),
            );
        }

        Ok(self.snapshot())
    }

    pub fn schedule_region_jump(
        &mut self,
        target_region_id: &str,
        trigger: JumpTrigger,
        transition: TransitionType,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        self.sync_position(audio)?;
        let was_playing = self.engine.playback_state() == PlaybackState::Playing;

        self.engine
            .schedule_region_jump(target_region_id, trigger.clone(), transition.clone())?;

        if trigger == JumpTrigger::Immediate && transition == TransitionType::Instant {
            if was_playing {
                self.reposition_audio(audio, PlaybackStartReason::ImmediateJump)?;
                self.transport_clock
                    .note_jump_while_playing(self.engine.position_seconds());
            } else {
                self.transport_clock.seek_to(self.engine.position_seconds());
            }
            self.capture_transport_drift_sample(
                audio,
                "jump",
                self.current_position(),
                self.engine.position_seconds(),
            );
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

    pub fn toggle_vamp(
        &mut self,
        mode: VampMode,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        self.sync_position(audio)?;
        self.engine.toggle_vamp(mode)?;
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

        self.persist_song_update(song, audio, AudioChangeImpact::TimelineWindow, true)?;

        Ok(self.snapshot())
    }

    pub fn move_clip_live(
        &mut self,
        clip_id: &str,
        timeline_start_seconds: f64,
        audio: &AudioController,
    ) -> Result<(), DesktopError> {
        self.sync_position(audio)?;
        self.capture_live_history_anchor();

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

        self.persist_song_update_internal(
            song,
            audio,
            AudioChangeImpact::TimelineWindow,
            false,
            false,
        )?;

        Ok(())
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
        self.persist_song_update(song, audio, AudioChangeImpact::StructureRebuild, true)?;

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

        self.persist_song_update(song, audio, AudioChangeImpact::TimelineWindow, true)?;

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

        self.persist_song_update(song, audio, AudioChangeImpact::StructureRebuild, true)?;

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
        let start_seconds = start_seconds.max(0.0);
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

        self.persist_song_update(song, audio, AudioChangeImpact::TransportOnly, true)?;

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

        let start_seconds = start_seconds.max(0.0);

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

        self.persist_song_update(song, audio, AudioChangeImpact::TransportOnly, true)?;

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

        self.persist_song_update(song, audio, AudioChangeImpact::TransportOnly, true)?;

        Ok(self.snapshot())
    }

    pub fn create_song_region(
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
        let (start_seconds, end_seconds) =
            sanitize_region_bounds(&song, start_seconds, end_seconds)?;
        let region_index = song.regions.len();
        let region_name = audio
            .current_settings()
            .ok()
            .and_then(|settings| settings.locale)
            .map(|locale| locale.to_ascii_lowercase())
            .map(|locale| match locale.as_str() {
                "es" => format!("Canción {region_index}"),
                _ => format!("Song {region_index}"),
            })
            .unwrap_or_else(|| format!("Song {region_index}"));
        let region = SongRegion {
            id: format!("region_{}_{}", timestamp_suffix(), region_index),
            name: region_name,
            start_seconds,
            end_seconds,
        };

        replace_song_region_range(&mut song, region);
        self.persist_song_update(song, audio, AudioChangeImpact::TransportOnly, true)?;

        Ok(self.snapshot())
    }

    pub fn update_song_region(
        &mut self,
        region_id: &str,
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
                "region name must not be empty".into(),
            ));
        }

        let existing_region = song
            .regions
            .iter()
            .find(|region| region.id == region_id)
            .cloned()
            .ok_or_else(|| DesktopError::RegionNotFound(region_id.to_string()))?;
        let (start_seconds, end_seconds) =
            sanitize_region_bounds(&song, start_seconds, end_seconds)?;
        let updated_region = SongRegion {
            id: existing_region.id,
            name: trimmed_name.to_string(),
            start_seconds,
            end_seconds,
        };

        replace_song_region_range(&mut song, updated_region);
        self.persist_song_update(song, audio, AudioChangeImpact::TransportOnly, true)?;

        Ok(self.snapshot())
    }

    pub fn delete_song_region(
        &mut self,
        region_id: &str,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        let region_index = song
            .regions
            .iter()
            .position(|region| region.id == region_id)
            .ok_or_else(|| DesktopError::RegionNotFound(region_id.to_string()))?;

        song.regions.remove(region_index);
        sort_song_regions(&mut song.regions);
        self.persist_song_update(song, audio, AudioChangeImpact::TransportOnly, true)?;

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

        self.persist_song_update(song, audio, AudioChangeImpact::TransportOnly, true)?;

        Ok(self.snapshot())
    }

    pub fn update_song_tempo(
        &mut self,
        bpm: f64,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        if !bpm.is_finite() || bpm < 20.0 || bpm > 300.0 {
            return Err(DesktopError::AudioCommand(
                "song bpm must be between 20.0 and 300.0".into(),
            ));
        }

        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        song.bpm = bpm;

        self.persist_song_update(song, audio, AudioChangeImpact::TransportOnly, true)?;

        Ok(self.snapshot())
    }

    pub fn upsert_song_tempo_marker(
        &mut self,
        start_seconds: f64,
        bpm: f64,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        if !bpm.is_finite() || bpm < 20.0 || bpm > 300.0 {
            return Err(DesktopError::AudioCommand(
                "song bpm marker must be between 20.0 and 300.0".into(),
            ));
        }

        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        let clamped_start_seconds = start_seconds.max(0.0);

        if clamped_start_seconds <= 0.0001 {
            song.bpm = bpm;
        } else if let Some(existing_marker) = song
            .tempo_markers
            .iter_mut()
            .find(|marker| (marker.start_seconds - clamped_start_seconds).abs() < 0.0001)
        {
            existing_marker.bpm = bpm;
        } else {
            song.tempo_markers.push(TempoMarker {
                id: format!("tempo_marker_{}", timestamp_suffix()),
                start_seconds: clamped_start_seconds,
                bpm,
            });
            song.tempo_markers.sort_by(|left, right| {
                left.start_seconds
                    .partial_cmp(&right.start_seconds)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
        }

        self.persist_song_update(song, audio, AudioChangeImpact::TransportOnly, true)?;

        Ok(self.snapshot())
    }

    pub fn delete_song_tempo_marker(
        &mut self,
        marker_id: &str,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        let marker_index = song
            .tempo_markers
            .iter()
            .position(|marker| marker.id == marker_id)
            .ok_or_else(|| DesktopError::AudioCommand("tempo marker not found".into()))?;
        song.tempo_markers.remove(marker_index);

        self.persist_song_update(song, audio, AudioChangeImpact::TransportOnly, true)?;

        Ok(self.snapshot())
    }

    pub fn update_song_time_signature(
        &mut self,
        signature: &str,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        validate_time_signature(signature)?;

        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        song.time_signature = signature.to_string();

        self.persist_song_update(song, audio, AudioChangeImpact::TransportOnly, true)?;

        Ok(self.snapshot())
    }

    pub fn upsert_song_time_signature_marker(
        &mut self,
        start_seconds: f64,
        signature: &str,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        validate_time_signature(signature)?;

        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        let clamped_start_seconds = start_seconds.max(0.0);

        if clamped_start_seconds <= 0.0001 {
            song.time_signature = signature.to_string();
        } else if let Some(existing_marker) = song
            .time_signature_markers
            .iter_mut()
            .find(|marker| (marker.start_seconds - clamped_start_seconds).abs() < 0.0001)
        {
            existing_marker.signature = signature.to_string();
        } else {
            song.time_signature_markers.push(TimeSignatureMarker {
                id: format!("time_signature_marker_{}", timestamp_suffix()),
                start_seconds: clamped_start_seconds,
                signature: signature.to_string(),
            });
            song.time_signature_markers.sort_by(|left, right| {
                left.start_seconds
                    .partial_cmp(&right.start_seconds)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
        }

        self.persist_song_update(song, audio, AudioChangeImpact::TransportOnly, true)?;

        Ok(self.snapshot())
    }

    pub fn delete_song_time_signature_marker(
        &mut self,
        marker_id: &str,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        let marker_index = song
            .time_signature_markers
            .iter()
            .position(|marker| marker.id == marker_id)
            .ok_or_else(|| DesktopError::AudioCommand("time signature marker not found".into()))?;
        song.time_signature_markers.remove(marker_index);

        self.persist_song_update(song, audio, AudioChangeImpact::TransportOnly, true)?;

        Ok(self.snapshot())
    }

    pub fn import_song_package(
        &mut self,
        package_path: &str,
        insert_at_seconds: f64,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let song_dir = self.song_dir.clone().ok_or(DesktopError::NoSongLoaded)?;
        let song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        let imported = import_song_package_into_project(
            &song_dir,
            &song,
            Path::new(package_path),
            insert_at_seconds,
        )?;
        let mut library_assets = list_library_assets(&song_dir, Some(&imported.song))?;
        merge_package_library_meta(
            &song_dir,
            &mut library_assets,
            &imported.library_meta,
            Some(&imported.package_title),
        )?;
        write_library_manifest_assets(&song_dir, &library_assets)?;
        self.persist_song_update(
            imported.song,
            audio,
            AudioChangeImpact::StructureRebuild,
            true,
        )?;
        Ok(self.snapshot())
    }

    pub fn import_song_package_from_bytes(
        &mut self,
        package_bytes: &[u8],
        insert_at_seconds: f64,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let song_dir = self.song_dir.clone().ok_or(DesktopError::NoSongLoaded)?;
        let song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        let imported = libretracks_project::import_song_package_from_bytes(
            &song_dir,
            &song,
            package_bytes,
            insert_at_seconds,
        )?;
        let mut library_assets = list_library_assets(&song_dir, Some(&imported.song))?;
        merge_package_library_meta(
            &song_dir,
            &mut library_assets,
            &imported.library_meta,
            Some(&imported.package_title),
        )?;
        write_library_manifest_assets(&song_dir, &library_assets)?;
        self.persist_song_update(
            imported.song,
            audio,
            AudioChangeImpact::StructureRebuild,
            true,
        )?;
        Ok(self.snapshot())
    }

    pub fn import_song_package_from_base64(
        &mut self,
        package_base64: &str,
        insert_at_seconds: f64,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let song_dir = self.song_dir.clone().ok_or(DesktopError::NoSongLoaded)?;
        let song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        let imported = libretracks_project::import_song_package_from_base64(
            &song_dir,
            &song,
            package_base64,
            insert_at_seconds,
        )?;
        let mut library_assets = list_library_assets(&song_dir, Some(&imported.song))?;
        merge_package_library_meta(
            &song_dir,
            &mut library_assets,
            &imported.library_meta,
            Some(&imported.package_title),
        )?;
        write_library_manifest_assets(&song_dir, &library_assets)?;
        self.persist_song_update(
            imported.song,
            audio,
            AudioChangeImpact::StructureRebuild,
            true,
        )?;
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
        self.persist_song_update(song, audio, AudioChangeImpact::StructureRebuild, true)?;

        Ok(self.snapshot())
    }

    pub fn create_clip(
        &mut self,
        track_id: &str,
        file_path: &str,
        timeline_start_seconds: f64,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        self.create_clips_batch(
            &[CreateClipRequest {
                track_id: track_id.to_string(),
                file_path: file_path.to_string(),
                timeline_start_seconds,
            }],
            audio,
        )
    }

    pub fn create_clips_batch(
        &mut self,
        requests: &[CreateClipRequest],
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        if requests.is_empty() {
            return Ok(self.snapshot());
        }

        let song_dir = self.song_dir.clone().ok_or(DesktopError::NoSongLoaded)?;
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;

        for request in requests {
            append_clip_to_song(&mut song, &song_dir, request)?;
        }
        refresh_song_duration(&mut song);

        self.persist_song_update(song, audio, AudioChangeImpact::StructureRebuild, true)?;

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
        self.persist_song_update(song, audio, AudioChangeImpact::StructureRebuild, true)?;

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
        self.sync_position(audio)?;

        self.push_history_entry();
        self.redo_stack.clear();

        self.update_loaded_track(track_id, name, volume, pan, muted, solo)?;
        if volume.is_some() || pan.is_some() || muted.is_some() || solo.is_some() {
            let loaded_song = self.engine.song().ok_or(DesktopError::NoSongLoaded)?;
            audio.ensure_live_track(loaded_song, track_id)?;
            audio.update_live_track_mix(track_id, volume, pan, muted, solo)?;
        }

        self.perf_metrics.song_save_millis = 0;
        self.project_revision = self.project_revision.saturating_add(1);

        Ok(self.snapshot())
    }

    pub fn update_track_mix_live(
        &mut self,
        track_id: &str,
        volume: Option<f64>,
        pan: Option<f64>,
        muted: Option<bool>,
        solo: Option<bool>,
        audio: &AudioController,
    ) -> Result<(), DesktopError> {
        self.capture_live_history_anchor();
        self.update_loaded_track(track_id, None, volume, pan, muted, solo)?;
        let loaded_song = self.engine.song().ok_or(DesktopError::NoSongLoaded)?;
        audio.ensure_live_track(loaded_song, track_id)?;
        audio.update_live_track_mix(track_id, volume, pan, muted, solo)?;

        Ok(())
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

        self.persist_song_update(song, audio, AudioChangeImpact::StructureRebuild, true)?;

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
        self.persist_song_update(song, audio, AudioChangeImpact::StructureRebuild, true)?;

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
        self.last_drift_sample = None;
        self.undo_stack.clear();
        self.redo_stack.clear();
        self.live_history_anchor = None;
        self.engine.load_song(song)?;
        self.project_revision = self.project_revision.saturating_add(1);
        let loaded_song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        audio.sync_live_mix(&loaded_song)?;
        self.prime_waveform_cache(&song_dir, &loaded_song)?;

        Ok(())
    }

    fn persist_song_update(
        &mut self,
        song: Song,
        audio: &AudioController,
        impact: AudioChangeImpact,
        bump_revision: bool,
    ) -> Result<(), DesktopError> {
        self.persist_song_update_internal(song, audio, impact, true, bump_revision)
    }

    fn persist_song_update_internal(
        &mut self,
        song: Song,
        audio: &AudioController,
        impact: AudioChangeImpact,
        record_history: bool,
        bump_revision: bool,
    ) -> Result<(), DesktopError> {
        self.sync_position(audio)?;

        if record_history {
            self.push_history_entry();
            self.redo_stack.clear();
        }

        let playback_state = self.engine.playback_state();
        let position_seconds = self.current_position();
        let pending_jump = self.engine.pending_marker_jump().cloned();
        let song_dir = self.song_dir.clone().ok_or(DesktopError::NoSongLoaded)?;

        if playback_state == PlaybackState::Playing
            && matches!(
                impact,
                AudioChangeImpact::TimelineWindow | AudioChangeImpact::StructureRebuild
            )
        {
            audio.replace_song_buffers(&song_dir, &song)?;
        }

        self.perf_metrics.song_save_millis = 0;
        self.engine.load_song(song)?;
        if bump_revision {
            self.project_revision = self.project_revision.saturating_add(1);
        }
        self.prune_waveform_cache_for_current_song();

        let restored_position = position_seconds;
        self.engine.seek(restored_position)?;

        let loaded_song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        audio.sync_live_mix(&loaded_song)?;

        if let Some(pending_jump) = pending_jump {
            if loaded_song
                .marker_by_id(&pending_jump.target_marker_id)
                .is_some()
            {
                if restored_position < pending_jump.execute_at_seconds {
                    self.engine.schedule_marker_jump(
                        &pending_jump.target_marker_id,
                        pending_jump.trigger,
                        pending_jump.transition,
                    )?;
                }
            }
        }

        match playback_state {
            PlaybackState::Playing => {
                self.engine.play()?;
                match impact {
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

    fn capture_live_history_anchor(&mut self) {
        if self.live_history_anchor.is_none() {
            self.live_history_anchor = self.engine.song().cloned();
        }
    }

    fn push_history_entry(&mut self) {
        let history_entry = self
            .live_history_anchor
            .take()
            .or_else(|| self.engine.song().cloned());

        if let Some(song) = history_entry {
            self.undo_stack.push(song);
            if self.undo_stack.len() > 50 {
                self.undo_stack.remove(0);
            }
        }
    }

    fn update_loaded_track(
        &mut self,
        track_id: &str,
        name: Option<&str>,
        volume: Option<f64>,
        pan: Option<f64>,
        muted: Option<bool>,
        solo: Option<bool>,
    ) -> Result<(), DesktopError> {
        let track = self
            .engine
            .song_mut()?
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

        Ok(())
    }

    pub fn undo_action(
        &mut self,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        self.live_history_anchor = None;
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
            true,
        )?;

        Ok(self.snapshot())
    }

    pub fn redo_action(
        &mut self,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        self.live_history_anchor = None;
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
            true,
        )?;

        Ok(self.snapshot())
    }

    fn current_position(&self) -> f64 {
        self.transport_clock
            .current_position(self.engine.playback_state())
    }

    fn sync_position(&mut self, audio: &AudioController) -> Result<(), DesktopError> {
        if self.engine.playback_state() != PlaybackState::Playing {
            return Ok(());
        }

        let elapsed = self.transport_clock.elapsed_since_anchor();
        let previous_position = self.engine.position_seconds();
        let wrapped_by_vamp = self
            .engine
            .active_vamp()
            .map(|active_vamp| previous_position + elapsed >= active_vamp.end_seconds)
            .unwrap_or(false);
        let (advanced_position, jump_executed) = self.engine.advance_transport(elapsed)?;

        if let Some(duration_seconds) = self.engine.take_pending_fade_out_request() {
            audio.start_master_fade(0.0, duration_seconds)?;
            self.transport_clock.reanchor_playing(advanced_position);
            return Ok(());
        }

        if let Some(duration_seconds) = self.engine.pending_fade_duration_seconds() {
            if elapsed >= duration_seconds {
                if let Some(target_position) = self.engine.complete_pending_fade_jump()? {
                    self.reposition_audio(audio, PlaybackStartReason::TransportResync)?;
                    audio.start_master_fade(1.0, duration_seconds)?;
                    self.transport_clock
                        .note_jump_while_playing(target_position);
                    self.capture_transport_drift_sample(
                        audio,
                        "jump",
                        target_position,
                        target_position,
                    );
                    return Ok(());
                }
            }

            self.transport_clock.reanchor_playing(advanced_position);
            return Ok(());
        }

        if jump_executed || wrapped_by_vamp {
            self.reposition_audio(audio, PlaybackStartReason::TransportResync)?;
            self.transport_clock
                .note_jump_while_playing(advanced_position);
            self.capture_transport_drift_sample(
                audio,
                "jump",
                advanced_position,
                advanced_position,
            );
        } else {
            self.transport_clock.reanchor_playing(advanced_position);
        }

        Ok(())
    }

    fn capture_transport_drift_sample(
        &mut self,
        audio: &AudioController,
        event: &str,
        transport_position_seconds: f64,
        engine_position_seconds: f64,
    ) {
        let runtime_snapshot = audio.debug_snapshot().ok();
        let runtime_estimated_position_seconds = runtime_snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.playhead.estimated_position_seconds);
        let runtime_running = runtime_snapshot
            .as_ref()
            .map(|snapshot| snapshot.playhead.running)
            .unwrap_or(false);
        let transport_minus_engine_seconds = transport_position_seconds - engine_position_seconds;
        let runtime_minus_transport_seconds = runtime_estimated_position_seconds
            .map(|runtime_position| runtime_position - transport_position_seconds);
        let runtime_minus_engine_seconds = runtime_estimated_position_seconds
            .map(|runtime_position| runtime_position - engine_position_seconds);
        let mut max_observed_delta_seconds = transport_minus_engine_seconds.abs();
        if let Some(delta) = runtime_minus_transport_seconds {
            max_observed_delta_seconds = max_observed_delta_seconds.max(delta.abs());
        }
        if let Some(delta) = runtime_minus_engine_seconds {
            max_observed_delta_seconds = max_observed_delta_seconds.max(delta.abs());
        }

        self.last_drift_sample = Some(TransportDriftSummary {
            event: event.to_string(),
            transport_position_seconds,
            engine_position_seconds,
            runtime_estimated_position_seconds,
            runtime_running,
            transport_minus_engine_seconds,
            runtime_minus_transport_seconds,
            runtime_minus_engine_seconds,
            max_observed_delta_seconds,
        });
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
            active_vamp: self.engine.active_vamp().map(active_vamp_to_summary),
            musical_position: self
                .engine
                .song()
                .map(|song| musical_position_summary(song, self.current_position()))
                .unwrap_or_else(empty_musical_position_summary),
            transport_clock: self.transport_clock.summary(),
            last_drift_sample: self.last_drift_sample.clone(),
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
            let _ = self.load_waveform_summary_cached(song_dir, &waveform_key, false);
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
        key: None,
        bpm: 120.0,
        time_signature: "4/4".into(),
        duration_seconds: 60.0,
        tempo_markers: vec![],
        time_signature_markers: vec![],
        regions: vec![],
        tracks: vec![],
        clips: vec![],
        section_markers: vec![],
    }
}

fn emit_library_import_progress(app: &AppHandle, percent: u8, message: String) {
    let payload = LibraryImportProgressEvent { percent, message };

    if let Err(error) = app.emit(LIBRARY_IMPORT_PROGRESS_EVENT, payload) {
        eprintln!("[libretracks-library] failed to emit import progress: {error}");
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LibraryManifest {
    #[serde(default)]
    file_paths: Vec<String>,
    #[serde(default)]
    assets: Vec<LibraryManifestAssetEntry>,
    #[serde(default)]
    folders: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LibraryManifestAssetEntry {
    file_path: String,
    #[serde(default)]
    folder_path: Option<String>,
}

fn library_manifest_path(song_dir: &Path) -> PathBuf {
    song_dir.join(LIBRARY_MANIFEST_FILE_NAME)
}

fn normalize_library_file_path(file_path: &str) -> String {
    file_path.replace('\\', "/")
}

fn normalize_library_folder_path(folder_path: &str) -> Option<String> {
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

fn is_library_folder_in_branch(folder_path: &str, branch_root: &str) -> bool {
    folder_path == branch_root || folder_path.starts_with(&format!("{branch_root}/"))
}

fn rename_library_folder_branch(
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

fn read_library_manifest(song_dir: &Path) -> Result<Option<LibraryManifest>, DesktopError> {
    let manifest_path = library_manifest_path(song_dir);
    if !manifest_path.exists() {
        return Ok(None);
    }

    let manifest = serde_json::from_slice::<LibraryManifest>(&fs::read(&manifest_path)?)
        .map_err(|error| DesktopError::AudioCommand(error.to_string()))?;
    Ok(Some(manifest))
}

fn write_library_manifest(song_dir: &Path, file_paths: &[String]) -> Result<(), DesktopError> {
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

fn write_library_manifest_assets(
    song_dir: &Path,
    assets: &[LibraryAssetSummary],
) -> Result<(), DesktopError> {
    let folders = read_library_manifest(song_dir)?
        .map(|manifest| manifest.folders)
        .unwrap_or_default();
    write_library_manifest_state(song_dir, assets, &folders)
}

fn merge_package_library_meta(
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

fn write_library_manifest_state(
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

fn list_library_folders(
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

    let mut file_paths = Vec::new();
    for entry in fs::read_dir(audio_dir)? {
        let entry = entry?;
        let path = entry.path();
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

        let file_name = entry.file_name().to_string_lossy().to_string();
        file_paths.push(format!("audio/{file_name}"));
    }

    file_paths.sort();
    Ok(file_paths)
}

fn collect_library_file_paths(
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

fn list_library_assets(
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
        let is_missing = !Path::new(&file_path).exists();
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

fn validate_time_signature(signature: &str) -> Result<(), DesktopError> {
    let (numerator, denominator) = signature
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
    Ok(())
}

fn playback_state_label(state: PlaybackState) -> &'static str {
    match state {
        PlaybackState::Empty => "empty",
        PlaybackState::Stopped => "stopped",
        PlaybackState::Playing => "playing",
        PlaybackState::Paused => "paused",
    }
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
    pub(crate) fn source_duration_seconds(&self, waveform_key: &str) -> Option<f64> {
        self.entries
            .get(waveform_key)
            .map(|cached| cached.summary.duration_seconds)
    }

    fn reset(&mut self, song_dir: &Path) {
        self.song_dir = Some(song_dir.to_path_buf());
        self.entries.clear();
    }

    fn reset_if_song_changed(&mut self, song_dir: &Path) {
        if self.song_dir.as_deref() != Some(song_dir) {
            self.reset(song_dir);
        }
    }

    fn remove(&mut self, song_dir: &Path, waveform_key: &str) {
        if self.song_dir.as_deref() == Some(song_dir) {
            self.entries.remove(waveform_key);
        }
    }
}

fn build_waveform_cache_token(
    song_dir: &Path,
    waveform_key: &str,
) -> Result<WaveformCacheToken, DesktopError> {
    let audio_metadata = fs::metadata(resolve_audio_file_path(song_dir, waveform_key))?;
    let waveform_metadata = fs::metadata(waveform_file_path(song_dir, waveform_key))?;

    Ok(WaveformCacheToken {
        audio_size: audio_metadata.len(),
        audio_modified_millis: modified_millis(&audio_metadata)?,
        waveform_size: waveform_metadata.len(),
        waveform_modified_millis: modified_millis(&waveform_metadata)?,
    })
}

fn resolve_audio_file_path(song_dir: &Path, file_path: &str) -> PathBuf {
    let path = Path::new(file_path);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        song_dir.join(path)
    }
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

    let audio_metadata = read_audio_metadata(resolve_audio_file_path(song_dir, clip_file_path))?;
    if source_start_seconds + duration_seconds > audio_metadata.duration_seconds + 0.0001 {
        return Err(DesktopError::InvalidClipRange);
    }

    Ok(())
}

fn append_clip_to_song(
    song: &mut Song,
    song_dir: &Path,
    request: &CreateClipRequest,
) -> Result<(), DesktopError> {
    let track = song
        .tracks
        .iter()
        .find(|track| track.id == request.track_id)
        .ok_or_else(|| DesktopError::TrackNotFound(request.track_id.clone()))?;
    if track.kind == TrackKind::Folder {
        return Err(DesktopError::AudioCommand(
            "clip cannot target a folder track".into(),
        ));
    }

    let normalized_file_path = request.file_path.replace('\\', "/");
    let wav_metadata =
        read_audio_metadata(resolve_audio_file_path(song_dir, &normalized_file_path))?;
    let clip_id = format!("clip_{}_{}", timestamp_suffix(), song.clips.len());

    song.clips.push(Clip {
        id: clip_id,
        track_id: request.track_id.clone(),
        file_path: normalized_file_path,
        timeline_start_seconds: request.timeline_start_seconds.max(0.0),
        source_start_seconds: 0.0,
        duration_seconds: wav_metadata.duration_seconds,
        gain: 1.0,
        fade_in_seconds: None,
        fade_out_seconds: None,
    });

    Ok(())
}

fn refresh_song_duration(song: &mut Song) {
    let max_clip_end = song
        .clips
        .iter()
        .map(|clip| clip.timeline_start_seconds + clip.duration_seconds)
        .fold(0.0_f64, f64::max);

    song.duration_seconds = max_clip_end.max(1.0);
}

fn sanitize_region_bounds(
    _song: &Song,
    start_seconds: f64,
    end_seconds: f64,
) -> Result<(f64, f64), DesktopError> {
    if !start_seconds.is_finite() || !end_seconds.is_finite() {
        return Err(DesktopError::AudioCommand(
            "region bounds must be finite".into(),
        ));
    }

    let clamped_start_seconds = start_seconds.max(0.0);
    let clamped_end_seconds = end_seconds.max(clamped_start_seconds + 0.001);
    if clamped_end_seconds <= clamped_start_seconds {
        return Err(DesktopError::AudioCommand(
            "region end must be greater than region start".into(),
        ));
    }

    Ok((clamped_start_seconds, clamped_end_seconds))
}

fn replace_song_region_range(song: &mut Song, replacement: SongRegion) {
    let mut next_regions = Vec::with_capacity(song.regions.len() + 2);
    let mut fragment_index = 0usize;

    for region in &song.regions {
        if region.end_seconds <= replacement.start_seconds
            || region.start_seconds >= replacement.end_seconds
        {
            next_regions.push(region.clone());
            continue;
        }

        if region.start_seconds < replacement.start_seconds {
            fragment_index += 1;
            next_regions.push(SongRegion {
                id: format!(
                    "{}_fragment_{}_{}",
                    region.id,
                    timestamp_suffix(),
                    fragment_index
                ),
                name: region.name.clone(),
                start_seconds: region.start_seconds,
                end_seconds: replacement.start_seconds,
            });
        }

        if region.end_seconds > replacement.end_seconds {
            fragment_index += 1;
            next_regions.push(SongRegion {
                id: format!(
                    "{}_fragment_{}_{}",
                    region.id,
                    timestamp_suffix(),
                    fragment_index
                ),
                name: region.name.clone(),
                start_seconds: replacement.end_seconds,
                end_seconds: region.end_seconds,
            });
        }
    }

    next_regions.push(replacement);
    sort_song_regions(&mut next_regions);
    song.regions = next_regions;
}

fn sort_song_regions(regions: &mut Vec<SongRegion>) {
    regions.sort_by(|left, right| {
        left.start_seconds
            .partial_cmp(&right.start_seconds)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                left.end_seconds
                    .partial_cmp(&right.end_seconds)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    });
}

pub(crate) fn slugify(value: &str) -> String {
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
    format!("{fallback}.ltsession")
}

fn copy_project_audio_files(
    source_song_dir: &Path,
    target_song_dir: &Path,
    song: &Song,
    library_file_paths: &[String],
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

    for file_path in library_file_paths {
        let relative_path = Path::new(file_path);
        if !copied_relative_paths.insert(relative_path.to_path_buf()) {
            continue;
        }

        let source_path = source_song_dir.join(relative_path);
        if !source_path.exists() {
            continue;
        }

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

    use libretracks_audio::{JumpTrigger, PlaybackState, TransitionType};
    use libretracks_core::{
        Clip, Marker, OutputBus, Song, SongRegion, TempoMarker, Track, TrackKind,
    };
    use libretracks_project::{
        create_song_folder, generate_waveform_summary, load_song, save_song, SONG_FILE_NAME,
    };
    use tempfile::tempdir;

    use crate::models::view::{musical_position_summary, song_to_view};
    use crate::models::LibraryAssetSummary;

    use super::{
        build_empty_song, list_library_assets, write_library_manifest,
        write_library_manifest_assets, CreateClipRequest, DesktopSession, TransportClock,
        WaveformMemoryCache,
    };

    fn demo_song() -> Song {
        Song {
            id: "song_move".into(),
            title: "Move Demo".into(),
            artist: None,
            key: None,
            bpm: 120.0,
            time_signature: "4/4".into(),
            duration_seconds: 12.0,
            tempo_markers: vec![],
            time_signature_markers: vec![],
            regions: vec![SongRegion {
                id: "region_1".into(),
                name: "Move Demo".into(),
                start_seconds: 0.0,
                end_seconds: 12.0,
            }],
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

    #[test]
    fn musical_position_summary_uses_tempo_markers_beyond_song_duration() {
        let mut song = demo_song();
        song.duration_seconds = 8.0;
        song.bpm = 120.0;
        song.tempo_markers = vec![TempoMarker {
            id: "tempo_far".into(),
            start_seconds: 12.0,
            bpm: 60.0,
        }];

        let summary = musical_position_summary(&song, 13.0);

        assert_eq!(summary.bar_number, 7);
        assert_eq!(summary.beat_in_bar, 2);
        assert_eq!(summary.sub_beat, 0);
        assert_eq!(summary.display, "7.2.00");
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

    fn demo_song_with_region_changes_and_sections() -> Song {
        let mut song = demo_song();
        song.duration_seconds = 18.0;
        song.regions = vec![
            SongRegion {
                id: "region_1".into(),
                name: "Intro".into(),
                start_seconds: 0.0,
                end_seconds: 8.0,
            },
            SongRegion {
                id: "region_2".into(),
                name: "Bridge".into(),
                start_seconds: 8.0,
                end_seconds: 14.0,
            },
            SongRegion {
                id: "region_3".into(),
                name: "Outro".into(),
                start_seconds: 14.0,
                end_seconds: 18.0,
            },
        ];
        song.clips[0].duration_seconds = 18.0;
        song.section_markers = vec![
            Marker {
                id: "section_1".into(),
                name: "Intro".into(),
                start_seconds: 1.0,
                digit: Some(1),
            },
            Marker {
                id: "section_2".into(),
                name: "Outro".into(),
                start_seconds: 15.0,
                digit: Some(2),
            },
        ];
        song
    }

    fn write_silent_test_wav(path: &Path, duration_seconds: u32) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("wav parent dir should exist");
        }
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
        save_song(&song_dir, &song).expect("song should save");

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
            key: None,
            bpm: 120.0,
            time_signature: "4/4".into(),
            duration_seconds: 12.0,
            tempo_markers: vec![],
            time_signature_markers: vec![],
            regions: vec![SongRegion {
                id: "region_1".into(),
                name: "Hierarchy Demo".into(),
                start_seconds: 0.0,
                end_seconds: 12.0,
            }],
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
        let running_position = clock.current_position(PlaybackState::Playing);
        assert!(running_position > 1.25);

        clock.pause_at(running_position);
        thread::sleep(Duration::from_millis(20));

        let paused_position = clock.current_position(PlaybackState::Paused);
        assert!((paused_position - running_position).abs() < 0.02);
    }

    #[test]
    fn transport_clock_seek_reanchors_without_accumulating_old_elapsed_time() {
        let mut clock = TransportClock::default();
        clock.start_from(0.5);

        thread::sleep(Duration::from_millis(12));
        let advanced_position = clock.current_position(PlaybackState::Playing);
        assert!(advanced_position > 0.5);

        clock.seek_to(3.0);
        thread::sleep(Duration::from_millis(12));

        let seek_position = clock.current_position(PlaybackState::Paused);
        assert!((seek_position - 3.0).abs() < 0.001);

        clock.start_from(seek_position);
        thread::sleep(Duration::from_millis(12));
        let resumed_position = clock.current_position(PlaybackState::Playing);
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
            .schedule_marker_jump(
                "section_1",
                JumpTrigger::Immediate,
                TransitionType::Instant,
                &audio,
            )
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

        let drift = snapshot
            .last_drift_sample
            .expect("seek should capture drift sample");
        assert_eq!(drift.event, "seek");
        assert_eq!(drift.transport_position_seconds, 2.75);
        assert_eq!(drift.engine_position_seconds, 2.75);
        assert_eq!(drift.transport_minus_engine_seconds, 0.0);
    }

    #[test]
    fn pause_freezes_position_after_real_playback() {
        let mut session = session_with_song_dir("pause-freeze-demo", demo_song());
        let audio = crate::audio_runtime::AudioController::default();

        let playing_snapshot = session.play(&audio).expect("play should succeed");
        assert_eq!(playing_snapshot.playback_state, "playing");

        let drift = playing_snapshot
            .last_drift_sample
            .expect("play should capture drift sample");
        assert_eq!(drift.event, "play");
        assert!(drift.runtime_running);
        assert!(drift.max_observed_delta_seconds < 0.05);

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
        assert!(debug_snapshot.command_count >= 4);
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

        let drift = snapshot
            .last_drift_sample
            .expect("seek should capture drift sample while playing");
        assert_eq!(drift.event, "seek");
        assert!(drift.runtime_running);
        assert!(drift.runtime_estimated_position_seconds.unwrap_or_default() >= 3.5);
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
    fn song_to_view_preserves_track_ids_and_parent_ids_verbatim() {
        let song = Song {
            id: "song_ids".into(),
            title: "ID Audit".into(),
            artist: None,
            key: None,
            bpm: 120.0,
            time_signature: "4/4".into(),
            duration_seconds: 8.0,
            tempo_markers: vec![],
            time_signature_markers: vec![],
            regions: vec![SongRegion {
                id: "region_1".into(),
                name: "ID Audit".into(),
                start_seconds: 0.0,
                end_seconds: 8.0,
            }],
            tracks: vec![
                Track {
                    id: "folder_main".into(),
                    name: "Folder".into(),
                    kind: TrackKind::Folder,
                    parent_track_id: None,
                    volume: 1.0,
                    pan: 0.0,
                    muted: false,
                    solo: false,
                    output_bus_id: OutputBus::Main.id(),
                },
                Track {
                    id: "track-drums_01".into(),
                    name: "Drums".into(),
                    kind: TrackKind::Audio,
                    parent_track_id: Some("folder_main".into()),
                    volume: 1.0,
                    pan: 0.0,
                    muted: false,
                    solo: false,
                    output_bus_id: OutputBus::Main.id(),
                },
            ],
            clips: vec![],
            section_markers: vec![],
        };

        let view = song_to_view(&song, &WaveformMemoryCache::default(), 7);

        assert_eq!(view.tracks[0].id, "folder_main");
        assert_eq!(view.tracks[0].parent_track_id, None);
        assert_eq!(view.tracks[1].id, "track-drums_01");
        assert_eq!(
            view.tracks[1].parent_track_id.as_deref(),
            Some("folder_main")
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
            .schedule_marker_jump(
                "section_3",
                JumpTrigger::NextMarker,
                TransitionType::Instant,
                &audio,
            )
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

        let drift = snapshot
            .last_drift_sample
            .expect("jump should capture drift sample");
        assert_eq!(drift.event, "jump");
        assert!(drift.runtime_running);
        assert!(drift.transport_position_seconds >= 8.0);
        assert!(drift.max_observed_delta_seconds < 0.1);

        let debug_snapshot = audio
            .debug_snapshot()
            .expect("debug snapshot should succeed");
        assert_eq!(
            debug_snapshot.playhead.last_start_reason.as_deref(),
            Some("transport_resync")
        );
    }

    #[test]
    fn playback_continues_after_song_end_is_reached() {
        let mut session = session_with_song_dir("song-end-demo", demo_song());
        let audio = crate::audio_runtime::AudioController::default();

        session.seek(11.98, &audio).expect("seek should succeed");
        session.play(&audio).expect("play should succeed");

        thread::sleep(Duration::from_millis(60));
        let snapshot = session
            .snapshot_with_sync(&audio)
            .expect("sync should keep transport running past song end");

        assert_eq!(snapshot.playback_state, "playing");
        assert!(snapshot.position_seconds > 12.0);
        assert!(snapshot.transport_clock.running);
        assert!(snapshot.transport_clock.anchor_position_seconds > 12.0);
        assert_eq!(
            snapshot
                .last_drift_sample
                .as_ref()
                .map(|drift| drift.event.as_str()),
            Some("play")
        );

        let debug_snapshot = audio
            .debug_snapshot()
            .expect("debug snapshot should succeed");
        assert!(debug_snapshot.playhead.running);
    }

    #[test]
    fn moving_a_clip_stays_in_memory_until_save() {
        let root = tempdir().expect("temp dir should exist");
        let song_dir = create_song_folder(root.path(), "move-demo").expect("song dir should exist");
        fs::create_dir_all(song_dir.join("audio")).expect("audio dir should exist");
        save_song(&song_dir, &demo_song()).expect("song should save");

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
        assert_eq!(saved_song.clips[0].timeline_start_seconds, 1.0);
        assert_eq!(session.engine.playback_state(), PlaybackState::Stopped);
    }

    #[test]
    fn live_track_mix_updates_skip_disk_and_project_revision() {
        let mut session = session_with_song_dir("live-mix-demo", demo_song());
        let song_dir = session
            .song_dir
            .clone()
            .expect("song dir should exist for loaded session");
        save_song(&song_dir, &demo_song()).expect("seed song should save");

        let audio = crate::audio_runtime::AudioController::default();
        let initial_revision = session.snapshot().project_revision;

        session
            .update_track_mix_live(
                "track_1",
                Some(0.61),
                Some(-0.22),
                Some(true),
                Some(true),
                &audio,
            )
            .expect("live mix update should succeed");

        let updated_song = session
            .song_view()
            .expect("song view should build")
            .expect("song view should exist");
        let updated_track = updated_song
            .tracks
            .into_iter()
            .find(|track| track.id == "track_1")
            .expect("updated track should exist");

        assert_eq!(session.snapshot().project_revision, initial_revision);
        assert_eq!(updated_track.volume, 0.61);
        assert_eq!(updated_track.pan, -0.22);
        assert!(updated_track.muted);
        assert!(updated_track.solo);

        let saved_song = load_song(&song_dir).expect("song json should load");
        let saved_track = saved_song
            .tracks
            .into_iter()
            .find(|track| track.id == "track_1")
            .expect("saved track should exist");
        assert_eq!(saved_track.volume, 1.0);
        assert_eq!(saved_track.pan, 0.0);
        assert!(!saved_track.muted);
        assert!(!saved_track.solo);
    }

    #[test]
    fn live_track_mix_commit_undoes_in_single_step() {
        let mut session = session_with_song_dir("live-mix-undo-demo", demo_song());
        let audio = crate::audio_runtime::AudioController::default();

        session
            .update_track_mix_live(
                "track_1",
                Some(0.61),
                Some(-0.22),
                Some(true),
                Some(true),
                &audio,
            )
            .expect("live mix update should succeed");
        assert_eq!(session.undo_stack.len(), 0);

        session
            .update_track(
                "track_1",
                None,
                Some(0.61),
                Some(-0.22),
                Some(true),
                Some(true),
                &audio,
            )
            .expect("mix commit should succeed");
        assert_eq!(session.undo_stack.len(), 1);

        session.undo_action(&audio).expect("undo should succeed");
        let track = session
            .song_view()
            .expect("song view should build")
            .expect("song view should exist")
            .tracks
            .into_iter()
            .find(|track| track.id == "track_1")
            .expect("track should exist after undo");

        assert_eq!(track.volume, 1.0);
        assert_eq!(track.pan, 0.0);
        assert!(!track.muted);
        assert!(!track.solo);
    }

    #[test]
    fn live_clip_move_commit_undoes_in_single_step() {
        let mut session = session_with_song_dir("live-clip-move-demo", demo_song());
        let audio = crate::audio_runtime::AudioController::default();
        let initial_revision = session.snapshot().project_revision;

        session
            .move_clip_live("clip_1", 3.0, &audio)
            .expect("first live move should succeed");
        session
            .move_clip_live("clip_1", 4.5, &audio)
            .expect("second live move should succeed");
        assert_eq!(session.snapshot().project_revision, initial_revision);
        assert_eq!(session.undo_stack.len(), 0);

        session
            .move_clip("clip_1", 6.0, &audio)
            .expect("clip commit should succeed");
        assert_eq!(session.undo_stack.len(), 1);

        session.undo_action(&audio).expect("undo should succeed");
        let clip = session
            .song_view()
            .expect("song view should build")
            .expect("song should exist")
            .clips
            .into_iter()
            .find(|clip| clip.id == "clip_1")
            .expect("clip should exist after undo");

        assert!((clip.timeline_start_seconds - 1.0).abs() < 0.0001);
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
            .import_audio_files_into_current_song(&[imported_click], &audio, |_, _| {})
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
        assert_eq!(saved_song.tracks.len(), 1);
        assert_eq!(saved_song.clips.len(), 1);
    }

    #[test]
    fn importing_library_assets_keeps_the_current_arrangement_unchanged() {
        let mut session = session_with_song_dir("library-import-demo", demo_song());
        let imports_root = tempdir().expect("temp dir should exist");
        let imported_click = imports_root.path().join("click.wav");
        write_silent_test_wav(&imported_click, 6);

        let before = session
            .song_view()
            .expect("song view should build")
            .expect("song should be loaded");
        let assets = session
            .import_audio_files_into_library(&[imported_click], |_, _| {})
            .expect("library import should succeed");
        let after = session
            .song_view()
            .expect("song view should build")
            .expect("song should stay loaded");

        assert_eq!(before.tracks.len(), after.tracks.len());
        assert_eq!(before.clips.len(), after.clips.len());
        assert!(assets
            .iter()
            .any(|asset| asset.file_path == "audio/click.wav"));
    }

    #[test]
    fn create_clip_adds_a_library_asset_to_an_existing_audio_track() {
        let mut session = session_with_song_dir("create-clip-demo", demo_song());
        let audio = crate::audio_runtime::AudioController::default();

        session
            .create_clip("track_1", "audio/test.wav", 4.0, &audio)
            .expect("clip should be created");

        let song_view = session
            .song_view()
            .expect("song view should build")
            .expect("song should exist");
        assert_eq!(song_view.clips.len(), 2);
        assert!(song_view.clips.iter().any(|clip| {
            clip.track_id == "track_1"
                && clip.file_path == "audio/test.wav"
                && (clip.timeline_start_seconds - 4.0).abs() < 0.0001
        }));

        let saved_song = load_song(
            session
                .song_dir
                .as_ref()
                .expect("song dir should remain available"),
        )
        .expect("song file should save");
        assert_eq!(saved_song.clips.len(), 1);
    }

    #[test]
    fn create_clips_batch_persists_multiple_clips_with_one_song_update() {
        let mut session = session_with_song_dir("create-clips-batch-demo", demo_song());
        let audio = crate::audio_runtime::AudioController::default();
        let song_dir = session.song_dir.clone().expect("song dir should exist");
        write_silent_test_wav(&song_dir.join("audio").join("test-2.wav"), 5);

        let snapshot = session
            .create_clips_batch(
                &[
                    CreateClipRequest {
                        track_id: "track_1".into(),
                        file_path: "audio/test.wav".into(),
                        timeline_start_seconds: 4.0,
                    },
                    CreateClipRequest {
                        track_id: "track_1".into(),
                        file_path: "audio/test-2.wav".into(),
                        timeline_start_seconds: 9.5,
                    },
                ],
                &audio,
            )
            .expect("clips batch should succeed");

        assert_eq!(snapshot.project_revision, 1);

        let song_view = session
            .song_view()
            .expect("song view should build")
            .expect("song should exist");
        assert_eq!(song_view.clips.len(), 3);
        assert!(song_view.clips.iter().any(|clip| {
            clip.file_path == "audio/test.wav" && (clip.timeline_start_seconds - 4.0).abs() < 0.0001
        }));
        assert!(song_view.clips.iter().any(|clip| {
            clip.file_path == "audio/test-2.wav"
                && (clip.timeline_start_seconds - 9.5).abs() < 0.0001
                && (clip.duration_seconds - 5.0).abs() < 0.0001
        }));

        let saved_song = load_song(&song_dir).expect("song file should stay unchanged until save");
        assert_eq!(saved_song.clips.len(), 1);
    }

    #[test]
    fn get_library_assets_reads_audio_files_from_the_session_audio_directory() {
        let root = tempdir().expect("temp dir should exist");
        let root_path = root.keep();
        let song_dir =
            create_song_folder(&root_path, "library-assets-demo").expect("song dir should exist");
        let imported_a = song_dir.join("audio").join("alpha.wav");
        let imported_b = song_dir.join("audio").join("beta.wav");
        write_silent_test_wav(&imported_b, 4);
        write_silent_test_wav(&imported_a, 2);

        let mut session = DesktopSession::default();
        session.song_dir = Some(song_dir);

        let assets = session
            .get_library_assets()
            .expect("library assets should load");

        assert_eq!(assets.len(), 2);
        assert_eq!(assets[0].file_name, "alpha.wav");
        assert_eq!(assets[0].file_path, "audio/alpha.wav");
        assert!((assets[0].duration_seconds - 2.0).abs() < 0.001);
        assert_eq!(assets[1].file_name, "beta.wav");
    }

    #[test]
    fn get_library_assets_preserves_folder_from_manifest() {
        let root = tempdir().expect("temp dir should exist");
        let root_path = root.keep();
        let song_dir =
            create_song_folder(&root_path, "library-bpm-demo").expect("song dir should exist");
        let audio_path = song_dir.join("audio").join("click.wav");
        write_silent_test_wav(&audio_path, 2);
        write_library_manifest_assets(
            &song_dir,
            &[LibraryAssetSummary {
                file_name: "click.wav".into(),
                file_path: "audio/click.wav".into(),
                duration_seconds: 2.0,
                is_missing: false,
                folder_path: Some("Percusion/Clicks".into()),
            }],
        )
        .expect("manifest should save");

        let assets = list_library_assets(&song_dir, None).expect("library assets should load");

        assert_eq!(assets.len(), 1);
        assert_eq!(assets[0].file_path, "audio/click.wav");
        assert_eq!(assets[0].folder_path.as_deref(), Some("Percusion/Clicks"));
    }

    #[test]
    fn library_manifest_overrides_audio_directory_scanning_for_empty_songs() {
        let root = tempdir().expect("temp dir should exist");
        let root_path = root.keep();
        let song_dir =
            create_song_folder(&root_path, "library-manifest-demo").expect("song dir should exist");
        write_silent_test_wav(&song_dir.join("audio").join("carry-over.wav"), 3);
        write_library_manifest(&song_dir, &[]).expect("manifest should save");

        let assets = list_library_assets(
            &song_dir,
            Some(&build_empty_song("song_1".into(), "Nueva".into())),
        )
        .expect("library assets should load");

        assert!(assets.is_empty());
    }

    #[test]
    fn delete_library_asset_removes_unused_files_from_the_song_library() {
        let mut session = session_with_song_dir(
            "library-delete-demo",
            build_empty_song("song_1".into(), "Nueva".into()),
        );
        let song_dir = session.song_dir.clone().expect("song dir should exist");
        let audio_path = song_dir.join("audio").join("remove-me.wav");
        write_silent_test_wav(&audio_path, 5);
        write_library_manifest(&song_dir, &["audio/remove-me.wav".to_string()])
            .expect("manifest should save");

        let assets = session
            .delete_library_asset("audio/remove-me.wav")
            .expect("delete should succeed");

        assert!(assets.is_empty());
        assert!(!audio_path.exists());
    }

    #[test]
    fn delete_library_asset_rejects_files_used_by_existing_clips() {
        let mut session = session_with_song_dir("library-delete-used-demo", demo_song());

        let error = session
            .delete_library_asset("audio/test.wav")
            .expect_err("delete should be rejected");

        assert!(error.to_string().contains("already used on the timeline"));
    }

    #[test]
    fn create_library_folder_persists_empty_virtual_folders() {
        let mut session = session_with_song_dir(
            "library-create-folder-demo",
            build_empty_song("song_1".into(), "Nueva".into()),
        );

        let folders = session
            .create_library_folder("Sets/Intro")
            .expect("folder should be created");

        assert_eq!(folders, vec!["Sets/Intro".to_string()]);
        assert_eq!(
            session
                .get_library_folders()
                .expect("folders should load after creation"),
            vec!["Sets/Intro".to_string()]
        );
    }

    #[test]
    fn move_library_asset_updates_virtual_folder_without_moving_files() {
        let mut session = session_with_song_dir(
            "library-move-folder-demo",
            build_empty_song("song_1".into(), "Nueva".into()),
        );
        let song_dir = session.song_dir.clone().expect("song dir should exist");
        let audio_path = song_dir.join("audio").join("move-me.wav");
        write_silent_test_wav(&audio_path, 3);
        write_library_manifest_assets(
            &song_dir,
            &[LibraryAssetSummary {
                file_name: "move-me.wav".into(),
                file_path: "audio/move-me.wav".into(),
                duration_seconds: 3.0,
                is_missing: false,
                folder_path: None,
            }],
        )
        .expect("manifest should save");

        session
            .create_library_folder("Set A")
            .expect("folder should be created");
        let assets = session
            .move_library_asset("audio/move-me.wav", Some("Set A".into()))
            .expect("asset should move logically");

        assert_eq!(assets.len(), 1);
        assert_eq!(assets[0].folder_path.as_deref(), Some("Set A"));
        assert!(audio_path.exists());
        assert_eq!(
            session
                .get_library_folders()
                .expect("folders should still exist"),
            vec!["Set A".to_string()]
        );
    }

    #[test]
    fn rename_library_folder_updates_assets_and_nested_folders() {
        let mut session = session_with_song_dir(
            "library-rename-folder-demo",
            build_empty_song("song_1".into(), "Nueva".into()),
        );
        let song_dir = session.song_dir.clone().expect("song dir should exist");
        let audio_path = song_dir.join("audio").join("move-me.wav");
        write_silent_test_wav(&audio_path, 3);
        write_library_manifest_assets(
            &song_dir,
            &[LibraryAssetSummary {
                file_name: "move-me.wav".into(),
                file_path: "audio/move-me.wav".into(),
                duration_seconds: 3.0,
                is_missing: false,
                folder_path: Some("Set A/Sub".into()),
            }],
        )
        .expect("manifest should save");
        session
            .create_library_folder("Set A")
            .expect("parent folder should exist");
        session
            .create_library_folder("Set A/Sub")
            .expect("child folder should exist");

        let assets = session
            .rename_library_folder("Set A", "Set B")
            .expect("folder should rename");

        assert_eq!(assets[0].folder_path.as_deref(), Some("Set B/Sub"));
        assert_eq!(
            session.get_library_folders().expect("folders should load"),
            vec!["Set B".to_string(), "Set B/Sub".to_string()]
        );
    }

    #[test]
    fn delete_library_folder_moves_assets_back_to_root() {
        let mut session = session_with_song_dir(
            "library-delete-folder-demo",
            build_empty_song("song_1".into(), "Nueva".into()),
        );
        let song_dir = session.song_dir.clone().expect("song dir should exist");
        let audio_path = song_dir.join("audio").join("move-me.wav");
        write_silent_test_wav(&audio_path, 3);
        write_library_manifest_assets(
            &song_dir,
            &[LibraryAssetSummary {
                file_name: "move-me.wav".into(),
                file_path: "audio/move-me.wav".into(),
                duration_seconds: 3.0,
                is_missing: false,
                folder_path: Some("Set A/Sub".into()),
            }],
        )
        .expect("manifest should save");
        session
            .create_library_folder("Set A")
            .expect("parent folder should exist");
        session
            .create_library_folder("Set A/Sub")
            .expect("child folder should exist");

        let assets = session
            .delete_library_folder("Set A")
            .expect("folder should delete");

        assert_eq!(assets[0].folder_path, None);
        assert!(session
            .get_library_folders()
            .expect("folders should load")
            .is_empty());
    }

    #[test]
    fn build_empty_song_starts_with_an_empty_arrangement_at_120_bpm() {
        let song = super::build_empty_song("song_empty".into(), "Nueva Cancion".into());

        assert!(song.regions.is_empty());
        assert_eq!(song.bpm, 120.0);
        assert_eq!(song.time_signature, "4/4");
        assert!(song.tracks.is_empty());
        assert!(song.clips.is_empty());
        assert!(song.section_markers.is_empty());
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
            .map(|clip| (clip.timeline_start_seconds - 1.0).abs() < 0.0001)
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
            .load_waveforms_internal(&["audio/test.wav".to_string()], None)
            .expect("waveform should load");
        let perf_after_first_request = session.performance_snapshot();
        let second_waveform = session
            .load_waveforms_internal(&["audio/test.wav".to_string()], None)
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
    fn creating_a_section_marker_stays_in_memory_until_save() {
        let root = tempdir().expect("temp dir should exist");
        let song_dir =
            create_song_folder(root.path(), "section-demo").expect("song dir should exist");
        fs::create_dir_all(song_dir.join("audio")).expect("audio dir should exist");
        save_song(&song_dir, &demo_song()).expect("song should save");

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
        assert!(saved_song.section_markers.is_empty());
    }

    #[test]
    fn deleting_a_clip_stays_in_memory_until_save() {
        let root = tempdir().expect("temp dir should exist");
        let song_dir =
            create_song_folder(root.path(), "clip-delete-demo").expect("song dir should exist");
        fs::create_dir_all(song_dir.join("audio")).expect("audio dir should exist");
        save_song(&song_dir, &demo_song()).expect("song should save");

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
        assert_eq!(saved_song.clips.len(), 1);
        assert_eq!(session.engine.playback_state(), PlaybackState::Stopped);
    }

    #[test]
    fn deleting_the_last_clip_shrinks_song_duration_even_if_markers_remain() {
        let root = tempdir().expect("temp dir should exist");
        let song_dir = create_song_folder(root.path(), "clip-delete-shrink-demo")
            .expect("song dir should exist");
        fs::create_dir_all(song_dir.join("audio")).expect("audio dir should exist");

        let mut song = demo_song();
        song.section_markers.push(Marker {
            id: "section_far".into(),
            name: "Far".into(),
            start_seconds: 6.0,
            digit: None,
        });
        save_song(&song_dir, &song).expect("song should save");

        let mut session = DesktopSession::default();
        session.song_dir = Some(song_dir.clone());
        session
            .engine
            .load_song(song)
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
        assert_eq!(song_view.duration_seconds, 1.0);
        assert_eq!(song_view.section_markers.len(), 1);
        assert_eq!(song_view.section_markers[0].start_seconds, 6.0);
    }

    #[test]
    fn updating_a_clip_window_stays_in_memory_until_save() {
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
        save_song(&song_dir, &demo_song()).expect("song should save");

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
        assert_eq!(saved_song.clips[0].timeline_start_seconds, 1.0);
        assert_eq!(saved_song.clips[0].source_start_seconds, 0.0);
        assert_eq!(saved_song.clips[0].duration_seconds, 4.0);
    }

    #[test]
    fn duplicating_a_clip_stays_in_memory_until_save() {
        let root = tempdir().expect("temp dir should exist");
        let song_dir =
            create_song_folder(root.path(), "clip-duplicate-demo").expect("song dir should exist");
        fs::create_dir_all(song_dir.join("audio")).expect("audio dir should exist");
        save_song(&song_dir, &demo_song()).expect("song should save");

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
        assert_eq!(saved_song.clips.len(), 1);
    }

    #[test]
    fn duplicating_a_clip_does_not_stretch_the_last_region() {
        let root = tempdir().expect("temp dir should exist");
        let song_dir = create_song_folder(root.path(), "clip-duplicate-region-demo")
            .expect("song dir should exist");
        fs::create_dir_all(song_dir.join("audio")).expect("audio dir should exist");

        let mut song = demo_song();
        song.regions[0].end_seconds = 2.0;
        save_song(&song_dir, &song).expect("song should save");

        let mut session = DesktopSession::default();
        session.song_dir = Some(song_dir.clone());
        session
            .engine
            .load_song(song)
            .expect("song should load into engine");

        let audio = crate::audio_runtime::AudioController::default();
        let snapshot = session
            .duplicate_clip("clip_1", 6.0, &audio)
            .expect("clip should duplicate without stretching regions");
        let song_view = session
            .song_view()
            .expect("song view should build")
            .expect("song summary should exist");

        assert!(snapshot.project_revision > 0);
        assert_eq!(song_view.duration_seconds, 10.0);
        assert_eq!(song_view.regions.len(), 1);
        assert_eq!(song_view.regions[0].end_seconds, 2.0);
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
            .schedule_marker_jump(
                "section_1",
                JumpTrigger::AfterBars(6),
                TransitionType::Instant,
                &audio,
            )
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
    fn scheduling_after_bars_across_regions_exposes_cumulative_execute_time_in_snapshot() {
        let mut session = DesktopSession::default();
        session
            .engine
            .load_song(demo_song_with_region_changes_and_sections())
            .expect("song should load into engine");

        let audio = crate::audio_runtime::AudioController::default();
        session.seek(7.0, &audio).expect("seek should work");

        let snapshot = session
            .schedule_marker_jump(
                "section_2",
                JumpTrigger::AfterBars(2),
                TransitionType::Instant,
                &audio,
            )
            .expect("jump should schedule");

        let pending_jump = snapshot
            .pending_marker_jump
            .expect("pending jump should exist");
        assert_eq!(pending_jump.target_marker_id, "section_2");
        assert_eq!(pending_jump.target_marker_name, "Outro");
        assert_eq!(pending_jump.trigger, "after_bars:2");
        assert!((pending_jump.execute_at_seconds - 10.0).abs() < 0.0001);
    }

    #[test]
    fn transport_only_updates_preserve_cross_region_after_bars_schedule() {
        let root = tempdir().expect("temp dir should exist");
        let song_dir = create_song_folder(root.path(), "transport-only-cross-region-pending-jump")
            .expect("song dir should exist");
        fs::create_dir_all(song_dir.join("audio")).expect("audio dir should exist");

        let mut session = DesktopSession::default();
        session.song_dir = Some(song_dir);
        session
            .engine
            .load_song(demo_song_with_region_changes_and_sections())
            .expect("song should load into engine");

        let audio = crate::audio_runtime::AudioController::default();
        session.seek(7.0, &audio).expect("seek should work");
        session
            .schedule_marker_jump(
                "section_2",
                JumpTrigger::AfterBars(2),
                TransitionType::Instant,
                &audio,
            )
            .expect("jump should schedule");

        let snapshot = session
            .update_section_marker("section_1", "Intro B", 1.0, &audio)
            .expect("section marker update should succeed");

        let pending_jump = snapshot
            .pending_marker_jump
            .expect("pending jump should survive transport-only change");
        assert_eq!(pending_jump.target_marker_id, "section_2");
        assert_eq!(pending_jump.target_marker_name, "Outro");
        assert_eq!(pending_jump.trigger, "after_bars:2");
        assert!((pending_jump.execute_at_seconds - 10.0).abs() < 0.0001);
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
            .schedule_marker_jump(
                "section_1",
                JumpTrigger::Immediate,
                TransitionType::Instant,
                &audio,
            )
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
            .schedule_marker_jump(
                "section_2",
                JumpTrigger::NextMarker,
                TransitionType::Instant,
                &audio,
            )
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
            .schedule_marker_jump(
                "section_2",
                JumpTrigger::NextMarker,
                TransitionType::Instant,
                &audio,
            )
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
            .schedule_marker_jump(
                "section_2",
                JumpTrigger::AfterBars(2),
                TransitionType::Instant,
                &audio,
            )
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
            .schedule_marker_jump(
                "section_2",
                JumpTrigger::NextMarker,
                TransitionType::Instant,
                &audio,
            )
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
    fn updating_a_section_marker_stays_in_memory_until_save() {
        let root = tempdir().expect("temp dir should exist");
        let song_dir =
            create_song_folder(root.path(), "section-update-demo").expect("song dir should exist");
        fs::create_dir_all(song_dir.join("audio")).expect("audio dir should exist");
        save_song(&song_dir, &demo_song_with_section()).expect("song should save");

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
        assert_eq!(saved_song.section_markers[0].name, "Intro");
        assert_eq!(saved_song.section_markers[0].start_seconds, 1.0);
    }

    #[test]
    fn deleting_a_section_marker_stays_in_memory_until_save() {
        let root = tempdir().expect("temp dir should exist");
        let song_dir =
            create_song_folder(root.path(), "section-delete-demo").expect("song dir should exist");
        fs::create_dir_all(song_dir.join("audio")).expect("audio dir should exist");
        save_song(&song_dir, &demo_song_with_section()).expect("song should save");

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
        assert_eq!(saved_song.section_markers.len(), 1);
    }

    #[test]
    fn creating_a_song_region_splits_the_existing_range() {
        let mut session = session_with_song_dir("region-create-demo", demo_song());
        let song_dir = session.song_dir.clone().expect("song dir should exist");

        let audio = crate::audio_runtime::AudioController::default();
        let snapshot = session
            .create_song_region(2.0, 5.0, &audio)
            .expect("song region should be created");
        let song_view = session
            .song_view()
            .expect("song view should build")
            .expect("song summary should exist");
        let created_region = song_view
            .regions
            .iter()
            .find(|region| region.start_seconds == 2.0 && region.end_seconds == 5.0)
            .expect("created region should exist");

        assert_eq!(snapshot.project_revision, song_view.project_revision);
        assert_eq!(song_view.regions.len(), 3);
        assert_eq!(created_region.name, "Song 1");

        let saved_song = load_song(&song_dir).expect("song json should load");
        assert_eq!(saved_song.regions.len(), 1);
    }

    #[test]
    fn creating_a_song_region_beyond_song_duration_preserves_its_bounds() {
        let mut session = session_with_song_dir("region-beyond-duration-demo", demo_song());
        let song_dir = session.song_dir.clone().expect("song dir should exist");

        let audio = crate::audio_runtime::AudioController::default();
        let snapshot = session
            .create_song_region(12.0, 24.0, &audio)
            .expect("song region should be created beyond song duration");
        let song_view = session
            .song_view()
            .expect("song view should build")
            .expect("song summary should exist");
        let created_region = song_view
            .regions
            .iter()
            .find(|region| region.start_seconds == 12.0 && region.end_seconds == 24.0)
            .expect("created region should exist");

        assert!(snapshot.project_revision > 0);
        assert_eq!(song_view.duration_seconds, 12.0);
        assert_eq!(song_view.regions.len(), 2);
        assert_eq!(created_region.name, "Song 1");

        let saved_song = load_song(&song_dir).expect("song json should load");
        assert_eq!(saved_song.regions.len(), 1);
        assert_eq!(saved_song.regions[0].end_seconds, 12.0);
    }

    #[test]
    fn updating_a_song_region_reflows_neighbors_and_preserves_coverage() {
        let mut session = session_with_song_dir(
            "region-update-demo",
            demo_song_with_region_changes_and_sections(),
        );

        let audio = crate::audio_runtime::AudioController::default();
        let snapshot = session
            .update_song_region("region_2", "Song B", 6.0, 16.0, &audio)
            .expect("song region should update");
        let song_view = session
            .song_view()
            .expect("song view should build")
            .expect("song summary should exist");
        let updated_region = song_view
            .regions
            .iter()
            .find(|region| region.id == "region_2")
            .expect("updated region should exist");

        assert!(snapshot.project_revision > 0);
        assert_eq!(song_view.regions.len(), 3);
        assert_eq!(song_view.regions[0].start_seconds, 0.0);
        assert_eq!(song_view.regions[0].end_seconds, 6.0);
        assert_eq!(updated_region.name, "Song B");
        assert_eq!(updated_region.start_seconds, 6.0);
        assert_eq!(updated_region.end_seconds, 16.0);
        assert_eq!(song_view.regions[2].start_seconds, 16.0);
        assert_eq!(song_view.regions[2].end_seconds, 18.0);
    }

    #[test]
    fn deleting_a_song_region_preserves_neighbor_region_bounds() {
        let mut session = session_with_song_dir(
            "region-delete-demo",
            demo_song_with_region_changes_and_sections(),
        );

        let audio = crate::audio_runtime::AudioController::default();
        let snapshot = session
            .delete_song_region("region_2", &audio)
            .expect("song region should delete");
        let song_view = session
            .song_view()
            .expect("song view should build")
            .expect("song summary should exist");

        assert_eq!(snapshot.project_revision, song_view.project_revision);
        assert_eq!(song_view.regions.len(), 2);
        assert_eq!(song_view.regions[0].id, "region_1");
        assert_eq!(song_view.regions[0].start_seconds, 0.0);
        assert_eq!(song_view.regions[0].end_seconds, 8.0);
        assert_eq!(song_view.regions[1].id, "region_3");
        assert_eq!(song_view.regions[1].start_seconds, 14.0);
        assert_eq!(song_view.regions[1].end_seconds, 18.0);
    }

    #[test]
    fn deleting_the_last_song_region_leaves_the_song_without_regions() {
        let mut session =
            session_with_song_dir("region-delete-last-demo", demo_song_with_section());

        let audio = crate::audio_runtime::AudioController::default();
        let snapshot = session
            .delete_song_region("region_1", &audio)
            .expect("last song region should delete");
        let song_view = session
            .song_view()
            .expect("song view should build")
            .expect("song summary should exist");

        assert_eq!(snapshot.project_revision, song_view.project_revision);
        assert!(song_view.regions.is_empty());
    }

    #[test]
    fn updating_song_tempo_without_regions_does_not_create_one() {
        let mut session = session_with_song_dir("song-tempo-without-regions", demo_song());
        let audio = crate::audio_runtime::AudioController::default();

        {
            let song = session.engine.song_mut().expect("song should exist");
            song.regions.clear();
        }

        let snapshot = session
            .update_song_tempo(148.0, &audio)
            .expect("song tempo update should not fail without regions");
        let song_view = session
            .song_view()
            .expect("song view should build")
            .expect("song summary should exist");

        assert!(snapshot.project_revision > 0);
        assert!(song_view.regions.is_empty());
        assert_eq!(song_view.bpm, 148.0);
    }

    #[test]
    fn updating_song_tempo_preserves_existing_tempo_markers_while_updating_the_base_bpm() {
        let mut session = session_with_song_dir("song-tempo-reset-demo", demo_song());
        let audio = crate::audio_runtime::AudioController::default();

        session
            .upsert_song_tempo_marker(12.0, 91.0, &audio)
            .expect("tempo marker should be created");

        let snapshot = session
            .update_song_tempo(91.0, &audio)
            .expect("song tempo should update");
        let song_view = session
            .song_view()
            .expect("song view should build")
            .expect("song summary should exist");

        assert_eq!(snapshot.project_revision, song_view.project_revision);
        assert_eq!(song_view.bpm, 91.0);
        assert_eq!(song_view.tempo_markers.len(), 1);
        assert!((song_view.tempo_markers[0].start_seconds - 12.0).abs() < 0.0001);
        assert!((song_view.tempo_markers[0].bpm - 91.0).abs() < 0.0001);
    }

    #[test]
    fn updating_song_time_signature_preserves_existing_time_signature_markers() {
        let mut session = session_with_song_dir("song-time-signature-reset-demo", demo_song());
        let audio = crate::audio_runtime::AudioController::default();

        session
            .upsert_song_time_signature_marker(8.0, "3/4", &audio)
            .expect("time signature marker should be created");

        let snapshot = session
            .update_song_time_signature("6/8", &audio)
            .expect("song time signature should update");
        let song_view = session
            .song_view()
            .expect("song view should build")
            .expect("song summary should exist");

        assert_eq!(snapshot.project_revision, song_view.project_revision);
        assert_eq!(song_view.time_signature, "6/8");
        assert_eq!(song_view.time_signature_markers.len(), 1);
        assert!((song_view.time_signature_markers[0].start_seconds - 8.0).abs() < 0.0001);
        assert_eq!(song_view.time_signature_markers[0].signature, "3/4");
    }

    #[test]
    fn creating_a_section_marker_beyond_song_duration_preserves_its_position() {
        let mut session = session_with_song_dir("section-beyond-duration-demo", demo_song());
        let audio = crate::audio_runtime::AudioController::default();

        let snapshot = session
            .create_section_marker(24.0, &audio)
            .expect("section marker should be created beyond song duration");
        let song_view = session
            .song_view()
            .expect("song view should build")
            .expect("song summary should exist");

        assert!(snapshot.project_revision > 0);
        assert_eq!(song_view.duration_seconds, 12.0);
        assert_eq!(song_view.section_markers.len(), 1);
        assert_eq!(song_view.section_markers[0].start_seconds, 24.0);
    }

    #[test]
    fn creating_a_tempo_marker_beyond_song_duration_preserves_its_position() {
        let mut session = session_with_song_dir("tempo-beyond-duration-demo", demo_song());
        let audio = crate::audio_runtime::AudioController::default();

        let snapshot = session
            .upsert_song_tempo_marker(24.0, 91.0, &audio)
            .expect("tempo marker should be created beyond song duration");
        let song_view = session
            .song_view()
            .expect("song view should build")
            .expect("song summary should exist");

        assert!(snapshot.project_revision > 0);
        assert_eq!(song_view.duration_seconds, 12.0);
        assert_eq!(song_view.tempo_markers.len(), 1);
        assert_eq!(song_view.tempo_markers[0].start_seconds, 24.0);
        assert_eq!(song_view.tempo_markers[0].bpm, 91.0);
    }

    #[test]
    fn save_project_persists_pending_song_changes() {
        let mut session = session_with_song_dir("save-project-demo", demo_song());
        let song_dir = session
            .song_dir
            .clone()
            .expect("song dir should exist for loaded session");
        save_song(&song_dir, &demo_song()).expect("seed song should save");

        let audio = crate::audio_runtime::AudioController::default();
        session
            .move_clip("clip_1", 6.5, &audio)
            .expect("clip should move");

        let unsaved_song = load_song(&song_dir).expect("song json should load");
        assert_eq!(unsaved_song.clips[0].timeline_start_seconds, 1.0);

        session.save_project().expect("save should succeed");

        let saved_song = load_song(&song_dir).expect("song json should load");
        assert_eq!(saved_song.clips[0].timeline_start_seconds, 6.5);
    }
}
