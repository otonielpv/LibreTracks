//! Preparing a set of tracks: what to render, in what order, and what to do
//! when the session moves underneath.
//!
//! The rendering itself is somebody else's problem — it lives in the engine and
//! arrives here as [`TrackRenderSink`]. That indirection is not ceremony: the
//! decisions in this file are the ones worth testing, and testing them against
//! a real stretcher would mean minutes per case and no way to provoke the
//! failures that matter.
//!
//! # Why the key is checked twice
//!
//! A render takes seconds. The user is free to keep editing during them, and
//! moving one clip changes what the file should have contained. So the key is
//! computed before rendering, to decide what to do, and computed again from the
//! current model before publishing — if it moved, the file is discarded rather
//! than published under a key it no longer matches. Publishing first and
//! checking later would put stale audio in front of a listener, which is the
//! one outcome this whole feature must never produce.
//!
//! # Why cancellation is between tracks and inside them
//!
//! Between, because a session close or a clip edit should not have to wait for
//! a twelve-track preparation. Inside, because one track of a long song is
//! itself tens of seconds, and a stop button that does nothing for half a
//! minute is a broken stop button.

use std::path::{Path, PathBuf};

use libretracks_core::model::Song;

use crate::prepared_render::{
    load_usable_prepared_render, PreparedRenderOutput, prepared_render_audio_path, publish_prepared_render_manifest,
    now_millis, PreparedRenderManifest, PreparedRenderSpec, PREPARED_RENDER_VERSION,
};
use crate::prepared_render_store::{
    check_room, create_prepared_dir, discard, free_space_for, in_progress_audio_path,
    plan_preparation, publish_audio, reclaim, stored_bytes, PreparationRefusal,
};

/// What the engine reports back for one rendered track.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RenderedTrack {
    pub timeline_start_frames: i64,
    pub frames: u64,
    pub output_bytes: u64,
    pub clipped_samples: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RenderFailure {
    /// The sink was asked to stop and did.
    Cancelled,
    Failed(String),
}

/// Whatever can turn a track into a prepared file. Implemented over the engine's
/// detached renderer by the host; implemented by a fake in the tests here.
pub trait TrackRenderSink {
    fn render(
        &self,
        track_id: &str,
        output_path: &Path,
        pcm16: bool,
        on_progress: &mut dyn FnMut(u64, u64) -> bool,
    ) -> Result<RenderedTrack, RenderFailure>;
}

/// Where a preparation is, for the UI and the log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparationProgress {
    pub track_id: String,
    /// 1-based, counting only the tracks that actually need rendering.
    pub track_index: usize,
    pub track_count: usize,
    pub frames_done: u64,
    pub frames_total: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TrackOutcome {
    /// A usable file was already on disk.
    Reused,
    Prepared { clipped_samples: u64, bytes: u64 },
    /// The session changed while this track rendered, so the file no longer
    /// described it and was thrown away.
    Superseded,
    Cancelled,
    Failed(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PreparationReport {
    pub outcomes: Vec<(String, TrackOutcome)>,
    pub bytes_written: u64,
    pub bytes_reclaimed: u64,
    /// Total samples the format's ceiling clamped across every track. Non-zero
    /// means some of the prepared audio carries distortion, and the caller
    /// should say so rather than let it be discovered by ear.
    pub clipped_samples: u64,
    pub refused: Option<PreparationRefusal>,
}

impl PreparationReport {
    pub fn prepared_count(&self) -> usize {
        self.outcomes
            .iter()
            .filter(|(_, outcome)| matches!(outcome, TrackOutcome::Prepared { .. }))
            .count()
    }

    pub fn failures(&self) -> impl Iterator<Item = (&str, &str)> {
        self.outcomes.iter().filter_map(|(track, outcome)| match outcome {
            TrackOutcome::Failed(reason) => Some((track.as_str(), reason.as_str())),
            _ => None,
        })
    }

    pub fn was_cancelled(&self) -> bool {
        self.outcomes
            .iter()
            .any(|(_, outcome)| matches!(outcome, TrackOutcome::Cancelled))
    }
}

/// Everything the caller has to supply that is not a track.
pub struct PreparationRequest<'a> {
    pub song_dir: &'a Path,
    /// One spec per track the caller wants prepared, already built from the
    /// live model.
    pub specs: &'a [PreparedRenderSpec],
    /// Bytes this song's prepared cache may occupy in total.
    pub budget_bytes: u64,
    /// Re-reads the spec for a track from the CURRENT model. Returning a
    /// different key from the one rendered means the session moved and the file
    /// is dropped. Returning `None` means the track no longer exists.
    pub current_spec: &'a dyn Fn(&str) -> Option<PreparedRenderSpec>,
}

/// Prepares every track in `request` that needs it.
///
/// Never renders anything if the plan does not fit: an out-of-space failure
/// discovered halfway leaves a half-written cache and a user who has waited for
/// nothing.
pub fn prepare_tracks(
    request: &PreparationRequest<'_>,
    sink: &dyn TrackRenderSink,
    pcm16: bool,
    on_progress: &mut dyn FnMut(PreparationProgress),
    should_cancel: &dyn Fn() -> bool,
) -> PreparationReport {
    let mut report = PreparationReport::default();
    let song_dir = request.song_dir;
    let plan = plan_preparation(song_dir, request.specs);

    if let Err(refusal) = check_room(
        &plan,
        free_space_for(song_dir),
        stored_bytes(song_dir),
        request.budget_bytes,
    ) {
        report.refused = Some(refusal);
        return report;
    }

    let pending: Vec<&PreparedRenderSpec> = request
        .specs
        .iter()
        .filter(|spec| {
            let reusable = load_usable_prepared_render(song_dir, spec).is_ok();
            if reusable {
                report
                    .outcomes
                    .push((spec.track_id.clone(), TrackOutcome::Reused));
            }
            !reusable
        })
        .collect();

    if !pending.is_empty() {
        if let Err(error) = create_prepared_dir(song_dir) {
            for spec in &pending {
                report.outcomes.push((
                    spec.track_id.clone(),
                    TrackOutcome::Failed(format!("no se pudo crear la carpeta de caché: {error}")),
                ));
            }
            return report;
        }
    }

    let track_count = pending.len();
    for (index, spec) in pending.iter().enumerate() {
        if should_cancel() {
            report
                .outcomes
                .push((spec.track_id.clone(), TrackOutcome::Cancelled));
            continue;
        }
        let key = spec.key();
        let temporary: PathBuf = in_progress_audio_path(song_dir, &key);
        let mut cancelled_inside = false;
        let outcome = match sink.render(&spec.track_id, &temporary, pcm16, &mut |done, total| {
            on_progress(PreparationProgress {
                track_id: spec.track_id.clone(),
                track_index: index + 1,
                track_count,
                frames_done: done,
                frames_total: total,
            });
            !should_cancel()
        }) {
            Ok(rendered) => finish_track(song_dir, spec, &key, rendered, request.current_spec),
            Err(RenderFailure::Cancelled) => {
                cancelled_inside = true;
                TrackOutcome::Cancelled
            }
            Err(RenderFailure::Failed(reason)) => TrackOutcome::Failed(reason),
        };
        if cancelled_inside || matches!(outcome, TrackOutcome::Failed(_)) {
            // The sink removes its own partial file, but a temporary from an
            // earlier attempt under the same key would otherwise survive.
            discard(song_dir, &key);
        }
        if let TrackOutcome::Prepared {
            clipped_samples,
            bytes,
        } = &outcome
        {
            report.clipped_samples += clipped_samples;
            report.bytes_written += bytes;
        }
        report.outcomes.push((spec.track_id.clone(), outcome));
    }

    // Whatever no live key claims is dead weight at ~11 MiB per track-minute.
    let live: Vec<String> = request.specs.iter().map(|spec| spec.key()).collect();
    report.bytes_reclaimed = reclaim(song_dir, &live).freed_bytes;
    report
}

/// Publishes one rendered track, unless the session moved while it rendered.
fn finish_track(
    song_dir: &Path,
    spec: &PreparedRenderSpec,
    key: &str,
    rendered: RenderedTrack,
    current_spec: &dyn Fn(&str) -> Option<PreparedRenderSpec>,
) -> TrackOutcome {
    // The second check. See the module note: publishing first and validating
    // afterwards would hand a listener audio that no longer matches the song.
    match current_spec(&spec.track_id) {
        Some(current) if current.key() == key => {}
        _ => {
            discard(song_dir, key);
            return TrackOutcome::Superseded;
        }
    }

    let bytes = match publish_audio(song_dir, key) {
        Ok(bytes) => bytes,
        Err(error) => {
            discard(song_dir, key);
            return TrackOutcome::Failed(format!("no se pudo publicar el audio: {error}"));
        }
    };
    // The engine's own byte count and the file's must agree; if they do not,
    // something truncated the write and the manifest would vouch for it.
    if bytes != rendered.output_bytes {
        discard(song_dir, key);
        return TrackOutcome::Failed(format!(
            "el archivo preparado mide {bytes} bytes y el motor escribió {}",
            rendered.output_bytes
        ));
    }

    let manifest = PreparedRenderManifest {
        version: PREPARED_RENDER_VERSION,
        key: key.to_string(),
        track_id: spec.track_id.clone(),
        timeline_start_frames: rendered.timeline_start_frames,
        sample_rate: spec.sample_rate,
        channels: spec.channels,
        format: spec.format,
        frames: rendered.frames,
        output_bytes: bytes,
        clipped_samples: rendered.clipped_samples,
        created_millis: now_millis(),
    };
    if let Err(error) = publish_prepared_render_manifest(song_dir, &manifest) {
        // Audio without a manifest is invisible and gets swept, which is the
        // safe direction — but leaving it would waste the space until then.
        let _ = std::fs::remove_file(prepared_render_audio_path(song_dir, key));
        return TrackOutcome::Failed(format!("no se pudo publicar el manifiesto: {error}"));
    }
    TrackOutcome::Prepared {
        clipped_samples: rendered.clipped_samples,
        bytes,
    }
}

/// A prepared render a track can play from right now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsablePreparedRender {
    pub track_id: String,
    pub audio_path: PathBuf,
    /// Where the file sits on the timeline. It covers the track's own clips,
    /// not the whole song, so playback has to place it rather than assume zero.
    pub timeline_start_frames: i64,
    pub frames: u64,
}

/// Which of a song's tracks have a prepared render that still matches them.
///
/// This is the read side of the whole feature: called while the session is
/// being handed to the engine, once per load. A track that appears here plays
/// from its file with the stretcher switched off; every other track plays live,
/// exactly as before. A stale file simply does not appear — the key check is
/// what makes "stale" impossible to confuse with "usable".
pub fn usable_prepared_renders(
    song: &Song,
    song_dir: &Path,
    output: &PreparedRenderOutput,
) -> Vec<UsablePreparedRender> {
    song.tracks
        .iter()
        .filter_map(|track| {
            let spec = PreparedRenderSpec::from_song(song, &track.id, song_dir, output)?;
            let manifest = load_usable_prepared_render(song_dir, &spec).ok()?;
            Some(UsablePreparedRender {
                track_id: track.id.clone(),
                audio_path: prepared_render_audio_path(song_dir, &manifest.key),
                timeline_start_frames: manifest.timeline_start_frames,
                frames: manifest.frames,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::prepared_render::{
        prepared_render_manifest_path, PreparedRenderClip, PreparedRenderFormat,
        PreparedRenderOutput, SourceSignature,
    };
    use crate::prepared_render::prepared_render_dir;
    use crate::prepared_render_store::{estimated_bytes, span_frames};
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::fs;
    use tempfile::TempDir;

    const GIB: u64 = 1024 * 1024 * 1024;

    fn spec(track_id: &str, seconds: i64, gain: f64) -> PreparedRenderSpec {
        PreparedRenderSpec {
            track_id: track_id.into(),
            transpose_enabled: true,
            sample_rate: 48_000,
            channels: 2,
            format: PreparedRenderFormat::Pcm16,
            clips: vec![PreparedRenderClip {
                source: SourceSignature {
                    relative_path: "audio/x.wav".into(),
                    size: 10,
                    modified_millis: 20,
                },
                timeline_start_frames: 0,
                source_start_frames: 0,
                length_frames: seconds * 48_000,
                gain,
                fade_in_frames: 0,
                fade_out_frames: 0,
            }],
            regions: vec![],
            tempo: vec![],
            dsp_identity: "engine-1".into(),
        }
    }

    /// Writes the bytes the engine would have written. Records what it was
    /// asked for, so a test can assert on what did NOT get rendered too.
    struct FakeSink {
        rendered: RefCell<Vec<String>>,
        clipped: u64,
        /// Tracks that should fail, and why.
        failures: HashMap<String, RenderFailure>,
        /// Write fewer bytes than reported, to model a truncated render.
        short_by: u64,
    }

    impl FakeSink {
        fn new() -> Self {
            Self {
                rendered: RefCell::new(Vec::new()),
                clipped: 0,
                failures: HashMap::new(),
                short_by: 0,
            }
        }
    }

    impl TrackRenderSink for FakeSink {
        fn render(
            &self,
            track_id: &str,
            output_path: &Path,
            _pcm16: bool,
            on_progress: &mut dyn FnMut(u64, u64) -> bool,
        ) -> Result<RenderedTrack, RenderFailure> {
            self.rendered.borrow_mut().push(track_id.to_string());
            if let Some(failure) = self.failures.get(track_id) {
                return Err(failure.clone());
            }
            // One progress report, honoured the way the engine honours it.
            if !on_progress(1, 2) {
                return Err(RenderFailure::Cancelled);
            }
            let bytes = 44 + 4 * 48_000u64;
            fs::write(output_path, vec![0u8; (bytes - self.short_by) as usize])
                .expect("fake render");
            Ok(RenderedTrack {
                timeline_start_frames: 0,
                frames: 48_000,
                output_bytes: bytes,
                clipped_samples: self.clipped,
            })
        }
    }

    struct Fixture {
        dir: TempDir,
        specs: Vec<PreparedRenderSpec>,
    }

    impl Fixture {
        fn new(specs: Vec<PreparedRenderSpec>) -> Self {
            Self {
                dir: TempDir::new().expect("tempdir"),
                specs,
            }
        }

        fn run(&self, sink: &dyn TrackRenderSink) -> PreparationReport {
            self.run_with(sink, GIB, &|| false, &|id| {
                self.specs.iter().find(|s| s.track_id == id).cloned()
            })
        }

        fn run_with(
            &self,
            sink: &dyn TrackRenderSink,
            budget: u64,
            should_cancel: &dyn Fn() -> bool,
            current: &dyn Fn(&str) -> Option<PreparedRenderSpec>,
        ) -> PreparationReport {
            let request = PreparationRequest {
                song_dir: self.dir.path(),
                specs: &self.specs,
                budget_bytes: budget,
                current_spec: current,
            };
            prepare_tracks(&request, sink, true, &mut |_| {}, should_cancel)
        }
    }

    #[test]
    fn a_prepared_track_is_published_with_a_manifest_that_matches_it() {
        let fixture = Fixture::new(vec![spec("t1", 1, 1.0)]);
        let report = fixture.run(&FakeSink::new());

        assert_eq!(report.prepared_count(), 1);
        assert!(report.refused.is_none());
        assert_eq!(report.failures().count(), 0);

        // And the next run reuses it instead of rendering again.
        let sink = FakeSink::new();
        let again = fixture.run(&sink);
        assert_eq!(again.outcomes, vec![("t1".to_string(), TrackOutcome::Reused)]);
        assert!(sink.rendered.borrow().is_empty(), "nothing should re-render");
    }

    #[test]
    fn a_session_that_moves_during_the_render_throws_the_file_away() {
        // The whole reason the key is checked twice. Publishing this file would
        // put audio in front of a listener that no longer matches the song.
        let fixture = Fixture::new(vec![spec("t1", 1, 1.0)]);
        let edited = spec("t1", 1, 0.5); // the user moved the clip's gain
        let report = fixture.run_with(&FakeSink::new(), GIB, &|| false, &|_| Some(edited.clone()));

        assert_eq!(
            report.outcomes,
            vec![("t1".to_string(), TrackOutcome::Superseded)]
        );
        assert_eq!(report.bytes_written, 0);
        let key = fixture.specs[0].key();
        assert!(!prepared_render_audio_path(fixture.dir.path(), &key).exists());
        assert!(!prepared_render_manifest_path(fixture.dir.path(), &key).exists());
        assert!(!in_progress_audio_path(fixture.dir.path(), &key).exists());
    }

    #[test]
    fn a_track_that_no_longer_exists_is_not_published_either() {
        let fixture = Fixture::new(vec![spec("t1", 1, 1.0)]);
        let report = fixture.run_with(&FakeSink::new(), GIB, &|| false, &|_| None);
        assert_eq!(
            report.outcomes,
            vec![("t1".to_string(), TrackOutcome::Superseded)]
        );
    }

    #[test]
    fn a_plan_that_does_not_fit_the_budget_renders_nothing_at_all() {
        // Refusing halfway would leave a half-written cache and a user who
        // waited for nothing.
        let fixture = Fixture::new(vec![spec("t1", 60, 1.0), spec("t2", 60, 1.0)]);
        let tiny = estimated_bytes(&fixture.specs[0]) / 2;
        let sink = FakeSink::new();
        let report = fixture.run_with(&sink, tiny, &|| false, &|id| {
            fixture.specs.iter().find(|s| s.track_id == id).cloned()
        });

        assert!(matches!(
            report.refused,
            Some(PreparationRefusal::OverBudget { .. })
        ));
        assert!(sink.rendered.borrow().is_empty());
        assert!(report.outcomes.is_empty());
    }

    #[test]
    fn cancelling_stops_and_leaves_nothing_half_written() {
        let fixture = Fixture::new(vec![spec("t1", 1, 1.0), spec("t2", 1, 1.0)]);
        let sink = FakeSink::new();
        // Cancel from the first progress report onwards.
        let report = fixture.run_with(&sink, GIB, &|| true, &|id| {
            fixture.specs.iter().find(|s| s.track_id == id).cloned()
        });

        assert!(report.was_cancelled());
        assert_eq!(report.bytes_written, 0);
        for spec in &fixture.specs {
            let key = spec.key();
            assert!(!prepared_render_audio_path(fixture.dir.path(), &key).exists());
            assert!(!in_progress_audio_path(fixture.dir.path(), &key).exists());
        }
    }

    #[test]
    fn a_truncated_render_is_refused_rather_than_vouched_for() {
        // The engine says it wrote N bytes and the file has fewer. Publishing a
        // manifest that promises N would make every later size check pass.
        let fixture = Fixture::new(vec![spec("t1", 1, 1.0)]);
        let mut sink = FakeSink::new();
        sink.short_by = 100;
        let report = fixture.run(&sink);

        assert_eq!(report.failures().count(), 1);
        let key = fixture.specs[0].key();
        assert!(!prepared_render_manifest_path(fixture.dir.path(), &key).exists());
        assert!(!prepared_render_audio_path(fixture.dir.path(), &key).exists());
    }

    #[test]
    fn one_track_failing_does_not_stop_the_others() {
        let fixture = Fixture::new(vec![spec("t1", 1, 1.0), spec("t2", 1, 1.0)]);
        let mut sink = FakeSink::new();
        sink.failures.insert(
            "t1".into(),
            RenderFailure::Failed("source not loaded: kick".into()),
        );
        let report = fixture.run(&sink);

        assert_eq!(report.prepared_count(), 1);
        let failures: Vec<_> = report.failures().collect();
        assert_eq!(failures, vec![("t1", "source not loaded: kick")]);
        assert!(prepared_render_manifest_path(fixture.dir.path(), &fixture.specs[1].key()).exists());
    }

    #[test]
    fn clipping_is_carried_out_of_the_engine_and_not_swallowed() {
        // PCM16 has a ceiling and warp raises peaks. A prepared file that hit
        // it carries distortion, and the caller has to be able to say so.
        let fixture = Fixture::new(vec![spec("t1", 1, 1.0)]);
        let mut sink = FakeSink::new();
        sink.clipped = 42;
        let report = fixture.run(&sink);
        assert_eq!(report.clipped_samples, 42);
        assert!(matches!(
            report.outcomes[0].1,
            TrackOutcome::Prepared {
                clipped_samples: 42,
                ..
            }
        ));
    }

    #[test]
    fn files_from_a_previous_shape_of_the_session_are_reclaimed() {
        let fixture = Fixture::new(vec![spec("t1", 1, 1.0)]);
        fixture.run(&FakeSink::new());

        // The user edits the clip: the old file is now an orphan, and at
        // ~11 MiB per track-minute it is not something to leave lying around.
        let edited = Fixture {
            dir: TempDir::new().expect("tempdir"),
            specs: vec![spec("t1", 1, 0.25)],
        };
        // Same directory, different spec.
        let stale_key = fixture.specs[0].key();
        fs::create_dir_all(prepared_render_dir(edited.dir.path())).expect("dir");
        fs::write(
            prepared_render_audio_path(edited.dir.path(), &stale_key),
            vec![0u8; 4096],
        )
        .expect("stale");

        let report = edited.run(&FakeSink::new());
        assert!(report.bytes_reclaimed >= 4096);
        assert!(!prepared_render_audio_path(edited.dir.path(), &stale_key).exists());
    }

    #[test]
    fn the_spec_builder_and_the_estimate_agree_on_what_a_track_costs() {
        // Guards the seam between the two: the budget refuses work using the
        // estimate, so an estimate that disagreed with the spec would refuse
        // the wrong preparations.
        let one_minute = spec("t1", 60, 1.0);
        assert_eq!(span_frames(&one_minute), 60 * 48_000);
        assert_eq!(
            estimated_bytes(&one_minute),
            44 + 60 * 48_000 * 2 * 2,
            "PCM16 stereo is four bytes a frame"
        );
    }

    #[test]
    fn a_spec_built_from_a_song_survives_the_round_trip_to_a_key() {
        // The job is driven by specs the host builds from the live model, so a
        // smoke test that the two ends actually connect.
        use libretracks_core::{Clip, Song, Track, TrackKind};
        let dir = TempDir::new().expect("tempdir");
        fs::create_dir_all(dir.path().join("audio")).expect("audio");
        fs::write(dir.path().join("audio/x.wav"), vec![1u8; 64]).expect("source");

        let song = Song {
            id: "s".into(),
            title: "S".into(),
            artist: None,
            key: None,
            bpm: 120.0,
            time_signature: "4/4".into(),
            duration_seconds: 30.0,
            tempo_markers: vec![],
            time_signature_markers: vec![],
            regions: vec![],
            tracks: vec![Track {
                id: "t1".into(),
                name: "T".into(),
                kind: TrackKind::Audio,
                parent_track_id: None,
                volume: 1.0,
                pan: 0.0,
                muted: false,
                solo: false,
                transpose_enabled: true,
                audio_to: "master".into(),
                color: None,
                auto_created: false,
                midi_port: None,
                midi_channel: 1,
                midi_enabled: true,
                collapsed: false,
                height_offset: None,
            }],
            clips: vec![Clip {
                id: "c".into(),
                track_id: "t1".into(),
                file_path: "audio/x.wav".into(),
                timeline_start_seconds: 0.0,
                source_start_seconds: 0.0,
                duration_seconds: 1.0,
                gain: 1.0,
                fade_in_seconds: None,
                fade_out_seconds: None,
                color: None,
            }],
            midi_clips: vec![],
            section_markers: vec![],
        };
        let output = PreparedRenderOutput {
            sample_rate: 48_000,
            channels: 2,
            format: PreparedRenderFormat::Pcm16,
            dsp_identity: "engine-1".into(),
        };
        let built = PreparedRenderSpec::from_song(&song, "t1", dir.path(), &output).expect("spec");

        let fixture = Fixture {
            dir,
            specs: vec![built],
        };
        let report = fixture.run(&FakeSink::new());
        assert_eq!(report.prepared_count(), 1);
    }

    #[test]
    fn only_tracks_with_a_matching_file_are_offered_for_playback() {
        let fixture = Fixture::new(vec![spec("t1", 1, 1.0)]);
        let output = PreparedRenderOutput {
            sample_rate: 48_000,
            channels: 2,
            format: PreparedRenderFormat::Pcm16,
            dsp_identity: "engine-1".into(),
        };
        let song = song_with_one_track(fixture.dir.path());

        // Nothing prepared yet: every track plays live, exactly as before.
        assert!(usable_prepared_renders(&song, fixture.dir.path(), &output).is_empty());

        let built =
            PreparedRenderSpec::from_song(&song, "t1", fixture.dir.path(), &output).expect("spec");
        let prepared = Fixture {
            dir: TempDir::new().expect("tempdir"),
            specs: vec![built.clone()],
        };
        fs::create_dir_all(prepared.dir.path().join("audio")).expect("audio");
        fs::write(prepared.dir.path().join("audio/x.wav"), vec![1u8; 64]).expect("source");
        let built =
            PreparedRenderSpec::from_song(&song, "t1", prepared.dir.path(), &output).expect("spec");
        let prepared = Fixture {
            dir: prepared.dir,
            specs: vec![built],
        };
        prepared.run(&FakeSink::new());

        let offered = usable_prepared_renders(&song, prepared.dir.path(), &output);
        assert_eq!(offered.len(), 1);
        assert_eq!(offered[0].track_id, "t1");
        assert!(offered[0].audio_path.exists());

        // A stale file must never be offered: that is the whole point of the
        // key, and offering it would play audio the song no longer describes.
        let mut edited = song.clone();
        edited.clips[0].gain = 0.5;
        assert!(usable_prepared_renders(&edited, prepared.dir.path(), &output).is_empty());
    }

    fn song_with_one_track(dir: &Path) -> libretracks_core::Song {
        use libretracks_core::{Clip, Song, Track, TrackKind};
        let _ = dir;
        Song {
            id: "s".into(),
            title: "S".into(),
            artist: None,
            key: None,
            bpm: 120.0,
            time_signature: "4/4".into(),
            duration_seconds: 30.0,
            tempo_markers: vec![],
            time_signature_markers: vec![],
            regions: vec![],
            tracks: vec![Track {
                id: "t1".into(),
                name: "T".into(),
                kind: TrackKind::Audio,
                parent_track_id: None,
                volume: 1.0,
                pan: 0.0,
                muted: false,
                solo: false,
                transpose_enabled: true,
                audio_to: "master".into(),
                color: None,
                auto_created: false,
                midi_port: None,
                midi_channel: 1,
                midi_enabled: true,
                collapsed: false,
                height_offset: None,
            }],
            clips: vec![Clip {
                id: "c".into(),
                track_id: "t1".into(),
                file_path: "audio/x.wav".into(),
                timeline_start_seconds: 0.0,
                source_start_seconds: 0.0,
                duration_seconds: 1.0,
                gain: 1.0,
                fade_in_seconds: None,
                fade_out_seconds: None,
                color: None,
            }],
            midi_clips: vec![],
            section_markers: vec![],
        }
    }
}
