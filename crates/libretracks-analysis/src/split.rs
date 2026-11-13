//! Click and speech that share one signal (plan channel-split, step 06).
//!
//! A single file with the multitrack panned to one side and the click plus the
//! spoken guide on the other leaves both on the same track. Analysed as is,
//! each spoils the other: the click never leaves the silence `analyze_guide`
//! splits announcements on, so the whole song is one announcement, and every
//! word is an onset off the click's grid for `analyze_click`.
//!
//! The two are told apart by how long they sound: a click is a burst of a few
//! tens of milliseconds, a word is longer. The active stretches of the signal
//! (above a threshold relative to its own floor and peak, not a fixed level:
//! other material comes at another level) shorter than [`MAX_CLICK_SECONDS`]
//! are the click; the rest is speech. A click that falls inside a word stays
//! with the word: the click analysis already tolerates the gap (`ClickGap`).

/// Envelope resolution: fine enough to see a click start and end.
const BLOCK_SECONDS: f64 = 0.002;
/// Longest active stretch still taken for a click. Real clicks measured
/// 22 ms (p90) to 24 ms (p95); a click with a 60 ms tail must still fit.
const MAX_CLICK_SECONDS: f64 = 0.08;
/// Dips shorter than this inside an active stretch do not end it: a word's
/// quiet instants between syllables, a click's ring crossing the threshold.
const BRIDGE_SECONDS: f64 = 0.012;
/// Above the noise floor by at least this much…
const FLOOR_MARGIN_DB: f64 = 15.0;
/// …and within this much of the loudest instant.
const PEAK_RANGE_DB: f64 = 40.0;
/// Extra room around each click: its first instant before the envelope rises
/// and its last ring after it falls.
const CLICK_MARGIN_SECONDS: f64 = 0.004;
/// Fade in and out of each gap cut in the speech, so the recogniser hears no
/// clicks of its own at the cuts.
const FADE_SECONDS: f64 = 0.002;

#[derive(Debug, Clone, PartialEq)]
pub struct SplitSignals {
    /// Only the click: silence everywhere else.
    pub click: Vec<f32>,
    /// Everything but the click.
    pub speech: Vec<f32>,
}

/// Split a signal that carries a click and a spoken guide into the two.
/// Both outputs have the input's length and rate.
pub fn split_click_and_speech(samples: &[f32], sample_rate: u32) -> SplitSignals {
    let rate = f64::from(sample_rate.max(1));
    let block = ((BLOCK_SECONDS * rate).round() as usize).max(1);
    let levels: Vec<f64> = samples
        .chunks(block)
        .map(|chunk| {
            let peak = chunk.iter().fold(0.0_f32, |max, x| max.max(x.abs()));
            20.0 * f64::from(peak.max(1.0e-9)).log10()
        })
        .collect();
    let silent = SplitSignals {
        click: vec![0.0; samples.len()],
        speech: vec![0.0; samples.len()],
    };
    if levels.is_empty() {
        return silent;
    }
    let mut sorted = levels.clone();
    sorted.sort_by(f64::total_cmp);
    let floor = sorted[(sorted.len() - 1) / 5];
    let peak = sorted[sorted.len() - 1];
    if peak < -80.0 {
        return silent;
    }
    let threshold = (floor + FLOOR_MARGIN_DB).max(peak - PEAK_RANGE_DB);

    let blocks_for = |seconds: f64| ((seconds * rate) / block as f64).round() as usize;
    let bridge = blocks_for(BRIDGE_SECONDS);
    let max_click = blocks_for(MAX_CLICK_SECONDS).max(1);

    // Active stretches, as [first, last] block, with short dips bridged.
    let mut stretches: Vec<(usize, usize)> = Vec::new();
    for (index, &level) in levels.iter().enumerate() {
        if level < threshold {
            continue;
        }
        match stretches.last_mut() {
            Some((_, last)) if index - *last <= bridge + 1 => *last = index,
            _ => stretches.push((index, index)),
        }
    }

    let margin = (CLICK_MARGIN_SECONDS * rate) as usize;
    let fade = ((FADE_SECONDS * rate) as usize).max(1);
    let mut click = vec![0.0_f32; samples.len()];
    // Gain of the speech output: 1 except over the clicks, with fades.
    let mut speech_gain = vec![1.0_f32; samples.len()];
    for &(first, last) in &stretches {
        if last - first + 1 > max_click {
            continue;
        }
        let from = (first * block).saturating_sub(margin);
        let to = ((last + 1) * block + margin).min(samples.len());
        click[from..to].copy_from_slice(&samples[from..to]);
        for gain in &mut speech_gain[from..to] {
            *gain = 0.0;
        }
        for step in 0..fade {
            let ramp = step as f32 / fade as f32;
            if let Some(index) = from.checked_sub(fade - step) {
                speech_gain[index] = speech_gain[index].min(1.0 - ramp);
            }
            if let Some(gain) = speech_gain.get_mut(to + step) {
                *gain = gain.min(ramp);
            }
        }
    }
    let speech = samples
        .iter()
        .zip(&speech_gain)
        .map(|(sample, gain)| sample * gain)
        .collect();
    SplitSignals { click, speech }
}

#[cfg(test)]
#[path = "split_tests.rs"]
mod tests;
