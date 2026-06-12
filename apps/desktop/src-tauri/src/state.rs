use std::{
    collections::{HashMap, HashSet},
    fs,
    path::Path,
    path::PathBuf,
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use libretracks_audio::{
    ActiveVamp, AudioEngine, JumpTrigger, PendingMarkerJump, PlaybackState, TransitionType,
    VampMode,
};
use libretracks_core::{
    audible_clip_duration_seconds, effective_bpm_at, region_warp_ratio_in_song,
    source_seconds_at_view, warp_timeline_seconds_at, Clip, Marker, MarkerKind, Song, SongRegion,
    TempoMarker, TimeSignatureMarker, Track, TrackKind, MAX_TRANSPOSE_SEMITONES,
    MIN_TRANSPOSE_SEMITONES,
};
use libretracks_project::{
    append_wav_files_to_song, global_waveform_file_path,
    import_song_package as import_song_package_into_project, import_wav_files_to_library,
    load_global_waveform, load_or_generate_global_waveform, load_song_from_file,
    read_audio_metadata, save_song_to_file, waveform_summary_from_peaks, write_global_waveform,
    ImportOperationMetrics, ImportedSong, PackageLibraryAssetEntry, ProjectError, WaveformSummary,
    SONG_FILE_NAME,
};
use lt_audio_engine_v2::{JumpTarget as NativeJumpTarget, JumpTargetKind as NativeJumpTargetKind};
use rayon::prelude::*;
use rfd::FileDialog;
use serde::{Deserialize, Serialize};
use serde_json::to_vec;
use tauri::{AppHandle, Emitter, Manager};

use crate::audio_engine::{jump_debug_logging_enabled, AudioController, PlaybackStartReason};
use crate::automation::{
    load_automation, save_automation, AutomationAction, AutomationCue, AutomationDocument,
    AutomationJumpTarget, AutomationTransitionMode, MixScene,
};
use crate::error::DesktopError;
use crate::midi::MidiManager;
use crate::models::view::{
    active_vamp_to_summary, active_vamp_to_warped_summary, automation_cues_to_summary,
    automation_jump_target_to_summary, empty_musical_position_summary, marker_to_warped_summary,
    mix_scenes_to_summary, musical_position_summary, pending_jump_to_summary,
    pending_jump_to_warped_summary, song_to_view, waveform_key_for_file_path,
    waveform_summary_to_dto, PendingAutomationCueSummary,
};
use crate::models::{
    DesktopPerformanceSnapshot, LibraryAssetSummary, PitchPrepareSummary,
    SongPackageImportResponse, SongView, TransportClockSummary, TransportDriftSummary,
    TransportSnapshot, WaveformSummaryDto,
};
use crate::settings::AppSettings;

const LIBRARY_MANIFEST_FILE_NAME: &str = "library.json";
const LIBRARY_IMPORT_PROGRESS_EVENT: &str = "library:import-progress";
const PROJECT_LOAD_PROGRESS_EVENT: &str = "project:load-progress";
pub const WAVEFORM_READY_EVENT: &str = "waveform:ready";
const TRANSPORT_RUNTIME_SYNC_INTERVAL: Duration = Duration::from_millis(250);
const TRANSPORT_PITCH_SYNC_INTERVAL: Duration = Duration::from_millis(800);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LibraryImportProgressEvent {
    percent: u8,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectLoadProgressEvent {
    pub percent: u8,
    pub message: String,
    pub sources_ready: usize,
    pub sources_total: usize,
    pub ram_cache_mb: usize,
    pub disk_cache_mb: usize,
    pub emitted_at_unix_ms: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioFileImportPayload {
    pub file_name: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioFilePathImportPayload {
    pub file_name: String,
    pub source_path: String,
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
    pub project_load_progress: Mutex<Option<ProjectLoadProgressEvent>>,
}

impl Default for DesktopState {
    fn default() -> Self {
        Self {
            audio: AudioController::default(),
            midi: MidiManager::default(),
            waveform_jobs: WaveformGenerationQueue::default(),
            session: Mutex::new(DesktopSession::default()),
            project_load_progress: Mutex::new(None),
        }
    }
}

pub struct DesktopSession {
    pub engine: AudioEngine,
    transport_clock: TransportClock,
    pub song_dir: Option<PathBuf>,
    song_file_path: Option<PathBuf>,
    last_drift_sample: Option<TransportDriftSummary>,
    last_runtime_pitch: Option<PitchPrepareSummary>,
    last_transport_runtime_sync_at: Option<Instant>,
    last_transport_pitch_sync_at: Option<Instant>,
    last_native_scheduled_jump_executed_count: u64,
    automation: AutomationDocument,
    pending_automation_jump: Option<PendingAutomationJump>,
    /// In-flight jobs without a terminal jump (pure mix/scene/wait sequences).
    active_automation_job: Option<ActiveAutomationJob>,
    /// Per-cue fire count for this playback session (cue id → times fired).
    /// Session state only (never persisted); reset on stop and on seeking before
    /// a cue. Enforces `AutomationCue.max_runs` so loops can be bounded.
    automation_run_counts: HashMap<String, u32>,
    project_revision: u64,
    undo_stack: Vec<Song>,
    redo_stack: Vec<Song>,
    live_history_anchor: Option<Song>,
    transpose_history_group: Option<TransposeHistoryGroup>,
    waveform_cache: WaveformMemoryCache,
    perf_metrics: DesktopPerformanceMetrics,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum TransposeHistoryTarget {
    Region(String),
    Track(String),
}

#[derive(Debug, Clone)]
struct TransposeHistoryGroup {
    target: TransposeHistoryTarget,
    recorded_at: Instant,
}

#[derive(Debug, Clone)]
struct PendingAutomationJump {
    cue_id: String,
    cue_name: String,
    /// View-space time the jump itself fires: cue.at_seconds + Σ pre-jump waits.
    execute_at_seconds: f64,
    target: AutomationJumpTarget,
    mix_scene_id: Option<String>,
    fade_out_seconds: Option<f64>,
    fade_started: bool,
    /// Non-jump actions of the job, paired with their view-space fire time
    /// (cue.at_seconds + offset). Sorted by time; fired as the playhead crosses
    /// them. `fired_count` is how many have already run this pass.
    timed_actions: Vec<(f64, AutomationAction)>,
    fired_count: usize,
}

/// An in-flight job that has NO terminal jump (pure mix/scene/wait sequence).
/// Jobs with a jump are tracked via `pending_automation_jump` instead, since the
/// native jump scheduling already drives them.
#[derive(Debug, Clone)]
struct ActiveAutomationJob {
    cue_id: String,
    timed_actions: Vec<(f64, AutomationAction)>,
    fired_count: usize,
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
            last_runtime_pitch: None,
            last_transport_runtime_sync_at: None,
            last_transport_pitch_sync_at: None,
            last_native_scheduled_jump_executed_count: 0,
            automation: AutomationDocument::default(),
            pending_automation_jump: None,
            active_automation_job: None,
            automation_run_counts: HashMap::new(),
            project_revision: 0,
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
            live_history_anchor: None,
            transpose_history_group: None,
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

fn unique_waveform_keys(song: &Song) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut keys = Vec::new();
    for clip in &song.clips {
        let key = waveform_key_for_file_path(&clip.file_path);
        if seen.insert(key.clone()) {
            keys.push(key);
        }
    }
    keys
}

fn process_waveform_job(job: WaveformJob) {
    let WaveformJob {
        app,
        song_dir,
        waveform_key,
    } = job;

    let summary_result = load_or_generate_global_waveform(
        &decoding_cache_root(),
        &song_dir,
        Path::new(&waveform_key),
    );

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
            playback_rate: 1.0,
            running: self.anchor_started_at.is_some(),
            last_seek_position_seconds: self.last_seek_position_seconds,
            last_start_position_seconds: self.last_start_position_seconds,
            last_jump_position_seconds: self.last_jump_position_seconds,
        }
    }
}

fn timeline_seconds_to_view(song: Option<&Song>, seconds: f64) -> f64 {
    song.map(|song| warp_timeline_seconds_at(song, seconds))
        .unwrap_or(seconds)
}

fn timeline_playback_rate_to_view(song: Option<&Song>, source_seconds: f64) -> f64 {
    let Some(song) = song else {
        return 1.0;
    };

    if !source_seconds.is_finite() {
        return 1.0;
    }

    let active_region = song
        .regions
        .iter()
        .filter(|region| {
            region.start_seconds.is_finite()
                && region.end_seconds.is_finite()
                && source_seconds >= region.start_seconds
                && source_seconds < region.end_seconds
        })
        .max_by(|left, right| {
            left.start_seconds
                .partial_cmp(&right.start_seconds)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

    let Some(region) = active_region else {
        return 1.0;
    };

    let ratio = if region.warp_enabled {
        region_warp_ratio_in_song(region, song)
    } else if region.transpose_semitones != 0 {
        semitones_to_pitch_scale(region.transpose_semitones)
    } else {
        1.0
    };

    if ratio.is_finite() && ratio > 0.0 {
        1.0 / ratio
    } else {
        1.0
    }
}

fn optional_timeline_seconds_to_view(song: Option<&Song>, seconds: Option<f64>) -> Option<f64> {
    seconds.map(|seconds| timeline_seconds_to_view(song, seconds))
}

fn transport_clock_summary_to_view(
    song: Option<&Song>,
    summary: TransportClockSummary,
) -> TransportClockSummary {
    let source_anchor_position_seconds = summary.anchor_position_seconds;
    TransportClockSummary {
        anchor_position_seconds: timeline_seconds_to_view(song, source_anchor_position_seconds),
        playback_rate: timeline_playback_rate_to_view(song, source_anchor_position_seconds),
        running: summary.running,
        last_seek_position_seconds: optional_timeline_seconds_to_view(
            song,
            summary.last_seek_position_seconds,
        ),
        last_start_position_seconds: optional_timeline_seconds_to_view(
            song,
            summary.last_start_position_seconds,
        ),
        last_jump_position_seconds: optional_timeline_seconds_to_view(
            song,
            summary.last_jump_position_seconds,
        ),
    }
}

fn transport_drift_summary_to_view(
    song: Option<&Song>,
    sample: TransportDriftSummary,
) -> TransportDriftSummary {
    let transport_position_seconds =
        timeline_seconds_to_view(song, sample.transport_position_seconds);
    let engine_position_seconds = timeline_seconds_to_view(song, sample.engine_position_seconds);
    let runtime_estimated_position_seconds = sample.runtime_estimated_position_seconds;
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

    TransportDriftSummary {
        event: sample.event,
        transport_position_seconds,
        engine_position_seconds,
        runtime_estimated_position_seconds,
        runtime_running: sample.runtime_running,
        transport_minus_engine_seconds,
        runtime_minus_transport_seconds,
        runtime_minus_engine_seconds,
        max_observed_delta_seconds,
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateClipRequest {
    pub track_id: String,
    pub file_path: String,
    pub timeline_start_seconds: f64,
}

/// Drop request from the compact view's song column: an audio file with no
/// associated track. The state layer creates an auto track per file
/// (`auto_created = true`) with the file stem as the track name.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateClipWithAutoTrackRequest {
    pub file_path: String,
    pub timeline_start_seconds: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipMoveRequest {
    pub clip_id: String,
    pub timeline_start_seconds: f64,
    /// Optional destination track. When present, the clip is reassigned to
    /// this track as part of the same move (dragging a clip vertically onto
    /// another lane). `None` keeps the clip on its current track. The target
    /// must exist and must not be a folder track.
    #[serde(default)]
    pub target_track_id: Option<String>,
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
        let default_directory = project_root(app).join("songs");
        // The user picks the .ltsession name + parent location with the native
        // save dialog. We then create a project folder named after the file
        // stem and place the .ltsession (plus audio/, cache/) inside it —
        // Ableton-style. This means a user can pick "MyShow.ltsession" in
        // any folder without first having to create a MyShow/ subfolder.
        let target_pick = FileDialog::new()
            .set_title("Crear proyecto")
            .set_directory(&default_directory)
            .add_filter("LibreTracks Session", &["ltsession"])
            .set_file_name(&default_project_file_name("Nueva Cancion"))
            .save_file();

        let Some(target_pick) = target_pick else {
            return Ok(None);
        };

        self.create_song_at_path(target_pick, audio).map(Some)
    }

    /// Heavy half of `create_song`: writes the project folder + .ltsession and
    /// loads it into the engine. Split out from the native dialog so the
    /// command layer can run this on a worker thread — running it on the main
    /// thread (as a sync Tauri command does) freezes the macOS run loop and
    /// hangs the window on the "Applying changes" overlay.
    pub fn create_song_at_path(
        &mut self,
        target_pick: PathBuf,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let title = "Nueva Cancion".to_string();
        let song_id = format!("song_{}", timestamp_suffix());
        let song = build_empty_song(song_id, title);

        let parent_dir = target_pick.parent().map(Path::to_path_buf).ok_or_else(|| {
            DesktopError::AudioCommand("no se pudo determinar la carpeta destino".into())
        })?;
        let project_name = target_pick
            .file_stem()
            .and_then(|stem| stem.to_str())
            .map(str::to_owned)
            .filter(|name| !name.is_empty())
            .ok_or_else(|| {
                DesktopError::AudioCommand("el nombre del proyecto no es valido".into())
            })?;

        let song_dir = parent_dir.join(&project_name);
        if song_dir.exists() {
            return Err(DesktopError::AudioCommand(format!(
                "ya existe una carpeta llamada \"{}\" en esa ubicacion. Elige otro nombre.",
                project_name
            )));
        }
        let target_song_file = song_dir.join(format!("{}.ltsession", project_name));

        fs::create_dir_all(song_dir.join("audio"))?;
        fs::create_dir_all(song_dir.join("cache").join("waveforms"))?;
        write_library_manifest(&song_dir, &[])?;
        save_automation(&song_dir, &AutomationDocument::default())
            .map_err(|error| DesktopError::AudioCommand(error.to_string()))?;

        let save_started_at = Instant::now();
        save_song_to_file(&target_song_file, &song)?;
        self.perf_metrics.song_save_millis = save_started_at.elapsed().as_millis();
        self.load_song_from_path(song, song_dir, audio)?;
        self.song_file_path = Some(target_song_file);

        Ok(self.snapshot())
    }

    pub fn save_project(&mut self) -> Result<TransportSnapshot, DesktopError> {
        let song_file_path = self.current_song_file_path()?;
        let song_dir = self.song_dir.clone().ok_or(DesktopError::NoSongLoaded)?;
        let song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;

        let save_started_at = Instant::now();
        save_song_to_file(&song_file_path, &song)?;
        save_automation(&song_dir, &self.automation)
            .map_err(|error| DesktopError::AudioCommand(error.to_string()))?;
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

        // Waveforms now live in the global per-file cache keyed by the audio's
        // path+size+mtime. Renaming the audio simply maps to a different cache
        // entry: the new path migrates/regenerates on next load and the old
        // entry is reclaimed by the cache's purge — there is nothing per-project
        // to move here. We only drop the stale in-memory entry.
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
        let song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;

        let target_pick = FileDialog::new()
            .add_filter("LibreTracks Session", &["ltsession"])
            .set_title("Guardar proyecto como")
            .set_file_name(&default_project_file_name(&song.title))
            .save_file();

        let Some(target_pick) = target_pick else {
            return Ok(None);
        };

        self.save_project_as_to_path(target_pick).map(Some)
    }

    /// Heavy half of `save_project_as`: copies the project's audio and writes
    /// the new .ltsession. Split out from the native dialog so the command
    /// layer can run it on a worker thread instead of freezing the macOS main
    /// run loop. See [`create_song_at_path`](Self::create_song_at_path).
    pub fn save_project_as_to_path(
        &mut self,
        target_pick: PathBuf,
    ) -> Result<TransportSnapshot, DesktopError> {
        let source_song_dir = self.song_dir.clone().ok_or(DesktopError::NoSongLoaded)?;
        let song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;

        // Save As mirrors Create: the user picks <name>.ltsession in any
        // folder, and we create a <name>/ subfolder containing the session
        // file plus audio/ and cache/.
        let parent_dir = target_pick.parent().map(Path::to_path_buf).ok_or_else(|| {
            DesktopError::AudioCommand("no se pudo determinar la carpeta destino".into())
        })?;
        let project_name = target_pick
            .file_stem()
            .and_then(|stem| stem.to_str())
            .map(str::to_owned)
            .filter(|name| !name.is_empty())
            .ok_or_else(|| {
                DesktopError::AudioCommand("el nombre del proyecto no es valido".into())
            })?;

        let target_song_dir = parent_dir.join(&project_name);
        if target_song_dir.exists() && target_song_dir != source_song_dir {
            return Err(DesktopError::AudioCommand(format!(
                "ya existe una carpeta llamada \"{}\" en esa ubicacion. Elige otro nombre.",
                project_name
            )));
        }
        let target_song_file = target_song_dir.join(format!("{}.ltsession", project_name));

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
        save_automation(&target_song_dir, &self.automation)
            .map_err(|error| DesktopError::AudioCommand(error.to_string()))?;
        self.perf_metrics.song_save_millis = save_started_at.elapsed().as_millis();

        self.song_dir = Some(target_song_dir.clone());
        self.song_file_path = Some(target_song_file);
        self.prime_waveform_cache(&target_song_dir, &song)?;

        Ok(self.snapshot())
    }

    pub fn open_project_from_dialog(
        &mut self,
        app: &AppHandle,
        audio: &AudioController,
    ) -> Result<Option<TransportSnapshot>, DesktopError> {
        let song_file = FileDialog::new()
            .add_filter("LibreTracks Session", &["ltsession"])
            .set_title("Selecciona session.ltsession")
            .pick_file();

        let Some(song_file) = song_file else {
            return Ok(None);
        };

        self.open_project_from_path(app, audio, song_file).map(Some)
    }

    pub fn open_project_from_path(
        &mut self,
        app: &AppHandle,
        audio: &AudioController,
        song_file: PathBuf,
    ) -> Result<TransportSnapshot, DesktopError> {
        self.begin_open_project_from_path(app, audio, song_file)?;
        self.wait_for_project_audio_preparation(app, audio)?;

        Ok(self.snapshot())
    }

    pub fn begin_open_project_from_path(
        &mut self,
        app: &AppHandle,
        audio: &AudioController,
        song_file: PathBuf,
    ) -> Result<TransportSnapshot, DesktopError> {
        let song_dir = song_file
            .parent()
            .map(std::path::Path::to_path_buf)
            .ok_or_else(|| {
                DesktopError::AudioCommand("session.ltsession must live inside a folder".into())
            })?;
        emit_project_load_progress(app, 5, "Leyendo archivo de proyecto...".into(), 0, 0, 0, 0);
        let song = load_song_from_file(&song_file)?;

        emit_project_load_progress(app, 10, "Proyecto leido.".into(), 0, 0, 0, 0);
        emit_project_load_progress(app, 14, "Cargando sesion de audio...".into(), 0, 0, 0, 0);
        self.load_song_from_path(song, song_dir, audio)?;
        emit_project_load_progress(
            app,
            18,
            "Registrando fuentes de audio...".into(),
            0,
            0,
            0,
            0,
        );
        self.song_file_path = Some(song_file);

        Ok(self.snapshot())
    }

    /// Heavy half of the package-import flow: unpacks the .ltpkg and decodes
    /// its sources. Split out from the native dialog so the command layer can
    /// run it on a worker thread instead of freezing the macOS main run loop.
    /// See [`create_song_at_path`](Self::create_song_at_path).
    pub fn import_song_from_path(
        &mut self,
        app: &AppHandle,
        audio: &AudioController,
        package_file: PathBuf,
        insert_at_seconds: f64,
    ) -> Result<TransportSnapshot, DesktopError> {
        self.song_dir.as_ref().ok_or(DesktopError::NoSongLoaded)?;
        self.engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;

        let package_path = package_file.to_string_lossy().into_owned();
        emit_project_load_progress(app, 5, "Leyendo paquete...".into(), 0, 0, 0, 0);
        // Import the package WITHOUT blocking on source decode — that's what
        // wait_for_project_audio_preparation does, with live progress events.
        // Otherwise the user only sees the loading bar at the very end, after
        // sources have already been decoded silently. The no_wait phase itself
        // (unzip + persist) is also synchronous and used to emit nothing, so the
        // overlay sat frozen on "Leyendo paquete..." until decode began; pass
        // `app` through so it reports its sub-phases inside the reserved 5..18
        // band (decode then continues from 18 in the wait loop below).
        let inserted =
            self.import_song_package_no_wait(app, &package_path, insert_at_seconds, audio)?;
        self.wait_for_project_audio_preparation(app, audio)?;

        Ok(inserted.snapshot)
    }

    /// Import a set of already-picked audio files into the library, emitting
    /// progress events as it goes. The native file dialog is opened by the
    /// caller on the main thread; this runs on a worker thread so the heavy
    /// decode/persist work does not block the macOS run loop and freeze the
    /// window (see `start_import_library_assets_from_dialog`).
    pub fn import_picked_library_assets(
        &mut self,
        app: &AppHandle,
        files: &[PathBuf],
    ) -> Result<Vec<LibraryAssetSummary>, DesktopError> {
        emit_library_import_progress(
            app,
            10,
            format!("Preparando {} archivo(s) para importar...", files.len()),
        );

        let assets = self.import_audio_files_into_library(files, |percent, message| {
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
        Ok(assets)
    }

    #[cfg_attr(not(test), allow(dead_code))]
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

    pub fn song_view(&mut self) -> Result<Option<SongView>, DesktopError> {
        self.song_view_with_options(true)
    }

    /// Build the song view with optional inclusion of waveforms. Waveform LODs
    /// encoded as base64 dominate the SongView payload (~27 MB for 33 clips of
    /// multitrack church audio); skipping them when the caller doesn't need a
    /// fresh copy collapses the IPC round-trip from ~4s to ~50ms for mutations
    /// that don't touch clip audio (transpose, gain, mute, solo, region rename
    /// — none of these change the peaks). The frontend keeps the previously
    /// hydrated waveforms in its local cache.
    pub fn song_view_with_options(
        &mut self,
        include_waveforms: bool,
    ) -> Result<Option<SongView>, DesktopError> {
        let started_at = Instant::now();
        let song_view = self.engine.song().map(|song| {
            song_to_view(
                song,
                &self.automation,
                &self.automation_run_counts,
                &self.waveform_cache,
                self.project_revision,
                self.song_dir.as_deref(),
                include_waveforms,
            )
        });
        let build_ms = started_at.elapsed().as_millis();
        let serialize_started = Instant::now();
        let bytes = song_view
            .as_ref()
            .map(|view| to_vec(view).map(|bytes| bytes.len()))
            .transpose()
            .map_err(|error| DesktopError::AudioCommand(error.to_string()))?
            .unwrap_or(0);
        let serialize_ms = serialize_started.elapsed().as_millis();
        self.perf_metrics.song_view_build_millis = build_ms;
        self.perf_metrics.song_view_bytes = bytes;
        if jump_debug_logging_enabled() {
            eprintln!(
                "[SONG_VIEW_PERF] build_ms={} serialize_ms={} bytes={} include_wfs={} clips={} tracks={} regions={}",
                build_ms,
                serialize_ms,
                bytes,
                include_waveforms,
                song_view.as_ref().map(|v| v.clips.len()).unwrap_or(0),
                song_view.as_ref().map(|v| v.tracks.len()).unwrap_or(0),
                song_view.as_ref().map(|v| v.regions.len()).unwrap_or(0),
            );
        }
        Ok(song_view)
    }

    pub fn load_waveforms(
        &mut self,
        waveform_keys: &[String],
        waveform_jobs: &WaveformGenerationQueue,
        app: &AppHandle,
        audio: &AudioController,
    ) -> Result<Vec<WaveformSummaryDto>, DesktopError> {
        self.load_waveforms_internal(waveform_keys, Some((waveform_jobs, app)), Some(audio))
    }

    fn load_waveforms_internal(
        &mut self,
        waveform_keys: &[String],
        background_generation: Option<(&WaveformGenerationQueue, &AppHandle)>,
        audio: Option<&AudioController>,
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
                    if let Ok(summary) =
                        self.load_waveform_summary_cached(&song_dir, waveform_key, true)
                    {
                        summaries.push(waveform_summary_to_dto(waveform_key, summary));
                        continue;
                    }
                    if let Some(audio) = audio {
                        if let Ok(summary) =
                            self.load_native_waveform_summary(&song_dir, waveform_key, audio)
                        {
                            summaries.push(waveform_summary_to_dto(waveform_key, summary));
                            continue;
                        }
                    }
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
        audio: &AudioController,
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
                    if let Ok(summary) =
                        self.load_waveform_summary_cached(&song_dir, &normalized_path, true)
                    {
                        summaries.push(waveform_summary_to_dto(&normalized_path, summary));
                        continue;
                    }
                    if let Ok(summary) =
                        self.load_native_waveform_summary(&song_dir, &normalized_path, audio)
                    {
                        summaries.push(waveform_summary_to_dto(&normalized_path, summary));
                        continue;
                    }
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
        let device_changed = previous_settings.selected_output_device
            != next_settings.selected_output_device
            || previous_settings.selected_audio_backend != next_settings.selected_audio_backend
            || previous_settings.selected_output_device_id
                != next_settings.selected_output_device_id
            || previous_settings.selected_output_device_name
                != next_settings.selected_output_device_name
            || previous_settings.output_sample_rate != next_settings.output_sample_rate
            || previous_settings.output_buffer_size != next_settings.output_buffer_size
            || previous_settings.output_sample_format != next_settings.output_sample_format
            || previous_settings.output_channel_mapping != next_settings.output_channel_mapping
            || previous_settings.audio_safe_mode != next_settings.audio_safe_mode;
        let midi_changed =
            previous_settings.selected_midi_device != next_settings.selected_midi_device;
        let output_channels_changed =
            previous_settings.enabled_output_channels != next_settings.enabled_output_channels;
        let metronome_enabled_changed =
            previous_settings.metronome_enabled != next_settings.metronome_enabled;
        let metronome_volume_changed =
            (previous_settings.metronome_volume - next_settings.metronome_volume).abs()
                > f64::EPSILON;
        let metronome_output_changed =
            previous_settings.metronome_output != next_settings.metronome_output;
        let metronome_sound_changed = previous_settings.metronome_accent_enabled
            != next_settings.metronome_accent_enabled
            || previous_settings.metronome_accent_preset != next_settings.metronome_accent_preset
            || previous_settings.metronome_beat_preset != next_settings.metronome_beat_preset
            || (previous_settings.metronome_accent_pitch - next_settings.metronome_accent_pitch)
                .abs()
                > f32::EPSILON
            || (previous_settings.metronome_beat_pitch - next_settings.metronome_beat_pitch).abs()
                > f32::EPSILON
            || previous_settings.metronome_subdivision != next_settings.metronome_subdivision
            || previous_settings.metronome_subdivision_preset
                != next_settings.metronome_subdivision_preset
            || (previous_settings.metronome_subdivision_pitch
                - next_settings.metronome_subdivision_pitch)
                .abs()
                > f32::EPSILON
            || (previous_settings.metronome_subdivision_gain
                - next_settings.metronome_subdivision_gain)
                .abs()
                > f32::EPSILON;
        let voice_guide_config_changed = previous_settings.voice_guide_enabled
            != next_settings.voice_guide_enabled
            || previous_settings.voice_guide_output != next_settings.voice_guide_output
            || (previous_settings.voice_guide_volume - next_settings.voice_guide_volume).abs()
                > f64::EPSILON
            || previous_settings.voice_guide_lead_bars != next_settings.voice_guide_lead_bars
            || previous_settings.voice_guide_count_in_enabled
                != next_settings.voice_guide_count_in_enabled;

        if !device_changed
            && !midi_changed
            && !output_channels_changed
            && !metronome_enabled_changed
            && !metronome_volume_changed
            && !metronome_output_changed
            && !metronome_sound_changed
            && !voice_guide_config_changed
        {
            return Ok(next_settings);
        }

        let rebuild_audio_stream = device_changed || output_channels_changed;
        if rebuild_audio_stream && self.engine.playback_state() == PlaybackState::Playing {
            let _ = audio.stop();
            self.engine.pause()?;
            self.transport_clock
                .pause_at(self.engine.position_seconds());
        }

        audio.apply_settings_with_stream_rebuild(next_settings.clone(), rebuild_audio_stream)?;

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

        let runtime_position_seconds =
            self.runtime_seconds_for_engine_position(self.engine.position_seconds());
        audio.prepare_song_buffers_async(song_dir.clone(), song.clone());
        audio.play(song_dir, song, runtime_position_seconds, start_reason)?;
        self.engine.play()?;
        self.transport_clock
            .start_from(self.engine.position_seconds());
        self.schedule_next_automation_jump(audio)?;
        self.capture_transport_drift_sample(
            audio,
            "play",
            self.current_position(),
            self.engine.position_seconds(),
        );

        Ok(self.snapshot_with_runtime_transport(audio))
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
        self.pending_automation_jump = None;
        self.active_automation_job = None;
        // A fresh session: every cue can fire its full quota again.
        self.reset_automation_run_counts(None);
        audio.cancel_scheduled_jumps()?;

        Ok(self.snapshot())
    }

    pub fn seek(
        &mut self,
        position_seconds: f64,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        // The frontend passes the playhead position in view-time. The engine
        // operates in source-time, so map back before seeking (otherwise a
        // click after a stretched region lands on a different stored sample
        // than the user pointed at).
        let position_seconds = self
            .engine
            .song()
            .map(|song| source_seconds_at_view(song, position_seconds))
            .unwrap_or(position_seconds);
        let was_playing = self.engine.playback_state() == PlaybackState::Playing;
        self.engine.seek(position_seconds)?;
        // Seeking before a cue makes it eligible to fire its full quota again.
        self.reset_automation_run_counts(Some(self.engine.position_seconds()));
        if was_playing {
            self.reposition_audio(audio, PlaybackStartReason::Seek)?;
            self.transport_clock
                .seek_while_playing(self.engine.position_seconds());
            self.schedule_next_automation_jump(audio)?;
            self.capture_transport_drift_sample(
                audio,
                "seek",
                self.current_position(),
                self.engine.position_seconds(),
            );
            return Ok(self.snapshot());
        }

        self.transport_clock.seek_to(self.engine.position_seconds());
        self.pending_automation_jump = None;
        self.active_automation_job = None;
        audio.cancel_scheduled_jumps()?;
        self.capture_transport_drift_sample(
            audio,
            "seek",
            self.current_position(),
            self.engine.position_seconds(),
        );

        Ok(self.snapshot())
    }

    pub fn on_timeline_hover_or_drag(
        &mut self,
        position_seconds: f64,
        audio: &AudioController,
    ) -> Result<(), DesktopError> {
        let song_dir = self.song_dir.clone().ok_or(DesktopError::NoSongLoaded)?;
        let song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        audio.on_timeline_hover_or_drag(song_dir, song, position_seconds.max(0.0))
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
        self.pending_automation_jump = None;
        self.active_automation_job = None;
        let source_song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;

        let scheduled_jump = self.engine.schedule_marker_jump_with_song(
            &source_song,
            target_marker_id,
            trigger.clone(),
            transition.clone(),
        )?;

        if trigger == JumpTrigger::Immediate && transition == TransitionType::Instant {
            audio.cancel_scheduled_jumps()?;
            if was_playing {
                audio.start_master_fade(1.0, 0.0)?;
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
        } else if matches!(
            transition,
            TransitionType::Instant | TransitionType::FadeOut { .. }
        ) {
            if let Some(pending_jump) = scheduled_jump {
                self.last_native_scheduled_jump_executed_count = audio
                    .engine_snapshot()
                    .map(|snapshot| snapshot.pitch.mixer_scheduled_jump_executed_count)
                    .unwrap_or(self.last_native_scheduled_jump_executed_count);
                if jump_debug_logging_enabled() {
                    eprintln!(
                        "[LT_JUMP_DEBUG][state] marker_pending target_marker={target_marker_id} transition={transition:?} execute_at_seconds={:.9} current_position={:.9} native_count_baseline={}",
                    pending_jump.execute_at_seconds,
                    self.engine.position_seconds(),
                    self.last_native_scheduled_jump_executed_count
                );
                }
                self.schedule_native_marker_jump(audio, &source_song, &pending_jump)?;
            } else {
                audio.cancel_scheduled_jumps()?;
            }
        } else {
            audio.cancel_scheduled_jumps()?;
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
        self.pending_automation_jump = None;
        self.active_automation_job = None;
        let source_song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;

        let scheduled_jump = self.engine.schedule_region_jump_with_song(
            &source_song,
            target_region_id,
            trigger.clone(),
            transition.clone(),
        )?;

        if trigger == JumpTrigger::Immediate && transition == TransitionType::Instant {
            audio.cancel_scheduled_jumps()?;
            if was_playing {
                audio.start_master_fade(1.0, 0.0)?;
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
        } else if trigger == JumpTrigger::RegionEnd
            && matches!(
                transition,
                TransitionType::Instant | TransitionType::FadeOut { .. }
            )
        {
            if let Some(pending_jump) = scheduled_jump {
                self.last_native_scheduled_jump_executed_count = audio
                    .engine_snapshot()
                    .map(|snapshot| snapshot.pitch.mixer_scheduled_jump_executed_count)
                    .unwrap_or(self.last_native_scheduled_jump_executed_count);
                if jump_debug_logging_enabled() {
                    eprintln!(
                        "[LT_JUMP_DEBUG][state] region_end_pending target_region={target_region_id} transition={transition:?} execute_at_seconds={:.9} current_position={:.9} native_count_baseline={}",
                        pending_jump.execute_at_seconds,
                        self.engine.position_seconds(),
                        self.last_native_scheduled_jump_executed_count
                    );
                }
                audio.schedule_region_end_jump(
                    &pending_jump.target_marker_id,
                    target_region_id,
                    matches!(pending_jump.transition, TransitionType::FadeOut { .. }),
                )?;
            } else {
                audio.cancel_scheduled_jumps()?;
            }
        } else if matches!(
            transition,
            TransitionType::Instant | TransitionType::FadeOut { .. }
        ) {
            if let Some(pending_jump) = scheduled_jump {
                self.last_native_scheduled_jump_executed_count = audio
                    .engine_snapshot()
                    .map(|snapshot| snapshot.pitch.mixer_scheduled_jump_executed_count)
                    .unwrap_or(self.last_native_scheduled_jump_executed_count);
                if jump_debug_logging_enabled() {
                    eprintln!(
                        "[LT_JUMP_DEBUG][state] region_pending target_region={target_region_id} trigger={trigger:?} transition={transition:?} execute_at_seconds={:.9} current_position={:.9} native_count_baseline={}",
                        pending_jump.execute_at_seconds,
                        self.engine.position_seconds(),
                        self.last_native_scheduled_jump_executed_count
                    );
                }
                self.schedule_native_region_jump(audio, &source_song, &pending_jump)?;
            } else {
                audio.cancel_scheduled_jumps()?;
            }
        } else if scheduled_jump.is_none() {
            audio.cancel_scheduled_jumps()?;
        }

        Ok(self.snapshot())
    }

    pub fn cancel_marker_jump(
        &mut self,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        self.sync_position(audio)?;
        self.engine.cancel_section_jump();
        self.pending_automation_jump = None;
        self.active_automation_job = None;
        audio.cancel_scheduled_jumps()?;
        Ok(self.snapshot())
    }

    pub fn toggle_vamp(
        &mut self,
        mode: VampMode,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        self.sync_position(audio)?;
        self.engine.cancel_section_jump();
        self.pending_automation_jump = None;
        self.active_automation_job = None;
        audio.cancel_scheduled_jumps()?;
        self.engine.toggle_vamp(mode)?;
        if self.engine.playback_state() == PlaybackState::Playing {
            if let (Some(source_song), Some(active_vamp)) =
                (self.engine.song(), self.engine.active_vamp())
            {
                self.schedule_native_vamp_jump(audio, source_song, active_vamp)?;
            }
        }
        Ok(self.snapshot())
    }

    pub fn upsert_automation_cue(
        &mut self,
        mut cue: AutomationCue,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        cue.at_seconds = source_seconds_at_view(&song, cue.at_seconds);
        // Normalize any frame-target jump's seconds from view → source space.
        for action in &mut cue.actions {
            if let AutomationAction::Jump {
                target: AutomationJumpTarget::Frame { seconds },
                ..
            } = action
            {
                *seconds = source_seconds_at_view(&song, *seconds);
            }
        }
        validate_automation_cue(&song, &self.automation, &cue)?;
        cue.name = cue.name.trim().to_string();
        if cue.name.is_empty() {
            cue.name = "Automation cue".into();
        }

        if let Some(existing) = self
            .automation
            .cues
            .iter_mut()
            .find(|existing| existing.id == cue.id)
        {
            *existing = cue;
        } else {
            self.automation.cues.push(cue);
        }
        // Creating a cue implies the automation track is present: a cue with no
        // visible lane would be a ghost jump. Keep the two invariants together.
        self.automation.track_present = true;
        self.automation.cues.sort_by(|left, right| {
            left.at_seconds
                .partial_cmp(&right.at_seconds)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        self.persist_automation(audio)?;
        Ok(self.snapshot())
    }

    pub fn add_automation_track(
        &mut self,
        after_track_id: Option<String>,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let after_track_id = after_track_id.filter(|id| !id.trim().is_empty());
        if !self.automation.track_present || self.automation.track_after_id != after_track_id {
            self.automation.track_present = true;
            self.automation.track_after_id = after_track_id;
            self.persist_automation(audio)?;
        }
        Ok(self.snapshot())
    }

    pub fn remove_automation_track(
        &mut self,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        // Removing the track clears every cue: without a visible lane the cues
        // would keep firing as ghost jumps. The runtime scheduler iterates over
        // `cues`, so an empty list means nothing is armed.
        self.automation.track_present = false;
        self.automation.track_after_id = None;
        self.automation.cues.clear();
        self.persist_automation(audio)?;
        Ok(self.snapshot())
    }

    pub fn set_automation_track_position(
        &mut self,
        after_track_id: Option<String>,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        self.automation.track_after_id = after_track_id.filter(|id| !id.trim().is_empty());
        self.persist_automation(audio)?;
        Ok(self.snapshot())
    }

    pub fn delete_automation_cue(
        &mut self,
        cue_id: &str,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let before = self.automation.cues.len();
        self.automation.cues.retain(|cue| cue.id != cue_id);
        if self.automation.cues.len() != before {
            if self
                .pending_automation_jump
                .as_ref()
                .is_some_and(|pending| pending.cue_id == cue_id)
            {
                self.pending_automation_jump = None;
        self.active_automation_job = None;
                audio.cancel_scheduled_jumps()?;
            }
            self.persist_automation(audio)?;
        }
        Ok(self.snapshot())
    }

    pub fn upsert_mix_scene(
        &mut self,
        mut scene: MixScene,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        scene.name = scene.name.trim().to_string();
        if scene.id.trim().is_empty() {
            return Err(DesktopError::AudioCommand(
                "mix scene id is required".into(),
            ));
        }
        if scene.name.is_empty() {
            scene.name = "Mix scene".into();
        }

        if let Some(existing) = self
            .automation
            .mix_scenes
            .iter_mut()
            .find(|existing| existing.id == scene.id)
        {
            *existing = scene;
        } else {
            self.automation.mix_scenes.push(scene);
        }
        self.persist_automation(audio)?;
        Ok(self.snapshot())
    }

    pub fn delete_mix_scene(
        &mut self,
        scene_id: &str,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let before = self.automation.mix_scenes.len();
        self.automation
            .mix_scenes
            .retain(|scene| scene.id != scene_id);
        if self.automation.mix_scenes.len() != before {
            for cue in &mut self.automation.cues {
                // Clear the deleted scene from jump actions, and drop any
                // ApplyScene actions that referenced it (a dangling scene id
                // would be a no-op at runtime, but we keep the model clean).
                for action in &mut cue.actions {
                    if let AutomationAction::Jump { mix_scene_id, .. } = action {
                        if mix_scene_id.as_deref() == Some(scene_id) {
                            *mix_scene_id = None;
                        }
                    }
                }
                cue.actions.retain(|action| {
                    !matches!(
                        action,
                        AutomationAction::ApplyScene { scene_id: id } if id == scene_id
                    )
                });
            }
            self.persist_automation(audio)?;
        }
        Ok(self.snapshot())
    }

    fn persist_automation(&mut self, audio: &AudioController) -> Result<(), DesktopError> {
        let song_dir = self.song_dir.clone().ok_or(DesktopError::NoSongLoaded)?;
        save_automation(&song_dir, &self.automation)
            .map_err(|error| DesktopError::AudioCommand(error.to_string()))?;
        self.project_revision = self.project_revision.saturating_add(1);
        self.pending_automation_jump = None;
        self.active_automation_job = None;
        audio.cancel_scheduled_jumps()?;
        self.schedule_next_automation_jump(audio)?;
        Ok(())
    }

    fn schedule_native_vamp_jump(
        &self,
        audio: &AudioController,
        source_song: &Song,
        active_vamp: &ActiveVamp,
    ) -> Result<(), DesktopError> {
        let trigger_seconds = warp_timeline_seconds_at(source_song, active_vamp.end_seconds);
        let target_seconds = Some(warp_timeline_seconds_at(
            source_song,
            active_vamp.start_seconds,
        ));
        if jump_debug_logging_enabled() {
            eprintln!(
                "[LT_JUMP_DEBUG][state] native_vamp_schedule source_start={:.9} source_end={:.9} view_trigger={:.9} view_target={:.9}",
                active_vamp.start_seconds,
                active_vamp.end_seconds,
                trigger_seconds,
                target_seconds.unwrap_or(trigger_seconds)
            );
        }
        audio.schedule_jump_at_frame(
            "__lt_vamp_loop__",
            NativeJumpTarget {
                kind: NativeJumpTargetKind::Frame,
                id: None,
                frame: None,
            },
            trigger_seconds,
            target_seconds,
            true,
        )
    }

    /// Whether the cue can still fire this session (under its `max_runs` limit).
    fn cue_has_runs_left(&self, cue: &AutomationCue) -> bool {
        match cue.max_runs {
            None => true,
            Some(max) => self.automation_run_counts.get(&cue.id).copied().unwrap_or(0) < max,
        }
    }

    /// Record one firing of the cue for this session.
    fn record_automation_cue_run(&mut self, cue_id: &str) {
        *self
            .automation_run_counts
            .entry(cue_id.to_string())
            .or_insert(0) += 1;
    }

    /// Drop run counts for cues at or after `position_seconds` so seeking before
    /// a cue makes it eligible to fire its full quota again. `None` clears all
    /// (used on stop).
    fn reset_automation_run_counts(&mut self, before_position_seconds: Option<f64>) {
        match before_position_seconds {
            None => self.automation_run_counts.clear(),
            Some(position) => {
                let cues = &self.automation.cues;
                self.automation_run_counts.retain(|cue_id, _| {
                    cues.iter()
                        .find(|cue| &cue.id == cue_id)
                        // Keep the count only for cues still behind the playhead;
                        // cues at/after the new position get re-armed.
                        .map(|cue| cue.at_seconds < position - 0.001)
                        .unwrap_or(false)
                });
            }
        }
    }

    /// Arm the next automation cue (job). The terminal jump — if the job has one
    /// — is scheduled sample-exact in the native engine at its effective time
    /// (`at_seconds + Σ pre-jump waits`); the job's pre-jump mix actions fire as
    /// the playhead crosses each one's effective time. Jobs without a jump are
    /// tracked as an `active_automation_job` and fire purely from the timeline.
    fn schedule_next_automation_jump(
        &mut self,
        audio: &AudioController,
    ) -> Result<(), DesktopError> {
        if self.engine.playback_state() != PlaybackState::Playing {
            return Ok(());
        }
        if self.engine.pending_marker_jump().is_some() || self.engine.active_vamp().is_some() {
            return Ok(());
        }

        let source_song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        let position_seconds = self.engine.position_seconds();

        // The next cue to arm is the earliest enabled cue still ahead of the
        // playhead. A cue's pre-jump actions may start firing once the playhead
        // is at/after at_seconds, so only arm cues strictly in the future here;
        // jobs already started are owned by pending_automation_jump / the active
        // job and re-armed on completion.
        let Some(cue) = self
            .automation
            .cues
            .iter()
            .filter(|cue| {
                cue.enabled
                    && cue.at_seconds > position_seconds + 0.001
                    // Skip cues that already hit their per-session run limit, so
                    // a "jump back" loop fires only the configured number of
                    // times and then the playhead passes through.
                    && self.cue_has_runs_left(cue)
            })
            .min_by(|left, right| {
                left.at_seconds
                    .partial_cmp(&right.at_seconds)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .cloned()
        else {
            self.pending_automation_jump = None;
            self.active_automation_job = None;
            return Ok(());
        };

        let timed_actions = cue.timed_pre_jump_actions();

        let Some(AutomationAction::Jump {
            target,
            transition,
            mix_scene_id,
        }) = cue.jump_action().cloned()
        else {
            // Pure mix/scene/wait job: nothing to schedule natively. Track it so
            // the per-tick advance fires its actions on time.
            self.pending_automation_jump = None;
            self.active_automation_job = Some(ActiveAutomationJob {
                cue_id: cue.id.clone(),
                timed_actions: timed_actions
                    .into_iter()
                    .map(|(offset, action)| (cue.at_seconds + offset, action))
                    .collect(),
                fired_count: 0,
            });
            return Ok(());
        };

        // Job with a terminal jump. Effective jump time accounts for waits.
        self.active_automation_job = None;
        let execute_at_seconds = cue.at_seconds + cue.pre_jump_wait_seconds();
        let target_seconds = automation_target_source_seconds(&source_song, &target)?;
        let trigger_seconds = warp_timeline_seconds_at(&source_song, execute_at_seconds);
        let target_view_seconds = Some(warp_timeline_seconds_at(&source_song, target_seconds));
        let native_target = match &target {
            AutomationJumpTarget::Marker { marker_id } => NativeJumpTarget {
                kind: NativeJumpTargetKind::Marker,
                id: Some(marker_id.clone()),
                frame: None,
            },
            AutomationJumpTarget::Region { region_id } => NativeJumpTarget {
                kind: NativeJumpTargetKind::Region,
                id: Some(region_id.clone()),
                frame: None,
            },
            AutomationJumpTarget::Frame { .. } => NativeJumpTarget {
                kind: NativeJumpTargetKind::Frame,
                id: None,
                frame: None,
            },
        };

        self.last_native_scheduled_jump_executed_count = audio
            .engine_snapshot()
            .map(|snapshot| snapshot.pitch.mixer_scheduled_jump_executed_count)
            .unwrap_or(self.last_native_scheduled_jump_executed_count);
        audio.schedule_jump_at_frame(
            &cue.id,
            native_target,
            trigger_seconds,
            target_view_seconds,
            transition.mode == AutomationTransitionMode::FadeOut,
        )?;
        self.pending_automation_jump = Some(PendingAutomationJump {
            cue_id: cue.id,
            cue_name: cue.name,
            execute_at_seconds,
            target,
            mix_scene_id,
            fade_out_seconds: (transition.mode == AutomationTransitionMode::FadeOut)
                .then_some(transition.duration_seconds.unwrap_or(0.35).max(0.0)),
            fade_started: false,
            timed_actions: timed_actions
                .into_iter()
                .map(|(offset, action)| (cue.at_seconds + offset, action))
                .collect(),
            fired_count: 0,
        });

        Ok(())
    }

    /// Apply a single non-jump job action immediately (mute/solo/mix/scene).
    fn apply_automation_action(
        &mut self,
        action: &AutomationAction,
        audio: &AudioController,
    ) -> Result<(), DesktopError> {
        match action {
            AutomationAction::SetTrackMute { track_id, muted } => {
                audio.update_live_track_mix(track_id, None, None, Some(*muted), None, None)?;
            }
            AutomationAction::SetTrackSolo { track_id, solo } => {
                audio.update_live_track_mix(track_id, None, None, None, Some(*solo), None)?;
            }
            AutomationAction::SetTrackMix {
                track_id,
                volume,
                pan,
                ..
            } => {
                // Ramps are not yet honoured by the live mix bridge; apply the
                // target value immediately (ramp is a future enhancement).
                audio.update_live_track_mix(track_id, *volume, *pan, None, None, None)?;
            }
            AutomationAction::ApplyScene { scene_id } => {
                self.apply_mix_scene_runtime(scene_id, audio)?;
            }
            // Jump and Wait are handled by the scheduler/executor, not here.
            AutomationAction::Jump { .. } | AutomationAction::Wait { .. } => {}
        }
        Ok(())
    }

    /// Fire any job pre-jump actions whose effective time the playhead has now
    /// reached. Drives both jump-jobs (via `pending_automation_jump`) and pure
    /// jobs (via `active_automation_job`). Pure jobs end when fully fired.
    fn advance_automation_job_actions(
        &mut self,
        audio: &AudioController,
    ) -> Result<(), DesktopError> {
        if self.engine.playback_state() != PlaybackState::Playing {
            return Ok(());
        }
        let position_seconds = self.engine.position_seconds();

        // Collect the actions that became due, then apply them (split borrow).
        let mut due: Vec<AutomationAction> = Vec::new();
        if let Some(pending) = self.pending_automation_jump.as_mut() {
            while pending.fired_count < pending.timed_actions.len()
                && pending.timed_actions[pending.fired_count].0 <= position_seconds + 0.001
            {
                due.push(pending.timed_actions[pending.fired_count].1.clone());
                pending.fired_count += 1;
            }
        }
        let mut pure_job_done = false;
        let mut pure_job_cue_id: Option<String> = None;
        if let Some(job) = self.active_automation_job.as_mut() {
            while job.fired_count < job.timed_actions.len()
                && job.timed_actions[job.fired_count].0 <= position_seconds + 0.001
            {
                due.push(job.timed_actions[job.fired_count].1.clone());
                job.fired_count += 1;
            }
            pure_job_done = job.fired_count >= job.timed_actions.len();
            if pure_job_done {
                pure_job_cue_id = Some(job.cue_id.clone());
            }
        }

        for action in due {
            self.apply_automation_action(&action, audio)?;
        }

        // A pure (jumpless) job ends once all its actions have fired; count the
        // run and arm the next cue so consecutive jobs chain.
        if pure_job_done {
            self.active_automation_job = None;
            if let Some(cue_id) = pure_job_cue_id {
                self.record_automation_cue_run(&cue_id);
            }
            self.schedule_next_automation_jump(audio)?;
        }

        Ok(())
    }

    fn apply_mix_scene_runtime(
        &mut self,
        scene_id: &str,
        audio: &AudioController,
    ) -> Result<(), DesktopError> {
        let Some(scene) = self
            .automation
            .mix_scenes
            .iter()
            .find(|scene| scene.id == scene_id)
            .cloned()
        else {
            return Ok(());
        };

        let song = self.engine.song_mut()?;
        for override_ in scene.track_overrides {
            if let Some(track) = song
                .tracks
                .iter_mut()
                .find(|track| track.id == override_.track_id)
            {
                let volume = override_.volume.map(|volume| volume.clamp(0.0, 1.0));
                let pan = override_.pan.map(|pan| pan.clamp(-1.0, 1.0));
                if let Some(volume) = volume {
                    track.volume = volume.clamp(0.0, 1.0);
                }
                if let Some(pan) = pan {
                    track.pan = pan.clamp(-1.0, 1.0);
                }
                if let Some(muted) = override_.muted {
                    track.muted = muted;
                }
                if let Some(solo) = override_.solo {
                    track.solo = solo;
                }
                audio.update_live_track_mix(
                    &track.id,
                    volume,
                    pan,
                    override_.muted,
                    override_.solo,
                    None,
                )?;
            }
        }

        Ok(())
    }

    fn start_pending_automation_fade_if_due(
        &mut self,
        audio: &AudioController,
    ) -> Result<(), DesktopError> {
        let position_seconds = self.engine.position_seconds();
        let Some(pending) = self.pending_automation_jump.as_mut() else {
            return Ok(());
        };
        let Some(duration_seconds) = pending.fade_out_seconds else {
            return Ok(());
        };
        if pending.fade_started {
            return Ok(());
        }
        if position_seconds + 0.001 >= (pending.execute_at_seconds - duration_seconds).max(0.0) {
            audio.start_master_fade(0.0, duration_seconds)?;
            pending.fade_started = true;
        }
        Ok(())
    }

    fn schedule_native_marker_jump(
        &self,
        audio: &AudioController,
        source_song: &Song,
        pending_jump: &PendingMarkerJump,
    ) -> Result<(), DesktopError> {
        let target_seconds = source_song
            .marker_by_id(&pending_jump.target_marker_id)
            .map(|marker| warp_timeline_seconds_at(source_song, marker.start_seconds));
        let trigger_seconds =
            warp_timeline_seconds_at(source_song, pending_jump.execute_at_seconds);
        if jump_debug_logging_enabled() {
            eprintln!(
                "[LT_JUMP_DEBUG][state] native_marker_schedule target={} source_execute={:.9} view_execute={:.9} view_target={:?}",
                pending_jump.target_marker_id,
                pending_jump.execute_at_seconds,
                trigger_seconds,
                target_seconds
            );
        }
        audio.schedule_jump_at_frame(
            &pending_jump.target_marker_id,
            NativeJumpTarget {
                kind: NativeJumpTargetKind::Marker,
                id: Some(pending_jump.target_marker_id.clone()),
                frame: None,
            },
            trigger_seconds,
            target_seconds,
            true,
        )
    }

    fn schedule_native_region_jump(
        &self,
        audio: &AudioController,
        source_song: &Song,
        pending_jump: &PendingMarkerJump,
    ) -> Result<(), DesktopError> {
        if pending_jump.trigger == JumpTrigger::RegionEnd {
            return audio.schedule_region_end_jump(
                &pending_jump.target_marker_id,
                &pending_jump.target_marker_id,
                matches!(pending_jump.transition, TransitionType::FadeOut { .. }),
            );
        }

        let target_seconds = source_song
            .regions
            .iter()
            .find(|region| region.id == pending_jump.target_marker_id)
            .map(|region| warp_timeline_seconds_at(source_song, region.start_seconds));
        let trigger_seconds =
            warp_timeline_seconds_at(source_song, pending_jump.execute_at_seconds);
        if jump_debug_logging_enabled() {
            eprintln!(
                "[LT_JUMP_DEBUG][state] native_region_schedule target={} source_execute={:.9} view_execute={:.9} view_target={:?}",
                pending_jump.target_marker_id,
                pending_jump.execute_at_seconds,
                trigger_seconds,
                target_seconds
            );
        }
        audio.schedule_jump_at_frame(
            &pending_jump.target_marker_id,
            NativeJumpTarget {
                kind: NativeJumpTargetKind::Region,
                id: Some(pending_jump.target_marker_id.clone()),
                frame: None,
            },
            trigger_seconds,
            target_seconds,
            matches!(pending_jump.transition, TransitionType::FadeOut { .. }),
        )
    }

    fn reschedule_pending_jump_after_song_update(
        &mut self,
        audio: &AudioController,
        source_song: &Song,
        pending_jump: PendingMarkerJump,
    ) -> Result<(), DesktopError> {
        if source_song
            .marker_by_id(&pending_jump.target_marker_id)
            .is_some()
        {
            let scheduled = self.engine.schedule_marker_jump_with_song(
                source_song,
                &pending_jump.target_marker_id,
                pending_jump.trigger,
                pending_jump.transition,
            )?;
            if let Some(next_pending) = scheduled.as_ref() {
                self.schedule_native_marker_jump(audio, source_song, next_pending)?;
            } else {
                audio.cancel_scheduled_jumps()?;
            }
            return Ok(());
        }

        if source_song
            .regions
            .iter()
            .any(|region| region.id == pending_jump.target_marker_id)
        {
            let scheduled = self.engine.schedule_region_jump_with_song(
                source_song,
                &pending_jump.target_marker_id,
                pending_jump.trigger,
                pending_jump.transition,
            )?;
            if let Some(next_pending) = scheduled.as_ref() {
                self.schedule_native_region_jump(audio, source_song, next_pending)?;
            } else {
                audio.cancel_scheduled_jumps()?;
            }
            return Ok(());
        }

        audio.cancel_scheduled_jumps()
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
        // View-time → source-time conversion, see create_section_marker.
        let timeline_start_seconds = source_seconds_at_view(&song, timeline_start_seconds);
        let new_start = normalize_timeline_start_seconds(timeline_start_seconds);
        let clip_duration = song
            .clips
            .iter()
            .find(|clip| clip.id == clip_id)
            .map(|clip| clip.duration_seconds)
            .ok_or_else(|| DesktopError::ClipNotFound(clip_id.to_string()))?;

        // Reshape the regions first (auto-create or auto-extend) so the
        // move never produces a transient state where the clip lives
        // outside every region.
        ensure_region_covers_clip(&mut song, new_start, new_start + clip_duration)?;

        let clip = song
            .clips
            .iter_mut()
            .find(|clip| clip.id == clip_id)
            .ok_or_else(|| DesktopError::ClipNotFound(clip_id.to_string()))?;
        clip.timeline_start_seconds = new_start;
        prune_empty_regions(&mut song);
        prune_auto_created_empty_tracks(&mut song);
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
        // View-time → source-time conversion, see create_section_marker.
        let timeline_start_seconds = source_seconds_at_view(&song, timeline_start_seconds);
        let new_start = normalize_timeline_start_seconds(timeline_start_seconds);
        let clip_duration = song
            .clips
            .iter()
            .find(|clip| clip.id == clip_id)
            .map(|clip| clip.duration_seconds)
            .ok_or_else(|| DesktopError::ClipNotFound(clip_id.to_string()))?;

        ensure_region_covers_clip(&mut song, new_start, new_start + clip_duration)?;

        let clip = song
            .clips
            .iter_mut()
            .find(|clip| clip.id == clip_id)
            .ok_or_else(|| DesktopError::ClipNotFound(clip_id.to_string()))?;
        clip.timeline_start_seconds = new_start;
        prune_empty_regions(&mut song);
        prune_auto_created_empty_tracks(&mut song);
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

    pub fn move_clips_batch(
        &mut self,
        moves: &[ClipMoveRequest],
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        if moves.is_empty() {
            return Ok(self.snapshot());
        }

        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;

        apply_clip_moves_with_region_reshape(&mut song, moves)?;
        prune_empty_regions(&mut song);
        prune_auto_created_empty_tracks(&mut song);
        refresh_song_duration(&mut song);
        self.persist_song_update(song, audio, AudioChangeImpact::TimelineWindow, true)?;

        Ok(self.snapshot())
    }

    pub fn move_clips_live_batch(
        &mut self,
        moves: &[ClipMoveRequest],
        audio: &AudioController,
    ) -> Result<(), DesktopError> {
        if moves.is_empty() {
            return Ok(());
        }

        self.sync_position(audio)?;
        self.capture_live_history_anchor();

        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;

        apply_clip_moves_with_region_reshape(&mut song, moves)?;
        prune_empty_regions(&mut song);
        prune_auto_created_empty_tracks(&mut song);
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
        self.delete_clips(&[clip_id.to_string()], audio)
    }

    /// Batched deletion. Removes every id in `clip_ids` in a single
    /// persist_song_update, so a multi-clip delete is one engine reload
    /// + one history entry instead of N. Missing ids are tolerated
    /// silently (could have been pruned by a previous cascade) — the
    /// only hard error is the whole batch missing.
    pub fn delete_clips(
        &mut self,
        clip_ids: &[String],
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        if clip_ids.is_empty() {
            return Err(DesktopError::ClipNotFound(String::new()));
        }
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        let id_set: HashSet<&str> = clip_ids.iter().map(String::as_str).collect();
        let before_count = song.clips.len();
        song.clips.retain(|clip| !id_set.contains(clip.id.as_str()));
        if song.clips.len() == before_count {
            // None of the ids matched. Surface the first one so the
            // error message is concrete.
            return Err(DesktopError::ClipNotFound(
                clip_ids.first().cloned().unwrap_or_default(),
            ));
        }

        // Per the song-model plan (step 4.5), a region that loses its
        // last clip is auto-deleted. The whole operation rides on a
        // single persist_song_update so undo restores the clips AND the
        // region together.
        prune_empty_regions(&mut song);
        prune_auto_created_empty_tracks(&mut song);

        refresh_song_duration(&mut song);
        self.persist_song_update(song, audio, AudioChangeImpact::StructureRebuild, true)?;

        Ok(self.snapshot())
    }

    /// Reassign a clip to a different track without changing its position
    /// on the timeline. Backs the compact view's right-click "Mover a
    /// track…" submenu. If the clip's original track was auto-created and
    /// loses its only clip in the process, the track is removed from the
    /// project so the mixer doesn't accumulate one-shot tracks.
    pub fn move_clip_to_track(
        &mut self,
        clip_id: &str,
        target_track_id: &str,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;

        let target_kind = song
            .tracks
            .iter()
            .find(|track| track.id == target_track_id)
            .map(|track| track.kind)
            .ok_or_else(|| DesktopError::TrackNotFound(target_track_id.to_string()))?;
        if target_kind == libretracks_core::TrackKind::Folder {
            return Err(DesktopError::AudioCommand(
                "no se puede mover un clip a un folder".into(),
            ));
        }

        let clip = song
            .clips
            .iter_mut()
            .find(|clip| clip.id == clip_id)
            .ok_or_else(|| DesktopError::ClipNotFound(clip_id.to_string()))?;
        if clip.track_id == target_track_id {
            return Ok(self.snapshot());
        }
        clip.track_id = target_track_id.to_string();

        prune_auto_created_empty_tracks(&mut song);
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

        clip.timeline_start_seconds = normalize_timeline_start_seconds(timeline_start_seconds);
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
        self.duplicate_clips(&[(clip_id.to_string(), timeline_start_seconds)], audio)
    }

    pub fn duplicate_clips(
        &mut self,
        placements: &[(String, f64)],
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        if placements.is_empty() {
            return Ok(self.snapshot());
        }

        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;

        let source_clips = placements
            .iter()
            .map(|(clip_id, timeline_start_seconds)| {
                let source_clip = song
                    .clips
                    .iter()
                    .find(|clip| clip.id == *clip_id)
                    .cloned()
                    .ok_or_else(|| DesktopError::ClipNotFound(clip_id.clone()))?;
                Ok((source_clip, *timeline_start_seconds))
            })
            .collect::<Result<Vec<_>, DesktopError>>()?;

        let timestamp = timestamp_suffix();
        for (index, (source_clip, timeline_start_seconds)) in source_clips.into_iter().enumerate() {
            let mut duplicated_clip = source_clip;
            duplicated_clip.id = format!("clip_{timestamp}_{index}");
            // View → source first (warp-aware mapping), then normalize so the
            // duplicated clip never lands at a negative timeline position.
            // Mirrors the pattern used by paste_clips and create_section_marker.
            duplicated_clip.timeline_start_seconds = normalize_timeline_start_seconds(
                source_seconds_at_view(&song, timeline_start_seconds),
            );
            song.clips.push(duplicated_clip);
        }
        refresh_song_duration(&mut song);

        self.persist_song_update(song, audio, AudioChangeImpact::TimelineWindow, true)?;

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
        // The frontend hands us a click in view-time (the rendered timeline,
        // after warp/varispeed). Markers/regions/clips are stored in
        // source-time, so we have to undo the timeline mapping or the marker
        // will land at the wrong stored offset inside or after a
        // stretched region.
        let start_seconds = source_seconds_at_view(&song, start_seconds).max(0.0);
        let marker_name = song.next_marker_name();
        song.section_markers.push(Marker {
            id: format!("section_{}", timestamp_suffix()),
            name: marker_name,
            start_seconds,
            digit: None,
            // New markers start untyped; the user picks a kind in the editor.
            kind: MarkerKind::Custom,
            variant: None,
        });
        song.section_markers.sort_by(|left, right| {
            left.start_seconds
                .partial_cmp(&right.start_seconds)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        audio.update_live_section_markers(&song)?;
        self.persist_song_update(song, audio, AudioChangeImpact::MixerOnly, true)?;

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

        // View → source: see comment in create_section_marker.
        let start_seconds = source_seconds_at_view(&song, start_seconds).max(0.0);

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

        audio.update_live_section_markers(&song)?;
        self.persist_song_update(song, audio, AudioChangeImpact::MixerOnly, true)?;

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

        audio.update_live_section_markers(&song)?;
        self.persist_song_update(song, audio, AudioChangeImpact::MixerOnly, true)?;

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
        // View-time → source-time conversion, see create_section_marker.
        let start_seconds = source_seconds_at_view(&song, start_seconds);
        let end_seconds = source_seconds_at_view(&song, end_seconds);
        let (start_seconds, end_seconds) =
            sanitize_region_bounds(&song, start_seconds, end_seconds)?;
        let region_index = song.regions.len();
        let region_name = audio
            .current_settings()
            .ok()
            .and_then(|settings| settings.locale)
            .map(|locale| locale.to_ascii_lowercase())
            .map(|locale| match locale.as_str() {
                "es" => format!("Canción {}", region_index + 1),
                _ => format!("Song {}", region_index + 1),
            })
            .unwrap_or_else(|| format!("Song {}", region_index + 1));
        let region = SongRegion {
            id: format!("region_{}_{}", timestamp_suffix(), region_index),
            name: region_name,
            start_seconds,
            end_seconds,
            transpose_semitones: 0,
            warp_enabled: false,
            warp_source_bpm: None,
            master: libretracks_core::SongMaster::default(),
        };

        replace_song_region_range(&mut song, region);
        audio.update_live_song_regions(&song)?;
        self.persist_song_update(song, audio, AudioChangeImpact::TransportOnly, true)?;

        Ok(self.snapshot())
    }

    /// Create an empty song (region) at the end of the current timeline,
    /// separated from the previous song by one bar of silence. The region
    /// itself is one bar wide so it's visible in the DAW view; the moment
    /// the user drops a clip into it the region will resize to fit (see
    /// ensure_region_covers_clip).
    ///
    /// Only used by the compact view's "+ Nueva canción" button. In the
    /// DAW view, regions are still created implicitly when clips drop onto
    /// empty timeline.
    pub fn create_empty_song(
        &mut self,
        name: Option<&str>,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;

        // Anchor: end of the last existing region (in source-time), or 0 if
        // this is the first song in the project.
        let anchor_source_seconds = song
            .regions
            .iter()
            .map(|region| region.end_seconds)
            .fold(0.0_f64, f64::max);

        // The first song in a fresh project starts at bar 1 (no leading
        // silence). For subsequent songs we want the boundary to be on a
        // real downbeat — using `lastEnd + one bar at the local BPM`
        // breaks when the previous song ended off-grid (trimmed region,
        // mid-bar tempo change, etc.), so we ask the song's tempo map
        // for the next downbeat at or after `anchor_source_seconds`.
        // Both offsets stay in source-time so they survive warp without
        // shifting visually.
        let is_first_region = song.regions.is_empty();
        let start_seconds = if is_first_region {
            0.0
        } else {
            next_downbeat_after_in_song(&song, anchor_source_seconds)
        };
        let bar_seconds = bar_seconds_at(&song, start_seconds);
        let end_seconds = start_seconds + bar_seconds;

        let region_index = song.regions.len();
        let region_name = name
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| {
                let locale = audio
                    .current_settings()
                    .ok()
                    .and_then(|settings| settings.locale)
                    .map(|locale| locale.to_ascii_lowercase());
                match locale.as_deref() {
                    Some("es") => format!("Canción {}", region_index + 1),
                    _ => format!("Song {}", region_index + 1),
                }
            });

        let region = SongRegion {
            id: format!("region_{}_{}", timestamp_suffix(), region_index),
            name: region_name,
            start_seconds,
            end_seconds,
            transpose_semitones: 0,
            warp_enabled: false,
            warp_source_bpm: None,
            master: libretracks_core::SongMaster::default(),
        };

        song.regions.push(region);
        sort_song_regions(&mut song.regions);

        // Anchor the new song to the project's global bpm so it doesn't
        // inherit the previous song's tempo marker. Without this any tempo
        // marker the user placed earlier would still be in effect at the
        // new song's start. We add the marker only when the new song is not
        // at t=0 (markers at the very start collapse into song.bpm anyway,
        // see upsert_song_tempo_marker for the same threshold) and only if
        // there isn't already a marker at the same position.
        if start_seconds > 0.0001
            && !song
                .tempo_markers
                .iter()
                .any(|marker| (marker.start_seconds - start_seconds).abs() < 0.0001)
        {
            song.tempo_markers.push(TempoMarker {
                id: format!("tempo_marker_{}", timestamp_suffix()),
                start_seconds,
                bpm: song.bpm,
            });
            song.tempo_markers.sort_by(|left, right| {
                left.start_seconds
                    .partial_cmp(&right.start_seconds)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
        }

        audio.update_live_song_regions(&song)?;
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
        // View-time → source-time conversion, see create_section_marker.
        let start_seconds = source_seconds_at_view(&song, start_seconds);
        let end_seconds = source_seconds_at_view(&song, end_seconds);
        let (start_seconds, end_seconds) =
            sanitize_region_bounds(&song, start_seconds, end_seconds)?;
        let updated_region = SongRegion {
            id: existing_region.id.clone(),
            name: trimmed_name.to_string(),
            start_seconds,
            end_seconds,
            transpose_semitones: existing_region.transpose_semitones,
            warp_enabled: existing_region.warp_enabled,
            warp_source_bpm: existing_region.warp_source_bpm,
            master: existing_region.master.clone(),
        };

        // Resizing a region NEVER moves its contents — the region is
        // just the named span that contains the clips and markers, not
        // a transform on them. Extending the left edge adds empty room
        // before whatever's already in the song; shrinking either edge
        // reclaims unused space at the boundary. The user's mental
        // model is "I'm changing where the box starts/ends", not "I'm
        // sliding the box and everything inside it".
        //
        // We only need to validate that a shrink doesn't leave clips
        // dangling outside the new bounds. If it would, refuse the
        // resize with a clear message instead of letting the engine's
        // invariant reject the sync with a cryptic boundary error.
        let start_delta = updated_region.start_seconds - existing_region.start_seconds;
        let shrinks_left = start_delta > f64::EPSILON;
        let shrinks_right = updated_region.end_seconds < existing_region.end_seconds - f64::EPSILON;
        if shrinks_left || shrinks_right {
            let old_start = existing_region.start_seconds;
            let old_end = existing_region.end_seconds;
            let inside_old_region = |pos: f64| pos >= old_start - 0.001 && pos < old_end;
            let new_start = updated_region.start_seconds;
            let new_end = updated_region.end_seconds;
            for clip in &song.clips {
                if !inside_old_region(clip.timeline_start_seconds) {
                    continue;
                }
                let clip_end = clip.timeline_start_seconds + clip.duration_seconds;
                let starts_before_new = clip.timeline_start_seconds < new_start - 0.001;
                let ends_after_new = clip_end > new_end + 0.001;
                if starts_before_new || ends_after_new {
                    return Err(DesktopError::AudioCommand(format!(
                        "no se puede reducir la region: el clip '{}' quedaria fuera del \
                         nuevo rango. Elimina o mueve los clips afectados antes de \
                         reducir la region.",
                        clip.id,
                    )));
                }
            }
        }

        // Drop the OLD copy of this region before delegating to
        // replace_song_region_range. That helper fragments any pre-existing
        // region that overlaps the replacement — useful when CREATING a new
        // region that carves through existing ones, but wrong when editing
        // the same region in place. Without this step, shrinking a region
        // makes the helper see the old (larger) version "overlapping" the
        // new (smaller) one and emits a spurious fragment for the cut-off
        // tail (reproduced as: "drag the end handle inward → a phantom
        // duplicate region appears with the trimmed name and the cut-off
        // span").
        song.regions
            .retain(|region| region.id != existing_region.id);
        replace_song_region_range(&mut song, updated_region);
        audio.update_live_song_regions(&song)?;
        self.persist_song_update(song, audio, AudioChangeImpact::TransportOnly, true)?;

        Ok(self.snapshot())
    }

    /// Atomically translate an entire song by `delta_seconds`. Moves
    /// the region itself + every clip whose timeline_start_seconds
    /// fell inside the region + every tempo / section /
    /// time-signature marker that lived inside the region, all by
    /// the same delta. One persist_song_update, one snapshot, one
    /// undo entry. Rejects the move if it would collide with a
    /// neighbouring region (the validator backs us up here too, but
    /// failing fast gives the user a friendlier error than the
    /// "regions out of order" downstream rejection).
    pub fn move_song_region(
        &mut self,
        region_id: &str,
        delta_seconds: f64,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;

        if !delta_seconds.is_finite() {
            return Err(DesktopError::AudioCommand(
                "delta_seconds must be a finite number".into(),
            ));
        }

        let existing_region = song
            .regions
            .iter()
            .find(|region| region.id == region_id)
            .cloned()
            .ok_or_else(|| DesktopError::RegionNotFound(region_id.to_string()))?;

        let old_start = existing_region.start_seconds;
        let old_end = existing_region.end_seconds;
        let new_start = old_start + delta_seconds;
        let new_end = old_end + delta_seconds;

        if new_start < 0.0 {
            return Err(DesktopError::AudioCommand(
                "no se puede mover la canción antes del inicio del proyecto".into(),
            ));
        }

        // Collision policy is asymmetric:
        //
        //   * Moving RIGHT into a following region: cascade-push the
        //     following regions to the right by the amount needed to
        //     resolve the overlap. realign_regions_after_warp_tempo_change
        //     later re-snaps each one to its bar.1, so the cascade
        //     converges to a clean bar-aligned arrangement.
        //
        //   * Moving LEFT into a preceding region: bounce the operation.
        //     There is no symmetric "push left" because doing so could
        //     push the predecessor before t=0 and silently swallow
        //     audio. The user can move the predecessors first.
        //
        // EDGE_EPS lets back-to-back boundaries (end == start) count as
        // touching, not overlapping.
        const EDGE_EPS: f64 = 1e-4;
        if delta_seconds < 0.0 {
            for other in &song.regions {
                if other.id == existing_region.id {
                    continue;
                }
                let overlaps_left = new_start < other.end_seconds - EDGE_EPS
                    && new_end > other.start_seconds + EDGE_EPS
                    && other.start_seconds < old_start;
                if overlaps_left {
                    return Err(DesktopError::AudioCommand(format!(
                        "no se puede mover la canción ahí: solaparía con '{}'",
                        other.name,
                    )));
                }
            }
        }

        // Translate everything that lived inside the old region by
        // the same offset: clips by timeline_start, markers by
        // start_seconds. We treat "inside" with a 1ms tolerance on
        // the left edge so markers placed exactly at start move with
        // the song (typical case: the per-song tempo marker the
        // importer pins at the region start).
        let inside_old = |pos: f64| pos >= old_start - 0.001 && pos < old_end;

        for clip in &mut song.clips {
            if inside_old(clip.timeline_start_seconds) {
                clip.timeline_start_seconds =
                    (clip.timeline_start_seconds + delta_seconds).max(0.0);
            }
        }
        for marker in &mut song.tempo_markers {
            if inside_old(marker.start_seconds) {
                marker.start_seconds = (marker.start_seconds + delta_seconds).max(0.0);
            }
        }
        for marker in &mut song.section_markers {
            if inside_old(marker.start_seconds) {
                marker.start_seconds = (marker.start_seconds + delta_seconds).max(0.0);
            }
        }
        for marker in &mut song.time_signature_markers {
            if inside_old(marker.start_seconds) {
                marker.start_seconds = (marker.start_seconds + delta_seconds).max(0.0);
            }
        }

        // Cascade-push following regions if the rightward move would
        // overlap them. We find the smallest "following" region that
        // overlaps and push from its original start. shift_song_suffix
        // moves regions/clips/markers from anchor onward; the moved
        // region itself is excluded because at this point song still
        // contains it at its OLD position (we haven't replaced it yet).
        if delta_seconds > 0.0 {
            let mut push_anchor: Option<f64> = None;
            let mut push_delta: f64 = 0.0;
            for other in &song.regions {
                if other.id == existing_region.id {
                    continue;
                }
                if other.start_seconds <= old_start {
                    continue; // not a follower
                }
                let needed = new_end - other.start_seconds + EDGE_EPS;
                if needed > push_delta {
                    push_delta = needed;
                    push_anchor = Some(other.start_seconds);
                } else if push_anchor.is_none() && needed > 0.0 {
                    push_anchor = Some(other.start_seconds);
                }
            }
            if let (Some(anchor), true) = (push_anchor, push_delta > 0.0) {
                shift_song_suffix(&mut song, anchor, push_delta);
            }
        }

        let updated_region = SongRegion {
            id: existing_region.id.clone(),
            name: existing_region.name.clone(),
            start_seconds: new_start,
            end_seconds: new_end,
            transpose_semitones: existing_region.transpose_semitones,
            warp_enabled: existing_region.warp_enabled,
            warp_source_bpm: existing_region.warp_source_bpm,
            master: existing_region.master.clone(),
        };

        // Same rebuild flow as update_song_region: drop the old copy
        // then push the new one through replace_song_region_range so
        // the regions list stays sorted and consistent.
        song.regions
            .retain(|region| region.id != existing_region.id);
        replace_song_region_range(&mut song, updated_region);
        sort_song_regions(&mut song.regions);

        // Snap every region AFTER the moved one to the next downbeat
        // following its predecessor's end. We don't rely on the
        // "boundary was downbeat-aligned before" check from the
        // generic realign helper, because the cascade-push above can
        // displace successors by non-bar amounts (EDGE_EPS, or by
        // arbitrary deltas if the move's delta wasn't bar-quantised
        // — which the frontend allows). Unconditionally snapping the
        // tail to bar.1 matches the user expectation that "each song
        // sits on its own downbeat" after any move.
        snap_regions_after_to_downbeats(&mut song, &existing_region.id);

        refresh_song_duration(&mut song);
        audio.update_live_song_regions(&song)?;
        self.persist_song_update(song, audio, AudioChangeImpact::StructureRebuild, true)?;

        Ok(self.snapshot())
    }

    pub fn update_song_region_warp(
        &mut self,
        region_id: &str,
        warp_enabled: bool,
        warp_source_bpm: Option<f64>,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        // Validate the BPM mirror of the libretracks-core rule. Done here
        // (instead of relying on validate_song downstream) so the user gets a
        // specific error message and the engine never receives a bad value.
        if let Some(bpm) = warp_source_bpm {
            if !bpm.is_finite() {
                return Err(DesktopError::AudioCommand(
                    "warp source bpm must be a finite number".into(),
                ));
            }
            if !(libretracks_core::MIN_WARP_SOURCE_BPM..=libretracks_core::MAX_WARP_SOURCE_BPM)
                .contains(&bpm)
            {
                return Err(DesktopError::AudioCommand(format!(
                    "warp source bpm must be between {} and {}",
                    libretracks_core::MIN_WARP_SOURCE_BPM,
                    libretracks_core::MAX_WARP_SOURCE_BPM
                )));
            }
        } else if warp_enabled {
            return Err(DesktopError::AudioCommand(
                "warp source bpm is required when warp is enabled".into(),
            ));
        }

        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        let (live_warp_source_bpm, restore_tempo_on_disable) = {
            let region = song
                .regions
                .iter_mut()
                .find(|region| region.id == region_id)
                .ok_or_else(|| DesktopError::RegionNotFound(region_id.to_string()))?;

            region.warp_enabled = warp_enabled;
            if warp_source_bpm.is_some() {
                region.warp_source_bpm = warp_source_bpm;
            }

            let restore_tempo_on_disable = if warp_enabled {
                None
            } else {
                region
                    .warp_source_bpm
                    .map(|source_bpm| (region.start_seconds, source_bpm))
            };

            (region.warp_source_bpm, restore_tempo_on_disable)
        };

        if let Some((region_start_seconds, source_bpm)) = restore_tempo_on_disable {
            set_song_tempo_at_source_position(&mut song, region_start_seconds, source_bpm);
        }

        // Push the realtime command first so the engine swaps in the new ratio
        // on the next audio block. Persist as a timeline change because warp
        // also remaps clip/region lengths in the runtime timeline.
        audio.update_live_region_warp(region_id, warp_enabled, live_warp_source_bpm)?;
        self.persist_song_update_internal(
            song,
            audio,
            AudioChangeImpact::TimelineWindow,
            false,
            true,
        )?;

        Ok(self.snapshot())
    }

    pub fn update_song_region_transpose(
        &mut self,
        region_id: &str,
        transpose_semitones: i32,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        if !(MIN_TRANSPOSE_SEMITONES..=MAX_TRANSPOSE_SEMITONES).contains(&transpose_semitones) {
            return Err(DesktopError::AudioCommand(format!(
                "transpose semitones must be between {} and {}",
                MIN_TRANSPOSE_SEMITONES, MAX_TRANSPOSE_SEMITONES
            )));
        }

        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        let region = song
            .regions
            .iter_mut()
            .find(|region| region.id == region_id)
            .ok_or_else(|| DesktopError::RegionNotFound(region_id.to_string()))?;

        let record_history =
            self.should_record_transpose_history(TransposeHistoryTarget::Region(region.id.clone()));

        let changes_timeline = !region.warp_enabled;
        // Capture the values we'll need to compensate the songs that
        // follow this region, BEFORE we mutate it.
        let edited_region_id = region.id.clone();
        let edited_region_start = region.start_seconds;
        let edited_region_end = region.end_seconds;
        let edited_region_warp_enabled = region.warp_enabled;
        let previous_transpose = region.transpose_semitones;
        region.transpose_semitones = transpose_semitones;
        if jump_debug_logging_enabled() {
            eprintln!(
                "[LT_JUMP_DEBUG][state] region_transpose region={region_id} semitones={transpose_semitones} changes_timeline={changes_timeline}"
            );
        }

        // Varispeed compensation: changing a region's pitch with warp
        // OFF rescales its rendered duration on the timeline (Ableton
        // varispeed). Without compensation, every clip / region /
        // marker that lives AFTER the edited region's source range
        // would visually slide left or right because the renderer
        // applies the new shift. The user perception is "I changed
        // song 1's pitch and song 2 stopped starting on a bar".
        //
        // To keep the view-time of subsequent songs anchored, we
        // translate their stored source positions by the inverse of
        // the shift change introduced by the edit:
        //
        //   covered      = region.end - region.start         (source span)
        //   old_shift_per_region = covered / old_ratio - covered
        //   new_shift_per_region = covered / new_ratio - covered
        //   delta = old_shift_per_region - new_shift_per_region
        //         = covered * (1/old_ratio - 1/new_ratio)
        //
        // Adding `delta` to every downstream position keeps
        // warp_timeline_seconds_at(song, pos) constant after the edit.
        // Warp-enabled regions are NOT affected here — warp absorbs
        // the duration change into Bungee, so the rendered length
        // stays anchored to the timeline bpm and downstream view-
        // time is unchanged anyway.
        if changes_timeline && !edited_region_warp_enabled {
            let old_ratio = if previous_transpose != 0 {
                libretracks_core::semitones_to_pitch_scale(previous_transpose)
            } else {
                1.0
            };
            let new_ratio = if transpose_semitones != 0 {
                libretracks_core::semitones_to_pitch_scale(transpose_semitones)
            } else {
                1.0
            };
            let covered = (edited_region_end - edited_region_start).max(0.0);
            let old_shift = covered / old_ratio - covered;
            let new_shift = covered / new_ratio - covered;
            let delta = old_shift - new_shift;
            // Tolerance: only act when the delta would actually nudge
            // a sample. Skips the no-op case (e.g. user re-applied the
            // same semitones value via MIDI learn / stepper bounce).
            if delta.abs() > 1e-9 {
                // Translate every region, clip and marker whose source
                // position lies at or after the edited region's source
                // end. The edited region itself stays put — its
                // source bounds are unchanged; only its rendered
                // length scales because of the new pitch.
                for region_iter in song.regions.iter_mut() {
                    if region_iter.id == edited_region_id {
                        continue;
                    }
                    if region_iter.start_seconds >= edited_region_end - 1e-6 {
                        region_iter.start_seconds = (region_iter.start_seconds + delta).max(0.0);
                        region_iter.end_seconds = (region_iter.end_seconds + delta).max(0.0);
                    }
                }
                for clip in song.clips.iter_mut() {
                    if clip.timeline_start_seconds >= edited_region_end - 1e-6 {
                        clip.timeline_start_seconds =
                            (clip.timeline_start_seconds + delta).max(0.0);
                    }
                }
                for marker in song.tempo_markers.iter_mut() {
                    if marker.start_seconds >= edited_region_end - 1e-6 {
                        marker.start_seconds = (marker.start_seconds + delta).max(0.0);
                    }
                }
                for marker in song.section_markers.iter_mut() {
                    if marker.start_seconds >= edited_region_end - 1e-6 {
                        marker.start_seconds = (marker.start_seconds + delta).max(0.0);
                    }
                }
                for marker in song.time_signature_markers.iter_mut() {
                    if marker.start_seconds >= edited_region_end - 1e-6 {
                        marker.start_seconds = (marker.start_seconds + delta).max(0.0);
                    }
                }
                sort_song_regions(&mut song.regions);
                refresh_song_duration(&mut song);
            }
        }
        if changes_timeline {
            // Warp off means pitch is varispeed: changing semitones changes
            // the rendered timeline length, so clips, regions and markers
            // must all be resent in runtime/view time.
            self.persist_song_update_internal(
                song,
                audio,
                AudioChangeImpact::TimelineWindow,
                record_history,
                true,
            )?;
        } else {
            // Warp absorbs duration, so region transpose is pitch-only.
            audio.update_live_region_transpose(region_id, transpose_semitones)?;
            self.persist_song_update_internal(
                song,
                audio,
                AudioChangeImpact::MixerOnly,
                record_history,
                true,
            )?;
        }
        self.last_runtime_pitch = Some(audio.pitch_prepare_summary());

        Ok(self.snapshot())
    }

    pub fn update_song_region_master_gain(
        &mut self,
        region_id: &str,
        master_gain: f64,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        if !master_gain.is_finite() || master_gain < 0.0 {
            return Err(DesktopError::AudioCommand(
                "master gain must be a finite, non-negative number".into(),
            ));
        }

        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        let region = song
            .regions
            .iter_mut()
            .find(|region| region.id == region_id)
            .ok_or_else(|| DesktopError::RegionNotFound(region_id.to_string()))?;
        region.master.gain = master_gain;

        audio.update_live_region_master_gain(region_id, master_gain as f32)?;
        self.persist_song_update(song, audio, AudioChangeImpact::MixerOnly, true)?;

        Ok(self.snapshot())
    }

    pub fn update_track_transpose_enabled(
        &mut self,
        track_id: &str,
        transpose_enabled: bool,
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

        let record_history =
            self.should_record_transpose_history(TransposeHistoryTarget::Track(track.id.clone()));

        track.transpose_enabled = transpose_enabled;

        // Send the realtime command first — C++ handles the session clone + pitch stream
        // rebuild via CmdSetTrackTransposeEnabled. MixerOnly skips the LoadSession path
        // so we don't trigger a redundant full session reload on top.
        audio.set_track_transpose_enabled_realtime(track_id, transpose_enabled)?;
        self.persist_song_update_internal(
            song,
            audio,
            AudioChangeImpact::MixerOnly,
            record_history,
            true,
        )?;
        self.last_runtime_pitch = Some(audio.pitch_prepare_summary());

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

        // Snapshot the region bounds before removing so we can also evict
        // any clips and tempo markers that live inside its range. Without
        // this the clips would survive past the region's removal and break
        // the "clip lives inside one region" invariant (step 4.1), and
        // stale tempo markers would keep affecting playback at positions
        // the user thought were gone with the song.
        let region_start = song.regions[region_index].start_seconds;
        let region_end = song.regions[region_index].end_seconds;

        song.regions.remove(region_index);
        song.clips.retain(|clip| {
            clip.timeline_start_seconds < region_start || clip.timeline_start_seconds >= region_end
        });
        song.tempo_markers.retain(|marker| {
            marker.start_seconds < region_start || marker.start_seconds >= region_end
        });

        sort_song_regions(&mut song.regions);
        // Pruning auto-created tracks whose only clip(s) lived inside the
        // deleted region keeps the mixer view tidy without an extra round
        // trip — same prune we already apply on clip move / delete paths.
        prune_auto_created_empty_tracks(&mut song);
        refresh_song_duration(&mut song);

        audio.update_live_song_regions(&song)?;
        self.persist_song_update(song, audio, AudioChangeImpact::StructureRebuild, true)?;

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

        // MixerOnly: section markers are Rust-model-only. C++ does not read them.
        self.persist_song_update(song, audio, AudioChangeImpact::MixerOnly, true)?;

        Ok(self.snapshot())
    }

    pub fn set_section_marker_kind(
        &mut self,
        section_id: &str,
        kind: MarkerKind,
        variant: Option<u8>,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;

        let marker = song
            .section_markers
            .iter_mut()
            .find(|section| section.id == section_id)
            .ok_or_else(|| DesktopError::SectionNotFound(section_id.to_string()))?;
        marker.kind = kind;
        marker.variant = variant;

        // Section markers ARE read by the engine voice guide (kind+variant pick
        // the announcement clip), so push them live as well as persisting.
        audio.update_live_section_markers(&song)?;
        self.persist_song_update(song, audio, AudioChangeImpact::MixerOnly, true)?;

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
        let previous_song = song.clone();
        song.bpm = bpm;
        realign_regions_after_warp_tempo_change(&previous_song, &mut song);

        let impact = if song_has_active_warp(&song) {
            AudioChangeImpact::TimelineWindow
        } else {
            AudioChangeImpact::TransportOnly
        };
        self.persist_song_update(song, audio, impact, true)?;

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
        // View-time → source-time conversion, see create_section_marker.
        let previous_song = song.clone();
        let clamped_start_seconds = source_seconds_at_view(&song, start_seconds).max(0.0);

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
        realign_regions_after_warp_tempo_change(&previous_song, &mut song);

        let impact = if song_has_active_warp(&song) {
            AudioChangeImpact::TimelineWindow
        } else {
            AudioChangeImpact::TransportOnly
        };
        self.persist_song_update(song, audio, impact, true)?;

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
        let previous_song = song.clone();
        let marker_index = song
            .tempo_markers
            .iter()
            .position(|marker| marker.id == marker_id)
            .ok_or_else(|| DesktopError::AudioCommand("tempo marker not found".into()))?;
        song.tempo_markers.remove(marker_index);
        realign_regions_after_warp_tempo_change(&previous_song, &mut song);

        let impact = if song_has_active_warp(&song) {
            AudioChangeImpact::TimelineWindow
        } else {
            AudioChangeImpact::TransportOnly
        };
        self.persist_song_update(song, audio, impact, true)?;

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
        // View-time → source-time conversion, see create_section_marker.
        let clamped_start_seconds = source_seconds_at_view(&song, start_seconds).max(0.0);

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
    ) -> Result<SongPackageImportResponse, DesktopError> {
        let song_dir = self.song_dir.clone().ok_or(DesktopError::NoSongLoaded)?;
        let song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        let mut imported = import_song_package_into_project(
            &song_dir,
            &song,
            Path::new(package_path),
            insert_at_seconds,
        )?;
        // Self-contained packages carry their audio: copy it into this project's
        // audio/ folder and re-point the imported clips before anything else
        // touches the source paths.
        place_bundled_audio_and_repoint(&song_dir, &mut imported.song, &imported.bundled_audio)?;
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
        let loaded_song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        self.prime_waveform_cache(&song_dir, &loaded_song)?;
        audio.wait_until_sources_ready(Duration::from_secs(120))?;
        // Read-only cache population (migrates any global/legacy .ltpeaks). Misses
        // are generated on demand by the frontend's normal waveform requests
        // post-import, so no background enqueue / AppHandle is needed here.
        let _ = self.populate_waveform_cache_readonly(&song_dir, &loaded_song);
        let runtime_position_seconds =
            self.runtime_seconds_for_engine_position(self.current_position());
        audio.prepare_playback_at(loaded_song, runtime_position_seconds)?;
        Ok(SongPackageImportResponse {
            snapshot: self.snapshot(),
            library_assets,
        })
    }

    // Same as `import_song_package` but skips the blocking source-ready wait
    // and waveform/playback prep — the caller (the dialog flow) drives those
    // through `wait_for_project_audio_preparation` so the loading bar can show
    // per-source progress instead of freezing on a generic "syncing" overlay.
    fn import_song_package_no_wait(
        &mut self,
        app: &AppHandle,
        package_path: &str,
        insert_at_seconds: f64,
        audio: &AudioController,
    ) -> Result<SongPackageImportResponse, DesktopError> {
        let song_dir = self.song_dir.clone().ok_or(DesktopError::NoSongLoaded)?;
        let song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        emit_project_load_progress(app, 7, "Descomprimiendo paquete...".into(), 0, 0, 0, 0);
        let mut imported = import_song_package_into_project(
            &song_dir,
            &song,
            Path::new(package_path),
            insert_at_seconds,
        )?;
        emit_project_load_progress(app, 10, "Copiando audio del paquete...".into(), 0, 0, 0, 0);
        place_bundled_audio_and_repoint(&song_dir, &mut imported.song, &imported.bundled_audio)?;
        emit_project_load_progress(
            app,
            13,
            "Actualizando libreria de la sesion...".into(),
            0,
            0,
            0,
            0,
        );
        let mut library_assets = list_library_assets(&song_dir, Some(&imported.song))?;
        merge_package_library_meta(
            &song_dir,
            &mut library_assets,
            &imported.library_meta,
            Some(&imported.package_title),
        )?;
        write_library_manifest_assets(&song_dir, &library_assets)?;
        emit_project_load_progress(
            app,
            16,
            "Aplicando cambios al proyecto...".into(),
            0,
            0,
            0,
            0,
        );
        self.persist_song_update(
            imported.song,
            audio,
            AudioChangeImpact::StructureRebuild,
            true,
        )?;
        let loaded_song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        emit_project_load_progress(app, 18, "Preparando formas de onda...".into(), 0, 0, 0, 0);
        self.prime_waveform_cache(&song_dir, &loaded_song)?;
        Ok(SongPackageImportResponse {
            snapshot: self.snapshot(),
            library_assets,
        })
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

        let audio_to = if parent_track_id.is_some() {
            "inherit".to_string()
        } else {
            "master".to_string()
        };

        let track = Track {
            id: format!("track_{}", timestamp_suffix()),
            name: trimmed_name.to_string(),
            kind,
            parent_track_id: parent_track_id.map(str::to_string),
            volume: 1.0,
            pan: 0.0,
            muted: false,
            solo: false,
            transpose_enabled: true,
            audio_to,
            color: None,
            auto_created: false,
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

        // Each request carries `timeline_start_seconds` in view-time (the
        // user dragged the clip to a visible point on the timeline). Convert
        // to source-time before append so warp/varispeed regions don't shift
        // the clip away from where the user dropped it.
        let mapped_requests: Vec<CreateClipRequest> = requests
            .iter()
            .map(|req| CreateClipRequest {
                track_id: req.track_id.clone(),
                file_path: req.file_path.clone(),
                timeline_start_seconds: source_seconds_at_view(&song, req.timeline_start_seconds),
            })
            .collect();
        for request in &mapped_requests {
            append_clip_to_song(&mut song, &song_dir, request)?;
        }
        refresh_song_duration(&mut song);

        self.persist_song_update(song, audio, AudioChangeImpact::StructureRebuild, true)?;

        Ok(self.snapshot())
    }

    /// Drop a list of audio files onto a song column in the compact view.
    /// Each file gets its own auto-created audio track (named after the
    /// file stem), and a clip pointing at that track. All clips land at
    /// the same `timeline_start_seconds` — the start of the target song —
    /// per the user's request "drop N files into a column → N rows".
    pub fn create_clips_with_auto_tracks(
        &mut self,
        requests: &[CreateClipWithAutoTrackRequest],
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

        for (offset, request) in requests.iter().enumerate() {
            let source_start_seconds =
                source_seconds_at_view(&song, request.timeline_start_seconds);
            let track_name = file_stem_for_auto_track(&request.file_path);
            let track_id = format!(
                "track_{}_{}",
                timestamp_suffix(),
                song.tracks.len() + offset,
            );
            song.tracks.push(libretracks_core::Track {
                id: track_id.clone(),
                name: track_name,
                kind: libretracks_core::TrackKind::Audio,
                parent_track_id: None,
                volume: 1.0,
                pan: 0.0,
                muted: false,
                solo: false,
                transpose_enabled: true,
                audio_to: "master".to_string(),
                color: None,
                auto_created: true,
            });
            append_clip_to_song(
                &mut song,
                &song_dir,
                &CreateClipRequest {
                    track_id,
                    file_path: request.file_path.clone(),
                    timeline_start_seconds: source_start_seconds,
                },
            )?;
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

    /// RuntimeUpdateKind: ModelOnly — update track name/metadata. No audio command sent.
    /// `updateTrack` (frontend) routes here when only name is present and no mix fields.
    pub fn update_track_metadata(
        &mut self,
        track_id: &str,
        name: &str,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        self.sync_position(audio)?;
        self.push_history_entry();
        self.redo_stack.clear();
        self.update_loaded_track(track_id, Some(name), None, None, None, None, None)?;
        self.perf_metrics.song_save_millis = 0;
        self.project_revision = self.project_revision.saturating_add(1);
        audio.record_commit_model_only();
        Ok(self.snapshot())
    }

    /// Kept for backwards-compat alias — delegates to update_track_metadata.
    pub fn update_track_color(
        &mut self,
        track_id: &str,
        color: Option<&str>,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        self.sync_position(audio)?;
        self.push_history_entry();
        self.redo_stack.clear();

        let color = normalize_ui_color(color)?;
        let track = self
            .engine
            .song_mut()?
            .tracks
            .iter_mut()
            .find(|track| track.id == track_id)
            .ok_or_else(|| DesktopError::TrackNotFound(track_id.to_string()))?;
        track.color = color;

        self.perf_metrics.song_save_millis = 0;
        self.project_revision = self.project_revision.saturating_add(1);
        audio.record_commit_model_only();
        Ok(self.snapshot())
    }

    pub fn update_clip_color(
        &mut self,
        clip_id: &str,
        color: Option<&str>,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        self.sync_position(audio)?;
        self.push_history_entry();
        self.redo_stack.clear();

        let color = normalize_ui_color(color)?;
        let clip = self
            .engine
            .song_mut()?
            .clips
            .iter_mut()
            .find(|clip| clip.id == clip_id)
            .ok_or_else(|| DesktopError::ClipNotFound(clip_id.to_string()))?;
        clip.color = color;

        self.perf_metrics.song_save_millis = 0;
        self.project_revision = self.project_revision.saturating_add(1);
        audio.record_commit_model_only();
        Ok(self.snapshot())
    }

    #[allow(dead_code)]
    pub fn update_track_name_only(
        &mut self,
        track_id: &str,
        name: &str,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        self.update_track_metadata(track_id, name, audio)
    }

    /// RuntimeUpdateKind: TargetedRealtimeCommand — commit mixer state (volume/pan/muted/solo/route)
    /// to the Rust model and send exactly one targeted Category A command to C++.
    /// This is the ONLY path that may touch both the Rust model AND the live mixer for these fields.
    pub fn commit_track_mix_model_and_command(
        &mut self,
        track_id: &str,
        volume: Option<f64>,
        pan: Option<f64>,
        muted: Option<bool>,
        solo: Option<bool>,
        audio_to: Option<&str>,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        self.sync_position(audio)?;
        self.push_history_entry();
        self.redo_stack.clear();

        self.update_loaded_track(track_id, None, volume, pan, muted, solo, audio_to)?;
        // Category A: one targeted command per changed field. No broad sync. No LoadSession.
        audio.update_live_track_mix(track_id, volume, pan, muted, solo, audio_to)?;
        audio.record_commit_mix();

        self.perf_metrics.song_save_millis = 0;
        self.project_revision = self.project_revision.saturating_add(1);
        Ok(self.snapshot())
    }

    /// Generic update_track is kept ONLY for structural/admin callers that must change
    /// both name and mix in a single operation (e.g. undo/redo replay).
    /// Mix fields (volume/pan/muted/solo/audio_to) route through commit_track_mix_model_and_command
    /// internally. Name changes route through update_track_metadata.
    /// Prefer the explicit methods above for new call sites.
    pub fn update_track(
        &mut self,
        track_id: &str,
        name: Option<&str>,
        volume: Option<f64>,
        pan: Option<f64>,
        muted: Option<bool>,
        solo: Option<bool>,
        audio_to: Option<&str>,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        self.sync_position(audio)?;
        self.push_history_entry();
        self.redo_stack.clear();

        self.update_loaded_track(track_id, name, volume, pan, muted, solo, audio_to)?;
        if volume.is_some()
            || pan.is_some()
            || muted.is_some()
            || solo.is_some()
            || audio_to.is_some()
        {
            // Category A: one targeted command per changed field. No broad sync.
            audio.update_live_track_mix(track_id, volume, pan, muted, solo, audio_to)?;
            audio.record_commit_mix();
        } else if name.is_some() {
            audio.record_commit_model_only();
        }

        self.perf_metrics.song_save_millis = 0;
        self.project_revision = self.project_revision.saturating_add(1);
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

        self.persist_song_update(song, audio, AudioChangeImpact::StructureRebuild, true)?;

        Ok(self.snapshot())
    }

    pub fn split_clip(
        &mut self,
        clip_id: &str,
        split_seconds: f64,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        self.split_clips(&[clip_id.to_string()], split_seconds, audio)
    }

    /// Splits every clip whose timeline span contains `split_seconds_view`
    /// in a single transaction. Used by the timeline context menu's
    /// "Split at cursor" action when the click target is part of a
    /// multi-selection — every selected clip the cursor crosses gets
    /// split, the ones it doesn't cross are left untouched. A single
    /// `persist_song_update` keeps the engine, the project revision,
    /// and the history entry coherent.
    pub fn split_clips(
        &mut self,
        clip_ids: &[String],
        split_seconds_view: f64,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        if clip_ids.is_empty() {
            return Err(DesktopError::ClipNotFound(String::new()));
        }

        // `timeline_start_seconds` and `duration_seconds` are stored in
        // view-time, so the split point comparison stays in view-time too.
        // We only convert to source-time when computing the right-hand
        // clip's `source_start_seconds`, which is the only field that
        // actually lives in the underlying audio file's clock.
        let split_seconds_source = source_seconds_at_view(&song, split_seconds_view);
        let suffix_base = timestamp_suffix();
        let mut any_split = false;
        let mut last_invalid_clip: Option<String> = None;

        for (offset, clip_id) in clip_ids.iter().enumerate() {
            let clip_index = match song.clips.iter().position(|clip| clip.id == *clip_id) {
                Some(index) => index,
                None => continue,
            };
            let clip = song.clips[clip_index].clone();
            let clip_end = clip.timeline_start_seconds + clip.duration_seconds;
            if split_seconds_view <= clip.timeline_start_seconds || split_seconds_view >= clip_end {
                last_invalid_clip = Some(clip_id.clone());
                continue;
            }

            let left_duration = split_seconds_view - clip.timeline_start_seconds;
            let right_duration = clip_end - split_seconds_view;
            // Source-time offset of the cut inside the original audio. With
            // warp off this collapses to `left_duration`; with warp on it
            // accounts for the stretch ratio in this region.
            let split_seconds_source_clip =
                source_seconds_at_view(&song, clip.timeline_start_seconds + left_duration);
            let source_left_duration = (split_seconds_source_clip
                - source_seconds_at_view(&song, clip.timeline_start_seconds))
            .max(0.0);

            let left_clip = Clip {
                id: format!("clip_{}_{}_l", suffix_base, offset),
                duration_seconds: left_duration,
                ..clip.clone()
            };
            let right_clip = Clip {
                id: format!("clip_{}_{}_r", suffix_base, offset),
                timeline_start_seconds: split_seconds_view,
                source_start_seconds: clip.source_start_seconds + source_left_duration,
                duration_seconds: right_duration,
                ..clip
            };

            song.clips
                .splice(clip_index..=clip_index, [left_clip, right_clip]);
            any_split = true;
        }

        if !any_split {
            // No clip contained the split point — surface a clear error
            // instead of an opaque engine roundtrip with no-op state.
            return Err(DesktopError::InvalidSplitPoint);
        }

        // Suppress an unused-variable warning on the diagnostic-only path
        // where every clip in the batch was outside the cursor.
        let _ = (split_seconds_source, last_invalid_clip);

        self.persist_song_update(song, audio, AudioChangeImpact::StructureRebuild, true)?;
        Ok(self.snapshot())
    }

    pub fn snapshot_with_sync(
        &mut self,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let now = Instant::now();
        let playback_is_running = self.engine.playback_state() == PlaybackState::Playing;
        let sync_interval = if playback_is_running {
            TRANSPORT_RUNTIME_SYNC_INTERVAL
        } else {
            TRANSPORT_PITCH_SYNC_INTERVAL
        };
        let should_sync_runtime = self
            .last_transport_runtime_sync_at
            .map(|last_sync| now.duration_since(last_sync) >= sync_interval)
            .unwrap_or(true);
        let should_sync_pitch = self
            .last_transport_pitch_sync_at
            .map(|last_sync| now.duration_since(last_sync) >= TRANSPORT_PITCH_SYNC_INTERVAL)
            .unwrap_or(true);

        if should_sync_runtime {
            self.sync_position(audio)?;
            self.last_transport_runtime_sync_at = Some(now);
        }

        if should_sync_pitch {
            self.last_runtime_pitch = Some(audio.pitch_prepare_summary());
            self.last_transport_pitch_sync_at = Some(now);
        }

        if playback_is_running {
            return Ok(self.snapshot_with_runtime_transport(audio));
        }

        Ok(self.snapshot())
    }

    #[allow(dead_code)]
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
        // LoadSession (via replace_song_buffers) initializes the complete C++ mixer runtime:
        // gain, pan, mute, solo, audio_to, transpose_behavior, folder parent chains.
        // No Rust broad sync is needed after this point.
        audio.replace_song_buffers(&song_dir, &song, "session_load")?;

        self.transport_clock.stop();
        self.song_dir = Some(song_dir.clone());
        self.song_file_path = Some(song_dir.join(SONG_FILE_NAME));
        self.last_drift_sample = None;
        self.automation = load_automation(&song_dir)
            .map_err(|error| DesktopError::AudioCommand(error.to_string()))?;
        self.pending_automation_jump = None;
        self.active_automation_job = None;
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
        self.prime_waveform_cache(&song_dir, &loaded_song)?;

        Ok(())
    }

    fn wait_for_project_audio_preparation(
        &mut self,
        app: &AppHandle,
        audio: &AudioController,
    ) -> Result<(), DesktopError> {
        const TIMEOUT: Duration = Duration::from_secs(120);
        const POLL_INTERVAL: Duration = Duration::from_millis(50);
        // The loader reserves visible bands for each blocking phase so cached
        // projects still show meaningful progress instead of jumping 2 -> 96.
        // 0..18: file/model/session, 18..80: source/cache readiness,
        // 80..92: waveforms + first-play cache, 92..99: prearmed jump voices.
        const SOURCES_BASE: u8 = 18;
        const SOURCES_SPAN: u8 = 62;
        let started_at = Instant::now();
        let mut last_ready = usize::MAX;
        let mut last_total = usize::MAX;
        let mut last_percent = u8::MAX;

        loop {
            // engine_snapshot() uses try_lock and returns Err if the lock is
            // contended (e.g. meter polling holds it). Don't propagate — that
            // would abort the whole open flow. Just back off and retry on the
            // next iteration so the loop survives temporary contention.
            let snapshot = match audio.engine_snapshot() {
                Ok(s) => s,
                Err(_) => {
                    if started_at.elapsed() >= TIMEOUT {
                        return Ok(());
                    }
                    thread::sleep(POLL_INTERVAL);
                    continue;
                }
            };
            let total = snapshot.source_states.len();
            let ready = snapshot
                .source_states
                .iter()
                .filter(|source| {
                    matches!(
                        source.status.as_str(),
                        "ready" | "cache_ready" | "failed" | "cancelled"
                    )
                })
                .count();
            let failures = snapshot
                .source_states
                .iter()
                .filter(|source| source.status == "failed")
                .count();
            let source_progress_sum = snapshot
                .source_states
                .iter()
                .map(|source| {
                    if matches!(
                        source.status.as_str(),
                        "ready" | "cache_ready" | "failed" | "cancelled"
                    ) {
                        100_usize
                    } else {
                        source.progress_percent.clamp(0, 99) as usize
                    }
                })
                .sum::<usize>();
            let ram_cache_mb = (snapshot.source_cache.ram_bytes_used / (1024 * 1024)) as usize;
            let disk_cache_mb = (snapshot.source_cache.disk_bytes_used / (1024 * 1024)) as usize;

            let percent = if total == 0 {
                SOURCES_BASE
            } else {
                SOURCES_BASE
                    + ((source_progress_sum * SOURCES_SPAN as usize) / (total * 100))
                        .min(SOURCES_SPAN as usize) as u8
            };
            // Emit on every ready/total change so the UI shows 1/31 → 2/31 …
            // not just the few percent-step boundaries.
            if ready != last_ready || total != last_total || percent != last_percent {
                last_ready = ready;
                last_total = total;
                last_percent = percent;
                let message = if total == 0 {
                    "Inicializando preparacion de audio...".to_string()
                } else if failures > 0 {
                    format!("Preparando audio... {ready}/{total} fuentes ({failures} con error)")
                } else {
                    format!("Preparando audio... {ready}/{total} fuentes")
                };
                emit_project_load_progress(
                    app,
                    percent,
                    message,
                    ready,
                    total,
                    ram_cache_mb,
                    disk_cache_mb,
                );
            }

            // Empty project (no sources): give the engine a brief moment to
            // register sources from LoadSession, then short-circuit straight
            // to 100% so the loader doesn't hang on "Inicializando..." forever
            // for projects that legitimately contain no audio.
            if total == 0 && started_at.elapsed() >= Duration::from_millis(300) {
                emit_project_load_progress(
                    app,
                    100,
                    "Proyecto listo para reproducir.".into(),
                    0,
                    0,
                    ram_cache_mb,
                    disk_cache_mb,
                );
                return Ok(());
            }

            if total > 0 && ready >= total {
                self.finish_project_audio_preparation(
                    app,
                    audio,
                    ready,
                    total,
                    ram_cache_mb,
                    disk_cache_mb,
                )?;
                return Ok(());
            }
            if started_at.elapsed() >= TIMEOUT {
                emit_project_load_progress(
                    app,
                    percent,
                    "El proyecto se abrio; la preparacion continua en segundo plano.".into(),
                    ready,
                    total,
                    ram_cache_mb,
                    disk_cache_mb,
                );
                return Ok(());
            }

            thread::sleep(POLL_INTERVAL);
        }
    }

    pub fn wait_for_project_audio_preparation_unlocked(
        app: &AppHandle,
        state: &DesktopState,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        const TIMEOUT: Duration = Duration::from_secs(120);
        const POLL_INTERVAL: Duration = Duration::from_millis(50);
        const SOURCES_BASE: u8 = 18;
        const SOURCES_SPAN: u8 = 62;
        let started_at = Instant::now();
        let mut last_ready = usize::MAX;
        let mut last_total = usize::MAX;
        let mut last_percent = u8::MAX;
        loop {
            let snapshot = match audio.engine_snapshot() {
                Ok(s) => s,
                Err(_) => {
                    if started_at.elapsed() >= TIMEOUT {
                        let mut session = state
                            .session
                            .lock()
                            .map_err(|_| DesktopError::StatePoisoned)?;
                        return Ok(session.snapshot());
                    }
                    thread::sleep(POLL_INTERVAL);
                    continue;
                }
            };
            let total = snapshot.source_states.len();
            let ready = snapshot
                .source_states
                .iter()
                .filter(|source| {
                    matches!(
                        source.status.as_str(),
                        "ready" | "cache_ready" | "failed" | "cancelled"
                    )
                })
                .count();
            let failures = snapshot
                .source_states
                .iter()
                .filter(|source| source.status == "failed")
                .count();
            let source_progress_sum = snapshot
                .source_states
                .iter()
                .map(|source| {
                    if matches!(
                        source.status.as_str(),
                        "ready" | "cache_ready" | "failed" | "cancelled"
                    ) {
                        100_usize
                    } else {
                        source.progress_percent.clamp(0, 99) as usize
                    }
                })
                .sum::<usize>();
            let ram_cache_mb = (snapshot.source_cache.ram_bytes_used / (1024 * 1024)) as usize;
            let disk_cache_mb = (snapshot.source_cache.disk_bytes_used / (1024 * 1024)) as usize;
            let percent = if total == 0 {
                SOURCES_BASE
            } else {
                SOURCES_BASE
                    + ((source_progress_sum * SOURCES_SPAN as usize) / (total * 100))
                        .min(SOURCES_SPAN as usize) as u8
            };

            if ready != last_ready || total != last_total || percent != last_percent {
                last_ready = ready;
                last_total = total;
                last_percent = percent;
                let message = if total == 0 {
                    "Inicializando preparacion de audio...".to_string()
                } else if failures > 0 {
                    format!("Preparando audio... {ready}/{total} fuentes ({failures} con error)")
                } else {
                    format!("Preparando audio... {ready}/{total} fuentes")
                };
                emit_project_load_progress(
                    app,
                    percent,
                    message,
                    ready,
                    total,
                    ram_cache_mb,
                    disk_cache_mb,
                );
            }

            if total == 0 && started_at.elapsed() >= Duration::from_millis(300) {
                emit_project_load_progress(
                    app,
                    100,
                    "Proyecto listo para reproducir.".into(),
                    0,
                    0,
                    ram_cache_mb,
                    disk_cache_mb,
                );
                let mut session = state
                    .session
                    .lock()
                    .map_err(|_| DesktopError::StatePoisoned)?;
                return Ok(session.snapshot());
            }

            if total > 0 && ready >= total {
                let mut session = state
                    .session
                    .lock()
                    .map_err(|_| DesktopError::StatePoisoned)?;
                session.finish_project_audio_preparation(
                    app,
                    audio,
                    ready,
                    total,
                    ram_cache_mb,
                    disk_cache_mb,
                )?;
                return Ok(session.snapshot());
            }

            if started_at.elapsed() >= TIMEOUT {
                emit_project_load_progress(
                    app,
                    percent,
                    "El proyecto se abrio; la preparacion continua en segundo plano.".into(),
                    ready,
                    total,
                    ram_cache_mb,
                    disk_cache_mb,
                );
                let mut session = state
                    .session
                    .lock()
                    .map_err(|_| DesktopError::StatePoisoned)?;
                return Ok(session.snapshot());
            }

            thread::sleep(POLL_INTERVAL);
        }
    }

    fn finish_project_audio_preparation(
        &mut self,
        app: &AppHandle,
        audio: &AudioController,
        ready: usize,
        total: usize,
        ram_cache_mb: usize,
        disk_cache_mb: usize,
    ) -> Result<(), DesktopError> {
        let song_opt = self.engine.song().cloned();
        if let Some(song) = song_opt {
            let song_dir = self.song_dir.clone().ok_or(DesktopError::NoSongLoaded)?;
            emit_project_load_progress(
                app,
                84,
                "Preparando waveforms...".into(),
                ready,
                total,
                ram_cache_mb,
                disk_cache_mb,
            );
            self.ensure_project_waveforms_ready(app, &song_dir, &song)?;
            emit_project_load_progress(
                app,
                88,
                "Waveforms preparadas.".into(),
                ready,
                total,
                ram_cache_mb,
                disk_cache_mb,
            );
            let runtime_position_seconds =
                self.runtime_seconds_for_engine_position(self.current_position());
            emit_project_load_progress(
                app,
                90,
                "Preparando cache inicial de reproduccion...".into(),
                ready,
                total,
                ram_cache_mb,
                disk_cache_mb,
            );
            audio.prepare_playback_at(song.clone(), runtime_position_seconds)?;
            emit_project_load_progress(
                app,
                92,
                "Preparando voces para reproduccion instantanea...".into(),
                ready,
                total,
                ram_cache_mb,
                disk_cache_mb,
            );
            self.wait_for_prearm_idle(app, audio, ready, total)?;
            let prepared_snapshot = audio.engine_snapshot()?;
            let ram_cache_mb =
                (prepared_snapshot.source_cache.ram_bytes_used / (1024 * 1024)) as usize;
            let disk_cache_mb =
                (prepared_snapshot.source_cache.disk_bytes_used / (1024 * 1024)) as usize;
            emit_project_load_progress(
                app,
                99,
                "Audio preparado. Construyendo vista del proyecto...".into(),
                ready,
                total,
                ram_cache_mb,
                disk_cache_mb,
            );
            return Ok(());
        }
        emit_project_load_progress(
            app,
            99,
            "Audio preparado. Construyendo vista del proyecto...".into(),
            ready,
            total,
            ram_cache_mb,
            disk_cache_mb,
        );
        Ok(())
    }

    fn wait_for_prearm_idle(
        &self,
        app: &AppHandle,
        audio: &AudioController,
        ready: usize,
        total: usize,
    ) -> Result<(), DesktopError> {
        // Bungee voice priming for marker/region/song targets runs on a
        // background worker after LoadSession. Without waiting here, the first
        // Play after open pays the ~80ms × voices × markers warm cost on the
        // audio thread → multi-second silence before sound starts. Bound the
        // wait so a stuck worker can't freeze the open flow forever.
        const PREARM_TIMEOUT: Duration = Duration::from_secs(30);
        const POLL_INTERVAL: Duration = Duration::from_millis(50);
        const STABLE_REQUIRED: u32 = 3; // ~150ms of idle to absorb re-post races
        const MIN_POSTS: u64 = 2; // initial (sources empty) + re-post once all decoded
        let started_at = Instant::now();
        let mut last_emitted_percent = 92_u8;
        let mut stable_polls: u32 = 0;
        loop {
            let snapshot = match audio.engine_snapshot() {
                Ok(s) => s,
                Err(_) => {
                    if started_at.elapsed() >= PREARM_TIMEOUT {
                        return Ok(());
                    }
                    thread::sleep(POLL_INTERVAL);
                    continue;
                }
            };
            let prearm = &snapshot.prearmed_jumps;
            // The first prearm post (from LoadSession) fires before sources
            // are decoded, so the worker returns in ~0ms with nothing built
            // (ready_count=0). The REAL build only happens after the
            // source_ready callback re-posts once every source is decoded —
            // that's the post we actually need to wait for. So require:
            //   - at least 2 posts have been seen, AND
            //   - completed has caught up to posted, AND
            //   - the prepared cache actually contains voices (ready_count>0)
            //     OR the session legitimately has zero targets (no markers /
            //     regions), in which case prepared_total stays 0 and we'll
            //     bail via the timeout / no-targets check.
            let has_prepared_targets = prearm.ready_count > 0 || prearm.prepared_total > 0;
            let has_no_targets = prearm.active_target_total == 0
                && prearm.ready_count == 0
                && prearm.prepared_total == 0;
            let active_targets_complete = prearm.active_target_total == 0
                || prearm.active_target_completed >= prearm.active_target_total;
            let counters_idle = prearm.completed_count >= prearm.posted_count
                && (prearm.posted_count >= MIN_POSTS || has_prepared_targets || has_no_targets);
            let latest_revision_complete = prearm.latest_posted_revision > 0
                && prearm.last_completed_revision >= prearm.latest_posted_revision
                && active_targets_complete
                && (has_prepared_targets || has_no_targets);
            let idle = !prearm.worker_busy && (counters_idle || latest_revision_complete);
            if idle {
                stable_polls = stable_polls.saturating_add(1);
                if stable_polls >= STABLE_REQUIRED {
                    return Ok(());
                }
            } else {
                stable_polls = 0;
            }
            if started_at.elapsed() >= PREARM_TIMEOUT {
                return Ok(());
            }
            let active_progress = if prearm.active_target_total > 0 {
                let completed = prearm
                    .active_target_completed
                    .min(prearm.active_target_total) as f32;
                let total = prearm.active_target_total as f32;
                (completed / total).clamp(0.0, 1.0)
            } else {
                let elapsed_secs = (started_at.elapsed().as_millis() / 1_000).min(7) as f32;
                (elapsed_secs / 7.0).clamp(0.0, 1.0)
            };
            // Reserve 99% for the moment the worker is actually idle. This
            // prevents the UI from showing 99% while there is still a long
            // tail of target preparation work left.
            let percent = if idle {
                99
            } else {
                92_u8 + (active_progress * 6.0).floor() as u8
            };
            if percent != last_emitted_percent {
                last_emitted_percent = percent;
                let ram_cache_mb = (snapshot.source_cache.ram_bytes_used / (1024 * 1024)) as usize;
                let disk_cache_mb =
                    (snapshot.source_cache.disk_bytes_used / (1024 * 1024)) as usize;
                emit_project_load_progress(
                    app,
                    percent,
                    "Preparando voces para reproduccion instantanea...".into(),
                    ready,
                    total,
                    ram_cache_mb,
                    disk_cache_mb,
                );
            }
            thread::sleep(POLL_INTERVAL);
        }
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

        // MixerOnly: C++ already has the correct state via a realtime command.
        // Just update the Rust model; skip LoadSession and audio restart entirely.
        // We still seek + reschedule any pending marker jump since engine.load_song clears engine
        // state and pending jumps compute execute_at_seconds relative to the seek position.
        if impact == AudioChangeImpact::MixerOnly {
            self.engine.load_song(song)?;
            // load_song resets playback_state to Stopped — restore it so snapshot()
            // returns the correct state and the UI doesn't briefly show "detenido".
            match playback_state {
                PlaybackState::Playing => {
                    let _ = self.engine.play();
                }
                PlaybackState::Paused => {
                    let _ = self.engine.pause();
                }
                _ => {}
            }
            if bump_revision {
                self.project_revision = self.project_revision.saturating_add(1);
            }
            self.engine.seek(position_seconds)?;
            if let Some(pending_jump) = pending_jump {
                let loaded_song = self
                    .engine
                    .song()
                    .cloned()
                    .ok_or(DesktopError::NoSongLoaded)?;
                self.reschedule_pending_jump_after_song_update(audio, &loaded_song, pending_jump)?;
            }
            return Ok(());
        }

        match impact {
            AudioChangeImpact::TimelineWindow if playback_state != PlaybackState::Playing => {
                // Timeline-only edits with already-known sources can stay Rust-side while idle.
                // The native engine will receive the current song on the next Play/Seek.
            }
            AudioChangeImpact::TimelineWindow | AudioChangeImpact::StructureRebuild => {
                if playback_state == PlaybackState::Playing {
                    if impact == AudioChangeImpact::TimelineWindow {
                        audio.update_live_timeline_window(&song)?;
                    } else {
                        audio.replace_song_buffers(&song_dir, &song, "structure_rebuild")?;
                    }
                } else {
                    // Not playing: still push the updated session to the engine so
                    // it can decode the newly-added sources in the background
                    // while the user is busy (waveform analyzing, arranging clips,
                    // etc). Otherwise the first Play after dropping audio has to
                    // decode all clips synchronously — 3-4s for MP3 with ~7 tracks.
                    // sync_song is cheap when the signature hasn't changed (early
                    // return in ensure_song_loaded).
                    audio.sync_song(song.clone())?;
                }
            }
            AudioChangeImpact::TransportOnly => {
                // Tempo and meter changes must reach the native session immediately so the
                // metronome follows the new grid in realtime, even before audio warp exists.
                audio.update_live_song_timing(&song)?;
            }
            AudioChangeImpact::MixerOnly => {}
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

        if let Some(pending_jump) = pending_jump {
            self.reschedule_pending_jump_after_song_update(audio, &loaded_song, pending_jump)?;
        }

        match playback_state {
            PlaybackState::Playing => {
                self.engine.play()?;
                match impact {
                    AudioChangeImpact::MixerOnly | AudioChangeImpact::TransportOnly => {}
                    AudioChangeImpact::TimelineWindow => {
                        self.reposition_audio(audio, PlaybackStartReason::TransportResync)?
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

    fn should_record_transpose_history(&mut self, target: TransposeHistoryTarget) -> bool {
        let now = Instant::now();
        let should_group = self.transpose_history_group.as_ref().is_some_and(|group| {
            group.target == target
                && now.duration_since(group.recorded_at) <= Duration::from_millis(750)
        });

        self.transpose_history_group = Some(TransposeHistoryGroup {
            target,
            recorded_at: now,
        });

        !should_group
    }

    fn update_loaded_track(
        &mut self,
        track_id: &str,
        name: Option<&str>,
        volume: Option<f64>,
        pan: Option<f64>,
        muted: Option<bool>,
        solo: Option<bool>,
        audio_to: Option<&str>,
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

        if let Some(audio_to) = audio_to {
            let trimmed = audio_to.trim();
            track.audio_to = if trimmed.is_empty() {
                "master".to_string()
            } else {
                trimmed.to_ascii_lowercase()
            };
        }

        self.transpose_history_group = None;

        Ok(())
    }

    pub fn undo_action(
        &mut self,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        self.live_history_anchor = None;
        self.transpose_history_group = None;
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
        self.transpose_history_group = None;
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

    pub(crate) fn current_position(&self) -> f64 {
        self.transport_clock
            .current_position(self.engine.playback_state())
    }

    fn runtime_transport_position(&self, audio: &AudioController) -> Option<(f64, bool)> {
        if self.engine.playback_state() != PlaybackState::Playing {
            return None;
        }

        let source_song = self.engine.song()?;
        let snapshot = audio.engine_snapshot().ok()?;
        if !matches!(
            snapshot.playback_state,
            lt_audio_engine_v2::PlaybackState::Playing
        ) {
            return None;
        }

        Some((
            source_seconds_at_view(source_song, snapshot.current_seconds.max(0.0)),
            !snapshot.transport_pending_start,
        ))
    }

    fn runtime_seconds_for_engine_position(&self, position_seconds: f64) -> f64 {
        self.engine
            .song()
            .map(|song| warp_timeline_seconds_at(song, position_seconds))
            .unwrap_or(position_seconds)
    }

    fn sync_position(&mut self, audio: &AudioController) -> Result<(), DesktopError> {
        if self.engine.playback_state() != PlaybackState::Playing {
            return Ok(());
        }

        if self.sync_native_scheduled_jump_if_needed(audio)? {
            return Ok(());
        }

        if let Some((runtime_source_position, _running)) = self.runtime_transport_position(audio) {
            self.engine
                .sync_position_preserving_transport_state(runtime_source_position)?;
            self.transport_clock
                .reanchor_playing(runtime_source_position);
            if let (Some(source_song), Some(active_vamp)) =
                (self.engine.song(), self.engine.active_vamp())
            {
                self.schedule_native_vamp_jump(audio, source_song, active_vamp)?;
                return Ok(());
            }
            if self.engine.pending_marker_jump().is_some() {
                return Ok(());
            }
            // Fire any job pre-jump mix actions whose effective time the
            // playhead has reached (runs for both jump-jobs and pure jobs).
            self.advance_automation_job_actions(audio)?;
            self.start_pending_automation_fade_if_due(audio)?;
            if self.pending_automation_jump.is_some() {
                return Ok(());
            }
        }

        let elapsed = self.transport_clock.elapsed_since_anchor();
        let previous_position = self.engine.position_seconds();
        let wrapped_vamp_start = self.engine.active_vamp().and_then(|active_vamp| {
            (previous_position + elapsed >= active_vamp.end_seconds)
                .then_some(active_vamp.start_seconds)
        });
        let wrapped_by_vamp = wrapped_vamp_start.is_some();
        let source_song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        let (mut advanced_position, jump_executed) = self
            .engine
            .advance_transport_with_song(&source_song, elapsed)?;

        if let Some(duration_seconds) = self.engine.take_pending_fade_out_request() {
            audio.start_master_fade(0.0, duration_seconds)?;
            self.transport_clock.reanchor_playing(advanced_position);
            return Ok(());
        }
        self.start_pending_automation_fade_if_due(audio)?;

        if let Some(duration_seconds) = self.engine.pending_fade_duration_seconds() {
            if self
                .engine
                .pending_fade_elapsed_seconds()
                .is_some_and(|elapsed_seconds| elapsed_seconds >= duration_seconds)
            {
                if let Some(target_position) = self
                    .engine
                    .complete_pending_fade_jump_with_song(&source_song)?
                {
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

        if wrapped_by_vamp && !jump_executed {
            if let Some(vamp_start_seconds) = wrapped_vamp_start {
                if jump_debug_logging_enabled() {
                    eprintln!(
                        "[LT_JUMP_DEBUG][state] vamp_wrap_quantized previous={:.9} computed={:.9} quantized={:.9}",
                        previous_position,
                        advanced_position,
                        vamp_start_seconds
                    );
                }
                self.engine.seek(vamp_start_seconds)?;
                advanced_position = vamp_start_seconds;
            }
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

    fn sync_native_scheduled_jump_if_needed(
        &mut self,
        audio: &AudioController,
    ) -> Result<bool, DesktopError> {
        let snapshot = match audio.engine_snapshot() {
            Ok(snapshot) => snapshot,
            Err(_) => return Ok(false),
        };
        let executed_count = snapshot.pitch.mixer_scheduled_jump_executed_count;
        if executed_count <= self.last_native_scheduled_jump_executed_count {
            return Ok(false);
        }

        if jump_debug_logging_enabled() {
            eprintln!(
                "[LT_JUMP_DEBUG][state] native_count_advanced previous_count={} executed_count={} rust_position={:.9}",
                self.last_native_scheduled_jump_executed_count,
                executed_count,
                self.engine.position_seconds()
            );
        }
        self.last_native_scheduled_jump_executed_count = executed_count;

        let Some(pending_jump) = self.engine.pending_marker_jump().cloned() else {
            if let Some(active_vamp) = self.engine.active_vamp().cloned() {
                let source_song = self
                    .engine
                    .song()
                    .cloned()
                    .ok_or(DesktopError::NoSongLoaded)?;
                let runtime_source_position =
                    source_seconds_at_view(&source_song, snapshot.current_seconds.max(0.0));
                if jump_debug_logging_enabled() {
                    eprintln!(
                        "[LT_JUMP_DEBUG][state] native_vamp_jump_completed runtime={:.9} vamp_start={:.9} vamp_end={:.9}",
                        runtime_source_position,
                        active_vamp.start_seconds,
                        active_vamp.end_seconds
                    );
                }
                self.engine
                    .sync_position_preserving_transport_state(runtime_source_position)?;
                self.transport_clock
                    .note_jump_while_playing(runtime_source_position);
                self.capture_transport_drift_sample(
                    audio,
                    "native_vamp_jump",
                    runtime_source_position,
                    runtime_source_position,
                );
                self.schedule_native_vamp_jump(audio, &source_song, &active_vamp)?;
                return Ok(true);
            }

            if let Some(pending_automation) = self.pending_automation_jump.take() {
                let source_song = self
                    .engine
                    .song()
                    .cloned()
                    .ok_or(DesktopError::NoSongLoaded)?;
                let runtime_source_position =
                    source_seconds_at_view(&source_song, snapshot.current_seconds.max(0.0));
                self.engine
                    .sync_position_preserving_transport_state(runtime_source_position)?;
                self.transport_clock
                    .note_jump_while_playing(runtime_source_position);
                self.capture_transport_drift_sample(
                    audio,
                    "automation_jump",
                    runtime_source_position,
                    runtime_source_position,
                );
                if let Some(duration_seconds) = pending_automation.fade_out_seconds {
                    audio.start_master_fade(1.0, duration_seconds)?;
                }
                if let Some(scene_id) = pending_automation.mix_scene_id.as_deref() {
                    self.apply_mix_scene_runtime(scene_id, audio)?;
                }
                // Count this firing before re-arming so a cue at its run limit is
                // not immediately re-scheduled (which would loop forever).
                self.record_automation_cue_run(&pending_automation.cue_id);
                self.schedule_next_automation_jump(audio)?;
                return Ok(true);
            }

            if jump_debug_logging_enabled() {
                eprintln!("[LT_JUMP_DEBUG][state] native_count_without_pending_jump");
            }
            return Ok(false);
        };
        let fade_in_duration_seconds = match pending_jump.transition {
            TransitionType::Instant => None,
            TransitionType::FadeOut { duration_seconds } => Some(duration_seconds),
        };

        let source_song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        let Some(target_position) = self
            .engine
            .complete_pending_native_jump_with_song(&source_song)?
        else {
            if jump_debug_logging_enabled() {
                eprintln!(
                    "[LT_JUMP_DEBUG][state] native_count_complete_returned_none pending_target={} execute_at_seconds={:.9}",
                    pending_jump.target_marker_id,
                    pending_jump.execute_at_seconds
                );
            }
            return Ok(false);
        };
        if jump_debug_logging_enabled() {
            eprintln!(
                "[LT_JUMP_DEBUG][state] native_jump_completed target_position={target_position:.9} pending_execute_at_seconds={:.9}",
                pending_jump.execute_at_seconds
            );
        }
        if let Some(duration_seconds) = fade_in_duration_seconds {
            audio.start_master_fade(1.0, duration_seconds)?;
        }
        let runtime_source_position =
            source_seconds_at_view(&source_song, snapshot.current_seconds.max(0.0));
        self.engine
            .sync_position_preserving_transport_state(runtime_source_position)?;
        self.transport_clock
            .note_jump_while_playing(runtime_source_position);
        self.capture_transport_drift_sample(
            audio,
            "native_jump",
            runtime_source_position,
            runtime_source_position,
        );
        self.schedule_next_automation_jump(audio)?;
        Ok(true)
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

    fn snapshot_with_runtime_transport(&mut self, audio: &AudioController) -> TransportSnapshot {
        self.snapshot_with_transport_override(self.runtime_transport_position(audio))
    }

    fn snapshot(&mut self) -> TransportSnapshot {
        self.snapshot_with_transport_override(None)
    }

    fn snapshot_with_transport_override(
        &mut self,
        runtime_transport: Option<(f64, bool)>,
    ) -> TransportSnapshot {
        let started_at = Instant::now();
        let source_song = self.engine.song().cloned();
        let raw_position_seconds = runtime_transport
            .map(|(position_seconds, _)| position_seconds)
            .unwrap_or_else(|| self.current_position());
        let mut transport_clock = self.transport_clock.summary();
        if let Some((position_seconds, running)) = runtime_transport {
            transport_clock.anchor_position_seconds = position_seconds;
            transport_clock.running = running;
        }
        let position_seconds = timeline_seconds_to_view(source_song.as_ref(), raw_position_seconds);
        let transport_clock =
            transport_clock_summary_to_view(source_song.as_ref(), transport_clock);
        let transport_song = source_song
            .as_ref()
            .map(song_with_warped_timeline_for_transport);
        let snapshot = TransportSnapshot {
            playback_state: playback_state_label(self.engine.playback_state()).to_string(),
            position_seconds,
            current_marker: source_song.as_ref().and_then(|song| {
                song.marker_at(raw_position_seconds)
                    .map(|marker| marker_to_warped_summary(song, &marker))
            }),
            pending_marker_jump: self.engine.pending_marker_jump().map(|pending_jump| {
                source_song
                    .as_ref()
                    .map(|song| pending_jump_to_warped_summary(song, pending_jump))
                    .unwrap_or_else(|| pending_jump_to_summary(pending_jump))
            }),
            pending_automation_cue: self.pending_automation_jump.as_ref().and_then(|pending| {
                source_song
                    .as_ref()
                    .map(|song| PendingAutomationCueSummary {
                        cue_id: pending.cue_id.clone(),
                        cue_name: pending.cue_name.clone(),
                        execute_at_seconds: warp_timeline_seconds_at(
                            song,
                            pending.execute_at_seconds,
                        ),
                        target: automation_jump_target_to_summary(song, &pending.target),
                    })
            }),
            active_vamp: self.engine.active_vamp().map(|active_vamp| {
                source_song
                    .as_ref()
                    .map(|song| active_vamp_to_warped_summary(song, active_vamp))
                    .unwrap_or_else(|| active_vamp_to_summary(active_vamp))
            }),
            automation_cues: source_song
                .as_ref()
                .map(|song| {
                    automation_cues_to_summary(
                        song,
                        &self.automation.cues,
                        &self.automation_run_counts,
                    )
                })
                .unwrap_or_default(),
            mix_scenes: mix_scenes_to_summary(&self.automation.mix_scenes),
            automation_track: if self.automation.track_present {
                Some(crate::models::view::AutomationTrackSummary {
                    after_track_id: self.automation.track_after_id.clone(),
                })
            } else {
                None
            },
            musical_position: transport_song
                .as_ref()
                .map(|song| musical_position_summary(song, position_seconds))
                .unwrap_or_else(empty_musical_position_summary),
            transport_clock,
            pitch: self.last_runtime_pitch.clone().unwrap_or_default(),
            last_drift_sample: self
                .last_drift_sample
                .clone()
                .map(|sample| transport_drift_summary_to_view(source_song.as_ref(), sample)),
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

    fn prime_waveform_cache(&mut self, song_dir: &Path, _song: &Song) -> Result<(), DesktopError> {
        // We used to eagerly load every .peaks file off disk here during
        // load_song_from_path, then load them AGAIN in
        // ensure_project_waveforms_ready after sources finished decoding —
        // 2× syscalls per file with no functional benefit. Now we just reset
        // the cache; the real load happens once, in parallel, post-sources.
        self.waveform_cache.reset(song_dir);
        Ok(())
    }

    /// Populate the in-memory waveform cache from the per-file global cache
    /// (migrating any project-local/packaged `.ltpeaks` in). READ-ONLY: never
    /// analyses audio, so it stays cheap under the session lock. Returns the keys
    /// that had no cache yet (misses) so the caller can decide how to generate
    /// them — on the project-open path that means enqueueing background jobs.
    fn populate_waveform_cache_readonly(&mut self, song_dir: &Path, song: &Song) -> Vec<String> {
        self.waveform_cache.reset_if_song_changed(song_dir);
        let keys = unique_waveform_keys(song);
        let cache_root = decoding_cache_root();
        let parallel_results: Vec<(String, Option<(WaveformCacheToken, WaveformSummary)>)> = keys
            .par_iter()
            .map(|key| {
                let summary = load_global_waveform(&cache_root, song_dir, Path::new(key)).ok();
                let token = build_waveform_cache_token(song_dir, key).ok();
                let entry = match (token, summary) {
                    (Some(t), Some(s)) => Some((t, s)),
                    _ => None,
                };
                (key.clone(), entry)
            })
            .collect();

        let mut misses = Vec::new();
        for (key, entry) in parallel_results {
            if let Some((token, summary)) = entry {
                self.perf_metrics.waveform_cache_hits += 1;
                self.waveform_cache
                    .entries
                    .insert(key, CachedWaveformSummary { token, summary });
            } else {
                self.perf_metrics.waveform_cache_misses += 1;
                misses.push(key);
            }
        }
        misses
    }

    /// Project-open waveform readiness. Reads the global cache (cheap), then for
    /// any miss enqueues generation on the BACKGROUND worker (which does not hold
    /// the session lock). The worker emits WAVEFORM_READY_EVENT and the frontend
    /// paints each waveform as it lands. Waveforms are purely visual — playback
    /// readiness is handled separately by prepare_playback_at + prearm — so this
    /// never blocks the open on audio analysis and the UI stays responsive.
    fn ensure_project_waveforms_ready(
        &mut self,
        app: &AppHandle,
        song_dir: &Path,
        song: &Song,
    ) -> Result<(), DesktopError> {
        let misses = self.populate_waveform_cache_readonly(song_dir, song);
        let jobs = &app.state::<DesktopState>().waveform_jobs;
        for key in misses {
            // Best-effort: a full/unavailable worker must not fail the open.
            let _ = jobs.enqueue(app.clone(), song_dir.to_path_buf(), key);
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
        let cache_root = decoding_cache_root();
        let key_path = Path::new(waveform_key);
        let summary = if allow_regenerate {
            // Read the global cache (migrating a project-local one), analysing the
            // source as a last resort.
            load_or_generate_global_waveform(&cache_root, song_dir, key_path)?
        } else {
            // Read-only: never analyse here so the caller can fall back to native
            // engine peaks for sources symphonia can't decode.
            load_global_waveform(&cache_root, song_dir, key_path)?
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

    fn load_native_waveform_summary(
        &mut self,
        song_dir: &Path,
        waveform_key: &str,
        audio: &AudioController,
    ) -> Result<&WaveformSummary, DesktopError> {
        let peaks = audio.source_peaks(song_dir, waveform_key)?;
        let duration_frames = u64::try_from(peaks.duration_frames.max(0)).unwrap_or(0);
        let source_path = resolve_audio_file_path(song_dir, waveform_key);
        let summary = waveform_summary_from_peaks(
            peaks.sample_rate,
            duration_frames,
            peaks.resolution_frames,
            peaks.min_peaks,
            peaks.max_peaks,
            &source_path,
        )?;
        write_global_waveform(&decoding_cache_root(), &source_path, &summary)?;
        let refreshed_token = build_waveform_cache_token(song_dir, waveform_key)?;

        self.waveform_cache.reset_if_song_changed(song_dir);
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
            .expect("native waveform cache entry should exist")
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
        let runtime_position_seconds =
            self.runtime_seconds_for_engine_position(self.engine.position_seconds());
        audio.seek(song, runtime_position_seconds, reason)?;
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
        audio.replace_song_buffers(&song_dir, &song, "restart_audio")?;
        let runtime_position_seconds =
            self.runtime_seconds_for_engine_position(self.engine.position_seconds());
        audio.play(song_dir, song, runtime_position_seconds, reason)?;
        Ok(())
    }
}

/// Taxonomy of runtime update kinds. Documents what a given operation does to the C++ runtime.
///
/// This is the canonical classification for the ownership contract:
/// - **RealtimeBridgeOnly**: sent from a Category A Tauri command — no model mutation, no undo.
/// - **CommitWithTargetedCommand**: pointer-up / commit path — model + one Category A command.
/// - **PitchRuntimeUpdate**: transpose change — model + one Category B pitch command.
/// - **StructuralSessionReload**: source/track CRUD — model + full `LoadSession` rebuild.
///
/// Used for diagnostics comments and future assertion points. Not stored at runtime.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeUpdateKind {
    /// Category A: bridge-only. No Rust model mutation, no undo entry, no LoadSession.
    /// Examples: slider drag, mute/solo toggle during drag, metronome toggle.
    RealtimeBridgeOnly,
    /// Category B (commit): Rust model updated + one targeted Category A command to C++.
    /// Examples: pointer-up on volume/pan/mute/solo, track name commit.
    CommitWithTargetedCommand,
    /// Category B (pitch): Rust model updated + SetRegionTranspose/SetSongTranspose to C++.
    /// May trigger C++ pitch stream rebuild but NOT a full LoadSession.
    PitchRuntimeUpdate,
    /// Category C: Rust model updated + full `LoadSession` (source/track/clip CRUD).
    /// Examples: add track, delete clip, move clip to different source.
    StructuralSessionReload,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AudioChangeImpact {
    /// Gain/pan/mute/solo/transpose_enabled changed. C++ already received a realtime command.
    /// No LoadSession needed — skip replace_song_buffers and restart_audio entirely.
    MixerOnly,
    /// Marker/region/BPM/tempo changes that don't move clips. No source reload needed.
    TransportOnly,
    /// Clips moved or resized. If playing, re-send LoadSession to update render windows.
    TimelineWindow,
    /// Sources added/removed, tracks added/deleted. Always triggers full source reload.
    StructureRebuild,
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

fn emit_project_load_progress(
    app: &AppHandle,
    percent: u8,
    message: String,
    sources_ready: usize,
    sources_total: usize,
    ram_cache_mb: usize,
    disk_cache_mb: usize,
) {
    let emitted_at_unix_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    let payload = ProjectLoadProgressEvent {
        percent: percent.min(100),
        message,
        sources_ready,
        sources_total,
        ram_cache_mb,
        disk_cache_mb,
        emitted_at_unix_ms,
    };

    if let Some(state) = app.try_state::<DesktopState>() {
        if let Ok(mut progress) = state.project_load_progress.lock() {
            *progress = Some(payload.clone());
        }
    }

    if let Err(error) = app.emit(PROJECT_LOAD_PROGRESS_EVENT, payload) {
        eprintln!("[libretracks-project] failed to emit load progress: {error}");
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

fn allocate_library_audio_path(reserved_paths: &HashSet<String>, file_name: &str) -> String {
    let source_path = Path::new(file_name);
    let stem = source_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("audio");
    let extension = source_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("wav");

    let mut index = 0_u32;
    loop {
        let next_name = if index == 0 {
            format!("{stem}.{extension}")
        } else {
            format!("{stem}-{index}.{extension}")
        };
        let candidate = format!("audio/{next_name}");
        if !reserved_paths.contains(&candidate) {
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
fn place_bundled_audio_and_repoint(
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
        let relative_path = if let Some(existing) = copied.get(&file_name) {
            existing.clone()
        } else {
            let relative_path = allocate_library_audio_path(&reserved_paths, &file_name);
            reserved_paths.insert(relative_path.clone());
            fs::write(song_dir.join(&relative_path), bytes)?;
            copied.insert(file_name.clone(), relative_path.clone());
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
            let relative_path = allocate_library_audio_path(&reserved_paths, &sanitized_file_name);
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

    let audio_dir = song_dir.join("audio");
    fs::create_dir_all(&audio_dir)?;

    let mut written_paths = Vec::with_capacity(files.len());
    let import_result = (|| {
        let mut imported_assets = Vec::with_capacity(files.len());
        let mut reserved_paths = collect_library_file_paths(song_dir, song)?
            .into_iter()
            .collect::<HashSet<_>>();

        for file in files {
            if file.source_path.trim().is_empty() {
                return Err(DesktopError::AudioCommand(
                    "source path is required for audio import".into(),
                ));
            }

            let sanitized_file_name = sanitize_import_file_name(&file.file_name)?;
            let relative_path = allocate_library_audio_path(&reserved_paths, &sanitized_file_name);
            reserved_paths.insert(relative_path.clone());

            let absolute_path = resolve_audio_file_path(song_dir, &relative_path);
            fs::copy(Path::new(&file.source_path), &absolute_path)?;
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

fn project_root(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("LibreTracks"))
}

fn automation_target_source_seconds(
    song: &Song,
    target: &AutomationJumpTarget,
) -> Result<f64, DesktopError> {
    match target {
        AutomationJumpTarget::Marker { marker_id } => song
            .section_markers
            .iter()
            .find(|marker| marker.id == *marker_id)
            .map(|marker| marker.start_seconds)
            .ok_or_else(|| DesktopError::SectionNotFound(marker_id.clone())),
        AutomationJumpTarget::Region { region_id } => song
            .regions
            .iter()
            .find(|region| region.id == *region_id)
            .map(|region| region.start_seconds)
            .ok_or_else(|| DesktopError::RegionNotFound(region_id.clone())),
        AutomationJumpTarget::Frame { seconds } if seconds.is_finite() && *seconds >= 0.0 => {
            Ok(*seconds)
        }
        AutomationJumpTarget::Frame { .. } => Err(DesktopError::AudioCommand(
            "automation frame target must be a finite, non-negative number".into(),
        )),
    }
}

fn validate_automation_cue(
    song: &Song,
    automation: &AutomationDocument,
    cue: &AutomationCue,
) -> Result<(), DesktopError> {
    if cue.id.trim().is_empty() {
        return Err(DesktopError::AudioCommand(
            "automation cue id is required".into(),
        ));
    }
    if !cue.at_seconds.is_finite() || cue.at_seconds < 0.0 {
        return Err(DesktopError::AudioCommand(
            "automation cue time must be a finite, non-negative number".into(),
        ));
    }
    if cue.max_runs == Some(0) {
        return Err(DesktopError::AudioCommand(
            "automation cue max runs must be at least 1 (omit for unlimited)".into(),
        ));
    }
    if cue.actions.is_empty() {
        return Err(DesktopError::AudioCommand(
            "automation cue must have at least one action".into(),
        ));
    }

    let track_exists = |track_id: &str| song.tracks.iter().any(|track| track.id == track_id);
    let scene_exists = |scene_id: &str| automation.mix_scenes.iter().any(|s| s.id == scene_id);

    let mut jump_count = 0usize;
    let last_index = cue.actions.len() - 1;
    for (index, action) in cue.actions.iter().enumerate() {
        match action {
            AutomationAction::Jump {
                target,
                transition,
                mix_scene_id,
            } => {
                jump_count += 1;
                // The jump must be the terminal action (it's scheduled
                // sample-exact as the job's culmination).
                if index != last_index {
                    return Err(DesktopError::AudioCommand(
                        "the jump action must be the last action of the cue".into(),
                    ));
                }
                automation_target_source_seconds(song, target)?;
                if transition.mode == AutomationTransitionMode::FadeOut
                    && transition
                        .duration_seconds
                        .is_some_and(|duration| !duration.is_finite() || duration < 0.0)
                {
                    return Err(DesktopError::AudioCommand(
                        "automation fade duration must be a finite, non-negative number".into(),
                    ));
                }
                if let Some(scene_id) = mix_scene_id {
                    if !scene_exists(scene_id) {
                        return Err(DesktopError::AudioCommand(format!(
                            "mix scene not found: {scene_id}"
                        )));
                    }
                }
            }
            AutomationAction::SetTrackMute { track_id, .. }
            | AutomationAction::SetTrackSolo { track_id, .. } => {
                if !track_exists(track_id) {
                    return Err(DesktopError::AudioCommand(format!(
                        "track not found: {track_id}"
                    )));
                }
            }
            AutomationAction::SetTrackMix {
                track_id,
                volume,
                pan,
                ramp_seconds,
            } => {
                if !track_exists(track_id) {
                    return Err(DesktopError::AudioCommand(format!(
                        "track not found: {track_id}"
                    )));
                }
                for (value, label) in [(volume, "volume"), (pan, "pan")] {
                    if value.is_some_and(|v| !v.is_finite()) {
                        return Err(DesktopError::AudioCommand(format!(
                            "automation {label} must be a finite number"
                        )));
                    }
                }
                if ramp_seconds.is_some_and(|r| !r.is_finite() || r < 0.0) {
                    return Err(DesktopError::AudioCommand(
                        "automation ramp must be a finite, non-negative number".into(),
                    ));
                }
            }
            AutomationAction::ApplyScene { scene_id } => {
                if !scene_exists(scene_id) {
                    return Err(DesktopError::AudioCommand(format!(
                        "mix scene not found: {scene_id}"
                    )));
                }
            }
            AutomationAction::Wait { duration_seconds } => {
                if !duration_seconds.is_finite() || *duration_seconds < 0.0 {
                    return Err(DesktopError::AudioCommand(
                        "automation wait must be a finite, non-negative number".into(),
                    ));
                }
            }
        }
    }
    if jump_count > 1 {
        return Err(DesktopError::AudioCommand(
            "a cue may contain at most one jump action".into(),
        ));
    }

    Ok(())
}

fn timestamp_suffix() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn set_song_tempo_at_source_position(song: &mut Song, start_seconds: f64, bpm: f64) {
    if start_seconds <= 0.0001 {
        song.bpm = bpm;
        return;
    }

    if let Some(existing_marker) = song
        .tempo_markers
        .iter_mut()
        .find(|marker| (marker.start_seconds - start_seconds).abs() < 0.0001)
    {
        existing_marker.bpm = bpm;
    } else {
        song.tempo_markers.push(TempoMarker {
            id: format!("tempo_marker_{}", timestamp_suffix()),
            start_seconds,
            bpm,
        });
        song.tempo_markers.sort_by(|left, right| {
            left.start_seconds
                .partial_cmp(&right.start_seconds)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
    }
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

    let previous_parent_track_id = root_track.parent_track_id.clone();
    let should_force_inherit_route =
        parent_track_id.is_some() && previous_parent_track_id.as_deref() != parent_track_id;

    root_track.parent_track_id = parent_track_id.map(str::to_string);
    if should_force_inherit_route {
        root_track.audio_to = "inherit".to_string();
    }

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
    pub(crate) fn summary(&self, waveform_key: &str) -> Option<&WaveformSummary> {
        self.entries.get(waveform_key).map(|cached| &cached.summary)
    }

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
    let audio_path = resolve_audio_file_path(song_dir, waveform_key);
    let audio_metadata = fs::metadata(&audio_path)?;
    let waveform_path = global_waveform_file_path(&decoding_cache_root(), &audio_path);
    let waveform_metadata = fs::metadata(&waveform_path)?;

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

/// Root directory for the on-disk caches (PCM `.rf64` and per-file waveform
/// `.ltpeaks`), honouring the configurable decoding-cache folder. The engine
/// reports `<cache_root>/source-cache`; we take its parent so the waveform
/// cache lives alongside it under the same configurable root. Falls back to the
/// engine value verbatim (then to a temp dir) if the parent can't be derived.
pub(crate) fn decoding_cache_root() -> PathBuf {
    let engine_dir = lt_audio_engine_v2::decoding_cache_dir();
    if !engine_dir.is_empty() {
        let path = PathBuf::from(&engine_dir);
        // engine_dir is `<root>/source-cache`; the root is its parent.
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                return parent.to_path_buf();
            }
        }
        return path;
    }
    std::env::temp_dir().join("LibreTracks")
}

fn modified_millis(metadata: &fs::Metadata) -> Result<u128, DesktopError> {
    Ok(metadata
        .modified()?
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis())
}

fn normalize_timeline_start_seconds(value: f64) -> f64 {
    if value.is_finite() {
        value
    } else {
        0.0
    }
}

fn validate_clip_window(
    song_dir: &std::path::Path,
    clip_file_path: &str,
    timeline_start_seconds: f64,
    source_start_seconds: f64,
    duration_seconds: f64,
) -> Result<(), DesktopError> {
    if !timeline_start_seconds.is_finite() || source_start_seconds < 0.0 || duration_seconds < 0.05
    {
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
    let clip_start = normalize_timeline_start_seconds(request.timeline_start_seconds);
    let clip_end = clip_start + wav_metadata.duration_seconds;

    // Enforce the "clip lives inside one region" invariant by either
    // extending the region the clip lands in, or creating a new region
    // around it when it falls between songs. A clip whose span would
    // invade a neighbouring song is rejected.
    ensure_region_covers_clip(song, clip_start, clip_end)?;

    song.clips.push(Clip {
        id: clip_id,
        track_id: request.track_id.clone(),
        file_path: normalized_file_path,
        timeline_start_seconds: clip_start,
        source_start_seconds: 0.0,
        duration_seconds: wav_metadata.duration_seconds,
        gain: 1.0,
        fade_in_seconds: None,
        fade_out_seconds: None,
        color: None,
    });

    Ok(())
}

/// Make sure exactly one region covers `[clip_start, clip_end)`.
///
/// Cases handled (with the user-facing contract from steps 4.3 + 4.4 of the
/// song-model plan):
///
/// 1. A region already contains `[clip_start, clip_end)` end-to-end. No-op.
/// 2. A region contains `clip_start` but the clip overflows its end. Extend
///    that region's end to `clip_end`. If the new end would overlap a
///    following region, the drop is rejected (the user's clip would invade
///    the next song).
/// 3. The clip falls outside every region. Create a fresh region around it,
///    unless that new region would overlap a neighbour, in which case the
///    drop is rejected.
///
/// We never shift `clip_start` backward into an earlier region's tail — the
/// invariant is about containment, and a clip whose start sits at exactly
/// `region.end` belongs to whatever follows, not to that region.
fn ensure_region_covers_clip(
    song: &mut Song,
    clip_start: f64,
    clip_end: f64,
) -> Result<(), DesktopError> {
    if clip_end <= clip_start {
        return Err(DesktopError::AudioCommand(
            "clip must have a positive duration".into(),
        ));
    }

    // Pre-sort so neighbour lookups are deterministic.
    sort_song_regions(&mut song.regions);

    // Case 1 / 2: clip starts inside an existing region.
    if let Some(idx) = song
        .regions
        .iter()
        .position(|region| clip_start >= region.start_seconds && clip_start < region.end_seconds)
    {
        let region_end = song.regions[idx].end_seconds;
        if clip_end <= region_end {
            return Ok(());
        }
        // Need to extend forward. Reject if a following region sits before
        // clip_end — extending would either overlap it (invariant break)
        // or implicitly delete it (data loss).
        if let Some(next) = song.regions.get(idx + 1) {
            if clip_end > next.start_seconds {
                return Err(DesktopError::AudioCommand(
                    "clip would extend into the next song; move it earlier or shorten it".into(),
                ));
            }
        }
        song.regions[idx].end_seconds = clip_end;
        return Ok(());
    }

    // Case 3: clip is outside every region. Build a fresh region. Reject if
    // its bounds would straddle a neighbour.
    if let Some(neighbour) = song
        .regions
        .iter()
        .find(|region| !(clip_end <= region.start_seconds || clip_start >= region.end_seconds))
    {
        return Err(DesktopError::AudioCommand(format!(
            "clip overlaps song '{}' but does not lie inside it; move it earlier or later",
            neighbour.name
        )));
    }
    let region_index = song.regions.len();
    song.regions.push(SongRegion {
        id: format!("region_{}_{}", timestamp_suffix(), region_index),
        name: format!("Song {}", region_index + 1),
        start_seconds: clip_start,
        end_seconds: clip_end,
        transpose_semitones: 0,
        warp_enabled: false,
        warp_source_bpm: None,
        master: libretracks_core::SongMaster::default(),
    });
    sort_song_regions(&mut song.regions);
    Ok(())
}

/// Apply a batch of clip moves with the same per-clip region reshaping the
/// single-clip path uses. Moves are applied in order so the region layout
/// after each clip's reshape is visible to the next. Failure on any single
/// move aborts the whole batch — callers see a single all-or-nothing
/// outcome, matching how the user perceives a multi-select drag.
fn apply_clip_moves_with_region_reshape(
    song: &mut Song,
    moves: &[ClipMoveRequest],
) -> Result<(), DesktopError> {
    for request in moves {
        let new_start = normalize_timeline_start_seconds(request.timeline_start_seconds);
        let clip_duration = song
            .clips
            .iter()
            .find(|clip| clip.id == request.clip_id)
            .map(|clip| clip.duration_seconds)
            .ok_or_else(|| DesktopError::ClipNotFound(request.clip_id.clone()))?;
        // When the move reassigns the clip to another track, validate the
        // destination before touching anything (same rule as
        // move_clip_to_track: target must exist and must not be a folder).
        if let Some(target_track_id) = &request.target_track_id {
            let target_kind = song
                .tracks
                .iter()
                .find(|track| &track.id == target_track_id)
                .map(|track| track.kind)
                .ok_or_else(|| DesktopError::TrackNotFound(target_track_id.clone()))?;
            if target_kind == libretracks_core::TrackKind::Folder {
                return Err(DesktopError::AudioCommand(
                    "no se puede mover un clip a un folder".into(),
                ));
            }
        }
        ensure_region_covers_clip(song, new_start, new_start + clip_duration)?;
        let clip = song
            .clips
            .iter_mut()
            .find(|clip| clip.id == request.clip_id)
            .ok_or_else(|| DesktopError::ClipNotFound(request.clip_id.clone()))?;
        clip.timeline_start_seconds = new_start;
        if let Some(target_track_id) = &request.target_track_id {
            clip.track_id = target_track_id.clone();
        }
    }
    Ok(())
}

/// Drop any region that no longer has at least one clip whose start falls
/// inside it. Per the song-model plan (step 4.5), a song that loses its last
/// clip ceases to exist — the user does not have to clean it up by hand.
///
/// The size of surviving regions is left alone (user request: "if clips are
/// moved leave the size as-is, the user can adjust"). Only completely empty
/// regions are removed.
fn prune_empty_regions(song: &mut Song) {
    song.regions.retain(|region| {
        song.clips.iter().any(|clip| {
            clip.timeline_start_seconds >= region.start_seconds
                && clip.timeline_start_seconds < region.end_seconds
        })
    });
}

/// Remove any track whose `auto_created` flag is set and that holds no clip
/// at all. User-created tracks (auto_created = false) are left alone even
/// when empty — the user may want a placeholder before they drop audio in.
///
/// Used by every flow that can leave a track empty: delete_clip, the move-
/// clip paths, and the upcoming move_clip_to_track. A track auto-created
/// for a single audio drop disappears the moment the user moves that clip
/// to another track, leaving the mixer view tidy without an explicit
/// "delete track" step.
/// Strip the directory path and extension off a file path to derive a
/// reasonable initial track name. "audio/kick.wav" → "kick". Falls back to
/// the raw path if nothing sensible remains.
fn file_stem_for_auto_track(file_path: &str) -> String {
    let normalised = file_path.replace('\\', "/");
    let basename = normalised.rsplit('/').next().unwrap_or(&normalised);
    let stem = match basename.rfind('.') {
        Some(idx) if idx > 0 => &basename[..idx],
        _ => basename,
    };
    let trimmed = stem.trim();
    if trimmed.is_empty() {
        return file_path.to_string();
    }
    trimmed.to_string()
}

fn prune_auto_created_empty_tracks(song: &mut Song) {
    let used_track_ids: std::collections::HashSet<&str> = song
        .clips
        .iter()
        .map(|clip| clip.track_id.as_str())
        .collect();
    // Folder tracks are kept around even when "empty" — a folder with no
    // children is still a structural choice. We only prune leaf audio
    // tracks that the system created and nobody is using.
    song.tracks.retain(|track| {
        !(track.auto_created
            && track.kind != libretracks_core::TrackKind::Folder
            && !used_track_ids.contains(track.id.as_str()))
    });
}

/// Duration of one bar at `position_seconds` (in source-time), derived from
/// the song's effective BPM at that point and the song's base time signature
/// numerator. Used by create_empty_song to space new songs by one bar of
/// silence regardless of tempo.
fn bar_seconds_at(song: &Song, position_seconds: f64) -> f64 {
    let bpm = libretracks_core::effective_bpm_at(song, position_seconds).max(1.0);
    let beats_per_bar = song
        .time_signature
        .split_once('/')
        .and_then(|(num, _)| num.trim().parse::<u32>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(4) as f64;
    (beats_per_bar * 60.0) / bpm
}

/// Returns the first downbeat (bar boundary) at or after `position_seconds`,
/// walking the song's tempo markers so the answer respects every tempo
/// change between the anchor and the next bar. Falls back to the song's
/// global BPM when there are no tempo markers. Used by create_empty_song
/// to land new songs on a real grid bar instead of "lastEnd + one bar at
/// the global BPM", which drifts off-grid whenever the previous song
/// ended under a different tempo marker or didn't end exactly on a bar.
fn next_downbeat_after_in_song(song: &Song, position_seconds: f64) -> f64 {
    if position_seconds <= 0.0 {
        return 0.0;
    }
    // Build the set of tempo segments: from each tempo marker (sorted by
    // start) to the next marker's start (or +infinity for the last one).
    // Within a segment the BPM is constant so the local downbeat math is
    // a simple rounding.
    let mut markers = song.tempo_markers.clone();
    markers.sort_by(|a, b| {
        a.start_seconds
            .partial_cmp(&b.start_seconds)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let beats_per_bar = song
        .time_signature
        .split_once('/')
        .and_then(|(num, _)| num.trim().parse::<u32>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(4) as f64;

    // Walk segments in order, accumulating bar count at each segment
    // boundary. The current segment is the one whose start_seconds is the
    // greatest <= position_seconds (or the implicit "before-any-marker"
    // segment anchored at 0 with the song's base BPM).
    let mut segment_start_seconds = 0.0_f64;
    let mut segment_start_bars = 0.0_f64;
    let mut segment_bpm = song.bpm.max(1.0);

    for marker in &markers {
        if marker.start_seconds > position_seconds {
            break;
        }
        let span = marker.start_seconds - segment_start_seconds;
        let bar_seconds = (beats_per_bar * 60.0) / segment_bpm.max(1.0);
        let span_bars = if bar_seconds > 0.0 {
            span / bar_seconds
        } else {
            0.0
        };
        segment_start_bars += span_bars;
        segment_start_seconds = marker.start_seconds;
        segment_bpm = marker.bpm.max(1.0);
    }

    let segment_bar_seconds = (beats_per_bar * 60.0) / segment_bpm.max(1.0);
    if segment_bar_seconds <= 0.0 {
        return position_seconds;
    }
    let local_bars = (position_seconds - segment_start_seconds) / segment_bar_seconds;
    // Ceil with a tiny epsilon so positions already on a downbeat don't
    // jump to the next one due to floating drift.
    let target_local_bars = (local_bars - 1e-9).ceil().max(0.0);
    segment_start_seconds + target_local_bars * segment_bar_seconds
}

const REGION_DOWNBEAT_ALIGNMENT_EPSILON_SECONDS: f64 = 0.15;

#[derive(Clone, Copy)]
struct ViewTempoBoundary<'a> {
    start_seconds: f64,
    bpm: Option<f64>,
    time_signature: Option<&'a str>,
}

/// Snap every region positioned AFTER `moved_region_id` so its start
/// lands on the next downbeat after the previous region's end. Used
/// by `move_song_region` to guarantee that each follower ends up on
/// its own bar.1 even when the cascade-push displaced it by a
/// non-bar amount. Iterates in order so that fixing region N feeds
/// the correct end_seconds into the fix for region N+1.
fn snap_regions_after_to_downbeats(song: &mut Song, moved_region_id: &str) {
    let ordered_ids: Vec<String> = song
        .regions
        .iter()
        .map(|region| region.id.clone())
        .collect();
    let Some(moved_idx) = ordered_ids.iter().position(|id| id == moved_region_id) else {
        return;
    };
    if moved_idx + 1 >= ordered_ids.len() {
        return;
    }

    let followers: Vec<String> = ordered_ids.iter().skip(moved_idx + 1).cloned().collect();
    let mut predecessor_id = moved_region_id.to_string();
    for follower_id in followers {
        let Some(predecessor_end) = song
            .regions
            .iter()
            .find(|region| region.id == predecessor_id)
            .map(|region| region.end_seconds)
        else {
            predecessor_id = follower_id;
            continue;
        };
        let Some(current_start) = song
            .regions
            .iter()
            .find(|region| region.id == follower_id)
            .map(|region| region.start_seconds)
        else {
            predecessor_id = follower_id;
            continue;
        };

        let predecessor_view_end = warp_timeline_seconds_at(song, predecessor_end);
        let desired_view_start = next_downbeat_after_in_view_timeline(song, predecessor_view_end);
        let desired_source_start = source_seconds_at_view(song, desired_view_start);
        let delta = desired_source_start - current_start;
        if delta.abs() > 0.00001 {
            shift_song_suffix(song, current_start, delta);
        }
        predecessor_id = follower_id;
    }
}

fn realign_regions_after_warp_tempo_change(previous_song: &Song, song: &mut Song) {
    // The original guard here was "only act when some region has warp
    // active", but the same realignment is needed for plain tempo
    // changes too: if the user moves the global BPM (or a tempo
    // marker that the next region doesn't supersede), region N+1's
    // source_start no longer falls on the bar it used to fall on.
    // Without this, the case "song 1 has no tempo marker (uses
    // global BPM), song 2 has its own tempo marker pinned at its
    // start; bumping the global BPM" leaves song 2 visually
    // mid-bar even though both endpoints were downbeat-aligned
    // before. The function name is kept for now to avoid touching
    // every caller; it's effectively realign_regions_after_tempo_change.
    let mut previous_regions = previous_song.regions.iter().collect::<Vec<_>>();
    previous_regions.sort_by(|left, right| {
        left.start_seconds
            .partial_cmp(&right.start_seconds)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    for pair in previous_regions.windows(2) {
        let previous_region = pair[0];
        let following_region = pair[1];
        if !region_boundary_was_downbeat_aligned(previous_song, previous_region, following_region) {
            continue;
        }

        let Some(current_previous_end) = song
            .regions
            .iter()
            .find(|region| region.id == previous_region.id)
            .map(|region| region.end_seconds)
        else {
            continue;
        };
        let Some(current_following_start) = song
            .regions
            .iter()
            .find(|region| region.id == following_region.id)
            .map(|region| region.start_seconds)
        else {
            continue;
        };

        let previous_view_end = warp_timeline_seconds_at(song, current_previous_end);
        let desired_view_start = next_downbeat_after_in_view_timeline(song, previous_view_end);
        let desired_source_start = source_seconds_at_view(song, desired_view_start);
        let delta = desired_source_start - current_following_start;
        if delta.abs() <= 0.0001 {
            continue;
        }

        shift_song_suffix(song, current_following_start, delta);
    }

    refresh_song_duration(song);
}

fn region_boundary_was_downbeat_aligned(
    song: &Song,
    previous_region: &SongRegion,
    following_region: &SongRegion,
) -> bool {
    let previous_view_end = warp_timeline_seconds_at(song, previous_region.end_seconds);
    let following_view_start = warp_timeline_seconds_at(song, following_region.start_seconds);
    let expected_view_start = next_downbeat_after_in_view_timeline(song, previous_view_end);
    (following_view_start - expected_view_start).abs() <= REGION_DOWNBEAT_ALIGNMENT_EPSILON_SECONDS
}

fn shift_song_suffix(song: &mut Song, anchor_seconds: f64, delta_seconds: f64) {
    if !delta_seconds.is_finite() || delta_seconds.abs() <= 0.0001 {
        return;
    }
    let at_or_after_anchor = |seconds: f64| seconds >= anchor_seconds - 0.0001;

    for region in &mut song.regions {
        if at_or_after_anchor(region.start_seconds) {
            region.start_seconds = (region.start_seconds + delta_seconds).max(0.0);
            region.end_seconds = (region.end_seconds + delta_seconds).max(region.start_seconds);
        }
    }
    for clip in &mut song.clips {
        if at_or_after_anchor(clip.timeline_start_seconds) {
            clip.timeline_start_seconds = (clip.timeline_start_seconds + delta_seconds).max(0.0);
        }
    }
    for marker in &mut song.tempo_markers {
        if at_or_after_anchor(marker.start_seconds) {
            marker.start_seconds = (marker.start_seconds + delta_seconds).max(0.0);
        }
    }
    for marker in &mut song.time_signature_markers {
        if at_or_after_anchor(marker.start_seconds) {
            marker.start_seconds = (marker.start_seconds + delta_seconds).max(0.0);
        }
    }
    for marker in &mut song.section_markers {
        if at_or_after_anchor(marker.start_seconds) {
            marker.start_seconds = (marker.start_seconds + delta_seconds).max(0.0);
        }
    }
}

fn next_downbeat_after_in_view_timeline(song: &Song, position_seconds: f64) -> f64 {
    if position_seconds <= 0.0 {
        return 0.0;
    }

    let mut boundaries = Vec::<ViewTempoBoundary>::new();
    for marker in &song.tempo_markers {
        if marker.start_seconds > 0.0 {
            boundaries.push(ViewTempoBoundary {
                start_seconds: warp_timeline_seconds_at(song, marker.start_seconds),
                bpm: Some(marker.bpm),
                time_signature: None,
            });
        }
    }
    for marker in &song.time_signature_markers {
        if marker.start_seconds > 0.0 {
            boundaries.push(ViewTempoBoundary {
                start_seconds: warp_timeline_seconds_at(song, marker.start_seconds),
                bpm: None,
                time_signature: Some(marker.signature.as_str()),
            });
        }
    }
    for region in &song.regions {
        if !region.warp_enabled && region.transpose_semitones != 0 {
            if region.start_seconds > 0.0 {
                boundaries.push(ViewTempoBoundary {
                    start_seconds: warp_timeline_seconds_at(song, region.start_seconds),
                    bpm: None,
                    time_signature: None,
                });
            }
            if region.end_seconds > 0.0 {
                boundaries.push(ViewTempoBoundary {
                    start_seconds: warp_timeline_seconds_at(song, region.end_seconds),
                    bpm: None,
                    time_signature: None,
                });
            }
        }
    }
    boundaries.sort_by(|left, right| {
        left.start_seconds
            .partial_cmp(&right.start_seconds)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut segment_start_seconds = 0.0_f64;
    let mut segment_bpm = song.bpm.max(1.0);
    let mut segment_time_signature = song.time_signature.as_str();
    let mut cumulative_bars = 0.0_f64;

    for boundary in boundaries {
        if boundary.start_seconds > position_seconds {
            break;
        }
        if boundary.start_seconds > segment_start_seconds {
            let bar_seconds = view_bar_seconds_at(
                song,
                segment_start_seconds,
                segment_bpm,
                segment_time_signature,
            );
            if bar_seconds > 0.0 {
                cumulative_bars += (boundary.start_seconds - segment_start_seconds) / bar_seconds;
            }
            segment_start_seconds = boundary.start_seconds;
        }
        if let Some(next_signature) = boundary.time_signature {
            if next_signature != segment_time_signature {
                cumulative_bars = (cumulative_bars - 1e-9).ceil();
            }
            segment_time_signature = next_signature;
        }
        if let Some(next_bpm) = boundary.bpm {
            segment_bpm = next_bpm.max(1.0);
        }
    }

    let bar_seconds = view_bar_seconds_at(
        song,
        segment_start_seconds,
        segment_bpm,
        segment_time_signature,
    );
    if bar_seconds <= 0.0 {
        return position_seconds;
    }
    let local_bars = (position_seconds - segment_start_seconds) / bar_seconds;
    let target_total_bars = (cumulative_bars + local_bars - 1e-9).ceil().max(0.0);
    segment_start_seconds + (target_total_bars - cumulative_bars) * bar_seconds
}

fn view_bar_seconds_at(song: &Song, view_seconds: f64, bpm: f64, time_signature: &str) -> f64 {
    let source_seconds = source_seconds_at_view(song, view_seconds);
    let display_bpm = bpm.max(1.0) * varispeed_scale_at_source(song, source_seconds);
    let beats_per_bar = time_signature
        .split_once('/')
        .and_then(|(num, _)| num.trim().parse::<u32>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(4) as f64;
    (beats_per_bar * 60.0) / display_bpm.max(1.0)
}

fn varispeed_scale_at_source(song: &Song, source_seconds: f64) -> f64 {
    let Some(region) = song.regions.iter().find(|region| {
        !region.warp_enabled
            && region.transpose_semitones != 0
            && source_seconds >= region.start_seconds
            && source_seconds < region.end_seconds
    }) else {
        return 1.0;
    };
    let scale = 2.0_f64.powf(region.transpose_semitones as f64 / 12.0);
    if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    }
}

fn refresh_song_duration(song: &mut Song) {
    let max_clip_end = song
        .clips
        .iter()
        .map(|clip| clip.timeline_start_seconds + clip.duration_seconds)
        .fold(0.0_f64, f64::max);
    // Regions must fit inside the song. If a region's end extends past
    // the latest clip — typical after a user-grabbed resize that
    // expanded the region's bounds — the engine's session validator
    // rejects the load with "Region X is outside its song". Take the
    // max of both so the song duration always envelops every region.
    let max_region_end = song
        .regions
        .iter()
        .map(|region| region.end_seconds)
        .fold(0.0_f64, f64::max);

    song.duration_seconds = max_clip_end.max(max_region_end).max(1.0);
}

fn song_with_warped_timeline_for_transport(song: &Song) -> Song {
    let source_song = song.clone();
    let mut runtime = song.clone();

    // Build a track_id -> transpose_enabled lookup so the per-clip varispeed
    // path can read the right flag without scanning runtime.tracks N times.
    let track_transpose_enabled: std::collections::HashMap<&str, bool> = source_song
        .tracks
        .iter()
        .map(|track| (track.id.as_str(), track.transpose_enabled))
        .collect();

    for clip in &mut runtime.clips {
        let source_start_seconds = clip.timeline_start_seconds;
        let transpose_enabled = track_transpose_enabled
            .get(clip.track_id.as_str())
            .copied()
            .unwrap_or(true);
        // Ableton-style: warp-on clips follow warp; warp-off pitched clips
        // shrink/expand by pitch_scale (varispeed). Clip START always uses
        // the warp mapping so the musical grid stays consistent; only the
        // clip's own duration absorbs varispeed.
        clip.timeline_start_seconds = warp_timeline_seconds_at(&source_song, source_start_seconds);
        clip.duration_seconds = audible_clip_duration_seconds(
            &source_song,
            source_start_seconds,
            clip.duration_seconds,
            transpose_enabled,
        );
    }

    for region in &mut runtime.regions {
        let source_start_seconds = region.start_seconds;
        let source_end_seconds = region.end_seconds;
        region.start_seconds = warp_timeline_seconds_at(&source_song, source_start_seconds);
        region.end_seconds = warp_timeline_seconds_at(&source_song, source_end_seconds)
            .max(region.start_seconds + 0.001);
    }

    for marker in &mut runtime.section_markers {
        marker.start_seconds = warp_timeline_seconds_at(&source_song, marker.start_seconds);
    }
    for marker in &mut runtime.tempo_markers {
        let source_start_seconds = marker.start_seconds;
        marker.start_seconds = warp_timeline_seconds_at(&source_song, marker.start_seconds);
        if let Some(scale) = varispeed_scale_at_source_second(&source_song, source_start_seconds) {
            marker.bpm *= scale;
        }
    }
    for marker in &mut runtime.time_signature_markers {
        marker.start_seconds = warp_timeline_seconds_at(&source_song, marker.start_seconds);
    }

    runtime.duration_seconds = runtime
        .clips
        .iter()
        .map(|clip| clip.timeline_start_seconds + clip.duration_seconds)
        .fold(
            warp_timeline_seconds_at(&source_song, source_song.duration_seconds),
            f64::max,
        )
        .max(1.0);
    add_varispeed_tempo_boundaries(&source_song, &mut runtime);
    runtime
}

fn semitones_to_pitch_scale(semitones: i32) -> f64 {
    let scale = 2.0_f64.powf(semitones as f64 / 12.0);
    if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    }
}

fn varispeed_scale_at_source_second(song: &Song, source_seconds: f64) -> Option<f64> {
    song.regions.iter().find_map(|region| {
        if region.warp_enabled
            || region.transpose_semitones == 0
            || source_seconds < region.start_seconds
            || source_seconds >= region.end_seconds
        {
            return None;
        }
        Some(semitones_to_pitch_scale(region.transpose_semitones))
    })
}

fn add_varispeed_tempo_boundaries(source_song: &Song, runtime: &mut Song) {
    let mut synthetic_markers = Vec::new();
    for region in &source_song.regions {
        if region.warp_enabled || region.transpose_semitones == 0 {
            continue;
        }
        let scale = semitones_to_pitch_scale(region.transpose_semitones);
        if (scale - 1.0).abs() < f64::EPSILON {
            continue;
        }
        let view_start = warp_timeline_seconds_at(source_song, region.start_seconds);
        let view_end = warp_timeline_seconds_at(source_song, region.end_seconds).max(view_start);
        synthetic_markers.push(TempoMarker {
            id: format!("{}_varispeed_start", region.id),
            start_seconds: view_start,
            bpm: effective_bpm_at(source_song, region.start_seconds) * scale,
        });
        synthetic_markers.push(TempoMarker {
            id: format!("{}_varispeed_end", region.id),
            start_seconds: view_end,
            bpm: effective_bpm_at(source_song, region.end_seconds),
        });
    }
    runtime.tempo_markers.extend(synthetic_markers);
    runtime.tempo_markers.sort_by(|left, right| {
        left.start_seconds
            .partial_cmp(&right.start_seconds)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
}

fn song_has_active_warp(song: &Song) -> bool {
    song.regions.iter().any(|region| {
        region.warp_enabled
            && region
                .warp_source_bpm
                .is_some_and(|bpm| bpm.is_finite() && bpm > 0.0)
    })
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

fn normalize_ui_color(color: Option<&str>) -> Result<Option<String>, DesktopError> {
    let Some(color) = color.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };

    let hex = color.strip_prefix('#').unwrap_or(color);
    if hex.len() != 6 || !hex.as_bytes().iter().all(u8::is_ascii_hexdigit) {
        return Err(DesktopError::AudioCommand(
            "color must be a #RRGGBB hex value".into(),
        ));
    }

    Ok(Some(format!("#{}", hex.to_ascii_uppercase())))
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
                transpose_semitones: region.transpose_semitones,
                warp_enabled: region.warp_enabled,
                warp_source_bpm: region.warp_source_bpm,
                master: region.master.clone(),
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
                transpose_semitones: region.transpose_semitones,
                warp_enabled: region.warp_enabled,
                warp_source_bpm: region.warp_source_bpm,
                master: region.master.clone(),
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

/// Default directory the "Crear proyecto" save dialog opens to:
/// `<app_data>/songs`. Exposed so the command layer can build it before
/// spawning the worker thread (the dialog must run on the main thread).
pub(crate) fn create_song_default_directory(app: &AppHandle) -> PathBuf {
    project_root(app).join("songs")
}

pub(crate) fn default_project_file_name(title: &str) -> String {
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

#[cfg(test)]
mod tests {
    use std::{fs, path::Path, thread, time::Duration};

    use libretracks_audio::{JumpTrigger, PlaybackState, TransitionType};
    use libretracks_core::{
        source_seconds_at_view, validate_song, warp_timeline_seconds_at, Clip, Marker, MarkerKind,
        Song, SongRegion, TempoMarker, Track, TrackKind,
    };
    use libretracks_project::{
        create_song_folder, export_region_as_package, generate_waveform_summary, load_song,
        save_song, SONG_FILE_NAME,
    };
    use tempfile::tempdir;

    use crate::automation::AutomationDocument;
    use crate::models::view::{musical_position_summary, song_to_view};
    use crate::models::LibraryAssetSummary;

    use super::{
        build_empty_song, list_library_assets, next_downbeat_after_in_view_timeline,
        place_bundled_audio_and_repoint, realign_regions_after_warp_tempo_change,
        write_library_manifest, write_library_manifest_assets, AudioFileImportPayload,
        ClipMoveRequest, CreateClipRequest, DesktopSession, TransportClock, WaveformMemoryCache,
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
                transpose_semitones: 0,
                warp_enabled: false,
                warp_source_bpm: None,
                master: libretracks_core::SongMaster::default(),
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
                transpose_enabled: true,
                audio_to: "master".to_string(),
                color: None,
                auto_created: false,
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
                color: None,
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
            kind: MarkerKind::Custom,
            variant: None,
        });
        song
    }

    fn demo_song_with_varispeed_region() -> Song {
        let mut song = demo_song();
        song.duration_seconds = 24.0;
        song.regions = vec![SongRegion {
            id: "region_varispeed".into(),
            name: "Varispeed".into(),
            start_seconds: 5.0,
            end_seconds: 20.0,
            transpose_semitones: 3,
            warp_enabled: false,
            warp_source_bpm: None,
            master: libretracks_core::SongMaster::default(),
        }];
        // Keep the clip inside the varispeed region ([5, 20]) so the song
        // satisfies the clip-inside-region invariant.
        song.clips[0].timeline_start_seconds = 5.0;
        song.clips[0].duration_seconds = 15.0;
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
            kind: MarkerKind::Custom,
            variant: None,
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
            kind: MarkerKind::Custom,
            variant: None,
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
                transpose_semitones: 0,
                warp_enabled: false,
                warp_source_bpm: None,
                master: libretracks_core::SongMaster::default(),
            },
            SongRegion {
                id: "region_2".into(),
                name: "Bridge".into(),
                start_seconds: 8.0,
                end_seconds: 14.0,
                transpose_semitones: 0,
                warp_enabled: false,
                warp_source_bpm: None,
                master: libretracks_core::SongMaster::default(),
            },
            SongRegion {
                id: "region_3".into(),
                name: "Outro".into(),
                start_seconds: 14.0,
                end_seconds: 18.0,
                transpose_semitones: 0,
                warp_enabled: false,
                warp_source_bpm: None,
                master: libretracks_core::SongMaster::default(),
            },
        ];
        // Keep the clip inside region_1 ([0, 8]) — and small enough that it
        // still fits after the reflow test shrinks region_1 to [0, 6] — so the
        // song satisfies the clip-inside-region invariant. These tests exercise
        // region/marker geometry and jumps, not the clip itself.
        song.clips[0].timeline_start_seconds = 1.0;
        song.clips[0].duration_seconds = 4.0;
        song.section_markers = vec![
            Marker {
                id: "section_1".into(),
                name: "Intro".into(),
                start_seconds: 1.0,
                digit: Some(1),
                kind: MarkerKind::Custom,
                variant: None,
            },
            Marker {
                id: "section_2".into(),
                name: "Outro".into(),
                start_seconds: 15.0,
                digit: Some(2),
                kind: MarkerKind::Custom,
                variant: None,
            },
        ];
        song
    }

    fn demo_song_with_folder_track() -> Song {
        let mut song = demo_song();
        song.tracks.insert(
            0,
            Track {
                id: "folder_1".into(),
                name: "Folder".into(),
                kind: TrackKind::Folder,
                parent_track_id: None,
                volume: 1.0,
                pan: 0.0,
                muted: false,
                solo: false,
                transpose_enabled: false,
                audio_to: "master".to_string(),
                color: None,
                auto_created: false,
            },
        );
        // Make the audio track a child of the folder.
        if let Some(t) = song.tracks.iter_mut().find(|t| t.id == "track_1") {
            t.parent_track_id = Some("folder_1".into());
        }
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
                transpose_semitones: 0,
                warp_enabled: false,
                warp_source_bpm: None,
                master: libretracks_core::SongMaster::default(),
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
                    transpose_enabled: true,
                    audio_to: "master".to_string(),
                    color: None,
                    auto_created: false,
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
                    transpose_enabled: true,
                    audio_to: "master".to_string(),
                    color: None,
                    auto_created: false,
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
                    transpose_enabled: true,
                    audio_to: "master".to_string(),
                    color: None,
                    auto_created: false,
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
                    transpose_enabled: true,
                    audio_to: "master".to_string(),
                    color: None,
                    auto_created: false,
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

        let audio = crate::audio_engine::AudioController::default();
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

        let audio = crate::audio_engine::AudioController::default();
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
    fn snapshot_reports_seek_position_in_view_seconds_for_varispeed_region() {
        let song = demo_song_with_varispeed_region();
        let expected_source_seconds = source_seconds_at_view(&song, 10.0);
        let mut session = DesktopSession::default();
        session
            .engine
            .load_song(song)
            .expect("song should load into engine");

        let audio = crate::audio_engine::AudioController::default();
        let snapshot = session.seek(10.0, &audio).expect("seek should succeed");

        assert!(
            (session.engine.position_seconds() - expected_source_seconds).abs() < 1e-9,
            "engine should seek source-time"
        );
        assert!(
            (snapshot.position_seconds - 10.0).abs() < 1e-9,
            "snapshot should report view-time"
        );
        assert!(
            (snapshot.transport_clock.anchor_position_seconds - 10.0).abs() < 1e-9,
            "transport clock anchor should report view-time"
        );
        assert!(
            (snapshot
                .transport_clock
                .last_seek_position_seconds
                .expect("seek anchor should be recorded")
                - 10.0)
                .abs()
                < 1e-9
        );
    }

    #[test]
    fn scheduled_jump_snapshot_reports_execute_time_in_view_seconds_for_varispeed_region() {
        let mut song = demo_song_with_varispeed_region();
        song.section_markers.push(Marker {
            id: "section_target".into(),
            name: "Target".into(),
            start_seconds: 18.0,
            digit: Some(1),
            kind: MarkerKind::Custom,
            variant: None,
        });
        let expected_execute_seconds = warp_timeline_seconds_at(&song, 18.0);
        let mut session = DesktopSession::default();
        session
            .engine
            .load_song(song)
            .expect("song should load into engine");

        let audio = crate::audio_engine::AudioController::default();
        session.seek(10.0, &audio).expect("seek should succeed");
        let snapshot = session
            .schedule_marker_jump(
                "section_target",
                JumpTrigger::NextMarker,
                TransitionType::Instant,
                &audio,
            )
            .expect("jump should schedule");

        let pending = snapshot
            .pending_marker_jump
            .expect("pending jump should be exposed");
        assert!(
            (pending.execute_at_seconds - expected_execute_seconds).abs() < 1e-9,
            "snapshot pending execute time should be view-time"
        );
    }

    #[test]
    fn transport_timeline_scales_bpm_inside_varispeed_region() {
        let mut song = demo_song_with_varispeed_region();
        song.bpm = 120.0;
        song.regions[0].transpose_semitones = -2;
        let runtime = super::song_with_warped_timeline_for_transport(&song);
        let scale = 2.0_f64.powf(-2.0 / 12.0);
        let start_marker = runtime
            .tempo_markers
            .iter()
            .find(|marker| marker.id == "region_varispeed_varispeed_start")
            .expect("varispeed start tempo marker should be injected");
        let end_marker = runtime
            .tempo_markers
            .iter()
            .find(|marker| marker.id == "region_varispeed_varispeed_end")
            .expect("varispeed end tempo marker should be injected");

        assert!((start_marker.start_seconds - 5.0).abs() < 1e-9);
        assert!((start_marker.bpm - 120.0 * scale).abs() < 1e-9);
        assert!((end_marker.bpm - 120.0).abs() < 1e-9);
        assert!(end_marker.start_seconds > song.regions[0].end_seconds);
    }

    #[test]
    fn snapshot_after_playing_seek_keeps_visual_clock_running() {
        let mut session = DesktopSession::default();
        session
            .engine
            .load_song(demo_song())
            .expect("song should load into engine");
        session.engine.play().expect("engine should enter playback");
        session.engine.seek(3.5).expect("engine seek should work");
        session.transport_clock.seek_while_playing(3.5);

        let snapshot = session.snapshot();

        assert_eq!(snapshot.playback_state, "playing");
        assert!(snapshot.position_seconds >= 3.5);
        assert!(snapshot.position_seconds < 3.55);
        assert_eq!(snapshot.transport_clock.anchor_position_seconds, 3.5);
        assert_eq!(
            snapshot.transport_clock.last_seek_position_seconds,
            Some(3.5)
        );
        assert!(snapshot.transport_clock.running);
    }

    #[test]
    fn pause_freezes_position_after_real_playback() {
        let mut session = session_with_song_dir("pause-freeze-demo", demo_song());
        let audio = crate::audio_engine::AudioController::default();

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
    fn play_does_not_synchronously_prepare_missing_audio() {
        let root = tempdir().expect("temp dir should exist");
        let root_path = root.keep();
        let song = demo_song();
        let song_dir =
            create_song_folder(&root_path, "async-play-demo").expect("song dir should exist");
        fs::create_dir_all(song_dir.join("audio")).expect("audio dir should exist");
        save_song(&song_dir, &song).expect("song should save");

        let mut session = DesktopSession::default();
        session.song_file_path = Some(song_dir.join(SONG_FILE_NAME));
        session.song_dir = Some(song_dir);
        session
            .engine
            .load_song(song)
            .expect("song should load into engine");
        let audio = crate::audio_engine::AudioController::default();

        let snapshot = session
            .play(&audio)
            .expect("play should not prepare inline");

        assert_eq!(snapshot.playback_state, "playing");
    }

    #[test]
    // Needs the real engine's playhead estimate; the no-link stub reports a
    // static snapshot. Runs under `npm run test:native`.
    #[cfg_attr(feature = "no-link", ignore = "requires real engine output")]
    fn repeated_seeks_while_playing_keep_latest_seek_anchor() {
        let mut session = session_with_song_dir("rapid-seek-demo", demo_song());
        let audio = crate::audio_engine::AudioController::default();

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
    fn reparent_track_sets_inherit_route_when_entering_new_folder() {
        let mut tracks = hierarchy_song().tracks;
        let folder_b = tracks
            .iter_mut()
            .find(|track| track.id == "track_folder_b")
            .expect("folder should exist");
        folder_b.audio_to = "ext:2-3".to_string();

        super::reparent_track(
            &mut tracks,
            "track_folder_b",
            Some("track_child_a"),
            None,
            Some("track_folder_a"),
        )
        .expect("moving into a folder should succeed");

        let moved = tracks
            .iter()
            .find(|track| track.id == "track_folder_b")
            .expect("moved track should exist");
        assert_eq!(moved.parent_track_id.as_deref(), Some("track_folder_a"));
        assert_eq!(moved.audio_to, "inherit");
    }

    #[test]
    fn reparent_track_keeps_manual_route_when_reordering_inside_same_folder() {
        let mut tracks = hierarchy_song().tracks;
        let child_a = tracks
            .iter_mut()
            .find(|track| track.id == "track_child_a")
            .expect("child should exist");
        child_a.audio_to = "ext:2-3".to_string();

        super::reparent_track(
            &mut tracks,
            "track_child_a",
            None,
            Some("track_child_b"),
            Some("track_folder_a"),
        )
        .expect("reordering inside same folder should succeed");

        let moved = tracks
            .iter()
            .find(|track| track.id == "track_child_a")
            .expect("moved track should exist");
        assert_eq!(moved.parent_track_id.as_deref(), Some("track_folder_a"));
        assert_eq!(moved.audio_to, "ext:2-3");
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
                transpose_semitones: 0,
                warp_enabled: false,
                warp_source_bpm: None,
                master: libretracks_core::SongMaster::default(),
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
                    transpose_enabled: true,
                    audio_to: "master".to_string(),
                    color: None,
                    auto_created: false,
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
                    transpose_enabled: true,
                    audio_to: "master".to_string(),
                    color: None,
                    auto_created: false,
                },
            ],
            clips: vec![],
            section_markers: vec![],
        };

        let view = song_to_view(
            &song,
            &AutomationDocument::default(),
            &std::collections::HashMap::new(),
            &WaveformMemoryCache::default(),
            7,
            None,
            true,
        );

        assert_eq!(view.tracks[0].id, "folder_main");
        assert_eq!(view.tracks[0].parent_track_id, None);
        assert_eq!(view.tracks[1].id, "track-drums_01");
        assert_eq!(
            view.tracks[1].parent_track_id.as_deref(),
            Some("folder_main")
        );
    }

    #[test]
    // Asserts on real playback drift; the no-link stub does not run audio.
    // Runs under `npm run test:native`.
    #[cfg_attr(feature = "no-link", ignore = "requires real engine output")]
    fn executing_section_jump_reanchors_transport_and_runtime() {
        let mut session =
            session_with_song_dir("jump-resync-demo", demo_song_with_three_sections());
        let audio = crate::audio_engine::AudioController::default();

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
        let audio = crate::audio_engine::AudioController::default();

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

        let audio = crate::audio_engine::AudioController::default();
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
    fn batch_move_can_reassign_clip_to_another_track() {
        // Dragging a clip vertically onto another lane: the batch move
        // carries target_track_id, so position and track change together in
        // one operation. The origin track (auto_created) is then pruned
        // because it lost its only clip.
        let mut song = demo_song();
        song.tracks[0].auto_created = true;
        song.tracks.push(Track {
            id: "track_2".into(),
            name: "Track 2".into(),
            kind: TrackKind::Audio,
            parent_track_id: None,
            volume: 1.0,
            pan: 0.0,
            muted: false,
            solo: false,
            transpose_enabled: true,
            audio_to: "master".to_string(),
            color: None,
            auto_created: false,
        });
        let mut session = session_with_song_dir("batch-move-track", song);
        let audio = crate::audio_engine::AudioController::default();

        session
            .move_clips_batch(
                &[ClipMoveRequest {
                    clip_id: "clip_1".into(),
                    timeline_start_seconds: 3.0,
                    target_track_id: Some("track_2".into()),
                }],
                &audio,
            )
            .expect("batch move with track change should succeed");

        let song_view = session
            .song_view()
            .expect("song view should build")
            .expect("song view should exist");
        let clip = song_view
            .clips
            .iter()
            .find(|clip| clip.id == "clip_1")
            .expect("clip should still exist");
        assert_eq!(clip.track_id, "track_2");
        assert_eq!(clip.timeline_start_seconds, 3.0);
        // Origin track was auto-created and is now empty → pruned.
        assert!(song_view.tracks.iter().all(|track| track.id != "track_1"));
    }

    #[test]
    fn batch_move_rejects_folder_as_target_track() {
        let mut song = demo_song_with_folder_track();
        let folder_id = song
            .tracks
            .iter()
            .find(|track| track.kind == TrackKind::Folder)
            .expect("folder track should exist")
            .id
            .clone();
        let mut session = session_with_song_dir("batch-move-folder", song);
        let audio = crate::audio_engine::AudioController::default();

        let result = session.move_clips_batch(
            &[ClipMoveRequest {
                clip_id: "clip_1".into(),
                timeline_start_seconds: 1.0,
                target_track_id: Some(folder_id),
            }],
            &audio,
        );
        assert!(result.is_err(), "moving a clip onto a folder must fail");
    }

    #[test]
    fn moving_a_clip_before_bar_one_clamps_to_the_timeline_start() {
        // The clip-inside-region invariant no longer allows a clip to start
        // before 0 (it would fall outside every region), so moving to a
        // negative position clamps the clip to the timeline start.
        let mut session = session_with_song_dir("negative-clip-start", demo_song());
        let audio = crate::audio_engine::AudioController::default();

        session
            .move_clip("clip_1", -1.5, &audio)
            .expect("clip should move");
        let song = session.engine.song().expect("song should remain loaded");

        assert_eq!(song.clips[0].timeline_start_seconds, 0.0);
    }

    #[test]
    fn live_track_mix_updates_skip_disk_model_and_project_revision() {
        let mut session = session_with_song_dir("live-mix-demo", demo_song());
        let song_dir = session
            .song_dir
            .clone()
            .expect("song dir should exist for loaded session");
        save_song(&song_dir, &demo_song()).expect("seed song should save");

        let audio = crate::audio_engine::AudioController::default();
        let initial_revision = session.snapshot().project_revision;

        // Category A: bridge-only, no model mutation, no undo, no revision bump.
        audio
            .update_live_track_mix(
                "track_1",
                Some(0.61),
                Some(-0.22),
                Some(true),
                Some(true),
                None,
            )
            .expect("live mix update should succeed");

        let diagnostics = audio.realtime_control_diagnostics();
        assert_eq!(diagnostics.live_mix_realtime_command_count, 1);
        assert_eq!(diagnostics.session_rebuild_count, 0);
        assert_eq!(diagnostics.live_mix_ensure_live_track_count, 0);

        let updated_song = session
            .song_view()
            .expect("song view should build")
            .expect("song view should exist");
        let updated_track = updated_song
            .tracks
            .into_iter()
            .find(|track| track.id == "track_1")
            .expect("updated track should exist");

        // Rust model must NOT have changed — Category A is bridge-only.
        assert_eq!(session.snapshot().project_revision, initial_revision);
        assert_eq!(updated_track.volume, 1.0);
        assert_eq!(updated_track.pan, 0.0);
        assert!(!updated_track.muted);
        assert!(!updated_track.solo);

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
    fn realtime_slider_drag_does_not_sync_session() {
        let audio = crate::audio_engine::AudioController::default();

        for i in 0..200 {
            audio
                .update_live_track_mix("track_1", Some(i as f64 / 200.0), None, None, None, None)
                .expect("realtime gain update should send");
        }

        let diagnostics = audio.realtime_control_diagnostics();
        assert_eq!(diagnostics.live_mix_realtime_command_count, 200);
        assert_eq!(diagnostics.session_rebuild_count, 0);
        assert_eq!(diagnostics.live_mix_ensure_live_track_count, 0);
    }

    #[test]
    fn realtime_pan_drag_does_not_rebuild_session() {
        let audio = crate::audio_engine::AudioController::default();

        for i in 0..200 {
            let pan = -1.0 + (i as f64 / 100.0);
            audio
                .update_live_track_mix("track_1", None, Some(pan), None, None, None)
                .expect("realtime pan update should send");
        }

        let diagnostics = audio.realtime_control_diagnostics();
        assert_eq!(diagnostics.live_mix_realtime_command_count, 200);
        assert_eq!(diagnostics.session_rebuild_count, 0);
        assert_eq!(diagnostics.live_mix_ensure_live_track_count, 0);
    }

    #[test]
    fn metronome_realtime_commands_do_not_use_full_config_path() {
        let audio = crate::audio_engine::AudioController::default();

        for i in 0..20 {
            audio
                .set_metronome_enabled_realtime(i % 2 == 0)
                .expect("realtime metronome toggle should send");
        }
        audio
            .set_metronome_volume_realtime(0.42)
            .expect("realtime metronome volume should send");

        let diagnostics = audio.realtime_control_diagnostics();
        assert_eq!(diagnostics.metronome_realtime_toggle_count, 20);
        assert_eq!(diagnostics.metronome_realtime_volume_count, 1);
        assert_eq!(diagnostics.session_rebuild_count, 0);
        assert_eq!(diagnostics.live_mix_ensure_live_track_count, 0);
    }

    #[test]
    fn live_track_mix_commit_undoes_in_single_step() {
        let mut session = session_with_song_dir("live-mix-undo-demo", demo_song());
        let audio = crate::audio_engine::AudioController::default();

        // Category A bridge: realtime command only, no model mutation, no undo entry.
        audio
            .update_live_track_mix(
                "track_1",
                Some(0.61),
                Some(-0.22),
                Some(true),
                Some(true),
                None,
            )
            .expect("live mix update should succeed");
        assert_eq!(session.undo_stack.len(), 0);

        session
            .commit_track_mix_model_and_command(
                "track_1",
                Some(0.61),
                Some(-0.22),
                Some(true),
                Some(true),
                None,
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
    fn repeated_region_transpose_changes_group_into_one_undo_entry() {
        let mut session = session_with_song_dir("transpose-undo-demo", demo_song());
        let audio = crate::audio_engine::AudioController::default();

        session
            .update_song_region_transpose("region_1", 1, &audio)
            .expect("first transpose change should succeed");
        session
            .update_song_region_transpose("region_1", 2, &audio)
            .expect("second transpose change should succeed");

        assert_eq!(session.undo_stack.len(), 1);

        session.undo_action(&audio).expect("undo should succeed");
        let region = session
            .song_view()
            .expect("song view should build")
            .expect("song view should exist")
            .regions
            .into_iter()
            .find(|region| region.id == "region_1")
            .expect("region should exist after undo");

        assert_eq!(region.transpose_semitones, 0);
    }

    #[test]
    fn live_clip_move_commit_undoes_in_single_step() {
        let mut session = session_with_song_dir("live-clip-move-demo", demo_song());
        let audio = crate::audio_engine::AudioController::default();
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

        let audio = crate::audio_engine::AudioController::default();
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
        let imported_click_path = imported_click
            .canonicalize()
            .unwrap_or_else(|_| imported_click.clone())
            .to_string_lossy()
            .replace('\\', "/");

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
            .any(|asset| asset.file_path.replace('\\', "/") == imported_click_path));
    }

    #[test]
    fn import_audio_files_from_bytes_returns_only_newly_imported_assets() {
        let mut session = session_with_song_dir("library-import-bytes-demo", demo_song());
        let song_dir = session.song_dir.clone().expect("song dir should exist");

        write_silent_test_wav(&song_dir.join("audio").join("existing-a.wav"), 2);
        write_silent_test_wav(&song_dir.join("audio").join("existing-b.wav"), 3);
        write_silent_test_wav(&song_dir.join("audio").join("existing-c.wav"), 4);
        write_library_manifest_assets(
            &song_dir,
            &[
                LibraryAssetSummary {
                    file_name: "existing-a.wav".into(),
                    file_path: "audio/existing-a.wav".into(),
                    duration_seconds: 2.0,
                    is_missing: false,
                    folder_path: None,
                },
                LibraryAssetSummary {
                    file_name: "existing-b.wav".into(),
                    file_path: "audio/existing-b.wav".into(),
                    duration_seconds: 3.0,
                    is_missing: false,
                    folder_path: None,
                },
                LibraryAssetSummary {
                    file_name: "existing-c.wav".into(),
                    file_path: "audio/existing-c.wav".into(),
                    duration_seconds: 4.0,
                    is_missing: false,
                    folder_path: None,
                },
            ],
        )
        .expect("manifest should save");

        let imports_root = tempdir().expect("temp dir should exist");
        let dropped_a = imports_root.path().join("dropped-a.wav");
        let dropped_b = imports_root.path().join("dropped-b.wav");
        write_silent_test_wav(&dropped_a, 5);
        write_silent_test_wav(&dropped_b, 6);

        let imported_assets = session
            .import_audio_files_from_bytes(&[
                AudioFileImportPayload {
                    file_name: "dropped-a.wav".into(),
                    bytes: fs::read(&dropped_a).expect("first dropped wav should read"),
                },
                AudioFileImportPayload {
                    file_name: "dropped-b.wav".into(),
                    bytes: fs::read(&dropped_b).expect("second dropped wav should read"),
                },
            ])
            .expect("byte import should succeed");

        assert_eq!(imported_assets.len(), 2);
        assert!(imported_assets
            .iter()
            .any(|asset| asset.file_path == "audio/dropped-a.wav"));
        assert!(imported_assets
            .iter()
            .any(|asset| asset.file_path == "audio/dropped-b.wav"));
        assert!(imported_assets
            .iter()
            .all(|asset| asset.file_name.starts_with("dropped-")));

        let all_assets = session
            .get_library_assets()
            .expect("full library assets should still load");
        assert_eq!(all_assets.len(), 6);
    }

    #[test]
    // Package import asks the engine for source peaks, which the no-link stub
    // cannot produce. Runs under `npm run test:native`.
    #[cfg_attr(feature = "no-link", ignore = "requires real engine output")]
    fn import_song_package_returns_library_assets_for_missing_audio_references() {
        let source_root = tempdir().expect("temp dir should exist");
        let source_song_dir = create_song_folder(source_root.path(), "package-source")
            .expect("source song dir should exist");
        let source_song = demo_song();
        save_song(&source_song_dir, &source_song).expect("source song should save");
        write_library_manifest_assets(
            &source_song_dir,
            &[LibraryAssetSummary {
                file_name: "test.wav".into(),
                file_path: "audio/test.wav".into(),
                duration_seconds: 4.0,
                is_missing: false,
                folder_path: Some("Imported/Refs".into()),
            }],
        )
        .expect("source manifest should save");

        let package_path = source_song_dir.join("demo.ltpkg");
        let export_cache_root = tempdir().expect("export cache root");
        export_region_as_package(
            export_cache_root.path(),
            &source_song_dir,
            &source_song,
            "region_1",
            &package_path,
            false,
        )
        .expect("package should export");

        let target_root = tempdir().expect("temp dir should exist");
        let target_song_dir = create_song_folder(target_root.path(), "package-import-target")
            .expect("target song dir should exist");
        let target_song = build_empty_song("song_target".into(), "Target".into());
        save_song(&target_song_dir, &target_song).expect("target song should save");

        let mut session = DesktopSession::default();
        session.song_file_path = Some(target_song_dir.join(SONG_FILE_NAME));
        session.song_dir = Some(target_song_dir);
        session
            .engine
            .load_song(target_song)
            .expect("target song should load into engine");
        let audio = crate::audio_engine::AudioController::default();

        let result = session
            .import_song_package(&package_path.to_string_lossy(), 0.0, &audio)
            .expect("package import should succeed");

        let imported_asset = result
            .library_assets
            .iter()
            .find(|asset| asset.file_path == "audio/test.wav")
            .unwrap_or_else(|| {
                panic!(
                    "missing imported asset in response: {:?}",
                    result.library_assets
                )
            });
        assert!(imported_asset.is_missing);

        let song_view = session
            .song_view()
            .expect("song view should build")
            .expect("song should exist");
        assert!(song_view
            .clips
            .iter()
            .any(|clip| { clip.file_path == "audio/test.wav" && clip.is_missing }));
        assert_eq!(result.snapshot.project_revision, song_view.project_revision);
    }

    #[test]
    fn create_clip_adds_a_library_asset_to_an_existing_audio_track() {
        let mut session = session_with_song_dir("create-clip-demo", demo_song());
        let audio = crate::audio_engine::AudioController::default();

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
        let audio = crate::audio_engine::AudioController::default();
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
        let audio = crate::audio_engine::AudioController::default();
        let initial_snapshot = session.snapshot();

        let updated_snapshot = session
            .move_clip("clip_1", 4.25, &audio)
            .expect("clip should move");

        assert!(updated_snapshot.project_revision > initial_snapshot.project_revision);
    }

    #[test]
    fn undo_and_redo_restore_song_state() {
        let mut session = session_with_song_dir("undo-redo-demo", demo_song());
        let audio = crate::audio_engine::AudioController::default();

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
    // Exercises the real engine's waveform cache counters; the no-link stub
    // performs no analysis. Runs under `npm run test:native`.
    #[cfg_attr(feature = "no-link", ignore = "requires real engine output")]
    fn waveform_requests_reuse_the_in_memory_cache_after_song_load() {
        let root = tempdir().expect("temp dir should exist");
        let song_dir =
            create_song_folder(root.path(), "waveform-cache-demo").expect("song dir should exist");
        let wav_path = song_dir.join("audio").join("test.wav");
        write_silent_test_wav(&wav_path, 6);
        generate_waveform_summary(&song_dir, "audio/test.wav").expect("waveform should generate");
        save_song(&song_dir, &demo_song()).expect("song should save");

        let mut session = DesktopSession::default();
        let audio = crate::audio_engine::AudioController::default();
        session
            .load_song_from_path(demo_song(), song_dir, &audio)
            .expect("song should load");

        let perf_after_load = session.performance_snapshot();
        let first_waveform = session
            .load_waveforms_internal(&["audio/test.wav".to_string()], None, None)
            .expect("waveform should load");
        let perf_after_first_request = session.performance_snapshot();
        let second_waveform = session
            .load_waveforms_internal(&["audio/test.wav".to_string()], None, None)
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

        let audio = crate::audio_engine::AudioController::default();
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

        let audio = crate::audio_engine::AudioController::default();
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
            kind: MarkerKind::Custom,
            variant: None,
        });
        save_song(&song_dir, &song).expect("song should save");

        let mut session = DesktopSession::default();
        session.song_dir = Some(song_dir.clone());
        session
            .engine
            .load_song(song)
            .expect("song should load into engine");

        let audio = crate::audio_engine::AudioController::default();
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

        let audio = crate::audio_engine::AudioController::default();
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

        let audio = crate::audio_engine::AudioController::default();
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
        let duplicated_clip = snapshot_song
            .clips
            .iter()
            .find(|clip| clip.id != "clip_1")
            .expect("duplicated clip should exist");
        assert_eq!(duplicated_clip.file_path, "audio/test.wav");
        assert_eq!(
            fs::read_dir(song_dir.join("audio"))
                .expect("audio dir should be readable")
                .count(),
            0
        );

        let saved_song = load_song(&song_dir).expect("song json should load");
        assert_eq!(saved_song.clips.len(), 1);
    }

    #[test]
    // Pre-dates the clip-inside-region invariant: it duplicates a clip to a
    // position outside every region, which save_song now rejects. Kept for
    // reference until the region/clip duplication behaviour is revisited.
    #[ignore = "scenario invalid under the clip-inside-region invariant; revisit duplication behaviour"]
    fn duplicating_a_clip_does_not_stretch_the_last_region() {
        let root = tempdir().expect("temp dir should exist");
        let song_dir = create_song_folder(root.path(), "clip-duplicate-region-demo")
            .expect("song dir should exist");
        fs::create_dir_all(song_dir.join("audio")).expect("audio dir should exist");

        let mut song = demo_song();
        song.regions[0].end_seconds = 2.0;
        // Shrink the clip to fit inside the shortened region ([0, 2]) so the
        // starting song is valid; the test then checks that duplicating the
        // clip past the region does not stretch the region.
        song.clips[0].timeline_start_seconds = 0.0;
        song.clips[0].duration_seconds = 2.0;
        save_song(&song_dir, &song).expect("song should save");

        let mut session = DesktopSession::default();
        session.song_dir = Some(song_dir.clone());
        session
            .engine
            .load_song(song)
            .expect("song should load into engine");

        let audio = crate::audio_engine::AudioController::default();
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

        let audio = crate::audio_engine::AudioController::default();
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

        let audio = crate::audio_engine::AudioController::default();
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

        let audio = crate::audio_engine::AudioController::default();
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

        let audio = crate::audio_engine::AudioController::default();
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

        let audio = crate::audio_engine::AudioController::default();
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

        let audio = crate::audio_engine::AudioController::default();
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

        let audio = crate::audio_engine::AudioController::default();
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

        let audio = crate::audio_engine::AudioController::default();
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

        let audio = crate::audio_engine::AudioController::default();
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

        let audio = crate::audio_engine::AudioController::default();
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
        // No clips: splitting the single region at 2..5 would otherwise leave
        // demo_song's [1, 5] clip crossing the new boundary. This test checks
        // region-split geometry, so an empty timeline is the right fixture.
        let mut song = demo_song();
        song.clips.clear();
        let mut session = session_with_song_dir("region-create-demo", song);
        let song_dir = session.song_dir.clone().expect("song dir should exist");

        let audio = crate::audio_engine::AudioController::default();
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
        // One region already exists, so the new one is named "Song 2".
        assert_eq!(created_region.name, "Song 2");

        let saved_song = load_song(&song_dir).expect("song json should load");
        assert_eq!(saved_song.regions.len(), 1);
    }

    #[test]
    fn creating_a_song_region_beyond_song_duration_preserves_its_bounds() {
        let mut session = session_with_song_dir("region-beyond-duration-demo", demo_song());
        let song_dir = session.song_dir.clone().expect("song dir should exist");

        let audio = crate::audio_engine::AudioController::default();
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
        // One region already exists, so the new one is named "Song 2".
        assert_eq!(created_region.name, "Song 2");

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

        let audio = crate::audio_engine::AudioController::default();
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

        let audio = crate::audio_engine::AudioController::default();
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

        let audio = crate::audio_engine::AudioController::default();
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
        let audio = crate::audio_engine::AudioController::default();

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
        let diagnostics = audio.realtime_control_diagnostics();
        assert_eq!(diagnostics.transport_timing_update_count, 1);
        assert_eq!(
            diagnostics.session_rebuild_count, 0,
            "tempo commits must refresh native timing without reloading sources"
        );
    }

    #[test]
    fn updating_song_tempo_preserves_existing_tempo_markers_while_updating_the_base_bpm() {
        let mut session = session_with_song_dir("song-tempo-reset-demo", demo_song());
        let audio = crate::audio_engine::AudioController::default();

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
    fn disabling_region_warp_restores_timeline_bpm_to_source_bpm() {
        let mut session = session_with_song_dir("region-warp-disable-bpm-demo", demo_song());
        let audio = crate::audio_engine::AudioController::default();

        session
            .update_song_tempo(91.0, &audio)
            .expect("source tempo should update");
        session
            .update_song_region_warp("region_1", true, Some(91.0), &audio)
            .expect("warp should enable");
        session
            .update_song_tempo(100.0, &audio)
            .expect("timeline tempo should update while warped");
        session
            .update_song_region_warp("region_1", false, None, &audio)
            .expect("warp should disable");

        let song_view = session
            .song_view()
            .expect("song view should build")
            .expect("song summary should exist");

        assert_eq!(song_view.bpm, 91.0);
        assert_eq!(song_view.regions[0].warp_enabled, false);
        assert_eq!(song_view.regions[0].warp_source_bpm, Some(91.0));
    }

    #[test]
    fn changing_warped_region_tempo_keeps_following_song_on_downbeat() {
        let mut song = demo_song();
        song.bpm = 120.0;
        song.time_signature = "4/4".into();
        song.tempo_markers = vec![
            TempoMarker {
                id: "tempo_middle".into(),
                start_seconds: 10.0,
                bpm: 130.0,
            },
            TempoMarker {
                id: "tempo_following".into(),
                start_seconds: 17.384615384615387,
                bpm: 140.0,
            },
        ];
        song.regions = vec![
            SongRegion {
                id: "region_intro".into(),
                name: "Intro".into(),
                start_seconds: 0.0,
                end_seconds: 9.0,
                transpose_semitones: 0,
                warp_enabled: false,
                warp_source_bpm: None,
                master: libretracks_core::SongMaster::default(),
            },
            SongRegion {
                id: "region_middle".into(),
                name: "Warped".into(),
                start_seconds: 10.0,
                end_seconds: 17.0,
                transpose_semitones: 0,
                warp_enabled: true,
                warp_source_bpm: Some(130.0),
                master: libretracks_core::SongMaster::default(),
            },
            SongRegion {
                id: "region_following".into(),
                name: "Following".into(),
                start_seconds: 17.384615384615387,
                end_seconds: 25.0,
                transpose_semitones: 0,
                warp_enabled: false,
                warp_source_bpm: None,
                master: libretracks_core::SongMaster::default(),
            },
        ];
        song.clips = vec![
            Clip {
                id: "clip_middle".into(),
                track_id: "track_1".into(),
                file_path: "audio/middle.wav".into(),
                timeline_start_seconds: 10.0,
                source_start_seconds: 0.0,
                duration_seconds: 7.0,
                gain: 1.0,
                fade_in_seconds: None,
                fade_out_seconds: None,
                color: None,
            },
            Clip {
                id: "clip_following".into(),
                track_id: "track_1".into(),
                file_path: "audio/following.wav".into(),
                timeline_start_seconds: 17.384615384615387,
                source_start_seconds: 0.0,
                duration_seconds: 7.0,
                gain: 1.0,
                fade_in_seconds: None,
                fade_out_seconds: None,
                color: None,
            },
        ];

        let previous_song = song.clone();
        song.tempo_markers[0].bpm = 110.0;
        realign_regions_after_warp_tempo_change(&previous_song, &mut song);

        let middle = song
            .regions
            .iter()
            .find(|region| region.id == "region_middle")
            .expect("middle region");
        let following = song
            .regions
            .iter()
            .find(|region| region.id == "region_following")
            .expect("following region");
        let following_clip = song
            .clips
            .iter()
            .find(|clip| clip.id == "clip_following")
            .expect("following clip");
        let following_tempo = song
            .tempo_markers
            .iter()
            .find(|marker| marker.id == "tempo_following")
            .expect("following tempo marker");

        let expected_view_start = next_downbeat_after_in_view_timeline(
            &song,
            warp_timeline_seconds_at(&song, middle.end_seconds),
        );
        let actual_view_start = warp_timeline_seconds_at(&song, following.start_seconds);
        assert!((actual_view_start - expected_view_start).abs() < 0.0001);
        assert!((following.start_seconds - following_clip.timeline_start_seconds).abs() < 0.0001);
        assert!((following.start_seconds - following_tempo.start_seconds).abs() < 0.0001);
        assert!(following.start_seconds > 17.384615384615387);
        validate_song(&song).expect("realigned song should validate");
    }

    #[test]
    fn updating_song_time_signature_preserves_existing_time_signature_markers() {
        let mut session = session_with_song_dir("song-time-signature-reset-demo", demo_song());
        let audio = crate::audio_engine::AudioController::default();

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
        let audio = crate::audio_engine::AudioController::default();

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
        let audio = crate::audio_engine::AudioController::default();

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

    // ── Phase 9: section marker MixerOnly path ────────────────────────────────

    #[test]
    fn section_marker_create_does_not_trigger_session_rebuild() {
        // Section markers are Rust-model-only — C++ must not receive a LoadSession.
        // Verified by checking that realtime_command_count stays at zero (no commands sent).
        let mut session = session_with_song_dir("section-create-demo", demo_song());
        let audio = crate::audio_engine::AudioController::default();
        let initial_revision = session.snapshot().project_revision;

        let snapshot = session
            .create_section_marker(2.5, &audio)
            .expect("section marker should be created");

        let diagnostics = audio.realtime_control_diagnostics();
        assert_eq!(diagnostics.live_mix_realtime_command_count, 0);
        assert_eq!(diagnostics.session_rebuild_count, 0);
        // Revision bumps (model changed) but no realtime commands were sent.
        assert!(snapshot.project_revision > initial_revision);

        let song_view = session
            .song_view()
            .expect("song view should build")
            .expect("song view should exist");
        assert_eq!(song_view.section_markers.len(), 1);
        assert_eq!(song_view.section_markers[0].start_seconds, 2.5);
    }

    #[test]
    fn section_marker_update_does_not_trigger_session_rebuild() {
        let mut session = session_with_song_dir("section-update-demo", demo_song_with_section());
        let audio = crate::audio_engine::AudioController::default();

        session
            .update_section_marker("section_1", "Verse", 3.0, &audio)
            .expect("section marker update should succeed");

        let diagnostics = audio.realtime_control_diagnostics();
        assert_eq!(diagnostics.live_mix_realtime_command_count, 0);
        assert_eq!(diagnostics.session_rebuild_count, 0);

        let song_view = session
            .song_view()
            .expect("song view should build")
            .expect("song view should exist");
        assert_eq!(song_view.section_markers[0].name, "Verse");
        assert_eq!(song_view.section_markers[0].start_seconds, 3.0);
    }

    #[test]
    fn section_marker_delete_does_not_trigger_session_rebuild() {
        let mut session = session_with_song_dir("section-delete-demo", demo_song_with_section());
        let audio = crate::audio_engine::AudioController::default();

        session
            .delete_section_marker("section_1", &audio)
            .expect("section marker deletion should succeed");

        let diagnostics = audio.realtime_control_diagnostics();
        assert_eq!(diagnostics.live_mix_realtime_command_count, 0);
        assert_eq!(diagnostics.session_rebuild_count, 0);

        let song_view = session
            .song_view()
            .expect("song view should build")
            .expect("song view should exist");
        assert_eq!(song_view.section_markers.len(), 0);
    }

    #[test]
    fn section_marker_assign_digit_does_not_trigger_session_rebuild() {
        let mut session = session_with_song_dir("section-digit-demo", demo_song_with_section());
        let audio = crate::audio_engine::AudioController::default();

        session
            .assign_section_marker_digit("section_1", Some(3), &audio)
            .expect("assign digit should succeed");

        let diagnostics = audio.realtime_control_diagnostics();
        assert_eq!(diagnostics.live_mix_realtime_command_count, 0);
        assert_eq!(diagnostics.session_rebuild_count, 0);

        let song_view = session
            .song_view()
            .expect("song view should build")
            .expect("song view should exist");
        assert_eq!(song_view.section_markers[0].digit, Some(3));
    }

    #[test]
    fn set_section_marker_kind_updates_kind_without_session_rebuild() {
        let mut session = session_with_song_dir("section-kind-demo", demo_song_with_section());
        let audio = crate::audio_engine::AudioController::default();

        session
            .set_section_marker_kind("section_1", MarkerKind::Chorus, Some(2), &audio)
            .expect("set kind should succeed");

        // Changing kind/variant is a live marker update for the voice guide, not
        // a full session rebuild (which would interrupt playback).
        let diagnostics = audio.realtime_control_diagnostics();
        assert_eq!(diagnostics.session_rebuild_count, 0);

        let song_view = session
            .song_view()
            .expect("song view should build")
            .expect("song view should exist");
        assert_eq!(song_view.section_markers[0].kind, MarkerKind::Chorus);
        assert_eq!(song_view.section_markers[0].variant, Some(2));
    }

    #[test]
    fn set_section_marker_kind_rejects_unknown_section() {
        let mut session = session_with_song_dir("section-kind-missing", demo_song_with_section());
        let audio = crate::audio_engine::AudioController::default();

        let result = session.set_section_marker_kind("nope", MarkerKind::Verse, None, &audio);
        assert!(matches!(
            result,
            Err(crate::error::DesktopError::SectionNotFound(_))
        ));
    }

    // ── Phase 5: set_track_transpose_enabled_realtime path ───────────────────

    #[test]
    fn transpose_enabled_toggle_sends_realtime_command_not_load_session() {
        let mut session = session_with_song_dir("transpose-enabled-demo", demo_song());
        let audio = crate::audio_engine::AudioController::default();
        let initial_revision = session.snapshot().project_revision;

        session
            .update_track_transpose_enabled("track_1", false, &audio)
            .expect("transpose enable toggle should succeed");

        let diagnostics = audio.realtime_control_diagnostics();
        // set_track_transpose_enabled_realtime sends one CmdSetTrackTransposeEnabled.
        // It is counted as a realtime command (live_mix_realtime_command_count).
        assert_eq!(diagnostics.session_rebuild_count, 0);
        // Revision bumps because the Rust model changed.
        assert!(session.snapshot().project_revision > initial_revision);

        let song_view = session
            .song_view()
            .expect("song view should build")
            .expect("song view should exist");
        let track = song_view
            .tracks
            .into_iter()
            .find(|t| t.id == "track_1")
            .expect("track should exist");
        assert!(!track.transpose_enabled);
    }

    #[test]
    fn save_project_persists_pending_song_changes() {
        let mut session = session_with_song_dir("save-project-demo", demo_song());
        let song_dir = session
            .song_dir
            .clone()
            .expect("song dir should exist for loaded session");
        save_song(&song_dir, &demo_song()).expect("seed song should save");

        let audio = crate::audio_engine::AudioController::default();
        session
            .move_clip("clip_1", 6.5, &audio)
            .expect("clip should move");

        let unsaved_song = load_song(&song_dir).expect("song json should load");
        assert_eq!(unsaved_song.clips[0].timeline_start_seconds, 1.0);

        session.save_project().expect("save should succeed");

        let saved_song = load_song(&song_dir).expect("song json should load");
        assert_eq!(saved_song.clips[0].timeline_start_seconds, 6.5);
    }

    // ── Phase 11 (second pass): strict thin-bridge enforcement tests ──────────

    /// Category A: realtime bridge sends command but must NOT mutate the Rust model.
    #[test]
    fn realtime_bridge_does_not_mutate_rust_model() {
        let mut session = session_with_song_dir("realtime-bridge-model-demo", demo_song());
        let audio = crate::audio_engine::AudioController::default();

        let before = session
            .song_view()
            .expect("song view should build")
            .expect("song view should exist")
            .tracks
            .into_iter()
            .find(|t| t.id == "track_1")
            .expect("track should exist");

        // Category A: direct audio controller call, no session involvement.
        audio
            .update_live_track_mix("track_1", Some(0.5), Some(0.3), Some(true), None, None)
            .expect("realtime update should succeed");

        let after = session
            .song_view()
            .expect("song view should build")
            .expect("song view should exist")
            .tracks
            .into_iter()
            .find(|t| t.id == "track_1")
            .expect("track should exist");

        // Rust model must be unchanged — Category A is bridge-only.
        assert_eq!(after.volume, before.volume);
        assert_eq!(after.pan, before.pan);
        assert_eq!(after.muted, before.muted);
    }

    /// Category A: realtime bridge must not create an undo entry.
    #[test]
    fn realtime_bridge_does_not_create_undo_entry() {
        let mut session = session_with_song_dir("realtime-bridge-undo-demo", demo_song());
        let audio = crate::audio_engine::AudioController::default();

        let undo_before = session.undo_stack.len();

        for _ in 0..10 {
            audio
                .update_live_track_mix("track_1", Some(0.8), None, None, None, None)
                .expect("realtime update should succeed");
        }

        assert_eq!(
            session.undo_stack.len(),
            undo_before,
            "undo stack must not grow from realtime commands"
        );
    }

    /// Category A: realtime bridge must not increment the project revision.
    #[test]
    fn realtime_bridge_does_not_bump_project_revision() {
        let mut session = session_with_song_dir("realtime-bridge-revision-demo", demo_song());
        let audio = crate::audio_engine::AudioController::default();

        let revision_before = session.snapshot().project_revision;

        for i in 0..20 {
            audio
                .update_live_track_mix("track_1", Some(i as f64 / 20.0), None, None, None, None)
                .expect("realtime update should succeed");
        }

        assert_eq!(
            session.snapshot().project_revision,
            revision_before,
            "project revision must not change from Category A commands"
        );
    }

    /// Commit path (pointer-up): must bump revision and send exactly one realtime command.
    #[test]
    fn commit_track_mix_bumps_revision_and_sends_one_realtime_command() {
        let mut session = session_with_song_dir("commit-mix-demo", demo_song());
        let audio = crate::audio_engine::AudioController::default();

        let revision_before = session.snapshot().project_revision;
        let diag_before = audio.realtime_control_diagnostics();

        session
            .commit_track_mix_model_and_command(
                "track_1",
                Some(0.75),
                None,
                None,
                None,
                None,
                &audio,
            )
            .expect("commit should succeed");

        let revision_after = session.snapshot().project_revision;
        let diag_after = audio.realtime_control_diagnostics();

        assert!(
            revision_after > revision_before,
            "commit must bump project revision"
        );
        assert_eq!(
            diag_after.live_mix_realtime_command_count
                - diag_before.live_mix_realtime_command_count,
            1,
            "commit must send exactly one targeted realtime command"
        );
        assert_eq!(
            diag_after.commit_mix_command_count,
            diag_before.commit_mix_command_count + 1,
            "commit must increment commit_mix_command_count"
        );
        assert_eq!(
            diag_after.session_rebuild_count, 0,
            "commit must not trigger a session rebuild"
        );
    }

    /// Commit path: must create one undo entry.
    #[test]
    fn commit_track_mix_creates_one_undo_entry() {
        let mut session = session_with_song_dir("commit-undo-demo", demo_song());
        let audio = crate::audio_engine::AudioController::default();

        let undo_before = session.undo_stack.len();

        session
            .commit_track_mix_model_and_command(
                "track_1",
                Some(0.5),
                None,
                None,
                None,
                None,
                &audio,
            )
            .expect("commit should succeed");
        session
            .commit_track_mix_model_and_command(
                "track_1",
                Some(0.6),
                None,
                None,
                None,
                None,
                &audio,
            )
            .expect("commit should succeed");

        assert_eq!(
            session.undo_stack.len(),
            undo_before + 2,
            "each commit must create exactly one undo entry"
        );
    }

    /// Track name change must not send any audio command.
    #[test]
    fn update_track_name_does_not_send_audio_command() {
        let mut session = session_with_song_dir("name-change-demo", demo_song());
        let audio = crate::audio_engine::AudioController::default();

        let diag_before = audio.realtime_control_diagnostics();

        // Name-only change via update_track_name_only.
        session
            .update_track_name_only("track_1", "New Name", &audio)
            .expect("name change should succeed");

        let diag_after = audio.realtime_control_diagnostics();

        assert_eq!(
            diag_after.live_mix_realtime_command_count, diag_before.live_mix_realtime_command_count,
            "name-only change must not send any audio command"
        );
        assert_eq!(diag_after.session_rebuild_count, 0);

        let song_view = session
            .song_view()
            .expect("song view should build")
            .expect("song view should exist");
        let track = song_view
            .tracks
            .into_iter()
            .find(|t| t.id == "track_1")
            .expect("track");
        assert_eq!(track.name, "New Name");
    }

    /// Legacy broad sync is deleted. Realtime slider drags must never trigger a session rebuild.
    #[test]
    fn realtime_slider_drags_never_trigger_session_rebuild() {
        let audio = crate::audio_engine::AudioController::default();

        // 100 realtime commands (slider drags) must NOT increment session_rebuild_count.
        for i in 0..100 {
            audio
                .update_live_track_mix("track_1", Some(i as f64 / 100.0), None, None, None, None)
                .expect("realtime update should succeed");
        }

        let diag = audio.realtime_control_diagnostics();
        assert_eq!(diag.live_mix_realtime_command_count, 100);
        assert_eq!(
            diag.session_rebuild_count, 0,
            "realtime slider drags must never trigger a session rebuild"
        );
    }

    /// session_rebuild_count must increment only for structural changes, not for mixer changes.
    #[test]
    fn session_rebuild_count_does_not_increment_for_mixer_changes() {
        let audio = crate::audio_engine::AudioController::default();

        // Category A — no rebuild.
        audio
            .update_live_track_mix("track_1", Some(0.5), None, None, None, None)
            .expect("realtime update should succeed");
        audio
            .set_metronome_enabled_realtime(true)
            .expect("metronome toggle should succeed");
        audio
            .set_metronome_volume_realtime(0.7)
            .expect("metronome volume should succeed");
        audio
            .set_track_transpose_enabled_realtime("track_1", false)
            .expect("transpose enabled should succeed");

        assert_eq!(
            audio.realtime_control_diagnostics().session_rebuild_count,
            0,
            "Category A commands must never trigger a session rebuild"
        );
    }

    /// Metronome toggle must use realtime commands, not session rebuild.
    #[test]
    fn metronome_toggle_uses_realtime_command_not_session_rebuild() {
        let audio = crate::audio_engine::AudioController::default();

        for i in 0..10 {
            audio
                .set_metronome_enabled_realtime(i % 2 == 0)
                .expect("metronome toggle should succeed");
        }
        audio
            .set_metronome_volume_realtime(0.5)
            .expect("metronome volume should succeed");

        let diag = audio.realtime_control_diagnostics();
        assert_eq!(diag.metronome_realtime_toggle_count, 10);
        assert_eq!(diag.metronome_realtime_volume_count, 1);
        assert_eq!(
            diag.session_rebuild_count, 0,
            "metronome commands must never rebuild the session"
        );
    }

    /// Folder track volume change must use realtime command, not session rebuild.
    #[test]
    fn folder_track_volume_uses_realtime_command_not_session_rebuild() {
        let mut session = session_with_song_dir("folder-track-demo", demo_song_with_folder_track());
        let audio = crate::audio_engine::AudioController::default();

        // Folder track volume change — Category A bridge.
        audio
            .update_live_track_mix("folder_1", Some(0.6), None, None, None, None)
            .expect("folder track realtime update should succeed");

        let diag = audio.realtime_control_diagnostics();
        assert_eq!(
            diag.session_rebuild_count, 0,
            "folder track Category A command must not rebuild session"
        );
        assert_eq!(diag.live_mix_realtime_command_count, 1);

        // Commit the folder track volume change — Category B (commit), still no rebuild.
        session
            .commit_track_mix_model_and_command(
                "folder_1",
                Some(0.6),
                None,
                None,
                None,
                None,
                &audio,
            )
            .expect("folder track commit should succeed");

        let diag = audio.realtime_control_diagnostics();
        assert_eq!(
            diag.session_rebuild_count, 0,
            "folder track commit must not rebuild session"
        );
    }

    // ── Phase 10: new commit classification tests ─────────────────────────────

    /// commit_track_mix_model_and_command must increment commit_mix_command_count.
    #[test]
    fn commit_mix_increments_commit_mix_command_count() {
        let mut session = session_with_song_dir("commit-mix-count-demo", demo_song());
        let audio = crate::audio_engine::AudioController::default();

        assert_eq!(
            audio
                .realtime_control_diagnostics()
                .commit_mix_command_count,
            0
        );

        session
            .commit_track_mix_model_and_command(
                "track_1",
                Some(0.8),
                None,
                None,
                None,
                None,
                &audio,
            )
            .expect("commit should succeed");

        assert_eq!(
            audio
                .realtime_control_diagnostics()
                .commit_mix_command_count,
            1,
            "commit_mix must increment commit_mix_command_count"
        );
        assert_eq!(
            audio.realtime_control_diagnostics().commit_model_only_count,
            0,
            "commit_mix must not increment commit_model_only_count"
        );
    }

    /// update_track_metadata must increment commit_model_only_count and send no audio command.
    #[test]
    fn metadata_commit_increments_commit_model_only_count() {
        let mut session = session_with_song_dir("metadata-count-demo", demo_song());
        let audio = crate::audio_engine::AudioController::default();

        assert_eq!(
            audio.realtime_control_diagnostics().commit_model_only_count,
            0
        );

        session
            .update_track_metadata("track_1", "Renamed", &audio)
            .expect("metadata update should succeed");

        let diag = audio.realtime_control_diagnostics();
        assert_eq!(
            diag.commit_model_only_count, 1,
            "update_track_metadata must increment commit_model_only_count"
        );
        assert_eq!(
            diag.commit_mix_command_count, 0,
            "update_track_metadata must not increment commit_mix_command_count"
        );
        assert_eq!(
            diag.live_mix_realtime_command_count, 0,
            "update_track_metadata must not send any realtime audio command"
        );
    }

    /// Mute commit uses Category B (targeted command), never a full session reload.
    #[test]
    fn commit_mute_sends_targeted_command_not_session_reload() {
        let mut session = session_with_song_dir("commit-mute-demo", demo_song());
        let audio = crate::audio_engine::AudioController::default();

        session
            .commit_track_mix_model_and_command(
                "track_1",
                None,
                None,
                Some(true),
                None,
                None,
                &audio,
            )
            .expect("mute commit should succeed");

        let diag = audio.realtime_control_diagnostics();
        assert_eq!(
            diag.session_rebuild_count, 0,
            "mute commit must not rebuild session"
        );
        assert_eq!(
            diag.live_mix_realtime_command_count, 1,
            "mute commit must send exactly one command"
        );
        assert_eq!(diag.commit_mix_command_count, 1);
    }

    /// Solo commit uses Category B (targeted command), never a full session reload.
    #[test]
    fn commit_solo_sends_targeted_command_not_session_reload() {
        let mut session = session_with_song_dir("commit-solo-demo", demo_song());
        let audio = crate::audio_engine::AudioController::default();

        session
            .commit_track_mix_model_and_command(
                "track_1",
                None,
                None,
                None,
                Some(true),
                None,
                &audio,
            )
            .expect("solo commit should succeed");

        let diag = audio.realtime_control_diagnostics();
        assert_eq!(
            diag.session_rebuild_count, 0,
            "solo commit must not rebuild session"
        );
        assert_eq!(
            diag.live_mix_realtime_command_count, 1,
            "solo commit must send exactly one command"
        );
        assert_eq!(diag.commit_mix_command_count, 1);
    }

    /// Pan commit uses Category B (targeted command), never a full session reload.
    #[test]
    fn commit_pan_sends_targeted_command_not_session_reload() {
        let mut session = session_with_song_dir("commit-pan-demo", demo_song());
        let audio = crate::audio_engine::AudioController::default();

        session
            .commit_track_mix_model_and_command(
                "track_1",
                None,
                Some(-0.5),
                None,
                None,
                None,
                &audio,
            )
            .expect("pan commit should succeed");

        let diag = audio.realtime_control_diagnostics();
        assert_eq!(
            diag.session_rebuild_count, 0,
            "pan commit must not rebuild session"
        );
        assert_eq!(
            diag.live_mix_realtime_command_count, 1,
            "pan commit must send exactly one command"
        );
        assert_eq!(diag.commit_mix_command_count, 1);
    }

    /// Multiple mix commits accumulate commit_mix_command_count correctly.
    #[test]
    fn commit_mix_command_count_accumulates_across_multiple_commits() {
        let mut session = session_with_song_dir("commit-count-accum-demo", demo_song());
        let audio = crate::audio_engine::AudioController::default();

        for i in 1..=5 {
            session
                .commit_track_mix_model_and_command(
                    "track_1",
                    Some(i as f64 / 10.0),
                    None,
                    None,
                    None,
                    None,
                    &audio,
                )
                .expect("commit should succeed");
        }

        assert_eq!(
            audio
                .realtime_control_diagnostics()
                .commit_mix_command_count,
            5
        );
        assert_eq!(
            audio.realtime_control_diagnostics().session_rebuild_count,
            0
        );
    }

    /// commit_model_only_count and commit_mix_command_count are independent counters.
    #[test]
    fn mix_and_metadata_commit_counts_are_independent() {
        let mut session = session_with_song_dir("commit-independent-demo", demo_song());
        let audio = crate::audio_engine::AudioController::default();

        session
            .update_track_metadata("track_1", "Renamed", &audio)
            .expect("name update should succeed");
        session
            .commit_track_mix_model_and_command(
                "track_1",
                Some(0.5),
                None,
                None,
                None,
                None,
                &audio,
            )
            .expect("mix commit should succeed");
        session
            .update_track_metadata("track_1", "Renamed Again", &audio)
            .expect("name update should succeed");

        let diag = audio.realtime_control_diagnostics();
        assert_eq!(diag.commit_model_only_count, 2, "two name updates");
        assert_eq!(diag.commit_mix_command_count, 1, "one mix commit");
        assert_eq!(diag.session_rebuild_count, 0);
    }

    #[test]
    fn place_bundled_audio_reuses_existing_original_and_copies_missing_one() {
        let dir = tempdir().expect("tempdir");
        let song_dir = dir.path();

        // An original source that still exists on disk: the clip must keep
        // pointing at it and NO copy should be written into audio/.
        let original = song_dir.join("present.wav");
        fs::write(&original, b"present-bytes").expect("write original");
        let original_path = original.to_string_lossy().to_string();

        let mut song = build_empty_song("song_pkg".into(), "Pkg".into());
        song.clips.push(Clip {
            id: "clip_present".into(),
            track_id: "t".into(),
            file_path: original_path.clone(),
            timeline_start_seconds: 0.0,
            source_start_seconds: 0.0,
            duration_seconds: 1.0,
            gain: 1.0,
            fade_in_seconds: None,
            fade_out_seconds: None,
            color: None,
        });
        // A clip whose original is GONE: it must be copied into audio/ and
        // re-pointed there.
        song.clips.push(Clip {
            id: "clip_missing".into(),
            track_id: "t".into(),
            file_path: song_dir.join("gone.wav").to_string_lossy().to_string(),
            timeline_start_seconds: 0.0,
            source_start_seconds: 0.0,
            duration_seconds: 1.0,
            gain: 1.0,
            fade_in_seconds: None,
            fade_out_seconds: None,
            color: None,
        });

        let mut bundled = std::collections::HashMap::new();
        bundled.insert("present.wav".to_string(), b"present-bytes".to_vec());
        bundled.insert("gone.wav".to_string(), b"gone-bytes".to_vec());

        place_bundled_audio_and_repoint(song_dir, &mut song, &bundled).expect("place");

        // Present original: clip untouched, no copy created.
        assert_eq!(song.clips[0].file_path, original_path);
        assert!(
            !song_dir.join("audio").join("present.wav").exists(),
            "existing original must not be copied into audio/"
        );

        // Missing original: copied and re-pointed under audio/.
        assert_eq!(song.clips[1].file_path, "audio/gone.wav");
        assert_eq!(
            fs::read(song_dir.join("audio").join("gone.wav")).expect("copied"),
            b"gone-bytes"
        );
    }
}
