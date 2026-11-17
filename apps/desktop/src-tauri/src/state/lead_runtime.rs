//! Glue between the session's transport state and
//! `libretracks_core::lead_plan` (plan lead-time): what jump is pending, in
//! the planner's terms, and the song's items with their leads.
//!
//! The decisions live in core, where they are tested; this only reads state.

use libretracks_audio::{JumpTrigger, PlaybackState, TransitionType};
use libretracks_core::lead_plan::{Discontinuity, LeadItem};
use libretracks_core::lead_time::{has_lead, LeadGrid};
use libretracks_core::Song;

use crate::audio::automation::{AutomationAction, AutomationCue};
use crate::audio::engine::AudioController;
use crate::infra::error::DesktopError;

use super::{automation_target_source_seconds, DesktopSession};

/// Same guard as the MIDI walk: a tick longer than this is a discontinuity,
/// not playback, and fires nothing (landings re-anchor explicitly).
const MAX_CONTINUOUS_LEAD_TICK_SECONDS: f64 = 1.0;

/// How far behind a landing the automation lead cursor is put, so a cue
/// whose actions start exactly on the landing still fires.
const LEAD_LANDING_EPSILON_SECONDS: f64 = 0.001;

/// The cues the lead walk owns: enabled, with a lead. (Their jump, if any,
/// stays in the armed-cue slot.)
fn lead_cues(cues: &[AutomationCue]) -> impl Iterator<Item = &AutomationCue> + Clone {
    cues.iter()
        .filter(|cue| cue.enabled && has_lead(cue.lead.as_ref()))
}

fn cue_lead_item(cue: &AutomationCue) -> LeadItem<'_> {
    LeadItem {
        id: &cue.id,
        anchor: cue.at_seconds,
        lead: cue.lead.as_ref(),
    }
}

/// Start of the marker or region a pending user jump targets (the pending
/// jump stores one id for either).
fn marker_or_region_start(song: &Song, id: &str) -> Option<f64> {
    song.section_markers
        .iter()
        .find(|marker| marker.id == id)
        .map(|marker| marker.start_seconds)
        .or_else(|| {
            song.regions
                .iter()
                .find(|region| region.id == id)
                .map(|region| region.start_seconds)
        })
}

/// The song's MIDI clips as lead items.
pub(super) fn midi_lead_items(song: &Song) -> impl Iterator<Item = LeadItem<'_>> + Clone {
    song.midi_clips.iter().map(|clip| LeadItem {
        id: &clip.id,
        anchor: clip.timeline_start_seconds,
        lead: clip.lead.as_ref(),
    })
}

/// Whether any MIDI clip has a lead; when none does the runtime keeps the
/// plain walk and the planner stays idle.
pub(super) fn song_has_midi_leads(song: &Song) -> bool {
    song.midi_clips
        .iter()
        .any(|clip| has_lead(clip.lead.as_ref()))
}

impl DesktopSession {
    /// The next jump of the playhead, in source seconds: a live jump the user
    /// armed, a cue's jump, or the wrap of an active vamp. When several are
    /// pending, the one that executes first.
    pub(super) fn pending_lead_discontinuity(&self, song: &Song) -> Option<Discontinuity> {
        let mut candidates: Vec<Discontinuity> = Vec::with_capacity(3);
        if let Some(pending) = self.engine.pending_marker_jump() {
            if let Some(landing) = marker_or_region_start(song, &pending.target_marker_id) {
                let mut execute_at = pending.execute_at_seconds;
                // "Immediate + fade" lands when the fade finishes (see
                // `native_region_jump_trigger_view_seconds`).
                if let (JumpTrigger::Immediate, TransitionType::FadeOut { duration_seconds }) =
                    (&pending.trigger, &pending.transition)
                {
                    execute_at += duration_seconds.max(0.0);
                }
                candidates.push(Discontinuity::new(execute_at, landing));
            }
        }
        if let Some(pending) = &self.pending_automation_jump {
            if let Ok(landing) = automation_target_source_seconds(song, &pending.target) {
                candidates.push(Discontinuity {
                    execute_at: pending.execute_at_seconds,
                    landing,
                    owner: Some(pending.cue_id.clone()),
                });
            }
        }
        if let Some(vamp) = self.engine.active_vamp() {
            if vamp.end_seconds > vamp.start_seconds {
                candidates.push(Discontinuity::new(vamp.end_seconds, vamp.start_seconds));
            }
        }
        candidates
            .into_iter()
            .filter(|jump| jump.execute_at.is_finite() && jump.landing.is_finite())
            .min_by(|left, right| left.execute_at.total_cmp(&right.execute_at))
    }
}

impl DesktopSession {
    /// Re-anchor the automation lead walk where the playhead landed (jump,
    /// vamp wrap, seek, Play): a cue pre-fired before the jump is not fired
    /// again, one whose lead window contains the landing fires now.
    pub(super) fn land_automation_leads(&mut self, landing_seconds: f64) {
        let fired_until = self.automation_lead_cursor;
        let landing = landing_seconds.max(0.0);
        self.automation_lead_cursor = landing - LEAD_LANDING_EPSILON_SECONDS;
        let Some(song) = self.engine.song() else {
            self.automation_lead_planner.reset();
            return;
        };
        if lead_cues(&self.automation.cues).next().is_none() {
            self.automation_lead_planner.reset();
            return;
        }
        let grid = LeadGrid::new(song);
        self.automation_lead_planner.on_landing(
            &grid,
            lead_cues(&self.automation.cues).map(cue_lead_item),
            landing,
            self.automation_lead_cursor,
            fired_until,
        );
    }

    /// Fire the actions of cues with a lead that fall in `(cursor, now]`, each
    /// cue starting where the lead planner says given the pending jump. A cue's
    /// actions keep their offsets (waits) from that start; its jump, if it has
    /// one, is not here: it stays on the bar, armed by the slot.
    pub(super) fn advance_automation_lead_cues(
        &mut self,
        audio: &AudioController,
    ) -> Result<(), DesktopError> {
        if self.engine.playback_state() != PlaybackState::Playing {
            return Ok(());
        }
        let now = self.engine.position_seconds();
        let previous = self.automation_lead_cursor;
        if now < previous {
            // A clock correction a few ms back: wait for it to catch up.
            return Ok(());
        }
        if now - previous > MAX_CONTINUOUS_LEAD_TICK_SECONDS {
            self.automation_lead_cursor = now;
            return Ok(());
        }
        self.automation_lead_cursor = now;
        if !self.automation.track_enabled || lead_cues(&self.automation.cues).next().is_none() {
            if !self.automation_lead_planner.is_idle() {
                self.automation_lead_planner.reset();
            }
            return Ok(());
        }
        let Some(song) = self.engine.song().cloned() else {
            return Ok(());
        };

        let grid = LeadGrid::new(&song);
        let pending = self.pending_lead_discontinuity(&song);
        self.automation_lead_planner.sync_pending(
            &grid,
            lead_cues(&self.automation.cues).map(cue_lead_item),
            pending,
            previous,
        );

        let mut due: Vec<(f64, AutomationAction)> = Vec::new();
        let mut started: Vec<String> = Vec::new();
        for cue in lead_cues(&self.automation.cues) {
            for start in self
                .automation_lead_planner
                .starts(&grid, cue_lead_item(cue))
            {
                let starts_now = start > previous && start <= now;
                // The run limit gates a cue STARTING; actions of a run already
                // under way (waits after the start) still go out.
                if starts_now && !self.cue_has_runs_left(cue) {
                    continue;
                }
                if start > now {
                    continue;
                }
                if starts_now && cue.jump_action().is_none() {
                    // A cue with a jump counts its run when the jump fires.
                    started.push(cue.id.clone());
                }
                for (offset, action) in cue.timed_pre_jump_actions() {
                    let at = start + offset;
                    if at > previous && at <= now {
                        due.push((at, action));
                    }
                }
            }
        }
        due.sort_by(|left, right| left.0.total_cmp(&right.0));
        for cue_id in started {
            self.record_automation_cue_run(&cue_id);
        }
        for (_, action) in due {
            self.apply_automation_action(&action, audio)?;
        }
        Ok(())
    }
}
