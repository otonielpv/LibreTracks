//! Where the transport is SOUNDING at a given instant, from one stamp the
//! audio callback left (docs/plans/completed/redundancy/02-reloj-de-audio.md).
//!
//! Pure: the caller passes every instant, in nanoseconds of ONE local
//! monotonic base (whatever it is, as long as it is always the same). No
//! frames leave this module: positions are seconds at the stamp's rate, so
//! two machines running at different sample rates compare directly.

/// One reading of the engine's audio clock, already on the local base.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AudioClockSample {
    /// Transport seconds at the start of the stamped block (what was being
    /// RENDERED then, not what was heard).
    pub position_seconds: f64,
    /// Local monotonic ns at the start of that block.
    pub sampled_at_ns: u64,
    /// Playing and advancing (a paused, stopped or start-gated transport
    /// does not move).
    pub playing: bool,
    /// How long a rendered sample takes to be heard. 0 when unknown.
    pub output_latency_seconds: f64,
}

impl AudioClockSample {
    /// Build a sample from the engine's raw reading. `callback_age_ns` is
    /// how long before `now_ns` the block started (the engine measures it on
    /// its own clock, so no shared epoch is assumed).
    pub fn from_engine(
        frame: i64,
        sample_rate: u32,
        callback_age_ns: u64,
        now_ns: u64,
        playing: bool,
        output_latency_samples: u32,
    ) -> Option<Self> {
        if sample_rate == 0 {
            return None;
        }
        let rate = f64::from(sample_rate);
        Some(Self {
            position_seconds: frame as f64 / rate,
            sampled_at_ns: now_ns.saturating_sub(callback_age_ns),
            playing,
            output_latency_seconds: f64::from(output_latency_samples) / rate,
        })
    }

    /// Transport position being RENDERED at `at_ns`.
    pub fn rendered_position_at(&self, at_ns: u64) -> f64 {
        if !self.playing {
            return self.position_seconds;
        }
        self.position_seconds + elapsed_seconds(self.sampled_at_ns, at_ns)
    }

    /// Transport position being HEARD at `at_ns`: what was rendered one
    /// output latency earlier. Not clamped: right after a play it can be a
    /// little behind the stamp, which is exactly what is heard (nothing new
    /// yet). Stopped, it does not move and latency does not apply.
    pub fn audible_position_at(&self, at_ns: u64) -> f64 {
        if !self.playing {
            return self.position_seconds;
        }
        self.rendered_position_at(at_ns) - self.output_latency_seconds
    }
}

/// Signed seconds from `from_ns` to `to_ns` (negative if `to` is earlier).
pub fn elapsed_seconds(from_ns: u64, to_ns: u64) -> f64 {
    (to_ns as f64 - from_ns as f64) / 1e9
}

#[cfg(test)]
mod tests {
    use super::*;

    const MS: u64 = 1_000_000;

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    #[test]
    fn playing_advances_with_the_injected_clock() {
        // Frame 48 000 at 48 kHz = 1 s, stamped 5 ms before "now".
        let sample = AudioClockSample::from_engine(48_000, 48_000, 5 * MS, 1_000 * MS, true, 0)
            .unwrap();
        assert_eq!(sample.sampled_at_ns, 995 * MS);
        assert!(close(sample.audible_position_at(995 * MS), 1.0));
        assert!(close(sample.audible_position_at(1_000 * MS), 1.005));
        assert!(close(sample.audible_position_at(1_995 * MS), 2.0));
        // Before the stamp: extrapolates backwards, linearly.
        assert!(close(sample.audible_position_at(994 * MS), 0.999));
    }

    #[test]
    fn stopped_does_not_move_and_ignores_latency() {
        let sample =
            AudioClockSample::from_engine(96_000, 48_000, 0, 10 * MS, false, 480).unwrap();
        assert!(close(sample.audible_position_at(10 * MS), 2.0));
        assert!(close(sample.audible_position_at(10_000 * MS), 2.0));
    }

    #[test]
    fn latency_of_10_ms_is_heard_10_ms_later() {
        let sample = AudioClockSample::from_engine(48_000, 48_000, 0, 0, true, 480).unwrap();
        assert!(close(sample.output_latency_seconds, 0.010));
        assert!(close(sample.rendered_position_at(20 * MS), 1.020));
        assert!(close(sample.audible_position_at(20 * MS), 1.010));
        let no_latency = AudioClockSample::from_engine(48_000, 48_000, 0, 0, true, 0).unwrap();
        assert!(close(no_latency.audible_position_at(20 * MS), 1.020));
    }

    #[test]
    fn rate_44100_converts_frames_and_latency() {
        let sample = AudioClockSample::from_engine(44_100, 44_100, 0, 0, true, 441).unwrap();
        assert!(close(sample.position_seconds, 1.0));
        assert!(close(sample.output_latency_seconds, 0.010));
        assert!(close(sample.audible_position_at(100 * MS), 1.090));
        // Same timeline instant at 48 kHz gives the same seconds.
        let other = AudioClockSample::from_engine(48_000, 48_000, 0, 0, true, 480).unwrap();
        assert!(close(
            sample.audible_position_at(100 * MS),
            other.audible_position_at(100 * MS)
        ));
    }

    #[test]
    fn zero_rate_is_no_sample() {
        assert!(AudioClockSample::from_engine(1, 0, 0, 0, true, 0).is_none());
    }
}
