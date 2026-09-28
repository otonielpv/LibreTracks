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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SuspendAction {
    None,
    Suspend,
    Resume,
}

#[derive(Debug, Default)]
pub struct IdleSuspendPolicy {
    idle_since: Option<Instant>,
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
        if !backgrounded {
            self.idle_since = None;
            return if suspended {
                SuspendAction::Resume
            } else {
                SuspendAction::None
            };
        }
        if !idle {
            self.idle_since = None;
            return SuspendAction::None;
        }
        let since = *self.idle_since.get_or_insert(now);
        if !suspended && now.duration_since(since) >= IDLE_GRACE {
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
    fn an_already_suspended_stream_is_not_asked_again() {
        let t0 = Instant::now();
        let mut policy = IdleSuspendPolicy::default();
        policy.step(t0, true, true, false);
        assert_eq!(policy.step(at(t0, 90), true, true, true), SuspendAction::None);
    }
}
