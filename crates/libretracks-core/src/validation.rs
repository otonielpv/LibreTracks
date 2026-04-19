use std::collections::HashSet;

use thiserror::Error;

use crate::model::Song;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum DomainError {
    #[error("song must have a title")]
    MissingTitle,
    #[error("song bpm must be greater than zero")]
    InvalidBpm,
    #[error("song duration must be greater than zero")]
    InvalidDuration,
    #[error("duplicate track id: {0}")]
    DuplicateTrackId(String),
    #[error("duplicate group id: {0}")]
    DuplicateGroupId(String),
    #[error("duplicate clip id: {0}")]
    DuplicateClipId(String),
    #[error("track {track_id} references unknown group {group_id}")]
    UnknownGroup { track_id: String, group_id: String },
    #[error("clip {clip_id} references unknown track {track_id}")]
    UnknownTrack { clip_id: String, track_id: String },
    #[error("section {section_id} has invalid range")]
    InvalidSectionRange { section_id: String },
}

pub fn validate_song(song: &Song) -> Result<(), DomainError> {
    if song.title.trim().is_empty() {
        return Err(DomainError::MissingTitle);
    }

    if song.bpm <= 0.0 {
        return Err(DomainError::InvalidBpm);
    }

    if song.duration_seconds <= 0.0 {
        return Err(DomainError::InvalidDuration);
    }

    let mut track_ids = HashSet::new();
    for track in &song.tracks {
        if !track_ids.insert(track.id.as_str()) {
            return Err(DomainError::DuplicateTrackId(track.id.clone()));
        }
    }

    let mut group_ids = HashSet::new();
    for group in &song.groups {
        if !group_ids.insert(group.id.as_str()) {
            return Err(DomainError::DuplicateGroupId(group.id.clone()));
        }
    }

    let mut clip_ids = HashSet::new();
    for clip in &song.clips {
        if !clip_ids.insert(clip.id.as_str()) {
            return Err(DomainError::DuplicateClipId(clip.id.clone()));
        }

        if !track_ids.contains(clip.track_id.as_str()) {
            return Err(DomainError::UnknownTrack {
                clip_id: clip.id.clone(),
                track_id: clip.track_id.clone(),
            });
        }
    }

    for track in &song.tracks {
        if let Some(group_id) = &track.group_id {
            if !group_ids.contains(group_id.as_str()) {
                return Err(DomainError::UnknownGroup {
                    track_id: track.id.clone(),
                    group_id: group_id.clone(),
                });
            }
        }
    }

    for section in &song.sections {
        if section.end_seconds <= section.start_seconds {
            return Err(DomainError::InvalidSectionRange {
                section_id: section.id.clone(),
            });
        }
    }

    Ok(())
}
