//! "Render audio" of a song: bounce the chosen tracks of one region to WAV.
//!
//! The musician's use case: send the band a rehearsal track with their own
//! instrument taken out — the drummer gets everything but the drums. So the
//! user picks tracks, not a mix preset, and mute/solo do not matter (see
//! `native/audio-engine-v2/include/lt_engine/render/offline_renderer.h`).
//!
//! The render itself is the engine's offline renderer, which builds its own
//! session from the LoadSession payload: playback keeps running, and nothing
//! here takes the engine lock. The project session lock is held only to copy
//! the song out.
//!
//! Output:
//! - a mix is one `.wav`;
//! - stems are several `.wav`s delivered as ONE `.zip`: Android's SAF has no
//!   folder picker, and a single file is also what a musician can send.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use lt_audio_engine_v2::{
    RenderError, RenderOutput, RenderPans, RenderRequest, RenderSampleFormat, RenderVoiceGuide,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands::project::pick_export_target_async;
use crate::commands::project::ExportTarget;
use crate::infra::error::DesktopError;
use crate::infra::settings::AppSettingsStore;
use crate::state::DesktopState;

pub const RENDER_PROGRESS_EVENT: &str = "render-audio-progress";

/// One render at a time: two would double RAM and CPU for no benefit, and
/// the cancel flag below is global.
static RENDER_ACTIVE: AtomicBool = AtomicBool::new(false);
static RENDER_CANCEL: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RenderMode {
    /// Every chosen track summed into one file.
    Mix,
    /// One file per chosen track, zipped.
    Stems,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum RenderScope {
    #[default]
    Song,
    Session,
    Songs,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderSongAudioRequest {
    pub region_id: String,
    #[serde(default)]
    pub scope: RenderScope,
    pub track_ids: Vec<String>,
    pub mode: RenderMode,
    pub format: RenderSampleFormat,
    /// `None` = the rate the engine is running at.
    #[serde(default)]
    pub sample_rate: Option<u32>,
    pub channels: u32,
    pub normalize: bool,
    pub apply_mixer: bool,
    #[serde(default)]
    pub include_metronome: bool,
    #[serde(default)]
    pub include_voice_guide: bool,
    #[serde(default)]
    pub tracks_pan: f32,
    #[serde(default)]
    pub metronome_pan: f32,
    #[serde(default)]
    pub voice_guide_pan: f32,
    /// File name without extension, already localised by the UI.
    pub file_name: String,
    /// Stem names for the click and the guide, localised by the UI.
    #[serde(default = "default_metronome_label")]
    pub metronome_label: String,
    #[serde(default = "default_voice_guide_label")]
    pub voice_guide_label: String,
}

fn default_metronome_label() -> String {
    "Metrónomo".to_string()
}

fn default_voice_guide_label() -> String {
    "Voz guía".to_string()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderSongAudioResult {
    /// false when the user cancelled the save dialog or the render.
    pub saved: bool,
    pub cancelled: bool,
    pub file_name: Option<String>,
    pub file_count: u32,
    /// Audio files that could not be read and went out as silence.
    pub missing_files: Vec<String>,
}

impl RenderSongAudioResult {
    fn not_saved(cancelled: bool) -> Self {
        Self {
            saved: false,
            cancelled,
            file_name: None,
            file_count: 0,
            missing_files: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RenderProgressPayload {
    fraction: f64,
    /// "rendering" while the engine works, "packing" while stems are zipped.
    stage: &'static str,
}

/// Released on drop so an early return or a panic never leaves renders locked.
struct ActiveRender;

impl ActiveRender {
    fn acquire() -> Option<Self> {
        RENDER_ACTIVE
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()?;
        RENDER_CANCEL.store(false, Ordering::Release);
        Some(Self)
    }
}

impl Drop for ActiveRender {
    fn drop(&mut self) {
        RENDER_ACTIVE.store(false, Ordering::Release);
    }
}

/// A file name the user will see: keeps accents and spaces (it is not a
/// slug), drops only what filesystems reject.
pub(crate) fn sanitize_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '-',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_end_matches(['.', ' ']).trim();
    if trimmed.is_empty() {
        "audio".to_string()
    } else {
        trimmed.chars().take(120).collect()
    }
}

/// Stem file names inside the zip: numbered in track order so they sort like
/// the session, and unique even when two tracks share a name.
fn stem_file_names(names: &[String]) -> Vec<String> {
    let width = names.len().max(1).to_string().len().max(2);
    names
        .iter()
        .enumerate()
        .map(|(index, name)| {
            format!(
                "{:0width$} {}.wav",
                index + 1,
                sanitize_file_name(name),
                width = width
            )
        })
        .collect()
}

/// Cancel the render in progress, if any. Partial files are deleted.
#[tauri::command(async)]
pub fn cancel_render_song_audio() {
    RENDER_CANCEL.store(true, Ordering::Release);
}

/// Render a song's chosen tracks. Asks where to save first, then renders on a
/// worker thread, emitting `render-audio-progress` as it goes.
#[tauri::command]
pub async fn render_song_audio(
    app: AppHandle,
    request: RenderSongAudioRequest,
    state: State<'_, DesktopState>,
    settings_store: State<'_, AppSettingsStore>,
) -> Result<RenderSongAudioResult, String> {
    if request.track_ids.is_empty() && !request.include_metronome && !request.include_voice_guide {
        return Err("Selecciona al menos una pista".to_string());
    }
    if request.channels != 1 && request.channels != 2 {
        return Err("channels must be 1 or 2".to_string());
    }
    let Some(active) = ActiveRender::acquire() else {
        return Err("Ya hay un renderizado en curso".to_string());
    };

    // Copy the song out under a brief lock; everything after runs unlocked.
    let (song_dir, song) = {
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
        (song_dir, song)
    };
    if request.scope == RenderScope::Song && !song
        .regions
        .iter()
        .any(|region| region.id == request.region_id)
    {
        return Err("Region not found".to_string());
    }
    if request.scope == RenderScope::Songs && song.regions.is_empty() {
        return Err("No songs to render".to_string());
    }
    if [request.tracks_pan, request.metronome_pan, request.voice_guide_pan]
        .iter().any(|pan| !pan.is_finite() || !(-1.0..=1.0).contains(pan)) {
        return Err("Invalid pan".to_string());
    }

    let base_name = sanitize_file_name(&request.file_name);
    let (extension, filter) = if request.mode == RenderMode::Stems || request.scope == RenderScope::Songs {
        ("zip", "Zip")
    } else {
        ("wav", "Wave Audio")
    };
    let suggested = format!("{base_name}.{extension}");
    let Some(target) = pick_render_target(&app, &suggested, filter, extension).await? else {
        return Ok(RenderSongAudioResult::not_saved(false));
    };

    let settings = settings_store
        .current()
        .map_err(|error| error.to_string())?;
    let engine_rate = state.audio.current_sample_rate_capabilities().0;
    let voices_dir = if request.include_voice_guide {
        crate::commands::settings::voice_guide_voices_dir(&app)
    } else {
        None
    };
    let staging_root = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join("render-staging");

    let worker_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _active = active;
        let emit_app = worker_app.clone();
        let emit = move |fraction: f64, stage: &'static str| {
            let _ = emit_app.emit(
                RENDER_PROGRESS_EVENT,
                RenderProgressPayload {
                    fraction: fraction.clamp(0.0, 1.0),
                    stage,
                },
            );
        };
        let job = RenderJob {
            emit: &emit,
            request: &request,
            song_dir: &song_dir,
            song: &song,
            settings: &settings,
            engine_rate,
            voices_dir,
            staging_root: &staging_root,
        };
        let outcome = job.run(target.write_path());
        match outcome {
            Ok(mut done) => {
                target.finish(&worker_app)?;
                done.file_name = Some(target.display_name().unwrap_or(suggested));
                Ok(done)
            }
            Err(JobError::Cancelled) => {
                discard_target(&target);
                Ok(RenderSongAudioResult::not_saved(true))
            }
            Err(JobError::Failed(error)) => {
                discard_target(&target);
                Err(error)
            }
        }
    })
    .await
    .map_err(|error| error.to_string())?;
    result
}

/// Remove whatever a failed or cancelled render left at the write path.
fn discard_target(target: &ExportTarget) {
    let _ = std::fs::remove_file(target.write_path());
}

#[derive(Debug)]
pub(crate) enum JobError {
    Cancelled,
    Failed(String),
}

impl From<std::io::Error> for JobError {
    fn from(error: std::io::Error) -> Self {
        JobError::Failed(error.to_string())
    }
}

struct RenderJob<'a> {
    /// Progress sink: the Tauri event in the app, a no-op in tests.
    emit: &'a dyn Fn(f64, &'static str),
    request: &'a RenderSongAudioRequest,
    song_dir: &'a Path,
    song: &'a libretracks_core::Song,
    settings: &'a crate::infra::settings::AppSettings,
    engine_rate: u32,
    voices_dir: Option<String>,
    staging_root: &'a Path,
}

impl RenderJob<'_> {
    fn run(&self, write_path: &Path) -> Result<RenderSongAudioResult, JobError> {
        self.run_with_renderer(write_path, lt_audio_engine_v2::render_offline)
    }

    fn run_with_renderer(
        &self,
        write_path: &Path,
        mut render: impl FnMut(&RenderRequest, &mut dyn FnMut(f64) -> bool) -> Result<lt_audio_engine_v2::RenderReport, RenderError>,
    ) -> Result<RenderSongAudioResult, JobError> {
        let stems = self.request.mode == RenderMode::Stems || self.request.scope == RenderScope::Songs;
        let stem_dir = self.staging_root.join(format!(
            "render-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        ));
        // The destination is chosen: say so now, before the first file is
        // opened, so the modal leaves "choose where to save" at once.
        self.emit_progress(0.0, "rendering");
        if stems {
            std::fs::create_dir_all(&stem_dir)?;
        }
        let render_share = if stems { 0.95 } else { 1.0 };
        let mut regions: Vec<_> = self.song.regions.iter().collect();
        regions.sort_by(|left, right| left.start_seconds.total_cmp(&right.start_seconds));
        let jobs: Vec<Option<&libretracks_core::SongRegion>> = if self.request.scope == RenderScope::Songs {
            regions.into_iter().map(Some).collect()
        } else {
            vec![None]
        };
        let mut last_emit = Instant::now() - Duration::from_secs(1);
        let mut files = Vec::new();
        let mut missing_files = Vec::new();
        for (index, region) in jobs.iter().enumerate() {
            let result = (|| {
                let mut engine_request = self.engine_request_for_region(write_path, &stem_dir, region.map(|item| item.id.as_str()))?;
                if let Some(region) = region {
                    let prefix = format!("{:02} {}", index + 1, sanitize_file_name(&region.name));
                    for output in &mut engine_request.outputs {
                        let name = if self.request.mode == RenderMode::Mix {
                            format!("{prefix}.wav")
                        } else {
                            let name = Path::new(&output.path).file_name().unwrap_or_default().to_string_lossy();
                            format!("{prefix} - {name}")
                        };
                        output.path = path_string(&stem_dir.join(name));
                    }
                }
                let mut on_progress = |fraction: f64| {
                    if last_emit.elapsed() >= Duration::from_millis(100) {
                        last_emit = Instant::now();
                        self.emit_progress((index as f64 + fraction) / jobs.len() as f64 * render_share, "rendering");
                    }
                    !RENDER_CANCEL.load(Ordering::Acquire)
                };
                render(&engine_request, &mut on_progress).map_err(|error| match error {
                    RenderError::Cancelled => JobError::Cancelled,
                    RenderError::Failed(error) => JobError::Failed(error.to_string()),
                })
            })();
            match result {
                Ok(report) => {
                    files.extend(report.files);
                    for path in report.missing_files {
                        if !missing_files.contains(&path) { missing_files.push(path); }
                    }
                }
                Err(error) => {
                    let _ = std::fs::remove_dir_all(&stem_dir);
                    return Err(error);
                }
            }
        }

        if stems {
            self.emit_progress(render_share, "packing");
            let zipped = zip_stems(&files, write_path);
            let _ = std::fs::remove_dir_all(&stem_dir);
            zipped?;
        }
        self.emit_progress(1.0, "done");

        Ok(RenderSongAudioResult {
            saved: true,
            cancelled: false,
            file_name: None,
            file_count: files.len() as u32,
            missing_files,
        })
    }

    /// What the engine is asked for: the LoadSession payload, the song's
    /// runtime bounds and one output per file. A mix writes straight to
    /// `write_path`; stems go to `stem_dir` to be zipped afterwards.
    #[cfg(test)]
    fn engine_request(&self, write_path: &Path, stem_dir: &Path) -> Result<RenderRequest, JobError> {
        self.engine_request_for_region(write_path, stem_dir, None)
    }

    fn engine_request_for_region(&self, write_path: &Path, stem_dir: &Path, region_id: Option<&str>) -> Result<RenderRequest, JobError> {
        let (project_json, (start_seconds, end_seconds)) = if let Some(region_id) = region_id {
            render_range(self.song_dir, self.song, region_id)?
        } else if self.request.scope == RenderScope::Session {
            let (json, runtime_song) = crate::audio::engine::runtime_session_json(self.song_dir, self.song)
                .map_err(|error| JobError::Failed(error.to_string()))?;
            (json, (0.0, runtime_song.duration_seconds))
        } else {
            render_range(self.song_dir, self.song, &self.request.region_id)?
        };

        let request = self.request;
        let sample_rate =
            request
                .sample_rate
                .filter(|rate| *rate > 0)
                .unwrap_or(if self.engine_rate > 0 {
                    self.engine_rate
                } else {
                    48_000
                });

        // Track order as in the session, whatever order the UI sent.
        let chosen: Vec<&libretracks_core::Track> = self
            .song
            .tracks
            .iter()
            .filter(|track| request.track_ids.iter().any(|id| id == &track.id))
            .collect();

        let stems = request.mode == RenderMode::Stems;
        let mut outputs = Vec::new();
        if stems {
            let mut names: Vec<String> = chosen.iter().map(|track| track.name.clone()).collect();
            if request.include_metronome {
                names.push(request.metronome_label.clone());
            }
            if request.include_voice_guide {
                names.push(request.voice_guide_label.clone());
            }
            let file_names = stem_file_names(&names);
            for (index, track) in chosen.iter().enumerate() {
                outputs.push(RenderOutput {
                    path: path_string(&stem_dir.join(&file_names[index])),
                    track_ids: vec![track.id.clone()],
                    include_metronome: false,
                    include_voice_guide: false,
                });
            }
            let mut next = chosen.len();
            if request.include_metronome {
                outputs.push(RenderOutput {
                    path: path_string(&stem_dir.join(&file_names[next])),
                    track_ids: Vec::new(),
                    include_metronome: true,
                    include_voice_guide: false,
                });
                next += 1;
            }
            if request.include_voice_guide {
                outputs.push(RenderOutput {
                    path: path_string(&stem_dir.join(&file_names[next])),
                    track_ids: Vec::new(),
                    include_metronome: false,
                    include_voice_guide: true,
                });
            }
        } else {
            outputs.push(RenderOutput {
                path: path_string(write_path),
                track_ids: chosen.iter().map(|track| track.id.clone()).collect(),
                include_metronome: request.include_metronome,
                include_voice_guide: request.include_voice_guide,
            });
        }

        let voice_guide = match (&self.voices_dir, request.include_voice_guide) {
            (Some(dir), true) => Some(RenderVoiceGuide {
                volume: self.settings.voice_guide_volume as f32,
                lead_bars: self.settings.voice_guide_lead_bars,
                count_in_enabled: self.settings.voice_guide_count_in_enabled,
                count_style: self.settings.voice_guide_count_style.as_engine_value(),
                voices_dir: dir.clone(),
                lang: self.settings.voice_guide_language.clone(),
            }),
            _ => None,
        };
        let engine_request = RenderRequest {
            project_json,
            sample_rate,
            start_seconds,
            end_seconds,
            outputs,
            format: request.format,
            channels: request.channels,
            normalize: request.normalize,
            normalize_peak_db: -0.3,
            apply_mixer: request.apply_mixer,
            dither: true,
            measure_loudness: false,
            pans: Some(RenderPans {
                tracks: if request.channels == 2 { request.tracks_pan } else { 0.0 },
                metronome: if request.channels == 2 { request.metronome_pan } else { 0.0 },
                voice_guide: if request.channels == 2 { request.voice_guide_pan } else { 0.0 },
            }),
            metronome: request
                .include_metronome
                .then(|| crate::audio::engine::metronome_render_config(self.settings)),
            voice_guide,
        };
        Ok(engine_request)
    }

    fn emit_progress(&self, fraction: f64, stage: &'static str) {
        (self.emit)(fraction, stage);
    }
}

/// The LoadSession payload and the bounds the engine renders for a song: the
/// RUNTIME region, not the saved one — a varispeed transpose stretches the
/// timeline and moves the song's bounds with it. An arranged song renders as
/// the linear timeline the arrangement wrote, so its length is the sum of its
/// blocks.
pub(crate) fn render_range(
    song_dir: &Path,
    song: &libretracks_core::Song,
    region_id: &str,
) -> Result<(String, (f64, f64)), JobError> {
    let (project_json, runtime_song) = crate::audio::engine::runtime_session_json(song_dir, song)
        .map_err(|error| JobError::Failed(error.to_string()))?;
    let region = runtime_song
        .regions
        .iter()
        .find(|region| region.id == region_id)
        .ok_or_else(|| JobError::Failed("Region not found".to_string()))?;
    Ok((project_json, (region.start_seconds, region.end_seconds)))
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// Pack the stems uncompressed: WAV barely deflates, and Stored keeps the
/// packing step a plain copy on a phone.
fn zip_stems(files: &[lt_audio_engine_v2::RenderedFile], zip_path: &Path) -> Result<(), JobError> {
    use zip::write::SimpleFileOptions;
    if RENDER_CANCEL.load(Ordering::Acquire) {
        return Err(JobError::Cancelled);
    }
    let out = std::fs::File::create(zip_path)?;
    let mut writer = zip::ZipWriter::new(std::io::BufWriter::new(out));
    let options = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored)
        .large_file(true);
    for file in files {
        let path = PathBuf::from(&file.path);
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "stem.wav".to_string());
        writer
            .start_file(name, options)
            .map_err(|error| JobError::Failed(error.to_string()))?;
        let mut input = std::fs::File::open(&path)?;
        std::io::copy(&mut input, &mut writer)?;
        if RENDER_CANCEL.load(Ordering::Acquire) {
            return Err(JobError::Cancelled);
        }
    }
    writer
        .finish()
        .map_err(|error| JobError::Failed(error.to_string()))?;
    Ok(())
}

/// Where to save: the same destination picker as the other exports (a folder
/// on iOS, the save dialog elsewhere).
async fn pick_render_target(
    app: &AppHandle,
    suggested: &str,
    filter: &str,
    extension: &str,
) -> Result<Option<ExportTarget>, String> {
    pick_export_target_async(app, "Renderizar audio", filter, &[extension], suggested).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_names_keep_accents_and_drop_forbidden_characters() {
        assert_eq!(
            sanitize_file_name("Canción (sin batería)"),
            "Canción (sin batería)"
        );
        assert_eq!(sanitize_file_name("AC/DC: Live?"), "AC-DC- Live-");
        assert_eq!(sanitize_file_name("  ...  "), "audio");
        assert_eq!(sanitize_file_name("end."), "end");
    }

    #[test]
    fn stem_names_are_numbered_and_unique() {
        let names = vec![
            "Bass".to_string(),
            "Bass".to_string(),
            "Keys/Pad".to_string(),
        ];
        assert_eq!(
            stem_file_names(&names),
            vec!["01 Bass.wav", "02 Bass.wav", "03 Keys-Pad.wav"]
        );
    }

    #[test]
    fn request_uses_the_ui_field_names() {
        let request: RenderSongAudioRequest = serde_json::from_value(serde_json::json!({
            "regionId": "r1",
            "trackIds": ["a", "b"],
            "mode": "stems",
            "format": "pcm24",
            "sampleRate": 44100,
            "channels": 2,
            "normalize": false,
            "applyMixer": true,
            "includeMetronome": true,
            "fileName": "Song"
        }))
        .unwrap();
        assert_eq!(request.mode, RenderMode::Stems);
        assert_eq!(request.format, RenderSampleFormat::Pcm24);
        assert_eq!(request.sample_rate, Some(44100));
        assert!(!request.include_voice_guide);
    }

    #[test]
    fn session_and_song_requests_use_runtime_ranges_and_pans() {
        let song: libretracks_core::Song = serde_json::from_value(serde_json::json!({
            "id": "session", "title": "Set", "durationSeconds": 12.0,
            "regions": [
                {"id": "a", "name": "A", "startSeconds": 1.0, "endSeconds": 4.0},
                {"id": "b", "name": "B", "startSeconds": 7.0, "endSeconds": 10.0}
            ],
            "tracks": [], "clips": [], "sectionMarkers": []
        })).unwrap();
        let mut request: RenderSongAudioRequest = serde_json::from_value(serde_json::json!({
            "regionId": "", "scope": "session", "trackIds": [], "mode": "mix",
            "format": "float32", "channels": 2, "normalize": false,
            "applyMixer": true, "includeMetronome": true, "fileName": "Set",
            "tracksPan": -1.0, "metronomePan": 1.0, "voiceGuidePan": 0.5
        })).unwrap();
        let settings = crate::infra::settings::AppSettings::default();
        let emit = |_: f64, _: &'static str| {};
        let build = |request: &RenderSongAudioRequest, region: Option<&str>| {
            let job = RenderJob {
                emit: &emit, request, song_dir: Path::new("."), song: &song,
                settings: &settings, engine_rate: 48000, voices_dir: None,
                staging_root: Path::new("."),
            };
            job.engine_request_for_region(Path::new("mix.wav"), Path::new("stems"), region).unwrap()
        };
        let session = build(&request, None);
        assert_eq!((session.start_seconds, session.end_seconds), (0.0, 12.0));
        let pans = session.pans.unwrap();
        assert_eq!((pans.tracks, pans.metronome, pans.voice_guide), (-1.0, 1.0, 0.5));
        request.scope = RenderScope::Songs;
        let second = build(&request, Some("b"));
        assert_eq!((second.start_seconds, second.end_seconds), (7.0, 10.0));
        request.channels = 1;
        let mono = build(&request, Some("a"));
        let pans = mono.pans.unwrap();
        assert_eq!((pans.tracks, pans.metronome, pans.voice_guide), (0.0, 0.0, 0.0));
    }

    #[test]
    fn songs_are_rendered_in_timeline_order_and_packed_with_unique_names() {
        let song: libretracks_core::Song = serde_json::from_value(serde_json::json!({
            "id": "session", "title": "Set", "durationSeconds": 12.0,
            "regions": [
                {"id": "b", "name": "Same", "startSeconds": 7.0, "endSeconds": 10.0},
                {"id": "a", "name": "Same", "startSeconds": 1.0, "endSeconds": 4.0}
            ],
            "tracks": [], "clips": [], "sectionMarkers": []
        })).unwrap();
        let request: RenderSongAudioRequest = serde_json::from_value(serde_json::json!({
            "regionId": "", "scope": "songs", "trackIds": [], "mode": "mix",
            "format": "float32", "channels": 2, "normalize": false,
            "applyMixer": true, "includeMetronome": true, "fileName": "Set"
        })).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let settings = crate::infra::settings::AppSettings::default();
        let emit = |_: f64, _: &'static str| {};
        let job = RenderJob {
            emit: &emit, request: &request, song_dir: dir.path(), song: &song,
            settings: &settings, engine_rate: 48000, voices_dir: None,
            staging_root: dir.path(),
        };
        let mut ranges = Vec::new();
        let zip_path = dir.path().join("songs.zip");
        let result = job.run_with_renderer(&zip_path, |request, _| {
            ranges.push((request.start_seconds, request.end_seconds));
            let files = request.outputs.iter().map(|output| {
                std::fs::write(&output.path, b"audio").unwrap();
                lt_audio_engine_v2::RenderedFile {
                    path: output.path.clone(), frames: 1, peak: 0.0, loudness: None,
                }
            }).collect();
            Ok(lt_audio_engine_v2::RenderReport { files, missing_clips: 0, missing_files: vec![] })
        }).unwrap();
        assert_eq!(ranges, vec![(1.0, 4.0), (7.0, 10.0)]);
        assert_eq!(result.file_count, 2);
        let mut zip = zip::ZipArchive::new(std::fs::File::open(zip_path).unwrap()).unwrap();
        assert_eq!(zip.by_index(0).unwrap().name(), "01 Same.wav");
        assert_eq!(zip.by_index(1).unwrap().name(), "02 Same.wav");
    }

    /// Builds the engine requests for a real session, for an end-to-end run
    /// against the real engine library (which this crate's test binary cannot
    /// load on Windows, see the desktop-crate testing notes):
    ///
    /// ```text
    /// LT_RENDER_SESSION=<session folder> cargo test -p libretracks-desktop --lib     ///     --features no-link dump_real_session_render_requests -- --ignored
    /// cargo run -p lt-audio-engine-v2 --example render_request -- <dumped .json>
    /// ```
    ///
    /// Only reads the session; everything is written under the temp folder.
    #[test]
    #[ignore]
    fn dump_real_session_render_requests() {
        let Ok(session_dir) = std::env::var("LT_RENDER_SESSION") else {
            return;
        };
        let session_dir = PathBuf::from(session_dir);
        let song = libretracks_project::load_song(&session_dir).expect("session loads");
        let out_dir = std::env::temp_dir().join("lt-render-real-session");
        let _ = std::fs::remove_dir_all(&out_dir);
        std::fs::create_dir_all(&out_dir).unwrap();
        let settings = crate::infra::settings::AppSettings::default();
        let emit = |_: f64, _: &'static str| {};

        for region in &song.regions {
            let track_ids: Vec<String> = song
                .tracks
                .iter()
                .filter(|track| {
                    song.clips.iter().any(|clip| {
                        clip.track_id == track.id
                            && clip.timeline_start_seconds < region.end_seconds
                            && clip.timeline_start_seconds + clip.duration_seconds
                                > region.start_seconds
                    })
                })
                .map(|track| track.id.clone())
                .collect();
            for mode in [RenderMode::Mix, RenderMode::Stems] {
                let label = format!(
                    "{}-{}",
                    sanitize_file_name(&region.name),
                    if mode == RenderMode::Mix { "mix" } else { "stems" }
                );
                let request = RenderSongAudioRequest {
                    region_id: region.id.clone(),
                    scope: RenderScope::Song,
                    track_ids: track_ids.clone(),
                    mode,
                    format: RenderSampleFormat::Pcm24,
                    sample_rate: Some(48_000),
                    channels: 2,
                    normalize: false,
                    apply_mixer: true,
                    include_metronome: mode == RenderMode::Stems,
                    include_voice_guide: false,
                    tracks_pan: 0.0,
                    metronome_pan: 0.0,
                    voice_guide_pan: 0.0,
                    file_name: label.clone(),
                    metronome_label: "Metrónomo".into(),
                    voice_guide_label: "Voz guía".into(),
                };
                let job = RenderJob {
                    emit: &emit,
                    request: &request,
                    song_dir: &session_dir,
                    song: &song,
                    settings: &settings,
                    engine_rate: 48_000,
                    voices_dir: None,
                    staging_root: &out_dir,
                };
                let stem_dir = out_dir.join(&label);
                std::fs::create_dir_all(&stem_dir).unwrap();
                let Ok(engine_request) =
                    job.engine_request(&out_dir.join(format!("{label}.wav")), &stem_dir)
                else {
                    panic!("request builds for {}", region.name);
                };
                let dump = out_dir.join(format!("{label}.request.json"));
                std::fs::write(&dump, serde_json::to_vec(&engine_request).unwrap()).unwrap();
                println!("{}", dump.display());
            }
        }
    }

    #[test]
    fn only_one_render_runs_at_a_time() {
        let first = ActiveRender::acquire().expect("free");
        assert!(ActiveRender::acquire().is_none());
        drop(first);
        assert!(ActiveRender::acquire().is_some());
    }
}
