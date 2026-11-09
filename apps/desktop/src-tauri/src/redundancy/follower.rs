//! The backup's follower (redundancy step 06): connects to the main as its
//! backup, checks the session fingerprint, and every 20 ms applies the one
//! action the reconciler picks to its own `DesktopSession`, so its engine
//! sounds in step with the main's.
//!
//! - [`FollowerCore`] is pure: it turns link messages into the reconciler's
//!   `MainView` on the local time base, gates on the fingerprint, and
//!   records what was applied.
//! - [`FollowTarget`] applies an action: [`SessionTarget`] on the real
//!   session (taking its lock only to apply, origin `Follower`), a double in
//!   tests.
//! - [`run`] is the thin async loop: connection, 20 ms ticks, 250 ms status.
//!
//! The backup NEVER stops for lack of network: a silent main gives
//! `Freewheel` and nothing is applied (rule 2 of the plan).

use std::collections::HashMap;
use std::time::Duration;

use libretracks_core::audio_clock::AudioClockSample;
use libretracks_core::redundancy::lifecycle::{
    BackupLifecycle, BackupObservation, BackupState, LifecyclePolicy, SessionCheck, Transition,
};
use libretracks_core::redundancy::reconciler::{
    reconcile, Action, Decision, LocalView, MainIntent, MainView, PendingJump as CoreJump, Policy,
};
use libretracks_core::session_fingerprint::{compare, FingerprintDiff, SessionFingerprint};
use libretracks_core::warp::{source_seconds_at_view, warp_timeline_seconds_at};
use libretracks_core::Song;
use libretracks_link::redundancy::{
    BackupPhase, HealthSummary, HeartbeatMonitor, MixControl, PendingJump as LinkJump,
    RedundancyMessage, SeqGate, TransportIntent, DEFAULT_HEARTBEAT_TIMEOUT_MS,
};
use serde::Serialize;

/// Reconcile this often.
pub const TICK: Duration = Duration::from_millis(20);
/// Status to the main this often.
pub const STATUS_INTERVAL: Duration = Duration::from_millis(250);

/// Where the follower stands, for the UI (step 10) and `BackupStatus`: the
/// backup lifecycle (step 07) without its timestamps.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FollowerPhase {
    Disabled,
    Pairing,
    CheckingSession,
    /// Blocking differences: nothing is applied.
    SessionMismatch,
    Following,
    Armed,
    /// The main went quiet or lost its audio: the backup carries on alone,
    /// local inputs unlocked.
    MainLost,
    Standalone,
    Diverged,
}

impl From<BackupState> for FollowerPhase {
    fn from(state: BackupState) -> Self {
        match state {
            BackupState::Disabled => FollowerPhase::Disabled,
            BackupState::Pairing => FollowerPhase::Pairing,
            BackupState::CheckingSession => FollowerPhase::CheckingSession,
            BackupState::SessionMismatch => FollowerPhase::SessionMismatch,
            BackupState::Following => FollowerPhase::Following,
            BackupState::Armed => FollowerPhase::Armed,
            BackupState::MainLost { .. } => FollowerPhase::MainLost,
            BackupState::Standalone => FollowerPhase::Standalone,
            BackupState::Diverged => FollowerPhase::Diverged,
        }
    }
}

impl FollowerPhase {
    pub fn as_backup_phase(self) -> BackupPhase {
        match self {
            FollowerPhase::Disabled | FollowerPhase::Pairing => BackupPhase::Pairing,
            FollowerPhase::CheckingSession => BackupPhase::CheckingSession,
            FollowerPhase::SessionMismatch => BackupPhase::SessionMismatch,
            FollowerPhase::Following => BackupPhase::Following,
            FollowerPhase::Armed => BackupPhase::Armed,
            FollowerPhase::MainLost => BackupPhase::MainLost,
            FollowerPhase::Standalone => BackupPhase::Standalone,
            FollowerPhase::Diverged => BackupPhase::Diverged,
        }
    }
}

/// The backup's engine and session, as the follower reads them each tick
/// (no session lock: audio clock + the session feed's latest frame).
#[derive(Debug, Clone, Default)]
pub struct LocalInputs {
    pub clock: Option<AudioClockSample>,
    pub vamp: bool,
    /// Engine seconds.
    pub pending_jump: Option<CoreJump>,
}

#[derive(Debug)]
pub struct FollowerCore {
    pub policy: Policy,
    lifecycle: BackupLifecycle,
    monitor: HeartbeatMonitor,
    main_health: HealthSummary,
    connected: bool,
    last_transition: Option<Transition>,
    pub manual_offset_seconds: f64,
    gate: SeqGate,
    main: Option<MainView>,
    main_name: Option<String>,
    /// Trigger/transition of each jump the main announced, by target, so a
    /// jump only seen in a state can still be scheduled the same way.
    jump_specs: HashMap<String, CoreJump>,
    vamp_mode: Option<(String, Option<u32>)>,
    pub main_may_forward: bool,
    main_fingerprint: Option<SessionFingerprint>,
    own_fingerprint: Option<SessionFingerprint>,
    diffs: Vec<FingerprintDiff>,
    last_applied_intent: u64,
    last_correction_ns: Option<u64>,
    last_correction_seconds: Option<f64>,
    playing_since_ns: Option<u64>,
    pub corrections: u32,
    last_offset_seconds: Option<f64>,
    main_sample_rate: u32,
    /// Mix messages from the main waiting to be applied (step 09): `true` =
    /// a whole snapshot.
    pending_mix: Vec<(bool, Vec<MixControl>)>,
    mix_diverged: bool,
}

/// `marker:<id>` / `region:<id>`.
fn jump_key(kind: &str, id: &str) -> String {
    format!("{kind}:{id}")
}

fn to_source(song: Option<&Song>, view_seconds: f64) -> f64 {
    song.map_or(view_seconds, |song| source_seconds_at_view(song, view_seconds))
}

pub fn to_view(song: Option<&Song>, source_seconds: f64) -> f64 {
    song.map_or(source_seconds, |song| warp_timeline_seconds_at(song, source_seconds))
}

/// The song (region) at an engine position, and its bounds.
pub fn region_at(song: Option<&Song>, seconds: f64) -> Option<(String, f64, f64)> {
    song?.regions.iter().find_map(|region| {
        (seconds >= region.start_seconds && seconds < region.end_seconds).then(|| {
            (
                region.id.clone(),
                region.start_seconds,
                region.end_seconds,
            )
        })
    })
}

impl FollowerCore {
    pub fn new(policy: Policy, manual_offset_seconds: f64) -> Self {
        let mut lifecycle = BackupLifecycle::new(LifecyclePolicy {
            correction_threshold_seconds: policy.correction_threshold_seconds,
            ..LifecyclePolicy::default()
        });
        lifecycle.enable();
        Self {
            policy,
            lifecycle,
            monitor: HeartbeatMonitor::new(DEFAULT_HEARTBEAT_TIMEOUT_MS),
            main_health: HealthSummary {
                audio_ok: true,
                fallback_active: false,
                pilot_tone_on: false,
            },
            connected: false,
            last_transition: None,
            manual_offset_seconds,
            gate: SeqGate::default(),
            main: None,
            main_name: None,
            jump_specs: HashMap::new(),
            vamp_mode: None,
            main_may_forward: false,
            main_fingerprint: None,
            own_fingerprint: None,
            diffs: Vec::new(),
            last_applied_intent: 0,
            last_correction_ns: None,
            last_correction_seconds: None,
            playing_since_ns: None,
            corrections: 0,
            last_offset_seconds: None,
            main_sample_rate: 0,
            pending_mix: Vec::new(),
            mix_diverged: false,
        }
    }

    /// Mix messages to apply, oldest first. Only while following: a backup
    /// with another session (or lost) keeps its own mix.
    pub fn take_mix(&mut self) -> Vec<(bool, Vec<MixControl>)> {
        let pending = std::mem::take(&mut self.pending_mix);
        if self.lifecycle.applies_actions() {
            pending
        } else {
            Vec::new()
        }
    }

    /// The backup's mix differs from the main's last whole mix.
    pub fn set_mix_diverged(&mut self, diverged: bool) {
        self.mix_diverged = diverged;
    }

    pub fn mix_diverged(&self) -> bool {
        self.mix_diverged
    }

    /// The link connection went up or down (the client tells).
    pub fn set_connected(&mut self, connected: bool) {
        self.connected = connected;
    }

    /// Heartbeat timeout, 0.5-5 s (step 07).
    pub fn set_heartbeat_timeout_ms(&mut self, timeout_ms: u64) {
        self.monitor.set_timeout_ms(timeout_ms.clamp(500, 5_000));
    }

    /// The operator moved the transport locally (only possible while the
    /// main is lost): coming back to it is no longer automatic.
    pub fn local_order(&mut self) {
        self.lifecycle.local_order();
    }

    /// «Ahora mando yo».
    pub fn take_command(&mut self) -> Option<Transition> {
        let transition = self.lifecycle.take_command();
        self.last_transition = transition.or(self.last_transition);
        transition
    }

    /// From `Diverged`: follow the main again.
    pub fn follow_again(&mut self) -> Option<Transition> {
        let transition = self.lifecycle.follow_again();
        self.last_transition = transition.or(self.last_transition);
        transition
    }

    /// The transition the last tick caused, once.
    pub fn take_transition(&mut self) -> Option<Transition> {
        self.last_transition.take()
    }

    pub fn last_reason(&self) -> &'static str {
        self.lifecycle.last_reason()
    }

    pub fn lifecycle_state(&self) -> BackupState {
        self.lifecycle.state()
    }

    pub fn main_name(&self) -> Option<&str> {
        self.main_name.as_deref()
    }

    pub fn diffs(&self) -> &[FingerprintDiff] {
        &self.diffs
    }

    pub fn last_offset_seconds(&self) -> Option<f64> {
        self.last_offset_seconds
    }

    pub fn main_sample_rate(&self) -> u32 {
        self.main_sample_rate
    }

    pub fn vamp_mode(&self) -> Option<(String, Option<u32>)> {
        self.vamp_mode.clone()
    }

    pub fn phase(&self) -> FollowerPhase {
        self.lifecycle.state().into()
    }

    fn session_check(&self) -> SessionCheck {
        match (&self.main_fingerprint, &self.own_fingerprint) {
            (Some(_), Some(_)) if self.diffs.iter().any(FingerprintDiff::blocks_arming) => {
                SessionCheck::Different
            }
            (Some(_), Some(_)) => SessionCheck::Same,
            _ => SessionCheck::Unknown,
        }
    }

    pub fn set_own_fingerprint(&mut self, fingerprint: SessionFingerprint) {
        self.own_fingerprint = Some(fingerprint);
        self.recompare();
    }

    fn recompare(&mut self) {
        self.diffs = match (&self.main_fingerprint, &self.own_fingerprint) {
            (Some(main), Some(own)) => compare(main, own),
            _ => Vec::new(),
        };
    }

    fn core_jump(&self, jump: &LinkJump, song: Option<&Song>) -> CoreJump {
        let (key, execute_at) = match jump {
            LinkJump::Marker {
                marker_id,
                execute_at_seconds,
            } => (jump_key("marker", marker_id), *execute_at_seconds),
            LinkJump::Region {
                region_id,
                execute_at_seconds,
            } => (jump_key("region", region_id), *execute_at_seconds),
        };
        let execute_at_seconds = execute_at.map(|view| to_source(song, view));
        match self.jump_specs.get(&key) {
            Some(spec) => CoreJump {
                execute_at_seconds,
                ..spec.clone()
            },
            None => CoreJump {
                target: key,
                trigger: String::new(),
                bars: None,
                transition: None,
                duration_seconds: None,
                execute_at_seconds,
                target_seconds: None,
            },
        }
    }

    fn core_intent(
        &mut self,
        intent: &TransportIntent,
        at_ns: u64,
        song: Option<&Song>,
    ) -> Option<MainIntent> {
        Some(match intent {
            TransportIntent::Play { from_seconds } => MainIntent::Play {
                from_seconds: to_source(song, *from_seconds),
                at_ns,
            },
            TransportIntent::Pause { at_seconds } => MainIntent::Pause {
                at_seconds: to_source(song, *at_seconds),
            },
            TransportIntent::Stop => MainIntent::Stop,
            TransportIntent::FadeOutStop { duration_ms } => MainIntent::FadeOutStop {
                duration_ms: *duration_ms,
            },
            TransportIntent::Seek { to_seconds } => MainIntent::Seek {
                to_seconds: to_source(song, *to_seconds),
                at_ns,
            },
            TransportIntent::ScheduleMarkerJump {
                marker_id,
                trigger,
                bars,
                transition,
                duration_seconds,
            } => {
                let jump = CoreJump {
                    target: jump_key("marker", marker_id),
                    trigger: trigger.clone(),
                    bars: *bars,
                    transition: transition.clone(),
                    duration_seconds: *duration_seconds,
                    execute_at_seconds: None,
                    target_seconds: None,
                };
                self.jump_specs.insert(jump.target.clone(), jump.clone());
                MainIntent::ScheduleJump(jump)
            }
            TransportIntent::ScheduleRegionJump {
                region_id,
                trigger,
                bars,
                transition,
                duration_seconds,
            } => {
                let jump = CoreJump {
                    target: jump_key("region", region_id),
                    trigger: trigger.clone(),
                    bars: *bars,
                    transition: transition.clone(),
                    duration_seconds: *duration_seconds,
                    execute_at_seconds: None,
                    target_seconds: None,
                };
                self.jump_specs.insert(jump.target.clone(), jump.clone());
                MainIntent::ScheduleJump(jump)
            }
            TransportIntent::CancelJump => MainIntent::CancelJump,
            TransportIntent::ToggleVamp {
                enabled,
                mode,
                bars,
            } => {
                if let Some(mode) = mode {
                    self.vamp_mode = Some((mode.clone(), *bars));
                }
                MainIntent::SetVamp(*enabled)
            }
            TransportIntent::SongChanged { .. } => return None,
        })
    }

    /// One message from the main. `host_offset_ns` = main clock − local
    /// clock (the link's estimator); without it a state cannot be placed in
    /// time and is skipped (the next one will do). `song` = the backup's own
    /// session, for view ↔ engine time.
    pub fn on_message(
        &mut self,
        message: RedundancyMessage,
        now_ns: u64,
        host_offset_ns: Option<f64>,
        song: Option<&Song>,
    ) {
        let to_local = |main_ns: u64| -> Option<u64> {
            host_offset_ns.map(|offset| (main_ns as f64 - offset).max(0.0) as u64)
        };
        // Anything from the main means it is there.
        self.monitor.observe(now_ns / 1_000_000);
        self.connected = true;
        if let Some(seq) = message.seq() {
            if !self.gate.accept(seq) {
                return;
            }
        }
        match message {
            RedundancyMessage::Welcome {
                main_name,
                instance_id,
                settings,
                ..
            } => {
                self.gate.reset_for(&instance_id);
                self.main_name = Some(main_name);
                self.main_may_forward = settings.backup_may_forward;
            }
            RedundancyMessage::State {
                clock,
                song_id,
                vamp,
                pending_jumps,
                ..
            } => {
                let Some(sampled_at_ns) = to_local(clock.callback_monotonic_ns) else {
                    return;
                };
                self.main_sample_rate = clock.sample_rate;
                let pending_jump = pending_jumps.first().map(|jump| self.core_jump(jump, song));
                let last_intent = self.main.as_ref().and_then(|main| main.last_intent.clone());
                self.main = Some(MainView {
                    clock: AudioClockSample {
                        position_seconds: clock.position_seconds,
                        sampled_at_ns,
                        playing: clock.playing,
                        output_latency_seconds: clock.output_latency_seconds,
                    },
                    song_id,
                    vamp: vamp.is_some_and(|vamp| vamp.enabled),
                    pending_jump,
                    last_intent,
                    received_at_ns: now_ns,
                });
            }
            RedundancyMessage::Intent {
                seq,
                intent,
                monotonic_ns,
            } => {
                let at_ns = to_local(monotonic_ns).unwrap_or(now_ns);
                let Some(intent) = self.core_intent(&intent, at_ns, song) else {
                    return;
                };
                if let Some(main) = &mut self.main {
                    main.last_intent = Some((seq, intent));
                    main.received_at_ns = now_ns;
                }
            }
            RedundancyMessage::Heartbeat { health, .. } => {
                self.main_health = health;
                if let Some(main) = &mut self.main {
                    main.received_at_ns = now_ns;
                }
            }
            RedundancyMessage::Fingerprint { fingerprint, .. } => {
                if let Ok(fingerprint) = serde_json::from_str(&fingerprint) {
                    self.main_fingerprint = Some(fingerprint);
                    self.recompare();
                }
            }
            RedundancyMessage::Mix { full, controls, .. } => {
                self.pending_mix.push((full, controls));
            }
            RedundancyMessage::BackupStatus { .. }
            | RedundancyMessage::RoleChange { .. }
            | RedundancyMessage::Handover { .. }
            | RedundancyMessage::BackupInfo { .. }
            | RedundancyMessage::GuestAccess { .. } => {}
        }
    }

    /// The action for now. Transport actions only reach the session while
    /// the lifecycle follows (`Following`/`Armed`): not before the session is
    /// checked, not with a blocking difference, never with the main lost.
    pub fn decide(&mut self, now_ns: u64, local: &LocalInputs, song: Option<&Song>) -> Decision {
        let Some(clock) = local.clock else {
            return Decision {
                action: Action::None,
                applied_intent: None,
                offset_seconds: None,
            };
        };
        let position = clock.rendered_position_at(now_ns);
        let region = region_at(song, position);
        let view = LocalView {
            clock,
            song_id: region.as_ref().map(|(id, _, _)| id.clone()),
            vamp: local.vamp,
            pending_jump: local.pending_jump.clone(),
            last_applied_intent_seq: self.last_applied_intent,
            last_correction_at_ns: self.last_correction_ns,
            playing_since_ns: self.playing_since_ns,
            region_bounds: region.map(|(_, start, end)| (start, end)),
            manual_offset_seconds: self.manual_offset_seconds,
            main_lost: self.lifecycle.main_lost(),
        };
        let decision = reconcile(now_ns, self.main.as_ref(), &view, &self.policy);
        if let Some(offset) = decision.offset_seconds {
            self.last_offset_seconds = Some(offset);
        }

        // Is the main, when fresh, where we are?
        let fresh = self.main.as_ref().filter(|main| {
            (now_ns.saturating_sub(main.received_at_ns) as f64) / 1e9
                <= self.policy.stale_after_seconds
        });
        let main_matches = fresh.map(|main| {
            let same_play = main.clock.playing == view.clock.playing;
            let same_song = main.song_id.is_none()
                || view.song_id.is_none()
                || main.song_id == view.song_id;
            let offset = main.clock.audible_position_at(now_ns)
                - view.clock.audible_position_at(now_ns)
                - self.manual_offset_seconds;
            same_play && same_song && offset.abs() < self.policy.hard_resync_threshold_seconds
        });
        let observation = BackupObservation {
            now_ns,
            connected: self.connected,
            main_alive: self.monitor.is_alive(now_ns / 1_000_000),
            main_audio_ok: self.main_health.audio_ok,
            main_fallback_active: self.main_health.fallback_active,
            session: self.session_check(),
            offset_seconds: decision.offset_seconds,
            resynced: matches!(
                decision.action,
                Action::Play { .. } | Action::Pause { .. } | Action::SeekAbsolute { .. }
            ) && decision.applied_intent.is_none(),
            main_matches,
        };
        if let Some(transition) = self.lifecycle.observe(&observation) {
            self.last_transition = Some(transition);
        }

        let freewheel = matches!(decision.action, Action::Freewheel(_));
        if !freewheel && !self.lifecycle.applies_actions() {
            return Decision {
                action: Action::None,
                applied_intent: None,
                offset_seconds: decision.offset_seconds,
            };
        }
        decision
    }

    /// The action ran (or was not needed): remember it.
    pub fn record(&mut self, decision: &Decision, now_ns: u64) {
        if let Some(seq) = decision.applied_intent {
            self.last_applied_intent = seq;
        }
        match &decision.action {
            Action::Nudge { delta_seconds } => {
                self.last_correction_ns = Some(now_ns);
                self.last_correction_seconds = Some(*delta_seconds);
                self.corrections += 1;
            }
            Action::Play { .. } | Action::SeekAbsolute { .. } => {
                self.playing_since_ns = Some(now_ns);
            }
            _ => {}
        }
    }

    pub fn status(&self, include_fingerprint: bool) -> RedundancyMessage {
        RedundancyMessage::BackupStatus {
            phase: self.phase().as_backup_phase(),
            offset_ms: self.last_offset_seconds.map(|offset| offset * 1000.0),
            last_correction_ms: self.last_correction_seconds.map(|delta| delta * 1000.0),
            fingerprint: include_fingerprint
                .then(|| {
                    self.own_fingerprint
                        .as_ref()
                        .and_then(|own| serde_json::to_string(own).ok())
                })
                .flatten(),
            mix_diverged: self.mix_diverged,
        }
    }

    /// Whether the backup's own transport must stay locked (following or
    /// armed). Not while the main is lost (R6) or the sessions differ.
    pub fn locks_local_inputs(&self) -> bool {
        self.lifecycle.locks_local_inputs()
    }
}

/// Applies the reconciler's actions.
pub trait FollowTarget {
    fn apply(&mut self, action: &Action, vamp_mode: Option<(String, Option<u32>)>)
        -> Result<(), String>;
}

/// Whether an action touches the transport (and so the session lock).
pub fn is_transport_action(action: &Action) -> bool {
    !matches!(action, Action::None | Action::Freewheel(_))
}

/// One tick: decide, apply if it is a transport action, record.
pub fn tick(
    core: &mut FollowerCore,
    target: &mut impl FollowTarget,
    now_ns: u64,
    local: &LocalInputs,
    song: Option<&Song>,
) -> Decision {
    let decision = core.decide(now_ns, local, song);
    if is_transport_action(&decision.action) {
        if let Err(error) = target.apply(&decision.action, core.vamp_mode()) {
            if cfg!(debug_assertions) {
                eprintln!("[redundancy] follower could not apply {:?}: {error}", decision.action);
            }
            // Not recorded: the next tick decides again.
            return decision;
        }
    }
    core.record(&decision, now_ns);
    decision
}

// --- the real session ---

use tauri::{AppHandle, Manager};

use crate::commands::transport::{parse_jump_trigger, parse_transition_type, parse_vamp_mode};
use crate::state::{DesktopSession, DesktopState, IntentOrigin};

/// Apply `action` to a session as the follower (origin `Follower`, which the
/// local-input lock lets through).
pub fn apply_to_session(
    session: &mut DesktopSession,
    audio: &crate::audio::engine::AudioController,
    action: &Action,
    vamp_mode: Option<(String, Option<u32>)>,
) -> Result<(), String> {
    let _origin = session.intent_origin_scope(IntentOrigin::Follower);
    let song = session.engine.song().cloned();
    let view = |source: f64| to_view(song.as_ref(), source);
    let error = |error: crate::infra::error::DesktopError| error.to_string();
    match action {
        Action::None | Action::Freewheel(_) => {}
        Action::Play { from_seconds } => {
            session.seek(view(*from_seconds), audio).map_err(error)?;
            session.play(audio).map_err(error)?;
        }
        Action::Pause { at_seconds } => {
            session.pause(audio).map_err(error)?;
            session.seek(view(*at_seconds), audio).map_err(error)?;
        }
        Action::Stop => {
            session.stop(audio).map_err(error)?;
        }
        Action::FadeOutStop { duration_ms } => {
            session
                .fade_out_and_stop(f64::from(*duration_ms) / 1000.0, audio)
                .map_err(error)?;
        }
        Action::SeekAbsolute { to_seconds } => {
            session.seek(view(*to_seconds), audio).map_err(error)?;
        }
        Action::Nudge { delta_seconds } => {
            session.nudge_transport(*delta_seconds, audio).map_err(error)?;
        }
        Action::ScheduleJump(jump) => {
            if jump.trigger.is_empty() {
                // Only seen in a state, never announced: its trigger is
                // unknown and guessing would jump at the wrong moment.
                return Err("jump without trigger".into());
            }
            let trigger = parse_jump_trigger(&jump.trigger, jump.bars).map_err(error)?;
            let transition = parse_transition_type(jump.transition.as_deref(), jump.duration_seconds)
                .map_err(error)?;
            if let Some(marker) = jump.target.strip_prefix("marker:") {
                session
                    .schedule_marker_jump(marker, trigger, transition, audio)
                    .map_err(error)?;
            } else if let Some(region) = jump.target.strip_prefix("region:") {
                session
                    .schedule_region_jump(region, trigger, transition, audio)
                    .map_err(error)?;
            }
        }
        Action::CancelJump => {
            session.cancel_marker_jump(audio).map_err(error)?;
        }
        Action::SetVamp(enabled) => {
            let active = session.snapshot().active_vamp.is_some();
            if active != *enabled {
                let (mode, bars) = vamp_mode.unwrap_or_else(|| ("section".into(), None));
                let mode = parse_vamp_mode(&mode, bars).map_err(error)?;
                session.toggle_vamp(mode, audio).map_err(error)?;
            }
        }
    }
    Ok(())
}

/// The app's own session.
pub struct SessionTarget {
    pub app: AppHandle,
}

impl FollowTarget for SessionTarget {
    fn apply(
        &mut self,
        action: &Action,
        vamp_mode: Option<(String, Option<u32>)>,
    ) -> Result<(), String> {
        let state = self.app.state::<DesktopState>();
        let mut session = state.session.lock().map_err(|_| "state poisoned")?;
        apply_to_session(&mut session, &state.audio, action, vamp_mode)
    }
}

#[cfg(test)]
#[path = "follower_tests.rs"]
mod tests;
