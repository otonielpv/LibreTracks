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
    AudioEngine, JumpTrigger, PlaybackState, TransitionType, VampMode,
};
use libretracks_core::{
    audible_clip_duration_seconds, effective_bpm_at, region_warp_ratio_in_song,
    source_seconds_at_view, warp_timeline_seconds_at, Clip, Marker, MarkerKind, Song, SongRegion,
    TempoMarker, TimeSignatureMarker, Track, TrackKind, MAX_TRANSPOSE_SEMITONES,
    MIN_TRANSPOSE_SEMITONES,
};
use libretracks_project::{
    append_wav_files_to_song, extract_session_package, global_waveform_file_path,
    import_song_package as import_song_package_into_project, import_wav_files_to_library,
    load_global_waveform, load_or_generate_global_waveform, load_song_from_file,
    merge_extracted_song_package, read_audio_metadata, save_song_to_file,
    waveform_summary_from_channel_peaks, write_global_waveform, ExtractedSessionPackage,
    ExtractedSongPackage, ImportOperationMetrics, ImportedSong, PackageLibraryAssetEntry,
    ProjectError, SidecarFile, WaveformSummary, SONG_FILE_NAME,
};
use rayon::prelude::*;

use crate::file_dialog::FileDialog;
use serde::{Deserialize, Serialize};
use serde_json::to_vec;
use tauri::{AppHandle, Emitter, Manager};

use crate::audio_engine::{
    jump_debug_logging_enabled, AudioController, PlaybackStartReason,
    ENGINE_WAVEFORM_RESOLUTION_FRAMES,
};
use crate::automation::{
    load_automation, save_automation, AutomationAction, AutomationCue, AutomationDocument,
    AutomationJumpTarget, AutomationTransitionMode, AUTOMATION_FILE_NAME,
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
mod automation_runtime;
mod external_import;

const LIBRARY_MANIFEST_FILE_NAME: &str = "library.json";
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
const MAX_TRACK_GAIN: f64 = 3.162_277_66;

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
enum TransposeHistoryTarget {
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
    pub fn ensure_song_loaded_for_external_import(
        &mut self,
        app: &AppHandle,
        audio: &AudioController,
    ) -> Result<(), DesktopError> {
        if self.engine.song().is_some() {
            return Ok(());
        }

        let base_dir = project_root(app).join("imports");
        fs::create_dir_all(&base_dir)?;

        let mut attempt = 0_u32;
        let (song_dir, song_file_path) = loop {
            let suffix = timestamp_suffix();
            let folder_name = if attempt == 0 {
                format!("import-session-{suffix}")
            } else {
                format!("import-session-{suffix}-{attempt}")
            };
            let candidate_dir = base_dir.join(&folder_name);
            if !candidate_dir.exists() {
                break (
                    candidate_dir.clone(),
                    candidate_dir.join("import-session.ltsession"),
                );
            }
            attempt = attempt.saturating_add(1);
        };

        fs::create_dir_all(song_dir.join("audio"))?;
        fs::create_dir_all(song_dir.join("cache").join("waveforms"))?;
        write_library_manifest(&song_dir, &[])?;

        let song = build_empty_song(
            format!("song_import_{}", timestamp_suffix()),
            "Import Reaper/Ableton".to_string(),
        );
        save_song_to_file(&song_file_path, &song)?;
        self.load_song_from_path(song, song_dir, audio)?;
        self.song_file_path = Some(song_file_path);

        eprintln!("[libretracks-import] bootstrap empty session created for wizard import");

        Ok(())
    }

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
        self.create_song_at_path_with(target_pick, song, audio)
    }

    /// Create a brand-new project at `target_pick` whose arrangement structure
    /// comes from a `.lttemplate` file (tracks, folder hierarchy and routing).
    /// The template is loaded, stripped of any residual clips/regions and given
    /// fresh entity ids/title so the resulting session is a clean slate ready to
    /// receive audio (see [`build_template_song`]).
    pub fn create_song_from_template_path(
        &mut self,
        template_path: PathBuf,
        target_pick: PathBuf,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let template_song = load_song_from_file(&template_path).map_err(|error| {
            DesktopError::AudioCommand(format!(
                "no se pudo leer la plantilla \"{}\": {error}",
                template_path.display()
            ))
        })?;

        let project_name = target_pick
            .file_stem()
            .and_then(|stem| stem.to_str())
            .map(str::to_owned)
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| "Nueva Cancion".to_string());
        let song_id = format!("song_{}", timestamp_suffix());
        let song = build_template_song(template_song, song_id, project_name);

        self.create_song_at_path_with(target_pick, song, audio)
    }

    /// Shared body for creating a new on-disk project (empty or from a
    /// template): builds the Ableton-style folder layout, writes the session
    /// document and loads it into the engine. `song` is whatever arrangement the
    /// caller wants the fresh project to start with.
    fn create_song_at_path_with(
        &mut self,
        target_pick: PathBuf,
        song: Song,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
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

    /// Serialize the currently loaded session as a portable `.lttemplate` file
    /// at `template_path`. Only the organizational structure is kept (tracks,
    /// folder hierarchy, routing, names and colors); clips, regions, markers and
    /// per-track mix are dropped so the template is a clean starting point.
    pub fn save_current_as_template(&self, template_path: PathBuf) -> Result<(), DesktopError> {
        let song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        let template = strip_song_to_template(song);
        save_song_to_file(&template_path, &template)?;
        Ok(())
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

    /// Resolve the source data for a whole-session `.ltset` export: the live
    /// song dir, the in-memory song (so unsaved edits are captured), and the
    /// sidecar files that must travel with it. Automation is flushed to disk
    /// first so its sidecar reflects the current state, mirroring `save_project`.
    pub fn prepare_session_package_export(
        &self,
    ) -> Result<(PathBuf, Song, Vec<SidecarFile>), DesktopError> {
        let song_dir = self.song_dir.clone().ok_or(DesktopError::NoSongLoaded)?;
        let song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;

        // Flush automation so the bundled sidecar matches the live session.
        save_automation(&song_dir, &self.automation)
            .map_err(|error| DesktopError::AudioCommand(error.to_string()))?;

        let sidecars = vec![
            SidecarFile {
                file_name: LIBRARY_MANIFEST_FILE_NAME.to_string(),
            },
            SidecarFile {
                file_name: AUTOMATION_FILE_NAME.to_string(),
            },
        ];

        Ok((song_dir, song, sidecars))
    }

    /// Inflate a `.ltset` into a freshly created project folder and open it as a
    /// new session, replacing whatever was loaded. This is the "create at home,
    /// open at the venue" flow — it does NOT merge into the current session.
    ///
    /// `target_song_dir` must not already exist (the caller picks a name/location
    /// and we own the folder). The slow decompression runs on the calling
    /// thread; callers run this off the session lock.
    pub fn import_session_package_as_new(
        &mut self,
        app: &AppHandle,
        audio: &AudioController,
        package_path: &Path,
        target_song_dir: &Path,
    ) -> Result<TransportSnapshot, DesktopError> {
        if target_song_dir.exists() {
            return Err(DesktopError::AudioCommand(format!(
                "ya existe una carpeta llamada \"{}\" en esa ubicacion. Elige otro nombre.",
                target_song_dir
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("proyecto")
            )));
        }

        emit_project_load_progress(app, 8, "Descomprimiendo sesion...".into(), 0, 0, 0, 0);
        let extracted: ExtractedSessionPackage =
            extract_session_package(target_song_dir, package_path, |done, total| {
                if total > 0 {
                    // Decompression occupies the 8–40% band; audio prep takes over after.
                    let percent = (8 + ((done as f64 / total as f64) * 32.0) as u32).min(40) as u8;
                    emit_project_load_progress(
                        app,
                        percent,
                        "Descomprimiendo sesion...".into(),
                        0,
                        0,
                        0,
                        0,
                    );
                }
            })
            .map_err(|error| DesktopError::AudioCommand(error.to_string()))?;

        self.begin_open_project_from_path(app, audio, extracted.song_file)?;
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
    /// Read the destination dir for a package import. The caller uses this to
    /// run the slow decompression (`extract_song_package`) WITHOUT holding the
    /// session lock — see `start_import_song_package_from_path`.
    pub fn package_import_song_dir(&self) -> Result<PathBuf, DesktopError> {
        let song_dir = self.song_dir.clone().ok_or(DesktopError::NoSongLoaded)?;
        // Confirm a song is loaded now so the caller fails fast before doing the
        // expensive extraction; we re-clone the (possibly newer) song under the
        // lock when applying.
        self.engine.song().ok_or(DesktopError::NoSongLoaded)?;
        Ok(song_dir)
    }

    /// Merge an already-decompressed package (`extract_song_package`) into the
    /// current song. This is the fast, session-bound half of an import; the
    /// caller holds the session lock only for this call, never for the
    /// decompression that precedes it.
    pub fn import_song_from_extracted(
        &mut self,
        app: &AppHandle,
        audio: &AudioController,
        extracted: ExtractedSongPackage,
        insert_at_seconds: f64,
    ) -> Result<TransportSnapshot, DesktopError> {
        self.song_dir.as_ref().ok_or(DesktopError::NoSongLoaded)?;
        self.engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;

        // Merge WITHOUT blocking on source decode. This phase repoints copied
        // audio, persists the structure (StructureRebuild → the engine's
        // incremental upsert), and primes the waveform cache — all fast — giving
        // the frontend a complete song (tracks + clips + waveform placeholders).
        // The sources are enqueued for background decode by the upsert; we do
        // NOT wait for them here. Play is progressive (decoded head audible, rest
        // silent — R5). Previously this also unzipped under the session lock,
        // which froze the UI for the whole import of a large package.
        let inserted =
            self.import_song_package_no_wait(app, extracted, insert_at_seconds, audio)?;

        Ok(inserted.snapshot)
    }

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

    #[cfg_attr(not(test), allow(dead_code))]
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
        kind: Option<MarkerKind>,
        variant: Option<u8>,
        name: Option<String>,
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
        // The caller may create the marker already typed (Section or Cue) and
        // named — the frontend supplies the localized name. Otherwise it falls
        // back to an untyped Custom marker with a generic generated name.
        let kind = kind.unwrap_or(MarkerKind::Custom);
        let marker_name = name
            .map(|n| n.trim().to_string())
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| song.next_marker_name());
        song.section_markers.push(Marker {
            id: format!("section_{}", timestamp_suffix()),
            name: marker_name,
            start_seconds,
            digit: None,
            kind,
            variant,
            color: None,
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
            key: None,
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
            key: None,
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
            key: existing_region.key.clone(),
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
        // Extending a region's end past the last clip is allowed (the region is
        // a named span, not a transform on its contents). The song must envelop
        // every region or the engine's session validator rejects the sync with
        // "Region X is outside its song", so grow the song duration to cover the
        // new region end. refresh_song_duration takes max(clip_end, region_end),
        // so shrinking back never strands the duration above real content.
        refresh_song_duration(&mut song);
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
            key: existing_region.key.clone(),
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
        self.last_source_readiness = Some(audio.source_readiness_summary());

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
        self.last_source_readiness = Some(audio.source_readiness_summary());

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
        // any clips and markers that live inside its range. Without this the
        // clips would survive past the region's removal and break the "clip
        // lives inside one region" invariant (step 4.1), and stale tempo /
        // section markers would keep affecting playback at positions the user
        // thought were gone with the song. Section markers in particular also
        // break the next LoadSession: the C++ validator rejects a marker whose
        // frame no longer falls inside any song range ("Marker X is outside
        // its song"), so deleting a song with markers must take its markers.
        let region_start = song.regions[region_index].start_seconds;
        let region_end = song.regions[region_index].end_seconds;

        song.regions.remove(region_index);
        song.clips.retain(|clip| {
            clip.timeline_start_seconds < region_start || clip.timeline_start_seconds >= region_end
        });
        song.tempo_markers.retain(|marker| {
            marker.start_seconds < region_start || marker.start_seconds >= region_end
        });
        song.section_markers.retain(|marker| {
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

    /// Split a song (SongRegion) in two at `split_seconds_view`. The left half
    /// keeps the original id/name/transpose/warp/master; the right half is a new
    /// region named "<name> (2)" inheriting the same musical settings (it is the
    /// same song, cut in two). Clips and markers are NOT moved — each already
    /// belongs to whichever half contains its start (the "clip lives inside one
    /// region" invariant), so the split point alone redistributes them. A clip
    /// straddling the cut stays in the left half (its start is left of the cut);
    /// the user can split that clip separately if they want.
    pub fn split_song_region(
        &mut self,
        region_id: &str,
        split_seconds_view: f64,
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

        // Region bounds live in source-time; the cursor is view-time. Convert,
        // mirroring split_clips.
        let split_seconds = source_seconds_at_view(&song, split_seconds_view);
        let region = song.regions[region_index].clone();
        // The cut must fall strictly inside the region, with enough room for two
        // non-degenerate halves.
        if split_seconds <= region.start_seconds + 0.001
            || split_seconds >= region.end_seconds - 0.001
        {
            return Err(DesktopError::InvalidSplitPoint);
        }

        // A clip may not cross a region boundary (the engine rejects it). Any
        // clip straddling the cut is split there too, so each half stays inside
        // its song — exactly what split_clips does at the cursor.
        split_clips_crossing_point(&mut song, split_seconds_view);

        let right = SongRegion {
            id: format!("region_{}_{}", timestamp_suffix(), song.regions.len()),
            name: format!("{} (2)", region.name),
            start_seconds: split_seconds,
            end_seconds: region.end_seconds,
            transpose_semitones: region.transpose_semitones,
            key: region.key.clone(),
            warp_enabled: region.warp_enabled,
            warp_source_bpm: region.warp_source_bpm,
            master: region.master.clone(),
        };
        // Left half: shrink the original region's end to the cut.
        song.regions[region_index].end_seconds = split_seconds;
        song.regions.push(right);
        sort_song_regions(&mut song.regions);

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

    /// Set (or clear, with `None`) a marker's colour override. Only meaningful
    /// for Custom markers — typed sections/cues take their colour from the kind
    /// palette — but the backend just stores whatever the caller sends. Colour
    /// is presentation-only (the engine never reads it), so this does not touch
    /// the live voice-guide markers.
    pub fn set_section_marker_color(
        &mut self,
        section_id: &str,
        color: Option<String>,
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
        marker.color = color
            .map(|c| c.trim().to_string())
            .filter(|c| !c.is_empty());

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

    /// Sets a region's (song's) original musical key (e.g. `"Dm"`, `"F#"`).
    /// Pure display metadata — the audible pitch is driven by the region's
    /// `transpose_semitones`, so this only persists and re-emits the snapshot.
    /// `None` (or an empty/whitespace string) clears the key.
    pub fn update_song_region_key(
        &mut self,
        region_id: &str,
        key: Option<String>,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
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
        region.key = key
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());

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
    fn import_song_package_no_wait(
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

    /// Drop a list of library assets onto the timeline: each becomes a
    /// persistent audio track (named `track_name`) holding one clip. The whole
    /// batch is a single song update so the cost is one rebuild regardless of
    /// how many assets are dropped or how much the song already holds.
    pub fn create_audio_tracks_with_clips(
        &mut self,
        requests: &[CreateAudioTrackWithClipRequest],
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
            let trimmed_name = request.track_name.trim();
            if trimmed_name.is_empty() {
                return Err(DesktopError::AudioCommand(
                    "track name must not be empty".into(),
                ));
            }
            // view-time -> source-time, same conversion create_clips_batch does
            // so warp/varispeed regions don't shift the clip from the drop point.
            let source_start_seconds =
                source_seconds_at_view(&song, request.timeline_start_seconds);
            let track_id = format!(
                "track_{}_{}",
                timestamp_suffix(),
                song.tracks.len() + offset
            );
            song.tracks.push(Track {
                id: track_id.clone(),
                name: trimmed_name.to_string(),
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
        self.delete_tracks(&[track_id.to_string()], audio)
    }

    /// Delete every track in `track_ids` in a single transaction: repair the
    /// folder hierarchy for each, drop the clips of any deleted audio track, and
    /// persist ONE `StructureRebuild`. Deleting a multi-track selection used to
    /// loop `delete_track` per id from the frontend — N engine syncs + N
    /// snapshots + N history entries — which made the tracks vanish one by one
    /// and felt sluggish on big selections. Mirrors the batched `delete_clips`.
    pub fn delete_tracks(
        &mut self,
        track_ids: &[String],
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        if track_ids.is_empty() {
            return Ok(self.snapshot());
        }

        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;

        let mut any_audio_deleted = false;
        for track_id in track_ids {
            // A track may already be gone if it was a child of a folder deleted
            // earlier in this batch (the hierarchy repair reparents/removes
            // descendants). Treat a now-missing id as a no-op so the whole batch
            // doesn't fail because of selection overlap.
            match delete_track_and_repair_hierarchy(&mut song.tracks, track_id) {
                Ok(deleted_track) => {
                    if deleted_track.kind == TrackKind::Audio {
                        song.clips.retain(|clip| &clip.track_id != track_id);
                        any_audio_deleted = true;
                    }
                }
                Err(DesktopError::TrackNotFound(_)) => continue,
                Err(error) => return Err(error),
            }
        }

        if any_audio_deleted {
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
            self.last_source_readiness = Some(audio.source_readiness_summary());
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

        // How many distinct audio sources the loaded song actually references.
        // Right after a structural import the engine upserts the new sources for
        // background decode, but they take a moment to appear in source_states.
        // Without this, the `total == 0` "empty project" escape hatch below fires
        // during that race window and returns "ready" before any MP3 is decoded —
        // so prime_waveforms_from_engine_peaks finds nothing and the tracks sit on
        // "analyzing waveform" forever. If the song HAS sources, we must wait for
        // the engine to register them instead of short-circuiting.
        let expected_sources = self
            .engine
            .song()
            .map(|song| unique_waveform_keys(song).len())
            .unwrap_or(0);

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
            //
            // The grace window is short (300ms) for a truly empty song, but when
            // the loaded song HAS sources we extend it: right after a structural
            // import the engine upserts the new sources for background decode and
            // they take a moment to appear in source_states. Short-circuiting in
            // that race window returned "ready" before any MP3 was decoded, so the
            // waveform prime found nothing and the tracks sat on "analyzing
            // waveform" forever. Wait up to a few seconds for them to register; if
            // they never do (a decode-pipeline bug elsewhere) we still give up so
            // the importer isn't blocked for the full 120s — the background
            // waveform jobs fall back to native file_peaks generation anyway.
            let empty_grace = if expected_sources == 0 {
                Duration::from_millis(300)
            } else {
                Duration::from_secs(10)
            };
            if total == 0 && started_at.elapsed() >= empty_grace {
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

    pub fn finalize_project_audio_preparation(
        &mut self,
        app: &AppHandle,
        audio: &AudioController,
    ) -> Result<(), DesktopError> {
        self.wait_for_project_audio_preparation(app, audio)
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
            track.volume = volume.clamp(0.0, MAX_TRACK_GAIN);
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

    pub(super) fn prime_waveform_cache(&mut self, song_dir: &Path, _song: &Song) -> Result<(), DesktopError> {
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

/// Reduce a full session `Song` to a reusable template: keep the organizational
/// structure (tracks, folder hierarchy via `parent_track_id`, routing via
/// `audio_to`, names, colors, kinds) and drop everything song-specific (clips,
/// regions, markers, tempo map and per-track mix). The result is what gets
/// serialized into a portable `.lttemplate` file.
fn strip_song_to_template(mut song: Song) -> Song {
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
fn build_template_song(template: Song, song_id: String, title: String) -> Song {
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

fn project_root(app: &AppHandle) -> PathBuf {
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
        key: None,
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
                key: region.key.clone(),
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
                key: region.key.clone(),
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

/// Split every clip whose span strictly contains `split_seconds_view` into two
/// clips at that point. Same cut math as `split_clips` (warp-aware via
/// `source_seconds_at_view`), but applied to whichever clips cross the point
/// rather than a caller-chosen set. Used when splitting a song region so no clip
/// straddles the new song boundary (the engine rejects boundary-crossing clips).
fn split_clips_crossing_point(song: &mut Song, split_seconds_view: f64) {
    let suffix_base = timestamp_suffix();
    let mut index = 0;
    let mut counter = 0;
    while index < song.clips.len() {
        let clip = song.clips[index].clone();
        let clip_end = clip.timeline_start_seconds + clip.duration_seconds;
        if split_seconds_view <= clip.timeline_start_seconds || split_seconds_view >= clip_end {
            index += 1;
            continue;
        }

        let left_duration = split_seconds_view - clip.timeline_start_seconds;
        let right_duration = clip_end - split_seconds_view;
        let split_seconds_source_clip =
            source_seconds_at_view(song, clip.timeline_start_seconds + left_duration);
        let source_left_duration = (split_seconds_source_clip
            - source_seconds_at_view(song, clip.timeline_start_seconds))
        .max(0.0);

        let left_clip = Clip {
            id: format!("clip_{}_{}_l", suffix_base, counter),
            duration_seconds: left_duration,
            ..clip.clone()
        };
        let right_clip = Clip {
            id: format!("clip_{}_{}_r", suffix_base, counter),
            timeline_start_seconds: split_seconds_view,
            source_start_seconds: clip.source_start_seconds + source_left_duration,
            duration_seconds: right_duration,
            ..clip
        };

        song.clips.splice(index..=index, [left_clip, right_clip]);
        // Skip past both halves; neither crosses the point anymore.
        index += 2;
        counter += 1;
    }
}

/// Make an imported song's clips legal against its region (song) boundaries. The
/// engine rejects a clip that crosses from one region into the next. Reaper
/// region-end boundaries can be a few ms shorter than the audio items inside
/// them, so a clip may overrun its region and invade the following song. This:
///   1. splits any clip straddling a region boundary (each region end), then
///   2. grows every region's end to cover the clips that START inside it, capped
///      at the next region's start so regions never overlap.
/// A single-region import just gets its end grown to the last clip end (no split
/// needed). Idempotent-ish and cheap; safe to run once at the end of an import.
fn reconcile_regions_and_clips(song: &mut Song) {
    if song.regions.is_empty() {
        return;
    }
    sort_song_regions(&mut song.regions);

    // 1) Split clips that cross any interior region boundary (each region start
    //    after the first is a boundary between two songs).
    let boundaries: Vec<f64> = song
        .regions
        .iter()
        .skip(1)
        .map(|region| region.start_seconds)
        .collect();
    for boundary in boundaries {
        split_clips_crossing_point(song, boundary);
    }

    // 2) Grow each region end to cover clips starting inside it, capped by the
    //    next region's start (half-open [start, end)).
    let region_count = song.regions.len();
    for index in 0..region_count {
        let start = song.regions[index].start_seconds;
        let cap = song
            .regions
            .get(index + 1)
            .map(|next| next.start_seconds)
            .unwrap_or(f64::INFINITY);
        let max_clip_end = song
            .clips
            .iter()
            .filter(|clip| {
                clip.timeline_start_seconds >= start - 0.0001 && clip.timeline_start_seconds < cap
            })
            .map(|clip| clip.timeline_start_seconds + clip.duration_seconds)
            .fold(song.regions[index].end_seconds, f64::max);
        // Never let the end reach/exceed the next region's start.
        let capped_end = if cap.is_finite() {
            max_clip_end.min(cap)
        } else {
            max_clip_end
        };
        song.regions[index].end_seconds = capped_end.max(start + 0.001);
    }

    refresh_song_duration(song);
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

pub(super) fn unique_song_entity_id(prefix: &str, seed: &str, used: &mut HashSet<String>) -> String {
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

pub(super) fn upsert_imported_time_signature_marker(song: &mut Song, start_seconds: f64, signature: &str) {
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
mod tests;
