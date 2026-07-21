//! Free helpers that rewrite a `Song`'s clips and regions: clip-window
//! validation, appending a clip (creating an auto-track/region if needed),
//! batch clip moves with region reshape, and the empty-region / auto-track
//! pruning that runs after edits. Shared by `arrangement.rs`, `regions.rs` and
//! `mod.rs`; pure functions, no `self`.

use std::path::Path;

use libretracks_core::{Clip, Song, SongRegion, TrackKind};
use libretracks_project::read_audio_metadata;

use crate::error::DesktopError;

use super::{
    resolve_audio_file_path, sort_song_regions, timestamp_suffix, ClipMoveRequest,
    CreateClipRequest,
};

pub(super) fn normalize_timeline_start_seconds(value: f64) -> f64 {
    if value.is_finite() {
        value
    } else {
        0.0
    }
}

pub(super) fn validate_clip_window(
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

pub(super) fn append_clip_to_song(
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
pub(super) fn ensure_region_covers_clip(
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
pub(super) fn apply_clip_moves_with_region_reshape(
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
pub(super) fn prune_empty_regions(song: &mut Song) {
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
pub(super) fn file_stem_for_auto_track(file_path: &str) -> String {
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

pub(super) fn prune_auto_created_empty_tracks(song: &mut Song) {
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
