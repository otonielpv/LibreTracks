use std::{
    collections::{HashMap, HashSet},
    fs,
    path::Path,
    path::PathBuf,
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use libretracks_audio::{AudioEngine, JumpTrigger, PlaybackState, TransitionType, VampMode};
use libretracks_core::{
    region_warp_ratio_in_song, source_seconds_at_view, warp_timeline_seconds_at, Marker, MarkerKind,
    Song, TempoMarker, TimeSignatureMarker,
};
use libretracks_project::{
    append_wav_files_to_song, global_waveform_file_path,
    import_song_package as import_song_package_into_project, load_global_waveform,
    load_or_generate_global_waveform, merge_extracted_song_package, read_audio_metadata,
    waveform_summary_from_channel_peaks, write_global_waveform, ExtractedSongPackage,
    ImportOperationMetrics, PackageLibraryAssetEntry, ProjectError, WaveformSummary, SONG_FILE_NAME,
};
use rayon::prelude::*;

use serde::{Deserialize, Serialize};
use serde_json::to_vec;
use tauri::{AppHandle, Emitter, Manager};

use crate::audio_engine::{
    jump_debug_logging_enabled, AudioController, PlaybackStartReason,
    ENGINE_WAVEFORM_RESOLUTION_FRAMES,
};
use crate::automation::{
    AutomationAction, AutomationCue, AutomationDocument, AutomationJumpTarget,
    AutomationTransitionMode,
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
    SongPackageImportResponse, SongView, SourceReadinessSummary, TransportClockSummary,
    TransportDriftSummary, TransportSnapshot, WaveformSummaryDto,
};
use crate::settings::AppSettings;

/// Theme-split `impl DesktopSession` blocks. Each submodule owns one coherent
/// slice of the session's behavior and reaches the `pub(super)` fields defined
/// here. See docs/REDESIGN_state_rs_module_split.md.
mod arrangement;
mod audio_prep;
mod automation_runtime;
mod external_import;
mod history;
mod library;
mod regions;
mod session;
mod song_edit;
mod timeline_math;
mod track_tree;

use song_edit::*;
use timeline_math::*;
use track_tree::*;

pub(super) const LIBRARY_MANIFEST_FILE_NAME: &str = "library.json";
const LIBRARY_IMPORT_PROGRESS_EVENT: &str = "library:import-progress";
const PROJECT_LOAD_PROGRESS_EVENT: &str = "project:load-progress";
const SESSION_EXPORT_PROGRESS_EVENT: &str = "session:export-progress";
pub const WAVEFORM_READY_EVENT: &str = "waveform:ready";
const TRANSPORT_RUNTIME_SYNC_INTERVAL: Duration = Duration::from_millis(250);
const TRANSPORT_PITCH_SYNC_INTERVAL: Duration = Duration::from_millis(800);
/// Track volume faders are an Ableton-style dB scale reaching +10 dB, i.e. a
/// linear gain of 10^(10/20) ≈ 3.1623. Track gain must clamp to this headroom,
/// not to unity — clamping to 1.0 here snaps every above-0-dB fader back down.
/// Keep in sync with `TRACK_FADER_SCALE` in packages/shared/src/faderScale.ts.
pub(super) const MAX_TRACK_GAIN: f64 = 3.162_277_66;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LibraryImportProgressEvent {
    percent: u8,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionExportProgressEvent {
    percent: u8,
    message: String,
    /// True on the terminal event (success or failure) so the UI can dismiss the
    /// overlay; `error` is set when the export failed.
    done: bool,
    error: Option<String>,
}

/// Emit whole-session export progress to the frontend overlay. `percent` is
/// clamped; the terminal event carries `done = true` (and `error` on failure).
pub(crate) fn emit_session_export_progress(
    app: &AppHandle,
    percent: u8,
    message: String,
    done: bool,
    error: Option<String>,
) {
    let payload = SessionExportProgressEvent {
        percent: percent.min(100),
        message,
        done,
        error,
    };
    if let Err(emit_error) = app.emit(SESSION_EXPORT_PROGRESS_EVENT, payload) {
        eprintln!("[libretracks-project] failed to emit export progress: {emit_error}");
    }
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

#[derive(Clone)]
pub struct WaveformJob {
    pub app: tauri::AppHandle,
    pub song_dir: PathBuf,
    pub waveform_key: String,
}

#[derive(Clone)]
pub struct WaveformGenerationQueue {
    sender: mpsc::Sender<WaveformJob>,
    in_flight: Arc<Mutex<HashSet<String>>>,
    // The engine, so the worker can reuse the peaks the streaming decode ALREADY
    // computed (source_peaks) instead of re-decoding the whole file. None in
    // tests / before the controller exists.
    audio: Arc<Mutex<Option<Arc<AudioController>>>>,
}

pub struct DesktopState {
    pub audio: Arc<AudioController>,
    pub midi: MidiManager,
    pub waveform_jobs: WaveformGenerationQueue,
    pub session: Mutex<DesktopSession>,
    pub project_load_progress: Mutex<Option<ProjectLoadProgressEvent>>,
    /// OS resource sampler backing the top-bar CPU/RAM/disk meter. Independent
    /// of the session lock so sampling can never be blocked by heavy session
    /// work.
    pub resource_monitor: crate::resource_monitor::ResourceMonitor,
}

impl Default for DesktopState {
    fn default() -> Self {
        let audio = Arc::new(AudioController::default());
        let waveform_jobs = WaveformGenerationQueue::default();
        // Let the waveform worker reuse the engine's same-pass peaks instead of
        // re-decoding each file.
        waveform_jobs.set_audio(Arc::clone(&audio));
        Self {
            audio,
            midi: MidiManager::default(),
            waveform_jobs,
            session: Mutex::new(DesktopSession::default()),
            project_load_progress: Mutex::new(None),
            resource_monitor: crate::resource_monitor::ResourceMonitor::default(),
        }
    }
}

pub struct DesktopSession {
    pub engine: AudioEngine,
    // Fields are `pub(super)` so the theme-split `impl DesktopSession` blocks in
    // sibling modules (state/automation_runtime.rs, …) can reach them. The
    // visibility stops at the `state` module boundary — nothing leaks outside.
    pub(super) transport_clock: TransportClock,
    pub song_dir: Option<PathBuf>,
    pub(super) song_file_path: Option<PathBuf>,
    pub(super) last_drift_sample: Option<TransportDriftSummary>,
    pub(super) last_runtime_pitch: Option<PitchPrepareSummary>,
    pub(super) last_source_readiness: Option<SourceReadinessSummary>,
    pub(super) last_transport_runtime_sync_at: Option<Instant>,
    pub(super) last_transport_pitch_sync_at: Option<Instant>,
    pub(super) last_native_scheduled_jump_executed_count: u64,
    pub(super) automation: AutomationDocument,
    pub(super) pending_automation_jump: Option<PendingAutomationJump>,
    /// In-flight jobs without a terminal jump (pure mix/scene/wait sequences).
    pub(super) active_automation_job: Option<ActiveAutomationJob>,
    /// Per-cue fire count for this playback session (cue id → times fired).
    /// Session state only (never persisted); reset on stop and on seeking before
    /// a cue. Enforces `AutomationCue.max_runs` so loops can be bounded.
    pub(super) automation_run_counts: HashMap<String, u32>,
    /// In-progress volume/pan ramps from SetTrackMix actions with ramp_seconds.
    pub(super) active_mix_ramps: Vec<ActiveMixRamp>,
    pub(super) project_revision: u64,
    pub(super) undo_stack: Vec<Song>,
    pub(super) redo_stack: Vec<Song>,
    pub(super) live_history_anchor: Option<Song>,
    pub(super) transpose_history_group: Option<TransposeHistoryGroup>,
    pub(super) waveform_cache: WaveformMemoryCache,
    pub(super) perf_metrics: DesktopPerformanceMetrics,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum TransposeHistoryTarget {
    Region(String),
    Track(String),
}

#[derive(Debug, Clone)]
pub(super) struct TransposeHistoryGroup {
    target: TransposeHistoryTarget,
    recorded_at: Instant,
}

#[derive(Debug, Clone)]
pub(super) struct PendingAutomationJump {
    pub(super) cue_id: String,
    pub(super) cue_name: String,
    /// View-space time the jump itself fires: cue.at_seconds + Σ pre-jump waits.
    pub(super) execute_at_seconds: f64,
    pub(super) target: AutomationJumpTarget,
    pub(super) mix_scene_id: Option<String>,
    pub(super) fade_out_seconds: Option<f64>,
    pub(super) fade_started: bool,
    /// Non-jump actions of the job, paired with their view-space fire time
    /// (cue.at_seconds + offset). Sorted by time; fired as the playhead crosses
    /// them. `fired_count` is how many have already run this pass.
    pub(super) timed_actions: Vec<(f64, AutomationAction)>,
    pub(super) fired_count: usize,
}

/// An in-flight job that has NO terminal jump (pure mix/scene/wait sequence).
/// Jobs with a jump are tracked via `pending_automation_jump` instead, since the
/// native jump scheduling already drives them.
#[derive(Debug, Clone)]
pub(super) struct ActiveAutomationJob {
    pub(super) cue_id: String,
    pub(super) timed_actions: Vec<(f64, AutomationAction)>,
    pub(super) fired_count: usize,
}

/// A volume/pan ramp in progress for a SetTrackMix action with `ramp_seconds`.
/// The runtime interpolates from the start value to the target across the ramp
/// window (stepped per transport tick), since the native engine only has
/// instantaneous SetTrackGain/SetTrackPan. Session state; cleared on stop/seek.
#[derive(Debug, Clone)]
pub(super) struct ActiveMixRamp {
    pub(super) track_id: String,
    pub(super) start_position_seconds: f64,
    pub(super) duration_seconds: f64,
    pub(super) volume: Option<(f64, f64)>, // (from, to)
    pub(super) pan: Option<(f64, f64)>,    // (from, to)
}

#[derive(Debug, Default)]
pub(super) struct TransportClock {
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
            last_source_readiness: None,
            last_transport_runtime_sync_at: None,
            last_transport_pitch_sync_at: None,
            last_native_scheduled_jump_executed_count: 0,
            automation: AutomationDocument::default(),
            pending_automation_jump: None,
            active_automation_job: None,
            automation_run_counts: HashMap::new(),
            active_mix_ramps: Vec::new(),
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

    /// Number of jobs currently enqueued / in flight. Test-only: lets tests
    /// assert that a cache miss enqueued background work instead of decoding.
    #[cfg(test)]
    pub(crate) fn pending_count(&self) -> usize {
        self.in_flight.lock().map(|set| set.len()).unwrap_or(0)
    }
}

impl Default for WaveformGenerationQueue {
    fn default() -> Self {
        let (sender, receiver) = mpsc::channel::<WaveformJob>();
        let in_flight = Arc::new(Mutex::new(HashSet::new()));
        let worker_in_flight = Arc::clone(&in_flight);
        let audio: Arc<Mutex<Option<Arc<AudioController>>>> = Arc::new(Mutex::new(None));
        let worker_audio = Arc::clone(&audio);

        thread::spawn(move || {
            while let Ok(job) = receiver.recv() {
                let job_key = waveform_job_key(&job.song_dir, &job.waveform_key);
                let audio = worker_audio.lock().ok().and_then(|g| g.clone());
                process_waveform_job(job, audio.as_deref());
                if let Ok(mut in_flight) = worker_in_flight.lock() {
                    in_flight.remove(&job_key);
                }
            }
        });

        Self {
            sender,
            in_flight,
            audio,
        }
    }
}

impl WaveformGenerationQueue {
    /// Give the worker the engine handle so it can reuse same-pass peaks
    /// (source_peaks) instead of re-decoding. Called once after DesktopState
    /// builds the shared AudioController.
    pub fn set_audio(&self, audio: Arc<AudioController>) {
        if let Ok(mut slot) = self.audio.lock() {
            *slot = Some(audio);
        }
    }
}

#[cfg(test)]
impl WaveformGenerationQueue {
    /// Build a queue WITHOUT a draining worker, so enqueued jobs stay in
    /// `in_flight` for tests to inspect (otherwise the real worker removes the
    /// key as soon as it runs, racing the assertion). The receiver is leaked to
    /// keep the channel open.
    pub(crate) fn new_for_test() -> Self {
        let (sender, receiver) = mpsc::channel::<WaveformJob>();
        std::mem::forget(receiver);
        Self {
            sender,
            in_flight: Arc::new(Mutex::new(HashSet::new())),
            audio: Arc::new(Mutex::new(None)),
        }
    }
}

fn waveform_job_key(song_dir: &Path, waveform_key: &str) -> String {
    format!("{}\n{waveform_key}", song_dir.to_string_lossy())
}

pub(super) fn unique_waveform_keys(song: &Song) -> Vec<String> {
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

/// Generate a waveform with the native decoder stack (FFmpeg/libav for
/// compressed formats, native fast paths where available) and write it to the
/// global on-disk cache. This is independent of playback session state, so it
/// is safe to call from the background waveform worker.
fn generate_native_waveform(
    song_dir: &Path,
    waveform_key: &str,
) -> Result<WaveformSummary, DesktopError> {
    let source_path = resolve_audio_file_path(song_dir, waveform_key);
    let source_path_string = source_path.to_string_lossy().to_string();
    let peaks =
        lt_audio_engine_v2::file_peaks(&source_path_string, ENGINE_WAVEFORM_RESOLUTION_FRAMES)
            .map_err(|error| DesktopError::AudioCommand(error.to_string()))?;
    let duration_frames = u64::try_from(peaks.duration_frames.max(0)).unwrap_or(0);
    let summary = waveform_summary_from_channel_peaks(
        peaks.sample_rate,
        duration_frames,
        peaks.resolution_frames,
        peaks.min_peaks,
        peaks.max_peaks,
        peaks.min_peaks_right,
        peaks.max_peaks_right,
        &source_path,
    )?;
    write_global_waveform(&decoding_cache_root(), &source_path, &summary)?;
    Ok(summary)
}

/// Build the global waveform cache for a song's sources from the peaks the
/// streaming decode ALREADY computed (AudioController::source_peaks), instead of
/// re-decoding each file. Run after sources are ready, on the command thread
/// (which owns the engine). Best-effort per file: a miss just leaves the normal
/// background waveform job to generate it. This is what removes the second
/// full decode that was contending with playback during import.
fn prime_waveforms_from_engine_peaks(song_dir: &Path, song: &Song, audio: &AudioController) {
    let cache_root = decoding_cache_root();
    for key in unique_waveform_keys(song) {
        // The source id the engine knows is the resolved audio file path.
        let source_path = resolve_audio_file_path(song_dir, &key);
        let source_id = source_path.to_string_lossy().to_string();
        // Skip if a cache already exists (cheap check).
        if load_global_waveform(&cache_root, song_dir, Path::new(&key)).is_ok() {
            continue;
        }
        let Some(peaks) = audio.source_peaks(&source_id, ENGINE_WAVEFORM_RESOLUTION_FRAMES) else {
            continue; // not loaded yet / no same-pass peaks → retry will hit
        };
        let duration_frames = u64::try_from(peaks.duration_frames.max(0)).unwrap_or(0);
        if duration_frames == 0 {
            continue;
        }
        let Ok(summary) = waveform_summary_from_channel_peaks(
            peaks.sample_rate,
            duration_frames,
            peaks.resolution_frames,
            peaks.min_peaks,
            peaks.max_peaks,
            peaks.min_peaks_right,
            peaks.max_peaks_right,
            &source_path,
        ) else {
            continue;
        };
        let _ = write_global_waveform(&cache_root, &source_path, &summary);
    }
}

/// Build a waveform summary for one source from the engine's same-pass peaks
/// (no re-decode). Returns None if the engine doesn't have the source yet or
/// has no peaks — the caller then falls back to the full decode. Also writes
/// the global cache so subsequent requests hit it.
fn waveform_from_engine_peaks(
    song_dir: &Path,
    waveform_key: &str,
    audio: Option<&AudioController>,
) -> Option<WaveformSummary> {
    let audio = audio?;
    let source_path = resolve_audio_file_path(song_dir, waveform_key);
    let source_id = source_path.to_string_lossy().to_string();
    let peaks = audio.source_peaks(&source_id, ENGINE_WAVEFORM_RESOLUTION_FRAMES)?;
    let duration_frames = u64::try_from(peaks.duration_frames.max(0)).unwrap_or(0);
    if duration_frames == 0 {
        return None;
    }
    // R5: a source still streaming reports its duration but no peaks yet (the
    // same-pass peaks are published atomically at decode end). Treat empty peaks
    // as not-ready so we don't cache a blank/half waveform — the caller polls.
    if peaks.max_peaks.is_empty() {
        return None;
    }
    let summary = waveform_summary_from_channel_peaks(
        peaks.sample_rate,
        duration_frames,
        peaks.resolution_frames,
        peaks.min_peaks,
        peaks.max_peaks,
        peaks.min_peaks_right,
        peaks.max_peaks_right,
        &source_path,
    )
    .ok()?;
    let _ = write_global_waveform(&decoding_cache_root(), &source_path, &summary);
    Some(summary)
}

fn process_waveform_job(job: WaveformJob, audio: Option<&AudioController>) {
    let WaveformJob {
        app,
        song_dir,
        waveform_key,
    } = job;

    // 1) Disk cache. 2) Same-pass peaks from the engine (NO re-decode — the
    // streaming decode already computed them). 3) Full re-decode (file_peaks),
    // the expensive fallback only for sources the engine doesn't have (e.g. a
    // library file not in the session). 4) Symphonia, last resort.
    let cache_root = decoding_cache_root();
    // If the engine has this source (decoding or done) we must NOT re-decode for
    // the waveform — its streaming pass produces the peaks. If they're not ready
    // yet, bail (the frontend re-requests; in_flight is cleared when this job
    // returns, so a later poll retries and eventually hits the engine peaks).
    let engine_has_source = audio
        .map(|a| {
            let id = resolve_audio_file_path(&song_dir, &waveform_key)
                .to_string_lossy()
                .to_string();
            a.source_is_known(&id)
        })
        .unwrap_or(false);

    // When the engine is decoding this source, POLL for its same-pass peaks
    // here (this is a background thread) instead of bailing — otherwise the
    // frontend's one-shot "analyzing" request never gets a waveform and spins
    // forever. The streaming decode finishes within seconds; cap the wait so a
    // stuck/failed source eventually falls through to the file_peaks path.
    let engine_peaks = if engine_has_source {
        let mut got = waveform_from_engine_peaks(&song_dir, &waveform_key, audio);
        let mut waited_ms = 0u64;
        const POLL_MS: u64 = 100;
        const MAX_WAIT_MS: u64 = 120_000;
        while got.is_none() && waited_ms < MAX_WAIT_MS {
            // Stop early if the source vanished (session changed / removed).
            let still_known = audio
                .map(|a| {
                    let id = resolve_audio_file_path(&song_dir, &waveform_key)
                        .to_string_lossy()
                        .to_string();
                    a.source_is_known(&id)
                })
                .unwrap_or(false);
            if !still_known {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(POLL_MS));
            waited_ms += POLL_MS;
            got = waveform_from_engine_peaks(&song_dir, &waveform_key, audio);
        }
        got
    } else {
        waveform_from_engine_peaks(&song_dir, &waveform_key, audio)
    };

    let summary = match load_global_waveform(&cache_root, &song_dir, Path::new(&waveform_key)) {
        Ok(summary) => Some(summary),
        Err(_) if engine_peaks.is_some() => engine_peaks,
        Err(cache_error) => match generate_native_waveform(&song_dir, &waveform_key) {
            Ok(summary) => Some(summary),
            Err(native_error) => {
                match load_or_generate_global_waveform(
                    &cache_root,
                    &song_dir,
                    Path::new(&waveform_key),
                ) {
                    Ok(summary) => Some(summary),
                    Err(symphonia_error) => {
                        eprintln!(
                            "[libretracks-waveform] failed to generate waveform for {}: \
                             cache={cache_error} native={native_error} symphonia={symphonia_error}",
                            waveform_key
                        );
                        None
                    }
                }
            }
        },
    };

    if let Some(summary) = summary {
        let dto = waveform_summary_to_dto(&waveform_key, &summary);
        emit_waveform_ready(&app, &song_dir, &waveform_key, dto);
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

/// Drop request when dragging library assets onto the timeline: each asset
/// becomes a persistent audio track (`auto_created = false`) with the given
/// `track_name`, plus a clip pointing at it. Unlike the per-asset
/// create_track + create_clip loop this once was, the whole batch is one
/// `persist_song_update` / `LoadSession` — so dropping N assets onto a song
/// that already holds M clips costs one rebuild, not N rebuilds of a song that
/// grows M..M+N (which made the *second* batch drop visibly progressive).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAudioTrackWithClipRequest {
    pub track_name: String,
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
pub(super) struct DesktopPerformanceMetrics {
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
    /// Import a set of already-picked audio files into the library, emitting
    /// progress events as it goes. The native file dialog is opened by the
    /// caller on the main thread; this runs on a worker thread so the heavy
    /// decode/persist work does not block the macOS run loop and freeze the
    /// window (see `start_import_library_assets_from_dialog`).
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
        // Before serving, prime the global cache from the engine's same-pass
        // peaks (no re-decode) so the cache lookup below hits and we never
        // enqueue the heavy file_peaks re-decode that contended with playback.
        if let Some(song) = self.engine.song().cloned() {
            if let Some(song_dir) = self.song_dir.clone() {
                prime_waveforms_from_engine_peaks(&song_dir, &song, audio);
            }
        }
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

            // Read-only cache lookup ONLY. On a cache miss we NEVER decode here
            // (that held the session lock for seconds and froze the UI).
            match self.load_waveform_summary_cached(&song_dir, waveform_key, false) {
                Ok(summary) => summaries.push(waveform_summary_to_dto(waveform_key, summary)),
                Err(DesktopError::Project(ProjectError::Io(_)))
                | Err(DesktopError::Project(ProjectError::InvalidWaveformSummary(_))) => {
                    // If the engine is/will be decoding this source, its
                    // streaming pass produces the peaks (same single decode) —
                    // do NOT enqueue a redundant full re-decode. The frontend
                    // re-requests; once the source finishes, prime_waveforms_
                    // from_engine_peaks (top of load_waveforms) writes the cache
                    // and the retry HITs. Only enqueue the heavy file_peaks path
                    // when the engine won't produce peaks (source not loaded,
                    // e.g. a library file not in the session).
                    let source_id = resolve_audio_file_path(&song_dir, waveform_key)
                        .to_string_lossy()
                        .to_string();
                    let engine_will_decode = audio
                        .map(|a| a.source_is_known(&source_id))
                        .unwrap_or(false);
                    if !engine_will_decode {
                        if let Some((waveform_jobs, app)) = background_generation {
                            waveform_jobs.enqueue(
                                app.clone(),
                                song_dir.clone(),
                                waveform_key.clone(),
                            )?;
                        }
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

            // Read-only cache lookup ONLY. Cache miss => enqueue to the
            // background worker (never decode under the session lock — that was
            // the post-import freeze). The frontend paints late waveforms via
            // WAVEFORM_READY_EVENT.
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
            || previous_settings.audio_safe_mode != next_settings.audio_safe_mode
            || previous_settings.low_latency_output != next_settings.low_latency_output;
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
        self.active_mix_ramps.clear();
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
        // A seek cancels any in-progress ramps (their timeline anchor is stale).
        self.active_mix_ramps.clear();
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
        if let Err(error) = audio.prepare_playback_at(loaded_song, runtime_position_seconds) {
            eprintln!(
                "[libretracks-import] prepare_playback_at failed after package import: {error}"
            );
        }
        Ok(SongPackageImportResponse {
            snapshot: self.snapshot(),
            library_assets,
        })
    }

    // Same as `import_song_package` but skips the blocking source-ready wait
    // and waveform/playback prep — the caller (the dialog flow) drives those
    // through `wait_for_project_audio_preparation` so the loading bar can show
    // per-source progress instead of freezing on a generic "syncing" overlay.
    pub(super) fn import_song_package_no_wait(
        &mut self,
        app: &AppHandle,
        extracted: ExtractedSongPackage,
        insert_at_seconds: f64,
        audio: &AudioController,
    ) -> Result<SongPackageImportResponse, DesktopError> {
        let song_dir = self.song_dir.clone().ok_or(DesktopError::NoSongLoaded)?;
        let song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        // The package is already decompressed (see `extract_song_package`, run
        // off the lock by the caller, which owns the 7..40% progress band);
        // merging it into the song is fast, so this phase owns 42..50%.
        let mut imported = merge_extracted_song_package(&song, extracted, insert_at_seconds)?;
        emit_project_load_progress(app, 42, "Copiando audio del paquete...".into(), 0, 0, 0, 0);
        place_bundled_audio_and_repoint(&song_dir, &mut imported.song, &imported.bundled_audio)?;
        emit_project_load_progress(
            app,
            45,
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
            47,
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
        emit_project_load_progress(app, 50, "Preparando formas de onda...".into(), 0, 0, 0, 0);
        self.prime_waveform_cache(&song_dir, &loaded_song)?;
        Ok(SongPackageImportResponse {
            snapshot: self.snapshot(),
            library_assets,
        })
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
            self.last_source_readiness = Some(audio.source_readiness_summary());
            self.last_transport_pitch_sync_at = Some(now);
        }

        if playback_is_running {
            return Ok(self.snapshot_with_runtime_transport(audio));
        }

        Ok(self.snapshot())
    }

    pub(super) fn persist_song_update(
        &mut self,
        song: Song,
        audio: &AudioController,
        impact: AudioChangeImpact,
        bump_revision: bool,
    ) -> Result<(), DesktopError> {
        self.persist_song_update_internal(song, audio, impact, true, bump_revision)
    }

    pub(super) fn persist_song_update_internal(
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
        // Validates a song dir is set (NoSongLoaded otherwise). No longer used
        // directly here since structural edits go through the incremental upsert
        // instead of replace_song_buffers(&song_dir, ...).
        let _song_dir = self.song_dir.clone().ok_or(DesktopError::NoSongLoaded)?;

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
                        // record_history=false marks an IN-PROGRESS drag (the
                        // _live_ variants); the commit records history. Pass that
                        // through as `live` so the engine defers the warp
                        // hard-retime to the drop (avoids the per-tick "trrrr").
                        audio.update_live_timeline_window(&song, !record_history)?;
                    } else {
                        // Structural edits (add/remove/move tracks & clips,
                        // import audio) go through the INCREMENTAL upsert command
                        // instead of a full LoadSession: the engine mutates the
                        // live session in place and decodes only new sources,
                        // preserving already-playing tracks. A full
                        // replace_song_buffers here clears + re-decodes every
                        // source and reassigns the session in cold pages, which
                        // stalled the audio callback for 100-400ms (see
                        // docs/HANDOFF_import_while_playing_glitches.md).
                        audio.upsert_song_tracks(&song)?;
                    }
                } else if impact == AudioChangeImpact::StructureRebuild
                    && audio.has_loaded_session()
                {
                    // Not playing but a session is already loaded: use the
                    // INCREMENTAL upsert here too. The previous code did a full
                    // LoadSession (sync_song -> ensure_song_loaded) on every
                    // structural edit, which clears() + re-decodes EVERY source —
                    // slow even when stopped, and the reason the FIRST import felt
                    // heavy. The upsert decodes only the new sources in the
                    // background. (Playback is stopped so there's no callback to
                    // stall, but the destructive re-decode is still wasteful.)
                    // Importantly: the import drag-drop runs with the transport
                    // Stopped, so THIS is the branch imports actually take.
                    audio.upsert_song_tracks(&song)?;
                } else {
                    // No session loaded yet (cold project) — do the initial full
                    // load so the engine has something to upsert into next time.
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
                    AudioChangeImpact::MixerOnly | AudioChangeImpact::TransportOnly => {
                        self.transport_clock
                            .reanchor_playing(self.engine.position_seconds());
                    }
                    // TimelineWindow / StructureRebuild already pushed the edit
                    // to the LIVE C++ session (update_live_timeline_window /
                    // upsert_song_tracks above) without disturbing its clock —
                    // the audio thread keeps playing seamlessly. We must NOT
                    // reposition_audio here: that sends a SeekAbsolute to the
                    // engine at `restored_position`, the playhead captured BEFORE
                    // the edit. By now the audio has advanced past it, so the
                    // seek drags the clock BACKWARD (and triggers the seek-fade /
                    // voice re-prime) — heard as the playback "rewinding" a few
                    // times per edit (worse in debug, where the gap is bigger).
                    // Instead, read the engine's ACTUAL live playhead and anchor
                    // both the Rust model and clock to it so they stay in sync. A
                    // real seek still goes through reposition_audio on the
                    // seek/jump paths.
                    AudioChangeImpact::TimelineWindow | AudioChangeImpact::StructureRebuild => {
                        let live_position = self
                            .runtime_transport_position(audio)
                            .map(|(pos, _)| pos)
                            .unwrap_or(restored_position);
                        self.engine
                            .sync_position_preserving_transport_state(live_position)?;
                        self.transport_clock.reanchor_playing(live_position);
                    }
                }
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

    pub fn transport_position_seconds(&self) -> f64 {
        self.current_position()
    }

    /// Where to drop the NEXT imported project so it sits after the current
    /// setlist with a one-bar breathing gap between songs (regions are whole
    /// songs and may not overlap — the engine rejects that). Returns 0 when
    /// nothing is loaded so the first import starts at the top. The one-bar
    /// spacing mirrors how `create_empty_song` separates appended songs, landing
    /// on a real grid downbeat instead of butting the next song flush against the
    /// previous one.
    pub fn setlist_end_seconds(&self) -> f64 {
        let Some(song) = self.engine.song() else {
            return 0.0;
        };
        let last_end = song
            .regions
            .iter()
            .map(|region| region.end_seconds)
            .fold(0.0_f64, f64::max);
        if last_end <= 0.0 {
            return 0.0;
        }
        // One bar of silence at the tempo in effect at the end of the setlist,
        // snapped to the next downbeat so the new song starts on the grid.
        let gap_target = last_end + bar_seconds_at(song, last_end);
        next_downbeat_after_in_song(song, gap_target)
    }

    /// Where to drop an imported external project that wants to land at
    /// `desired_seconds` (e.g. the X position of a timeline drop). A whole
    /// imported project becomes one or more songs (regions), and the engine
    /// rejects overlapping songs — so if `[desired, desired + project_duration]`
    /// would intersect any existing region, fall back to appending after the
    /// current setlist (`setlist_end_seconds`). With no song / no regions the
    /// desired position is used as-is (clamped to >= 0).
    pub(super) fn resolve_external_insert_seconds(
        &self,
        desired_seconds: f64,
        project_duration_seconds: f64,
    ) -> f64 {
        let desired = desired_seconds.max(0.0);
        let Some(song) = self.engine.song() else {
            return desired;
        };
        let desired_end = desired + project_duration_seconds.max(0.0);
        let overlaps = song.regions.iter().any(|region| {
            // Half-open ranges; touching at an edge is fine (no overlap).
            desired < region.end_seconds - 0.0001 && desired_end > region.start_seconds + 0.0001
        });
        if overlaps {
            self.setlist_end_seconds()
        } else {
            desired
        }
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

    pub(super) fn runtime_seconds_for_engine_position(&self, position_seconds: f64) -> f64 {
        self.engine
            .song()
            .map(|song| warp_timeline_seconds_at(song, position_seconds))
            .unwrap_or(position_seconds)
    }

    pub(super) fn sync_position(&mut self, audio: &AudioController) -> Result<(), DesktopError> {
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
            // Step any in-progress volume/pan ramps.
            self.advance_mix_ramps(audio)?;
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
                // Reanchor to the engine's actual post-jump position. (Using the
                // computed target instead broke the second jump of a looping cue
                // because the imposed position drifted from where the native
                // engine really landed, desyncing the next jump's scheduling.)
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
                    // The jump's mix scene applies instantly as the culmination.
                    self.apply_mix_scene_runtime(scene_id, 0.0, audio)?;
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

    pub(super) fn snapshot(&mut self) -> TransportSnapshot {
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
                        target_seconds: automation_target_source_seconds(song, &pending.target)
                            .map(|seconds| warp_timeline_seconds_at(song, seconds))
                            .unwrap_or(0.0),
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
            sources: self.last_source_readiness.clone().unwrap_or_default(),
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

    pub(super) fn record_import_metrics(&mut self, metrics: &ImportOperationMetrics) {
        self.perf_metrics.copy_millis = metrics.copy_millis;
        self.perf_metrics.wav_analysis_millis = metrics.wav_analysis_millis;
        self.perf_metrics.waveform_write_millis = metrics.waveform_write_millis;
        self.perf_metrics.song_save_millis = metrics.song_save_millis;
    }

    pub(super) fn current_song_file_path(&self) -> Result<PathBuf, DesktopError> {
        if let Some(song_file_path) = self.song_file_path.clone() {
            return Ok(song_file_path);
        }

        self.song_dir
            .as_ref()
            .map(|song_dir| song_dir.join(SONG_FILE_NAME))
            .ok_or(DesktopError::NoSongLoaded)
    }

    pub(super) fn prime_waveform_cache(
        &mut self,
        song_dir: &Path,
        _song: &Song,
    ) -> Result<(), DesktopError> {
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
    pub(super) fn populate_waveform_cache_readonly(
        &mut self,
        song_dir: &Path,
        song: &Song,
    ) -> Vec<String> {
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
    pub(super) fn ensure_project_waveforms_ready(
        &mut self,
        app: &AppHandle,
        song_dir: &Path,
        song: &Song,
    ) -> Result<(), DesktopError> {
        let misses = self.populate_waveform_cache_readonly(song_dir, song);
        let desktop_state = app.state::<DesktopState>();
        let jobs = &desktop_state.waveform_jobs;
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

    // restart_audio() was removed: structural edits now route through the
    // incremental upsert (persist_song_update -> upsert_song_tracks +
    // reposition_audio), so nothing needs the destructive
    // replace_song_buffers (full LoadSession) + restart path anymore. Opening a
    // project still uses load_song_from_path, which is where a full rebuild
    // belongs. Keeping restart_audio around would leave the clear()+re-decode
    // stall one careless call away. See
    // docs/HANDOFF_import_while_playing_glitches.md.
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
pub(super) enum AudioChangeImpact {
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

pub(super) fn build_empty_song(song_id: String, title: String) -> Song {
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

/// Reduce a full session `Song` to a reusable template: keep the organizational
/// structure (tracks, folder hierarchy via `parent_track_id`, routing via
/// `audio_to`, names, colors, kinds) and drop everything song-specific (clips,
/// regions, markers, tempo map and per-track mix). The result is what gets
/// serialized into a portable `.lttemplate` file.
pub(super) fn strip_song_to_template(mut song: Song) -> Song {
    song.title = "Plantilla".into();
    song.artist = None;
    song.key = None;
    song.bpm = 120.0;
    song.time_signature = "4/4".into();
    song.duration_seconds = 60.0;
    song.tempo_markers.clear();
    song.time_signature_markers.clear();
    song.regions.clear();
    song.clips.clear();
    song.section_markers.clear();

    for track in song.tracks.iter_mut() {
        // Structure/routing survive; the mix is reset to defaults so the
        // template is a neutral starting point rather than a saved mix.
        track.volume = 1.0;
        track.pan = 0.0;
        track.muted = false;
        track.solo = false;
        track.transpose_enabled = true;
        // Auto-created tracks vanish once empty; a template has no clips, so
        // pin every track as explicit to preserve the whole layout.
        track.auto_created = false;
    }

    song
}

/// Turn a loaded `.lttemplate` document into the seed `Song` for a fresh
/// project: re-apply the template stripping (defensively, in case the file was
/// hand-edited or carried residue) and stamp it with a new id and the project
/// title chosen at creation time.
pub(super) fn build_template_song(template: Song, song_id: String, title: String) -> Song {
    let mut song = strip_song_to_template(template);
    song.id = song_id;
    song.title = title;
    song
}

pub(crate) fn emit_library_import_progress(app: &AppHandle, percent: u8, message: String) {
    let payload = LibraryImportProgressEvent { percent, message };

    if let Err(error) = app.emit(LIBRARY_IMPORT_PROGRESS_EVENT, payload) {
        eprintln!("[libretracks-library] failed to emit import progress: {error}");
    }
}

/// Emit a project-load progress update carrying only a percent + message (the
/// source/cache counters stay 0). Used by the off-lock package decompression
/// phase to drive the same progress overlay as the rest of the import.
pub(crate) fn emit_project_load_message(app: &AppHandle, percent: u8, message: String) {
    emit_project_load_progress(app, percent, message, 0, 0, 0, 0);
}

pub(super) fn emit_project_load_progress(
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
pub(super) struct LibraryManifest {
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

pub(super) fn library_manifest_path(song_dir: &Path) -> PathBuf {
    song_dir.join(LIBRARY_MANIFEST_FILE_NAME)
}

pub(super) fn normalize_library_file_path(file_path: &str) -> String {
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

/// Android staged-import variant: like the bytes import above — the asset is
/// moved INTO the session's audio/ folder and registered by RELATIVE path —
/// but the source is a staged temp file (see `stage_imported_audio_chunk`)
/// that gets consumed (rename, or copy+delete across filesystems).
///
/// This must NOT go through `import_audio_files_from_paths_to_library`: that
/// one registers the ABSOLUTE source path (desktop assets reference the
/// user's original files), and staged temp files are ephemeral — the next
/// import batch cleans the staging area, which surfaced phantom
/// "missing file" warnings for assets that played back fine (the clip's
/// session copy existed; the library provenance path didn't).
pub fn import_staged_audio_files_to_library(
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
            let source_path = PathBuf::from(file.source_path.trim());
            if !source_path.is_file() {
                return Err(DesktopError::AudioCommand(format!(
                    "staged import source not found: {}",
                    source_path.display()
                )));
            }

            let sanitized_file_name = sanitize_import_file_name(&file.file_name)?;
            let relative_path = allocate_library_audio_path(&reserved_paths, &sanitized_file_name);
            reserved_paths.insert(relative_path.clone());

            let absolute_path = resolve_audio_file_path(song_dir, &relative_path);
            if fs::rename(&source_path, &absolute_path).is_err() {
                fs::copy(&source_path, &absolute_path)?;
                let _ = fs::remove_file(&source_path);
            }
            written_paths.push(absolute_path.clone());
            // Best-effort cleanup of the per-file staging folder.
            if let Some(parent) = source_path.parent() {
                let _ = fs::remove_dir(parent);
            }

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
        Ok(imported_assets)
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

    let mut imported_assets = Vec::with_capacity(files.len());
    let mut seen_import_paths = HashSet::new();

    for file in files {
        let trimmed_source_path = file.source_path.trim();
        if trimmed_source_path.is_empty() {
            return Err(DesktopError::AudioCommand(
                "source path is required for audio import".into(),
            ));
        }

        let source_path = PathBuf::from(trimmed_source_path);
        let source_path = source_path
            .canonicalize()
            .unwrap_or_else(|_| source_path.clone());
        let metadata = read_audio_metadata(&source_path)?;
        let normalized_path = normalize_library_file_path(source_path.to_string_lossy().as_ref());

        if !seen_import_paths.insert(normalized_path.clone()) {
            continue;
        }

        let file_name = source_path
            .file_name()
            .and_then(|value| value.to_str())
            .or_else(|| {
                Path::new(&file.file_name)
                    .file_name()
                    .and_then(|value| value.to_str())
            })
            .unwrap_or(&normalized_path)
            .to_string();

        imported_assets.push(LibraryAssetSummary {
            file_name,
            file_path: normalized_path,
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
    Ok(imported_assets)
}

pub(super) fn normalize_library_folder_path(folder_path: &str) -> Option<String> {
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

pub(super) fn is_library_folder_in_branch(folder_path: &str, branch_root: &str) -> bool {
    folder_path == branch_root || folder_path.starts_with(&format!("{branch_root}/"))
}

pub(super) fn rename_library_folder_branch(
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

pub(super) fn read_library_manifest(song_dir: &Path) -> Result<Option<LibraryManifest>, DesktopError> {
    let manifest_path = library_manifest_path(song_dir);
    if !manifest_path.exists() {
        return Ok(None);
    }

    let manifest = serde_json::from_slice::<LibraryManifest>(&fs::read(&manifest_path)?)
        .map_err(|error| DesktopError::AudioCommand(error.to_string()))?;
    Ok(Some(manifest))
}

pub(super) fn write_library_manifest(song_dir: &Path, file_paths: &[String]) -> Result<(), DesktopError> {
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

pub(super) fn write_library_manifest_assets(
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

pub(super) fn write_library_manifest_state(
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

pub(super) fn list_library_folders(
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

pub(crate) fn list_library_assets(
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

pub(super) fn project_root(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("LibreTracks"))
}

pub(super) fn automation_target_source_seconds(
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

pub(super) fn validate_automation_cue(
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
            AutomationAction::ApplyScene {
                scene_id,
                ramp_seconds,
            } => {
                if !scene_exists(scene_id) {
                    return Err(DesktopError::AudioCommand(format!(
                        "mix scene not found: {scene_id}"
                    )));
                }
                if ramp_seconds.is_some_and(|r| !r.is_finite() || r < 0.0) {
                    return Err(DesktopError::AudioCommand(
                        "automation scene ramp must be a finite, non-negative number".into(),
                    ));
                }
            }
            AutomationAction::SetPad {
                pad_id,
                pad_key,
                volume,
                output,
                fade_in_seconds,
                fade_out_seconds,
                ..
            } => {
                if pad_id.trim().is_empty() {
                    return Err(DesktopError::AudioCommand(
                        "automation pad pack is required".into(),
                    ));
                }
                if !(0..=11).contains(pad_key) {
                    return Err(DesktopError::AudioCommand(
                        "automation pad key must be between 0 and 11".into(),
                    ));
                }
                if !volume.is_finite() || !(0.0..=10.0).contains(volume) {
                    return Err(DesktopError::AudioCommand(
                        "automation pad volume must be between 0 and 10".into(),
                    ));
                }
                if output.trim().is_empty() {
                    return Err(DesktopError::AudioCommand(
                        "automation pad output is required".into(),
                    ));
                }
                for (fade, label) in [(fade_in_seconds, "fade-in"), (fade_out_seconds, "fade-out")]
                {
                    if let Some(seconds) = fade {
                        if !seconds.is_finite() || !(0.0..=30.0).contains(seconds) {
                            return Err(DesktopError::AudioCommand(format!(
                                "automation pad {label} must be between 0 and 30 seconds"
                            )));
                        }
                    }
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

pub(super) fn timestamp_suffix() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

pub(super) fn set_song_tempo_at_source_position(song: &mut Song, start_seconds: f64, bpm: f64) {
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

pub(super) fn validate_time_signature(signature: &str) -> Result<(), DesktopError> {
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

pub(crate) fn resolve_audio_file_path(song_dir: &Path, file_path: &str) -> PathBuf {
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

/// Summary of a session folder inside the default songs directory, surfaced
/// to the landing screen on platforms without native file dialogs (Android):
/// the user picks from this list instead of an "open file" dialog.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub name: String,
    pub song_file: String,
    pub modified_ms: Option<u64>,
}

/// List the sessions living in the default songs folder, most recently
/// modified first. Missing folder → empty list (fresh install).
pub(crate) fn list_default_sessions(app: &AppHandle) -> Vec<SessionSummary> {
    let dir = create_song_default_directory(app);
    let mut sessions: Vec<SessionSummary> = match fs::read_dir(&dir) {
        Ok(entries) => entries
            .flatten()
            .filter_map(|entry| {
                let folder = entry.path();
                if !folder.is_dir() {
                    return None;
                }
                let song_file = fs::read_dir(&folder)
                    .ok()?
                    .flatten()
                    .map(|entry| entry.path())
                    .find(|path| {
                        path.extension()
                            .and_then(|ext| ext.to_str())
                            .is_some_and(|ext| ext.eq_ignore_ascii_case("ltsession"))
                    })?;
                let name = folder.file_name()?.to_str()?.to_string();
                let modified_ms = song_file
                    .metadata()
                    .ok()
                    .and_then(|meta| meta.modified().ok())
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|duration| duration.as_millis() as u64);
                Some(SessionSummary {
                    name,
                    song_file: song_file.to_string_lossy().into_owned(),
                    modified_ms,
                })
            })
            .collect(),
        Err(_) => Vec::new(),
    };
    sessions.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    sessions
}

/// Default folder where "Save as template" suggests writing `.lttemplate`
/// files and where the landing screen looks for reusable templates. Users can
/// still save/open templates anywhere; this is just the discoverable home.
pub(crate) fn templates_default_directory(app: &AppHandle) -> PathBuf {
    project_root(app).join("templates")
}

/// Summary of a `.lttemplate` file surfaced to the frontend template picker.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateSummary {
    pub name: String,
    pub path: String,
}

/// List the `.lttemplate` files living in the default templates folder, sorted
/// by name. Missing folder → empty list (not an error): a fresh install simply
/// has no templates yet.
pub(crate) fn list_default_templates(app: &AppHandle) -> Vec<TemplateSummary> {
    let dir = templates_default_directory(app);
    let mut templates: Vec<TemplateSummary> = match fs::read_dir(&dir) {
        Ok(entries) => entries
            .flatten()
            .filter_map(|entry| {
                let path = entry.path();
                let is_template = path
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("lttemplate"));
                if !is_template {
                    return None;
                }
                let name = path.file_stem()?.to_str()?.to_string();
                Some(TemplateSummary {
                    name,
                    path: path.to_string_lossy().into_owned(),
                })
            })
            .collect(),
        Err(_) => Vec::new(),
    };
    templates.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    templates
}

pub(super) fn normalize_external_source_key(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "/")
        .to_ascii_lowercase()
}

pub(super) fn unique_song_entity_id(
    prefix: &str,
    seed: &str,
    used: &mut HashSet<String>,
) -> String {
    let slug_seed = slugify(seed);
    let base = if slug_seed.is_empty() {
        "item"
    } else {
        &slug_seed
    };
    let mut index = 0_u32;
    loop {
        let candidate = if index == 0 {
            format!("{prefix}_{base}")
        } else {
            format!("{prefix}_{base}_{index}")
        };
        if used.insert(candidate.clone()) {
            return candidate;
        }
        index += 1;
    }
}

pub(super) fn upsert_imported_tempo_marker(song: &mut Song, start_seconds: f64, bpm: f64) {
    let start_seconds = start_seconds.max(0.0);
    if let Some(existing_marker) = song
        .tempo_markers
        .iter_mut()
        .find(|marker| (marker.start_seconds - start_seconds).abs() <= 0.0001)
    {
        existing_marker.bpm = bpm;
        return;
    }

    song.tempo_markers.push(TempoMarker {
        id: format!("tempo_marker_import_{}", timestamp_suffix()),
        start_seconds,
        bpm,
    });
    song.tempo_markers.sort_by(|left, right| {
        left.start_seconds
            .partial_cmp(&right.start_seconds)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
}

pub(super) fn upsert_imported_time_signature_marker(
    song: &mut Song,
    start_seconds: f64,
    signature: &str,
) {
    let start_seconds = start_seconds.max(0.0);

    if start_seconds <= 0.0001 {
        song.time_signature = signature.to_string();
        return;
    }

    if let Some(existing_marker) = song
        .time_signature_markers
        .iter_mut()
        .find(|marker| (marker.start_seconds - start_seconds).abs() <= 0.0001)
    {
        existing_marker.signature = signature.to_string();
        return;
    }

    song.time_signature_markers.push(TimeSignatureMarker {
        id: format!("time_signature_marker_import_{}", timestamp_suffix()),
        start_seconds,
        signature: signature.to_string(),
    });
    song.time_signature_markers.sort_by(|left, right| {
        left.start_seconds
            .partial_cmp(&right.start_seconds)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
}

pub(super) fn append_imported_section_marker(song: &mut Song, start_seconds: f64, name: &str) {
    let start_seconds = start_seconds.max(0.0);
    if song
        .section_markers
        .iter()
        .any(|marker| (marker.start_seconds - start_seconds).abs() <= 0.0001)
    {
        return;
    }

    song.section_markers.push(Marker {
        id: format!("marker_import_{}", timestamp_suffix()),
        name: name.trim().to_string(),
        start_seconds,
        digit: None,
        // Imported markers carry only a freeform label from the external DAW, so
        // they land as untyped Custom sections (kind palette / voice bank fall
        // back to the base). The user can retag them afterwards.
        kind: MarkerKind::Custom,
        variant: None,
        color: None,
    });
}

pub(super) fn normalize_imported_section_markers(markers: &mut Vec<Marker>) {
    markers.sort_by(|left, right| {
        left.start_seconds
            .partial_cmp(&right.start_seconds)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut deduped = Vec::<Marker>::new();
    for marker in markers.drain(..) {
        if deduped
            .iter()
            .any(|existing| (existing.start_seconds - marker.start_seconds).abs() <= 0.0001)
        {
            continue;
        }
        deduped.push(marker);
    }

    *markers = deduped;
}

pub(super) fn ensure_unique_imported_song_entity_ids(song: &mut Song) {
    let mut used = HashSet::<String>::new();

    used.insert(song.id.clone());
    for track in &song.tracks {
        used.insert(track.id.clone());
    }
    for clip in &song.clips {
        used.insert(clip.id.clone());
    }

    for marker in &mut song.section_markers {
        if marker.id.trim().is_empty() || !used.insert(marker.id.clone()) {
            marker.id = unique_song_entity_id("marker_import", &marker.name, &mut used);
        }
    }

    for region in &mut song.regions {
        if region.id.trim().is_empty() || !used.insert(region.id.clone()) {
            region.id = unique_song_entity_id("region_import", &region.name, &mut used);
        }
    }

    for marker in &mut song.tempo_markers {
        if marker.id.trim().is_empty() || !used.insert(marker.id.clone()) {
            marker.id = unique_song_entity_id(
                "tempo_marker_import",
                &format!("{:.3}", marker.start_seconds),
                &mut used,
            );
        }
    }

    for marker in &mut song.time_signature_markers {
        if marker.id.trim().is_empty() || !used.insert(marker.id.clone()) {
            marker.id =
                unique_song_entity_id("time_signature_marker_import", &marker.signature, &mut used);
        }
    }
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

pub(super) fn copy_project_audio_files(
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
mod tests;
