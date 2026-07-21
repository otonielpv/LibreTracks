//! Undo/redo history on `DesktopSession`. Snapshots of the `Song` are pushed
//! onto an undo stack on each structural edit; `undo_action`/`redo_action` swap
//! between the stacks and reload the engine. The live-drag anchor and the
//! transpose-history grouping keep a burst of realtime edits collapsed into a
//! single undo entry. The history helpers here are `pub(super)` because the
//! arrangement/regions edits call them at mutation time.

use std::time::{Duration, Instant};

use crate::audio::engine::AudioController;
use crate::infra::error::DesktopError;
use crate::models::TransportSnapshot;

use super::{
    AudioChangeImpact, DesktopSession, TransposeHistoryGroup, TransposeHistoryTarget,
    MAX_TRACK_GAIN,
};

impl DesktopSession {
    pub(super) fn capture_live_history_anchor(&mut self) {
        if self.live_history_anchor.is_none() {
            self.live_history_anchor = self.engine.song().cloned();
        }
    }

    pub(super) fn push_history_entry(&mut self) {
        let history_entry = self
            .live_history_anchor
            .take()
            .or_else(|| self.engine.song().cloned());

        if let Some(song) = history_entry {
            self.undo_stack.push(song);
            if self.undo_stack.len() > 50 {
                self.undo_stack.remove(0);
            }
        }
    }

    pub(super) fn should_record_transpose_history(
        &mut self,
        target: TransposeHistoryTarget,
    ) -> bool {
        let now = Instant::now();
        let should_group = self.transpose_history_group.as_ref().is_some_and(|group| {
            group.target == target
                && now.duration_since(group.recorded_at) <= Duration::from_millis(750)
        });

        self.transpose_history_group = Some(TransposeHistoryGroup {
            target,
            recorded_at: now,
        });

        !should_group
    }

    pub(super) fn update_loaded_track(
        &mut self,
        track_id: &str,
        name: Option<&str>,
        volume: Option<f64>,
        pan: Option<f64>,
        muted: Option<bool>,
        solo: Option<bool>,
        audio_to: Option<&str>,
    ) -> Result<(), DesktopError> {
        let track = self
            .engine
            .song_mut()?
            .tracks
            .iter_mut()
            .find(|track| track.id == track_id)
            .ok_or_else(|| DesktopError::TrackNotFound(track_id.to_string()))?;

        if let Some(name) = name {
            let trimmed_name = name.trim();
            if trimmed_name.is_empty() {
                return Err(DesktopError::AudioCommand(
                    "track name must not be empty".into(),
                ));
            }
            track.name = trimmed_name.to_string();
        }

        if let Some(volume) = volume {
            track.volume = volume.clamp(0.0, MAX_TRACK_GAIN);
        }

        if let Some(pan) = pan {
            track.pan = pan.clamp(-1.0, 1.0);
        }

        if let Some(muted) = muted {
            track.muted = muted;
        }

        if let Some(solo) = solo {
            track.solo = solo;
        }

        if let Some(audio_to) = audio_to {
            let trimmed = audio_to.trim();
            track.audio_to = if trimmed.is_empty() {
                "master".to_string()
            } else {
                trimmed.to_ascii_lowercase()
            };
        }

        self.transpose_history_group = None;

        Ok(())
    }

    pub fn undo_action(
        &mut self,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        self.live_history_anchor = None;
        self.transpose_history_group = None;
        let Some(previous_song) = self.undo_stack.pop() else {
            return Ok(self.snapshot());
        };

        let current_song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        self.redo_stack.push(current_song);

        self.persist_song_update_internal(
            previous_song,
            audio,
            AudioChangeImpact::StructureRebuild,
            false,
            true,
        )?;

        Ok(self.snapshot())
    }

    pub fn redo_action(
        &mut self,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        self.live_history_anchor = None;
        self.transpose_history_group = None;
        let Some(next_song) = self.redo_stack.pop() else {
            return Ok(self.snapshot());
        };

        let current_song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        self.undo_stack.push(current_song);
        if self.undo_stack.len() > 50 {
            self.undo_stack.remove(0);
        }

        self.persist_song_update_internal(
            next_song,
            audio,
            AudioChangeImpact::StructureRebuild,
            false,
            true,
        )?;

        Ok(self.snapshot())
    }
}
