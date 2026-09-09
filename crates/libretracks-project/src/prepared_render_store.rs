//! Where prepared renders live on disk, what they are allowed to cost, and how
//! they are published and reclaimed.
//!
//! [`crate::prepared_render`] answers "does this file still match the session".
//! This module answers "is there room, is it written safely, and what can be
//! thrown away". Rendering itself is not here: this never decodes a sample.
//!
//! # Why the room is checked before the first byte
//!
//! Measured on an i7-12700KF, a prepared track costs **10,99 MiB per
//! track-minute in PCM16** and 21,97 in float32 — a four-minute song with
//! twelve prepared tracks is 0,51 GiB or 1,03 GiB. Those numbers are a property
//! of the format, so they transfer to any machine
//! (`docs/plans/audio-engine-performance/08-presupuesto-y-formato.md`).
//!
//! At that size, discovering halfway through that the disk is full is not an
//! inconvenience: it leaves a half-written session behind. The same lesson the
//! session importer already learned — see `check_space_for_extraction` — so the
//! plan is costed up front and refused up front.
//!
//! # Why the span, not the song
//!
//! A prepared file covers the track's own clip span, not the whole timeline. A
//! track holding one ten-second clip in a five-minute song would otherwise pay
//! for five minutes of silence, and a sparse session is the normal case, not
//! the exception. The manifest carries where the span starts so playback can
//! place it.

use std::{
    fs, io,
    path::{Path, PathBuf},
};

use crate::disk_space::free_space_bytes;
use crate::prepared_render::{
    load_usable_prepared_render, prepared_render_audio_path, prepared_render_dir,
    prepared_render_manifest_path, PreparedRenderSpec,
};

/// Bytes kept free on top of what the plan needs. Preparation is not the last
/// thing that touches this disk — the engine's own PCM cache lands here too —
/// so filling the volume to the brim counts as a failure even when the writes
/// themselves would fit. Same reasoning, and same figure, as the importer.
pub const PREPARATION_HEADROOM_BYTES: u64 = 1024 * 1024 * 1024;

/// Bytes a canonical WAV header occupies. The renderer writes exactly this.
const WAV_HEADER_BYTES: u64 = 44;

/// One track's place in a preparation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedRender {
    pub track_id: String,
    pub key: String,
    /// What the file will occupy once written.
    pub estimated_bytes: u64,
    /// True when a usable file is already on disk and nothing has to be done.
    pub already_prepared: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PreparationPlan {
    pub items: Vec<PlannedRender>,
    /// Bytes the preparation still has to write. Excludes what is already there.
    pub bytes_to_write: u64,
    /// Bytes already on disk that this plan will reuse.
    pub bytes_reused: u64,
}

impl PreparationPlan {
    pub fn is_complete(&self) -> bool {
        self.items.iter().all(|item| item.already_prepared)
    }

    pub fn pending(&self) -> impl Iterator<Item = &PlannedRender> {
        self.items.iter().filter(|item| !item.already_prepared)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PreparationRefusal {
    /// The volume cannot hold the plan plus the headroom.
    NotEnoughDiskSpace { needed: u64, free: u64 },
    /// The plan fits on disk but breaks the budget the user allowed the cache.
    OverBudget {
        needed: u64,
        in_use: u64,
        budget: u64,
    },
}

impl std::fmt::Display for PreparationRefusal {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let gb = |bytes: u64| (bytes as f64) / (1024.0 * 1024.0 * 1024.0);
        match self {
            PreparationRefusal::NotEnoughDiskSpace { needed, free } => write!(
                formatter,
                "preparar estas pistas necesita {:.1} GB y solo quedan {:.1} GB libres",
                gb(*needed),
                gb(*free)
            ),
            PreparationRefusal::OverBudget {
                needed,
                in_use,
                budget,
            } => write!(
                formatter,
                "preparar estas pistas ocuparia {:.1} GB sobre los {:.1} GB ya usados, \
                 y el limite de la cache es {:.1} GB",
                gb(*needed),
                gb(*in_use),
                gb(*budget)
            ),
        }
    }
}

/// Frames the prepared file spans: from the track's first clip to the end of
/// its last. Zero when the spec somehow carries no clips.
pub fn span_frames(spec: &PreparedRenderSpec) -> u64 {
    let start = spec
        .clips
        .iter()
        .map(|clip| clip.timeline_start_frames)
        .min()
        .unwrap_or(0);
    let end = spec
        .clips
        .iter()
        .map(|clip| clip.timeline_start_frames + clip.length_frames.max(0))
        .max()
        .unwrap_or(0);
    (end - start).max(0) as u64
}

/// Where the span begins on the timeline, so playback can place the file.
pub fn span_start_frames(spec: &PreparedRenderSpec) -> i64 {
    spec.clips
        .iter()
        .map(|clip| clip.timeline_start_frames)
        .min()
        .unwrap_or(0)
}

/// Exactly what the file will occupy: header plus interleaved samples. Not an
/// approximation — the caller refuses work on this number, so a guess would
/// either block a preparation that fits or admit one that does not.
pub fn estimated_bytes(spec: &PreparedRenderSpec) -> u64 {
    WAV_HEADER_BYTES
        + span_frames(spec)
            * u64::from(spec.channels)
            * spec.format.bytes_per_sample()
}

/// Costs a preparation, marking which tracks already have a usable file.
pub fn plan_preparation(song_dir: impl AsRef<Path>, specs: &[PreparedRenderSpec]) -> PreparationPlan {
    let song_dir = song_dir.as_ref();
    let mut plan = PreparationPlan::default();
    for spec in specs {
        let estimated = estimated_bytes(spec);
        let already_prepared = load_usable_prepared_render(song_dir, spec).is_ok();
        if already_prepared {
            plan.bytes_reused += estimated;
        } else {
            plan.bytes_to_write += estimated;
        }
        plan.items.push(PlannedRender {
            track_id: spec.track_id.clone(),
            key: spec.key(),
            estimated_bytes: estimated,
            already_prepared,
        });
    }
    plan
}

/// Decides whether a plan may proceed.
///
/// Pure function of its inputs so the policy is testable without a filesystem,
/// which is the only way to check the boundary cases that matter. `free_bytes`
/// of `None` means the volume could not be measured; that is not treated as
/// zero, because refusing on an unmeasurable filesystem would block the feature
/// outright on the ones we cannot stat.
pub fn check_room(
    plan: &PreparationPlan,
    free_bytes: Option<u64>,
    in_use_bytes: u64,
    budget_bytes: u64,
) -> Result<(), PreparationRefusal> {
    let needed = plan.bytes_to_write;
    if needed == 0 {
        return Ok(());
    }
    if let Some(free) = free_bytes {
        if free < needed.saturating_add(PREPARATION_HEADROOM_BYTES) {
            return Err(PreparationRefusal::NotEnoughDiskSpace { needed, free });
        }
    }
    if in_use_bytes.saturating_add(needed) > budget_bytes {
        return Err(PreparationRefusal::OverBudget {
            needed,
            in_use: in_use_bytes,
            budget: budget_bytes,
        });
    }
    Ok(())
}

/// Free space on the volume holding the song, for [`check_room`].
pub fn free_space_for(song_dir: impl AsRef<Path>) -> Option<u64> {
    free_space_bytes(&prepared_render_dir(song_dir))
}

/// Bytes the prepared cache of this song currently occupies, temporaries
/// included: a crashed run's leftovers are real bytes on a real disk.
pub fn stored_bytes(song_dir: impl AsRef<Path>) -> u64 {
    let Ok(entries) = fs::read_dir(prepared_render_dir(song_dir)) else {
        return 0;
    };
    entries
        .flatten()
        .filter_map(|entry| entry.metadata().ok())
        .filter(|metadata| metadata.is_file())
        .map(|metadata| metadata.len())
        .sum()
}

/// Where a render is written while it is still being produced.
///
/// Renders go to a temporary and are renamed into place, so a reader can never
/// open a file that is still growing. The extension is deliberate: [`reclaim`]
/// sweeps `.part` files, which is what a run killed halfway leaves behind.
pub fn in_progress_audio_path(song_dir: impl AsRef<Path>, key: &str) -> PathBuf {
    prepared_render_dir(song_dir).join(format!("{key}.ltprep.part"))
}

pub fn create_prepared_dir(song_dir: impl AsRef<Path>) -> io::Result<PathBuf> {
    let directory = prepared_render_dir(song_dir);
    fs::create_dir_all(&directory)?;
    Ok(directory)
}

/// Moves a finished render into place and reports its size.
///
/// The rename is what makes publication atomic. The manifest is written after
/// this, by [`crate::prepared_render::publish_prepared_render_manifest`], and
/// that order matters: audio without a manifest is invisible and gets swept up,
/// whereas a manifest without its audio would advertise a file that is not
/// there.
pub fn publish_audio(song_dir: impl AsRef<Path>, key: &str) -> io::Result<u64> {
    let song_dir = song_dir.as_ref();
    let temporary = in_progress_audio_path(song_dir, key);
    let final_path = prepared_render_audio_path(song_dir, key);
    let size = fs::metadata(&temporary)?.len();
    fs::rename(&temporary, &final_path)?;
    Ok(size)
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ReclaimReport {
    pub removed_files: usize,
    pub freed_bytes: u64,
    /// Files we wanted to remove and could not. Reported rather than swallowed:
    /// a cache that silently fails to shrink looks exactly like one that has
    /// nothing to shrink.
    pub failed: Vec<PathBuf>,
}

/// Deletes everything in the prepared directory that no live key claims,
/// including the temporaries of interrupted runs.
///
/// Cancelling a preparation halfway is a normal outcome — the user closes the
/// session, or edits a clip — so the leftovers have to be swept rather than
/// left to accumulate at 11 MiB per track-minute.
pub fn reclaim(song_dir: impl AsRef<Path>, live_keys: &[String]) -> ReclaimReport {
    let song_dir = song_dir.as_ref();
    let directory = prepared_render_dir(song_dir);
    let Ok(entries) = fs::read_dir(&directory) else {
        return ReclaimReport::default();
    };
    let mut report = ReclaimReport::default();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let claimed = [".ltprep.wav", ".ltprep.json"].iter().any(|suffix| {
            name.strip_suffix(suffix)
                .is_some_and(|key| live_keys.iter().any(|live| live == key))
        });
        if claimed {
            continue;
        }
        let size = entry.metadata().map(|metadata| metadata.len()).unwrap_or(0);
        match fs::remove_file(&path) {
            Ok(()) => {
                report.removed_files += 1;
                report.freed_bytes += size;
            }
            Err(_) => report.failed.push(path),
        }
    }
    report
}

/// Removes the audio and manifest of one key, for a render the caller has
/// decided to abandon. Missing files are not an error: the point is that the
/// key is gone afterwards.
pub fn discard(song_dir: impl AsRef<Path>, key: &str) -> ReclaimReport {
    let song_dir = song_dir.as_ref();
    let mut report = ReclaimReport::default();
    for path in [
        prepared_render_audio_path(song_dir, key),
        prepared_render_manifest_path(song_dir, key),
        in_progress_audio_path(song_dir, key),
    ] {
        let Ok(metadata) = fs::metadata(&path) else {
            continue;
        };
        match fs::remove_file(&path) {
            Ok(()) => {
                report.removed_files += 1;
                report.freed_bytes += metadata.len();
            }
            Err(_) => report.failed.push(path),
        }
    }
    report
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::prepared_render::{
        publish_prepared_render_manifest, now_millis, PreparedRenderClip, PreparedRenderFormat,
        PreparedRenderManifest, SourceSignature, PREPARED_RENDER_VERSION,
    };
    use tempfile::TempDir;

    const MIB: u64 = 1024 * 1024;
    const GIB: u64 = 1024 * MIB;

    fn clip(start_frames: i64, length_frames: i64) -> PreparedRenderClip {
        PreparedRenderClip {
            source: SourceSignature {
                relative_path: "audio/x.wav".into(),
                size: 1,
                modified_millis: 1,
            },
            timeline_start_frames: start_frames,
            source_start_frames: 0,
            length_frames,
            gain: 1.0,
            fade_in_frames: 0,
            fade_out_frames: 0,
        }
    }

    fn spec(track_id: &str, clips: Vec<PreparedRenderClip>) -> PreparedRenderSpec {
        PreparedRenderSpec {
            track_id: track_id.into(),
            transpose_enabled: true,
            sample_rate: 48_000,
            channels: 2,
            format: PreparedRenderFormat::Pcm16,
            clips,
            regions: vec![],
            tempo: vec![],
            dsp_identity: "engine-1".into(),
        }
    }

    /// The published rate is 10,99 MiB per track-minute in PCM16 and 21,97 in
    /// float32. A change that quietly broke the estimate would break every
    /// refusal built on it, so it is pinned against those measurements.
    #[test]
    fn the_estimate_matches_the_measured_rate_per_track_minute() {
        let minute = 60 * 48_000;
        let pcm16 = estimated_bytes(&spec("t", vec![clip(0, minute)]));
        let mib = |bytes: u64| (bytes as f64) / (MIB as f64);
        assert!(
            (mib(pcm16) - 10.99).abs() < 0.01,
            "PCM16 came out at {:.2} MiB per track-minute",
            mib(pcm16)
        );

        let mut float = spec("t", vec![clip(0, minute)]);
        float.format = PreparedRenderFormat::Float32;
        assert!((mib(estimated_bytes(&float)) - 21.97).abs() < 0.01);
    }

    /// The point of costing the span and not the song: a short clip late in a
    /// long song must not pay for the silence around it.
    #[test]
    fn only_the_clip_span_is_paid_for() {
        let ten_seconds = 10 * 48_000;
        let late = spec("t", vec![clip(300 * 48_000, ten_seconds)]);
        assert_eq!(span_frames(&late), ten_seconds as u64);
        assert_eq!(span_start_frames(&late), 300 * 48_000);

        let whole_song = spec("t", vec![clip(0, 300 * 48_000 + ten_seconds)]);
        assert!(
            estimated_bytes(&late) * 30 < estimated_bytes(&whole_song),
            "a sparse track must cost far less than a full one"
        );

        // Two clips with a gap: the span covers both and the hole between them,
        // because the file is one continuous stretch of timeline.
        let gapped = spec("t", vec![clip(0, ten_seconds), clip(100 * 48_000, ten_seconds)]);
        assert_eq!(span_frames(&gapped), (100 * 48_000 + ten_seconds) as u64);
    }

    #[test]
    fn a_plan_costs_only_what_is_not_already_prepared() {
        let dir = TempDir::new().expect("tempdir");
        let minute = 60 * 48_000;
        let first = spec("t1", vec![clip(0, minute)]);
        let second = spec("t2", vec![clip(0, minute)]);

        let plan = plan_preparation(dir.path(), &[first.clone(), second.clone()]);
        assert_eq!(plan.bytes_to_write, estimated_bytes(&first) * 2);
        assert_eq!(plan.bytes_reused, 0);
        assert!(!plan.is_complete());
        assert_eq!(plan.pending().count(), 2);

        // Publish the first one and the plan stops charging for it.
        create_prepared_dir(dir.path()).expect("dir");
        let key = first.key();
        fs::write(
            in_progress_audio_path(dir.path(), &key),
            vec![0u8; estimated_bytes(&first) as usize],
        )
        .expect("render");
        let written = publish_audio(dir.path(), &key).expect("publish");
        publish_prepared_render_manifest(
            dir.path(),
            &PreparedRenderManifest {
                version: PREPARED_RENDER_VERSION,
                key: key.clone(),
                track_id: "t1".into(),
                timeline_start_frames: 0,
                sample_rate: 48_000,
                channels: 2,
                format: PreparedRenderFormat::Pcm16,
                frames: minute as u64,
                output_bytes: written,
                clipped_samples: 0,
                created_millis: now_millis(),
            },
        )
        .expect("manifest");

        let plan = plan_preparation(dir.path(), &[first.clone(), second.clone()]);
        assert_eq!(plan.bytes_to_write, estimated_bytes(&second));
        assert_eq!(plan.bytes_reused, estimated_bytes(&first));
        assert_eq!(plan.pending().count(), 1);
        assert_eq!(plan.pending().next().unwrap().track_id, "t2");
    }

    #[test]
    fn a_plan_that_does_not_fit_is_refused_before_anything_is_written() {
        let plan = PreparationPlan {
            items: vec![],
            bytes_to_write: 2 * GIB,
            bytes_reused: 0,
        };

        // Room for the writes but not for the headroom the engine's own cache
        // still needs afterwards.
        assert_eq!(
            check_room(&plan, Some(2 * GIB + 100 * MIB), 0, 100 * GIB),
            Err(PreparationRefusal::NotEnoughDiskSpace {
                needed: 2 * GIB,
                free: 2 * GIB + 100 * MIB
            })
        );
        assert!(check_room(&plan, Some(2 * GIB + PREPARATION_HEADROOM_BYTES), 0, 100 * GIB).is_ok());

        // Fits on disk, breaks the cache budget.
        assert_eq!(
            check_room(&plan, Some(500 * GIB), 3 * GIB, 4 * GIB),
            Err(PreparationRefusal::OverBudget {
                needed: 2 * GIB,
                in_use: 3 * GIB,
                budget: 4 * GIB
            })
        );

        // An unmeasurable volume is not treated as a full one: refusing there
        // would disable the feature on every filesystem we cannot stat.
        assert!(check_room(&plan, None, 0, 100 * GIB).is_ok());

        // Nothing to write is always allowed, however tight the disk is.
        let done = PreparationPlan::default();
        assert!(check_room(&done, Some(0), 100 * GIB, 1).is_ok());
    }

    #[test]
    fn the_refusal_says_what_is_wrong_in_the_user_s_terms() {
        let refusal = PreparationRefusal::NotEnoughDiskSpace {
            needed: 2 * GIB,
            free: 512 * MIB,
        };
        let message = refusal.to_string();
        assert!(message.contains("2.0 GB"), "{message}");
        assert!(message.contains("0.5 GB"), "{message}");
    }

    #[test]
    fn audio_is_invisible_until_the_rename_publishes_it() {
        let dir = TempDir::new().expect("tempdir");
        create_prepared_dir(dir.path()).expect("dir");
        let key = "abc123";

        fs::write(in_progress_audio_path(dir.path(), key), vec![1u8; 900]).expect("render");
        assert!(
            !prepared_render_audio_path(dir.path(), key).exists(),
            "a render still being written must not be visible under its final name"
        );

        assert_eq!(publish_audio(dir.path(), key).expect("publish"), 900);
        assert!(prepared_render_audio_path(dir.path(), key).exists());
        assert!(!in_progress_audio_path(dir.path(), key).exists());
        assert_eq!(stored_bytes(dir.path()), 900);

        // Publishing something that was never rendered is an error, not a
        // silent success that would leave a manifest pointing at nothing.
        assert!(publish_audio(dir.path(), "never-rendered").is_err());
    }

    #[test]
    fn reclaim_sweeps_stale_renders_and_the_leftovers_of_an_interrupted_one() {
        let dir = TempDir::new().expect("tempdir");
        create_prepared_dir(dir.path()).expect("dir");
        let live = "live-key";
        let stale = "stale-key";

        for key in [live, stale] {
            fs::write(prepared_render_audio_path(dir.path(), key), vec![0u8; 400]).expect("audio");
            fs::write(prepared_render_manifest_path(dir.path(), key), b"{}").expect("manifest");
        }
        // What a run killed halfway leaves behind.
        fs::write(in_progress_audio_path(dir.path(), "interrupted"), vec![0u8; 700])
            .expect("partial");

        let report = reclaim(dir.path(), &[live.to_string()]);
        assert_eq!(report.removed_files, 3, "stale pair plus the partial");
        assert_eq!(report.freed_bytes, 400 + 2 + 700);
        assert!(report.failed.is_empty());
        assert!(prepared_render_audio_path(dir.path(), live).exists());
        assert!(!prepared_render_audio_path(dir.path(), stale).exists());
        assert!(!in_progress_audio_path(dir.path(), "interrupted").exists());
    }

    #[test]
    fn discarding_one_render_leaves_the_others_alone() {
        let dir = TempDir::new().expect("tempdir");
        create_prepared_dir(dir.path()).expect("dir");
        fs::write(prepared_render_audio_path(dir.path(), "a"), vec![0u8; 100]).expect("a");
        fs::write(prepared_render_manifest_path(dir.path(), "a"), b"{}").expect("a manifest");
        fs::write(prepared_render_audio_path(dir.path(), "b"), vec![0u8; 200]).expect("b");

        let report = discard(dir.path(), "a");
        assert_eq!(report.removed_files, 2);
        assert_eq!(report.freed_bytes, 102);
        assert!(prepared_render_audio_path(dir.path(), "b").exists());

        // Discarding what is not there is not an error: the postcondition is
        // that the key is gone, and it already is.
        let again = discard(dir.path(), "a");
        assert_eq!(again.removed_files, 0);
        assert!(again.failed.is_empty());
    }
}
