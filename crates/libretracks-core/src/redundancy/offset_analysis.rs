//! How many milliseconds separate what the main and the backup put on the
//! wire (docs/plans/redundancy/11-medir-y-calibrar.md): a stereo recording,
//! main on the left, backup on the right, cut in 1 s windows; each window's
//! lag by cross-correlation with parabolic interpolation (sub-sample).
//! Windows without signal (silence, or a weak correlation) are skipped.
//!
//! Pure: samples in, numbers out. The WAV reader is the
//! `redundancy_offset` example of `libretracks-project`.

/// One analysed window.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WindowOffset {
    /// Window start, seconds into the recording.
    pub at_seconds: f64,
    /// Right (backup) minus left (main): positive = the backup is LATE.
    pub offset_ms: f64,
    /// Normalised correlation at the peak, 0-1.
    pub correlation: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct OffsetSummary {
    pub windows: usize,
    pub skipped: usize,
    pub p50_ms: f64,
    pub p95_ms: f64,
    pub max_ms: f64,
    /// Median signed offset: the constant bias to calibrate away.
    pub bias_ms: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AnalysisOptions {
    pub window_seconds: f64,
    /// Largest lag searched either way.
    pub max_lag_ms: f64,
    /// Below this the window is silence / noise.
    pub min_correlation: f64,
    /// RMS under this (linear) = silence.
    pub min_rms: f64,
}

impl Default for AnalysisOptions {
    fn default() -> Self {
        Self {
            window_seconds: 1.0,
            max_lag_ms: 50.0,
            min_correlation: 0.5,
            min_rms: 1e-4,
        }
    }
}

fn rms(samples: &[f32]) -> f64 {
    if samples.is_empty() {
        return 0.0;
    }
    (samples.iter().map(|s| f64::from(*s) * f64::from(*s)).sum::<f64>() / samples.len() as f64)
        .sqrt()
}

/// Normalised correlation of `left[max_lag..max_lag+span]` against `right`
/// shifted by `lag` (0..=2*max_lag; `max_lag` = no shift).
fn correlation_at(left: &[f32], right: &[f32], max_lag: usize, span: usize, lag: usize) -> f64 {
    let reference = &left[max_lag..max_lag + span];
    let candidate = &right[lag..lag + span];
    let (mut dot, mut energy_ref, mut energy) = (0.0f64, 0.0f64, 0.0f64);
    for (a, b) in reference.iter().zip(candidate) {
        let (a, b) = (f64::from(*a), f64::from(*b));
        dot += a * b;
        energy_ref += a * a;
        energy += b * b;
    }
    let norm = (energy_ref * energy).sqrt();
    if norm > 0.0 {
        dot / norm
    } else {
        0.0
    }
}

/// |x| averaged over blocks of `factor` samples: a cheap envelope for the
/// coarse search.
fn envelope(samples: &[f32], factor: usize) -> Vec<f32> {
    samples
        .chunks(factor)
        .map(|chunk| chunk.iter().map(|s| s.abs()).sum::<f32>() / chunk.len() as f32)
        .collect()
}

const COARSE_FACTOR: usize = 8;
const FINE_RADIUS: usize = 2 * COARSE_FACTOR;

/// Lag (in samples, right relative to left) of one window, with its
/// normalised correlation. None when silent or uncorrelated. Two stages: the
/// envelopes (decimated by 8) find the neighbourhood over the whole lag
/// range, then the full-rate signal is correlated only around it.
fn window_lag(left: &[f32], right: &[f32], max_lag: usize, options: &AnalysisOptions) -> Option<(f64, f64)> {
    if rms(left) < options.min_rms || rms(right) < options.min_rms {
        return None;
    }
    let n = left.len().min(right.len());
    if n <= 2 * max_lag + 3 {
        return None;
    }
    let span = n - 2 * max_lag;

    // Coarse.
    let (env_left, env_right) = (envelope(left, COARSE_FACTOR), envelope(right, COARSE_FACTOR));
    let coarse_lag = max_lag / COARSE_FACTOR;
    let coarse_span = span / COARSE_FACTOR;
    let coarse_center = (0..=2 * coarse_lag)
        .map(|lag| (lag, correlation_at(&env_left, &env_right, coarse_lag, coarse_span, lag)))
        .max_by(|a, b| a.1.total_cmp(&b.1))?
        .0;
    let center = (coarse_center * COARSE_FACTOR) as isize;

    // Fine, at full rate.
    let low = (center - FINE_RADIUS as isize).max(0) as usize;
    let high = ((center + FINE_RADIUS as isize) as usize).min(2 * max_lag);
    let scores: Vec<(usize, f64)> = (low..=high)
        .map(|lag| (lag, correlation_at(left, right, max_lag, span, lag)))
        .collect();
    let (index, &(best, peak)) = scores
        .iter()
        .enumerate()
        .max_by(|a, b| a.1 .1.total_cmp(&b.1 .1))?;
    if peak < options.min_correlation {
        return None;
    }
    // Parabolic interpolation around the peak.
    let refine = if index > 0 && index + 1 < scores.len() {
        let (y0, y1, y2) = (scores[index - 1].1, peak, scores[index + 1].1);
        let denominator = y0 - 2.0 * y1 + y2;
        if denominator.abs() > f64::EPSILON {
            0.5 * (y0 - y2) / denominator
        } else {
            0.0
        }
    } else {
        0.0
    };
    Some((best as f64 + refine - max_lag as f64, peak))
}

/// Every window's offset; skipped windows are counted in the summary.
pub fn analyse(
    left: &[f32],
    right: &[f32],
    sample_rate: u32,
    options: &AnalysisOptions,
) -> (Vec<WindowOffset>, usize) {
    let rate = f64::from(sample_rate.max(1));
    let window = ((options.window_seconds * rate) as usize).max(1);
    let max_lag = (options.max_lag_ms / 1000.0 * rate).ceil() as usize;
    let length = left.len().min(right.len());
    let mut results = Vec::new();
    let mut skipped = 0;
    let mut start = 0;
    while start + window <= length {
        match window_lag(
            &left[start..start + window],
            &right[start..start + window],
            max_lag,
            options,
        ) {
            Some((lag, correlation)) => results.push(WindowOffset {
                at_seconds: start as f64 / rate,
                offset_ms: lag / rate * 1000.0,
                correlation,
            }),
            None => skipped += 1,
        }
        start += window;
    }
    (results, skipped)
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return f64::NAN;
    }
    sorted[((sorted.len() as f64 - 1.0) * p).round() as usize]
}

pub fn summarise(windows: &[WindowOffset], skipped: usize) -> OffsetSummary {
    let mut magnitudes: Vec<f64> = windows.iter().map(|w| w.offset_ms.abs()).collect();
    magnitudes.sort_by(f64::total_cmp);
    let mut signed: Vec<f64> = windows.iter().map(|w| w.offset_ms).collect();
    signed.sort_by(f64::total_cmp);
    OffsetSummary {
        windows: windows.len(),
        skipped,
        p50_ms: percentile(&magnitudes, 0.50),
        p95_ms: percentile(&magnitudes, 0.95),
        max_ms: magnitudes.last().copied().unwrap_or(f64::NAN),
        bias_ms: percentile(&signed, 0.50),
    }
}

/// `t,offset_ms,correlation` lines.
pub fn to_csv(windows: &[WindowOffset]) -> String {
    let mut csv = String::from("t,offset_ms,correlation\n");
    for window in windows {
        csv.push_str(&format!(
            "{:.3},{:.4},{:.4}\n",
            window.at_seconds, window.offset_ms, window.correlation
        ));
    }
    csv
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: u32 = 48_000;

    /// Deterministic noise.
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> f32 {
            self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((self.0 >> 40) as f32 / (1u64 << 24) as f32) * 2.0 - 1.0
        }
    }

    /// A clicky signal (decaying bursts every 250 ms over band-limited noise)
    /// evaluated at any time, so a fractional delay is exact.
    fn signal(t: f64) -> f32 {
        let beat = t.rem_euclid(0.25);
        let click = (-beat * 60.0).exp() * (2.0 * std::f64::consts::PI * 1500.0 * t).sin();
        let bed = 0.2 * (2.0 * std::f64::consts::PI * 233.0 * t).sin()
            + 0.15 * (2.0 * std::f64::consts::PI * 517.0 * t + 0.7).sin();
        (0.6 * click + bed) as f32
    }

    /// `seconds` of stereo: right = left delayed by `offset_ms`, plus noise;
    /// the second `silent_from..` is silence on both.
    fn recording(offset_ms: f64, seconds: f64, silent_from: Option<f64>) -> (Vec<f32>, Vec<f32>) {
        let mut rng = Rng(42);
        let frames = (seconds * f64::from(RATE)) as usize;
        let mut left = Vec::with_capacity(frames);
        let mut right = Vec::with_capacity(frames);
        for i in 0..frames {
            let t = i as f64 / f64::from(RATE);
            if silent_from.is_some_and(|from| t >= from) {
                left.push(0.0);
                right.push(0.0);
                continue;
            }
            left.push(signal(t) + 0.01 * rng.next());
            right.push(signal(t - offset_ms / 1000.0) + 0.01 * rng.next());
        }
        (left, right)
    }

    #[test]
    fn recovers_known_offsets_within_five_hundredths_of_a_millisecond() {
        for offset in [-10.0, -2.35, 0.0, 0.4, 7.0] {
            let (left, right) = recording(offset, 4.0, None);
            let (windows, skipped) = analyse(&left, &right, RATE, &AnalysisOptions::default());
            assert_eq!(skipped, 0);
            assert_eq!(windows.len(), 4);
            for window in &windows {
                assert!(
                    (window.offset_ms - offset).abs() < 0.05,
                    "wanted {offset} ms, got {:.4} ms",
                    window.offset_ms
                );
            }
            let summary = summarise(&windows, skipped);
            assert!((summary.bias_ms - offset).abs() < 0.05);
        }
    }

    #[test]
    fn silent_windows_are_skipped() {
        let (left, right) = recording(1.5, 5.0, Some(3.0));
        let (windows, skipped) = analyse(&left, &right, RATE, &AnalysisOptions::default());
        assert_eq!(windows.len(), 3);
        assert_eq!(skipped, 2);
        assert!(to_csv(&windows).starts_with("t,offset_ms,correlation\n0.000,1.5"));
    }
}
