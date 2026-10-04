//! When to pause the output stream of an idle app in the background.
//!
//! A running AAudio stream keeps Android's `AudioMix` wakelock held, so the
//! phone can never sleep while LibreTracks lives — and the foreground service
//! keeps it living on purpose, so a MIDI pedal still works with the screen off.
//! Measured on an Oppo A5 with a session open and the transport stopped: the
//! wakelock stayed held for as long as the app ran
//! (docs/internal/PLAY_CLOSED_TESTING_LOG.md, entry 22).
//!
//! The rule: in the background, with the transport stopped and the pad off
//! for [`IDLE_GRACE`], ask the engine to suspend the stream. Back in the
//! foreground, resume it. Everything that has to be heard (Play from any
//! source, enabling the pad) restarts the stream inside the engine itself, so
//! this policy never has to race a pedal press.

use std::time::{Duration, Instant};

/// How long the app has to sit idle in the background before its stream is
/// suspended. Long enough that glancing at another app mid-set costs nothing.
pub const IDLE_GRACE: Duration = Duration::from_secs(30);

/// A stream suspended this long is not trusted to come back by itself: one
/// paused through a whole gap between rehearsal and service resumed silent
/// (playhead moving, nothing heard) until the app was restarted. Back in the
/// foreground after a suspension this long, the user is asked to resume,
/// which reopens the device from scratch.
pub const WAKE_PROMPT_AFTER: Duration = Duration::from_secs(5 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SuspendAction {
    None,
    Suspend,
    Resume,
    /// Resume, and the stream sat suspended for [`WAKE_PROMPT_AFTER`] or more.
    ResumeAfterLongIdle,
}

#[derive(Debug, Default)]
pub struct IdleSuspendPolicy {
    idle_since: Option<Instant>,
    suspended_at: Option<Instant>,
}

impl IdleSuspendPolicy {
    /// `idle`: transport not playing (nor about to) and the pad off.
    /// `suspended`: what the engine's snapshot reports right now.
    pub fn step(
        &mut self,
        now: Instant,
        backgrounded: bool,
        idle: bool,
        suspended: bool,
    ) -> SuspendAction {
        if !suspended {
            // Never suspended, refused, or resumed by the engine itself (a
            // pedal's Play with the screen off): nothing long to report.
            self.suspended_at = None;
        }
        if !backgrounded {
            self.idle_since = None;
            if !suspended {
                return SuspendAction::None;
            }
            let long = self
                .suspended_at
                .take()
                .is_some_and(|at| now.duration_since(at) >= WAKE_PROMPT_AFTER);
            return if long {
                SuspendAction::ResumeAfterLongIdle
            } else {
                SuspendAction::Resume
            };
        }
        if !idle {
            self.idle_since = None;
            return SuspendAction::None;
        }
        let since = *self.idle_since.get_or_insert(now);
        if !suspended && now.duration_since(since) >= IDLE_GRACE {
            self.suspended_at = Some(now);
            SuspendAction::Suspend
        } else {
            SuspendAction::None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(start: Instant, secs: u64) -> Instant {
        start + Duration::from_secs(secs)
    }

    #[test]
    fn an_idle_app_in_the_background_is_suspended_after_the_grace() {
        let t0 = Instant::now();
        let mut policy = IdleSuspendPolicy::default();
        assert_eq!(policy.step(t0, true, true, false), SuspendAction::None);
        assert_eq!(policy.step(at(t0, 29), true, true, false), SuspendAction::None);
        assert_eq!(policy.step(at(t0, 30), true, true, false), SuspendAction::Suspend);
    }

    #[test]
    fn the_foreground_never_suspends_and_resumes_a_suspended_stream() {
        let t0 = Instant::now();
        let mut policy = IdleSuspendPolicy::default();
        assert_eq!(policy.step(at(t0, 600), false, true, false), SuspendAction::None);
        assert_eq!(policy.step(at(t0, 601), false, true, true), SuspendAction::Resume);
    }

    #[test]
    fn playing_or_a_sounding_pad_in_the_background_keeps_the_stream() {
        let t0 = Instant::now();
        let mut policy = IdleSuspendPolicy::default();
        for secs in 0..120 {
            assert_eq!(policy.step(at(t0, secs), true, false, false), SuspendAction::None);
        }
    }

    #[test]
    fn activity_restarts_the_grace() {
        let t0 = Instant::now();
        let mut policy = IdleSuspendPolicy::default();
        policy.step(t0, true, true, false);
        // A song played for a while, then stopped again at t0+25.
        policy.step(at(t0, 20), true, false, false);
        assert_eq!(policy.step(at(t0, 25), true, true, false), SuspendAction::None);
        assert_eq!(policy.step(at(t0, 54), true, true, false), SuspendAction::None);
        assert_eq!(policy.step(at(t0, 55), true, true, false), SuspendAction::Suspend);
    }

    #[test]
    fn returning_to_the_foreground_restarts_the_grace() {
        let t0 = Instant::now();
        let mut policy = IdleSuspendPolicy::default();
        policy.step(t0, true, true, false);
        policy.step(at(t0, 20), false, true, false);
        assert_eq!(policy.step(at(t0, 40), true, true, false), SuspendAction::None);
        assert_eq!(policy.step(at(t0, 70), true, true, false), SuspendAction::Suspend);
    }

    #[test]
    fn a_short_suspension_resumes_without_a_prompt() {
        let t0 = Instant::now();
        let mut policy = IdleSuspendPolicy::default();
        policy.step(t0, true, true, false);
        assert_eq!(policy.step(at(t0, 30), true, true, false), SuspendAction::Suspend);
        policy.step(at(t0, 31), true, true, true);
        assert_eq!(policy.step(at(t0, 120), false, true, true), SuspendAction::Resume);
    }

    #[test]
    fn a_long_suspension_asks_to_resume_once() {
        let t0 = Instant::now();
        let mut policy = IdleSuspendPolicy::default();
        policy.step(t0, true, true, false);
        assert_eq!(policy.step(at(t0, 30), true, true, false), SuspendAction::Suspend);
        let back = 30 + WAKE_PROMPT_AFTER.as_secs();
        policy.step(at(t0, back - 1), true, true, true);
        assert_eq!(
            policy.step(at(t0, back), false, true, true),
            SuspendAction::ResumeAfterLongIdle
        );
        // The resume command may take a tick to land in the snapshot: the
        // prompt must not fire twice for the same suspension.
        assert_eq!(policy.step(at(t0, back + 1), false, true, true), SuspendAction::Resume);
    }

    #[test]
    fn a_stream_the_engine_resumed_itself_does_not_prompt() {
        let t0 = Instant::now();
        let mut policy = IdleSuspendPolicy::default();
        policy.step(t0, true, true, false);
        policy.step(at(t0, 30), true, true, false);
        // A MIDI pedal pressed Play with the screen off: the engine restarted
        // the stream, the transport played and stopped, and the app idled
        // into a second, short suspension.
        policy.step(at(t0, 400), true, false, false);
        policy.step(at(t0, 500), true, true, false);
        assert_eq!(policy.step(at(t0, 530), true, true, false), SuspendAction::Suspend);
        assert_eq!(policy.step(at(t0, 560), false, true, true), SuspendAction::Resume);
    }

    #[test]
    fn an_already_suspended_stream_is_not_asked_again() {
        let t0 = Instant::now();
        let mut policy = IdleSuspendPolicy::default();
        policy.step(t0, true, true, false);
        assert_eq!(policy.step(at(t0, 90), true, true, true), SuspendAction::None);
    }
}
