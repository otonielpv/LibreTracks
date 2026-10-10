//! Following another device's clock over a network.
//!
//! Used by network-session guests to place the host's playhead (lyrics must
//! scroll in time with the host's audio) and, later, by the remote video
//! receiver (docs/plans/video-mobile/12). Pure: times come in as numbers, so
//! skew, drift and jitter are tested with simulated clocks.
//!
//! NTP-style sample: the guest sends at `t0` (its clock), the host receives at
//! `t1` and answers at `t2` (host clock), the guest receives at `t3`.
//!
//! - round trip  = (t3 − t0) − (t2 − t1)
//! - offset      = ((t1 − t0) + (t2 − t3)) / 2      (host − guest)
//!
//! The offset is exact when both legs take the same time; the error is half
//! the asymmetry of the two legs, which is never more than half the round
//! trip. So the estimator keeps the sample with the SMALLEST round trip among
//! the recent ones: its error bound is the tightest. Recent, because the two
//! clocks drift apart (crystals differ by tens of ppm) and an old sample's
//! offset goes stale.

use std::collections::VecDeque;

/// How often a follower samples the clock. A ping is a few dozen bytes, so
/// four a second cost nothing, even with a dozen guests on one host.
pub const CLOCK_PING_INTERVAL_MS: u64 = 250;

/// Samples kept: 12 s at `CLOCK_PING_INTERVAL_MS`. Each leg needs many
/// samples for one of them to catch a quiet moment of the network (with
/// 0–20 ms of jitter per leg, 16 samples still left ~4 ms of error), and the
/// window must stay short because 50 ppm of drift moves the offset 0.6 ms
/// across 12 s. Measured by simulation: worst error 1.35 ms over 120 runs.
pub const CLOCK_WINDOW: usize = 48;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ClockSample {
    pub t0: f64,
    pub t1: f64,
    pub t2: f64,
    pub t3: f64,
}

impl ClockSample {
    pub fn round_trip(&self) -> f64 {
        ((self.t3 - self.t0) - (self.t2 - self.t1)).max(0.0)
    }

    pub fn offset(&self) -> f64 {
        ((self.t1 - self.t0) + (self.t2 - self.t3)) / 2.0
    }
}

#[derive(Debug, Clone)]
pub struct ClockEstimator {
    window: VecDeque<ClockSample>,
    capacity: usize,
}

impl Default for ClockEstimator {
    fn default() -> Self {
        Self::with_capacity(CLOCK_WINDOW)
    }
}

impl ClockEstimator {
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            window: VecDeque::with_capacity(capacity.max(1)),
            capacity: capacity.max(1),
        }
    }

    /// Add a sample. Nonsense (the reply arriving before the request left)
    /// is dropped.
    pub fn add(&mut self, sample: ClockSample) {
        if sample.t3 < sample.t0 || sample.t2 < sample.t1 {
            return;
        }
        if self.window.len() == self.capacity {
            self.window.pop_front();
        }
        self.window.push_back(sample);
    }

    pub fn reset(&mut self) {
        self.window.clear();
    }

    fn best(&self) -> Option<&ClockSample> {
        self.window
            .iter()
            .min_by(|a, b| a.round_trip().total_cmp(&b.round_trip()))
    }

    /// host_clock − guest_clock, in the samples' unit.
    ///
    /// Each leg is filtered on its own: `t1 − t0` is offset + forward delay
    /// and `t3 − t2` is back delay − offset, so the minimum of each over the
    /// window is the offset plus (or minus) the quickest delay ever seen in
    /// that direction. Halving their difference leaves only the difference
    /// between the two quickest delays, which on a LAN is tiny, instead of
    /// the asymmetry of whichever single exchange happened to be quickest.
    pub fn offset(&self) -> Option<f64> {
        let forward = self
            .window
            .iter()
            .map(|sample| sample.t1 - sample.t0)
            .min_by(f64::total_cmp)?;
        let back = self
            .window
            .iter()
            .map(|sample| sample.t3 - sample.t2)
            .min_by(f64::total_cmp)?;
        Some((forward - back) / 2.0)
    }

    /// Round trip of the best sample: the latency worth showing.
    pub fn round_trip(&self) -> Option<f64> {
        self.best().map(ClockSample::round_trip)
    }

    pub fn host_time(&self, guest_now: f64) -> Option<f64> {
        self.offset().map(|offset| guest_now + offset)
    }
}

/// Where the host's playhead is now, in seconds.
///
/// `anchor_seconds` is the position when the host took its snapshot, at
/// `host_instant_ms` on the host clock. `offset_ms` is host − guest. A stopped
/// transport does not move; time never runs backwards past the anchor (a
/// snapshot that looks like it comes from the future is just early).
pub fn extrapolate_position(
    anchor_seconds: f64,
    host_instant_ms: f64,
    rate: f64,
    running: bool,
    guest_now_ms: f64,
    offset_ms: f64,
) -> f64 {
    if !running {
        return anchor_seconds;
    }
    let host_now_ms = guest_now_ms + offset_ms;
    let elapsed_seconds = ((host_now_ms - host_instant_ms) / 1000.0).max(0.0);
    anchor_seconds + elapsed_seconds * rate
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deterministic pseudo-random numbers in [0, 1): the test must not
    /// depend on luck, and a failure must replay identically.
    struct Lcg(u64);

    impl Lcg {
        fn next(&mut self) -> f64 {
            self.0 = self
                .0
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (self.0 >> 11) as f64 / (1u64 << 53) as f64
        }
    }

    /// The host clock as a function of true time: skewed and drifting.
    fn host_clock(true_ms: f64, skew_ms: f64, drift_ppm: f64) -> f64 {
        true_ms * (1.0 + drift_ppm / 1e6) + skew_ms
    }

    /// Runs a minute of pings, one every `CLOCK_PING_INTERVAL_MS` with each leg taking
    /// `base + jitter` ms, and returns the worst error of the estimated host
    /// time once the window has filled.
    fn worst_error(skew_ms: f64, drift_ppm: f64, base_ms: f64, jitter_ms: f64, seed: u64) -> f64 {
        let mut rng = Lcg(seed);
        let mut estimator = ClockEstimator::default();
        let mut worst: f64 = 0.0;
        for ping in 0..240 {
            let true_send = ping as f64 * CLOCK_PING_INTERVAL_MS as f64;
            let forward = base_ms + rng.next() * jitter_ms;
            let back = base_ms + rng.next() * jitter_ms;
            let host_processing = 0.2;
            let t0 = true_send; // guest clock = true time
            let t1 = host_clock(true_send + forward, skew_ms, drift_ppm);
            let t2 = host_clock(true_send + forward + host_processing, skew_ms, drift_ppm);
            let t3 = true_send + forward + host_processing + back;
            estimator.add(ClockSample { t0, t1, t2, t3 });

            if ping >= CLOCK_WINDOW {
                let guest_now = t3 + 5.0;
                let truth = host_clock(guest_now, skew_ms, drift_ppm);
                let estimate = estimator.host_time(guest_now).unwrap();
                worst = worst.max((estimate - truth).abs());
            }
        }
        worst
    }

    #[test]
    fn symmetric_network_gives_the_exact_offset() {
        let sample = ClockSample {
            t0: 100.0,
            t1: 3110.0,
            t2: 3111.0,
            t3: 121.0,
        };
        assert_eq!(sample.round_trip(), 20.0);
        assert_eq!(sample.offset(), 3000.0);
    }

    #[test]
    fn converges_under_two_ms_with_skew_drift_and_jitter() {
        // 3 s of skew, ±50 ppm of drift, legs of 1 ms + 0–20 ms of jitter
        // each: a busy but ordinary Wi-Fi. Several seeds so one lucky run
        // cannot pass the test.
        for seed in 1..=20 {
            for drift in [-50.0, 50.0] {
                let error = worst_error(3000.0, drift, 1.0, 20.0, seed);
                assert!(error < 2.0, "seed {seed} drift {drift}: {error} ms");
            }
        }
    }

    #[test]
    fn a_single_bad_sample_does_not_move_the_estimate() {
        let mut estimator = ClockEstimator::default();
        estimator.add(ClockSample {
            t0: 0.0,
            t1: 1002.0,
            t2: 1002.0,
            t3: 4.0,
        }); // 2 ms each way, offset 1000
        estimator.add(ClockSample {
            t0: 10.0,
            t1: 1110.0,
            t2: 1110.0,
            t3: 115.0,
        }); // same offset, but a 100 ms spike on the way there: alone it
            // would say 1047.5
        assert_eq!(estimator.offset(), Some(1000.0));
        assert_eq!(estimator.round_trip(), Some(4.0));
        let spike = ClockSample {
            t0: 10.0,
            t1: 1110.0,
            t2: 1110.0,
            t3: 115.0,
        };
        assert_eq!(spike.offset(), 1047.5);
    }

    #[test]
    fn old_samples_leave_the_window() {
        let mut estimator = ClockEstimator::with_capacity(2);
        estimator.add(ClockSample {
            t0: 0.0,
            t1: 500.0,
            t2: 500.0,
            t3: 0.0,
        }); // rtt 0, offset 500
        for i in 1..=2 {
            let t = i as f64 * 1000.0;
            estimator.add(ClockSample {
                t0: t,
                t1: t + 705.0,
                t2: t + 705.0,
                t3: t + 10.0,
            }); // rtt 10, offset 700
        }
        assert_eq!(estimator.offset(), Some(700.0));
    }

    #[test]
    fn impossible_samples_are_ignored() {
        let mut estimator = ClockEstimator::default();
        estimator.add(ClockSample {
            t0: 10.0,
            t1: 0.0,
            t2: 0.0,
            t3: 5.0,
        });
        assert_eq!(estimator.offset(), None);
    }

    #[test]
    fn extrapolation_follows_the_rate_and_respects_stops() {
        // Host took the snapshot at host-ms 10_000 with the song at 12 s;
        // guest clock is 3_000 ms behind.
        let position = extrapolate_position(12.0, 10_000.0, 1.0, true, 7_500.0, 3_000.0);
        assert!((position - 12.5).abs() < 1e-9);
        let half = extrapolate_position(12.0, 10_000.0, 0.5, true, 9_000.0, 3_000.0);
        assert!((half - 13.0).abs() < 1e-9);
        let stopped = extrapolate_position(12.0, 10_000.0, 1.0, false, 99_000.0, 0.0);
        assert_eq!(stopped, 12.0);
    }

    #[test]
    fn extrapolation_never_goes_behind_the_anchor() {
        let position = extrapolate_position(12.0, 10_000.0, 1.0, true, 6_000.0, 3_000.0);
        assert_eq!(position, 12.0);
    }
}
