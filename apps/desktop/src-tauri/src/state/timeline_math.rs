//! Pure timeline math over `Song`: bar/downbeat geometry, warp/varispeed time
//! mapping, region reflow and clip↔region reconciliation. No `self`, no I/O —
//! just functions that read or rewrite a `Song`'s timeline. Shared by the
//! region/tempo methods in `mod.rs` and the import paths.

use libretracks_core::{
    audible_clip_duration_seconds, effective_bpm_at, source_seconds_at_view,
    warp_timeline_seconds_at, Clip, Song, SongRegion, TempoMarker,
};

use crate::infra::error::DesktopError;

use super::timestamp_suffix;

/// Duration of one bar at `position_seconds` (in source-time), derived from
/// the song's effective BPM at that point and the song's base time signature
/// numerator. Used by create_empty_song to space new songs by one bar of
/// silence regardless of tempo.
pub(super) fn bar_seconds_at(song: &Song, position_seconds: f64) -> f64 {
    let bpm = libretracks_core::effective_bpm_at(song, position_seconds).max(1.0);
    let beats_per_bar = song
        .time_signature
        .split_once('/')
        .and_then(|(num, _)| num.trim().parse::<u32>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(4) as f64;
    (beats_per_bar * 60.0) / bpm
}

/// Returns the first downbeat (bar boundary) at or after `position_seconds`,
/// walking the song's tempo markers so the answer respects every tempo
/// change between the anchor and the next bar. Falls back to the song's
/// global BPM when there are no tempo markers. Used by create_empty_song
/// to land new songs on a real grid bar instead of "lastEnd + one bar at
/// the global BPM", which drifts off-grid whenever the previous song
/// ended under a different tempo marker or didn't end exactly on a bar.
pub(super) fn next_downbeat_after_in_song(song: &Song, position_seconds: f64) -> f64 {
    if position_seconds <= 0.0 {
        return 0.0;
    }
    // Build the set of tempo segments: from each tempo marker (sorted by
    // start) to the next marker's start (or +infinity for the last one).
    // Within a segment the BPM is constant so the local downbeat math is
    // a simple rounding.
    let mut markers = song.tempo_markers.clone();
    markers.sort_by(|a, b| {
        a.start_seconds
            .partial_cmp(&b.start_seconds)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let beats_per_bar = song
        .time_signature
        .split_once('/')
        .and_then(|(num, _)| num.trim().parse::<u32>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(4) as f64;

    // Walk segments in order, accumulating bar count at each segment
    // boundary. The current segment is the one whose start_seconds is the
    // greatest <= position_seconds (or the implicit "before-any-marker"
    // segment anchored at 0 with the song's base BPM).
    let mut segment_start_seconds = 0.0_f64;
    let mut segment_start_bars = 0.0_f64;
    let mut segment_bpm = song.bpm.max(1.0);

    for marker in &markers {
        if marker.start_seconds > position_seconds {
            break;
        }
        let span = marker.start_seconds - segment_start_seconds;
        let bar_seconds = (beats_per_bar * 60.0) / segment_bpm.max(1.0);
        let span_bars = if bar_seconds > 0.0 {
            span / bar_seconds
        } else {
            0.0
        };
        segment_start_bars += span_bars;
        segment_start_seconds = marker.start_seconds;
        segment_bpm = marker.bpm.max(1.0);
    }

    let segment_bar_seconds = (beats_per_bar * 60.0) / segment_bpm.max(1.0);
    if segment_bar_seconds <= 0.0 {
        return position_seconds;
    }
    let local_bars = (position_seconds - segment_start_seconds) / segment_bar_seconds;
    // Ceil with a tiny epsilon so positions already on a downbeat don't
    // jump to the next one due to floating drift.
    let target_local_bars = (local_bars - 1e-9).ceil().max(0.0);
    segment_start_seconds + target_local_bars * segment_bar_seconds
}

const REGION_DOWNBEAT_ALIGNMENT_EPSILON_SECONDS: f64 = 0.15;

#[derive(Clone, Copy)]
pub(super) struct ViewTempoBoundary<'a> {
    start_seconds: f64,
    bpm: Option<f64>,
    time_signature: Option<&'a str>,
}

/// Snap every region positioned AFTER `moved_region_id` so its start
/// lands on the next downbeat after the previous region's end. Used
/// by `move_song_region` to guarantee that each follower ends up on
/// its own bar.1 even when the cascade-push displaced it by a
/// non-bar amount. Iterates in order so that fixing region N feeds
/// the correct end_seconds into the fix for region N+1.
pub(super) fn snap_regions_after_to_downbeats(song: &mut Song, moved_region_id: &str) {
    let ordered_ids: Vec<String> = song
        .regions
        .iter()
        .map(|region| region.id.clone())
        .collect();
    let Some(moved_idx) = ordered_ids.iter().position(|id| id == moved_region_id) else {
        return;
    };
    if moved_idx + 1 >= ordered_ids.len() {
        return;
    }

    let followers: Vec<String> = ordered_ids.iter().skip(moved_idx + 1).cloned().collect();
    let mut predecessor_id = moved_region_id.to_string();
    for follower_id in followers {
        let Some(predecessor_end) = song
            .regions
            .iter()
            .find(|region| region.id == predecessor_id)
            .map(|region| region.end_seconds)
        else {
            predecessor_id = follower_id;
            continue;
        };
        let Some(current_start) = song
            .regions
            .iter()
            .find(|region| region.id == follower_id)
            .map(|region| region.start_seconds)
        else {
            predecessor_id = follower_id;
            continue;
        };

        let predecessor_view_end = warp_timeline_seconds_at(song, predecessor_end);
        let desired_view_start = next_downbeat_after_in_view_timeline(song, predecessor_view_end);
        let desired_source_start = source_seconds_at_view(song, desired_view_start);
        let delta = desired_source_start - current_start;
        if delta.abs() > 0.00001 {
            shift_song_suffix(song, current_start, delta);
        }
        predecessor_id = follower_id;
    }
}

pub(super) fn realign_regions_after_warp_tempo_change(previous_song: &Song, song: &mut Song) {
    // The original guard here was "only act when some region has warp
    // active", but the same realignment is needed for plain tempo
    // changes too: if the user moves the global BPM (or a tempo
    // marker that the next region doesn't supersede), region N+1's
    // source_start no longer falls on the bar it used to fall on.
    // Without this, the case "song 1 has no tempo marker (uses
    // global BPM), song 2 has its own tempo marker pinned at its
    // start; bumping the global BPM" leaves song 2 visually
    // mid-bar even though both endpoints were downbeat-aligned
    // before. The function name is kept for now to avoid touching
    // every caller; it's effectively realign_regions_after_tempo_change.
    let mut previous_regions = previous_song.regions.iter().collect::<Vec<_>>();
    previous_regions.sort_by(|left, right| {
        left.start_seconds
            .partial_cmp(&right.start_seconds)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    for pair in previous_regions.windows(2) {
        let previous_region = pair[0];
        let following_region = pair[1];
        if !region_boundary_was_downbeat_aligned(previous_song, previous_region, following_region) {
            continue;
        }

        let Some(current_previous_end) = song
            .regions
            .iter()
            .find(|region| region.id == previous_region.id)
            .map(|region| region.end_seconds)
        else {
            continue;
        };
        let Some(current_following_start) = song
            .regions
            .iter()
            .find(|region| region.id == following_region.id)
            .map(|region| region.start_seconds)
        else {
            continue;
        };

        let previous_view_end = warp_timeline_seconds_at(song, current_previous_end);
        let desired_view_start = next_downbeat_after_in_view_timeline(song, previous_view_end);
        let desired_source_start = source_seconds_at_view(song, desired_view_start);
        let delta = desired_source_start - current_following_start;
        if delta.abs() <= 0.0001 {
            continue;
        }

        shift_song_suffix(song, current_following_start, delta);
    }

    refresh_song_duration(song);
}

pub(super) fn region_boundary_was_downbeat_aligned(
    song: &Song,
    previous_region: &SongRegion,
    following_region: &SongRegion,
) -> bool {
    let previous_view_end = warp_timeline_seconds_at(song, previous_region.end_seconds);
    let following_view_start = warp_timeline_seconds_at(song, following_region.start_seconds);
    let expected_view_start = next_downbeat_after_in_view_timeline(song, previous_view_end);
    (following_view_start - expected_view_start).abs() <= REGION_DOWNBEAT_ALIGNMENT_EPSILON_SECONDS
}

pub(super) fn shift_song_suffix(song: &mut Song, anchor_seconds: f64, delta_seconds: f64) {
    if !delta_seconds.is_finite() || delta_seconds.abs() <= 0.0001 {
        return;
    }
    let at_or_after_anchor = |seconds: f64| seconds >= anchor_seconds - 0.0001;

    for region in &mut song.regions {
        if at_or_after_anchor(region.start_seconds) {
            region.start_seconds = (region.start_seconds + delta_seconds).max(0.0);
            region.end_seconds = (region.end_seconds + delta_seconds).max(region.start_seconds);
        }
    }
    for clip in &mut song.clips {
        if at_or_after_anchor(clip.timeline_start_seconds) {
            clip.timeline_start_seconds = (clip.timeline_start_seconds + delta_seconds).max(0.0);
        }
    }
    for marker in &mut song.tempo_markers {
        if at_or_after_anchor(marker.start_seconds) {
            marker.start_seconds = (marker.start_seconds + delta_seconds).max(0.0);
        }
    }
    for marker in &mut song.time_signature_markers {
        if at_or_after_anchor(marker.start_seconds) {
            marker.start_seconds = (marker.start_seconds + delta_seconds).max(0.0);
        }
    }
    for marker in &mut song.section_markers {
        if at_or_after_anchor(marker.start_seconds) {
            marker.start_seconds = (marker.start_seconds + delta_seconds).max(0.0);
        }
    }
}

pub(super) fn next_downbeat_after_in_view_timeline(song: &Song, position_seconds: f64) -> f64 {
    if position_seconds <= 0.0 {
        return 0.0;
    }

    let mut boundaries = Vec::<ViewTempoBoundary>::new();
    for marker in &song.tempo_markers {
        if marker.start_seconds > 0.0 {
            boundaries.push(ViewTempoBoundary {
                start_seconds: warp_timeline_seconds_at(song, marker.start_seconds),
                bpm: Some(marker.bpm),
                time_signature: None,
            });
        }
    }
    for marker in &song.time_signature_markers {
        if marker.start_seconds > 0.0 {
            boundaries.push(ViewTempoBoundary {
                start_seconds: warp_timeline_seconds_at(song, marker.start_seconds),
                bpm: None,
                time_signature: Some(marker.signature.as_str()),
            });
        }
    }
    for region in &song.regions {
        if !region.warp_enabled && region.transpose_semitones != 0 {
            if region.start_seconds > 0.0 {
                boundaries.push(ViewTempoBoundary {
                    start_seconds: warp_timeline_seconds_at(song, region.start_seconds),
                    bpm: None,
                    time_signature: None,
                });
            }
            if region.end_seconds > 0.0 {
                boundaries.push(ViewTempoBoundary {
                    start_seconds: warp_timeline_seconds_at(song, region.end_seconds),
                    bpm: None,
                    time_signature: None,
                });
            }
        }
    }
    boundaries.sort_by(|left, right| {
        left.start_seconds
            .partial_cmp(&right.start_seconds)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut segment_start_seconds = 0.0_f64;
    let mut segment_bpm = song.bpm.max(1.0);
    let mut segment_time_signature = song.time_signature.as_str();
    let mut cumulative_bars = 0.0_f64;

    for boundary in boundaries {
        if boundary.start_seconds > position_seconds {
            break;
        }
        if boundary.start_seconds > segment_start_seconds {
            let bar_seconds = view_bar_seconds_at(
                song,
                segment_start_seconds,
                segment_bpm,
                segment_time_signature,
            );
            if bar_seconds > 0.0 {
                cumulative_bars += (boundary.start_seconds - segment_start_seconds) / bar_seconds;
            }
            segment_start_seconds = boundary.start_seconds;
        }
        if let Some(next_signature) = boundary.time_signature {
            if next_signature != segment_time_signature {
                cumulative_bars = (cumulative_bars - 1e-9).ceil();
            }
            segment_time_signature = next_signature;
        }
        if let Some(next_bpm) = boundary.bpm {
            segment_bpm = next_bpm.max(1.0);
        }
    }

    let bar_seconds = view_bar_seconds_at(
        song,
        segment_start_seconds,
        segment_bpm,
        segment_time_signature,
    );
    if bar_seconds <= 0.0 {
        return position_seconds;
    }
    let local_bars = (position_seconds - segment_start_seconds) / bar_seconds;
    let target_total_bars = (cumulative_bars + local_bars - 1e-9).ceil().max(0.0);
    segment_start_seconds + (target_total_bars - cumulative_bars) * bar_seconds
}

pub(super) fn view_bar_seconds_at(
    song: &Song,
    view_seconds: f64,
    bpm: f64,
    time_signature: &str,
) -> f64 {
    let source_seconds = source_seconds_at_view(song, view_seconds);
    let display_bpm = bpm.max(1.0) * varispeed_scale_at_source(song, source_seconds);
    let beats_per_bar = time_signature
        .split_once('/')
        .and_then(|(num, _)| num.trim().parse::<u32>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(4) as f64;
    (beats_per_bar * 60.0) / display_bpm.max(1.0)
}

pub(super) fn varispeed_scale_at_source(song: &Song, source_seconds: f64) -> f64 {
    let Some(region) = song.regions.iter().find(|region| {
        !region.warp_enabled
            && region.transpose_semitones != 0
            && source_seconds >= region.start_seconds
            && source_seconds < region.end_seconds
    }) else {
        return 1.0;
    };
    let scale = 2.0_f64.powf(region.transpose_semitones as f64 / 12.0);
    if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    }
}

pub(super) fn refresh_song_duration(song: &mut Song) {
    let max_clip_end = song
        .clips
        .iter()
        .map(|clip| clip.timeline_start_seconds + clip.duration_seconds)
        .fold(0.0_f64, f64::max);
    // Regions must fit inside the song. If a region's end extends past
    // the latest clip — typical after a user-grabbed resize that
    // expanded the region's bounds — the engine's session validator
    // rejects the load with "Region X is outside its song". Take the
    // max of both so the song duration always envelops every region.
    let max_region_end = song
        .regions
        .iter()
        .map(|region| region.end_seconds)
        .fold(0.0_f64, f64::max);

    song.duration_seconds = max_clip_end.max(max_region_end).max(1.0);
}

pub(super) fn song_with_warped_timeline_for_transport(song: &Song) -> Song {
    let source_song = song.clone();
    let mut runtime = song.clone();

    // Build a track_id -> transpose_enabled lookup so the per-clip varispeed
    // path can read the right flag without scanning runtime.tracks N times.
    let track_transpose_enabled: std::collections::HashMap<&str, bool> = source_song
        .tracks
        .iter()
        .map(|track| (track.id.as_str(), track.transpose_enabled))
        .collect();

    for clip in &mut runtime.clips {
        let source_start_seconds = clip.timeline_start_seconds;
        let transpose_enabled = track_transpose_enabled
            .get(clip.track_id.as_str())
            .copied()
            .unwrap_or(true);
        // Ableton-style: warp-on clips follow warp; warp-off pitched clips
        // shrink/expand by pitch_scale (varispeed). Clip START always uses
        // the warp mapping so the musical grid stays consistent; only the
        // clip's own duration absorbs varispeed.
        clip.timeline_start_seconds = warp_timeline_seconds_at(&source_song, source_start_seconds);
        clip.duration_seconds = audible_clip_duration_seconds(
            &source_song,
            source_start_seconds,
            clip.duration_seconds,
            transpose_enabled,
        );
    }

    for region in &mut runtime.regions {
        let source_start_seconds = region.start_seconds;
        let source_end_seconds = region.end_seconds;
        region.start_seconds = warp_timeline_seconds_at(&source_song, source_start_seconds);
        region.end_seconds = warp_timeline_seconds_at(&source_song, source_end_seconds)
            .max(region.start_seconds + 0.001);
    }

    for marker in &mut runtime.section_markers {
        marker.start_seconds = warp_timeline_seconds_at(&source_song, marker.start_seconds);
    }
    for marker in &mut runtime.tempo_markers {
        let source_start_seconds = marker.start_seconds;
        marker.start_seconds = warp_timeline_seconds_at(&source_song, marker.start_seconds);
        if let Some(scale) = varispeed_scale_at_source_second(&source_song, source_start_seconds) {
            marker.bpm *= scale;
        }
    }
    for marker in &mut runtime.time_signature_markers {
        marker.start_seconds = warp_timeline_seconds_at(&source_song, marker.start_seconds);
    }

    runtime.duration_seconds = runtime
        .clips
        .iter()
        .map(|clip| clip.timeline_start_seconds + clip.duration_seconds)
        .fold(
            warp_timeline_seconds_at(&source_song, source_song.duration_seconds),
            f64::max,
        )
        .max(1.0);
    add_varispeed_tempo_boundaries(&source_song, &mut runtime);
    runtime
}

pub(super) fn semitones_to_pitch_scale(semitones: i32) -> f64 {
    let scale = 2.0_f64.powf(semitones as f64 / 12.0);
    if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    }
}

pub(super) fn varispeed_scale_at_source_second(song: &Song, source_seconds: f64) -> Option<f64> {
    song.regions.iter().find_map(|region| {
        if region.warp_enabled
            || region.transpose_semitones == 0
            || source_seconds < region.start_seconds
            || source_seconds >= region.end_seconds
        {
            return None;
        }
        Some(semitones_to_pitch_scale(region.transpose_semitones))
    })
}

pub(super) fn add_varispeed_tempo_boundaries(source_song: &Song, runtime: &mut Song) {
    let mut synthetic_markers = Vec::new();
    for region in &source_song.regions {
        if region.warp_enabled || region.transpose_semitones == 0 {
            continue;
        }
        let scale = semitones_to_pitch_scale(region.transpose_semitones);
        if (scale - 1.0).abs() < f64::EPSILON {
            continue;
        }
        let view_start = warp_timeline_seconds_at(source_song, region.start_seconds);
        let view_end = warp_timeline_seconds_at(source_song, region.end_seconds).max(view_start);
        synthetic_markers.push(TempoMarker {
            id: format!("{}_varispeed_start", region.id),
            start_seconds: view_start,
            bpm: effective_bpm_at(source_song, region.start_seconds) * scale,
        });
        synthetic_markers.push(TempoMarker {
            id: format!("{}_varispeed_end", region.id),
            start_seconds: view_end,
            bpm: effective_bpm_at(source_song, region.end_seconds),
        });
    }
    runtime.tempo_markers.extend(synthetic_markers);
    runtime.tempo_markers.sort_by(|left, right| {
        left.start_seconds
            .partial_cmp(&right.start_seconds)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
}

pub(super) fn song_has_active_warp(song: &Song) -> bool {
    song.regions.iter().any(|region| {
        region.warp_enabled
            && region
                .warp_source_bpm
                .is_some_and(|bpm| bpm.is_finite() && bpm > 0.0)
    })
}

pub(super) fn sanitize_region_bounds(
    _song: &Song,
    start_seconds: f64,
    end_seconds: f64,
) -> Result<(f64, f64), DesktopError> {
    if !start_seconds.is_finite() || !end_seconds.is_finite() {
        return Err(DesktopError::AudioCommand(
            "region bounds must be finite".into(),
        ));
    }

    let clamped_start_seconds = start_seconds.max(0.0);
    let clamped_end_seconds = end_seconds.max(clamped_start_seconds + 0.001);
    if clamped_end_seconds <= clamped_start_seconds {
        return Err(DesktopError::AudioCommand(
            "region end must be greater than region start".into(),
        ));
    }

    Ok((clamped_start_seconds, clamped_end_seconds))
}

pub(super) fn normalize_ui_color(color: Option<&str>) -> Result<Option<String>, DesktopError> {
    let Some(color) = color.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };

    let hex = color.strip_prefix('#').unwrap_or(color);
    if hex.len() != 6 || !hex.as_bytes().iter().all(u8::is_ascii_hexdigit) {
        return Err(DesktopError::AudioCommand(
            "color must be a #RRGGBB hex value".into(),
        ));
    }

    Ok(Some(format!("#{}", hex.to_ascii_uppercase())))
}

pub(super) fn replace_song_region_range(song: &mut Song, replacement: SongRegion) {
    let mut next_regions = Vec::with_capacity(song.regions.len() + 2);
    let mut fragment_index = 0usize;

    for region in &song.regions {
        if region.end_seconds <= replacement.start_seconds
            || region.start_seconds >= replacement.end_seconds
        {
            next_regions.push(region.clone());
            continue;
        }

        if region.start_seconds < replacement.start_seconds {
            fragment_index += 1;
            next_regions.push(SongRegion {
                id: format!(
                    "{}_fragment_{}_{}",
                    region.id,
                    timestamp_suffix(),
                    fragment_index
                ),
                name: region.name.clone(),
                start_seconds: region.start_seconds,
                end_seconds: replacement.start_seconds,
                transpose_semitones: region.transpose_semitones,
                key: region.key.clone(),
                warp_enabled: region.warp_enabled,
                warp_source_bpm: region.warp_source_bpm,
                master: region.master.clone(),
            });
        }

        if region.end_seconds > replacement.end_seconds {
            fragment_index += 1;
            next_regions.push(SongRegion {
                id: format!(
                    "{}_fragment_{}_{}",
                    region.id,
                    timestamp_suffix(),
                    fragment_index
                ),
                name: region.name.clone(),
                start_seconds: replacement.end_seconds,
                end_seconds: region.end_seconds,
                transpose_semitones: region.transpose_semitones,
                key: region.key.clone(),
                warp_enabled: region.warp_enabled,
                warp_source_bpm: region.warp_source_bpm,
                master: region.master.clone(),
            });
        }
    }

    next_regions.push(replacement);
    sort_song_regions(&mut next_regions);
    song.regions = next_regions;
}

pub(super) fn sort_song_regions(regions: &mut Vec<SongRegion>) {
    regions.sort_by(|left, right| {
        left.start_seconds
            .partial_cmp(&right.start_seconds)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                left.end_seconds
                    .partial_cmp(&right.end_seconds)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    });
}

/// Split every clip whose span strictly contains `split_seconds_view` into two
/// clips at that point. Same cut math as `split_clips` (warp-aware via
/// `source_seconds_at_view`), but applied to whichever clips cross the point
/// rather than a caller-chosen set. Used when splitting a song region so no clip
/// straddles the new song boundary (the engine rejects boundary-crossing clips).
pub(super) fn split_clips_crossing_point(song: &mut Song, split_seconds_view: f64) {
    let suffix_base = timestamp_suffix();
    let mut index = 0;
    let mut counter = 0;
    while index < song.clips.len() {
        let clip = song.clips[index].clone();
        let clip_end = clip.timeline_start_seconds + clip.duration_seconds;
        if split_seconds_view <= clip.timeline_start_seconds || split_seconds_view >= clip_end {
            index += 1;
            continue;
        }

        let left_duration = split_seconds_view - clip.timeline_start_seconds;
        let right_duration = clip_end - split_seconds_view;
        let split_seconds_source_clip =
            source_seconds_at_view(song, clip.timeline_start_seconds + left_duration);
        let source_left_duration = (split_seconds_source_clip
            - source_seconds_at_view(song, clip.timeline_start_seconds))
        .max(0.0);

        let left_clip = Clip {
            id: format!("clip_{}_{}_l", suffix_base, counter),
            duration_seconds: left_duration,
            ..clip.clone()
        };
        let right_clip = Clip {
            id: format!("clip_{}_{}_r", suffix_base, counter),
            timeline_start_seconds: split_seconds_view,
            source_start_seconds: clip.source_start_seconds + source_left_duration,
            duration_seconds: right_duration,
            ..clip
        };

        song.clips.splice(index..=index, [left_clip, right_clip]);
        // Skip past both halves; neither crosses the point anymore.
        index += 2;
        counter += 1;
    }
}

/// Make an imported song's clips legal against its region (song) boundaries. The
/// engine rejects a clip that crosses from one region into the next. Reaper
/// region-end boundaries can be a few ms shorter than the audio items inside
/// them, so a clip may overrun its region and invade the following song. This:
///   1. splits any clip straddling a region boundary (each region end), then
///   2. grows every region's end to cover the clips that START inside it, capped
///      at the next region's start so regions never overlap.
/// A single-region import just gets its end grown to the last clip end (no split
/// needed). Idempotent-ish and cheap; safe to run once at the end of an import.
pub(super) fn reconcile_regions_and_clips(song: &mut Song) {
    if song.regions.is_empty() {
        return;
    }
    sort_song_regions(&mut song.regions);

    // 1) Split clips that cross any interior region boundary (each region start
    //    after the first is a boundary between two songs).
    let boundaries: Vec<f64> = song
        .regions
        .iter()
        .skip(1)
        .map(|region| region.start_seconds)
        .collect();
    for boundary in boundaries {
        split_clips_crossing_point(song, boundary);
    }

    // 2) Grow each region end to cover clips starting inside it, capped by the
    //    next region's start (half-open [start, end)).
    let region_count = song.regions.len();
    for index in 0..region_count {
        let start = song.regions[index].start_seconds;
        let cap = song
            .regions
            .get(index + 1)
            .map(|next| next.start_seconds)
            .unwrap_or(f64::INFINITY);
        let max_clip_end = song
            .clips
            .iter()
            .filter(|clip| {
                clip.timeline_start_seconds >= start - 0.0001 && clip.timeline_start_seconds < cap
            })
            .map(|clip| clip.timeline_start_seconds + clip.duration_seconds)
            .fold(song.regions[index].end_seconds, f64::max);
        // Never let the end reach/exceed the next region's start.
        let capped_end = if cap.is_finite() {
            max_clip_end.min(cap)
        } else {
            max_clip_end
        };
        song.regions[index].end_seconds = capped_end.max(start + 0.001);
    }

    refresh_song_duration(song);
}
