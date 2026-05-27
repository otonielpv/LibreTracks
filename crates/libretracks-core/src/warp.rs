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
/// applying every warp-enabled region (and every non-warp pitched region's
/// varispeed) before that point.
///
/// Project data keeps clip/region/marker positions in the source song's
/// original time. Two things can change the rendered arrangement length:
///   - Warp: `duration / warp_ratio` (Bungee preserves pitch, ratio = target
///     BPM / source BPM).
///   - Varispeed (warp off + region pitch != 0): `duration / pitch_scale`,
///     where `pitch_scale = 2^(semitones/12)`. This is the Ableton-style
///     "pitch changes speed" behaviour — applied at the song level so the
///     musical grid shifts uniformly across tracks. Tracks with
///     `transpose_enabled=false` ignore varispeed audibly but still follow
///     the grid (handled by the renderer).
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

        // Pick warp ratio when warp is active; otherwise fall back to
        // varispeed (pitch as time-stretch). Both apply per region and don't
        // compose with each other — Bungee already absorbs pitch under warp.
        let ratio = if region.warp_enabled {
            region_warp_ratio_in_song(region, song)
        } else if region.transpose_semitones != 0 {
            semitones_to_pitch_scale(region.transpose_semitones)
        } else {
            1.0
        };
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

/// Inverse of `warp_timeline_seconds_at`: given a second in the rendered
/// (view) timeline, return the corresponding second in the stored (source)
/// timeline.
///
/// Use this when the user clicks somewhere on the visible timeline to
/// produce a position that's about to be stored on the song (markers,
/// region edges, clip starts, programmatic seeks specified in view-time).
/// Without this inverse, view-time positions inside or after a stretched
/// region land at the wrong stored offset because the renderer's mapping
/// has already moved the visible scale.
///
/// Returns `seconds` unchanged when the value is non-finite or when there
/// are no time-stretching regions before it.
pub fn source_seconds_at_view(song: &Song, view_seconds: f64) -> f64 {
    if !view_seconds.is_finite() {
        return view_seconds;
    }

    let mut regions = song.regions.iter().collect::<Vec<_>>();
    regions.sort_by(|left, right| {
        left.start_seconds
            .partial_cmp(&right.start_seconds)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    // Walk regions in source-order, tracking how many "view seconds" we've
    // consumed so far. Each region contributes either an unstretched span
    // (ratio == 1) or a stretched span of `source_len / ratio` view seconds.
    // The first region whose view-span contains `view_seconds` is where the
    // click landed; we map the local offset back through the same ratio.
    let mut consumed_view = 0.0_f64;
    let mut last_source_end = 0.0_f64;
    for region in regions {
        if region.end_seconds <= region.start_seconds {
            continue;
        }
        // Gap before this region (ratio = 1).
        let gap_source = (region.start_seconds - last_source_end).max(0.0);
        if view_seconds < consumed_view + gap_source {
            return (last_source_end + (view_seconds - consumed_view)).max(0.0);
        }
        consumed_view += gap_source;

        let ratio = if region.warp_enabled {
            region_warp_ratio_in_song(region, song)
        } else if region.transpose_semitones != 0 {
            semitones_to_pitch_scale(region.transpose_semitones)
        } else {
            1.0
        };
        let effective_ratio = if ratio.is_finite() && ratio > 0.0 {
            ratio
        } else {
            1.0
        };

        let source_len = region.end_seconds - region.start_seconds;
        let view_len = source_len / effective_ratio;
        if view_seconds < consumed_view + view_len {
            let local_view = view_seconds - consumed_view;
            return (region.start_seconds + local_view * effective_ratio).max(0.0);
        }
        consumed_view += view_len;
        last_source_end = region.end_seconds;
    }

    // Past every region: trailing tail is ratio = 1.
    (last_source_end + (view_seconds - consumed_view)).max(0.0)
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

/// Frequency scale `2^(semitones/12)` clamped to a finite positive value.
fn semitones_to_pitch_scale(semitones: i32) -> f64 {
    let scale = 2.0_f64.powf(semitones as f64 / 12.0);
    if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    }
}

/// Audible duration of a clip in the rendered timeline.
///
/// Ableton-style rules (matching the engine's `PitchRenderDecision`):
///   - Warp ON over the clip's start → duration shrunk/expanded by warp ratio
///     (pitch preserved, duration set by warp). `track_transpose_enabled=false`
///     tracks still follow warp's time-stretch but Bungee suppresses pitch,
///     so duration matches the rest of the song.
///   - Warp OFF, region pitch != 0 → varispeed: duration = source /
///     pitch_scale. `track_transpose_enabled` is intentionally ignored here:
///     since pitch *is* speed under varispeed, opting out would desync the
///     track. Tracks that need to stay at original pitch under varispeed
///     would also be desynced visually, so they don't have that option.
///
/// In short: the timeline mapping (`warp_timeline_*`) is the source of truth
/// for every track. `track_transpose_enabled` only changes the audible pitch
/// in cases where it doesn't affect duration (i.e., under warp).
pub fn audible_clip_duration_seconds(
    song: &Song,
    clip_start_seconds: f64,
    clip_duration_seconds: f64,
    _track_transpose_enabled: bool,
) -> f64 {
    if !clip_duration_seconds.is_finite() || clip_duration_seconds <= 0.0 {
        return 0.0;
    }
    warp_timeline_duration_seconds(song, clip_start_seconds, clip_duration_seconds)
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
                color: None,
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
                color: None,
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

    fn varispeed_song_with_region(
        region_pitch: i32,
        warp_enabled: bool,
        warp_source_bpm: Option<f64>,
    ) -> Song {
        let mut s = song(120.0, vec![]);
        s.regions.push(SongRegion {
            id: "r1".into(),
            name: "r1".into(),
            start_seconds: 0.0,
            end_seconds: 60.0,
            transpose_semitones: region_pitch,
            warp_enabled,
            warp_source_bpm,
        });
        s
    }

    #[test]
    fn audible_duration_unchanged_when_no_pitch_and_no_warp() {
        let s = varispeed_song_with_region(0, false, None);
        let d = audible_clip_duration_seconds(&s, 0.0, 10.0, true);
        assert!((d - 10.0).abs() < 1e-9, "got {d}");
    }

    #[test]
    fn audible_duration_halves_for_plus_12_semitones_when_track_allows_transpose() {
        let s = varispeed_song_with_region(12, false, None);
        let d = audible_clip_duration_seconds(&s, 0.0, 10.0, true);
        assert!((d - 5.0).abs() < 1e-9, "got {d}");
    }

    #[test]
    fn audible_duration_doubles_for_minus_12_semitones_when_track_allows_transpose() {
        let s = varispeed_song_with_region(-12, false, None);
        let d = audible_clip_duration_seconds(&s, 0.0, 10.0, true);
        assert!((d - 20.0).abs() < 1e-9, "got {d}");
    }

    #[test]
    fn audible_duration_under_varispeed_ignores_track_transpose_flag() {
        // Opción 4: under no-warp, track_transpose_enabled is ignored so the
        // track follows varispeed and stays aligned with the song grid.
        // Both true/false produce the same duration.
        let s = varispeed_song_with_region(12, false, None);
        let d_enabled = audible_clip_duration_seconds(&s, 0.0, 10.0, true);
        let d_disabled = audible_clip_duration_seconds(&s, 0.0, 10.0, false);
        assert!((d_enabled - 5.0).abs() < 1e-9, "enabled got {d_enabled}");
        assert!((d_disabled - 5.0).abs() < 1e-9, "disabled got {d_disabled}");
    }

    #[test]
    fn audible_duration_under_warp_follows_warp_regardless_of_track_flag() {
        // Under warp, both flag values follow warp ratio (Bungee absorbs
        // pitch, but warp's time-stretch still applies — that's the whole
        // point of letting NeverTranspose-style tracks coexist with warp).
        let s = varispeed_song_with_region(12, true, Some(100.0));
        let d_enabled = audible_clip_duration_seconds(&s, 0.0, 12.0, true);
        let d_disabled = audible_clip_duration_seconds(&s, 0.0, 12.0, false);
        assert!((d_enabled - 10.0).abs() < 1e-9, "enabled got {d_enabled}");
        assert!(
            (d_disabled - 10.0).abs() < 1e-9,
            "disabled got {d_disabled}"
        );
    }

    #[test]
    fn source_seconds_at_view_is_inverse_of_warp_for_warp_region() {
        let mut s = song(120.0, vec![]);
        s.regions.push(SongRegion {
            id: "r1".into(),
            name: "r1".into(),
            start_seconds: 10.0,
            end_seconds: 70.0, // 60 source seconds
            transpose_semitones: 0,
            warp_enabled: true,
            warp_source_bpm: Some(100.0), // ratio = 120/100 = 1.2 → view len 50s
        });

        // Before the region: identity.
        assert!((source_seconds_at_view(&s, 5.0) - 5.0).abs() < 1e-9);
        // Region start: identity (no shift yet).
        assert!((source_seconds_at_view(&s, 10.0) - 10.0).abs() < 1e-9);
        // Mid-region: view 35 = local view 25 → source = 10 + 25 * 1.2 = 40.
        assert!((source_seconds_at_view(&s, 35.0) - 40.0).abs() < 1e-9);
        // Region end (view 60 = source 70).
        assert!((source_seconds_at_view(&s, 60.0) - 70.0).abs() < 1e-9);
        // After the region: extra view seconds map 1:1.
        assert!((source_seconds_at_view(&s, 70.0) - 80.0).abs() < 1e-9);
    }

    #[test]
    fn source_seconds_at_view_is_inverse_of_warp_for_varispeed_region() {
        let mut s = song(120.0, vec![]);
        s.regions.push(SongRegion {
            id: "r1".into(),
            name: "r1".into(),
            start_seconds: 10.0,
            end_seconds: 20.0,       // 10 source seconds
            transpose_semitones: 12, // pitch_scale = 2 → view len 5s
            warp_enabled: false,
            warp_source_bpm: None,
        });

        // Mid-region: view 12.5 = local view 2.5 → source = 10 + 2.5 * 2 = 15.
        assert!((source_seconds_at_view(&s, 12.5) - 15.0).abs() < 1e-9);
        // After region: view 15 = source 20 + (15 - 15) = 20.
        assert!((source_seconds_at_view(&s, 15.0) - 20.0).abs() < 1e-9);
        // Well after region: view 25 = source 30.
        assert!((source_seconds_at_view(&s, 25.0) - 30.0).abs() < 1e-9);
    }

    #[test]
    fn varispeed_region_shifts_marker_positions_after_it() {
        // +12 semitones over [10, 20) halves the region's audible duration
        // (5s instead of 10s). A marker at 30s should slide left by 5s.
        let mut s = song(120.0, vec![]);
        s.regions.push(SongRegion {
            id: "r1".into(),
            name: "r1".into(),
            start_seconds: 10.0,
            end_seconds: 20.0,
            transpose_semitones: 12,
            warp_enabled: false,
            warp_source_bpm: None,
        });
        assert!((warp_timeline_seconds_at(&s, 10.0) - 10.0).abs() < 1e-9);
        assert!((warp_timeline_seconds_at(&s, 20.0) - 15.0).abs() < 1e-9);
        assert!((warp_timeline_seconds_at(&s, 30.0) - 25.0).abs() < 1e-9);
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
