//! Preparing a song's warped/transposed tracks to disk, in the background.
//!
//! Shaped after [`crate::state::WaveformGenerationQueue`], for the same reason
//! it exists: this work takes seconds per track and must never run under the
//! session lock, which `engine_snapshot` takes on every meter poll. A command
//! that did it inline would freeze playback and the UI for the whole run — the
//! exact failure the waveform prime pass was moved off the lock to fix.
//!
//! Two things differ from that queue, both on purpose:
//!
//! **One worker, not a pool.** The renderer makes a track's sources fully
//! resident before rendering it, because the stretched path cannot re-render a
//! step that came up short. One track at a time keeps that bounded at a
//! measured 112 MiB; several at once would multiply it and evict the cache
//! playback is reading from.
//!
//! **It is a user action, not an optimisation.** The waveform queue swallows
//! its errors because failing just means the slow path runs instead. Here a
//! failure means the user asked for something and did not get it, so every
//! outcome is kept and reported.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;

use libretracks_core::{Song, TrackKind};
use libretracks_project::{
    prepare_tracks, PreparationProgress, PreparationReport, PreparationRequest,
    PreparedRenderFormat, PreparedRenderOutput, PreparedRenderSpec, RenderFailure, RenderedTrack,
    TrackOutcome, TrackRenderSink,
};
use lt_audio_engine_v2::{PreparedRenderError, PreparedTrackRenderer};
use serde::Serialize;

use crate::audio::engine::AudioController;

/// Identity of the DSP that produces prepared audio.
///
/// **Bump this whenever the stretcher changes, or the way `TrackRenderer` feeds
/// it changes.** Nothing else in a cache key would notice: the session would be
/// identical and the audio would not. Getting this wrong means users keep
/// hearing the old DSP until they edit something.
pub const PREPARED_DSP_REVISION: &str = "bungee-2.4.24+trackrenderer-1";

/// 16-bit PCM, the format the decode cache already uses. Half the disk of
/// float32 with the quantization floor 80 dB under the programme, and measured
/// to change nothing about fidelity across starts, jumps or resumes. See
/// docs/plans/audio-engine-performance/08-presupuesto-y-formato.md.
const PREPARED_FORMAT: PreparedRenderFormat = PreparedRenderFormat::Pcm16;

/// What one song's prepared cache may occupy. At 10,99 MiB per track-minute a
/// four-minute song with twelve prepared tracks is 0,51 GiB, so this allows
/// roughly four such songs before refusing.
const DEFAULT_BUDGET_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparationStatus {
    pub running: bool,
    /// The track being rendered right now, empty when idle.
    pub track_id: String,
    pub track_index: usize,
    pub track_count: usize,
    /// 0..100 across the whole preparation, not just the current track.
    pub percent: f64,
    pub prepared: usize,
    pub reused: usize,
    pub failures: Vec<String>,
    /// Samples the format's ceiling clamped. Non-zero means some prepared audio
    /// carries distortion and the user should be told, not left to hear it.
    pub clipped_samples: u64,
    pub bytes_written: u64,
    pub bytes_reclaimed: u64,
    /// Set when the preparation never started because it did not fit.
    pub refused: Option<String>,
    pub cancelled: bool,
    /// True once a pass has finished, so the UI can stop polling.
    pub finished: bool,
}

struct Shared {
    cancel: AtomicBool,
    busy: AtomicBool,
    /// Bumped on every pass so a stale cancel cannot kill the next one.
    generation: AtomicU64,
    status: Mutex<PreparationStatus>,
}

struct PreparationTask {
    song_id: String,
    song_dir: PathBuf,
    song: Box<Song>,
    audio: Arc<AudioController>,
    generation: u64,
}

#[derive(Clone)]
pub struct PreparationQueue {
    sender: mpsc::Sender<PreparationTask>,
    shared: Arc<Shared>,
}

/// Tracks worth preparing: the ones whose audio actually goes through the
/// stretcher. A track with no warp and no transposition already plays straight
/// from its source, so preparing it would spend disk to save nothing.
pub fn tracks_worth_preparing(song: &Song) -> Vec<String> {
    song.tracks
        .iter()
        .filter(|track| track.kind == TrackKind::Audio)
        .filter(|track| {
            let clips: Vec<_> = song
                .clips
                .iter()
                .filter(|clip| clip.track_id == track.id)
                .collect();
            if clips.is_empty() {
                return false;
            }
            let start = clips
                .iter()
                .map(|clip| clip.timeline_start_seconds)
                .fold(f64::INFINITY, f64::min);
            let end = clips
                .iter()
                .map(|clip| clip.timeline_start_seconds + clip.duration_seconds.max(0.0))
                .fold(f64::NEG_INFINITY, f64::max);
            song.regions.iter().any(|region| {
                region.end_seconds > start
                    && region.start_seconds < end
                    && (region.warp_enabled
                        || (track.transpose_enabled && region.transpose_semitones != 0))
            })
        })
        .map(|track| track.id.clone())
        .collect()
}

fn build_specs(song: &Song, song_dir: &std::path::Path) -> Vec<PreparedRenderSpec> {
    let output = PreparedRenderOutput {
        sample_rate: 48_000,
        channels: 2,
        format: PREPARED_FORMAT,
        dsp_identity: PREPARED_DSP_REVISION.into(),
    };
    tracks_worth_preparing(song)
        .into_iter()
        .filter_map(|track_id| {
            PreparedRenderSpec::from_song(song, &track_id, song_dir, &output)
        })
        .collect()
}

/// The engine's renderer, behind the orchestration's sink.
struct EngineSink {
    renderer: PreparedTrackRenderer,
    song_id: String,
}

impl TrackRenderSink for EngineSink {
    fn render(
        &self,
        track_id: &str,
        output_path: &std::path::Path,
        pcm16: bool,
        on_progress: &mut dyn FnMut(u64, u64) -> bool,
    ) -> Result<RenderedTrack, RenderFailure> {
        // A path the engine cannot receive as text fails this track, not the
        // whole pass: the other tracks may well be fine.
        let Some(output) = output_path.to_str() else {
            return Err(RenderFailure::Failed(format!(
                "la ruta de salida no es texto válido: {}",
                output_path.display()
            )));
        };
        let mut progress =
            |done: i64, total: i64| on_progress(done.max(0) as u64, total.max(0) as u64);
        match self
            .renderer
            .render(&self.song_id, track_id, output, pcm16, &mut progress)
        {
            Ok(outcome) => Ok(RenderedTrack {
                timeline_start_frames: outcome.timeline_start_frames,
                frames: outcome.frames.max(0) as u64,
                output_bytes: outcome.output_bytes,
                clipped_samples: outcome.clipped_samples,
            }),
            Err(PreparedRenderError::Cancelled) => Err(RenderFailure::Cancelled),
            Err(PreparedRenderError::Failed(reason)) => Err(RenderFailure::Failed(reason)),
        }
    }
}

impl PreparationQueue {
    /// Start preparing `song`. Returns false when a preparation is already
    /// running: one at a time is the point, not a limitation to work around.
    pub fn enqueue(
        &self,
        song_id: String,
        song_dir: PathBuf,
        song: Song,
        audio: Arc<AudioController>,
    ) -> bool {
        if self.shared.busy.swap(true, Ordering::SeqCst) {
            return false;
        }
        let generation = self.shared.generation.fetch_add(1, Ordering::SeqCst) + 1;
        // A cancel from the previous pass must not reach this one.
        self.shared.cancel.store(false, Ordering::SeqCst);
        if let Ok(mut status) = self.shared.status.lock() {
            *status = PreparationStatus {
                running: true,
                track_count: tracks_worth_preparing(&song).len(),
                ..Default::default()
            };
        }
        let queued = self
            .sender
            .send(PreparationTask {
                song_id,
                song_dir,
                song: Box::new(song),
                audio,
                generation,
            })
            .is_ok();
        if !queued {
            self.shared.busy.store(false, Ordering::SeqCst);
            if let Ok(mut status) = self.shared.status.lock() {
                status.running = false;
                status.finished = true;
                status.refused = Some("el preparador no está disponible".into());
            }
        }
        queued
    }

    /// Ask the running preparation to stop. Safe to call when nothing is
    /// running; the generation counter keeps it from touching the next pass.
    pub fn cancel(&self) {
        self.shared.cancel.store(true, Ordering::SeqCst);
    }

    pub fn status(&self) -> PreparationStatus {
        self.shared
            .status
            .lock()
            .map(|status| status.clone())
            .unwrap_or_default()
    }

}

impl Default for PreparationQueue {
    fn default() -> Self {
        let (sender, receiver) = mpsc::channel::<PreparationTask>();
        let shared = Arc::new(Shared {
            cancel: AtomicBool::new(false),
            busy: AtomicBool::new(false),
            generation: AtomicU64::new(0),
            status: Mutex::new(PreparationStatus::default()),
        });

        let worker_shared = Arc::clone(&shared);
        // One worker. See the module note: source residency is what bounds the
        // memory, and it only bounds it for one track at a time.
        thread::spawn(move || {
            while let Ok(task) = receiver.recv() {
                run_task(task, &worker_shared);
                worker_shared.busy.store(false, Ordering::SeqCst);
            }
        });

        Self { sender, shared }
    }
}

fn run_task(task: PreparationTask, shared: &Arc<Shared>) {
    let specs = build_specs(&task.song, &task.song_dir);
    let renderer = match task.audio.prepared_track_renderer() {
        Ok(renderer) => renderer,
        Err(error) => {
            finish_with_refusal(shared, error.to_string());
            return;
        }
    };
    let sink = EngineSink {
        renderer,
        song_id: task.song_id.clone(),
    };

    // The second key check reads the song this pass was handed, not the live
    // session: taking the session lock here would put the very lock this queue
    // exists to avoid back in the middle of the render loop. The snapshot still
    // catches the case that matters — the file is validated against the song it
    // was asked to render, and a session edited since then bumps the generation
    // and gets its own pass.
    let song_for_recheck = task.song.clone();
    let dir_for_recheck = task.song_dir.clone();
    let output = PreparedRenderOutput {
        sample_rate: 48_000,
        channels: 2,
        format: PREPARED_FORMAT,
        dsp_identity: PREPARED_DSP_REVISION.into(),
    };
    let current_spec = move |track_id: &str| {
        PreparedRenderSpec::from_song(&song_for_recheck, track_id, &dir_for_recheck, &output)
    };

    let generation = task.generation;
    let cancel_shared = Arc::clone(shared);
    let should_cancel = move || {
        cancel_shared.cancel.load(Ordering::SeqCst)
            && cancel_shared.generation.load(Ordering::SeqCst) == generation
    };

    let progress_shared = Arc::clone(shared);
    let mut on_progress = move |progress: PreparationProgress| {
        if let Ok(mut status) = progress_shared.status.lock() {
            status.track_id = progress.track_id;
            status.track_index = progress.track_index;
            status.track_count = progress.track_count;
            // Across the whole pass, not the current track: a bar that resets
            // to zero on every track tells the user nothing about the wait.
            let within = if progress.frames_total > 0 {
                progress.frames_done as f64 / progress.frames_total as f64
            } else {
                0.0
            };
            let done = (progress.track_index.saturating_sub(1)) as f64 + within;
            status.percent = if progress.track_count > 0 {
                (done / progress.track_count as f64 * 100.0).clamp(0.0, 100.0)
            } else {
                0.0
            };
        }
    };

    let request = PreparationRequest {
        song_dir: &task.song_dir,
        specs: &specs,
        budget_bytes: DEFAULT_BUDGET_BYTES,
        current_spec: &current_spec,
    };
    let report = prepare_tracks(
        &request,
        &sink,
        matches!(PREPARED_FORMAT, PreparedRenderFormat::Pcm16),
        &mut on_progress,
        &should_cancel,
    );
    publish_report(shared, report);
}

fn finish_with_refusal(shared: &Arc<Shared>, reason: String) {
    if let Ok(mut status) = shared.status.lock() {
        status.running = false;
        status.finished = true;
        status.refused = Some(reason);
    }
}

fn publish_report(shared: &Arc<Shared>, report: PreparationReport) {
    if let Ok(mut status) = shared.status.lock() {
        status.running = false;
        status.finished = true;
        status.percent = if report.refused.is_some() { 0.0 } else { 100.0 };
        status.track_id.clear();
        status.prepared = report.prepared_count();
        status.reused = report
            .outcomes
            .iter()
            .filter(|(_, outcome)| matches!(outcome, TrackOutcome::Reused))
            .count();
        status.failures = report
            .failures()
            .map(|(track, reason)| format!("{track}: {reason}"))
            .collect();
        status.clipped_samples = report.clipped_samples;
        status.bytes_written = report.bytes_written;
        status.bytes_reclaimed = report.bytes_reclaimed;
        status.cancelled = report.was_cancelled();
        status.refused = report.refused.as_ref().map(|refusal| refusal.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use libretracks_core::{Clip, SongMaster, SongRegion, Track};

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
            color: None,
            auto_created: false,
            midi_port: None,
            midi_channel: 1,
            midi_enabled: true,
            collapsed: false,
            height_offset: None,
        }
    }

    fn clip(track_id: &str, start: f64, duration: f64) -> Clip {
        Clip {
            id: format!("c-{track_id}-{start}"),
            track_id: track_id.into(),
            file_path: "audio/x.wav".into(),
            timeline_start_seconds: start,
            source_start_seconds: 0.0,
            duration_seconds: duration,
            gain: 1.0,
            fade_in_seconds: None,
            fade_out_seconds: None,
            color: None,
        }
    }

    fn region(start: f64, end: f64, warp: bool, semitones: i32) -> SongRegion {
        SongRegion {
            id: format!("r{start}"),
            name: "R".into(),
            start_seconds: start,
            end_seconds: end,
            transpose_semitones: semitones,
            key: None,
            warp_enabled: warp,
            warp_source_bpm: if warp { Some(100.0) } else { None },
            master: SongMaster::default(),
            compact_column_width_rem: None,
        }
    }

    fn song(tracks: Vec<Track>, clips: Vec<Clip>, regions: Vec<SongRegion>) -> Song {
        Song {
            id: "song".into(),
            title: "Song".into(),
            artist: None,
            key: None,
            bpm: 120.0,
            time_signature: "4/4".into(),
            duration_seconds: 120.0,
            tempo_markers: vec![],
            time_signature_markers: vec![],
            regions,
            tracks,
            clips,
            midi_clips: vec![],
            section_markers: vec![],
        }
    }

    /// Preparing a track that plays straight from its source spends 11 MiB per
    /// track-minute to save nothing. Only the tracks that actually go through
    /// the stretcher are worth the disk.
    #[test]
    fn only_tracks_that_reach_the_stretcher_are_worth_preparing() {
        let warped = song(
            vec![track("t1", true)],
            vec![clip("t1", 0.0, 30.0)],
            vec![region(0.0, 60.0, true, 0)],
        );
        assert_eq!(tracks_worth_preparing(&warped), vec!["t1".to_string()]);

        let transposed = song(
            vec![track("t1", true)],
            vec![clip("t1", 0.0, 30.0)],
            vec![region(0.0, 60.0, false, 3)],
        );
        assert_eq!(tracks_worth_preparing(&transposed), vec!["t1".to_string()]);

        // Neither warp nor transposition: the source already plays as-is.
        let plain = song(
            vec![track("t1", true)],
            vec![clip("t1", 0.0, 30.0)],
            vec![region(0.0, 60.0, false, 0)],
        );
        assert!(tracks_worth_preparing(&plain).is_empty());
    }

    #[test]
    fn a_track_opted_out_of_transposition_is_not_prepared_for_it() {
        // The region transposes, but this track is set not to follow. Preparing
        // it would write a file identical to its source.
        let opted_out = song(
            vec![track("t1", false)],
            vec![clip("t1", 0.0, 30.0)],
            vec![region(0.0, 60.0, false, 3)],
        );
        assert!(tracks_worth_preparing(&opted_out).is_empty());

        // Warp is not gated by that flag â€” it applies to the whole region.
        let warped = song(
            vec![track("t1", false)],
            vec![clip("t1", 0.0, 30.0)],
            vec![region(0.0, 60.0, true, 0)],
        );
        assert_eq!(tracks_worth_preparing(&warped), vec!["t1".to_string()]);
    }

    #[test]
    fn a_track_that_never_reaches_the_warped_region_is_left_alone() {
        // Two songs in one timeline: only the second is warped, and the track
        // that lives in the first must not be prepared because of it.
        let mixed = song(
            vec![track("early", true), track("late", true)],
            vec![clip("early", 0.0, 10.0), clip("late", 70.0, 10.0)],
            vec![region(0.0, 60.0, false, 0), region(60.0, 120.0, true, 0)],
        );
        assert_eq!(tracks_worth_preparing(&mixed), vec!["late".to_string()]);
    }

    #[test]
    fn tracks_without_audio_are_never_candidates() {
        let mut folders = song(
            vec![track("t1", true)],
            vec![clip("t1", 0.0, 30.0)],
            vec![region(0.0, 60.0, true, 0)],
        );
        folders.tracks[0].kind = TrackKind::Folder;
        assert!(tracks_worth_preparing(&folders).is_empty());

        let empty = song(vec![track("t1", true)], vec![], vec![region(0.0, 60.0, true, 0)]);
        assert!(tracks_worth_preparing(&empty).is_empty());
    }

    #[test]
    fn a_second_preparation_is_refused_while_one_is_running() {
        // One at a time is the design: source residency only stays bounded for
        // one track, and two passes would multiply the memory and fight over
        // the same cache playback reads from.
        let queue = PreparationQueue::default();
        assert!(!queue.status().running);
        queue.shared.busy.store(true, std::sync::atomic::Ordering::SeqCst);
        let refused = queue.enqueue(
            "song".into(),
            PathBuf::from("."),
            song(vec![], vec![], vec![]),
            Arc::new(AudioController::default()),
        );
        assert!(!refused, "a second pass must not start on top of the first");
    }

    #[test]
    fn a_cancel_from_a_previous_pass_cannot_kill_the_next_one() {
        // The stop button and the queue are on different threads, so a cancel
        // can land after the pass it was meant for has already finished.
        let queue = PreparationQueue::default();
        queue.cancel();
        assert!(queue.shared.cancel.load(std::sync::atomic::Ordering::SeqCst));
        // Starting a pass clears it; the generation counter covers the race
        // where the cancel arrives between the two.
        let started = queue.enqueue(
            "song".into(),
            PathBuf::from("."),
            song(vec![], vec![], vec![]),
            Arc::new(AudioController::default()),
        );
        assert!(started);
        assert!(!queue.shared.cancel.load(std::sync::atomic::Ordering::SeqCst));
    }
}
