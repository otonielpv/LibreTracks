//! Automation runtime for `DesktopSession`: cue upsert/delete, mix scenes,
//! automation-track management, and the playback-time scheduling of jumps,
//! timed actions and mix ramps.
//!
//! Split out of `state/mod.rs` as a sibling `impl DesktopSession` block; the
//! session fields it touches (`automation`, `pending_automation_jump`,
//! `active_automation_job`, `active_mix_ramps`, `automation_run_counts`, …) are
//! `pub(super)` so this module can reach them without changing any behavior.

use libretracks_audio::{
    ActiveVamp, JumpTrigger, PendingMarkerJump, PlaybackState, TransitionType,
};
use libretracks_core::{source_seconds_at_view, warp_timeline_seconds_at, Song};
use lt_audio_engine_v2::{JumpTarget as NativeJumpTarget, JumpTargetKind as NativeJumpTargetKind};

use crate::audio::engine::{jump_debug_logging_enabled, AudioController};
use crate::audio::automation::{
    save_automation, AutomationAction, AutomationCue, AutomationJumpTarget,
    AutomationTransitionMode, MixScene,
};
use crate::infra::error::DesktopError;
use crate::models::TransportSnapshot;

use super::{
    automation_target_source_seconds, validate_automation_cue, ActiveAutomationJob, ActiveMixRamp,
    DesktopSession, PendingAutomationJump,
};

impl DesktopSession {
    pub fn upsert_automation_cue(
        &mut self,
        mut cue: AutomationCue,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        cue.at_seconds = source_seconds_at_view(&song, cue.at_seconds);
        // Normalize any frame-target jump's seconds from view → source space.
        for action in &mut cue.actions {
            if let AutomationAction::Jump {
                target: AutomationJumpTarget::Frame { seconds },
                ..
            } = action
            {
                *seconds = source_seconds_at_view(&song, *seconds);
            }
        }
        validate_automation_cue(&song, &self.automation, &cue)?;
        cue.name = cue.name.trim().to_string();
        if cue.name.is_empty() {
            cue.name = "Automation cue".into();
        }

        if let Some(existing) = self
            .automation
            .cues
            .iter_mut()
            .find(|existing| existing.id == cue.id)
        {
            *existing = cue;
        } else {
            self.automation.cues.push(cue);
        }
        // Creating a cue implies the automation track is present: a cue with no
        // visible lane would be a ghost jump. Keep the two invariants together.
        self.automation.track_present = true;
        self.automation.cues.sort_by(|left, right| {
            left.at_seconds
                .partial_cmp(&right.at_seconds)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        self.persist_automation(audio)?;
        Ok(self.snapshot())
    }

    pub fn add_automation_track(
        &mut self,
        after_track_id: Option<String>,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let after_track_id = after_track_id.filter(|id| !id.trim().is_empty());
        if !self.automation.track_present || self.automation.track_after_id != after_track_id {
            self.automation.track_present = true;
            self.automation.track_after_id = after_track_id;
            self.persist_automation(audio)?;
        }
        Ok(self.snapshot())
    }

    pub fn remove_automation_track(
        &mut self,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        // Removing the track clears every cue: without a visible lane the cues
        // would keep firing as ghost jumps. The runtime scheduler iterates over
        // `cues`, so an empty list means nothing is armed.
        self.automation.track_present = false;
        self.automation.track_after_id = None;
        self.automation.cues.clear();
        self.persist_automation(audio)?;
        Ok(self.snapshot())
    }

    pub fn set_automation_track_position(
        &mut self,
        after_track_id: Option<String>,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        self.automation.track_after_id = after_track_id.filter(|id| !id.trim().is_empty());
        self.persist_automation(audio)?;
        Ok(self.snapshot())
    }

    pub fn delete_automation_cue(
        &mut self,
        cue_id: &str,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let before = self.automation.cues.len();
        self.automation.cues.retain(|cue| cue.id != cue_id);
        if self.automation.cues.len() != before {
            if self
                .pending_automation_jump
                .as_ref()
                .is_some_and(|pending| pending.cue_id == cue_id)
            {
                self.pending_automation_jump = None;
                self.active_automation_job = None;
                audio.cancel_scheduled_jumps()?;
            }
            self.persist_automation(audio)?;
        }
        Ok(self.snapshot())
    }

    pub fn upsert_mix_scene(
        &mut self,
        mut scene: MixScene,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        scene.name = scene.name.trim().to_string();
        if scene.id.trim().is_empty() {
            return Err(DesktopError::AudioCommand(
                "mix scene id is required".into(),
            ));
        }
        if scene.name.is_empty() {
            scene.name = "Mix scene".into();
        }

        if let Some(existing) = self
            .automation
            .mix_scenes
            .iter_mut()
            .find(|existing| existing.id == scene.id)
        {
            *existing = scene;
        } else {
            self.automation.mix_scenes.push(scene);
        }
        self.persist_automation(audio)?;
        Ok(self.snapshot())
    }

    pub fn delete_mix_scene(
        &mut self,
        scene_id: &str,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let before = self.automation.mix_scenes.len();
        self.automation
            .mix_scenes
            .retain(|scene| scene.id != scene_id);
        if self.automation.mix_scenes.len() != before {
            for cue in &mut self.automation.cues {
                // Clear the deleted scene from jump actions, and drop any
                // ApplyScene actions that referenced it (a dangling scene id
                // would be a no-op at runtime, but we keep the model clean).
                for action in &mut cue.actions {
                    if let AutomationAction::Jump { mix_scene_id, .. } = action {
                        if mix_scene_id.as_deref() == Some(scene_id) {
                            *mix_scene_id = None;
                        }
                    }
                }
                cue.actions.retain(|action| {
                    !matches!(
                        action,
                        AutomationAction::ApplyScene { scene_id: id, .. } if id == scene_id
                    )
                });
            }
            self.persist_automation(audio)?;
        }
        Ok(self.snapshot())
    }

    fn persist_automation(&mut self, audio: &AudioController) -> Result<(), DesktopError> {
        let song_dir = self.song_dir.clone().ok_or(DesktopError::NoSongLoaded)?;
        save_automation(&song_dir, &self.automation)
            .map_err(|error| DesktopError::AudioCommand(error.to_string()))?;
        self.project_revision = self.project_revision.saturating_add(1);
        self.pending_automation_jump = None;
        self.active_automation_job = None;
        audio.cancel_scheduled_jumps()?;
        self.schedule_next_automation_jump(audio)?;
        Ok(())
    }

    pub(super) fn schedule_native_vamp_jump(
        &self,
        audio: &AudioController,
        source_song: &Song,
        active_vamp: &ActiveVamp,
    ) -> Result<(), DesktopError> {
        let trigger_seconds = warp_timeline_seconds_at(source_song, active_vamp.end_seconds);
        let target_seconds = Some(warp_timeline_seconds_at(
            source_song,
            active_vamp.start_seconds,
        ));
        if jump_debug_logging_enabled() {
            eprintln!(
                "[LT_JUMP_DEBUG][state] native_vamp_schedule source_start={:.9} source_end={:.9} view_trigger={:.9} view_target={:.9}",
                active_vamp.start_seconds,
                active_vamp.end_seconds,
                trigger_seconds,
                target_seconds.unwrap_or(trigger_seconds)
            );
        }
        audio.schedule_jump_at_frame(
            "__lt_vamp_loop__",
            NativeJumpTarget {
                kind: NativeJumpTargetKind::Frame,
                id: None,
                frame: None,
            },
            trigger_seconds,
            target_seconds,
            true,
        )
    }

    /// Whether the cue can still fire this session (under its `max_runs` limit).
    fn cue_has_runs_left(&self, cue: &AutomationCue) -> bool {
        match cue.max_runs {
            None => true,
            Some(max) => {
                self.automation_run_counts
                    .get(&cue.id)
                    .copied()
                    .unwrap_or(0)
                    < max
            }
        }
    }

    /// Record one firing of the cue for this session.
    pub(super) fn record_automation_cue_run(&mut self, cue_id: &str) {
        *self
            .automation_run_counts
            .entry(cue_id.to_string())
            .or_insert(0) += 1;
    }

    /// Drop run counts for cues at or after `position_seconds` so seeking before
    /// a cue makes it eligible to fire its full quota again. `None` clears all
    /// (used on stop).
    pub(super) fn reset_automation_run_counts(&mut self, before_position_seconds: Option<f64>) {
        match before_position_seconds {
            None => self.automation_run_counts.clear(),
            Some(position) => {
                let cues = &self.automation.cues;
                self.automation_run_counts.retain(|cue_id, _| {
                    cues.iter()
                        .find(|cue| &cue.id == cue_id)
                        // Keep the count only for cues still behind the playhead;
                        // cues at/after the new position get re-armed.
                        .map(|cue| cue.at_seconds < position - 0.001)
                        .unwrap_or(false)
                });
            }
        }
    }

    /// Arm the next automation cue (job). The terminal jump — if the job has one
    /// — is scheduled sample-exact in the native engine at its effective time
    /// (`at_seconds + Σ pre-jump waits`); the job's pre-jump mix actions fire as
    /// the playhead crosses each one's effective time. Jobs without a jump are
    /// tracked as an `active_automation_job` and fire purely from the timeline.
    pub(super) fn schedule_next_automation_jump(
        &mut self,
        audio: &AudioController,
    ) -> Result<(), DesktopError> {
        if self.engine.playback_state() != PlaybackState::Playing {
            return Ok(());
        }
        if self.engine.pending_marker_jump().is_some() || self.engine.active_vamp().is_some() {
            return Ok(());
        }

        let source_song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        let position_seconds = self.engine.position_seconds();

        // The next cue to arm is the earliest enabled cue still ahead of the
        // playhead. A cue's pre-jump actions may start firing once the playhead
        // is at/after at_seconds, so only arm cues strictly in the future here;
        // jobs already started are owned by pending_automation_jump / the active
        // job and re-armed on completion.
        let Some(cue) = self
            .automation
            .cues
            .iter()
            .filter(|cue| {
                cue.enabled
                    && cue.at_seconds > position_seconds + 0.001
                    // Skip cues that already hit their per-session run limit, so
                    // a "jump back" loop fires only the configured number of
                    // times and then the playhead passes through.
                    && self.cue_has_runs_left(cue)
            })
            .min_by(|left, right| {
                left.at_seconds
                    .partial_cmp(&right.at_seconds)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .cloned()
        else {
            self.pending_automation_jump = None;
            self.active_automation_job = None;
            return Ok(());
        };

        let timed_actions = cue.timed_pre_jump_actions();

        let Some(AutomationAction::Jump {
            target,
            transition,
            mix_scene_id,
        }) = cue.jump_action().cloned()
        else {
            // Pure mix/scene/wait job: nothing to schedule natively. Track it so
            // the per-tick advance fires its actions on time.
            self.pending_automation_jump = None;
            self.active_automation_job = Some(ActiveAutomationJob {
                cue_id: cue.id.clone(),
                timed_actions: timed_actions
                    .into_iter()
                    .map(|(offset, action)| (cue.at_seconds + offset, action))
                    .collect(),
                fired_count: 0,
            });
            return Ok(());
        };

        // Job with a terminal jump. Effective jump time accounts for waits.
        self.active_automation_job = None;
        let execute_at_seconds = cue.at_seconds + cue.pre_jump_wait_seconds();
        let target_seconds = automation_target_source_seconds(&source_song, &target)?;
        let trigger_seconds = warp_timeline_seconds_at(&source_song, execute_at_seconds);
        let target_view_seconds = Some(warp_timeline_seconds_at(&source_song, target_seconds));
        let native_target = match &target {
            AutomationJumpTarget::Marker { marker_id } => NativeJumpTarget {
                kind: NativeJumpTargetKind::Marker,
                id: Some(marker_id.clone()),
                frame: None,
            },
            AutomationJumpTarget::Region { region_id } => NativeJumpTarget {
                kind: NativeJumpTargetKind::Region,
                id: Some(region_id.clone()),
                frame: None,
            },
            AutomationJumpTarget::Frame { .. } => NativeJumpTarget {
                kind: NativeJumpTargetKind::Frame,
                id: None,
                frame: None,
            },
        };

        self.last_native_scheduled_jump_executed_count = audio
            .engine_snapshot()
            .map(|snapshot| snapshot.pitch.mixer_scheduled_jump_executed_count)
            .unwrap_or(self.last_native_scheduled_jump_executed_count);
        audio.schedule_jump_at_frame(
            &cue.id,
            native_target,
            trigger_seconds,
            target_view_seconds,
            transition.mode == AutomationTransitionMode::FadeOut,
        )?;
        self.pending_automation_jump = Some(PendingAutomationJump {
            cue_id: cue.id,
            cue_name: cue.name,
            execute_at_seconds,
            target,
            mix_scene_id,
            fade_out_seconds: (transition.mode == AutomationTransitionMode::FadeOut)
                .then_some(transition.duration_seconds.unwrap_or(0.35).max(0.0)),
            fade_started: false,
            timed_actions: timed_actions
                .into_iter()
                .map(|(offset, action)| (cue.at_seconds + offset, action))
                .collect(),
            fired_count: 0,
        });

        Ok(())
    }

    /// Apply a single non-jump job action immediately (mute/solo/mix/scene).
    fn apply_automation_action(
        &mut self,
        action: &AutomationAction,
        audio: &AudioController,
    ) -> Result<(), DesktopError> {
        match action {
            AutomationAction::SetTrackMute { track_id, muted } => {
                audio.update_live_track_mix(track_id, None, None, Some(*muted), None, None)?;
            }
            AutomationAction::SetTrackSolo { track_id, solo } => {
                audio.update_live_track_mix(track_id, None, None, None, Some(*solo), None)?;
            }
            AutomationAction::SetTrackMix {
                track_id,
                volume,
                pan,
                ramp_seconds,
            } => {
                let ramp = ramp_seconds.unwrap_or(0.0);
                if ramp > 0.0 {
                    // Register a stepped ramp from the track's current value to
                    // the target; advance_mix_ramps interpolates per tick.
                    let (cur_vol, cur_pan) = self
                        .engine
                        .song()
                        .and_then(|song| song.tracks.iter().find(|t| &t.id == track_id))
                        .map(|t| (t.volume, t.pan))
                        .unwrap_or((1.0, 0.0));
                    self.active_mix_ramps.retain(|r| &r.track_id != track_id);
                    self.active_mix_ramps.push(ActiveMixRamp {
                        track_id: track_id.clone(),
                        start_position_seconds: self.engine.position_seconds(),
                        duration_seconds: ramp,
                        volume: volume.map(|to| (cur_vol, to)),
                        pan: pan.map(|to| (cur_pan, to)),
                    });
                } else {
                    audio.update_live_track_mix(track_id, *volume, *pan, None, None, None)?;
                }
            }
            AutomationAction::ApplyScene {
                scene_id,
                ramp_seconds,
            } => {
                self.apply_mix_scene_runtime(scene_id, ramp_seconds.unwrap_or(0.0), audio)?;
            }
            AutomationAction::SetPad {
                enabled,
                pad_id,
                pad_key,
                volume,
                output,
                fade_in_seconds,
                fade_out_seconds,
            } => {
                audio.set_pad_automation_realtime(
                    *enabled,
                    pad_id,
                    *pad_key,
                    *volume,
                    output,
                    fade_in_seconds.unwrap_or(0.0),
                    fade_out_seconds.unwrap_or(0.0),
                )?;
            }
            // Jump and Wait are handled by the scheduler/executor, not here.
            AutomationAction::Jump { .. } | AutomationAction::Wait { .. } => {}
        }
        Ok(())
    }

    /// Step any in-progress volume/pan ramps toward their target, measured by
    /// transport position so the ramp respects pause/seek. Completed ramps land
    /// exactly on the target and are removed.
    pub(super) fn advance_mix_ramps(
        &mut self,
        audio: &AudioController,
    ) -> Result<(), DesktopError> {
        if self.active_mix_ramps.is_empty() {
            return Ok(());
        }
        if self.engine.playback_state() != PlaybackState::Playing {
            return Ok(());
        }
        let position = self.engine.position_seconds();

        // Compute each ramp's current value, then apply and prune (split borrow).
        let mut updates: Vec<(String, Option<f64>, Option<f64>)> = Vec::new();
        for ramp in &self.active_mix_ramps {
            let elapsed = position - ramp.start_position_seconds;
            // Seeking backwards before the ramp started would give a negative t;
            // clamp to [0,1]. A backward seek also cancels jobs elsewhere, so in
            // practice t stays forward.
            let t = if ramp.duration_seconds > 0.0 {
                (elapsed / ramp.duration_seconds).clamp(0.0, 1.0)
            } else {
                1.0
            };
            let lerp = |(from, to): (f64, f64)| from + (to - from) * t;
            updates.push((
                ramp.track_id.clone(),
                ramp.volume.map(lerp),
                ramp.pan.map(lerp),
            ));
        }
        for (track_id, volume, pan) in updates {
            audio.update_live_track_mix(&track_id, volume, pan, None, None, None)?;
        }
        // Drop ramps that have reached their end.
        self.active_mix_ramps
            .retain(|ramp| position - ramp.start_position_seconds < ramp.duration_seconds);
        Ok(())
    }

    /// Fire any job pre-jump actions whose effective time the playhead has now
    /// reached. Drives both jump-jobs (via `pending_automation_jump`) and pure
    /// jobs (via `active_automation_job`). Pure jobs end when fully fired.
    pub(super) fn advance_automation_job_actions(
        &mut self,
        audio: &AudioController,
    ) -> Result<(), DesktopError> {
        if self.engine.playback_state() != PlaybackState::Playing {
            return Ok(());
        }
        let position_seconds = self.engine.position_seconds();

        // Collect the actions that became due, then apply them (split borrow).
        let mut due: Vec<AutomationAction> = Vec::new();
        if let Some(pending) = self.pending_automation_jump.as_mut() {
            while pending.fired_count < pending.timed_actions.len()
                && pending.timed_actions[pending.fired_count].0 <= position_seconds + 0.001
            {
                due.push(pending.timed_actions[pending.fired_count].1.clone());
                pending.fired_count += 1;
            }
        }
        let mut pure_job_done = false;
        let mut pure_job_cue_id: Option<String> = None;
        if let Some(job) = self.active_automation_job.as_mut() {
            while job.fired_count < job.timed_actions.len()
                && job.timed_actions[job.fired_count].0 <= position_seconds + 0.001
            {
                due.push(job.timed_actions[job.fired_count].1.clone());
                job.fired_count += 1;
            }
            pure_job_done = job.fired_count >= job.timed_actions.len();
            if pure_job_done {
                pure_job_cue_id = Some(job.cue_id.clone());
            }
        }

        for action in due {
            self.apply_automation_action(&action, audio)?;
        }

        // A pure (jumpless) job ends once all its actions have fired; count the
        // run and arm the next cue so consecutive jobs chain.
        if pure_job_done {
            self.active_automation_job = None;
            if let Some(cue_id) = pure_job_cue_id {
                self.record_automation_cue_run(&cue_id);
            }
            self.schedule_next_automation_jump(audio)?;
        }

        Ok(())
    }

    pub(super) fn apply_mix_scene_runtime(
        &mut self,
        scene_id: &str,
        ramp_seconds: f64,
        audio: &AudioController,
    ) -> Result<(), DesktopError> {
        let Some(scene) = self
            .automation
            .mix_scenes
            .iter()
            .find(|scene| scene.id == scene_id)
            .cloned()
        else {
            return Ok(());
        };

        let position_seconds = self.engine.position_seconds();
        let ramped = ramp_seconds > 0.0;
        let mut new_ramps: Vec<ActiveMixRamp> = Vec::new();

        let song = self.engine.song_mut()?;
        for override_ in scene.track_overrides {
            if let Some(track) = song
                .tracks
                .iter_mut()
                .find(|track| track.id == override_.track_id)
            {
                let volume = override_.volume.map(|volume| volume.clamp(0.0, 1.0));
                let pan = override_.pan.map(|pan| pan.clamp(-1.0, 1.0));
                // Capture the current values BEFORE overwriting, to ramp from.
                let from_volume = track.volume;
                let from_pan = track.pan;
                if let Some(volume) = volume {
                    track.volume = volume;
                }
                if let Some(pan) = pan {
                    track.pan = pan;
                }
                if let Some(muted) = override_.muted {
                    track.muted = muted;
                }
                if let Some(solo) = override_.solo {
                    track.solo = solo;
                }

                if ramped && (volume.is_some() || pan.is_some()) {
                    // Mute/solo are discrete → apply now; volume/pan ramp.
                    audio.update_live_track_mix(
                        &track.id,
                        None,
                        None,
                        override_.muted,
                        override_.solo,
                        None,
                    )?;
                    new_ramps.push(ActiveMixRamp {
                        track_id: track.id.clone(),
                        start_position_seconds: position_seconds,
                        duration_seconds: ramp_seconds,
                        volume: volume.map(|to| (from_volume, to)),
                        pan: pan.map(|to| (from_pan, to)),
                    });
                } else {
                    audio.update_live_track_mix(
                        &track.id,
                        volume,
                        pan,
                        override_.muted,
                        override_.solo,
                        None,
                    )?;
                }
            }
        }

        // Replace any existing ramps for these tracks with the new ones.
        for ramp in &new_ramps {
            self.active_mix_ramps
                .retain(|existing| existing.track_id != ramp.track_id);
        }
        self.active_mix_ramps.extend(new_ramps);

        Ok(())
    }

    pub(super) fn start_pending_automation_fade_if_due(
        &mut self,
        audio: &AudioController,
    ) -> Result<(), DesktopError> {
        let position_seconds = self.engine.position_seconds();
        let Some(pending) = self.pending_automation_jump.as_mut() else {
            return Ok(());
        };
        let Some(duration_seconds) = pending.fade_out_seconds else {
            return Ok(());
        };
        if pending.fade_started {
            return Ok(());
        }
        if position_seconds + 0.001 >= (pending.execute_at_seconds - duration_seconds).max(0.0) {
            audio.start_master_fade(0.0, duration_seconds)?;
            pending.fade_started = true;
        }
        Ok(())
    }

    pub(super) fn schedule_native_marker_jump(
        &self,
        audio: &AudioController,
        source_song: &Song,
        pending_jump: &PendingMarkerJump,
    ) -> Result<(), DesktopError> {
        let target_seconds = source_song
            .marker_by_id(&pending_jump.target_marker_id)
            .map(|marker| warp_timeline_seconds_at(source_song, marker.start_seconds));
        let trigger_seconds =
            warp_timeline_seconds_at(source_song, pending_jump.execute_at_seconds);
        if jump_debug_logging_enabled() {
            eprintln!(
                "[LT_JUMP_DEBUG][state] native_marker_schedule target={} source_execute={:.9} view_execute={:.9} view_target={:?}",
                pending_jump.target_marker_id,
                pending_jump.execute_at_seconds,
                trigger_seconds,
                target_seconds
            );
        }
        audio.schedule_jump_at_frame(
            &pending_jump.target_marker_id,
            NativeJumpTarget {
                kind: NativeJumpTargetKind::Marker,
                id: Some(pending_jump.target_marker_id.clone()),
                frame: None,
            },
            trigger_seconds,
            target_seconds,
            true,
        )
    }

    pub(super) fn schedule_native_region_jump(
        &self,
        audio: &AudioController,
        source_song: &Song,
        pending_jump: &PendingMarkerJump,
    ) -> Result<(), DesktopError> {
        if pending_jump.trigger == JumpTrigger::RegionEnd {
            return audio.schedule_region_end_jump(
                &pending_jump.target_marker_id,
                &pending_jump.target_marker_id,
                matches!(pending_jump.transition, TransitionType::FadeOut { .. }),
            );
        }

        let target_seconds = source_song
            .regions
            .iter()
            .find(|region| region.id == pending_jump.target_marker_id)
            .map(|region| warp_timeline_seconds_at(source_song, region.start_seconds));
        let trigger_seconds =
            warp_timeline_seconds_at(source_song, pending_jump.execute_at_seconds);
        if jump_debug_logging_enabled() {
            eprintln!(
                "[LT_JUMP_DEBUG][state] native_region_schedule target={} source_execute={:.9} view_execute={:.9} view_target={:?}",
                pending_jump.target_marker_id,
                pending_jump.execute_at_seconds,
                trigger_seconds,
                target_seconds
            );
        }
        audio.schedule_jump_at_frame(
            &pending_jump.target_marker_id,
            NativeJumpTarget {
                kind: NativeJumpTargetKind::Region,
                id: Some(pending_jump.target_marker_id.clone()),
                frame: None,
            },
            trigger_seconds,
            target_seconds,
            matches!(pending_jump.transition, TransitionType::FadeOut { .. }),
        )
    }

    pub(super) fn reschedule_pending_jump_after_song_update(
        &mut self,
        audio: &AudioController,
        source_song: &Song,
        pending_jump: PendingMarkerJump,
    ) -> Result<(), DesktopError> {
        if source_song
            .marker_by_id(&pending_jump.target_marker_id)
            .is_some()
        {
            let scheduled = self.engine.schedule_marker_jump_with_song(
                source_song,
                &pending_jump.target_marker_id,
                pending_jump.trigger,
                pending_jump.transition,
            )?;
            if let Some(next_pending) = scheduled.as_ref() {
                self.schedule_native_marker_jump(audio, source_song, next_pending)?;
            } else {
                audio.cancel_scheduled_jumps()?;
            }
            return Ok(());
        }

        if source_song
            .regions
            .iter()
            .any(|region| region.id == pending_jump.target_marker_id)
        {
            let scheduled = self.engine.schedule_region_jump_with_song(
                source_song,
                &pending_jump.target_marker_id,
                pending_jump.trigger,
                pending_jump.transition,
            )?;
            if let Some(next_pending) = scheduled.as_ref() {
                self.schedule_native_region_jump(audio, source_song, next_pending)?;
            } else {
                audio.cancel_scheduled_jumps()?;
            }
            return Ok(());
        }

        audio.cancel_scheduled_jumps()
    }
}
