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

    // The short stretches are click hits, unless they are off the click's
    // grid: a short syllable ("dos") taken for a click would be an onset off
    // the beat, so it goes back to the speech.
    let short: Vec<usize> = stretches
        .iter()
        .filter(|(first, last)| last - first < max_click)
        .map(|&(first, _)| first * block)
        .collect();
    let gridded = on_grid(&short);
    // Too few hits on a grid to trust it (a click that wanders, very few
    // hits): every short stretch stays a click, as without the grid.
    let hits = if 2 * gridded.len() >= short.len() { gridded } else { short.clone() };

    let margin = (CLICK_MARGIN_SECONDS * rate) as usize;
    let fade = ((FADE_SECONDS * rate) as usize).max(1);
    let mut click = vec![0.0_f32; samples.len()];
    // Gain of the speech output: 1 except over the clicks, with fades.
    let mut speech_gain = vec![1.0_f32; samples.len()];
    for &(first, last) in &stretches {
        if last - first >= max_click || hits.binary_search(&(first * block)).is_err() {
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
    // The hits under a word: the click is periodic, so where a word hides
    // some, the hits on either side say where they fall. Without them the
    // click map breaks at every cue and the tempo across it is a guess
    // (bridges at 103 or 107 in a song at 105, "no click here" warnings).
    //
    // What goes there is a clean hit, not the word with the hit inside it:
    // the word changes the hit's level and apparent pitch, which is how
    // accents are told, and made up accents. The clean hit is the one in the
    // same place of the bar (the accent pattern's period), or the hit before
    // when the click has no accent.
    let hit_window = (GRID_HIT_SECONDS * rate) as usize;
    let lead = (GRID_LEAD_SECONDS * rate) as usize;
    let peak_at = |hit: usize| {
        let end = (hit + hit_window).min(samples.len());
        samples[hit.min(end)..end].iter().fold(0.0_f32, |max, x| max.max(x.abs()))
    };
    let beats = beat_numbers(&hits);
    let levels: Vec<f32> = hits.iter().map(|&hit| peak_at(hit)).collect();
    let period = accent_period(&beats, &levels);
    let by_beat: std::collections::HashMap<i64, usize> =
        beats.iter().enumerate().map(|(index, &beat)| (beat, index)).collect();
    for (hit, left, offset) in hidden_grid_hits(&hits) {
        let target = beats[left] + offset as i64;
        let source = period
            .and_then(|bar| {
                (1..=GRID_ACCENT_SEARCH_BARS as i64)
                    .flat_map(|k| [target - k * bar, target + k * bar])
                    .find_map(|beat| by_beat.get(&beat).copied())
            })
            .unwrap_or(left);
        let from = hits[source].saturating_sub(lead);
        let length = (lead + hit_window)
            .min(samples.len() - from)
            .min(samples.len().saturating_sub(hit.saturating_sub(lead)));
        let to = hit.saturating_sub(lead);
        click[to..to + length].copy_from_slice(&samples[from..from + length]);
    }

    let speech = samples
        .iter()
        .zip(&speech_gain)
        .map(|(sample, gain)| sample * gain)
        .collect();
    SplitSignals { click, speech }
}

/// How long a clean hit copied under a word lasts.
const GRID_HIT_SECONDS: f64 = 0.025;
/// And how much before its predicted start it opens.
const GRID_LEAD_SECONDS: f64 = 0.001;
/// Clean hits on each side a grid is read from.
const GRID_CONTEXT_HITS: usize = 6;
/// How close to the local beat a hit's interval must be to count as on it.
const GRID_STEADY_TOLERANCE: f64 = 0.04;
/// How far from a whole number of beats the hit after the word may land for
/// the grid to cross the word (a tempo change under the word otherwise).
const GRID_BRIDGE_TOLERANCE: f64 = 0.2;
/// Spread of hit levels (p90 against p10) above which the click is taken to
/// have accents.
const GRID_ACCENT_SPREAD: f32 = 0.15;
/// Longest accent pattern looked for, in beats (12/8 counted in eighths).
const GRID_ACCENT_MAX_BEATS: usize = 12;
/// Bars away a clean hit in the same place of the bar is looked for.
const GRID_ACCENT_SEARCH_BARS: usize = 4;
/// Longest gap filled, in beats: a cue lasts a few; longer is the click
/// really stopping.
const GRID_MAX_FILL_BEATS: f64 = 16.0;

/// The hits that sit on the click's grid: one of their neighbours is the
/// local beat away. A short syllable taken for a click is off the grid and
/// would spoil it (steady intervals, the beats across a word).
fn on_grid(hits: &[usize]) -> Vec<usize> {
    let intervals: Vec<f64> = hits.windows(2).map(|w| (w[1] - w[0]) as f64).collect();
    hits.iter()
        .enumerate()
        .filter(|&(index, _)| {
            let beat = local_beat(&intervals, index);
            let fits = |interval: Option<&f64>| {
                interval.is_some_and(|i| beat > 0.0 && (i - beat).abs() <= GRID_STEADY_TOLERANCE * beat)
            };
            fits(index.checked_sub(1).and_then(|i| intervals.get(i))) || fits(intervals.get(index))
        })
        .map(|(_, &hit)| hit)
        .collect()
}

/// Each hit's beat, counted from the first: a gap of three beats (a word)
/// advances three.
fn beat_numbers(hits: &[usize]) -> Vec<i64> {
    let intervals: Vec<f64> = hits.windows(2).map(|w| (w[1] - w[0]) as f64).collect();
    let mut beats = Vec::with_capacity(hits.len());
    let mut beat = 0_i64;
    for index in 0..hits.len() {
        if index > 0 {
            let local = local_beat(&intervals, index - 1);
            beat += if local > 0.0 { (intervals[index - 1] / local).round().max(1.0) as i64 } else { 1 };
        }
        beats.push(beat);
    }
    beats
}

/// How many beats the accent pattern repeats in, when the click has one: the
/// period whose hits a bar apart are most alike in level. `None` when every
/// hit sounds about the same.
fn accent_period(beats: &[i64], levels: &[f32]) -> Option<i64> {
    let mut sorted = levels.to_vec();
    sorted.sort_by(f32::total_cmp);
    let (low, high) = (
        *sorted.get(sorted.len() / 10)?,
        *sorted.get(sorted.len() * 9 / 10)?,
    );
    if high <= 0.0 || (high - low) / high < GRID_ACCENT_SPREAD {
        return None;
    }
    let level_of: std::collections::HashMap<i64, f32> =
        beats.iter().copied().zip(levels.iter().copied()).collect();
    (2..=GRID_ACCENT_MAX_BEATS as i64)
        .filter_map(|bar| {
            let differences: Vec<f32> = level_of
                .iter()
                .filter_map(|(beat, level)| level_of.get(&(beat + bar)).map(|other| (level - other).abs()))
                .collect();
            (differences.len() >= 4)
                .then(|| (bar, differences.iter().sum::<f32>() / differences.len() as f32))
        })
        .min_by(|a, b| a.1.total_cmp(&b.1))
        .map(|(bar, _)| bar)
}

/// The beat around interval `index`: the median of its neighbours, so the
/// odd long gap (a word) or short one (a syllable) does not move it.
fn local_beat(intervals: &[f64], index: usize) -> f64 {
    let from = index.saturating_sub(GRID_CONTEXT_HITS);
    let to = (index + GRID_CONTEXT_HITS).min(intervals.len());
    let mut near: Vec<f64> = intervals[from..to].to_vec();
    near.sort_by(f64::total_cmp);
    near.get(near.len() / 2).copied().unwrap_or(0.0)
}

/// The hits missing between two gridded hits a whole number of beats apart
/// (those a word covers): position, index of the hit before, and how many
/// beats after it. Only across gaps of up to [`GRID_MAX_FILL_BEATS`],
/// and only when the gap is that whole number of beats (a tempo change under
/// the word otherwise, and nothing is made up).
fn hidden_grid_hits(hits: &[usize]) -> Vec<(usize, usize, usize)> {
    let intervals: Vec<f64> = hits.windows(2).map(|w| (w[1] - w[0]) as f64).collect();
    let mut hidden = Vec::new();
    for (index, &interval) in intervals.iter().enumerate() {
        let beat = local_beat(&intervals, index);
        if beat <= 0.0 {
            continue;
        }
        let beats = interval / beat;
        let whole = beats.round();
        if whole < 2.0 || whole > GRID_MAX_FILL_BEATS || (beats - whole).abs() > GRID_BRIDGE_TOLERANCE {
            continue;
        }
        let step = interval / whole;
        hidden.extend(
            (1..whole as usize)
                .map(|n| ((hits[index] as f64 + n as f64 * step).round() as usize, index, n)),
        );
    }
    hidden
}

#[cfg(test)]
#[path = "split_tests.rs"]
mod tests;
