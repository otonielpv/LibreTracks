//! Track hierarchy helpers over a `&[Track]`: insertion, reparenting, subtree
//! bounds, depth and folder-descendant checks. Pure functions with no `self` —
//! the arrangement methods in `arrangement.rs` and the folder edits in `mod.rs`
//! call them to keep the `parent_track_id` tree consistent.

use libretracks_core::{Track, TrackKind};

use crate::error::DesktopError;

pub(super) fn insert_track(
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

pub(super) fn reparent_track(
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

pub(super) fn delete_track_and_repair_hierarchy(
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

pub(super) fn resolve_insert_index(
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

pub(super) fn validate_track_parent(
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

pub(super) fn is_descendant_of(
    tracks: &[Track],
    candidate_parent_id: Option<&str>,
    track_id: &str,
) -> bool {
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

pub(super) fn track_subtree_bounds(
    tracks: &[Track],
    track_id: &str,
) -> Result<(usize, usize), DesktopError> {
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

pub(super) fn track_depth_from_tracks(
    tracks: &[Track],
    track_id: &str,
) -> Result<usize, DesktopError> {
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
