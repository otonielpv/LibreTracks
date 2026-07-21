//! Arrangement editing on `DesktopSession`: clip operations (move/delete/
//! duplicate/split, live drags, batch moves, reassign to track) and track CRUD
//! (create/move/update/delete tracks and folders, mix commits). Everything here
//! mutates the loaded `Song` structure and persists it.

use std::collections::HashSet;

use libretracks_core::{source_seconds_at_view, Clip, Track, TrackKind};

use crate::audio::engine::AudioController;
use crate::infra::error::DesktopError;
use crate::models::TransportSnapshot;

use super::{
    append_clip_to_song, apply_clip_moves_with_region_reshape, delete_track_and_repair_hierarchy,
    ensure_region_covers_clip, file_stem_for_auto_track, insert_track,
    normalize_timeline_start_seconds, normalize_ui_color, prune_auto_created_empty_tracks,
    prune_empty_regions, refresh_song_duration, reparent_track, timestamp_suffix,
    validate_clip_window, AudioChangeImpact, ClipMoveRequest, CreateAudioTrackWithClipRequest,
    CreateClipRequest, CreateClipWithAutoTrackRequest, DesktopSession,
};

impl DesktopSession {
    pub fn move_clip(
        &mut self,
        clip_id: &str,
        timeline_start_seconds: f64,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        // View-time → source-time conversion, see create_section_marker.
        let timeline_start_seconds = source_seconds_at_view(&song, timeline_start_seconds);
        let new_start = normalize_timeline_start_seconds(timeline_start_seconds);
        let clip_duration = song
            .clips
            .iter()
            .find(|clip| clip.id == clip_id)
            .map(|clip| clip.duration_seconds)
            .ok_or_else(|| DesktopError::ClipNotFound(clip_id.to_string()))?;

        // Reshape the regions first (auto-create or auto-extend) so the
        // move never produces a transient state where the clip lives
        // outside every region.
        ensure_region_covers_clip(&mut song, new_start, new_start + clip_duration)?;

        let clip = song
            .clips
            .iter_mut()
            .find(|clip| clip.id == clip_id)
            .ok_or_else(|| DesktopError::ClipNotFound(clip_id.to_string()))?;
        clip.timeline_start_seconds = new_start;
        prune_empty_regions(&mut song);
        prune_auto_created_empty_tracks(&mut song);
        refresh_song_duration(&mut song);

        self.persist_song_update(song, audio, AudioChangeImpact::TimelineWindow, true)?;

        Ok(self.snapshot())
    }

    pub fn move_clip_live(
        &mut self,
        clip_id: &str,
        timeline_start_seconds: f64,
        audio: &AudioController,
    ) -> Result<(), DesktopError> {
        self.sync_position(audio)?;
        self.capture_live_history_anchor();

        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        // View-time → source-time conversion, see create_section_marker.
        let timeline_start_seconds = source_seconds_at_view(&song, timeline_start_seconds);
        let new_start = normalize_timeline_start_seconds(timeline_start_seconds);
        let clip_duration = song
            .clips
            .iter()
            .find(|clip| clip.id == clip_id)
            .map(|clip| clip.duration_seconds)
            .ok_or_else(|| DesktopError::ClipNotFound(clip_id.to_string()))?;

        ensure_region_covers_clip(&mut song, new_start, new_start + clip_duration)?;

        let clip = song
            .clips
            .iter_mut()
            .find(|clip| clip.id == clip_id)
            .ok_or_else(|| DesktopError::ClipNotFound(clip_id.to_string()))?;
        clip.timeline_start_seconds = new_start;
        prune_empty_regions(&mut song);
        prune_auto_created_empty_tracks(&mut song);
        refresh_song_duration(&mut song);

        self.persist_song_update_internal(
            song,
            audio,
            AudioChangeImpact::TimelineWindow,
            false,
            false,
        )?;

        Ok(())
    }

    pub fn move_clips_batch(
        &mut self,
        moves: &[ClipMoveRequest],
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        if moves.is_empty() {
            return Ok(self.snapshot());
        }

        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;

        apply_clip_moves_with_region_reshape(&mut song, moves)?;
        prune_empty_regions(&mut song);
        prune_auto_created_empty_tracks(&mut song);
        refresh_song_duration(&mut song);
        self.persist_song_update(song, audio, AudioChangeImpact::TimelineWindow, true)?;

        Ok(self.snapshot())
    }

    pub fn move_clips_live_batch(
        &mut self,
        moves: &[ClipMoveRequest],
        audio: &AudioController,
    ) -> Result<(), DesktopError> {
        if moves.is_empty() {
            return Ok(());
        }

        self.sync_position(audio)?;
        self.capture_live_history_anchor();

        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;

        apply_clip_moves_with_region_reshape(&mut song, moves)?;
        prune_empty_regions(&mut song);
        prune_auto_created_empty_tracks(&mut song);
        refresh_song_duration(&mut song);

        self.persist_song_update_internal(
            song,
            audio,
            AudioChangeImpact::TimelineWindow,
            false,
            false,
        )?;

        Ok(())
    }

    pub fn delete_clip(
        &mut self,
        clip_id: &str,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        self.delete_clips(&[clip_id.to_string()], audio)
    }

    /// Batched deletion. Removes every id in `clip_ids` in a single
    /// persist_song_update, so a multi-clip delete is one engine reload
    /// + one history entry instead of N. Missing ids are tolerated
    /// silently (could have been pruned by a previous cascade) — the
    /// only hard error is the whole batch missing.
    pub fn delete_clips(
        &mut self,
        clip_ids: &[String],
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        if clip_ids.is_empty() {
            return Err(DesktopError::ClipNotFound(String::new()));
        }
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        let id_set: HashSet<&str> = clip_ids.iter().map(String::as_str).collect();
        let before_count = song.clips.len();
        song.clips.retain(|clip| !id_set.contains(clip.id.as_str()));
        if song.clips.len() == before_count {
            // None of the ids matched. Surface the first one so the
            // error message is concrete.
            return Err(DesktopError::ClipNotFound(
                clip_ids.first().cloned().unwrap_or_default(),
            ));
        }

        // Per the song-model plan (step 4.5), a region that loses its
        // last clip is auto-deleted. The whole operation rides on a
        // single persist_song_update so undo restores the clips AND the
        // region together.
        prune_empty_regions(&mut song);
        prune_auto_created_empty_tracks(&mut song);

        refresh_song_duration(&mut song);
        self.persist_song_update(song, audio, AudioChangeImpact::StructureRebuild, true)?;

        Ok(self.snapshot())
    }

    /// Reassign a clip to a different track without changing its position
    /// on the timeline. Backs the compact view's right-click "Mover a
    /// track…" submenu. If the clip's original track was auto-created and
    /// loses its only clip in the process, the track is removed from the
    /// project so the mixer doesn't accumulate one-shot tracks.
    pub fn move_clip_to_track(
        &mut self,
        clip_id: &str,
        target_track_id: &str,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;

        let target_kind = song
            .tracks
            .iter()
            .find(|track| track.id == target_track_id)
            .map(|track| track.kind)
            .ok_or_else(|| DesktopError::TrackNotFound(target_track_id.to_string()))?;
        if target_kind == libretracks_core::TrackKind::Folder {
            return Err(DesktopError::AudioCommand(
                "no se puede mover un clip a un folder".into(),
            ));
        }

        let clip = song
            .clips
            .iter_mut()
            .find(|clip| clip.id == clip_id)
            .ok_or_else(|| DesktopError::ClipNotFound(clip_id.to_string()))?;
        if clip.track_id == target_track_id {
            return Ok(self.snapshot());
        }
        clip.track_id = target_track_id.to_string();

        prune_auto_created_empty_tracks(&mut song);
        self.persist_song_update(song, audio, AudioChangeImpact::StructureRebuild, true)?;

        Ok(self.snapshot())
    }

    pub fn update_clip_window(
        &mut self,
        clip_id: &str,
        timeline_start_seconds: f64,
        source_start_seconds: f64,
        duration_seconds: f64,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        let song_dir = self.song_dir.clone().ok_or(DesktopError::NoSongLoaded)?;
        let clip = song
            .clips
            .iter_mut()
            .find(|clip| clip.id == clip_id)
            .ok_or_else(|| DesktopError::ClipNotFound(clip_id.to_string()))?;

        validate_clip_window(
            &song_dir,
            &clip.file_path,
            timeline_start_seconds,
            source_start_seconds,
            duration_seconds,
        )?;

        clip.timeline_start_seconds = normalize_timeline_start_seconds(timeline_start_seconds);
        clip.source_start_seconds = source_start_seconds.max(0.0);
        clip.duration_seconds = duration_seconds;
        refresh_song_duration(&mut song);

        self.persist_song_update(song, audio, AudioChangeImpact::TimelineWindow, true)?;

        Ok(self.snapshot())
    }

    pub fn duplicate_clip(
        &mut self,
        clip_id: &str,
        timeline_start_seconds: f64,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        self.duplicate_clips(&[(clip_id.to_string(), timeline_start_seconds)], audio)
    }

    pub fn duplicate_clips(
        &mut self,
        placements: &[(String, f64)],
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        if placements.is_empty() {
            return Ok(self.snapshot());
        }

        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;

        let source_clips = placements
            .iter()
            .map(|(clip_id, timeline_start_seconds)| {
                let source_clip = song
                    .clips
                    .iter()
                    .find(|clip| clip.id == *clip_id)
                    .cloned()
                    .ok_or_else(|| DesktopError::ClipNotFound(clip_id.clone()))?;
                Ok((source_clip, *timeline_start_seconds))
            })
            .collect::<Result<Vec<_>, DesktopError>>()?;

        let timestamp = timestamp_suffix();
        for (index, (source_clip, timeline_start_seconds)) in source_clips.into_iter().enumerate() {
            let mut duplicated_clip = source_clip;
            duplicated_clip.id = format!("clip_{timestamp}_{index}");
            // View → source first (warp-aware mapping), then normalize so the
            // duplicated clip never lands at a negative timeline position.
            // Mirrors the pattern used by paste_clips and create_section_marker.
            duplicated_clip.timeline_start_seconds = normalize_timeline_start_seconds(
                source_seconds_at_view(&song, timeline_start_seconds),
            );
            song.clips.push(duplicated_clip);
        }
        refresh_song_duration(&mut song);

        self.persist_song_update(song, audio, AudioChangeImpact::TimelineWindow, true)?;

        Ok(self.snapshot())
    }

    pub fn create_track(
        &mut self,
        name: &str,
        kind: TrackKind,
        insert_after_track_id: Option<&str>,
        parent_track_id: Option<&str>,
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
                "track name must not be empty".into(),
            ));
        }

        let audio_to = if parent_track_id.is_some() {
            "inherit".to_string()
        } else {
            "master".to_string()
        };

        let track = Track {
            id: format!("track_{}", timestamp_suffix()),
            name: trimmed_name.to_string(),
            kind,
            parent_track_id: parent_track_id.map(str::to_string),
            volume: 1.0,
            pan: 0.0,
            muted: false,
            solo: false,
            transpose_enabled: true,
            audio_to,
            color: None,
            auto_created: false,
        };

        insert_track(
            &mut song.tracks,
            track,
            insert_after_track_id,
            parent_track_id,
        )?;
        self.persist_song_update(song, audio, AudioChangeImpact::StructureRebuild, true)?;

        Ok(self.snapshot())
    }

    pub fn create_clip(
        &mut self,
        track_id: &str,
        file_path: &str,
        timeline_start_seconds: f64,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        self.create_clips_batch(
            &[CreateClipRequest {
                track_id: track_id.to_string(),
                file_path: file_path.to_string(),
                timeline_start_seconds,
            }],
            audio,
        )
    }

    pub fn create_clips_batch(
        &mut self,
        requests: &[CreateClipRequest],
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        if requests.is_empty() {
            return Ok(self.snapshot());
        }

        let song_dir = self.song_dir.clone().ok_or(DesktopError::NoSongLoaded)?;
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;

        // Each request carries `timeline_start_seconds` in view-time (the
        // user dragged the clip to a visible point on the timeline). Convert
        // to source-time before append so warp/varispeed regions don't shift
        // the clip away from where the user dropped it.
        let mapped_requests: Vec<CreateClipRequest> = requests
            .iter()
            .map(|req| CreateClipRequest {
                track_id: req.track_id.clone(),
                file_path: req.file_path.clone(),
                timeline_start_seconds: source_seconds_at_view(&song, req.timeline_start_seconds),
            })
            .collect();
        for request in &mapped_requests {
            append_clip_to_song(&mut song, &song_dir, request)?;
        }
        refresh_song_duration(&mut song);

        self.persist_song_update(song, audio, AudioChangeImpact::StructureRebuild, true)?;

        Ok(self.snapshot())
    }

    /// Drop a list of audio files onto a song column in the compact view.
    /// Each file gets its own auto-created audio track (named after the
    /// file stem), and a clip pointing at that track. All clips land at
    /// the same `timeline_start_seconds` — the start of the target song —
    /// per the user's request "drop N files into a column → N rows".
    pub fn create_clips_with_auto_tracks(
        &mut self,
        requests: &[CreateClipWithAutoTrackRequest],
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        if requests.is_empty() {
            return Ok(self.snapshot());
        }

        let song_dir = self.song_dir.clone().ok_or(DesktopError::NoSongLoaded)?;
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;

        for (offset, request) in requests.iter().enumerate() {
            let source_start_seconds =
                source_seconds_at_view(&song, request.timeline_start_seconds);
            let track_name = file_stem_for_auto_track(&request.file_path);
            let track_id = format!(
                "track_{}_{}",
                timestamp_suffix(),
                song.tracks.len() + offset,
            );
            song.tracks.push(libretracks_core::Track {
                id: track_id.clone(),
                name: track_name,
                kind: libretracks_core::TrackKind::Audio,
                parent_track_id: None,
                volume: 1.0,
                pan: 0.0,
                muted: false,
                solo: false,
                transpose_enabled: true,
                audio_to: "master".to_string(),
                color: None,
                auto_created: true,
            });
            append_clip_to_song(
                &mut song,
                &song_dir,
                &CreateClipRequest {
                    track_id,
                    file_path: request.file_path.clone(),
                    timeline_start_seconds: source_start_seconds,
                },
            )?;
        }

        refresh_song_duration(&mut song);
        self.persist_song_update(song, audio, AudioChangeImpact::StructureRebuild, true)?;

        Ok(self.snapshot())
    }

    /// Drop a list of library assets onto the timeline: each becomes a
    /// persistent audio track (named `track_name`) holding one clip. The whole
    /// batch is a single song update so the cost is one rebuild regardless of
    /// how many assets are dropped or how much the song already holds.
    pub fn create_audio_tracks_with_clips(
        &mut self,
        requests: &[CreateAudioTrackWithClipRequest],
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        if requests.is_empty() {
            return Ok(self.snapshot());
        }

        let song_dir = self.song_dir.clone().ok_or(DesktopError::NoSongLoaded)?;
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;

        for (offset, request) in requests.iter().enumerate() {
            let trimmed_name = request.track_name.trim();
            if trimmed_name.is_empty() {
                return Err(DesktopError::AudioCommand(
                    "track name must not be empty".into(),
                ));
            }
            // view-time -> source-time, same conversion create_clips_batch does
            // so warp/varispeed regions don't shift the clip from the drop point.
            let source_start_seconds =
                source_seconds_at_view(&song, request.timeline_start_seconds);
            let track_id = format!(
                "track_{}_{}",
                timestamp_suffix(),
                song.tracks.len() + offset
            );
            song.tracks.push(Track {
                id: track_id.clone(),
                name: trimmed_name.to_string(),
                kind: TrackKind::Audio,
                parent_track_id: None,
                volume: 1.0,
                pan: 0.0,
                muted: false,
                solo: false,
                transpose_enabled: true,
                audio_to: "master".to_string(),
                color: None,
                auto_created: false,
            });
            append_clip_to_song(
                &mut song,
                &song_dir,
                &CreateClipRequest {
                    track_id,
                    file_path: request.file_path.clone(),
                    timeline_start_seconds: source_start_seconds,
                },
            )?;
        }

        refresh_song_duration(&mut song);
        self.persist_song_update(song, audio, AudioChangeImpact::StructureRebuild, true)?;

        Ok(self.snapshot())
    }

    pub fn move_track(
        &mut self,
        track_id: &str,
        insert_after_track_id: Option<&str>,
        insert_before_track_id: Option<&str>,
        parent_track_id: Option<&str>,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;

        reparent_track(
            &mut song.tracks,
            track_id,
            insert_after_track_id,
            insert_before_track_id,
            parent_track_id,
        )?;
        self.persist_song_update(song, audio, AudioChangeImpact::StructureRebuild, true)?;

        Ok(self.snapshot())
    }

    /// RuntimeUpdateKind: ModelOnly — update track name/metadata. No audio command sent.
    /// `updateTrack` (frontend) routes here when only name is present and no mix fields.
    pub fn update_track_metadata(
        &mut self,
        track_id: &str,
        name: &str,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        self.sync_position(audio)?;
        self.push_history_entry();
        self.redo_stack.clear();
        self.update_loaded_track(track_id, Some(name), None, None, None, None, None)?;
        self.perf_metrics.song_save_millis = 0;
        self.project_revision = self.project_revision.saturating_add(1);
        audio.record_commit_model_only();
        Ok(self.snapshot())
    }

    /// Kept for backwards-compat alias — delegates to update_track_metadata.
    pub fn update_track_color(
        &mut self,
        track_id: &str,
        color: Option<&str>,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        self.sync_position(audio)?;
        self.push_history_entry();
        self.redo_stack.clear();

        let color = normalize_ui_color(color)?;
        let track = self
            .engine
            .song_mut()?
            .tracks
            .iter_mut()
            .find(|track| track.id == track_id)
            .ok_or_else(|| DesktopError::TrackNotFound(track_id.to_string()))?;
        track.color = color;

        self.perf_metrics.song_save_millis = 0;
        self.project_revision = self.project_revision.saturating_add(1);
        audio.record_commit_model_only();
        Ok(self.snapshot())
    }

    pub fn update_clip_color(
        &mut self,
        clip_id: &str,
        color: Option<&str>,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        self.sync_position(audio)?;
        self.push_history_entry();
        self.redo_stack.clear();

        let color = normalize_ui_color(color)?;
        let clip = self
            .engine
            .song_mut()?
            .clips
            .iter_mut()
            .find(|clip| clip.id == clip_id)
            .ok_or_else(|| DesktopError::ClipNotFound(clip_id.to_string()))?;
        clip.color = color;

        self.perf_metrics.song_save_millis = 0;
        self.project_revision = self.project_revision.saturating_add(1);
        audio.record_commit_model_only();
        Ok(self.snapshot())
    }

    #[allow(dead_code)]
    pub fn update_track_name_only(
        &mut self,
        track_id: &str,
        name: &str,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        self.update_track_metadata(track_id, name, audio)
    }

    /// RuntimeUpdateKind: TargetedRealtimeCommand — commit mixer state (volume/pan/muted/solo/route)
    /// to the Rust model and send exactly one targeted Category A command to C++.
    /// This is the ONLY path that may touch both the Rust model AND the live mixer for these fields.
    pub fn commit_track_mix_model_and_command(
        &mut self,
        track_id: &str,
        volume: Option<f64>,
        pan: Option<f64>,
        muted: Option<bool>,
        solo: Option<bool>,
        audio_to: Option<&str>,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        self.sync_position(audio)?;
        self.push_history_entry();
        self.redo_stack.clear();

        self.update_loaded_track(track_id, None, volume, pan, muted, solo, audio_to)?;
        // Category A: one targeted command per changed field. No broad sync. No LoadSession.
        audio.update_live_track_mix(track_id, volume, pan, muted, solo, audio_to)?;
        audio.record_commit_mix();

        self.perf_metrics.song_save_millis = 0;
        self.project_revision = self.project_revision.saturating_add(1);
        Ok(self.snapshot())
    }

    /// Generic update_track is kept ONLY for structural/admin callers that must change
    /// both name and mix in a single operation (e.g. undo/redo replay).
    /// Mix fields (volume/pan/muted/solo/audio_to) route through commit_track_mix_model_and_command
    /// internally. Name changes route through update_track_metadata.
    /// Prefer the explicit methods above for new call sites.
    pub fn update_track(
        &mut self,
        track_id: &str,
        name: Option<&str>,
        volume: Option<f64>,
        pan: Option<f64>,
        muted: Option<bool>,
        solo: Option<bool>,
        audio_to: Option<&str>,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        self.sync_position(audio)?;
        self.push_history_entry();
        self.redo_stack.clear();

        self.update_loaded_track(track_id, name, volume, pan, muted, solo, audio_to)?;
        if volume.is_some()
            || pan.is_some()
            || muted.is_some()
            || solo.is_some()
            || audio_to.is_some()
        {
            // Category A: one targeted command per changed field. No broad sync.
            audio.update_live_track_mix(track_id, volume, pan, muted, solo, audio_to)?;
            audio.record_commit_mix();
        } else if name.is_some() {
            audio.record_commit_model_only();
        }

        self.perf_metrics.song_save_millis = 0;
        self.project_revision = self.project_revision.saturating_add(1);
        Ok(self.snapshot())
    }

    pub fn delete_track(
        &mut self,
        track_id: &str,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        self.delete_tracks(&[track_id.to_string()], audio)
    }

    /// Delete every track in `track_ids` in a single transaction: repair the
    /// folder hierarchy for each, drop the clips of any deleted audio track, and
    /// persist ONE `StructureRebuild`. Deleting a multi-track selection used to
    /// loop `delete_track` per id from the frontend — N engine syncs + N
    /// snapshots + N history entries — which made the tracks vanish one by one
    /// and felt sluggish on big selections. Mirrors the batched `delete_clips`.
    pub fn delete_tracks(
        &mut self,
        track_ids: &[String],
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        if track_ids.is_empty() {
            return Ok(self.snapshot());
        }

        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;

        let mut any_audio_deleted = false;
        for track_id in track_ids {
            // A track may already be gone if it was a child of a folder deleted
            // earlier in this batch (the hierarchy repair reparents/removes
            // descendants). Treat a now-missing id as a no-op so the whole batch
            // doesn't fail because of selection overlap.
            match delete_track_and_repair_hierarchy(&mut song.tracks, track_id) {
                Ok(deleted_track) => {
                    if deleted_track.kind == TrackKind::Audio {
                        song.clips.retain(|clip| &clip.track_id != track_id);
                        any_audio_deleted = true;
                    }
                }
                Err(DesktopError::TrackNotFound(_)) => continue,
                Err(error) => return Err(error),
            }
        }

        if any_audio_deleted {
            refresh_song_duration(&mut song);
        }

        self.persist_song_update(song, audio, AudioChangeImpact::StructureRebuild, true)?;

        Ok(self.snapshot())
    }

    pub fn split_clip(
        &mut self,
        clip_id: &str,
        split_seconds: f64,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        self.split_clips(&[clip_id.to_string()], split_seconds, audio)
    }

    /// Splits every clip whose timeline span contains `split_seconds_view`
    /// in a single transaction. Used by the timeline context menu's
    /// "Split at cursor" action when the click target is part of a
    /// multi-selection — every selected clip the cursor crosses gets
    /// split, the ones it doesn't cross are left untouched. A single
    /// `persist_song_update` keeps the engine, the project revision,
    /// and the history entry coherent.
    pub fn split_clips(
        &mut self,
        clip_ids: &[String],
        split_seconds_view: f64,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        if clip_ids.is_empty() {
            return Err(DesktopError::ClipNotFound(String::new()));
        }

        // `timeline_start_seconds` and `duration_seconds` are stored in
        // view-time, so the split point comparison stays in view-time too.
        // We only convert to source-time when computing the right-hand
        // clip's `source_start_seconds`, which is the only field that
        // actually lives in the underlying audio file's clock.
        let split_seconds_source = source_seconds_at_view(&song, split_seconds_view);
        let suffix_base = timestamp_suffix();
        let mut any_split = false;
        let mut last_invalid_clip: Option<String> = None;

        for (offset, clip_id) in clip_ids.iter().enumerate() {
            let clip_index = match song.clips.iter().position(|clip| clip.id == *clip_id) {
                Some(index) => index,
                None => continue,
            };
            let clip = song.clips[clip_index].clone();
            let clip_end = clip.timeline_start_seconds + clip.duration_seconds;
            if split_seconds_view <= clip.timeline_start_seconds || split_seconds_view >= clip_end {
                last_invalid_clip = Some(clip_id.clone());
                continue;
            }

            let left_duration = split_seconds_view - clip.timeline_start_seconds;
            let right_duration = clip_end - split_seconds_view;
            // Source-time offset of the cut inside the original audio. With
            // warp off this collapses to `left_duration`; with warp on it
            // accounts for the stretch ratio in this region.
            let split_seconds_source_clip =
                source_seconds_at_view(&song, clip.timeline_start_seconds + left_duration);
            let source_left_duration = (split_seconds_source_clip
                - source_seconds_at_view(&song, clip.timeline_start_seconds))
            .max(0.0);

            let left_clip = Clip {
                id: format!("clip_{}_{}_l", suffix_base, offset),
                duration_seconds: left_duration,
                ..clip.clone()
            };
            let right_clip = Clip {
                id: format!("clip_{}_{}_r", suffix_base, offset),
                timeline_start_seconds: split_seconds_view,
                source_start_seconds: clip.source_start_seconds + source_left_duration,
                duration_seconds: right_duration,
                ..clip
            };

            song.clips
                .splice(clip_index..=clip_index, [left_clip, right_clip]);
            any_split = true;
        }

        if !any_split {
            // No clip contained the split point — surface a clear error
            // instead of an opaque engine roundtrip with no-op state.
            return Err(DesktopError::InvalidSplitPoint);
        }

        // Suppress an unused-variable warning on the diagnostic-only path
        // where every clip in the batch was outside the cursor.
        let _ = (split_seconds_source, last_invalid_clip);

        self.persist_song_update(song, audio, AudioChangeImpact::StructureRebuild, true)?;
        Ok(self.snapshot())
    }
}
