use std::collections::HashSet;

use thiserror::Error;

use crate::model::{
    MidiEvent, MidiEventKind, Song, TrackKind, MAX_MIDI_CHANNEL, MAX_MIDI_DATA_VALUE,
    MIN_MIDI_CHANNEL,
};

pub const MIN_TRANSPOSE_SEMITONES: i32 = -12;
pub const MAX_TRANSPOSE_SEMITONES: i32 = 12;

pub const MIN_WARP_SOURCE_BPM: f64 = 20.0;
pub const MAX_WARP_SOURCE_BPM: f64 = 300.0;
const CLIP_REGION_BOUNDARY_EPSILON_SECONDS: f64 = 1.0e-6;

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
    #[error("time signature marker {marker_id} has invalid position")]
    InvalidTimeSignatureMarkerPosition { marker_id: String },
    #[error("time signature markers are out of order: {previous_marker_id} before {marker_id}")]
    TimeSignatureMarkersOutOfOrder {
        previous_marker_id: String,
        marker_id: String,
    },
    #[error("time signature marker {marker_id} is invalid: {signature}")]
    InvalidTimeSignatureMarker {
        marker_id: String,
        signature: String,
    },
    #[error("region {region_id} has invalid transpose semitones {transpose_semitones}")]
    InvalidRegionTranspose {
        region_id: String,
        transpose_semitones: i32,
    },
    #[error("region {region_id} has warp enabled but no source bpm configured")]
    WarpEnabledWithoutSourceBpm { region_id: String },
    #[error("region {region_id} has invalid warp source bpm {source_bpm}")]
    InvalidWarpSourceBpm {
        region_id: String,
        source_bpm: String,
    },
    #[error("region {region_id} has invalid master gain {gain}")]
    InvalidRegionMasterGain { region_id: String, gain: String },
    #[error("clip {clip_id} at {clip_start_seconds}s falls outside every region")]
    ClipOutsideAnyRegion {
        clip_id: String,
        clip_start_seconds: String,
    },
    #[error("clip {clip_id} spans the boundary between region {region_id} and the next region")]
    ClipCrossesRegionBoundary { clip_id: String, region_id: String },
    #[error("duplicate midi clip id: {0}")]
    DuplicateMidiClipId(String),
    #[error("midi clip {clip_id} references unknown track {track_id}")]
    UnknownMidiClipTrack { clip_id: String, track_id: String },
    #[error("midi clip {clip_id} must target a midi track, got {track_id}")]
    MidiClipTargetsNonMidiTrack { clip_id: String, track_id: String },
    #[error("audio clip {clip_id} cannot target midi track {track_id}")]
    ClipTargetsMidiTrack { clip_id: String, track_id: String },
    #[error("midi clip {clip_id} has invalid position {start_seconds}")]
    InvalidMidiClipPosition {
        clip_id: String,
        start_seconds: String,
    },
    #[error("duplicate midi event id {event_id} in clip {clip_id}")]
    DuplicateMidiEventId { clip_id: String, event_id: String },
    #[error("midi event {event_id} has invalid channel {channel}")]
    InvalidMidiChannel { event_id: String, channel: u8 },
    #[error("midi event {event_id} has invalid {field} value {value}")]
    InvalidMidiDataValue {
        event_id: String,
        field: &'static str,
        value: u8,
    },
    #[error("midi event {event_id} has invalid offset or duration")]
    InvalidMidiEventTiming { event_id: String },
    #[error("midi track {track_id} has invalid channel {channel}")]
    InvalidMidiTrackChannel { track_id: String, channel: u8 },
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
        if region.start_seconds < 0.0 || region.end_seconds <= region.start_seconds {
            return Err(DomainError::InvalidRegionBounds {
                region_id: region.id.clone(),
            });
        }

        if !(MIN_TRANSPOSE_SEMITONES..=MAX_TRANSPOSE_SEMITONES)
            .contains(&region.transpose_semitones)
        {
            return Err(DomainError::InvalidRegionTranspose {
                region_id: region.id.clone(),
                transpose_semitones: region.transpose_semitones,
            });
        }

        // Warp validation: a source BPM may be persisted while warp is off
        // (so toggling preserves the user's value), but if warp is on it
        // MUST be present and within the supported range.
        if let Some(source_bpm) = region.warp_source_bpm {
            if !source_bpm.is_finite()
                || !(MIN_WARP_SOURCE_BPM..=MAX_WARP_SOURCE_BPM).contains(&source_bpm)
            {
                return Err(DomainError::InvalidWarpSourceBpm {
                    region_id: region.id.clone(),
                    source_bpm: format!("{}", source_bpm),
                });
            }
        } else if region.warp_enabled {
            return Err(DomainError::WarpEnabledWithoutSourceBpm {
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

        if !region.master.gain.is_finite() || region.master.gain < 0.0 {
            return Err(DomainError::InvalidRegionMasterGain {
                region_id: region.id.clone(),
                gain: format!("{}", region.master.gain),
            });
        }

        previous_region_id = Some(region.id.as_str());
        previous_region_end_seconds = Some(region.end_seconds);
    }

    let mut track_ids = HashSet::new();
    for track in &song.tracks {
        if !track_ids.insert(track.id.as_str()) {
            return Err(DomainError::DuplicateTrackId(track.id.clone()));
        }

        // The channel only means anything on a MIDI track; other kinds carry
        // the serde default and are not held to it.
        if track.kind == TrackKind::Midi
            && !(MIN_MIDI_CHANNEL..=MAX_MIDI_CHANNEL).contains(&track.midi_channel)
        {
            return Err(DomainError::InvalidMidiTrackChannel {
                track_id: track.id.clone(),
                channel: track.midi_channel,
            });
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

        if track.kind == TrackKind::Midi {
            return Err(DomainError::ClipTargetsMidiTrack {
                clip_id: clip.id.clone(),
                track_id: clip.track_id.clone(),
            });
        }

        // Invariant: every clip lives inside exactly one region.
        // - The start of the clip (clip.timeline_start_seconds) must fall in
        //   [region.start, region.end) of some region.
        // - The end of the clip (start + duration) must fall in the same
        //   region; spanning a boundary is rejected.
        // Songs with no regions skip this check so empty-project bootstrap is
        // valid. The auto-create-region flow in the desktop layer guarantees
        // any non-empty timeline has at least one region.
        if !song.regions.is_empty() {
            let clip_start = clip.timeline_start_seconds;
            let clip_end = clip_start + clip.duration_seconds;
            let containing_region = song.regions.iter().find(|region| {
                clip_start >= region.start_seconds && clip_start < region.end_seconds
            });
            let containing_region = match containing_region {
                Some(region) => region,
                None => {
                    return Err(DomainError::ClipOutsideAnyRegion {
                        clip_id: clip.id.clone(),
                        clip_start_seconds: format!("{}", clip_start),
                    });
                }
            };
            if clip_end > containing_region.end_seconds + CLIP_REGION_BOUNDARY_EPSILON_SECONDS {
                return Err(DomainError::ClipCrossesRegionBoundary {
                    clip_id: clip.id.clone(),
                    region_id: containing_region.id.clone(),
                });
            }
        }
    }

    // MIDI clips are validated against their own list. Note they are NOT
    // subject to the "clip lives inside exactly one region" invariant: a clip
    // is a point that fires messages, and a controller sweep crossing a region
    // boundary is legitimate — nothing downstream slices MIDI per region the
    // way the mixer slices audio.
    let mut midi_clip_ids = HashSet::new();
    for midi_clip in &song.midi_clips {
        if !midi_clip_ids.insert(midi_clip.id.as_str()) {
            return Err(DomainError::DuplicateMidiClipId(midi_clip.id.clone()));
        }

        if !midi_clip.timeline_start_seconds.is_finite() || midi_clip.timeline_start_seconds < 0.0 {
            return Err(DomainError::InvalidMidiClipPosition {
                clip_id: midi_clip.id.clone(),
                start_seconds: format!("{}", midi_clip.timeline_start_seconds),
            });
        }

        let track = song
            .tracks
            .iter()
            .find(|track| track.id == midi_clip.track_id)
            .ok_or_else(|| DomainError::UnknownMidiClipTrack {
                clip_id: midi_clip.id.clone(),
                track_id: midi_clip.track_id.clone(),
            })?;

        if track.kind != TrackKind::Midi {
            return Err(DomainError::MidiClipTargetsNonMidiTrack {
                clip_id: midi_clip.id.clone(),
                track_id: midi_clip.track_id.clone(),
            });
        }

        let mut event_ids = HashSet::new();
        for event in &midi_clip.events {
            if !event_ids.insert(event.id.as_str()) {
                return Err(DomainError::DuplicateMidiEventId {
                    clip_id: midi_clip.id.clone(),
                    event_id: event.id.clone(),
                });
            }

            validate_midi_event(event)?;
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

    // Order is validated PER CATEGORY. Sections and cues share the
    // `section_markers` list but are independent overlays: a cue (a one-shot
    // spoken instruction like "Build") legitimately sits at the same time as a
    // section downbeat it belongs to. Requiring a single strictly-increasing
    // order across both would reject that — the "add a cue where a section
    // already is" case. Within one category the strict order still holds.
    let mut previous_section_id: Option<&str> = None;
    let mut previous_section_start_seconds: Option<f64> = None;
    let mut previous_cue_id: Option<&str> = None;
    let mut previous_cue_start_seconds: Option<f64> = None;
    let mut used_digits = HashSet::new();

    for marker in &song.section_markers {
        if marker.start_seconds < 0.0 {
            return Err(DomainError::InvalidMarkerPosition {
                marker_id: marker.id.clone(),
            });
        }

        // Effective category, not the kind's: a marker dragged to the other lane
        // is ordered against that lane's neighbours, matching where it renders.
        let (previous_id, previous_start_seconds) = match marker.category() {
            crate::model::MarkerCategory::Cue => {
                (&mut previous_cue_id, &mut previous_cue_start_seconds)
            }
            crate::model::MarkerCategory::Section => {
                (&mut previous_section_id, &mut previous_section_start_seconds)
            }
        };

        if let Some(prev) = *previous_start_seconds {
            if marker.start_seconds <= prev {
                return Err(DomainError::MarkersOutOfOrder {
                    previous_marker_id: previous_id.unwrap_or_default().to_string(),
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

        *previous_id = Some(marker.id.as_str());
        *previous_start_seconds = Some(marker.start_seconds);
    }

    let mut previous_time_signature_marker_id: Option<&str> = None;
    let mut previous_time_signature_marker_start_seconds: Option<f64> = None;

    for marker in &song.time_signature_markers {
        if marker.start_seconds < 0.0 {
            return Err(DomainError::InvalidTimeSignatureMarkerPosition {
                marker_id: marker.id.clone(),
            });
        }

        if parse_time_signature(&marker.signature).is_none() {
            return Err(DomainError::InvalidTimeSignatureMarker {
                marker_id: marker.id.clone(),
                signature: marker.signature.clone(),
            });
        }

        if let Some(previous_start_seconds) = previous_time_signature_marker_start_seconds {
            if marker.start_seconds <= previous_start_seconds {
                return Err(DomainError::TimeSignatureMarkersOutOfOrder {
                    previous_marker_id: previous_time_signature_marker_id
                        .unwrap_or_default()
                        .to_string(),
                    marker_id: marker.id.clone(),
                });
            }
        }

        previous_time_signature_marker_id = Some(marker.id.as_str());
        previous_time_signature_marker_start_seconds = Some(marker.start_seconds);
    }

    Ok(())
}

/// Check one MIDI event's channel, data bytes and timing. Values are validated
/// here rather than clamped at send time so a malformed file is rejected on
/// load instead of silently firing a different message than the user wrote.
fn validate_midi_event(event: &MidiEvent) -> Result<(), DomainError> {
    // Only an explicit override is checked here; `None` inherits the track's
    // channel, which is validated separately with the track.
    if let Some(channel) = event.channel {
        if !(MIN_MIDI_CHANNEL..=MAX_MIDI_CHANNEL).contains(&channel) {
            return Err(DomainError::InvalidMidiChannel {
                event_id: event.id.clone(),
                channel,
            });
        }
    }

    if !event.at_seconds.is_finite() || event.at_seconds < 0.0 {
        return Err(DomainError::InvalidMidiEventTiming {
            event_id: event.id.clone(),
        });
    }

    let check_value = |field: &'static str, value: u8| -> Result<(), DomainError> {
        if value > MAX_MIDI_DATA_VALUE {
            return Err(DomainError::InvalidMidiDataValue {
                event_id: event.id.clone(),
                field,
                value,
            });
        }
        Ok(())
    };

    match &event.kind {
        MidiEventKind::Note {
            note,
            velocity,
            duration_seconds,
        } => {
            check_value("note", *note)?;
            check_value("velocity", *velocity)?;
            if !duration_seconds.is_finite() || *duration_seconds < 0.0 {
                return Err(DomainError::InvalidMidiEventTiming {
                    event_id: event.id.clone(),
                });
            }
        }
        MidiEventKind::ControlChange { controller, value } => {
            check_value("controller", *controller)?;
            check_value("value", *value)?;
        }
        MidiEventKind::ProgramChange { program } => {
            check_value("program", *program)?;
        }
        MidiEventKind::ControlCurve {
            controller,
            from_value,
            to_value,
            duration_seconds,
        } => {
            check_value("controller", *controller)?;
            check_value("fromValue", *from_value)?;
            check_value("toValue", *to_value)?;
            if !duration_seconds.is_finite() || *duration_seconds < 0.0 {
                return Err(DomainError::InvalidMidiEventTiming {
                    event_id: event.id.clone(),
                });
            }
        }
    }

    Ok(())
}

fn parse_time_signature(time_signature: &str) -> Option<(u32, u32)> {
    let (numerator, denominator) = time_signature.split_once('/')?;
    let numerator = numerator.parse::<u32>().ok()?;
    let denominator = denominator.parse::<u32>().ok()?;
    if numerator == 0 || denominator == 0 {
        return None;
    }
    Some((numerator, denominator))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{
        Clip, Marker, MarkerKind, MidiClip, SongMaster, SongRegion, TimeSignatureMarker, Track,
    };

    fn region(id: &str, start: f64, end: f64) -> SongRegion {
        SongRegion {
            id: id.into(),
            name: id.into(),
            start_seconds: start,
            end_seconds: end,
            transpose_semitones: 0,
            warp_enabled: false,
            warp_source_bpm: None,
            key: None,
            master: SongMaster::default(),
        }
    }

    fn folder(id: &str) -> Track {
        track(id, TrackKind::Folder, None)
    }

    fn track(id: &str, kind: TrackKind, parent: Option<&str>) -> Track {
        Track {
            id: id.into(),
            name: id.into(),
            kind,
            parent_track_id: parent.map(|p| p.to_string()),
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
        }
    }

    /// Minimal valid song: one full-length region, one audio track, no clips.
    fn valid_song() -> Song {
        Song {
            id: "s".into(),
            title: "Song".into(),
            artist: None,
            key: None,
            bpm: 120.0,
            time_signature: "4/4".into(),
            duration_seconds: 100.0,
            tempo_markers: vec![],
            time_signature_markers: vec![],
            regions: vec![region("r1", 0.0, 100.0)],
            tracks: vec![track("t1", TrackKind::Audio, None)],
            clips: vec![],
            midi_clips: vec![],
            section_markers: vec![],
        }
    }

    #[test]
    fn baseline_song_is_valid() {
        assert_eq!(validate_song(&valid_song()), Ok(()));
    }

    #[test]
    fn rejects_blank_title() {
        let mut song = valid_song();
        song.title = "   ".into();
        assert_eq!(validate_song(&song), Err(DomainError::MissingTitle));
    }

    #[test]
    fn rejects_non_positive_duration() {
        let mut song = valid_song();
        song.duration_seconds = 0.0;
        assert_eq!(validate_song(&song), Err(DomainError::InvalidDuration));
    }

    #[test]
    fn rejects_inverted_region_bounds() {
        let mut song = valid_song();
        song.regions = vec![region("bad", 10.0, 5.0)];
        assert!(matches!(
            validate_song(&song),
            Err(DomainError::InvalidRegionBounds { region_id }) if region_id == "bad"
        ));
    }

    #[test]
    fn rejects_negative_region_start() {
        let mut song = valid_song();
        song.regions = vec![region("bad", -1.0, 10.0)];
        assert!(matches!(
            validate_song(&song),
            Err(DomainError::InvalidRegionBounds { .. })
        ));
    }

    #[test]
    fn rejects_overlapping_regions() {
        let mut song = valid_song();
        song.regions = vec![region("r1", 0.0, 50.0), region("r2", 40.0, 100.0)];
        assert!(matches!(
            validate_song(&song),
            Err(DomainError::RegionsOutOfOrder { region_id, .. }) if region_id == "r2"
        ));
    }

    #[test]
    fn rejects_negative_region_master_gain() {
        let mut song = valid_song();
        song.regions[0].master = SongMaster { gain: -0.5 };
        assert!(matches!(
            validate_song(&song),
            Err(DomainError::InvalidRegionMasterGain { region_id, .. }) if region_id == "r1"
        ));
    }

    #[test]
    fn rejects_non_finite_region_master_gain() {
        let mut song = valid_song();
        song.regions[0].master = SongMaster {
            gain: f64::INFINITY,
        };
        assert!(matches!(
            validate_song(&song),
            Err(DomainError::InvalidRegionMasterGain { .. })
        ));
    }

    #[test]
    fn rejects_duplicate_track_ids() {
        let mut song = valid_song();
        song.tracks = vec![
            track("dup", TrackKind::Audio, None),
            track("dup", TrackKind::Audio, None),
        ];
        assert_eq!(
            validate_song(&song),
            Err(DomainError::DuplicateTrackId("dup".into()))
        );
    }

    #[test]
    fn rejects_self_parented_track() {
        let mut song = valid_song();
        song.tracks = vec![track("t1", TrackKind::Audio, Some("t1"))];
        assert!(matches!(
            validate_song(&song),
            Err(DomainError::SelfParentTrack { track_id }) if track_id == "t1"
        ));
    }

    #[test]
    fn rejects_unknown_parent_track() {
        let mut song = valid_song();
        song.tracks = vec![track("t1", TrackKind::Audio, Some("ghost"))];
        assert!(matches!(
            validate_song(&song),
            Err(DomainError::UnknownParentTrack { parent_track_id, .. }) if parent_track_id == "ghost"
        ));
    }

    #[test]
    fn rejects_non_folder_parent() {
        let mut song = valid_song();
        song.tracks = vec![
            track("parent", TrackKind::Audio, None),
            track("child", TrackKind::Audio, Some("parent")),
        ];
        assert!(matches!(
            validate_song(&song),
            Err(DomainError::ParentTrackMustBeFolder { track_id, .. }) if track_id == "child"
        ));
    }

    #[test]
    fn accepts_audio_track_parented_to_a_folder() {
        let mut song = valid_song();
        song.tracks = vec![folder("f1"), track("child", TrackKind::Audio, Some("f1"))];
        assert_eq!(validate_song(&song), Ok(()));
    }

    #[test]
    fn rejects_track_hierarchy_cycle() {
        // Two folders parenting each other form a cycle.
        let mut song = valid_song();
        song.tracks = vec![
            track("a", TrackKind::Folder, Some("b")),
            track("b", TrackKind::Folder, Some("a")),
        ];
        assert!(matches!(
            validate_song(&song),
            Err(DomainError::TrackHierarchyCycle { .. })
        ));
    }

    #[test]
    fn rejects_duplicate_clip_ids() {
        let mut song = valid_song();
        let clip = Clip {
            id: "c".into(),
            track_id: "t1".into(),
            file_path: "a.wav".into(),
            timeline_start_seconds: 0.0,
            source_start_seconds: 0.0,
            duration_seconds: 1.0,
            gain: 1.0,
            fade_in_seconds: None,
            fade_out_seconds: None,
            color: None,
        };
        song.clips = vec![clip.clone(), clip];
        assert_eq!(
            validate_song(&song),
            Err(DomainError::DuplicateClipId("c".into()))
        );
    }

    #[test]
    fn rejects_negative_marker_position() {
        let mut song = valid_song();
        song.section_markers = vec![Marker {
            id: "m".into(),
            name: "M".into(),
            start_seconds: -1.0,
            digit: None,
            kind: MarkerKind::Custom,
            variant: None,
            color: None,
            category_override: None,
        }];
        assert!(matches!(
            validate_song(&song),
            Err(DomainError::InvalidMarkerPosition { .. })
        ));
    }

    #[test]
    fn rejects_out_of_order_markers() {
        let mut song = valid_song();
        song.section_markers = vec![
            Marker {
                id: "m1".into(),
                name: "M1".into(),
                start_seconds: 10.0,
                digit: None,
                kind: MarkerKind::Custom,
                variant: None,
                color: None,
                category_override: None,
            },
            Marker {
                id: "m2".into(),
                name: "M2".into(),
                start_seconds: 5.0,
                digit: None,
                kind: MarkerKind::Custom,
                variant: None,
                color: None,
                category_override: None,
            },
        ];
        assert!(matches!(
            validate_song(&song),
            Err(DomainError::MarkersOutOfOrder { marker_id, .. }) if marker_id == "m2"
        ));
    }

    #[test]
    fn accepts_cue_at_the_same_time_as_a_section() {
        // A cue (Build) and a section (Chorus) legitimately coincide: order is
        // validated per category, so sharing a start time is allowed.
        let mut song = valid_song();
        song.section_markers = vec![
            Marker {
                id: "sec".into(),
                name: "Chorus".into(),
                start_seconds: 8.0,
                digit: None,
                kind: MarkerKind::Chorus,
                variant: None,
                color: None,
                category_override: None,
            },
            Marker {
                id: "cue".into(),
                name: "Build".into(),
                start_seconds: 8.0,
                digit: None,
                kind: MarkerKind::Build,
                variant: None,
                color: None,
                category_override: None,
            },
        ];
        assert!(validate_song(&song).is_ok());
    }

    #[test]
    fn rejects_two_sections_at_the_same_time() {
        // Same category (two sections) still requires strictly increasing time.
        let mut song = valid_song();
        song.section_markers = vec![
            Marker {
                id: "s1".into(),
                name: "Verse".into(),
                start_seconds: 8.0,
                digit: None,
                kind: MarkerKind::Verse,
                variant: None,
                color: None,
                category_override: None,
            },
            Marker {
                id: "s2".into(),
                name: "Chorus".into(),
                start_seconds: 8.0,
                digit: None,
                kind: MarkerKind::Chorus,
                variant: None,
                color: None,
                category_override: None,
            },
        ];
        assert!(matches!(
            validate_song(&song),
            Err(DomainError::MarkersOutOfOrder { marker_id, .. }) if marker_id == "s2"
        ));
    }

    #[test]
    fn rejects_marker_digit_above_nine() {
        let mut song = valid_song();
        song.section_markers = vec![Marker {
            id: "m".into(),
            name: "M".into(),
            start_seconds: 0.0,
            digit: Some(10),
            kind: MarkerKind::Custom,
            variant: None,
            color: None,
            category_override: None,
        }];
        assert!(matches!(
            validate_song(&song),
            Err(DomainError::InvalidMarkerDigit { digit, .. }) if digit == 10
        ));
    }

    #[test]
    fn validates_time_signature_markers() {
        let mut song = valid_song();
        song.time_signature_markers = vec![TimeSignatureMarker {
            id: "ts".into(),
            start_seconds: 0.0,
            signature: "7/8".into(),
        }];
        assert_eq!(validate_song(&song), Ok(()));

        song.time_signature_markers[0].signature = "4/0".into();
        assert!(matches!(
            validate_song(&song),
            Err(DomainError::InvalidTimeSignatureMarker { .. })
        ));
    }

    #[test]
    fn rejects_out_of_order_time_signature_markers() {
        let mut song = valid_song();
        song.time_signature_markers = vec![
            TimeSignatureMarker {
                id: "a".into(),
                start_seconds: 10.0,
                signature: "4/4".into(),
            },
            TimeSignatureMarker {
                id: "b".into(),
                start_seconds: 4.0,
                signature: "4/4".into(),
            },
        ];
        assert!(matches!(
            validate_song(&song),
            Err(DomainError::TimeSignatureMarkersOutOfOrder { .. })
        ));
    }

    fn midi_event(id: &str, kind: MidiEventKind) -> MidiEvent {
        MidiEvent {
            id: id.into(),
            at_seconds: 0.0,
            channel: None,
            kind,
        }
    }

    fn note_event(id: &str) -> MidiEvent {
        midi_event(
            id,
            MidiEventKind::Note {
                note: 60,
                velocity: 100,
                duration_seconds: 0.5,
            },
        )
    }

    /// Song with one MIDI track holding one clip of `events`.
    fn song_with_midi(events: Vec<MidiEvent>) -> Song {
        let mut song = valid_song();
        song.tracks.push(track("midi1", TrackKind::Midi, None));
        song.midi_clips.push(MidiClip {
            id: "mc1".into(),
            track_id: "midi1".into(),
            timeline_start_seconds: 10.0,
            name: "Lights".into(),
            events,
            color: None,
        });
        song
    }

    #[test]
    fn accepts_a_well_formed_midi_clip() {
        let song = song_with_midi(vec![
            note_event("e1"),
            midi_event(
                "e2",
                MidiEventKind::ProgramChange { program: 5 },
            ),
            midi_event(
                "e3",
                MidiEventKind::ControlCurve {
                    controller: 74,
                    from_value: 0,
                    to_value: 127,
                    duration_seconds: 8.0,
                },
            ),
        ]);
        assert_eq!(validate_song(&song), Ok(()));
    }

    #[test]
    fn accepts_several_notes_stacked_at_the_same_offset() {
        // The chord case the editor is built around: one point, many notes,
        // each with its own velocity.
        let song = song_with_midi(vec![
            note_event("e1"),
            MidiEvent {
                id: "e2".into(),
                at_seconds: 0.0,
                channel: None,
                kind: MidiEventKind::Note {
                    note: 64,
                    velocity: 80,
                    duration_seconds: 0.5,
                },
            },
            MidiEvent {
                id: "e3".into(),
                at_seconds: 0.0,
                channel: None,
                kind: MidiEventKind::Note {
                    note: 67,
                    velocity: 60,
                    duration_seconds: 0.5,
                },
            },
        ]);
        assert_eq!(validate_song(&song), Ok(()));
    }

    #[test]
    fn rejects_midi_clip_on_a_non_midi_track() {
        let mut song = song_with_midi(vec![note_event("e1")]);
        song.midi_clips[0].track_id = "t1".into();
        assert!(matches!(
            validate_song(&song),
            Err(DomainError::MidiClipTargetsNonMidiTrack { .. })
        ));
    }

    #[test]
    fn rejects_audio_clip_on_a_midi_track() {
        let mut song = song_with_midi(vec![]);
        song.clips.push(Clip {
            id: "c1".into(),
            track_id: "midi1".into(),
            file_path: "audio/a.wav".into(),
            timeline_start_seconds: 0.0,
            source_start_seconds: 0.0,
            duration_seconds: 10.0,
            gain: 1.0,
            fade_in_seconds: None,
            fade_out_seconds: None,
            color: None,
        });
        assert!(matches!(
            validate_song(&song),
            Err(DomainError::ClipTargetsMidiTrack { .. })
        ));
    }

    #[test]
    fn rejects_midi_clip_on_unknown_track() {
        let mut song = song_with_midi(vec![note_event("e1")]);
        song.midi_clips[0].track_id = "ghost".into();
        assert!(matches!(
            validate_song(&song),
            Err(DomainError::UnknownMidiClipTrack { .. })
        ));
    }

    #[test]
    fn rejects_duplicate_midi_clip_and_event_ids() {
        let mut song = song_with_midi(vec![note_event("e1"), note_event("e1")]);
        assert!(matches!(
            validate_song(&song),
            Err(DomainError::DuplicateMidiEventId { .. })
        ));

        let mut song = song_with_midi(vec![note_event("e1")]);
        let duplicate = song.midi_clips[0].clone();
        song.midi_clips.push(duplicate);
        assert!(matches!(
            validate_song(&song),
            Err(DomainError::DuplicateMidiClipId(_))
        ));
    }

    #[test]
    fn rejects_out_of_range_channel_and_data_values() {
        let mut song = song_with_midi(vec![note_event("e1")]);
        song.midi_clips[0].events[0].channel = Some(0);
        assert!(matches!(
            validate_song(&song),
            Err(DomainError::InvalidMidiChannel { .. })
        ));

        let mut song = song_with_midi(vec![note_event("e1")]);
        song.midi_clips[0].events[0].channel = Some(17);
        assert!(matches!(
            validate_song(&song),
            Err(DomainError::InvalidMidiChannel { .. })
        ));

        let mut song = song_with_midi(vec![note_event("e1")]);
        song.midi_clips[0].events[0].kind = MidiEventKind::Note {
            note: 128,
            velocity: 100,
            duration_seconds: 0.5,
        };
        assert!(matches!(
            validate_song(&song),
            Err(DomainError::InvalidMidiDataValue { field: "note", .. })
        ));

        let mut song = song_with_midi(vec![note_event("e1")]);
        song.midi_clips[0].events[0].kind = MidiEventKind::ControlCurve {
            controller: 74,
            from_value: 0,
            to_value: 200,
            duration_seconds: 4.0,
        };
        assert!(matches!(
            validate_song(&song),
            Err(DomainError::InvalidMidiDataValue {
                field: "toValue",
                ..
            })
        ));
    }

    #[test]
    fn rejects_non_finite_or_negative_timing() {
        let mut song = song_with_midi(vec![note_event("e1")]);
        song.midi_clips[0].events[0].at_seconds = -1.0;
        assert!(matches!(
            validate_song(&song),
            Err(DomainError::InvalidMidiEventTiming { .. })
        ));

        let mut song = song_with_midi(vec![note_event("e1")]);
        song.midi_clips[0].events[0].kind = MidiEventKind::Note {
            note: 60,
            velocity: 100,
            duration_seconds: f64::NAN,
        };
        assert!(matches!(
            validate_song(&song),
            Err(DomainError::InvalidMidiEventTiming { .. })
        ));

        let mut song = song_with_midi(vec![note_event("e1")]);
        song.midi_clips[0].timeline_start_seconds = -0.5;
        assert!(matches!(
            validate_song(&song),
            Err(DomainError::InvalidMidiClipPosition { .. })
        ));
    }

    #[test]
    fn midi_clips_may_cross_region_boundaries() {
        // Unlike audio clips, a MIDI clip is a firing point: a controller sweep
        // that runs past the end of its region is legitimate, so the
        // one-clip-one-region invariant must not apply to it.
        let mut song = song_with_midi(vec![midi_event(
            "e1",
            MidiEventKind::ControlCurve {
                controller: 74,
                from_value: 0,
                to_value: 127,
                duration_seconds: 60.0,
            },
        )]);
        song.regions = vec![region("r1", 0.0, 50.0), region("r2", 50.0, 100.0)];
        song.midi_clips[0].timeline_start_seconds = 40.0;
        assert_eq!(validate_song(&song), Ok(()));
    }

    #[test]
    fn midi_clips_are_valid_in_a_song_with_no_regions() {
        // "Regions" are what the user calls songs. MIDI must be usable in a
        // session that has none yet — an empty session where the user drops a
        // MIDI track to drive lights before importing any audio. Audio clips
        // must live inside a region; MIDI clips deliberately need not, so an
        // empty timeline is still a valid place to author them.
        let mut song = song_with_midi(vec![note_event("e1")]);
        song.regions.clear();
        song.clips.clear();
        assert_eq!(validate_song(&song), Ok(()));
    }

    #[test]
    fn a_midi_only_song_with_no_audio_tracks_is_valid() {
        // The extreme case: a session whose only content is MIDI.
        let mut song = valid_song();
        song.regions.clear();
        song.tracks = vec![track("midi1", TrackKind::Midi, None)];
        song.midi_clips = vec![MidiClip {
            id: "mc1".into(),
            track_id: "midi1".into(),
            timeline_start_seconds: 0.0,
            name: "Lights".into(),
            events: vec![note_event("e1")],
            color: None,
        }];
        assert_eq!(validate_song(&song), Ok(()));
    }

    #[test]
    fn midi_clip_duration_spans_its_longest_event() {
        let clip = MidiClip {
            id: "mc".into(),
            track_id: "midi1".into(),
            timeline_start_seconds: 10.0,
            name: String::new(),
            events: vec![
                MidiEvent {
                    id: "e1".into(),
                    at_seconds: 0.0,
                    channel: None,
                    kind: MidiEventKind::Note {
                        note: 60,
                        velocity: 100,
                        duration_seconds: 2.0,
                    },
                },
                MidiEvent {
                    id: "e2".into(),
                    at_seconds: 4.0,
                    channel: None,
                    kind: MidiEventKind::ControlChange {
                        controller: 1,
                        value: 64,
                    },
                },
            ],
            color: None,
        };
        assert_eq!(clip.duration_seconds(), 4.0);
        assert_eq!(clip.end_seconds(), 14.0);
    }

    #[test]
    fn a_clip_of_instantaneous_messages_has_zero_duration() {
        let clip = MidiClip {
            id: "mc".into(),
            track_id: "midi1".into(),
            timeline_start_seconds: 3.0,
            name: String::new(),
            events: vec![MidiEvent {
                id: "e1".into(),
                at_seconds: 0.0,
                channel: None,
                kind: MidiEventKind::ProgramChange { program: 5 },
            }],
            color: None,
        };
        assert_eq!(clip.duration_seconds(), 0.0);
    }
}
