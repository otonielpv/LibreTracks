use std::collections::HashSet;

use thiserror::Error;

use crate::model::{Song, TrackKind};

#[derive(Debug, Error, PartialEq, Eq)]
pub enum DomainError {
    #[error("song must have a title")]
    MissingTitle,
    #[error("song duration must be greater than zero")]
    InvalidDuration,
    #[error("region {region_id} has invalid bounds")]
    InvalidRegionBounds { region_id: String },
    #[error("regions are out of order or overlap: {previous_region_id} before {region_id}")]
    RegionsOutOfOrder {
        previous_region_id: String,
        region_id: String,
    },
    #[error("duplicate track id: {0}")]
    DuplicateTrackId(String),
    #[error("duplicate clip id: {0}")]
    DuplicateClipId(String),
    #[error("track {track_id} references unknown parent track {parent_track_id}")]
    UnknownParentTrack {
        track_id: String,
        parent_track_id: String,
    },
    #[error("track {track_id} must be parented to a folder track, got {parent_track_id}")]
    ParentTrackMustBeFolder {
        track_id: String,
        parent_track_id: String,
    },
    #[error("track {track_id} cannot parent itself")]
    SelfParentTrack { track_id: String },
    #[error("track hierarchy contains a cycle involving {track_id}")]
    TrackHierarchyCycle { track_id: String },
    #[error("clip {clip_id} references unknown track {track_id}")]
    UnknownTrack { clip_id: String, track_id: String },
    #[error("clip {clip_id} cannot target folder track {track_id}")]
    ClipTargetsFolderTrack { clip_id: String, track_id: String },
    #[error("marker {marker_id} has invalid position")]
    InvalidMarkerPosition { marker_id: String },
    #[error("markers are out of order: {previous_marker_id} before {marker_id}")]
    MarkersOutOfOrder {
        previous_marker_id: String,
        marker_id: String,
    },
    #[error("marker {marker_id} has invalid digit {digit}")]
    InvalidMarkerDigit { marker_id: String, digit: u8 },
    #[error("marker digit is duplicated: {digit}")]
    DuplicateMarkerDigit { digit: u8 },
}

pub fn validate_song(song: &Song) -> Result<(), DomainError> {
    if song.title.trim().is_empty() {
        return Err(DomainError::MissingTitle);
    }

    if song.duration_seconds <= 0.0 {
        return Err(DomainError::InvalidDuration);
    }

    let mut previous_region_id: Option<&str> = None;
    let mut previous_region_end_seconds: Option<f64> = None;
    for region in &song.regions {
        if !(0.0..=song.duration_seconds).contains(&region.start_seconds)
            || !(0.0..=song.duration_seconds).contains(&region.end_seconds)
            || region.end_seconds <= region.start_seconds
        {
            return Err(DomainError::InvalidRegionBounds {
                region_id: region.id.clone(),
            });
        }

        if let Some(previous_end_seconds) = previous_region_end_seconds {
            if region.start_seconds < previous_end_seconds {
                return Err(DomainError::RegionsOutOfOrder {
                    previous_region_id: previous_region_id.unwrap_or_default().to_string(),
                    region_id: region.id.clone(),
                });
            }
        }

        previous_region_id = Some(region.id.as_str());
        previous_region_end_seconds = Some(region.end_seconds);
    }

    let mut track_ids = HashSet::new();
    for track in &song.tracks {
        if !track_ids.insert(track.id.as_str()) {
            return Err(DomainError::DuplicateTrackId(track.id.clone()));
        }
    }

    let mut clip_ids = HashSet::new();
    for clip in &song.clips {
        if !clip_ids.insert(clip.id.as_str()) {
            return Err(DomainError::DuplicateClipId(clip.id.clone()));
        }

        let track = song
            .tracks
            .iter()
            .find(|track| track.id == clip.track_id)
            .ok_or_else(|| DomainError::UnknownTrack {
                clip_id: clip.id.clone(),
                track_id: clip.track_id.clone(),
            })?;

        if track.kind == TrackKind::Folder {
            return Err(DomainError::ClipTargetsFolderTrack {
                clip_id: clip.id.clone(),
                track_id: clip.track_id.clone(),
            });
        }
    }

    for track in &song.tracks {
        if let Some(parent_track_id) = &track.parent_track_id {
            if parent_track_id == &track.id {
                return Err(DomainError::SelfParentTrack {
                    track_id: track.id.clone(),
                });
            }

            let parent_track = song
                .tracks
                .iter()
                .find(|candidate| &candidate.id == parent_track_id)
                .ok_or_else(|| DomainError::UnknownParentTrack {
                    track_id: track.id.clone(),
                    parent_track_id: parent_track_id.clone(),
                })?;

            if parent_track.kind != TrackKind::Folder {
                return Err(DomainError::ParentTrackMustBeFolder {
                    track_id: track.id.clone(),
                    parent_track_id: parent_track_id.clone(),
                });
            }
        }
    }

    for track in &song.tracks {
        let mut visited = HashSet::new();
        let mut cursor = track.parent_track_id.as_deref();
        while let Some(parent_track_id) = cursor {
            if !visited.insert(parent_track_id) {
                return Err(DomainError::TrackHierarchyCycle {
                    track_id: track.id.clone(),
                });
            }

            cursor = song
                .tracks
                .iter()
                .find(|candidate| candidate.id == parent_track_id)
                .and_then(|candidate| candidate.parent_track_id.as_deref());
        }
    }

    let mut previous_marker_id: Option<&str> = None;
    let mut previous_marker_start_seconds: Option<f64> = None;
    let mut used_digits = HashSet::new();

    for marker in &song.section_markers {
        if marker.start_seconds < 0.0 {
            return Err(DomainError::InvalidMarkerPosition {
                marker_id: marker.id.clone(),
            });
        }

        if let Some(previous_start_seconds) = previous_marker_start_seconds {
            if marker.start_seconds <= previous_start_seconds {
                return Err(DomainError::MarkersOutOfOrder {
                    previous_marker_id: previous_marker_id.unwrap_or_default().to_string(),
                    marker_id: marker.id.clone(),
                });
            }
        }

        if let Some(digit) = marker.digit {
            if digit > 9 {
                return Err(DomainError::InvalidMarkerDigit {
                    marker_id: marker.id.clone(),
                    digit,
                });
            }

            if !used_digits.insert(digit) {
                return Err(DomainError::DuplicateMarkerDigit { digit });
            }
        }

        previous_marker_id = Some(marker.id.as_str());
        previous_marker_start_seconds = Some(marker.start_seconds);
    }

    Ok(())
}
