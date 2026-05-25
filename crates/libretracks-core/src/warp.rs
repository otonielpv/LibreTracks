use crate::model::{Song, SongRegion};

/// Effective BPM at a given timeline position. Walks the song's tempo markers
/// and returns the latest one at-or-before `position_seconds`, falling back to
/// `song.bpm` when no marker applies.
///
/// Tolerates a 1 ms slack so a marker placed exactly at `position_seconds`
/// counts as applying (the same convention used elsewhere in the project).
pub fn effective_bpm_at(song: &Song, position_seconds: f64) -> f64 {
    song.tempo_markers
        .iter()
        .filter(|marker| marker.start_seconds <= position_seconds + 0.001)
        .max_by(|a, b| {
            a.start_seconds
                .partial_cmp(&b.start_seconds)
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .map(|marker| marker.bpm)
        .unwrap_or(song.bpm)
}

/// Time-stretch ratio for a region at the current effective tempo.
///
/// Returns `1.0` (identity, no warp) when:
///   - the region has warp disabled, OR
///   - `warp_source_bpm` is missing (validation guarantees this only happens
///     while warp is disabled, but we accept it defensively), OR
///   - either BPM is not finite or non-positive.
///
/// Otherwise returns `target_bpm / source_bpm`, the multiplier the engine
/// passes to Bungee as `time_ratio`: > 1 = play faster, < 1 = play slower.
pub fn region_warp_ratio(region: &SongRegion, target_bpm: f64) -> f64 {
    if !region.warp_enabled {
        return 1.0;
    }
    let source_bpm = match region.warp_source_bpm {
        Some(bpm) => bpm,
        None => return 1.0,
    };
    if !source_bpm.is_finite() || source_bpm <= 0.0 {
        return 1.0;
    }
    if !target_bpm.is_finite() || target_bpm <= 0.0 {
        return 1.0;
    }
    target_bpm / source_bpm
}

/// Convenience: ratio for a region given the song it belongs to. Uses the
/// effective tempo at the region's start, which is the contract from the
/// design doc: warp follows the region's own tempo marker (if any), else
/// the song's general BPM.
pub fn region_warp_ratio_in_song(region: &SongRegion, song: &Song) -> f64 {
    let target = effective_bpm_at(song, region.start_seconds);
    region_warp_ratio(region, target)
}

/// Maps a stored project second into the effective arrangement second after
/// applying every warp-enabled region before that point.
///
/// Project data keeps clip/region/marker positions in the source song's
/// original time. Warp changes the rendered arrangement length by
/// `duration / ratio`, so positions inside and after warped regions need the
/// same remap for the UI and native engine timeline to agree.
pub fn warp_timeline_seconds_at(song: &Song, seconds: f64) -> f64 {
    if !seconds.is_finite() {
        return seconds;
    }

    let mut regions = song.regions.iter().collect::<Vec<_>>();
    regions.sort_by(|left, right| {
        left.start_seconds
            .partial_cmp(&right.start_seconds)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut shift = 0.0_f64;
    for region in regions {
        if region.end_seconds <= region.start_seconds {
            continue;
        }
        if seconds <= region.start_seconds {
            break;
        }

        let ratio = region_warp_ratio_in_song(region, song);
        if !(ratio.is_finite() && ratio > 0.0) || (ratio - 1.0).abs() < f64::EPSILON {
            continue;
        }

        let covered_seconds = (seconds.min(region.end_seconds) - region.start_seconds).max(0.0);
        shift += covered_seconds / ratio - covered_seconds;

        if seconds < region.end_seconds {
            break;
        }
    }

    (seconds + shift).max(0.0)
}

pub fn warp_timeline_duration_seconds(
    song: &Song,
    start_seconds: f64,
    duration_seconds: f64,
) -> f64 {
    if !duration_seconds.is_finite() || duration_seconds <= 0.0 {
        return 0.0;
    }
    let start = warp_timeline_seconds_at(song, start_seconds);
    let end = warp_timeline_seconds_at(song, start_seconds + duration_seconds);
    (end - start).max(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Clip, Song, SongRegion, TempoMarker, Track, TrackKind};

    fn region(enabled: bool, source_bpm: Option<f64>) -> SongRegion {
        SongRegion {
            id: "r".into(),
            name: "r".into(),
            start_seconds: 0.0,
            end_seconds: 10.0,
            transpose_semitones: 0,
            warp_enabled: enabled,
            warp_source_bpm: source_bpm,
        }
    }

    fn song(bpm: f64, tempo_markers: Vec<TempoMarker>) -> Song {
        Song {
            id: "s".into(),
            title: "s".into(),
            artist: None,
            key: None,
            bpm,
            time_signature: "4/4".into(),
            duration_seconds: 60.0,
            tempo_markers,
            time_signature_markers: vec![],
            regions: vec![],
            tracks: vec![Track {
                id: "t".into(),
                name: "t".into(),
                kind: TrackKind::Audio,
                parent_track_id: None,
                volume: 1.0,
                pan: 0.0,
                muted: false,
                solo: false,
                transpose_enabled: true,
                audio_to: crate::model::default_audio_to(),
            }],
            clips: vec![Clip {
                id: "c".into(),
                track_id: "t".into(),
                file_path: "f.wav".into(),
                timeline_start_seconds: 0.0,
                source_start_seconds: 0.0,
                duration_seconds: 10.0,
                gain: 1.0,
                fade_in_seconds: None,
                fade_out_seconds: None,
            }],
            section_markers: vec![],
        }
    }

    #[test]
    fn warp_disabled_returns_identity() {
        assert_eq!(region_warp_ratio(&region(false, Some(120.0)), 140.0), 1.0);
    }

    #[test]
    fn warp_enabled_without_source_bpm_returns_identity() {
        assert_eq!(region_warp_ratio(&region(true, None), 140.0), 1.0);
    }

    #[test]
    fn warp_speeds_up_when_target_exceeds_source() {
        let r = region_warp_ratio(&region(true, Some(120.0)), 132.0);
        assert!((r - 1.1).abs() < 1e-9, "expected ~1.1, got {r}");
    }

    #[test]
    fn warp_slows_down_when_target_below_source() {
        let r = region_warp_ratio(&region(true, Some(120.0)), 90.0);
        assert!((r - 0.75).abs() < 1e-9, "expected 0.75, got {r}");
    }

    #[test]
    fn identity_when_source_equals_target() {
        assert_eq!(region_warp_ratio(&region(true, Some(120.0)), 120.0), 1.0);
    }

    #[test]
    fn rejects_non_finite_or_non_positive_bpm() {
        assert_eq!(region_warp_ratio(&region(true, Some(0.0)), 120.0), 1.0);
        assert_eq!(region_warp_ratio(&region(true, Some(-10.0)), 120.0), 1.0);
        assert_eq!(region_warp_ratio(&region(true, Some(f64::NAN)), 120.0), 1.0);
        assert_eq!(
            region_warp_ratio(&region(true, Some(f64::INFINITY)), 120.0),
            1.0
        );
        assert_eq!(region_warp_ratio(&region(true, Some(120.0)), 0.0), 1.0);
        assert_eq!(region_warp_ratio(&region(true, Some(120.0)), f64::NAN), 1.0);
    }

    #[test]
    fn effective_bpm_uses_song_bpm_when_no_markers() {
        assert_eq!(effective_bpm_at(&song(120.0, vec![]), 5.0), 120.0);
    }

    #[test]
    fn effective_bpm_picks_latest_marker_before_position() {
        let s = song(
            120.0,
            vec![
                TempoMarker {
                    id: "m1".into(),
                    start_seconds: 2.0,
                    bpm: 90.0,
                },
                TempoMarker {
                    id: "m2".into(),
                    start_seconds: 5.0,
                    bpm: 140.0,
                },
            ],
        );
        assert_eq!(effective_bpm_at(&s, 1.0), 120.0); // before any marker
        assert_eq!(effective_bpm_at(&s, 3.0), 90.0); // between markers
        assert_eq!(effective_bpm_at(&s, 6.0), 140.0); // after second marker
    }

    #[test]
    fn region_warp_ratio_in_song_uses_tempo_at_region_start() {
        let mut s = song(
            120.0,
            vec![TempoMarker {
                id: "m1".into(),
                start_seconds: 4.0,
                bpm: 140.0,
            }],
        );
        // Region starting at 5.0 inherits 140 BPM from the marker.
        let r = SongRegion {
            id: "r1".into(),
            name: "r1".into(),
            start_seconds: 5.0,
            end_seconds: 10.0,
            transpose_semitones: 0,
            warp_enabled: true,
            warp_source_bpm: Some(120.0),
        };
        s.regions.push(r.clone());
        let ratio = region_warp_ratio_in_song(&r, &s);
        assert!(
            (ratio - 140.0 / 120.0).abs() < 1e-9,
            "expected 140/120, got {ratio}"
        );
    }

    #[test]
    fn warp_timeline_seconds_shortens_positions_after_faster_region() {
        let mut s = song(120.0, vec![]);
        s.regions.push(SongRegion {
            id: "r1".into(),
            name: "r1".into(),
            start_seconds: 10.0,
            end_seconds: 70.0,
            transpose_semitones: 0,
            warp_enabled: true,
            warp_source_bpm: Some(100.0),
        });

        assert!((warp_timeline_seconds_at(&s, 10.0) - 10.0).abs() < 1e-9);
        assert!((warp_timeline_seconds_at(&s, 70.0) - 60.0).abs() < 1e-9);
        assert!((warp_timeline_seconds_at(&s, 80.0) - 70.0).abs() < 1e-9);
    }

    #[test]
    fn warp_timeline_duration_expands_slower_region_span() {
        let mut s = song(90.0, vec![]);
        s.regions.push(SongRegion {
            id: "r1".into(),
            name: "r1".into(),
            start_seconds: 0.0,
            end_seconds: 12.0,
            transpose_semitones: 0,
            warp_enabled: true,
            warp_source_bpm: Some(120.0),
        });

        let duration = warp_timeline_duration_seconds(&s, 0.0, 12.0);
        assert!((duration - 16.0).abs() < 1e-9, "got {duration}");
    }
}
