//! "Analizar canción": read a song's audio and propose its tempo and time
//! signature markers (from the click track, or the music without one), its
//! key (from the harmonic tracks) and its section markers (from the guide
//! track). See `docs/plans/song-analysis/`.
//!
//! Both are bounced in one pass of the engine's offline renderer (one output
//! file each), so clip offsets, trims and fades are already resolved, and with
//! `apply_mixer: false`, so a track's own volume or mute (the click is often
//! silenced to the room) does not matter. The song is bounced as recorded,
//! without warp or transpose: time-stretching every track (Bungee) made a
//! warped song take minutes, for nothing the analysis needs. The key and the
//! guide's times are then brought to the song as it plays. Like "Nivelar
//! canciones", the session lock is held only to copy the song out, and the
//! analysis runs on a blocking thread.

use std::sync::atomic::{AtomicBool, Ordering};

use libretracks_analysis::{
    analyze_click, analyze_click_as_eighths, analyze_click_with_guide, analyze_guide, analyze_key,
    analyze_music_tempo, initial_tempo_only, propose_tempo_markers, simplify_segments,
    ClickAnalysis, ExistingTiming, GuideAnalysis, GuideTemplate, KeyAnalysis,
    ProposedSignatureMarker, ProposedTempoMarker, SongSpan, TempoProposal, TempoSegment,
};
use lt_audio_engine_v2::{RenderError, RenderOutput, RenderRequest, RenderSampleFormat};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands::render::JobError;
use crate::infra::error::DesktopError;
use crate::models::TransportSnapshot;
use crate::state::DesktopState;

pub const SONG_ANALYSIS_PROGRESS_EVENT: &str = "song-analysis-progress";

/// Runtime bounds may differ from the stored ones by float noise only.
const SAME_BOUND_SECONDS: f64 = 0.001;

static ANALYSIS_ACTIVE: AtomicBool = AtomicBool::new(false);
static ANALYSIS_CANCEL: AtomicBool = AtomicBool::new(false);

struct ActiveAnalysis;

impl ActiveAnalysis {
    fn acquire() -> Option<Self> {
        if ANALYSIS_ACTIVE
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return None;
        }
        ANALYSIS_CANCEL.store(false, Ordering::Release);
        Some(Self)
    }
}

impl Drop for ActiveAnalysis {
    fn drop(&mut self) {
        ANALYSIS_ACTIVE.store(false, Ordering::Release);
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeSongRequest {
    pub region_id: String,
    /// The click track(s), usually one.
    #[serde(default)]
    pub click_track_ids: Vec<String>,
    /// No click: the tracks the tempo is estimated from (everything but the
    /// cues). Used only when `click_track_ids` is empty; both empty means no
    /// tempo analysis.
    #[serde(default)]
    pub music_tempo_track_ids: Vec<String>,
    /// The harmonic tracks the key is read from. Empty: no key analysis.
    #[serde(default)]
    pub key_track_ids: Vec<String>,
    /// The guide (cue) track the section announcements are read from.
    /// Empty: no section analysis.
    #[serde(default)]
    pub guide_track_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TempoResult {
    #[serde(flatten)]
    pub reading: TempoReading,
    /// A click without accent read as eighths (÷2), for the review's ÷2 / ×2:
    /// nothing in the audio says which reading is right.
    pub as_eighths: Option<TempoReading>,
}

/// One reading of the click, with the tempo map at each level of detail the
/// review offers: following the click (`proposal`), simplified, or only the
/// tempo the song starts at.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TempoReading {
    pub analysis: ClickAnalysis,
    pub proposal: TempoProposal,
    pub simplified: TempoLevel,
    pub initial: TempoLevel,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TempoLevel {
    pub segments: Vec<TempoSegment>,
    pub proposal: TempoProposal,
}

impl TempoReading {
    fn new(analysis: ClickAnalysis, tempo: &TempoJob) -> Self {
        // The markers are placed in the click's own (recorded) tempo, where
        // its bars are, and then given the tempo the song plays at.
        let scale = tempo.bpm_scale;
        let existing = ExistingTiming {
            bpm: tempo.existing.bpm / scale,
            tempo_markers: tempo
                .existing
                .tempo_markers
                .iter()
                .map(|&(start, bpm)| (start, bpm / scale))
                .collect(),
            ..tempo.existing.clone()
        };
        let propose = |analysis: &ClickAnalysis| {
            as_played_proposal(
                propose_tempo_markers(analysis, tempo.span, &existing),
                scale,
            )
        };
        let level = |segments: Vec<TempoSegment>| {
            let reduced = ClickAnalysis {
                segments,
                ..analysis.clone()
            };
            TempoLevel {
                proposal: propose(&reduced),
                segments: as_played_segments(reduced.segments, scale),
            }
        };
        Self {
            proposal: propose(&analysis),
            simplified: level(simplify_segments(&analysis.segments)),
            initial: level(initial_tempo_only(&analysis.segments)),
            analysis: ClickAnalysis {
                segments: as_played_segments(analysis.segments.clone(), scale),
                ..analysis
            },
        }
    }
}

/// A tempo as the song plays it: the original one times the warp ratio,
/// rounded as the tempo editor keeps it.
fn as_played_bpm(bpm: f64, scale: f64) -> f64 {
    if scale == 1.0 {
        bpm
    } else {
        (bpm * scale * 1000.0).round() / 1000.0
    }
}

fn as_played_segments(mut segments: Vec<TempoSegment>, scale: f64) -> Vec<TempoSegment> {
    for segment in &mut segments {
        segment.bpm = as_played_bpm(segment.bpm, scale);
        segment.end_bpm = segment.end_bpm.map(|bpm| as_played_bpm(bpm, scale));
    }
    segments
}

fn as_played_proposal(mut proposal: TempoProposal, scale: f64) -> TempoProposal {
    for marker in &mut proposal.tempo_markers {
        marker.bpm = as_played_bpm(marker.bpm, scale);
    }
    proposal.current_bpm = as_played_bpm(proposal.current_bpm, scale);
    proposal
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyResult {
    /// In the song's ORIGINAL key: the transpose is already taken out, so it
    /// compares with (and is written to) `SongRegion::key`.
    pub analysis: KeyAnalysis,
    pub current_key: Option<String>,
    /// The song's transpose, for the review to show the key it sounds in.
    pub transpose_semitones: i32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuideResult {
    /// Times from `render_start_seconds` (the timeline as it plays).
    pub analysis: GuideAnalysis,
    /// Speech recognition read the announcements (otherwise only the app's
    /// voice clips labelled them).
    pub speech_recognition: bool,
}

/// Where the analysis is, for the progress bar and its caption.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AnalysisProgress {
    pub fraction: f64,
    /// `render` (bouncing the tracks), `tempo`, `key` or `guide`.
    pub stage: &'static str,
    /// Guide announcements heard so far and in all, while listening.
    pub done: Option<usize>,
    pub total: Option<usize>,
}

impl AnalysisProgress {
    fn at(fraction: f64, stage: &'static str) -> Self {
        Self {
            fraction,
            stage,
            done: None,
            total: None,
        }
    }
}

/// Share of the bar each stage ends at. Bouncing the tracks is most of the
/// work, except when speech recognition listens to the guide (~1 s an
/// announcement), which gets the last fifth.
const RENDER_END: f64 = 0.7;
const TEMPO_END: f64 = 0.74;
const KEY_END: f64 = 0.78;
const GUIDE_START: f64 = 0.8;

/// Wraps the recogniser to move the progress bar as each announcement is
/// heard.
struct ReportingTranscriber<'a> {
    inner: &'a mut dyn libretracks_analysis::Transcriber,
    on_progress: &'a mut dyn FnMut(AnalysisProgress) -> bool,
}

impl libretracks_analysis::Transcriber for ReportingTranscriber<'_> {
    fn detect_language(&mut self, speech: &[f32]) {
        self.inner.detect_language(speech);
    }

    fn transcribe(&mut self, speech: &[f32]) -> Option<String> {
        self.inner.transcribe(speech)
    }

    fn progress(&mut self, done: usize, total: usize) {
        let share = if total == 0 {
            0.0
        } else {
            done as f64 / total as f64
        };
        (self.on_progress)(AnalysisProgress {
            fraction: GUIDE_START + (1.0 - GUIDE_START) * share,
            stage: "guide",
            done: Some(done),
            total: Some(total),
        });
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeSongResult {
    pub cancelled: bool,
    pub region_id: String,
    pub region_start_seconds: f64,
    pub region_end_seconds: f64,
    /// Where the song starts as it plays: the origin of the guide's times.
    /// Equal to `region_start_seconds` without warp or varispeed.
    pub render_start_seconds: f64,
    /// Seconds as it plays per second as recorded (the tempo markers are in
    /// recorded seconds; the guide's times are already as it plays).
    pub view_scale: f64,
    pub tempo: Option<TempoResult>,
    pub key: Option<KeyResult>,
    pub guide: Option<GuideResult>,
    pub missing_files: Vec<String>,
}

impl AnalyzeSongResult {
    fn cancelled(region_id: String) -> Self {
        Self {
            cancelled: true,
            region_id,
            region_start_seconds: 0.0,
            region_end_seconds: 0.0,
            render_start_seconds: 0.0,
            view_scale: 1.0,
            tempo: None,
            key: None,
            guide: None,
            missing_files: Vec::new(),
        }
    }
}

#[tauri::command(async)]
pub fn cancel_analyze_song() {
    ANALYSIS_CANCEL.store(true, Ordering::Release);
}

struct TempoJob {
    track_ids: Vec<String>,
    /// Estimated from the music instead of read from a click.
    from_music: bool,
    span: SongSpan,
    existing: ExistingTiming,
    fallback_beats_per_bar: u32,
    /// The song's warp ratio (target ÷ original BPM), 1 without warp. The
    /// click is read as recorded; with warp its tempos play this much
    /// faster, and that is what the tempo markers say. A varispeed transpose
    /// needs nothing: the session scales a varispeed song's markers itself.
    bpm_scale: f64,
}

struct KeyJob {
    track_ids: Vec<String>,
    current_key: Option<String>,
    transpose_semitones: i32,
}

/// What the analysis needs from the session, copied out under the lock.
struct AnalysisJob {
    project_json: String,
    region_id: String,
    region_start_seconds: f64,
    /// The song's span as recorded (stored seconds): what is bounced.
    region_end_seconds: f64,
    /// Where the song starts as it plays (warp and varispeed applied, here
    /// and in the songs before).
    render_start_seconds: f64,
    /// Seconds as it plays per second as recorded: warp and varispeed play
    /// the whole song at one speed, so its times only scale.
    view_scale: f64,
    tempo: Option<TempoJob>,
    key: Option<KeyJob>,
    /// The guide track(s): the section announcements.
    guide_track_ids: Vec<String>,
}

fn prepare_job(
    song_dir: &std::path::Path,
    song: &libretracks_core::Song,
    request: &AnalyzeSongRequest,
) -> Result<AnalysisJob, String> {
    let region = song
        .regions
        .iter()
        .find(|region| region.id == request.region_id)
        .ok_or_else(|| format!("Region not found: {}", request.region_id))?;
    let mut as_recorded = song.clone();
    for other in &mut as_recorded.regions {
        other.warp_enabled = false;
        other.transpose_semitones = 0;
    }
    let (project_json, _) = crate::audio::engine::runtime_session_json(song_dir, &as_recorded)
        .map_err(|error| error.to_string())?;
    // The song as it plays, as the engine lays it out.
    let view_start = libretracks_core::warp_timeline_seconds_at(song, region.start_seconds);
    let view_end = libretracks_core::warp_timeline_seconds_at(song, region.end_seconds)
        .max(view_start + 0.001);
    let recorded_length = region.end_seconds - region.start_seconds;
    let view_scale = if recorded_length > 0.0 {
        (view_end - view_start) / recorded_length
    } else {
        1.0
    };

    let tempo_track_ids = if request.click_track_ids.is_empty() {
        &request.music_tempo_track_ids
    } else {
        &request.click_track_ids
    };
    let tempo = (!tempo_track_ids.is_empty()).then(|| {
        let signature_at_start = song
            .time_signature_markers
            .iter()
            .filter(|marker| marker.start_seconds <= region.start_seconds + SAME_BOUND_SECONDS)
            .max_by(|a, b| a.start_seconds.total_cmp(&b.start_seconds))
            .map(|marker| marker.signature.as_str())
            .unwrap_or(song.time_signature.as_str());
        TempoJob {
            track_ids: tempo_track_ids.clone(),
            from_music: request.click_track_ids.is_empty(),
            span: SongSpan {
                start_seconds: region.start_seconds,
                end_seconds: region.end_seconds,
            },
            existing: ExistingTiming {
                bpm: song.bpm,
                time_signature: song.time_signature.clone(),
                tempo_markers: song
                    .tempo_markers
                    .iter()
                    .map(|marker| (marker.start_seconds, marker.bpm))
                    .collect(),
                signature_markers: song
                    .time_signature_markers
                    .iter()
                    .map(|marker| (marker.start_seconds, marker.signature.clone()))
                    .collect(),
            },
            fallback_beats_per_bar: signature_at_start
                .split_once('/')
                .and_then(|(numerator, _)| numerator.trim().parse::<u32>().ok())
                .filter(|numerator| *numerator > 0)
                .unwrap_or(4),
            bpm_scale: libretracks_core::region_warp_ratio_in_song(region, song),
        }
    });

    // Bounced untransposed: the key found is the original one, which is what
    // the song stores (the review adds the transpose to show how it sounds).
    let key = (!request.key_track_ids.is_empty()).then(|| KeyJob {
        track_ids: request.key_track_ids.clone(),
        current_key: region.key.clone(),
        transpose_semitones: region.transpose_semitones,
    });

    if tempo.is_none() && key.is_none() && request.guide_track_ids.is_empty() {
        return Err("Nothing to analyze".to_string());
    }
    Ok(AnalysisJob {
        project_json,
        region_id: region.id.clone(),
        region_start_seconds: region.start_seconds,
        region_end_seconds: region.end_seconds,
        render_start_seconds: view_start,
        view_scale,
        tempo,
        key,
        guide_track_ids: request.guide_track_ids.clone(),
    })
}

/// The app's voice-guide clips, every language, as templates for the guide
/// analysis: `sections/<kind>[_<n>].wav`, `cues/<kind>.wav` and the count
/// clips (labelled `count`). A missing folder is skipped: with no templates
/// the announcements are still found and grouped, just not labelled.
fn load_guide_templates(voices_dir: &std::path::Path) -> Vec<GuideTemplate> {
    let mut templates = Vec::new();
    let Ok(languages) = std::fs::read_dir(voices_dir) else {
        return templates;
    };
    for language in languages.flatten() {
        for folder in ["sections", "cues", "counts"] {
            let Ok(entries) = std::fs::read_dir(language.path().join(folder)) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("wav") {
                    continue;
                }
                let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                    continue;
                };
                let label = if folder == "counts" {
                    format!("count_{stem}")
                } else {
                    stem.to_string()
                };
                if let Ok((samples, sample_rate)) = read_mono_wav(&path) {
                    templates.push(GuideTemplate {
                        label,
                        samples,
                        sample_rate,
                    });
                }
            }
        }
    }
    templates
}

/// Read a float WAV written by the offline renderer as mono samples.
fn read_mono_wav(path: &std::path::Path) -> Result<(Vec<f32>, u32), String> {
    let mut reader = hound::WavReader::open(path).map_err(|error| error.to_string())?;
    let spec = reader.spec();
    let channels = usize::from(spec.channels.max(1));
    let samples: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader
            .samples::<f32>()
            .collect::<Result<_, _>>()
            .map_err(|error| error.to_string())?,
        hound::SampleFormat::Int => {
            let scale = 1.0 / (1_i64 << (spec.bits_per_sample.max(1) - 1)) as f32;
            reader
                .samples::<i32>()
                .map(|sample| sample.map(|value| value as f32 * scale))
                .collect::<Result<_, _>>()
                .map_err(|error| error.to_string())?
        }
    };
    let mono = if channels == 1 {
        samples
    } else {
        samples
            .chunks(channels)
            .map(|frame| frame.iter().sum::<f32>() / channels as f32)
            .collect()
    };
    Ok((mono, spec.sample_rate))
}

fn run_job(
    job: &AnalysisJob,
    sample_rate: u32,
    scratch_dir: &std::path::Path,
    voices_dir: Option<&std::path::Path>,
    speech_model: Option<&std::path::Path>,
    on_progress: &mut dyn FnMut(AnalysisProgress) -> bool,
) -> Result<AnalyzeSongResult, JobError> {
    let mut result = AnalyzeSongResult {
        cancelled: false,
        region_id: job.region_id.clone(),
        region_start_seconds: job.region_start_seconds,
        region_end_seconds: job.region_end_seconds,
        render_start_seconds: job.render_start_seconds,
        view_scale: job.view_scale,
        tempo: None,
        key: None,
        guide: None,
        missing_files: Vec::new(),
    };
    if job.tempo.is_none() && job.key.is_none() && job.guide_track_ids.is_empty() {
        return Ok(result);
    }

    std::fs::create_dir_all(scratch_dir)?;
    let path_for = |what: &str| {
        scratch_dir.join(format!(
            "{what}-{}-{}.wav",
            job.region_id,
            std::process::id()
        ))
    };
    let click_path = path_for("click");
    let key_path = path_for("key");
    let guide_path = path_for("guide");
    let mut outputs = Vec::new();
    if let Some(tempo) = &job.tempo {
        outputs.push(RenderOutput {
            path: click_path.to_string_lossy().into_owned(),
            track_ids: tempo.track_ids.clone(),
            include_metronome: false,
            include_voice_guide: false,
        });
    }
    if let Some(key) = &job.key {
        outputs.push(RenderOutput {
            path: key_path.to_string_lossy().into_owned(),
            track_ids: key.track_ids.clone(),
            include_metronome: false,
            include_voice_guide: false,
        });
    }
    if !job.guide_track_ids.is_empty() {
        outputs.push(RenderOutput {
            path: guide_path.to_string_lossy().into_owned(),
            track_ids: job.guide_track_ids.clone(),
            include_metronome: false,
            include_voice_guide: false,
        });
    }
    let cleanup = || {
        let _ = std::fs::remove_file(&click_path);
        let _ = std::fs::remove_file(&key_path);
        let _ = std::fs::remove_file(&guide_path);
    };
    let engine_request = RenderRequest {
        project_json: job.project_json.clone(),
        sample_rate,
        start_seconds: job.region_start_seconds,
        end_seconds: job.region_end_seconds,
        outputs,
        format: RenderSampleFormat::Float32,
        channels: 1,
        normalize: false,
        normalize_peak_db: 0.0,
        apply_mixer: false,
        dither: false,
        measure_loudness: false,
        metronome: None,
        voice_guide: None,
    };
    // Rendering is most of the work; the analyses take a moment.
    let mut render_progress =
        |fraction: f64| on_progress(AnalysisProgress::at(RENDER_END * fraction, "render"));
    let report = match lt_audio_engine_v2::render_offline(&engine_request, &mut render_progress) {
        Ok(report) => report,
        Err(RenderError::Cancelled) => {
            cleanup();
            return Err(JobError::Cancelled);
        }
        Err(RenderError::Failed(error)) => {
            cleanup();
            return Err(JobError::Failed(error.to_string()));
        }
    };
    result.missing_files = report.missing_files;

    let read = |path: &std::path::Path| read_mono_wav(path).map_err(JobError::Failed);
    let outcome = (|| -> Result<(), JobError> {
        // A click without accent: read again once the guide says where its
        // bars start.
        let mut unaccented_click: Option<(Vec<f32>, u32)> = None;
        if let Some(tempo) = &job.tempo {
            if !on_progress(AnalysisProgress::at(RENDER_END, "tempo")) {
                return Err(JobError::Cancelled);
            }
            let (samples, rate) = read(&click_path)?;
            let analysis = if tempo.from_music {
                analyze_music_tempo(&samples, rate, tempo.fallback_beats_per_bar)
            } else {
                analyze_click(&samples, rate, tempo.fallback_beats_per_bar)
            };
            let as_eighths = (!tempo.from_music && !analysis.downbeat_known)
                .then(|| analyze_click_as_eighths(&samples, rate, tempo.fallback_beats_per_bar))
                .flatten()
                .filter(|eighths| !eighths.segments.is_empty())
                .map(|analysis| TempoReading::new(analysis, tempo));
            if !tempo.from_music && !analysis.downbeat_known && !job.guide_track_ids.is_empty() {
                unaccented_click = Some((samples, rate));
            }
            result.tempo = Some(TempoResult {
                reading: TempoReading::new(analysis, tempo),
                as_eighths,
            });
        }
        if let Some(key) = &job.key {
            if !on_progress(AnalysisProgress::at(TEMPO_END, "key")) {
                return Err(JobError::Cancelled);
            }
            let (samples, rate) = read(&key_path)?;
            result.key = Some(KeyResult {
                analysis: as_played_key(analyze_key(&samples, rate), job.view_scale),
                current_key: key.current_key.clone(),
                transpose_semitones: key.transpose_semitones,
            });
        }
        if !job.guide_track_ids.is_empty() {
            if !on_progress(AnalysisProgress::at(KEY_END, "guide")) {
                return Err(JobError::Cancelled);
            }
            let (samples, rate) = read(&guide_path)?;
            let templates = voices_dir.map(load_guide_templates).unwrap_or_default();
            let mut recogniser = speech_model.and_then(|model| {
                crate::commands::speech::WhisperTranscriber::load(
                    model,
                    Box::new(|| ANALYSIS_CANCEL.load(Ordering::Acquire)),
                )
            });
            let speech_recognition = recogniser.is_some();
            let analysis = match recogniser.as_mut() {
                Some(inner) => {
                    let mut reporting = ReportingTranscriber {
                        inner,
                        on_progress: &mut *on_progress,
                    };
                    analyze_guide(&samples, rate, &templates, Some(&mut reporting))
                }
                None => analyze_guide(&samples, rate, &templates, None),
            };
            if ANALYSIS_CANCEL.load(Ordering::Acquire) {
                return Err(JobError::Cancelled);
            }
            if let (Some(tempo), Some((click, click_rate))) = (&job.tempo, &unaccented_click) {
                let reread = |as_eighths: bool| {
                    analyze_click_with_guide(
                        click,
                        *click_rate,
                        tempo.fallback_beats_per_bar,
                        as_eighths,
                        &analysis,
                    )
                    .filter(|reading| !reading.segments.is_empty())
                    .map(|reading| TempoReading::new(reading, tempo))
                };
                if let Some(reading) = reread(false) {
                    let had_eighths = result
                        .tempo
                        .as_ref()
                        .is_some_and(|tempo| tempo.as_eighths.is_some());
                    result.tempo = Some(TempoResult {
                        reading,
                        as_eighths: if had_eighths { reread(true) } else { None },
                    });
                }
            }
            result.guide = Some(GuideResult {
                analysis: as_played_guide(analysis, job.view_scale),
                speech_recognition,
            });
        }
        Ok(())
    })();
    cleanup();
    outcome?;
    on_progress(AnalysisProgress::at(1.0, "done"));
    Ok(result)
}

/// The key sections at the times the song plays them.
fn as_played_key(mut analysis: KeyAnalysis, view_scale: f64) -> KeyAnalysis {
    for section in &mut analysis.sections {
        section.start_seconds *= view_scale;
    }
    analysis
}

/// The announcements at the times the song plays them. The click reads the
/// guide before this, in its own (recorded) time.
fn as_played_guide(mut analysis: GuideAnalysis, view_scale: f64) -> GuideAnalysis {
    for announcement in &mut analysis.announcements {
        announcement.start_seconds *= view_scale;
        announcement.end_seconds *= view_scale;
        for word in &mut announcement.count_words {
            word.start_seconds *= view_scale;
        }
    }
    for group in &mut analysis.groups {
        group.first_start_seconds *= view_scale;
        group.first_end_seconds *= view_scale;
    }
    analysis
}

#[tauri::command]
pub async fn analyze_song(
    app: AppHandle,
    request: AnalyzeSongRequest,
    state: State<'_, DesktopState>,
) -> Result<AnalyzeSongResult, String> {
    if request.click_track_ids.is_empty()
        && request.music_tempo_track_ids.is_empty()
        && request.key_track_ids.is_empty()
        && request.guide_track_ids.is_empty()
    {
        return Err("Nothing to analyze".to_string());
    }
    let Some(active) = ActiveAnalysis::acquire() else {
        return Err("An analysis is already running".to_string());
    };
    let job = {
        let session = state
            .session
            .lock()
            .map_err(|_| DesktopError::StatePoisoned.to_string())?;
        let song_dir = session
            .song_dir
            .clone()
            .ok_or_else(|| "No song loaded".to_string())?;
        let song = session
            .engine
            .song()
            .cloned()
            .ok_or_else(|| "No song loaded".to_string())?;
        drop(session);
        prepare_job(&song_dir, &song, &request)?
    };
    // The engine's rate, not a lower one: at this rate the render reads the
    // PCM cache playback already decoded. At 22.05 kHz it decoded and
    // resampled every MP3 again (0.65 s a track on a desktop, ~30 s a track
    // through Android's MediaCodec).
    let engine_rate = state.audio.current_sample_rate_capabilities().0;
    let sample_rate = if engine_rate > 0 { engine_rate } else { 48_000 };
    let scratch_dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join("song-analysis");
    let voices_dir = crate::commands::settings::voice_guide_voices_dir(&app);
    let speech_model = crate::commands::speech::ready_model(&app);

    tauri::async_runtime::spawn_blocking(move || {
        let _active = active;
        let mut on_progress = |progress: AnalysisProgress| {
            let _ = app.emit(
                SONG_ANALYSIS_PROGRESS_EVENT,
                AnalysisProgress {
                    fraction: progress.fraction.clamp(0.0, 1.0),
                    ..progress
                },
            );
            !ANALYSIS_CANCEL.load(Ordering::Acquire)
        };
        let voices = voices_dir.as_deref().map(std::path::Path::new);
        match run_job(
            &job,
            sample_rate,
            &scratch_dir,
            voices,
            speech_model.as_deref(),
            &mut on_progress,
        ) {
            Ok(result) => Ok(result),
            Err(JobError::Cancelled) => Ok(AnalyzeSongResult::cancelled(job.region_id.clone())),
            Err(JobError::Failed(error)) => Err(error),
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

/// A section marker to write inside the song (from the guide), in the
/// rendered timeline's seconds.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SectionChange {
    pub start_seconds: f64,
    pub kind: libretracks_core::MarkerKind,
    #[serde(default)]
    pub variant: Option<u8>,
    /// The localized name, like the marker menus give it.
    pub name: String,
    /// `Cue` for a section kind on a spot that already has a section ("Verso
    /// a capella": verse is the section, a capella goes in the cue lane).
    #[serde(default)]
    pub category_override: Option<libretracks_core::MarkerCategory>,
}

/// The tempo and meter markers to write inside the song.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TempoChange {
    pub tempo_markers: Vec<ProposedTempoMarker>,
    pub signature_markers: Vec<ProposedSignatureMarker>,
}

/// Apply what the user ticked in the review, as ONE undo step: the tempo map
/// (when `tempo` is given), the key (when `key` is given), the key changes
/// (when `key_changes` is given, in view seconds) and the section markers
/// (when `sections` is given: they replace the song's own).
#[tauri::command(async)]
pub fn apply_song_analysis(
    region_id: String,
    tempo: Option<TempoChange>,
    key: Option<String>,
    key_changes: Option<Vec<crate::state::KeyChangeInput>>,
    sections: Option<Vec<SectionChange>>,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;
    let tempo = tempo.as_ref().map(|change| {
        (
            change.tempo_markers.as_slice(),
            change.signature_markers.as_slice(),
        )
    });
    let sections = sections.map(|list| {
        list.into_iter()
            .map(|section| crate::state::AnalysedSection {
                start_seconds: section.start_seconds,
                kind: section.kind,
                variant: section.variant,
                name: section.name,
                category_override: section.category_override,
            })
            .collect::<Vec<_>>()
    });
    session
        .apply_song_analysis(
            &region_id,
            tempo,
            key,
            key_changes,
            sections.as_deref(),
            &state.audio,
        )
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use libretracks_core::{Song, SongMaster, SongRegion, TimeSignatureMarker, Track, TrackKind};

    fn region(id: &str, start: f64, end: f64) -> SongRegion {
        SongRegion {
            key_changes: Vec::new(),
            id: id.into(),
            name: id.into(),
            start_seconds: start,
            end_seconds: end,
            transpose_semitones: 0,
            key: None,
            warp_enabled: false,
            warp_source_bpm: None,
            master: SongMaster::default(),
            compact_column_width_rem: None,
            chart: None,
            cover_image: None,
            voice_guide_count_style: None,
            structure: None,
        }
    }

    fn track(id: &str, transpose_enabled: bool) -> Track {
        Track {
            id: id.into(),
            name: id.into(),
            kind: TrackKind::Audio,
            parent_track_id: None,
            volume: 1.0,
            pan: 0.0,
            muted: false,
            solo: false,
            transpose_enabled,
            audio_to: "master".into(),
            mono_downmix: false,
            color: None,
            auto_created: false,
            midi_port: None,
            midi_channel: 1,
            midi_enabled: true,
            collapsed: false,
            height_offset: None,
            match_aliases: Vec::new(),
            song_region_id: None,
        }
    }

    fn song() -> Song {
        Song {
            id: "s".into(),
            title: "s".into(),
            artist: None,
            key: None,
            bpm: 120.0,
            time_signature: "4/4".into(),
            duration_seconds: 200.0,
            tempo_markers: vec![],
            time_signature_markers: vec![TimeSignatureMarker {
                id: "sig".into(),
                start_seconds: 50.0,
                signature: "6/8".into(),
            }],
            // Out of order on purpose: the next song is found by position.
            regions: vec![
                region("c", 150.0, 200.0),
                region("a", 0.0, 60.0),
                region("b", 64.0, 140.0),
            ],
            tracks: vec![
                track("keys", true),
                track("pad", true),
                track("drums", false),
            ],
            clips: vec![],
            midi_clips: vec![],
            video_clips: vec![],
            section_markers: vec![],
        }
    }

    fn request(region_id: &str) -> AnalyzeSongRequest {
        AnalyzeSongRequest {
            region_id: region_id.into(),
            click_track_ids: vec!["click".into()],
            music_tempo_track_ids: vec![],
            key_track_ids: vec!["keys".into(), "pad".into()],
            guide_track_ids: vec![],
        }
    }

    #[test]
    fn job_knows_the_song_span_and_the_meter_in_force() {
        let dir = tempfile::tempdir().expect("dir");
        let job = prepare_job(dir.path(), &song(), &request("b")).expect("job");
        let tempo = job.tempo.expect("tempo job");
        assert_eq!(tempo.span.start_seconds, 64.0);
        assert_eq!(tempo.span.end_seconds, 140.0);
        assert_eq!(tempo.fallback_beats_per_bar, 6);
    }

    #[test]
    fn a_warped_song_gets_its_tempo_as_it_plays() {
        // Recorded at 100, warped to the session's 120: the click is read as
        // recorded, its bars placed in recorded seconds, and its tempos
        // played 1.2 times as fast.
        let dir = tempfile::tempdir().expect("dir");
        let mut warped = song();
        warped.regions[2].warp_enabled = true;
        warped.regions[2].warp_source_bpm = Some(100.0);
        let job = prepare_job(dir.path(), &warped, &request("b")).expect("job");
        let tempo = job.tempo.expect("tempo job");
        assert!((tempo.bpm_scale - 1.2).abs() < 1e-9);

        let segment = |start_seconds: f64, bpm: f64| TempoSegment {
            start_seconds,
            bpm,
            beats_per_bar: 4,
            beat_unit: 4,
            bars: 8,
            end_bpm: None,
        };
        // 8 bars of 100 (19.2 s as recorded), then 80.
        let reading = TempoReading::new(
            ClickAnalysis {
                segments: vec![segment(0.0, 100.0), segment(19.2, 80.0)],
                warnings: Vec::new(),
                beat_count: 0,
                downbeat_known: true,
            },
            &tempo,
        );
        let markers: Vec<(f64, f64)> = reading
            .proposal
            .tempo_markers
            .iter()
            .map(|marker| (marker.start_seconds, marker.bpm))
            .collect();
        // At the start, the tempo the song already plays at: the warp stays.
        assert_eq!(markers.len(), 2, "{:?}", reading.proposal);
        assert_eq!(markers[0], (64.0, 120.0));
        assert!((markers[1].0 - 83.2).abs() < 1e-6, "{markers:?}");
        assert!((markers[1].1 - 96.0).abs() < 1e-9, "{markers:?}");
        assert_eq!(reading.analysis.segments[1].bpm, 96.0);
    }

    #[test]
    fn the_song_is_bounced_as_recorded() {
        // Bungee on every track took minutes for a warped song ("Es Él",
        // warp 70 → 70, transpose -1): the bounce has no warp or transpose,
        // here or in any other song.
        let dir = tempfile::tempdir().expect("dir");
        let mut song = song();
        song.regions[1].transpose_semitones = 3;
        song.regions[2].transpose_semitones = -1;
        song.regions[2].warp_enabled = true;
        song.regions[2].warp_source_bpm = Some(120.0);
        let job = prepare_job(dir.path(), &song, &request("b")).expect("job");
        let bounced: Song = serde_json::from_str(&job.project_json).expect("session");
        assert!(bounced
            .regions
            .iter()
            .all(|region| !region.warp_enabled && region.transpose_semitones == 0));
        assert_eq!(
            (job.region_start_seconds, job.region_end_seconds),
            (64.0, 140.0)
        );
    }

    #[test]
    fn the_key_is_read_back_in_the_song_s_original_key() {
        // Bounced untransposed, the key found is the original one; the
        // transpose only goes to the review.
        let dir = tempfile::tempdir().expect("dir");
        let mut transposed = song();
        transposed.regions[2].transpose_semitones = 2;
        let job = prepare_job(dir.path(), &transposed, &request("b")).expect("job");
        let bounced: Song = serde_json::from_str(&job.project_json).expect("session");
        assert_eq!(bounced.regions[2].transpose_semitones, 0);
        assert_eq!(job.key.expect("key job").transpose_semitones, 2);
    }

    #[test]
    fn the_guide_is_read_at_the_times_the_song_plays_them() {
        // Warped 120 → 100 BPM: the song plays 1.2 times as long, and the
        // varispeed of the song before (+12, twice as fast) moves its start.
        let dir = tempfile::tempdir().expect("dir");
        let mut song = song();
        song.regions[1].transpose_semitones = 12;
        song.bpm = 100.0;
        song.regions[2].warp_enabled = true;
        song.regions[2].warp_source_bpm = Some(120.0);
        let job = prepare_job(dir.path(), &song, &request("b")).expect("job");
        assert!((job.render_start_seconds - 34.0).abs() < 1e-9);
        assert!((job.view_scale - 1.2).abs() < 1e-9);

        let analysis = GuideAnalysis {
            announcements: vec![libretracks_analysis::GuideAnnouncement {
                start_seconds: 10.0,
                end_seconds: 11.0,
                group: 0,
                count_words: vec![libretracks_analysis::CountWord {
                    number: 1,
                    start_seconds: 10.5,
                }],
            }],
            groups: vec![libretracks_analysis::GuideGroup {
                labels: vec!["chorus".into()],
                transcript: None,
                match_cost: None,
                counted_in: false,
                occurrences: 1,
                first_start_seconds: 10.0,
                first_end_seconds: 11.0,
            }],
        };
        let played = as_played_guide(analysis, job.view_scale);
        let announcement = &played.announcements[0];
        assert!((announcement.start_seconds - 12.0).abs() < 1e-9);
        assert!((announcement.end_seconds - 13.2).abs() < 1e-9);
        assert!((announcement.count_words[0].start_seconds - 12.6).abs() < 1e-9);
        assert!((played.groups[0].first_start_seconds - 12.0).abs() < 1e-9);
    }

    /// The analysis of every song of a real session, as `run_job` does it
    /// (click, its ÷2 reading, the guide with speech recognition, the click
    /// read again with the guide), to check a change on real multitracks.
    /// The click and guide of song n (region order) are WAVs decoded
    /// beforehand as `<audio>/<n>_click.wav` and `<n>_guide.wav`; each
    /// song's result goes to `<audio>/<n>_result.json`, which
    /// `realSessionHarness.test.ts` puts through the review's placement:
    ///
    /// ```text
    /// LT_AN_SESSION=<file.ltsession> LT_AN_AUDIO=<dir> LT_AN_MODEL=<ggml-base-q5_1.bin>
    ///   [LT_AN_ONLY=<n>] [LT_AN_SKIP=<n,n,...>] cargo test --release --lib -p libretracks-desktop
    ///   --features libretracks-desktop/no-link dump_real_session_analysis -- --ignored
    /// ```
    #[test]
    #[ignore]
    fn dump_real_session_analysis() {
        let (Ok(session), Ok(audio), Ok(model)) = (
            std::env::var("LT_AN_SESSION"),
            std::env::var("LT_AN_AUDIO"),
            std::env::var("LT_AN_MODEL"),
        ) else {
            return;
        };
        let only: Option<usize> = std::env::var("LT_AN_ONLY")
            .ok()
            .and_then(|v| v.parse().ok());
        let skip: Vec<usize> = std::env::var("LT_AN_SKIP")
            .unwrap_or_default()
            .split(',')
            .filter(|value| !value.is_empty())
            .map(|value| {
                value
                    .parse()
                    .expect("LT_AN_SKIP must contain region indices")
            })
            .collect();
        let session = std::path::PathBuf::from(session);
        let audio = std::path::PathBuf::from(audio);
        let song = libretracks_project::load_song_from_file(&session).expect("session loads");
        let voices = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/voices");
        let templates = load_guide_templates(&voices);
        for (index, region) in song.regions.iter().enumerate() {
            if only.is_some_and(|only| only != index) || skip.contains(&index) {
                continue;
            }
            let click_path = audio.join(format!("{index}_click.wav"));
            let guide_path = audio.join(format!("{index}_guide.wav"));
            let request = AnalyzeSongRequest {
                region_id: region.id.clone(),
                click_track_ids: vec!["click".into()],
                music_tempo_track_ids: vec![],
                key_track_ids: vec![],
                guide_track_ids: vec!["guide".into()],
            };
            let song_dir = session.parent().expect("session folder");
            let job = prepare_job(song_dir, &song, &request).expect("job");
            let tempo = job.tempo.as_ref().unwrap();
            let (samples, rate) = read_mono_wav(&click_path).unwrap();
            let analysis = analyze_click(&samples, rate, tempo.fallback_beats_per_bar);
            let downbeat_known = analysis.downbeat_known;
            let as_eighths = (!downbeat_known)
                .then(|| analyze_click_as_eighths(&samples, rate, tempo.fallback_beats_per_bar))
                .flatten()
                .filter(|e| !e.segments.is_empty())
                .map(|a| TempoReading::new(a, tempo));
            let mut tempo_result = TempoResult {
                reading: TempoReading::new(analysis, tempo),
                as_eighths,
            };
            let (guide_samples, guide_rate) = read_mono_wav(&guide_path).unwrap();
            let mut whisper = crate::commands::speech::WhisperTranscriber::load(
                std::path::Path::new(&model),
                Box::new(|| false),
            )
            .expect("model");
            let guide = analyze_guide(&guide_samples, guide_rate, &templates, Some(&mut whisper));
            if !downbeat_known {
                let reread = |as_eighths: bool| {
                    analyze_click_with_guide(
                        &samples,
                        rate,
                        tempo.fallback_beats_per_bar,
                        as_eighths,
                        &guide,
                    )
                    .filter(|r| !r.segments.is_empty())
                    .map(|r| TempoReading::new(r, tempo))
                };
                if let Some(reading) = reread(false) {
                    let had = tempo_result.as_eighths.is_some();
                    tempo_result = TempoResult {
                        reading,
                        as_eighths: if had { reread(true) } else { None },
                    };
                }
            }
            let result = AnalyzeSongResult {
                cancelled: false,
                region_id: region.id.clone(),
                region_start_seconds: region.start_seconds,
                region_end_seconds: region.end_seconds,
                render_start_seconds: job.render_start_seconds,
                view_scale: job.view_scale,
                tempo: Some(tempo_result),
                key: None,
                guide: Some(GuideResult {
                    analysis: guide,
                    speech_recognition: true,
                }),
                missing_files: vec![],
            };
            let out = audio.join(format!("{index}_result.json"));
            std::fs::write(&out, serde_json::to_vec_pretty(&result).unwrap()).unwrap();
            println!("{index} {} -> {}", region.name, out.display());
        }
    }

    #[test]
    fn without_a_click_the_tempo_comes_from_the_music() {
        let dir = tempfile::tempdir().expect("dir");
        let no_click = AnalyzeSongRequest {
            click_track_ids: vec![],
            music_tempo_track_ids: vec!["keys".into(), "drums".into()],
            ..request("b")
        };
        let tempo = prepare_job(dir.path(), &song(), &no_click)
            .expect("job")
            .tempo
            .expect("tempo job");
        assert!(tempo.from_music);
        assert_eq!(
            tempo.track_ids,
            vec!["keys".to_string(), "drums".to_string()]
        );

        // A chosen click wins over the music.
        let both = AnalyzeSongRequest {
            music_tempo_track_ids: vec!["keys".into()],
            ..request("b")
        };
        let tempo = prepare_job(dir.path(), &song(), &both)
            .expect("job")
            .tempo
            .expect("tempo");
        assert!(!tempo.from_music);
        assert_eq!(tempo.track_ids, vec!["click".to_string()]);
    }
}
