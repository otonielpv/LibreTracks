//! The heart of redundancy (docs/plans/redundancy/05-reconciliador.md):
//! given what the backup knows about the main and what its own engine is
//! doing, decide the ONE action the backup takes now.
//!
//! Pure: no network, engine, Tauri or clock. Every instant is injected as
//! nanoseconds of the backup's local monotonic base, every position is in
//! engine (timeline) seconds — the caller converts. `libretracks-link`'s
//! messages are translated into these types by the desktop follower (core
//! cannot depend on the link crate).
//!
//! Priority when several things differ (one call, one action; the next call,
//! 20 ms later, takes the next one):
//! 1. no data / stale data → `Freewheel` (NEVER stop or pause for lack of
//!    data);
//! 2. after the main was lost, a main that comes back in another state →
//!    `Freewheel(Diverged)` (the lifecycle decides, step 07);
//! 3. a new intent → its direct action, extrapolated to now;
//! 4. playing state or song differ → full resync;
//! 5. pending jump differs → schedule / cancel;
//! 6. vamp differs → set it;
//! 7. offset → hard seek, nudge (outside the guard window, rate-limited) or
//!    nothing.

use crate::audio_clock::{elapsed_seconds, AudioClockSample};

/// A jump the main has scheduled. Positions in engine seconds.
#[derive(Debug, Clone, PartialEq)]
pub struct PendingJump {
    /// `marker:<id>` or `region:<id>`: what identifies the jump on both
    /// machines (the same session gives the same target).
    pub target: String,
    pub trigger: String,
    pub bars: Option<u32>,
    pub transition: Option<String>,
    pub duration_seconds: Option<f64>,
    /// Where it fires, when the main knows it.
    pub execute_at_seconds: Option<f64>,
    /// Where it lands (only used to reason about it; the backup's session
    /// computes its own landing from `target`).
    pub target_seconds: Option<f64>,
}

impl PendingJump {
    pub fn same_jump(&self, other: &PendingJump) -> bool {
        self.target == other.target
    }
}

/// A transport change of the main, already on the local base.
#[derive(Debug, Clone, PartialEq)]
pub enum MainIntent {
    Play { from_seconds: f64, at_ns: u64 },
    Pause { at_seconds: f64 },
    Stop,
    FadeOutStop { duration_ms: u32 },
    Seek { to_seconds: f64, at_ns: u64 },
    ScheduleJump(PendingJump),
    CancelJump,
    SetVamp(bool),
}

/// The latest we know about the main, on the local base.
#[derive(Debug, Clone, PartialEq)]
pub struct MainView {
    pub clock: AudioClockSample,
    pub song_id: Option<String>,
    pub vamp: bool,
    pub pending_jump: Option<PendingJump>,
    pub last_intent: Option<(u64, MainIntent)>,
    /// When the last message from the main arrived.
    pub received_at_ns: u64,
}

/// The backup's engine, now.
#[derive(Debug, Clone, PartialEq)]
pub struct LocalView {
    pub clock: AudioClockSample,
    pub song_id: Option<String>,
    pub vamp: bool,
    pub pending_jump: Option<PendingJump>,
    pub last_applied_intent_seq: u64,
    pub last_correction_at_ns: Option<u64>,
    /// When playback last started or was repositioned (no nudge right after).
    pub playing_since_ns: Option<u64>,
    /// The current song's (region's) bounds, engine seconds.
    pub region_bounds: Option<(f64, f64)>,
    /// Calibration from step 11: how much later the backup should SOUND.
    pub manual_offset_seconds: f64,
    /// The lifecycle saw the main as lost and has not re-armed yet.
    pub main_lost: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Policy {
    pub correction_threshold_seconds: f64,
    pub min_correction_interval_seconds: f64,
    pub guard_window_seconds: f64,
    pub hard_resync_threshold_seconds: f64,
    pub stale_after_seconds: f64,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            correction_threshold_seconds: 0.005,
            min_correction_interval_seconds: 2.0,
            guard_window_seconds: 0.150,
            hard_resync_threshold_seconds: 0.250,
            stale_after_seconds: 1.0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FreewheelReason {
    /// Nothing heard from the main yet.
    NoData,
    /// The main went quiet for longer than `stale_after`.
    Stale,
    /// The main came back in another state than the backup's.
    Diverged,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    None,
    Play { from_seconds: f64 },
    Pause { at_seconds: f64 },
    Stop,
    FadeOutStop { duration_ms: u32 },
    SeekAbsolute { to_seconds: f64 },
    /// Micro-correction: a short relative seek (`SeekRelative`, with its
    /// 128-frame fade), inaudible because the backup is not on the PA.
    Nudge { delta_seconds: f64 },
    ScheduleJump(PendingJump),
    CancelJump,
    SetVamp(bool),
    /// Do nothing to the transport, and say why.
    Freewheel(FreewheelReason),
}

impl Action {
    pub fn is_correction(&self) -> bool {
        matches!(self, Action::Nudge { .. })
    }
}

/// The action and, when it came from an intent, that intent's `seq` (the
/// caller records it as applied once the action ran).
#[derive(Debug, Clone, PartialEq)]
pub struct Decision {
    pub action: Action,
    pub applied_intent: Option<u64>,
    /// Measured offset (main − backup − manual), seconds, when both play.
    pub offset_seconds: Option<f64>,
}

impl Decision {
    fn just(action: Action) -> Self {
        Self {
            action,
            applied_intent: None,
            offset_seconds: None,
        }
    }
}

/// Where the backup must RENDER now so that it SOUNDS where the main does
/// (plus the calibration).
fn target_render_seconds(now_ns: u64, main: &MainView, local: &LocalView) -> f64 {
    main.clock.audible_position_at(now_ns) - local.manual_offset_seconds
        + if main.clock.playing {
            local.clock.output_latency_seconds
        } else {
            0.0
        }
}

fn in_guard_window(now_ns: u64, local: &LocalView, policy: &Policy) -> bool {
    let guard = policy.guard_window_seconds;
    let position = local.clock.rendered_position_at(now_ns);
    if local
        .playing_since_ns
        .is_some_and(|since| elapsed_seconds(since, now_ns).abs() < guard)
    {
        return true;
    }
    if let Some(at) = local
        .pending_jump
        .as_ref()
        .and_then(|jump| jump.execute_at_seconds)
    {
        if (position - at).abs() < guard {
            return true;
        }
    }
    if let Some((start, end)) = local.region_bounds {
        if (position - start).abs() < guard || (position - end).abs() < guard {
            return true;
        }
    }
    false
}

fn diverged(main: &MainView, local: &LocalView) -> bool {
    main.clock.playing != local.clock.playing
        || (main.song_id.is_some() && local.song_id.is_some() && main.song_id != local.song_id)
}

fn intent_action(now_ns: u64, intent: &MainIntent, main: &MainView, local: &LocalView) -> Action {
    let latency = local.clock.output_latency_seconds - main.clock.output_latency_seconds;
    match intent {
        // Extrapolated: a play that arrives 8 ms late starts 8 ms further on.
        MainIntent::Play { from_seconds, at_ns } => Action::Play {
            from_seconds: from_seconds + elapsed_seconds(*at_ns, now_ns).max(0.0)
                - local.manual_offset_seconds
                + latency,
        },
        MainIntent::Pause { at_seconds } => Action::Pause {
            at_seconds: *at_seconds,
        },
        MainIntent::Stop => Action::Stop,
        MainIntent::FadeOutStop { duration_ms } => Action::FadeOutStop {
            duration_ms: *duration_ms,
        },
        MainIntent::Seek { to_seconds, at_ns } => Action::SeekAbsolute {
            to_seconds: if main.clock.playing {
                to_seconds + elapsed_seconds(*at_ns, now_ns).max(0.0)
                    - local.manual_offset_seconds
                    + latency
            } else {
                *to_seconds
            },
        },
        MainIntent::ScheduleJump(jump) => Action::ScheduleJump(jump.clone()),
        MainIntent::CancelJump => Action::CancelJump,
        // Idempotent: the resulting state, applied only if it differs.
        MainIntent::SetVamp(enabled) => {
            if *enabled == local.vamp {
                Action::None
            } else {
                Action::SetVamp(*enabled)
            }
        }
    }
}

pub fn reconcile(
    now_ns: u64,
    main: Option<&MainView>,
    local: &LocalView,
    policy: &Policy,
) -> Decision {
    // 1. Nothing, or nothing fresh, from the main: carry on as we are.
    let Some(main) = main else {
        return Decision::just(Action::Freewheel(FreewheelReason::NoData));
    };
    if elapsed_seconds(main.received_at_ns, now_ns) > policy.stale_after_seconds {
        return Decision::just(Action::Freewheel(FreewheelReason::Stale));
    }

    // 2. Back after being lost, but somewhere else: not ours to decide.
    if local.main_lost && diverged(main, local) {
        return Decision::just(Action::Freewheel(FreewheelReason::Diverged));
    }

    // 3. A new intent.
    if let Some((seq, intent)) = &main.last_intent {
        if *seq > local.last_applied_intent_seq {
            return Decision {
                action: intent_action(now_ns, intent, main, local),
                applied_intent: Some(*seq),
                offset_seconds: None,
            };
        }
    }

    // 4. Playing state or song differ: full resync.
    if main.clock.playing && !local.clock.playing {
        return Decision::just(Action::Play {
            from_seconds: target_render_seconds(now_ns, main, local),
        });
    }
    if !main.clock.playing && local.clock.playing {
        return Decision::just(Action::Pause {
            at_seconds: main.clock.position_seconds,
        });
    }
    if main.song_id.is_some() && local.song_id.is_some() && main.song_id != local.song_id {
        return Decision::just(Action::SeekAbsolute {
            to_seconds: target_render_seconds(now_ns, main, local),
        });
    }

    // 5. Pending jumps.
    match (&main.pending_jump, &local.pending_jump) {
        (Some(theirs), None) => return Decision::just(Action::ScheduleJump(theirs.clone())),
        (Some(theirs), Some(ours)) if !theirs.same_jump(ours) => {
            return Decision::just(Action::ScheduleJump(theirs.clone()))
        }
        (None, Some(ours)) => {
            // The main's jump fired and ours is about to: let it fire.
            let about_to_fire = ours.execute_at_seconds.is_some_and(|at| {
                (local.clock.rendered_position_at(now_ns) - at).abs()
                    < policy.guard_window_seconds
            });
            if !about_to_fire {
                return Decision::just(Action::CancelJump);
            }
        }
        _ => {}
    }

    // 6. Vamp.
    if main.vamp != local.vamp {
        return Decision::just(Action::SetVamp(main.vamp));
    }

    // 7. Offset.
    if !main.clock.playing {
        // Both stopped: only the parked position can differ.
        let delta = main.clock.position_seconds - local.clock.position_seconds;
        if delta.abs() > policy.correction_threshold_seconds {
            return Decision::just(Action::SeekAbsolute {
                to_seconds: main.clock.position_seconds,
            });
        }
        return Decision::just(Action::None);
    }
    let offset = main.clock.audible_position_at(now_ns)
        - local.clock.audible_position_at(now_ns)
        - local.manual_offset_seconds;
    let decision = |action| Decision {
        action,
        applied_intent: None,
        offset_seconds: Some(offset),
    };
    if offset.abs() > policy.hard_resync_threshold_seconds {
        return decision(Action::SeekAbsolute {
            to_seconds: target_render_seconds(now_ns, main, local),
        });
    }
    if offset.abs() > policy.correction_threshold_seconds && !in_guard_window(now_ns, local, policy)
    {
        let rested = local.last_correction_at_ns.is_none_or(|last| {
            elapsed_seconds(last, now_ns) >= policy.min_correction_interval_seconds
        });
        if rested {
            return decision(Action::Nudge {
                delta_seconds: offset,
            });
        }
    }
    decision(Action::None)
}

#[cfg(test)]
#[path = "reconciler_tests.rs"]
mod tests;
