//! "Nivelar canciones": measure how loud every song of the session plays, so
//! the UI can propose a song master for each and they all reach the desk at
//! the same level.
//!
//! Each song is bounced with the engine's offline renderer in measure mode
//! (no file, no limiter), with the tracks the UI chose: the ones that go to the
//! PA, not the click or cues that go to the in-ears. Mute and solo are the
//! UI's call too — it sends only what sounds.
//!
//! Every song master is measured at unity, so the figure is the song's own
//! level and the proposed master does not depend on the one it has now. The
//! song fades stay, as they are part of how the song plays.
//!
//! Like "Render audio", nothing here takes the engine lock and the session
//! lock is held only to copy the song out: playback keeps running.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use lt_audio_engine_v2::{RenderError, RenderOutput, RenderRequest, RenderSampleFormat};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::commands::render::JobError;
use crate::infra::error::DesktopError;
use crate::state::DesktopState;

pub const LEVEL_SONGS_PROGRESS_EVENT: &str = "level-songs-progress";

/// One measurement at a time, with its own cancel flag (a render can run
/// beside it: they share nothing).
static MEASURE_ACTIVE: AtomicBool = AtomicBool::new(false);
static MEASURE_CANCEL: AtomicBool = AtomicBool::new(false);

struct ActiveMeasure;

impl ActiveMeasure {
    fn acquire() -> Option<Self> {
        if MEASURE_ACTIVE
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return None;
        }
        MEASURE_CANCEL.store(false, Ordering::Release);
        Some(Self)
    }
}

impl Drop for ActiveMeasure {
    fn drop(&mut self) {
        MEASURE_ACTIVE.store(false, Ordering::Release);
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeasureSongLoudnessRequest {
    /// Songs to measure, in the order the UI lists them.
    pub region_ids: Vec<String>,
    /// Audio tracks that count (folders are expanded by the engine).
    pub track_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SongLoudness {
    pub region_id: String,
    /// false: nothing audible among the chosen tracks in this song.
    pub has_signal: bool,
    pub integrated_lufs: f64,
    /// 90th percentile of the short-term loudness: the level of the song's
    /// loud parts, which is what the levelling matches.
    pub loud_lufs: f64,
    pub loudness_range_lu: f64,
    /// Linear sample peak of the mix at unity master, before the limiter.
    pub sample_peak: f32,
    /// Chosen tracks with audio inside this song, so the UI can tell when two
    /// songs carry different instruments and their levels do not compare.
    pub tracks_with_audio: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeasureSongLoudnessResult {
    pub cancelled: bool,
    pub songs: Vec<SongLoudness>,
    /// Audio files that could not be read (measured as silence).
    pub missing_files: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MeasureProgressPayload {
    fraction: f64,
    /// Songs already measured (several are measured at once).
    songs_done: usize,
    song_count: usize,
}

#[tauri::command(async)]
pub fn cancel_measure_song_loudness() {
    MEASURE_CANCEL.store(true, Ordering::Release);
}

#[tauri::command]
pub async fn measure_song_loudness(
    app: AppHandle,
    request: MeasureSongLoudnessRequest,
    state: State<'_, DesktopState>,
) -> Result<MeasureSongLoudnessResult, String> {
    if request.region_ids.is_empty() {
        return Err("No songs to measure".to_string());
    }
    let Some(active) = ActiveMeasure::acquire() else {
        return Err("A measurement is already running".to_string());
    };

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
    let engine_rate = state.audio.current_sample_rate_capabilities().0;

    tauri::async_runtime::spawn_blocking(move || {
        let _active = active;
        let emit = |fraction: f64, songs_done: usize, song_count: usize| {
            let _ = app.emit(
                LEVEL_SONGS_PROGRESS_EVENT,
                MeasureProgressPayload {
                    fraction: fraction.clamp(0.0, 1.0),
                    songs_done,
                    song_count,
                },
            );
        };
        let cancelled = || MEASURE_CANCEL.load(Ordering::Acquire);
        match measure_songs(&song_dir, &song, &request, engine_rate, &emit, &cancelled) {
            Ok(result) => Ok(result),
            Err(JobError::Cancelled) => Ok(MeasureSongLoudnessResult {
                cancelled: true,
                songs: Vec::new(),
                missing_files: Vec::new(),
            }),
            Err(JobError::Failed(error)) => Err(error),
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

/// The song as measured: every song master at unity (fades kept).
pub(crate) fn song_at_unity_masters(song: &libretracks_core::Song) -> libretracks_core::Song {
    let mut song = song.clone();
    for region in &mut song.regions {
        region.master.gain = 1.0;
    }
    song
}

/// Shortest overlap that puts a clip inside a song. Song bounds and clip ends
/// are float seconds computed separately: a clip that ends exactly where the
/// next song starts can overlap it by 1e-12 s and would count there too
/// (seen on a real session: every track of a song leaked into the next one).
pub(crate) const MIN_SONG_OVERLAP_SECONDS: f64 = 0.01;

/// Chosen tracks with a clip sounding inside [start, end), in session order.
/// Folders among the chosen ids count through their children.
pub(crate) fn tracks_with_audio(
    song: &libretracks_core::Song,
    track_ids: &[String],
    start_seconds: f64,
    end_seconds: f64,
) -> Vec<String> {
    let chosen = |track: &libretracks_core::Track| {
        let mut current = Some(track);
        // Bounded like the engine's folder walk.
        for _ in 0..8 {
            let Some(candidate) = current else { break };
            if track_ids.iter().any(|id| id == &candidate.id) {
                return true;
            }
            current = candidate
                .parent_track_id
                .as_deref()
                .and_then(|parent| song.tracks.iter().find(|t| t.id == parent));
        }
        false
    };
    song.tracks
        .iter()
        .filter(|track| track.kind == libretracks_core::TrackKind::Audio && chosen(track))
        .filter(|track| {
            song.clips.iter().any(|clip| {
                clip.track_id == track.id
                    && clip.timeline_start_seconds.max(start_seconds)
                        + MIN_SONG_OVERLAP_SECONDS
                        < (clip.timeline_start_seconds + clip.duration_seconds).min(end_seconds)
            })
        })
        .map(|track| track.id.clone())
        .collect()
}

/// One song to measure: the tracks that sound in it and its runtime bounds.
#[derive(Debug, Clone)]
pub(crate) struct SongJob {
    pub region_id: String,
    pub tracks: Vec<String>,
    pub start_seconds: f64,
    pub end_seconds: f64,
}

/// How many songs are measured at once. Each one holds its mix bus and one
/// track's decoded audio in RAM (~250 MB for a 5-minute song at 48 kHz), and
/// playback must keep its cores, so: half the cores, at most 4 — and 2 on a
/// phone, where memory runs out long before cores do.
pub(crate) fn measure_workers(job_count: usize) -> usize {
    let cores = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(2);
    let cap = if cfg!(any(target_os = "android", target_os = "ios")) {
        2
    } else {
        4
    };
    (cores / 2).clamp(1, cap).min(job_count.max(1))
}

/// Measure `jobs` on `workers` threads, results in job order. Workers pull
/// the next song from a shared counter, so a long song never holds the
/// others back. The first failure stops every worker; so does `cancelled`.
/// `emit` gets (overall fraction, songs finished, songs total).
pub(crate) fn run_song_jobs<T, F>(
    jobs: &[SongJob],
    workers: usize,
    emit: &(dyn Fn(f64, usize, usize) + Sync),
    cancelled: &(dyn Fn() -> bool + Sync),
    measure: F,
) -> Result<Vec<T>, JobError>
where
    T: Send,
    F: Fn(&SongJob, &mut dyn FnMut(f64) -> bool) -> Result<T, JobError> + Sync,
{
    use std::sync::atomic::AtomicUsize;
    use std::sync::{Mutex, MutexGuard, PoisonError};

    fn lock<V>(mutex: &Mutex<V>) -> MutexGuard<'_, V> {
        mutex.lock().unwrap_or_else(PoisonError::into_inner)
    }

    let total = jobs.len();
    let next = AtomicUsize::new(0);
    let finished = AtomicUsize::new(0);
    let abort = AtomicBool::new(false);
    let failure: Mutex<Option<JobError>> = Mutex::new(None);
    let results: Mutex<Vec<Option<T>>> = Mutex::new((0..total).map(|_| None).collect());
    let fractions: Mutex<Vec<f64>> = Mutex::new(vec![0.0; total]);
    let last_emit = Mutex::new(Instant::now() - Duration::from_secs(1));

    let report = |index: usize, fraction: f64, force: bool| {
        let overall = {
            let mut fractions = lock(&fractions);
            fractions[index] = fraction.clamp(0.0, 1.0);
            fractions.iter().sum::<f64>() / total.max(1) as f64
        };
        let mut last = lock(&last_emit);
        if force || last.elapsed() >= Duration::from_millis(100) {
            *last = Instant::now();
            emit(overall, finished.load(Ordering::Acquire), total);
        }
    };

    emit(0.0, 0, total);
    std::thread::scope(|scope| {
        for _ in 0..workers.clamp(1, total.max(1)) {
            scope.spawn(|| loop {
                if abort.load(Ordering::Acquire) || cancelled() {
                    return;
                }
                let index = next.fetch_add(1, Ordering::AcqRel);
                let Some(job) = jobs.get(index) else { return };
                let mut on_progress = |fraction: f64| {
                    report(index, fraction, false);
                    !abort.load(Ordering::Acquire) && !cancelled()
                };
                match measure(job, &mut on_progress) {
                    Ok(value) => {
                        lock(&results)[index] = Some(value);
                        finished.fetch_add(1, Ordering::AcqRel);
                        report(index, 1.0, true);
                    }
                    Err(error) => {
                        abort.store(true, Ordering::Release);
                        let mut failure = lock(&failure);
                        // A worker stopped by another's failure reports
                        // "cancelled": keep the real cause.
                        if failure.is_none() || matches!(*failure, Some(JobError::Cancelled)) {
                            *failure = Some(error);
                        }
                        return;
                    }
                }
            });
        }
    });

    if let Some(error) = failure.into_inner().unwrap_or_else(PoisonError::into_inner) {
        return Err(error);
    }
    if cancelled() {
        return Err(JobError::Cancelled);
    }
    results
        .into_inner()
        .unwrap_or_else(PoisonError::into_inner)
        .into_iter()
        .map(|result| result.ok_or(JobError::Cancelled))
        .collect()
}

fn measure_songs(
    song_dir: &Path,
    song: &libretracks_core::Song,
    request: &MeasureSongLoudnessRequest,
    engine_rate: u32,
    emit: &(dyn Fn(f64, usize, usize) + Sync),
    cancelled: &(dyn Fn() -> bool + Sync),
) -> Result<MeasureSongLoudnessResult, JobError> {
    let measured_song = song_at_unity_masters(song);
    let (project_json, runtime_song) =
        crate::audio::engine::runtime_session_json(song_dir, &measured_song)
            .map_err(|error| JobError::Failed(error.to_string()))?;
    let sample_rate = if engine_rate > 0 { engine_rate } else { 48_000 };

    // Every region resolved before any work starts.
    let jobs = request
        .region_ids
        .iter()
        .map(|region_id| {
            // The RUNTIME bounds: a varispeed transpose stretches the timeline.
            let region = runtime_song
                .regions
                .iter()
                .find(|region| &region.id == region_id)
                .ok_or_else(|| JobError::Failed(format!("Region not found: {region_id}")))?;
            Ok(SongJob {
                region_id: region_id.clone(),
                tracks: tracks_with_audio(
                    &runtime_song,
                    &request.track_ids,
                    region.start_seconds,
                    region.end_seconds,
                ),
                start_seconds: region.start_seconds,
                end_seconds: region.end_seconds,
            })
        })
        .collect::<Result<Vec<_>, JobError>>()?;

    let measured = run_song_jobs(
        &jobs,
        measure_workers(jobs.len()),
        emit,
        cancelled,
        |job, on_progress| -> Result<(SongLoudness, Vec<String>), JobError> {
            let mut measured = SongLoudness {
                region_id: job.region_id.clone(),
                has_signal: false,
                integrated_lufs: -70.0,
                loud_lufs: -70.0,
                loudness_range_lu: 0.0,
                sample_peak: 0.0,
                tracks_with_audio: job.tracks.clone(),
            };
            if job.tracks.is_empty() || job.end_seconds <= job.start_seconds {
                return Ok((measured, Vec::new()));
            }
            let engine_request = RenderRequest {
                project_json: project_json.clone(),
                sample_rate,
                start_seconds: job.start_seconds,
                end_seconds: job.end_seconds,
                outputs: vec![RenderOutput {
                    path: String::new(),
                    track_ids: job.tracks.clone(),
                    include_metronome: false,
                    include_voice_guide: false,
                }],
                format: RenderSampleFormat::Float32,
                channels: 2,
                normalize: false,
                normalize_peak_db: 0.0,
                apply_mixer: true,
                dither: false,
                measure_loudness: true,
                metronome: None,
                voice_guide: None,
            };
            let report = match lt_audio_engine_v2::render_offline(&engine_request, on_progress) {
                Ok(report) => report,
                Err(RenderError::Cancelled) => return Err(JobError::Cancelled),
                Err(RenderError::Failed(error)) => return Err(JobError::Failed(error.to_string())),
            };
            if let Some(loudness) = report.files.first().and_then(|file| file.loudness) {
                measured.has_signal = loudness.has_signal;
                measured.integrated_lufs = loudness.integrated_lufs;
                measured.loud_lufs = loudness.loud_lufs;
                measured.loudness_range_lu = loudness.loudness_range_lu;
                measured.sample_peak = loudness.sample_peak;
            }
            Ok((measured, report.missing_files))
        },
    )?;

    let mut songs = Vec::with_capacity(measured.len());
    let mut missing_files: Vec<String> = Vec::new();
    for (song, missing) in measured {
        for file in missing {
            if !missing_files.contains(&file) {
                missing_files.push(file);
            }
        }
        songs.push(song);
    }
    Ok(MeasureSongLoudnessResult {
        cancelled: false,
        songs,
        missing_files,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use libretracks_core::{Clip, Song, SongMaster, SongRegion, Track, TrackKind};

    fn track(id: &str, kind: TrackKind, parent: Option<&str>) -> Track {
        Track {
            id: id.into(),
            name: id.into(),
            kind,
            parent_track_id: parent.map(Into::into),
            volume: 1.0,
            pan: 0.0,
            muted: false,
            solo: false,
            transpose_enabled: true,
            audio_to: "master".to_string(),
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

    fn clip(id: &str, track_id: &str, start: f64, duration: f64) -> Clip {
        Clip {
            id: id.into(),
            track_id: track_id.into(),
            file_path: format!("{id}.wav"),
            timeline_start_seconds: start,
            source_start_seconds: 0.0,
            duration_seconds: duration,
            gain: 1.0,
            fade_in_seconds: None,
            fade_out_seconds: None,
            color: None,
        }
    }

    fn region(id: &str, start: f64, end: f64, gain: f64) -> SongRegion {
        SongRegion {
            key_changes: Vec::new(),
            id: id.into(),
            name: id.into(),
            start_seconds: start,
            end_seconds: end,
            transpose_semitones: 0,
            warp_enabled: false,
            warp_source_bpm: None,
            key: None,
            master: SongMaster {
                gain,
                ..SongMaster::default()
            },
            compact_column_width_rem: None,
            chart: None,
            cover_image: None,
            voice_guide_count_style: None,
            structure: None,
        }
    }

    fn song() -> Song {
        let mut second = region("two", 60.0, 120.0, 2.0);
        second.master.fade_in_seconds = 1.5;
        Song {
            id: "setlist".into(),
            title: "Setlist".into(),
            artist: None,
            key: None,
            bpm: 120.0,
            time_signature: "4/4".into(),
            duration_seconds: 120.0,
            tempo_markers: vec![],
            time_signature_markers: vec![],
            regions: vec![region("one", 0.0, 60.0, 0.3), second],
            tracks: vec![
                track("drums", TrackKind::Audio, None),
                track("keys_folder", TrackKind::Folder, None),
                track("keys", TrackKind::Audio, Some("keys_folder")),
                track("click", TrackKind::Audio, None),
            ],
            clips: vec![
                clip("d1", "drums", 0.0, 60.0),
                clip("k1", "keys", 0.0, 120.0),
                clip("c1", "click", 0.0, 120.0),
            ],
            midi_clips: vec![],
            video_clips: vec![],
            section_markers: vec![],
        }
    }

    #[test]
    fn tracks_with_audio_lists_chosen_tracks_that_sound_in_the_song() {
        let song = song();
        let chosen = vec!["drums".to_string(), "keys".to_string()];
        assert_eq!(tracks_with_audio(&song, &chosen, 0.0, 60.0), vec!["drums", "keys"]);
        // The drums stop at 60 s: the second song has none.
        assert_eq!(tracks_with_audio(&song, &chosen, 60.0, 120.0), vec!["keys"]);
        // A song starting a hair before the drums end (float noise) still has none.
        assert_eq!(
            tracks_with_audio(&song, &chosen, 60.0 - 1e-9, 120.0),
            vec!["keys"]
        );
    }

    #[test]
    fn a_chosen_folder_counts_through_its_tracks_and_unchosen_ones_never_count() {
        let song = song();
        let chosen = vec!["keys_folder".to_string()];
        assert_eq!(tracks_with_audio(&song, &chosen, 0.0, 120.0), vec!["keys"]);
        assert!(tracks_with_audio(&song, &[], 0.0, 120.0).is_empty());
    }

    #[test]
    fn songs_are_measured_at_unity_master_keeping_their_fades() {
        let measured = song_at_unity_masters(&song());
        assert!(measured.regions.iter().all(|region| region.master.gain == 1.0));
        assert_eq!(measured.regions[1].master.fade_in_seconds, 1.5);
    }

    fn jobs(count: usize) -> Vec<SongJob> {
        (0..count)
            .map(|index| SongJob {
                region_id: format!("song{index}"),
                tracks: vec!["t".into()],
                start_seconds: 0.0,
                end_seconds: 1.0,
            })
            .collect()
    }

    #[test]
    fn songs_are_measured_at_the_same_time_and_come_back_in_order() {
        use std::sync::atomic::AtomicUsize;
        let running = AtomicUsize::new(0);
        let peak = AtomicUsize::new(0);
        let last_done = AtomicUsize::new(0);
        let emit = |_: f64, done: usize, _: usize| {
            last_done.fetch_max(done, Ordering::AcqRel);
        };
        let results = run_song_jobs(&jobs(6), 3, &emit, &|| false, |job, on_progress| {
            let now = running.fetch_add(1, Ordering::AcqRel) + 1;
            peak.fetch_max(now, Ordering::AcqRel);
            // Long enough for the other workers to start.
            std::thread::sleep(Duration::from_millis(40));
            on_progress(0.5);
            running.fetch_sub(1, Ordering::AcqRel);
            Ok(job.region_id.clone())
        })
        .expect("all songs measured");
        assert_eq!(results, (0..6).map(|i| format!("song{i}")).collect::<Vec<_>>());
        assert!(peak.load(Ordering::Acquire) > 1, "songs were measured one by one");
        assert!(peak.load(Ordering::Acquire) <= 3, "more workers than asked");
        assert_eq!(last_done.load(Ordering::Acquire), 6);
    }

    #[test]
    fn one_failure_stops_the_rest_and_is_the_error_reported() {
        use std::sync::atomic::AtomicUsize;
        let started = AtomicUsize::new(0);
        let result = run_song_jobs(&jobs(20), 2, &|_, _, _| {}, &|| false, |job, on_progress| {
            started.fetch_add(1, Ordering::AcqRel);
            if job.region_id == "song1" {
                return Err::<(), _>(JobError::Failed("bad file".into()));
            }
            std::thread::sleep(Duration::from_millis(20));
            if on_progress(0.5) {
                Ok(())
            } else {
                Err(JobError::Cancelled)
            }
        });
        assert!(matches!(result, Err(JobError::Failed(ref e)) if e == "bad file"));
        assert!(started.load(Ordering::Acquire) < 20, "workers kept going after the failure");
    }

    #[test]
    fn cancelling_returns_cancelled() {
        let cancel = AtomicBool::new(false);
        let result = run_song_jobs(
            &jobs(4),
            2,
            &|_, _, _| {},
            &|| cancel.load(Ordering::Acquire),
            |_, on_progress| {
                cancel.store(true, Ordering::Release);
                if on_progress(0.1) {
                    Ok(())
                } else {
                    Err(JobError::Cancelled)
                }
            },
        );
        assert!(matches!(result, Err(JobError::Cancelled)));
    }

    #[test]
    fn workers_never_exceed_the_songs_or_the_cap() {
        assert_eq!(measure_workers(1), 1);
        assert!(measure_workers(100) >= 1);
        assert!(measure_workers(100) <= 4);
    }

    /// Real-session check, off unless `LT_LEVEL_SESSION` names a session
    /// folder. Writes, per song, the measure request and a mix-to-WAV request
    /// (both at unity masters, built as the app builds them) plus a summary of
    /// the tracks counted, for `examples/render_request` and offline analysis.
    /// Track choice mirrors the UI defaults (levelSongsPlan.ts): no muted
    /// tracks, nothing on the monitor bus, no click/cue/guide names.
    #[test]
    fn dump_real_session_level_requests() {
        let Ok(session_dir) = std::env::var("LT_LEVEL_SESSION") else {
            return;
        };
        let session_dir = std::path::PathBuf::from(session_dir);
        let song = libretracks_project::load_song(&session_dir).expect("session loads");
        let out_dir = std::env::temp_dir().join("lt-level-real-session");
        let _ = std::fs::remove_dir_all(&out_dir);
        std::fs::create_dir_all(&out_dir).unwrap();

        let cue = |name: &str| {
            let lower = name.to_lowercase();
            [
                "click", "clic", "metronom", "metrónom", "cue", "guide", "guia", "guía",
                "count", "conteo", "timecode", "smpte", "ltc",
            ]
            .iter()
            .any(|word| lower.contains(word))
        };
        let silent_or_ears = |track: &Track| {
            let mut current = Some(track);
            for _ in 0..8 {
                let Some(t) = current else { break };
                if t.muted || t.audio_to.eq_ignore_ascii_case("monitor") || cue(&t.name) {
                    return true;
                }
                current = t
                    .parent_track_id
                    .as_deref()
                    .and_then(|id| song.tracks.iter().find(|c| c.id == id));
            }
            false
        };
        let counted: Vec<String> = song
            .tracks
            .iter()
            .filter(|t| t.kind == TrackKind::Audio && !silent_or_ears(t))
            .map(|t| t.id.clone())
            .collect();

        let measured_song = song_at_unity_masters(&song);
        let (project_json, runtime_song) =
            crate::audio::engine::runtime_session_json(&session_dir, &measured_song)
                .expect("runtime json");
        let mut summary = Vec::new();
        for (index, region) in runtime_song.regions.iter().enumerate() {
            let tracks = tracks_with_audio(
                &runtime_song,
                &counted,
                region.start_seconds,
                region.end_seconds,
            );
            let excluded: Vec<String> = runtime_song
                .tracks
                .iter()
                .filter(|t| t.kind == TrackKind::Audio && !counted.contains(&t.id))
                .filter(|t| {
                    runtime_song.clips.iter().any(|c| {
                        c.track_id == t.id
                            && c.timeline_start_seconds < region.end_seconds
                            && c.timeline_start_seconds + c.duration_seconds > region.start_seconds
                    })
                })
                .map(|t| t.name.clone())
                .collect();
            let wav = out_dir.join(format!("song{index:02}.wav"));
            for (kind, measure, path) in [
                ("measure", true, String::new()),
                ("mix", false, wav.to_string_lossy().into_owned()),
            ] {
                let request = RenderRequest {
                    project_json: project_json.clone(),
                    sample_rate: 48_000,
                    start_seconds: region.start_seconds,
                    end_seconds: region.end_seconds,
                    outputs: vec![RenderOutput {
                        path,
                        track_ids: tracks.clone(),
                        include_metronome: false,
                        include_voice_guide: false,
                    }],
                    format: RenderSampleFormat::Float32,
                    channels: 2,
                    normalize: false,
                    normalize_peak_db: 0.0,
                    apply_mixer: true,
                    dither: false,
                    measure_loudness: measure,
                    metronome: None,
                    voice_guide: None,
                };
                std::fs::write(
                    out_dir.join(format!("song{index:02}-{kind}.json")),
                    serde_json::to_string(&request).unwrap(),
                )
                .unwrap();
            }
            let original = song.regions.iter().find(|r| r.id == region.id);
            summary.push(serde_json::json!({
                "index": index,
                "name": region.name,
                "currentGain": original.map(|r| r.master.gain).unwrap_or(1.0),
                "seconds": region.end_seconds - region.start_seconds,
                "counted": tracks
                    .iter()
                    .filter_map(|id| runtime_song.tracks.iter().find(|t| &t.id == id))
                    .map(|t| t.name.clone())
                    .collect::<Vec<_>>(),
                "excluded": excluded,
            }));
        }
        std::fs::write(
            out_dir.join("summary.json"),
            serde_json::to_string_pretty(&summary).unwrap(),
        )
        .unwrap();
        println!("wrote {}", out_dir.display());
    }

    #[test]
    fn request_uses_the_ui_field_names() {
        let request: MeasureSongLoudnessRequest = serde_json::from_value(serde_json::json!({
            "regionIds": ["one"],
            "trackIds": ["drums"],
        }))
        .unwrap();
        assert_eq!(request.region_ids, vec!["one"]);
        assert_eq!(request.track_ids, vec!["drums"]);
    }
}
