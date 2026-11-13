//! Redundancy lifecycle (docs/plans/completed/redundancy/07-caida-y-promocion.md):
//! the backup's and the main's state machines, the 4 Hz limit on status
//! events and what to do at startup after an unclean exit. Pure: every
//! instant is injected (ns of one local monotonic base).
//!
//! Safety rules the machines keep:
//! - from the backup, "the main hung" and "the cable came out" look the
//!   same, so losing the main never touches the audio and never hands over
//!   control by itself (D1: `Standalone` only when the operator says so);
//! - no automatic failback: a main that comes back is followed again only
//!   if nothing diverged meanwhile;
//! - nobody can tell which machine is on the PA (the software does not see
//!   the switcher), so every rule is safe without knowing it.

/// The backup's states (§4.5 of the design).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackupState {
    Disabled,
    /// Enabled, not connected to the main yet.
    Pairing,
    CheckingSession,
    SessionMismatch,
    Following,
    /// Following and in step long enough to be switched to.
    Armed,
    MainLost { since_ns: u64 },
    /// The operator took over. Follows nobody.
    Standalone,
    /// The main came back somewhere else (or the operator acted meanwhile):
    /// the user decides.
    Diverged,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionCheck {
    Unknown,
    Same,
    Different,
}

/// What the backup sees on one tick.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BackupObservation {
    pub now_ns: u64,
    pub connected: bool,
    /// The heartbeat monitor says the main is there.
    pub main_alive: bool,
    /// The main's own health from its last heartbeat.
    pub main_audio_ok: bool,
    pub main_fallback_active: bool,
    pub session: SessionCheck,
    /// Measured offset this tick (main − backup), when both play.
    pub offset_seconds: Option<f64>,
    /// The follower just did a full resync (hard seek, play, pause).
    pub resynced: bool,
    /// When the main is fresh: whether it is where the backup is (same
    /// play state, same song, offset under the hard-resync threshold).
    pub main_matches: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LifecyclePolicy {
    pub correction_threshold_seconds: f64,
    pub arm_after_seconds: f64,
    pub disarm_after_seconds: f64,
    /// Main unhealthy (no audio / fallback clock) this long = lost.
    pub unhealthy_after_seconds: f64,
}

impl Default for LifecyclePolicy {
    fn default() -> Self {
        Self {
            correction_threshold_seconds: 0.005,
            arm_after_seconds: 3.0,
            disarm_after_seconds: 1.0,
            unhealthy_after_seconds: 0.5,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Transition {
    pub from: BackupState,
    pub to: BackupState,
    pub reason: &'static str,
}

#[derive(Debug, Clone)]
pub struct BackupLifecycle {
    state: BackupState,
    policy: LifecyclePolicy,
    in_sync_since_ns: Option<u64>,
    out_of_sync_since_ns: Option<u64>,
    unhealthy_since_ns: Option<u64>,
    local_orders_while_lost: bool,
    last_reason: &'static str,
}

fn elapsed(from_ns: u64, to_ns: u64) -> f64 {
    to_ns.saturating_sub(from_ns) as f64 / 1e9
}

impl BackupLifecycle {
    pub fn new(policy: LifecyclePolicy) -> Self {
        Self {
            state: BackupState::Disabled,
            policy,
            in_sync_since_ns: None,
            out_of_sync_since_ns: None,
            unhealthy_since_ns: None,
            local_orders_while_lost: false,
            last_reason: "",
        }
    }

    pub fn state(&self) -> BackupState {
        self.state
    }

    pub fn last_reason(&self) -> &'static str {
        self.last_reason
    }

    /// Only the follower moves the transport (R5).
    pub fn locks_local_inputs(&self) -> bool {
        matches!(self.state, BackupState::Following | BackupState::Armed)
    }

    /// Whether the reconciler's transport actions are applied.
    pub fn applies_actions(&self) -> bool {
        matches!(self.state, BackupState::Following | BackupState::Armed)
    }

    pub fn main_lost(&self) -> bool {
        matches!(self.state, BackupState::MainLost { .. })
    }

    fn go(&mut self, to: BackupState, reason: &'static str) -> Option<Transition> {
        if self.state == to {
            return None;
        }
        let from = self.state;
        self.state = to;
        self.last_reason = reason;
        self.in_sync_since_ns = None;
        self.out_of_sync_since_ns = None;
        if !matches!(to, BackupState::MainLost { .. }) {
            self.local_orders_while_lost = false;
        }
        Some(Transition { from, to, reason })
    }

    pub fn enable(&mut self) -> Option<Transition> {
        match self.state {
            BackupState::Disabled => self.go(BackupState::Pairing, "enabled"),
            _ => None,
        }
    }

    pub fn disable(&mut self) -> Option<Transition> {
        self.go(BackupState::Disabled, "disabled")
    }

    /// The operator moved the transport locally (only possible when
    /// unlocked, i.e. with the main lost).
    pub fn local_order(&mut self) {
        if self.main_lost() {
            self.local_orders_while_lost = true;
        }
    }

    /// «Ahora mando yo» (D1: the ONLY way into `Standalone`). Also from
    /// `Following`/`Armed`: a planned handover with the main still alive (its
    /// interface fails, a cable goes). Not before the backup follows: there
    /// is nothing in step to take over.
    pub fn take_command(&mut self) -> Option<Transition> {
        match self.state {
            BackupState::MainLost { .. } | BackupState::Diverged => {
                self.go(BackupState::Standalone, "operator took command")
            }
            BackupState::Following | BackupState::Armed => {
                self.go(BackupState::Standalone, "planned handover")
            }
            _ => None,
        }
    }

    /// From `Diverged`, the user chose to follow the main again.
    pub fn follow_again(&mut self) -> Option<Transition> {
        match self.state {
            BackupState::Diverged => self.go(BackupState::CheckingSession, "operator follows again"),
            _ => None,
        }
    }

    pub fn observe(&mut self, obs: &BackupObservation) -> Option<Transition> {
        let now = obs.now_ns;
        match self.state {
            BackupState::Disabled | BackupState::Standalone | BackupState::Diverged => None,
            BackupState::Pairing | BackupState::CheckingSession | BackupState::SessionMismatch => {
                if !obs.connected {
                    return self.go(BackupState::Pairing, "not connected");
                }
                match obs.session {
                    SessionCheck::Unknown => self.go(BackupState::CheckingSession, "connected"),
                    SessionCheck::Different => {
                        self.go(BackupState::SessionMismatch, "the sessions differ")
                    }
                    SessionCheck::Same => self.go(BackupState::Following, "same session"),
                }
            }
            BackupState::Following | BackupState::Armed => {
                // Lost: silent, or alive but without audio for too long.
                if !obs.main_alive {
                    return self.go(BackupState::MainLost { since_ns: now }, "heartbeat timeout");
                }
                if !obs.main_audio_ok || obs.main_fallback_active {
                    let since = *self.unhealthy_since_ns.get_or_insert(now);
                    if elapsed(since, now) > self.policy.unhealthy_after_seconds {
                        self.unhealthy_since_ns = None;
                        return self
                            .go(BackupState::MainLost { since_ns: now }, "main audio failed");
                    }
                } else {
                    self.unhealthy_since_ns = None;
                }
                if obs.session == SessionCheck::Different {
                    return self.go(BackupState::SessionMismatch, "the sessions differ");
                }
                let in_step = obs
                    .offset_seconds
                    .is_some_and(|offset| offset.abs() <= self.policy.correction_threshold_seconds);
                if self.state == BackupState::Following {
                    if in_step && obs.session == SessionCheck::Same {
                        let since = *self.in_sync_since_ns.get_or_insert(now);
                        if elapsed(since, now) >= self.policy.arm_after_seconds {
                            return self.go(BackupState::Armed, "in step");
                        }
                    } else {
                        self.in_sync_since_ns = None;
                    }
                    None
                } else {
                    if obs.resynced {
                        return self.go(BackupState::Following, "full resync");
                    }
                    if in_step || obs.offset_seconds.is_none() {
                        self.out_of_sync_since_ns = None;
                    } else {
                        let since = *self.out_of_sync_since_ns.get_or_insert(now);
                        if elapsed(since, now) > self.policy.disarm_after_seconds {
                            return self.go(BackupState::Following, "out of step");
                        }
                    }
                    None
                }
            }
            BackupState::MainLost { .. } => {
                if !(obs.main_alive && obs.main_audio_ok && !obs.main_fallback_active) {
                    return None;
                }
                match obs.main_matches {
                    None => None,
                    Some(true) if !self.local_orders_while_lost => {
                        self.go(BackupState::Following, "main back in the same state")
                    }
                    Some(true) => self.go(BackupState::Diverged, "local orders while lost"),
                    Some(false) => self.go(BackupState::Diverged, "main back in another state"),
                }
            }
        }
    }
}

/// The main's view of its backup.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MainState {
    NoBackup,
    BackupConnected,
    BackupArmed,
    BackupMismatch,
    /// A warning only: nothing changes in the main's audio.
    BackupLost,
}

/// What the backup reported in its last status.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReportedPhase {
    CheckingSession,
    SessionMismatch,
    Following,
    Armed,
    MainLost,
    Standalone,
    Diverged,
}

/// A backup that became the main offers this one to switch roles.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoleOffer {
    pub new_main_name: String,
    pub new_main_address: Option<String>,
}

#[derive(Debug, Clone)]
pub struct MainLifecycle {
    state: MainState,
    had_backup: bool,
    offer: Option<RoleOffer>,
}

impl Default for MainLifecycle {
    fn default() -> Self {
        Self {
            state: MainState::NoBackup,
            had_backup: false,
            offer: None,
        }
    }
}

impl MainLifecycle {
    pub fn state(&self) -> MainState {
        self.state
    }

    /// `connected`: the link server has a backup; `alive`: its heartbeats
    /// arrive; `reported`: its last status.
    pub fn observe(
        &mut self,
        connected: bool,
        alive: bool,
        reported: Option<ReportedPhase>,
    ) -> Option<(MainState, MainState)> {
        let next = if !connected || !alive {
            if self.had_backup {
                MainState::BackupLost
            } else {
                MainState::NoBackup
            }
        } else {
            self.had_backup = true;
            match reported {
                Some(ReportedPhase::SessionMismatch) => MainState::BackupMismatch,
                Some(ReportedPhase::Armed) => MainState::BackupArmed,
                _ => MainState::BackupConnected,
            }
        };
        (next != self.state).then(|| {
            let from = self.state;
            self.state = next;
            (from, next)
        })
    }

    /// The backup stopped being wanted (role off): forget it.
    pub fn reset(&mut self) {
        *self = Self::default();
    }

    /// Kept until the user accepts or dismisses it; never applied alone (the
    /// switcher may have gone back to this machine).
    pub fn offer_role_change(&mut self, offer: RoleOffer) {
        self.offer = Some(offer);
    }

    pub fn pending_offer(&self) -> Option<&RoleOffer> {
        self.offer.as_ref()
    }

    pub fn accept_offer(&mut self) -> Option<RoleOffer> {
        self.offer.take()
    }

    pub fn dismiss_offer(&mut self) {
        self.offer = None;
    }
}

/// At most one status event per `min_interval`, plus one on every state
/// change.
#[derive(Debug, Clone)]
pub struct StatusThrottle {
    min_interval_ns: u64,
    last_emit_ns: Option<u64>,
}

impl StatusThrottle {
    /// 4 Hz.
    pub fn four_hz() -> Self {
        Self {
            min_interval_ns: 250_000_000,
            last_emit_ns: None,
        }
    }

    pub fn should_emit(&mut self, now_ns: u64, state_changed: bool) -> bool {
        let due = self
            .last_emit_ns
            .is_none_or(|last| now_ns.saturating_sub(last) >= self.min_interval_ns);
        if state_changed || due {
            self.last_emit_ns = Some(now_ns);
            true
        } else {
            false
        }
    }
}

/// What a machine does at launch about its redundancy role (R4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StartupPlan {
    pub resume_main: bool,
    pub pilot_tone_armed: bool,
    /// Show «this machine closed unexpectedly, re-arm the pilot tone».
    pub warn_unclean_exit: bool,
}

/// `last_role_was_main`: saved in `redundancy.json`; `unclean_exit`: the
/// crash marker of the previous run was still there; `pilot_setting`: the
/// user's pilot-tone switch.
pub fn startup_plan(last_role_was_main: bool, unclean_exit: bool, pilot_setting: bool) -> StartupPlan {
    if !last_role_was_main {
        return StartupPlan {
            resume_main: false,
            pilot_tone_armed: false,
            warn_unclean_exit: false,
        };
    }
    StartupPlan {
        resume_main: true,
        // A main that crashed must not start emitting the tone as if nothing
        // happened: some switchers would go back to it.
        pilot_tone_armed: pilot_setting && !unclean_exit,
        // The warning asks to re-arm the tone: without one there is nothing
        // to re-arm, and the banner would only sit on top of the window.
        warn_unclean_exit: unclean_exit && pilot_setting,
    }
}

#[cfg(test)]
#[path = "lifecycle_tests.rs"]
mod tests;
