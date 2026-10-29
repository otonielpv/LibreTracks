//! Apply the result of "Analizar canción": tempo and meter from the click,
//! and the song's key.
//!
//! The tempo proposal comes from `libretracks_analysis::propose_tempo_markers`,
//! reviewed (and maybe edited) by the user. Applying replaces every tempo and
//! time signature marker inside the song with it and writes the key, in one
//! undoable edit. See `docs/plans/song-analysis/00-DISENO.md`.

use libretracks_analysis::{ProposedSignatureMarker, ProposedTempoMarker};
use libretracks_core::{
    source_seconds_at_view, Marker, MarkerCategory, MarkerKind, Song, TempoMarker,
    TimeSignatureMarker,
};

use crate::audio::engine::AudioController;
use crate::infra::error::DesktopError;
use crate::models::TransportSnapshot;

use super::{
    realign_regions_after_warp_tempo_change, song_has_active_warp, timestamp_suffix,
    validate_time_signature, AudioChangeImpact, DesktopSession, UpdatePhase,
};

/// Two positions this close are the same marker (the editors' 1 ms).
const SAME_POSITION_SECONDS: f64 = 0.0005;
/// The first song's start: a marker here sets the song's base tempo/meter.
const SONG_ORIGIN_SECONDS: f64 = 0.0001;

/// Replace the tempo and time signature markers inside `region_id` with the
/// given ones. Markers outside the song are left alone.
pub(super) fn apply_tempo_analysis_to_song(
    song: &mut Song,
    region_id: &str,
    tempo_markers: &[ProposedTempoMarker],
    signature_markers: &[ProposedSignatureMarker],
) -> Result<(), DesktopError> {
    for marker in tempo_markers {
        if !marker.bpm.is_finite() || marker.bpm < 20.0 || marker.bpm > 300.0 {
            return Err(DesktopError::AudioCommand(
                "song bpm marker must be between 20.0 and 300.0".into(),
            ));
        }
        if !marker.start_seconds.is_finite() || marker.start_seconds < 0.0 {
            return Err(DesktopError::AudioCommand(
                "tempo marker position is invalid".into(),
            ));
        }
    }
    for marker in signature_markers {
        validate_time_signature(&marker.signature)?;
        if !marker.start_seconds.is_finite() || marker.start_seconds < 0.0 {
            return Err(DesktopError::AudioCommand(
                "time signature marker position is invalid".into(),
            ));
        }
    }
    let region = song
        .regions
        .iter()
        .find(|region| region.id == region_id)
        .ok_or_else(|| DesktopError::RegionNotFound(region_id.to_string()))?;
    let (start, end) = (region.start_seconds, region.end_seconds);
    let inside = |position: f64| {
        position >= start - SAME_POSITION_SECONDS && position < end - SAME_POSITION_SECONDS
    };
    song.tempo_markers
        .retain(|marker| !inside(marker.start_seconds));
    song.time_signature_markers
        .retain(|marker| !inside(marker.start_seconds));

    let suffix = timestamp_suffix();
    for (index, marker) in tempo_markers.iter().enumerate() {
        // A ramp needs a marker even at the session's start: the song's own
        // tempo has no ramp.
        if marker.start_seconds <= SONG_ORIGIN_SECONDS && !marker.ramp {
            song.bpm = marker.bpm;
        } else if let Some(existing) = song.tempo_markers.iter_mut().find(|existing| {
            (existing.start_seconds - marker.start_seconds).abs() < SAME_POSITION_SECONDS
        }) {
            existing.bpm = marker.bpm;
            existing.ramp = marker.ramp;
        } else {
            if marker.start_seconds <= SONG_ORIGIN_SECONDS {
                song.bpm = marker.bpm;
            }
            song.tempo_markers.push(TempoMarker {
                id: format!("tempo_marker_{suffix}_{index}"),
                start_seconds: marker.start_seconds.max(0.0),
                bpm: marker.bpm,
                ramp: marker.ramp,
            });
        }
    }
    for (index, marker) in signature_markers.iter().enumerate() {
        if marker.start_seconds <= SONG_ORIGIN_SECONDS {
            song.time_signature = marker.signature.clone();
        } else if let Some(existing) = song.time_signature_markers.iter_mut().find(|existing| {
            (existing.start_seconds - marker.start_seconds).abs() < SAME_POSITION_SECONDS
        }) {
            existing.signature = marker.signature.clone();
        } else {
            song.time_signature_markers.push(TimeSignatureMarker {
                id: format!("time_signature_marker_{suffix}_{index}"),
                start_seconds: marker.start_seconds,
                signature: marker.signature.clone(),
            });
        }
    }
    song.tempo_markers
        .sort_by(|left, right| left.start_seconds.total_cmp(&right.start_seconds));
    song.time_signature_markers
        .sort_by(|left, right| left.start_seconds.total_cmp(&right.start_seconds));
    Ok(())
}

/// A section marker read from the guide track, positioned on the rendered
/// timeline (view seconds), named in the UI's language.
#[derive(Debug, Clone)]
pub struct AnalysedSection {
    pub start_seconds: f64,
    pub kind: MarkerKind,
    pub variant: Option<u8>,
    pub name: String,
    /// The lane, when it is not the one the kind implies.
    pub category_override: Option<MarkerCategory>,
}

/// Replace the section and cue markers inside the song with `sections`.
/// Positions come in view time (the guide was read off the rendered
/// timeline) and are stored in source time, like `create_section_marker`.
pub(super) fn apply_sections_to_song(
    song: &mut Song,
    region_id: &str,
    sections: &[AnalysedSection],
) -> Result<(), DesktopError> {
    let region = song
        .regions
        .iter()
        .find(|region| region.id == region_id)
        .ok_or_else(|| DesktopError::RegionNotFound(region_id.to_string()))?;
    let (start, end) = (region.start_seconds, region.end_seconds);
    let inside = |position: f64| {
        position >= start - SAME_POSITION_SECONDS && position < end - SAME_POSITION_SECONDS
    };
    let stored: Vec<(f64, &AnalysedSection)> = sections
        .iter()
        .filter(|section| section.start_seconds.is_finite())
        .map(|section| {
            (
                source_seconds_at_view(song, section.start_seconds).max(0.0),
                section,
            )
        })
        .collect();
    song.section_markers
        .retain(|marker| !inside(marker.start_seconds));
    let suffix = timestamp_suffix();
    let mut added: Vec<(MarkerCategory, f64)> = Vec::new();
    for (index, (position, section)) in stored.into_iter().enumerate() {
        if !inside(position) {
            continue;
        }
        let name = section.name.trim();
        let marker = Marker {
            id: format!("section_{suffix}_{index}"),
            name: if name.is_empty() {
                format!("{:?}", section.kind)
            } else {
                name.to_string()
            },
            start_seconds: position,
            digit: None,
            kind: section.kind,
            variant: section.variant,
            color: None,
            category_override: section
                .category_override
                .filter(|lane| *lane != section.kind.category()),
        };
        // Two markers on one spot of a lane fail validation ("markers are out
        // of order") and the whole analysis with them: the first one stays.
        if added.iter().any(|(lane, at)| {
            *lane == marker.category() && (at - position).abs() < SAME_POSITION_SECONDS
        }) {
            continue;
        }
        added.push((marker.category(), position));
        song.section_markers.push(marker);
    }
    song.section_markers
        .sort_by(|left, right| left.start_seconds.total_cmp(&right.start_seconds));
    Ok(())
}

/// Write the song's original key (sharp spelling, as the key picker stores
/// it). An empty key clears it, like `update_song_region_key`.
pub(super) fn apply_key_to_song(
    song: &mut Song,
    region_id: &str,
    key: &str,
) -> Result<(), DesktopError> {
    let region = song
        .regions
        .iter_mut()
        .find(|region| region.id == region_id)
        .ok_or_else(|| DesktopError::RegionNotFound(region_id.to_string()))?;
    let key = key.trim();
    // Normalizar: un cambio a la nota nueva ya no cambia nada.
    region.set_key_map(libretracks_core::KeyMap {
        key: (!key.is_empty()).then(|| key.to_string()),
        changes: region.key_changes.clone(),
    });
    Ok(())
}

impl DesktopSession {
    /// The reviewed analysis, as ONE undo step: the tempo map when `tempo` is
    /// given (tempo and meter markers), the key when `key` is, the key changes
    /// when `key_changes` is (they replace the song's own), the section
    /// markers when `sections` is.
    #[allow(clippy::too_many_arguments)]
    pub fn apply_song_analysis(
        &mut self,
        region_id: &str,
        tempo: Option<(&[ProposedTempoMarker], &[ProposedSignatureMarker])>,
        key: Option<String>,
        key_changes: Option<Vec<super::KeyChangeInput>>,
        sections: Option<&[AnalysedSection]>,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        let previous_song = song.clone();
        if let Some((tempo_markers, signature_markers)) = tempo {
            apply_tempo_analysis_to_song(&mut song, region_id, tempo_markers, signature_markers)?;
        }
        if let Some(key) = key.as_deref() {
            apply_key_to_song(&mut song, region_id, key)?;
        }
        // After the tempo map: the positions are in the view it leaves.
        if let Some(changes) = key_changes {
            super::set_region_key_changes(&mut song, region_id, changes)?;
        }
        if let Some(sections) = sections {
            apply_sections_to_song(&mut song, region_id, sections)?;
            audio.update_live_section_markers(&song)?;
        }
        realign_regions_after_warp_tempo_change(&previous_song, &mut song);

        let impact = if song_has_active_warp(&song) {
            AudioChangeImpact::TimelineWindow
        } else {
            AudioChangeImpact::TransportOnly
        };
        // One persist, one undo step. Realigning may shift the songs after:
        // their cues go with them.
        self.persist_song_update_carrying_cues(song, audio, impact, true, UpdatePhase::Commit)?;

        Ok(self.snapshot())
    }
}

#[cfg(test)]
#[path = "song_analysis_tests.rs"]
mod tests;
