//! When to ask the user to "Resume" audio after the app sat unused.
//!
//! An Android user left the app open from the rehearsal to the service; at
//! Play the playhead moved and nothing was heard until the app was restarted
//! (its output stream had been paused for idle power saving and came back
//! dead). Reopening the output device is what the restart fixed, so after a
//! long idle spell the UI offers it as a button. The same applies to every
//! platform: a laptop that slept through the gap, or a minimised window, can
//! come back to an endpoint that is no longer there.
//!
//! The rule: the app was away (in the background, minimised or hidden) or the
//! machine slept, for [`WAKE_PROMPT_AFTER`] or more, with nothing sounding the
//! whole time. Anything audible in between (Play from a MIDI pedal with the
//! screen off, the pad) means the app was in use, and resets it.
//!
//! Measured on the wall clock, not `Instant`: whether a monotonic clock keeps
//! counting through a system sleep depends on the platform, and the sleep is
//! precisely what has to count.

use std::time::{Duration, SystemTime};

/// Long enough that glancing at another app, or a short break, costs nothing.
pub const WAKE_PROMPT_AFTER: Duration = Duration::from_secs(5 * 60);

#[derive(Debug, Default)]
pub struct WakePromptPolicy {
    /// Wall time of the previous step. A step long after it means the process
    /// did not run in between: the machine slept.
    last_step: Option<SystemTime>,
    /// When the app was last seen leaving the screen while idle.
    away_since: Option<SystemTime>,
}

impl WakePromptPolicy {
    /// `away`: the app is not on screen. `idle`: transport not playing (nor
    /// about to) and the pad off. Returns true once, on the step where the
    /// user is back after a long idle spell.
    pub fn step(&mut self, now: SystemTime, away: bool, idle: bool) -> bool {
        let previous = self.last_step.replace(now);
        if !idle {
            self.away_since = None;
            return false;
        }
        if away {
            // From the previous step: the machine may have slept right after
            // the app left the screen, before any step saw it away.
            self.away_since.get_or_insert(previous.unwrap_or(now));
            return false;
        }
        // On screen and idle. Back from being away, or from a sleep that
        // happened with the app on screen (a gap since the previous step).
        let since = self.away_since.take().or(previous);
        since
            .and_then(|at| now.duration_since(at).ok())
            .is_some_and(|elapsed| elapsed >= WAKE_PROMPT_AFTER)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(start: SystemTime, secs: u64) -> SystemTime {
        start + Duration::from_secs(secs)
    }

    /// Steps once a second from `from` to `to` (inclusive), returning whether
    /// any of them asked for the prompt.
    fn run(
        policy: &mut WakePromptPolicy,
        t0: SystemTime,
        from: u64,
        to: u64,
        away: bool,
        idle: bool,
    ) -> bool {
        (from..=to).fold(false, |prompted, secs| {
            policy.step(at(t0, secs), away, idle) || prompted
        })
    }

    #[test]
    fn using_the_app_on_screen_never_prompts() {
        let t0 = SystemTime::now();
        let mut policy = WakePromptPolicy::default();
        assert!(!run(&mut policy, t0, 0, 3600, false, true));
    }

    #[test]
    fn back_after_a_long_spell_away_prompts_once() {
        let t0 = SystemTime::now();
        let mut policy = WakePromptPolicy::default();
        run(&mut policy, t0, 0, 10, false, true);
        assert!(!run(&mut policy, t0, 11, 11 + WAKE_PROMPT_AFTER.as_secs(), true, true));
        let back = 12 + WAKE_PROMPT_AFTER.as_secs();
        assert!(policy.step(at(t0, back), false, true));
        assert!(!run(&mut policy, t0, back + 1, back + 60, false, true));
    }

    #[test]
    fn a_short_spell_away_does_not_prompt() {
        let t0 = SystemTime::now();
        let mut policy = WakePromptPolicy::default();
        run(&mut policy, t0, 0, 10, false, true);
        run(&mut policy, t0, 11, 120, true, true);
        assert!(!policy.step(at(t0, 121), false, true));
    }

    #[test]
    fn a_sleep_with_the_app_on_screen_prompts() {
        // A laptop with the app open, lid closed through the gap.
        let t0 = SystemTime::now();
        let mut policy = WakePromptPolicy::default();
        run(&mut policy, t0, 0, 10, false, true);
        assert!(policy.step(at(t0, 10 + 3 * 3600), false, true));
    }

    #[test]
    fn a_sleep_right_after_leaving_the_screen_counts_from_the_last_step() {
        let t0 = SystemTime::now();
        let mut policy = WakePromptPolicy::default();
        run(&mut policy, t0, 0, 10, false, true);
        // The first step that sees the app away comes after the sleep.
        policy.step(at(t0, 3600), true, true);
        assert!(policy.step(at(t0, 3601), false, true));
    }

    #[test]
    fn anything_sounding_while_away_means_the_app_was_in_use() {
        // A MIDI pedal played a song with the screen off.
        let t0 = SystemTime::now();
        let mut policy = WakePromptPolicy::default();
        run(&mut policy, t0, 0, 600, true, true);
        run(&mut policy, t0, 601, 900, true, false);
        run(&mut policy, t0, 901, 960, true, true);
        assert!(!policy.step(at(t0, 961), false, true));
    }

    #[test]
    fn a_long_sleep_while_playing_does_not_prompt() {
        let t0 = SystemTime::now();
        let mut policy = WakePromptPolicy::default();
        run(&mut policy, t0, 0, 10, false, false);
        assert!(!policy.step(at(t0, 3600), false, false));
    }
}
