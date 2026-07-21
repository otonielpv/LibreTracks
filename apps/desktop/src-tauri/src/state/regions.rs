//! Song timeline editing on `DesktopSession`: section markers, song regions,
//! tempo and time-signature markers, per-region warp/transpose/master-gain, and
//! the section-marker digit/kind/color attributes. Every method mutates the
//! loaded `Song` and persists it; the pure geometry lives in `timeline_math`.

use libretracks_core::{
    source_seconds_at_view, Marker, MarkerKind, SongRegion, TempoMarker, TimeSignatureMarker,
    MAX_TRANSPOSE_SEMITONES, MIN_TRANSPOSE_SEMITONES,
};

use crate::audio_engine::{jump_debug_logging_enabled, AudioController};
use crate::error::DesktopError;
use crate::models::TransportSnapshot;

use super::{
    bar_seconds_at, next_downbeat_after_in_song, prune_auto_created_empty_tracks,
    realign_regions_after_warp_tempo_change, refresh_song_duration, replace_song_region_range,
    sanitize_region_bounds, set_song_tempo_at_source_position, shift_song_suffix,
    snap_regions_after_to_downbeats, song_has_active_warp, sort_song_regions,
    split_clips_crossing_point, timestamp_suffix, validate_time_signature, AudioChangeImpact,
    DesktopSession, TransposeHistoryTarget,
};

impl DesktopSession {
    pub fn create_section_marker(
        &mut self,
        start_seconds: f64,
        kind: Option<MarkerKind>,
        variant: Option<u8>,
        name: Option<String>,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        // The frontend hands us a click in view-time (the rendered timeline,
        // after warp/varispeed). Markers/regions/clips are stored in
        // source-time, so we have to undo the timeline mapping or the marker
        // will land at the wrong stored offset inside or after a
        // stretched region.
        let start_seconds = source_seconds_at_view(&song, start_seconds).max(0.0);
        // The caller may create the marker already typed (Section or Cue) and
        // named — the frontend supplies the localized name. Otherwise it falls
        // back to an untyped Custom marker with a generic generated name.
        let kind = kind.unwrap_or(MarkerKind::Custom);
        let marker_name = name
            .map(|n| n.trim().to_string())
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| song.next_marker_name());
        song.section_markers.push(Marker {
            id: format!("section_{}", timestamp_suffix()),
            name: marker_name,
            start_seconds,
            digit: None,
            kind,
            variant,
            color: None,
        });
        song.section_markers.sort_by(|left, right| {
            left.start_seconds
                .partial_cmp(&right.start_seconds)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        audio.update_live_section_markers(&song)?;
        self.persist_song_update(song, audio, AudioChangeImpact::MixerOnly, true)?;

        Ok(self.snapshot())
    }

    pub fn update_section_marker(
        &mut self,
        section_id: &str,
        name: &str,
        start_seconds: f64,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        let trimmed_name = name.trim();
        if trimmed_name.is_empty() {
            return Err(DesktopError::AudioCommand(
                "section name must not be empty".into(),
            ));
        }

        // View → source: see comment in create_section_marker.
        let start_seconds = source_seconds_at_view(&song, start_seconds).max(0.0);

        let section = song
            .section_markers
            .iter_mut()
            .find(|section| section.id == section_id)
            .ok_or_else(|| DesktopError::SectionNotFound(section_id.to_string()))?;

        section.name = trimmed_name.to_string();
        section.start_seconds = start_seconds;
        song.section_markers.sort_by(|left, right| {
            left.start_seconds
                .partial_cmp(&right.start_seconds)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        audio.update_live_section_markers(&song)?;
        self.persist_song_update(song, audio, AudioChangeImpact::MixerOnly, true)?;

        Ok(self.snapshot())
    }

    pub fn delete_section_marker(
        &mut self,
        section_id: &str,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        let section_count = song.section_markers.len();
        song.section_markers
            .retain(|section| section.id != section_id);

        if song.section_markers.len() == section_count {
            return Err(DesktopError::SectionNotFound(section_id.to_string()));
        }

        audio.update_live_section_markers(&song)?;
        self.persist_song_update(song, audio, AudioChangeImpact::MixerOnly, true)?;

        Ok(self.snapshot())
    }

    pub fn create_song_region(
        &mut self,
        start_seconds: f64,
        end_seconds: f64,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        // View-time → source-time conversion, see create_section_marker.
        let start_seconds = source_seconds_at_view(&song, start_seconds);
        let end_seconds = source_seconds_at_view(&song, end_seconds);
        let (start_seconds, end_seconds) =
            sanitize_region_bounds(&song, start_seconds, end_seconds)?;
        let region_index = song.regions.len();
        let region_name = audio
            .current_settings()
            .ok()
            .and_then(|settings| settings.locale)
            .map(|locale| locale.to_ascii_lowercase())
            .map(|locale| match locale.as_str() {
                "es" => format!("Canción {}", region_index + 1),
                _ => format!("Song {}", region_index + 1),
            })
            .unwrap_or_else(|| format!("Song {}", region_index + 1));
        let region = SongRegion {
            id: format!("region_{}_{}", timestamp_suffix(), region_index),
            name: region_name,
            start_seconds,
            end_seconds,
            transpose_semitones: 0,
            key: None,
            warp_enabled: false,
            warp_source_bpm: None,
            master: libretracks_core::SongMaster::default(),
        };

        replace_song_region_range(&mut song, region);
        audio.update_live_song_regions(&song)?;
        self.persist_song_update(song, audio, AudioChangeImpact::TransportOnly, true)?;

        Ok(self.snapshot())
    }

    /// Create an empty song (region) at the end of the current timeline,
    /// separated from the previous song by one bar of silence. The region
    /// itself is one bar wide so it's visible in the DAW view; the moment
    /// the user drops a clip into it the region will resize to fit (see
    /// ensure_region_covers_clip).
    ///
    /// Only used by the compact view's "+ Nueva canción" button. In the
    /// DAW view, regions are still created implicitly when clips drop onto
    /// empty timeline.
    pub fn create_empty_song(
        &mut self,
        name: Option<&str>,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;

        // Anchor: end of the last existing region (in source-time), or 0 if
        // this is the first song in the project.
        let anchor_source_seconds = song
            .regions
            .iter()
            .map(|region| region.end_seconds)
            .fold(0.0_f64, f64::max);

        // The first song in a fresh project starts at bar 1 (no leading
        // silence). For subsequent songs we want the boundary to be on a
        // real downbeat — using `lastEnd + one bar at the local BPM`
        // breaks when the previous song ended off-grid (trimmed region,
        // mid-bar tempo change, etc.), so we ask the song's tempo map
        // for the next downbeat at or after `anchor_source_seconds`.
        // Both offsets stay in source-time so they survive warp without
        // shifting visually.
        let is_first_region = song.regions.is_empty();
        let start_seconds = if is_first_region {
            0.0
        } else {
            next_downbeat_after_in_song(&song, anchor_source_seconds)
        };
        let bar_seconds = bar_seconds_at(&song, start_seconds);
        let end_seconds = start_seconds + bar_seconds;

        let region_index = song.regions.len();
        let region_name = name
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| {
                let locale = audio
                    .current_settings()
                    .ok()
                    .and_then(|settings| settings.locale)
                    .map(|locale| locale.to_ascii_lowercase());
                match locale.as_deref() {
                    Some("es") => format!("Canción {}", region_index + 1),
                    _ => format!("Song {}", region_index + 1),
                }
            });

        let region = SongRegion {
            id: format!("region_{}_{}", timestamp_suffix(), region_index),
            name: region_name,
            start_seconds,
            end_seconds,
            transpose_semitones: 0,
            key: None,
            warp_enabled: false,
            warp_source_bpm: None,
            master: libretracks_core::SongMaster::default(),
        };

        song.regions.push(region);
        sort_song_regions(&mut song.regions);

        // Anchor the new song to the project's global bpm so it doesn't
        // inherit the previous song's tempo marker. Without this any tempo
        // marker the user placed earlier would still be in effect at the
        // new song's start. We add the marker only when the new song is not
        // at t=0 (markers at the very start collapse into song.bpm anyway,
        // see upsert_song_tempo_marker for the same threshold) and only if
        // there isn't already a marker at the same position.
        if start_seconds > 0.0001
            && !song
                .tempo_markers
                .iter()
                .any(|marker| (marker.start_seconds - start_seconds).abs() < 0.0001)
        {
            song.tempo_markers.push(TempoMarker {
                id: format!("tempo_marker_{}", timestamp_suffix()),
                start_seconds,
                bpm: song.bpm,
            });
            song.tempo_markers.sort_by(|left, right| {
                left.start_seconds
                    .partial_cmp(&right.start_seconds)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
        }

        audio.update_live_song_regions(&song)?;
        self.persist_song_update(song, audio, AudioChangeImpact::TransportOnly, true)?;

        Ok(self.snapshot())
    }

    pub fn update_song_region(
        &mut self,
        region_id: &str,
        name: &str,
        start_seconds: f64,
        end_seconds: f64,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        let trimmed_name = name.trim();
        if trimmed_name.is_empty() {
            return Err(DesktopError::AudioCommand(
                "region name must not be empty".into(),
            ));
        }

        let existing_region = song
            .regions
            .iter()
            .find(|region| region.id == region_id)
            .cloned()
            .ok_or_else(|| DesktopError::RegionNotFound(region_id.to_string()))?;
        // View-time → source-time conversion, see create_section_marker.
        let start_seconds = source_seconds_at_view(&song, start_seconds);
        let end_seconds = source_seconds_at_view(&song, end_seconds);
        let (start_seconds, end_seconds) =
            sanitize_region_bounds(&song, start_seconds, end_seconds)?;
        let updated_region = SongRegion {
            id: existing_region.id.clone(),
            name: trimmed_name.to_string(),
            start_seconds,
            end_seconds,
            transpose_semitones: existing_region.transpose_semitones,
            key: existing_region.key.clone(),
            warp_enabled: existing_region.warp_enabled,
            warp_source_bpm: existing_region.warp_source_bpm,
            master: existing_region.master.clone(),
        };

        // Resizing a region NEVER moves its contents — the region is
        // just the named span that contains the clips and markers, not
        // a transform on them. Extending the left edge adds empty room
        // before whatever's already in the song; shrinking either edge
        // reclaims unused space at the boundary. The user's mental
        // model is "I'm changing where the box starts/ends", not "I'm
        // sliding the box and everything inside it".
        //
        // We only need to validate that a shrink doesn't leave clips
        // dangling outside the new bounds. If it would, refuse the
        // resize with a clear message instead of letting the engine's
        // invariant reject the sync with a cryptic boundary error.
        let start_delta = updated_region.start_seconds - existing_region.start_seconds;
        let shrinks_left = start_delta > f64::EPSILON;
        let shrinks_right = updated_region.end_seconds < existing_region.end_seconds - f64::EPSILON;
        if shrinks_left || shrinks_right {
            let old_start = existing_region.start_seconds;
            let old_end = existing_region.end_seconds;
            let inside_old_region = |pos: f64| pos >= old_start - 0.001 && pos < old_end;
            let new_start = updated_region.start_seconds;
            let new_end = updated_region.end_seconds;
            for clip in &song.clips {
                if !inside_old_region(clip.timeline_start_seconds) {
                    continue;
                }
                let clip_end = clip.timeline_start_seconds + clip.duration_seconds;
                let starts_before_new = clip.timeline_start_seconds < new_start - 0.001;
                let ends_after_new = clip_end > new_end + 0.001;
                if starts_before_new || ends_after_new {
                    return Err(DesktopError::AudioCommand(format!(
                        "no se puede reducir la region: el clip '{}' quedaria fuera del \
                         nuevo rango. Elimina o mueve los clips afectados antes de \
                         reducir la region.",
                        clip.id,
                    )));
                }
            }
        }

        // Drop the OLD copy of this region before delegating to
        // replace_song_region_range. That helper fragments any pre-existing
        // region that overlaps the replacement — useful when CREATING a new
        // region that carves through existing ones, but wrong when editing
        // the same region in place. Without this step, shrinking a region
        // makes the helper see the old (larger) version "overlapping" the
        // new (smaller) one and emits a spurious fragment for the cut-off
        // tail (reproduced as: "drag the end handle inward → a phantom
        // duplicate region appears with the trimmed name and the cut-off
        // span").
        song.regions
            .retain(|region| region.id != existing_region.id);
        replace_song_region_range(&mut song, updated_region);
        // Extending a region's end past the last clip is allowed (the region is
        // a named span, not a transform on its contents). The song must envelop
        // every region or the engine's session validator rejects the sync with
        // "Region X is outside its song", so grow the song duration to cover the
        // new region end. refresh_song_duration takes max(clip_end, region_end),
        // so shrinking back never strands the duration above real content.
        refresh_song_duration(&mut song);
        audio.update_live_song_regions(&song)?;
        self.persist_song_update(song, audio, AudioChangeImpact::TransportOnly, true)?;

        Ok(self.snapshot())
    }

    /// Atomically translate an entire song by `delta_seconds`. Moves
    /// the region itself + every clip whose timeline_start_seconds
    /// fell inside the region + every tempo / section /
    /// time-signature marker that lived inside the region, all by
    /// the same delta. One persist_song_update, one snapshot, one
    /// undo entry. Rejects the move if it would collide with a
    /// neighbouring region (the validator backs us up here too, but
    /// failing fast gives the user a friendlier error than the
    /// "regions out of order" downstream rejection).
    pub fn move_song_region(
        &mut self,
        region_id: &str,
        delta_seconds: f64,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;

        if !delta_seconds.is_finite() {
            return Err(DesktopError::AudioCommand(
                "delta_seconds must be a finite number".into(),
            ));
        }

        let existing_region = song
            .regions
            .iter()
            .find(|region| region.id == region_id)
            .cloned()
            .ok_or_else(|| DesktopError::RegionNotFound(region_id.to_string()))?;

        let old_start = existing_region.start_seconds;
        let old_end = existing_region.end_seconds;
        let new_start = old_start + delta_seconds;
        let new_end = old_end + delta_seconds;

        if new_start < 0.0 {
            return Err(DesktopError::AudioCommand(
                "no se puede mover la canción antes del inicio del proyecto".into(),
            ));
        }

        // Collision policy is asymmetric:
        //
        //   * Moving RIGHT into a following region: cascade-push the
        //     following regions to the right by the amount needed to
        //     resolve the overlap. realign_regions_after_warp_tempo_change
        //     later re-snaps each one to its bar.1, so the cascade
        //     converges to a clean bar-aligned arrangement.
        //
        //   * Moving LEFT into a preceding region: bounce the operation.
        //     There is no symmetric "push left" because doing so could
        //     push the predecessor before t=0 and silently swallow
        //     audio. The user can move the predecessors first.
        //
        // EDGE_EPS lets back-to-back boundaries (end == start) count as
        // touching, not overlapping.
        const EDGE_EPS: f64 = 1e-4;
        if delta_seconds < 0.0 {
            for other in &song.regions {
                if other.id == existing_region.id {
                    continue;
                }
                let overlaps_left = new_start < other.end_seconds - EDGE_EPS
                    && new_end > other.start_seconds + EDGE_EPS
                    && other.start_seconds < old_start;
                if overlaps_left {
                    return Err(DesktopError::AudioCommand(format!(
                        "no se puede mover la canción ahí: solaparía con '{}'",
                        other.name,
                    )));
                }
            }
        }

        // Translate everything that lived inside the old region by
        // the same offset: clips by timeline_start, markers by
        // start_seconds. We treat "inside" with a 1ms tolerance on
        // the left edge so markers placed exactly at start move with
        // the song (typical case: the per-song tempo marker the
        // importer pins at the region start).
        let inside_old = |pos: f64| pos >= old_start - 0.001 && pos < old_end;

        for clip in &mut song.clips {
            if inside_old(clip.timeline_start_seconds) {
                clip.timeline_start_seconds =
                    (clip.timeline_start_seconds + delta_seconds).max(0.0);
            }
        }
        for marker in &mut song.tempo_markers {
            if inside_old(marker.start_seconds) {
                marker.start_seconds = (marker.start_seconds + delta_seconds).max(0.0);
            }
        }
        for marker in &mut song.section_markers {
            if inside_old(marker.start_seconds) {
                marker.start_seconds = (marker.start_seconds + delta_seconds).max(0.0);
            }
        }
        for marker in &mut song.time_signature_markers {
            if inside_old(marker.start_seconds) {
                marker.start_seconds = (marker.start_seconds + delta_seconds).max(0.0);
            }
        }

        // Cascade-push following regions if the rightward move would
        // overlap them. We find the smallest "following" region that
        // overlaps and push from its original start. shift_song_suffix
        // moves regions/clips/markers from anchor onward; the moved
        // region itself is excluded because at this point song still
        // contains it at its OLD position (we haven't replaced it yet).
        if delta_seconds > 0.0 {
            let mut push_anchor: Option<f64> = None;
            let mut push_delta: f64 = 0.0;
            for other in &song.regions {
                if other.id == existing_region.id {
                    continue;
                }
                if other.start_seconds <= old_start {
                    continue; // not a follower
                }
                let needed = new_end - other.start_seconds + EDGE_EPS;
                if needed > push_delta {
                    push_delta = needed;
                    push_anchor = Some(other.start_seconds);
                } else if push_anchor.is_none() && needed > 0.0 {
                    push_anchor = Some(other.start_seconds);
                }
            }
            if let (Some(anchor), true) = (push_anchor, push_delta > 0.0) {
                shift_song_suffix(&mut song, anchor, push_delta);
            }
        }

        let updated_region = SongRegion {
            id: existing_region.id.clone(),
            name: existing_region.name.clone(),
            start_seconds: new_start,
            end_seconds: new_end,
            transpose_semitones: existing_region.transpose_semitones,
            key: existing_region.key.clone(),
            warp_enabled: existing_region.warp_enabled,
            warp_source_bpm: existing_region.warp_source_bpm,
            master: existing_region.master.clone(),
        };

        // Same rebuild flow as update_song_region: drop the old copy
        // then push the new one through replace_song_region_range so
        // the regions list stays sorted and consistent.
        song.regions
            .retain(|region| region.id != existing_region.id);
        replace_song_region_range(&mut song, updated_region);
        sort_song_regions(&mut song.regions);

        // Snap every region AFTER the moved one to the next downbeat
        // following its predecessor's end. We don't rely on the
        // "boundary was downbeat-aligned before" check from the
        // generic realign helper, because the cascade-push above can
        // displace successors by non-bar amounts (EDGE_EPS, or by
        // arbitrary deltas if the move's delta wasn't bar-quantised
        // — which the frontend allows). Unconditionally snapping the
        // tail to bar.1 matches the user expectation that "each song
        // sits on its own downbeat" after any move.
        snap_regions_after_to_downbeats(&mut song, &existing_region.id);

        refresh_song_duration(&mut song);
        audio.update_live_song_regions(&song)?;
        self.persist_song_update(song, audio, AudioChangeImpact::StructureRebuild, true)?;

        Ok(self.snapshot())
    }

    pub fn update_song_region_warp(
        &mut self,
        region_id: &str,
        warp_enabled: bool,
        warp_source_bpm: Option<f64>,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        // Validate the BPM mirror of the libretracks-core rule. Done here
        // (instead of relying on validate_song downstream) so the user gets a
        // specific error message and the engine never receives a bad value.
        if let Some(bpm) = warp_source_bpm {
            if !bpm.is_finite() {
                return Err(DesktopError::AudioCommand(
                    "warp source bpm must be a finite number".into(),
                ));
            }
            if !(libretracks_core::MIN_WARP_SOURCE_BPM..=libretracks_core::MAX_WARP_SOURCE_BPM)
                .contains(&bpm)
            {
                return Err(DesktopError::AudioCommand(format!(
                    "warp source bpm must be between {} and {}",
                    libretracks_core::MIN_WARP_SOURCE_BPM,
                    libretracks_core::MAX_WARP_SOURCE_BPM
                )));
            }
        } else if warp_enabled {
            return Err(DesktopError::AudioCommand(
                "warp source bpm is required when warp is enabled".into(),
            ));
        }

        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        let (live_warp_source_bpm, restore_tempo_on_disable) = {
            let region = song
                .regions
                .iter_mut()
                .find(|region| region.id == region_id)
                .ok_or_else(|| DesktopError::RegionNotFound(region_id.to_string()))?;

            region.warp_enabled = warp_enabled;
            if warp_source_bpm.is_some() {
                region.warp_source_bpm = warp_source_bpm;
            }

            let restore_tempo_on_disable = if warp_enabled {
                None
            } else {
                region
                    .warp_source_bpm
                    .map(|source_bpm| (region.start_seconds, source_bpm))
            };

            (region.warp_source_bpm, restore_tempo_on_disable)
        };

        if let Some((region_start_seconds, source_bpm)) = restore_tempo_on_disable {
            set_song_tempo_at_source_position(&mut song, region_start_seconds, source_bpm);
        }

        // Push the realtime command first so the engine swaps in the new ratio
        // on the next audio block. Persist as a timeline change because warp
        // also remaps clip/region lengths in the runtime timeline.
        audio.update_live_region_warp(region_id, warp_enabled, live_warp_source_bpm)?;
        self.persist_song_update_internal(
            song,
            audio,
            AudioChangeImpact::TimelineWindow,
            false,
            true,
        )?;

        Ok(self.snapshot())
    }

    pub fn update_song_region_transpose(
        &mut self,
        region_id: &str,
        transpose_semitones: i32,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        if !(MIN_TRANSPOSE_SEMITONES..=MAX_TRANSPOSE_SEMITONES).contains(&transpose_semitones) {
            return Err(DesktopError::AudioCommand(format!(
                "transpose semitones must be between {} and {}",
                MIN_TRANSPOSE_SEMITONES, MAX_TRANSPOSE_SEMITONES
            )));
        }

        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        let region = song
            .regions
            .iter_mut()
            .find(|region| region.id == region_id)
            .ok_or_else(|| DesktopError::RegionNotFound(region_id.to_string()))?;

        let record_history =
            self.should_record_transpose_history(TransposeHistoryTarget::Region(region.id.clone()));

        let changes_timeline = !region.warp_enabled;
        // Capture the values we'll need to compensate the songs that
        // follow this region, BEFORE we mutate it.
        let edited_region_id = region.id.clone();
        let edited_region_start = region.start_seconds;
        let edited_region_end = region.end_seconds;
        let edited_region_warp_enabled = region.warp_enabled;
        let previous_transpose = region.transpose_semitones;
        region.transpose_semitones = transpose_semitones;
        if jump_debug_logging_enabled() {
            eprintln!(
                "[LT_JUMP_DEBUG][state] region_transpose region={region_id} semitones={transpose_semitones} changes_timeline={changes_timeline}"
            );
        }

        // Varispeed compensation: changing a region's pitch with warp
        // OFF rescales its rendered duration on the timeline (Ableton
        // varispeed). Without compensation, every clip / region /
        // marker that lives AFTER the edited region's source range
        // would visually slide left or right because the renderer
        // applies the new shift. The user perception is "I changed
        // song 1's pitch and song 2 stopped starting on a bar".
        //
        // To keep the view-time of subsequent songs anchored, we
        // translate their stored source positions by the inverse of
        // the shift change introduced by the edit:
        //
        //   covered      = region.end - region.start         (source span)
        //   old_shift_per_region = covered / old_ratio - covered
        //   new_shift_per_region = covered / new_ratio - covered
        //   delta = old_shift_per_region - new_shift_per_region
        //         = covered * (1/old_ratio - 1/new_ratio)
        //
        // Adding `delta` to every downstream position keeps
        // warp_timeline_seconds_at(song, pos) constant after the edit.
        // Warp-enabled regions are NOT affected here — warp absorbs
        // the duration change into Bungee, so the rendered length
        // stays anchored to the timeline bpm and downstream view-
        // time is unchanged anyway.
        if changes_timeline && !edited_region_warp_enabled {
            let old_ratio = if previous_transpose != 0 {
                libretracks_core::semitones_to_pitch_scale(previous_transpose)
            } else {
                1.0
            };
            let new_ratio = if transpose_semitones != 0 {
                libretracks_core::semitones_to_pitch_scale(transpose_semitones)
            } else {
                1.0
            };
            let covered = (edited_region_end - edited_region_start).max(0.0);
            let old_shift = covered / old_ratio - covered;
            let new_shift = covered / new_ratio - covered;
            let delta = old_shift - new_shift;
            // Tolerance: only act when the delta would actually nudge
            // a sample. Skips the no-op case (e.g. user re-applied the
            // same semitones value via MIDI learn / stepper bounce).
            if delta.abs() > 1e-9 {
                // Translate every region, clip and marker whose source
                // position lies at or after the edited region's source
                // end. The edited region itself stays put — its
                // source bounds are unchanged; only its rendered
                // length scales because of the new pitch.
                for region_iter in song.regions.iter_mut() {
                    if region_iter.id == edited_region_id {
                        continue;
                    }
                    if region_iter.start_seconds >= edited_region_end - 1e-6 {
                        region_iter.start_seconds = (region_iter.start_seconds + delta).max(0.0);
                        region_iter.end_seconds = (region_iter.end_seconds + delta).max(0.0);
                    }
                }
                for clip in song.clips.iter_mut() {
                    if clip.timeline_start_seconds >= edited_region_end - 1e-6 {
                        clip.timeline_start_seconds =
                            (clip.timeline_start_seconds + delta).max(0.0);
                    }
                }
                for marker in song.tempo_markers.iter_mut() {
                    if marker.start_seconds >= edited_region_end - 1e-6 {
                        marker.start_seconds = (marker.start_seconds + delta).max(0.0);
                    }
                }
                for marker in song.section_markers.iter_mut() {
                    if marker.start_seconds >= edited_region_end - 1e-6 {
                        marker.start_seconds = (marker.start_seconds + delta).max(0.0);
                    }
                }
                for marker in song.time_signature_markers.iter_mut() {
                    if marker.start_seconds >= edited_region_end - 1e-6 {
                        marker.start_seconds = (marker.start_seconds + delta).max(0.0);
                    }
                }
                sort_song_regions(&mut song.regions);
                refresh_song_duration(&mut song);
            }
        }
        if changes_timeline {
            // Warp off means pitch is varispeed: changing semitones changes
            // the rendered timeline length, so clips, regions and markers
            // must all be resent in runtime/view time.
            self.persist_song_update_internal(
                song,
                audio,
                AudioChangeImpact::TimelineWindow,
                record_history,
                true,
            )?;
        } else {
            // Warp absorbs duration, so region transpose is pitch-only.
            audio.update_live_region_transpose(region_id, transpose_semitones)?;
            self.persist_song_update_internal(
                song,
                audio,
                AudioChangeImpact::MixerOnly,
                record_history,
                true,
            )?;
        }
        self.last_runtime_pitch = Some(audio.pitch_prepare_summary());
        self.last_source_readiness = Some(audio.source_readiness_summary());

        Ok(self.snapshot())
    }

    pub fn update_song_region_master_gain(
        &mut self,
        region_id: &str,
        master_gain: f64,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        if !master_gain.is_finite() || master_gain < 0.0 {
            return Err(DesktopError::AudioCommand(
                "master gain must be a finite, non-negative number".into(),
            ));
        }

        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        let region = song
            .regions
            .iter_mut()
            .find(|region| region.id == region_id)
            .ok_or_else(|| DesktopError::RegionNotFound(region_id.to_string()))?;
        region.master.gain = master_gain;

        audio.update_live_region_master_gain(region_id, master_gain as f32)?;
        self.persist_song_update(song, audio, AudioChangeImpact::MixerOnly, true)?;

        Ok(self.snapshot())
    }

    pub fn update_track_transpose_enabled(
        &mut self,
        track_id: &str,
        transpose_enabled: bool,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        let track = song
            .tracks
            .iter_mut()
            .find(|track| track.id == track_id)
            .ok_or_else(|| DesktopError::TrackNotFound(track_id.to_string()))?;

        let record_history =
            self.should_record_transpose_history(TransposeHistoryTarget::Track(track.id.clone()));

        track.transpose_enabled = transpose_enabled;

        // Send the realtime command first — C++ handles the session clone + pitch stream
        // rebuild via CmdSetTrackTransposeEnabled. MixerOnly skips the LoadSession path
        // so we don't trigger a redundant full session reload on top.
        audio.set_track_transpose_enabled_realtime(track_id, transpose_enabled)?;
        self.persist_song_update_internal(
            song,
            audio,
            AudioChangeImpact::MixerOnly,
            record_history,
            true,
        )?;
        self.last_runtime_pitch = Some(audio.pitch_prepare_summary());
        self.last_source_readiness = Some(audio.source_readiness_summary());

        Ok(self.snapshot())
    }

    pub fn delete_song_region(
        &mut self,
        region_id: &str,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        let region_index = song
            .regions
            .iter()
            .position(|region| region.id == region_id)
            .ok_or_else(|| DesktopError::RegionNotFound(region_id.to_string()))?;

        // Snapshot the region bounds before removing so we can also evict
        // any clips and markers that live inside its range. Without this the
        // clips would survive past the region's removal and break the "clip
        // lives inside one region" invariant (step 4.1), and stale tempo /
        // section markers would keep affecting playback at positions the user
        // thought were gone with the song. Section markers in particular also
        // break the next LoadSession: the C++ validator rejects a marker whose
        // frame no longer falls inside any song range ("Marker X is outside
        // its song"), so deleting a song with markers must take its markers.
        let region_start = song.regions[region_index].start_seconds;
        let region_end = song.regions[region_index].end_seconds;

        song.regions.remove(region_index);
        song.clips.retain(|clip| {
            clip.timeline_start_seconds < region_start || clip.timeline_start_seconds >= region_end
        });
        song.tempo_markers.retain(|marker| {
            marker.start_seconds < region_start || marker.start_seconds >= region_end
        });
        song.section_markers.retain(|marker| {
            marker.start_seconds < region_start || marker.start_seconds >= region_end
        });

        sort_song_regions(&mut song.regions);
        // Pruning auto-created tracks whose only clip(s) lived inside the
        // deleted region keeps the mixer view tidy without an extra round
        // trip — same prune we already apply on clip move / delete paths.
        prune_auto_created_empty_tracks(&mut song);
        refresh_song_duration(&mut song);

        audio.update_live_song_regions(&song)?;
        self.persist_song_update(song, audio, AudioChangeImpact::StructureRebuild, true)?;

        Ok(self.snapshot())
    }

    /// Split a song (SongRegion) in two at `split_seconds_view`. The left half
    /// keeps the original id/name/transpose/warp/master; the right half is a new
    /// region named "<name> (2)" inheriting the same musical settings (it is the
    /// same song, cut in two). Clips and markers are NOT moved — each already
    /// belongs to whichever half contains its start (the "clip lives inside one
    /// region" invariant), so the split point alone redistributes them. A clip
    /// straddling the cut stays in the left half (its start is left of the cut);
    /// the user can split that clip separately if they want.
    pub fn split_song_region(
        &mut self,
        region_id: &str,
        split_seconds_view: f64,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;

        let region_index = song
            .regions
            .iter()
            .position(|region| region.id == region_id)
            .ok_or_else(|| DesktopError::RegionNotFound(region_id.to_string()))?;

        // Region bounds live in source-time; the cursor is view-time. Convert,
        // mirroring split_clips.
        let split_seconds = source_seconds_at_view(&song, split_seconds_view);
        let region = song.regions[region_index].clone();
        // The cut must fall strictly inside the region, with enough room for two
        // non-degenerate halves.
        if split_seconds <= region.start_seconds + 0.001
            || split_seconds >= region.end_seconds - 0.001
        {
            return Err(DesktopError::InvalidSplitPoint);
        }

        // A clip may not cross a region boundary (the engine rejects it). Any
        // clip straddling the cut is split there too, so each half stays inside
        // its song — exactly what split_clips does at the cursor.
        split_clips_crossing_point(&mut song, split_seconds_view);

        let right = SongRegion {
            id: format!("region_{}_{}", timestamp_suffix(), song.regions.len()),
            name: format!("{} (2)", region.name),
            start_seconds: split_seconds,
            end_seconds: region.end_seconds,
            transpose_semitones: region.transpose_semitones,
            key: region.key.clone(),
            warp_enabled: region.warp_enabled,
            warp_source_bpm: region.warp_source_bpm,
            master: region.master.clone(),
        };
        // Left half: shrink the original region's end to the cut.
        song.regions[region_index].end_seconds = split_seconds;
        song.regions.push(right);
        sort_song_regions(&mut song.regions);

        audio.update_live_song_regions(&song)?;
        self.persist_song_update(song, audio, AudioChangeImpact::StructureRebuild, true)?;

        Ok(self.snapshot())
    }

    pub fn assign_section_marker_digit(
        &mut self,
        section_id: &str,
        digit: Option<u8>,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;

        if let Some(digit) = digit {
            for marker in song.section_markers.iter_mut() {
                if marker.id != section_id && marker.digit == Some(digit) {
                    marker.digit = None;
                }
            }
        }

        let marker = song
            .section_markers
            .iter_mut()
            .find(|section| section.id == section_id)
            .ok_or_else(|| DesktopError::SectionNotFound(section_id.to_string()))?;
        marker.digit = digit;

        // MixerOnly: section markers are Rust-model-only. C++ does not read them.
        self.persist_song_update(song, audio, AudioChangeImpact::MixerOnly, true)?;

        Ok(self.snapshot())
    }

    pub fn set_section_marker_kind(
        &mut self,
        section_id: &str,
        kind: MarkerKind,
        variant: Option<u8>,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;

        let marker = song
            .section_markers
            .iter_mut()
            .find(|section| section.id == section_id)
            .ok_or_else(|| DesktopError::SectionNotFound(section_id.to_string()))?;
        marker.kind = kind;
        marker.variant = variant;

        // Section markers ARE read by the engine voice guide (kind+variant pick
        // the announcement clip), so push them live as well as persisting.
        audio.update_live_section_markers(&song)?;
        self.persist_song_update(song, audio, AudioChangeImpact::MixerOnly, true)?;

        Ok(self.snapshot())
    }

    /// Set (or clear, with `None`) a marker's colour override. Only meaningful
    /// for Custom markers — typed sections/cues take their colour from the kind
    /// palette — but the backend just stores whatever the caller sends. Colour
    /// is presentation-only (the engine never reads it), so this does not touch
    /// the live voice-guide markers.
    pub fn set_section_marker_color(
        &mut self,
        section_id: &str,
        color: Option<String>,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;

        let marker = song
            .section_markers
            .iter_mut()
            .find(|section| section.id == section_id)
            .ok_or_else(|| DesktopError::SectionNotFound(section_id.to_string()))?;
        marker.color = color
            .map(|c| c.trim().to_string())
            .filter(|c| !c.is_empty());

        self.persist_song_update(song, audio, AudioChangeImpact::MixerOnly, true)?;

        Ok(self.snapshot())
    }

    pub fn update_song_tempo(
        &mut self,
        bpm: f64,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        if !bpm.is_finite() || bpm < 20.0 || bpm > 300.0 {
            return Err(DesktopError::AudioCommand(
                "song bpm must be between 20.0 and 300.0".into(),
            ));
        }

        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        let previous_song = song.clone();
        song.bpm = bpm;
        realign_regions_after_warp_tempo_change(&previous_song, &mut song);

        let impact = if song_has_active_warp(&song) {
            AudioChangeImpact::TimelineWindow
        } else {
            AudioChangeImpact::TransportOnly
        };
        self.persist_song_update(song, audio, impact, true)?;

        Ok(self.snapshot())
    }

    /// Sets a region's (song's) original musical key (e.g. `"Dm"`, `"F#"`).
    /// Pure display metadata — the audible pitch is driven by the region's
    /// `transpose_semitones`, so this only persists and re-emits the snapshot.
    /// `None` (or an empty/whitespace string) clears the key.
    pub fn update_song_region_key(
        &mut self,
        region_id: &str,
        key: Option<String>,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        let region = song
            .regions
            .iter_mut()
            .find(|region| region.id == region_id)
            .ok_or_else(|| DesktopError::RegionNotFound(region_id.to_string()))?;
        region.key = key
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());

        self.persist_song_update(song, audio, AudioChangeImpact::TransportOnly, true)?;

        Ok(self.snapshot())
    }

    pub fn upsert_song_tempo_marker(
        &mut self,
        start_seconds: f64,
        bpm: f64,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        if !bpm.is_finite() || bpm < 20.0 || bpm > 300.0 {
            return Err(DesktopError::AudioCommand(
                "song bpm marker must be between 20.0 and 300.0".into(),
            ));
        }

        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        // View-time → source-time conversion, see create_section_marker.
        let previous_song = song.clone();
        let clamped_start_seconds = source_seconds_at_view(&song, start_seconds).max(0.0);

        if clamped_start_seconds <= 0.0001 {
            song.bpm = bpm;
        } else if let Some(existing_marker) = song
            .tempo_markers
            .iter_mut()
            .find(|marker| (marker.start_seconds - clamped_start_seconds).abs() < 0.0001)
        {
            existing_marker.bpm = bpm;
        } else {
            song.tempo_markers.push(TempoMarker {
                id: format!("tempo_marker_{}", timestamp_suffix()),
                start_seconds: clamped_start_seconds,
                bpm,
            });
            song.tempo_markers.sort_by(|left, right| {
                left.start_seconds
                    .partial_cmp(&right.start_seconds)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
        }
        realign_regions_after_warp_tempo_change(&previous_song, &mut song);

        let impact = if song_has_active_warp(&song) {
            AudioChangeImpact::TimelineWindow
        } else {
            AudioChangeImpact::TransportOnly
        };
        self.persist_song_update(song, audio, impact, true)?;

        Ok(self.snapshot())
    }

    pub fn delete_song_tempo_marker(
        &mut self,
        marker_id: &str,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        let previous_song = song.clone();
        let marker_index = song
            .tempo_markers
            .iter()
            .position(|marker| marker.id == marker_id)
            .ok_or_else(|| DesktopError::AudioCommand("tempo marker not found".into()))?;
        song.tempo_markers.remove(marker_index);
        realign_regions_after_warp_tempo_change(&previous_song, &mut song);

        let impact = if song_has_active_warp(&song) {
            AudioChangeImpact::TimelineWindow
        } else {
            AudioChangeImpact::TransportOnly
        };
        self.persist_song_update(song, audio, impact, true)?;

        Ok(self.snapshot())
    }

    pub fn update_song_time_signature(
        &mut self,
        signature: &str,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        validate_time_signature(signature)?;

        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        song.time_signature = signature.to_string();

        self.persist_song_update(song, audio, AudioChangeImpact::TransportOnly, true)?;

        Ok(self.snapshot())
    }

    pub fn upsert_song_time_signature_marker(
        &mut self,
        start_seconds: f64,
        signature: &str,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        validate_time_signature(signature)?;

        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        // View-time → source-time conversion, see create_section_marker.
        let clamped_start_seconds = source_seconds_at_view(&song, start_seconds).max(0.0);

        if clamped_start_seconds <= 0.0001 {
            song.time_signature = signature.to_string();
        } else if let Some(existing_marker) = song
            .time_signature_markers
            .iter_mut()
            .find(|marker| (marker.start_seconds - clamped_start_seconds).abs() < 0.0001)
        {
            existing_marker.signature = signature.to_string();
        } else {
            song.time_signature_markers.push(TimeSignatureMarker {
                id: format!("time_signature_marker_{}", timestamp_suffix()),
                start_seconds: clamped_start_seconds,
                signature: signature.to_string(),
            });
            song.time_signature_markers.sort_by(|left, right| {
                left.start_seconds
                    .partial_cmp(&right.start_seconds)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
        }

        self.persist_song_update(song, audio, AudioChangeImpact::TransportOnly, true)?;

        Ok(self.snapshot())
    }

    pub fn delete_song_time_signature_marker(
        &mut self,
        marker_id: &str,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        let marker_index = song
            .time_signature_markers
            .iter()
            .position(|marker| marker.id == marker_id)
            .ok_or_else(|| DesktopError::AudioCommand("time signature marker not found".into()))?;
        song.time_signature_markers.remove(marker_index);

        self.persist_song_update(song, audio, AudioChangeImpact::TransportOnly, true)?;

        Ok(self.snapshot())
    }
}
