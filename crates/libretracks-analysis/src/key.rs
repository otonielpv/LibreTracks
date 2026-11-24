//! The key of a song from its harmonic tracks.
//!
//! 1. Decimate to ~11 kHz (a key lives below 2 kHz) and run an STFT.
//! 2. Take the spectral peaks of each frame, estimate the tuning from how far
//!    they sit from equal temperament (a band tuned to 432 Hz is still in D),
//!    and fold them into a 12-bin chromagram, each frame weighted the same so
//!    a loud chorus does not outvote the verses.
//! 3. Correlate the song's chroma with the 24 key profiles. The margin to the
//!    runner-up is the confidence; a relative major/minor in second place is
//!    the classic doubt and is reported as such.

use serde::Serialize;

use crate::dsp::decimate;
use crate::fft::fft;

const FRAME: usize = 4096;
const HOP: usize = 2048;
/// Pitch range folded into the chromagram (C2 to C7).
const MIN_HZ: f64 = 65.0;
const MAX_HZ: f64 = 2100.0;
/// Strongest peaks kept per frame.
const PEAKS_PER_FRAME: usize = 40;
/// A peak this far (in semitones) from the tuned grid is noise, not a note.
const MAX_DETUNE_SEMITONES: f64 = 0.35;
/// Frames quieter than this share of the median loud frame are silence.
const SILENT_FRAME_SHARE: f64 = 0.1;
/// Length of the stretches the song is cut into to look for modulations.
const WINDOW_SECONDS: f64 = 30.0;
/// A stretch with fewer pitched frames than this says nothing (an intro).
const MIN_WINDOW_FRAMES: usize = 40;
/// A key that lasts less than this is a passing chord, not a modulation: the
/// last chorus up a tone lasts a minute or more, a bridge's borrowed chord
/// does not. Judged on duration, not on windows: the last window absorbs the
/// remainder of the song and can be shorter or longer than the others.
const MIN_SECTION_SECONDS: f64 = 45.0;
/// Below this correlation margin the runner-up is offered as an alternative.
/// Real songs whose key was right won by 0.16–0.36 (see the plan's
/// validation table).
const CLEAR_MARGIN: f64 = 0.1;

/// Sharp spelling, the app's canonical form (`SONG_KEY_OPTIONS`).
const PITCH_NAMES: [&str; 12] = [
    "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
];

/// Temperley–Kostka–Payne key profiles (2007), tonic first. Fit pop and
/// worship harmony better than Krumhansl–Kessler on the validation set.
const MAJOR_PROFILE: [f64; 12] = [
    0.748, 0.060, 0.488, 0.082, 0.670, 0.460, 0.096, 0.715, 0.104, 0.366, 0.057, 0.400,
];
const MINOR_PROFILE: [f64; 12] = [
    0.712, 0.084, 0.474, 0.618, 0.049, 0.460, 0.105, 0.747, 0.404, 0.067, 0.133, 0.330,
];

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyCandidate {
    /// `"Dm"`, `"F#"`…
    pub key: String,
    /// Correlation with the key's profile, -1..1.
    pub score: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyAnalysis {
    /// Best key; `None` when the audio has no pitched content.
    pub key: Option<String>,
    /// Correlation margin over the runner-up (0 = a coin toss).
    pub confidence: f64,
    /// The runner-up, when the margin is too small to call.
    pub alternative: Option<String>,
    /// That close runner-up is the relative key (same notes, other tonic).
    pub relative_doubt: bool,
    /// How far the band is from A = 440 Hz, in cents.
    pub tuning_cents: f64,
    /// The three best keys (of the section the key comes from).
    pub candidates: Vec<KeyCandidate>,
    /// Where the song changes key. Empty when it stays in one (the usual
    /// case); otherwise one entry per stretch, and `key` is the one that
    /// lasts longest.
    pub sections: Vec<KeySection>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeySection {
    /// Seconds from the start of the analysed audio.
    pub start_seconds: f64,
    pub key: String,
}

impl KeyAnalysis {
    fn silent() -> Self {
        Self {
            key: None,
            confidence: 0.0,
            alternative: None,
            relative_doubt: false,
            tuning_cents: 0.0,
            candidates: Vec::new(),
            sections: Vec::new(),
        }
    }
}

pub fn key_name(tonic: usize, minor: bool) -> String {
    format!(
        "{}{}",
        PITCH_NAMES[tonic % 12],
        if minor { "m" } else { "" }
    )
}

/// `key_name` shifted by `semitones` (`"Dm"` + 2 → `"Em"`). `None` for a name
/// this module did not write.
pub fn transpose_key_name(name: &str, semitones: i32) -> Option<String> {
    let minor = name.ends_with('m');
    let note = name.strip_suffix('m').unwrap_or(name);
    let tonic = PITCH_NAMES
        .iter()
        .position(|candidate| *candidate == note)?;
    let shifted = (tonic as i32 + semitones).rem_euclid(12) as usize;
    Some(key_name(shifted, minor))
}

impl KeyAnalysis {
    /// The same result `semitones` away. A song transposed +2 sounds a tone
    /// up, while its stored key is the original: the caller passes -2.
    pub fn transposed(mut self, semitones: i32) -> Self {
        let shift = |name: &mut String| {
            if let Some(shifted) = transpose_key_name(name, semitones) {
                *name = shifted;
            }
        };
        if let Some(key) = self.key.as_mut() {
            shift(key);
        }
        if let Some(alternative) = self.alternative.as_mut() {
            shift(alternative);
        }
        for candidate in &mut self.candidates {
            shift(&mut candidate.key);
        }
        for section in &mut self.sections {
            shift(&mut section.key);
        }
        self
    }
}

/// Analyse the key of a mono mix of the song's harmonic tracks.
///
/// A song that goes up a tone for the last chorus has no single key: its
/// whole-song chromagram blends the two and lands on the notes they share (a
/// song in D that ends in E reads as A, the dominant of both). So the song is
/// cut into stretches, stretches in the same key are merged, and the key is
/// the one that lasts longest; `sections` says where it changes.
pub fn analyze_key(samples: &[f32], sample_rate: u32) -> KeyAnalysis {
    let (signal, rate) = decimate(samples, f64::from(sample_rate.max(1)));
    let frames = spectral_peaks(&signal, rate);
    if frames.is_empty() {
        return KeyAnalysis::silent();
    }
    let tuning = estimate_tuning(&frames);
    let whole = chromagram(&frames, tuning);
    if whole.iter().sum::<f64>() <= 0.0 {
        return KeyAnalysis::silent();
    }

    let mut stretches = key_stretches(&frames, tuning, signal.len() as f64 / rate);
    if stretches.len() > 1 {
        refine_boundaries(&frames, tuning, &mut stretches);
        // First of the longest: a tie goes to the key the song starts in.
        let main = stretches
            .iter()
            .enumerate()
            .max_by(|(ia, a), (ib, b)| {
                (a.end - a.start)
                    .total_cmp(&(b.end - b.start))
                    .then(ib.cmp(ia))
            })
            .map(|(_, stretch)| stretch)
            .unwrap_or(&stretches[0]);
        let sections = stretches
            .iter()
            .map(|stretch| {
                let (tonic, minor, _) = rank_keys(&stretch.chroma)[0];
                KeySection {
                    start_seconds: stretch.start,
                    key: key_name(tonic, minor),
                }
            })
            .collect();
        return describe(&main.chroma, tuning, sections);
    }
    describe(&whole, tuning, Vec::new())
}

/// Every key against the chroma, best first: (tonic, minor, correlation).
fn rank_keys(chroma: &[f64; 12]) -> Vec<(usize, bool, f64)> {
    let mut scores: Vec<(usize, bool, f64)> = Vec::with_capacity(24);
    for tonic in 0..12 {
        for minor in [false, true] {
            let profile = if minor {
                &MINOR_PROFILE
            } else {
                &MAJOR_PROFILE
            };
            let rotated: Vec<f64> = (0..12).map(|pc| profile[(pc + 12 - tonic) % 12]).collect();
            scores.push((tonic, minor, pearson(chroma, &rotated)));
        }
    }
    scores.sort_by(|a, b| b.2.total_cmp(&a.2));
    scores
}

fn describe(chroma: &[f64; 12], tuning: f64, sections: Vec<KeySection>) -> KeyAnalysis {
    let scores = rank_keys(chroma);
    let (tonic, minor, best) = scores[0];
    let (second_tonic, second_minor, second) = scores[1];
    let relative = if minor {
        (tonic + 3) % 12
    } else {
        (tonic + 9) % 12
    };
    let margin = best - second;
    let relative_doubt = second_minor != minor && second_tonic == relative && margin < CLEAR_MARGIN;
    KeyAnalysis {
        key: Some(key_name(tonic, minor)),
        confidence: margin,
        alternative: (margin < CLEAR_MARGIN).then(|| key_name(second_tonic, second_minor)),
        relative_doubt,
        tuning_cents: tuning * 100.0,
        candidates: scores
            .iter()
            .take(3)
            .map(|&(t, m, score)| KeyCandidate {
                key: key_name(t, m),
                score,
            })
            .collect(),
        sections,
    }
}

/// A run of windows in one key.
struct Stretch {
    start: f64,
    end: f64,
    chroma: [f64; 12],
}

/// The key "family" two relative keys share (C and Am both give C's tonic): a
/// stretch that flips between them is not a modulation.
fn family(chroma: &[f64; 12]) -> usize {
    let (tonic, minor, _) = rank_keys(chroma)[0];
    if minor {
        (tonic + 3) % 12
    } else {
        tonic
    }
}

/// Two stretches read in the same key: the same family, or keys a fifth apart
/// that do not each sound the note only they have. Such keys share six notes,
/// so a verse sitting on the dominant reads as a modulation to it: "Al estar
/// ante ti" (D, D–A–Em–Bm verse ending on A) came out A, D, A, D, though its
/// verses had more G than G#. A real move to the dominant sounds its leading
/// tone, and the key it left its own fourth.
fn same_key(a: &[f64; 12], b: &[f64; 12]) -> bool {
    let (family_a, family_b) = (family(a), family(b));
    if family_a == family_b {
        return true;
    }
    // The note each key has and the other lacks: the dominant's leading tone
    // against the tonic's fourth.
    let (only_a, only_b) = match (family_b + 12 - family_a) % 12 {
        7 => ((family_a + 5) % 12, (family_a + 6) % 12),
        5 => ((family_b + 6) % 12, (family_b + 5) % 12),
        _ => return false,
    };
    !(a[only_a] > a[only_b] && b[only_b] > b[only_a])
}

fn add_chroma(into: &mut [f64; 12], other: [f64; 12]) {
    into.iter_mut().zip(other).for_each(|(a, b)| *a += b);
}

fn key_stretches(frames: &[(f64, Peaks)], tuning: f64, total_seconds: f64) -> Vec<Stretch> {
    // Whole windows; the last one runs to the end.
    let count = ((total_seconds / WINDOW_SECONDS).floor() as usize).max(1);
    let mut groups: Vec<Stretch> = Vec::new();
    for window in 0..count {
        let start = window as f64 * WINDOW_SECONDS;
        let end = if window + 1 == count {
            f64::INFINITY
        } else {
            start + WINDOW_SECONDS
        };
        let from = frames.partition_point(|(seconds, _)| *seconds < start);
        let to = frames.partition_point(|(seconds, _)| *seconds < end);
        let chroma = chromagram(&frames[from..to], tuning);
        let pitched = to - from >= MIN_WINDOW_FRAMES && chroma.iter().sum::<f64>() > 0.0;
        let end = end.min(total_seconds);
        match groups.last_mut() {
            // An empty stretch (an intro, a silence) joins its neighbour.
            Some(last) if !pitched => {
                last.end = end;
            }
            Some(last) if same_key(&last.chroma, &chroma) => {
                last.end = end;
                add_chroma(&mut last.chroma, chroma);
            }
            _ if !pitched => {}
            _ => groups.push(Stretch { start, end, chroma }),
        }
    }

    // Short stretches are passing chords, not modulations: fold each into the
    // stretch before it (or the one after, for the first), then merge any
    // neighbours that end up in the same key. The key of a merged stretch is
    // re-read from its summed chroma.
    while groups.len() > 1 {
        let Some(short) = groups
            .iter()
            .position(|g| g.end - g.start < MIN_SECTION_SECONDS)
        else {
            break;
        };
        let absorbed = groups.remove(short);
        let into = short.saturating_sub(1);
        let target = &mut groups[into];
        target.start = target.start.min(absorbed.start);
        target.end = target.end.max(absorbed.end);
        add_chroma(&mut target.chroma, absorbed.chroma);
        let mut index = 1;
        while index < groups.len() {
            if same_key(&groups[index - 1].chroma, &groups[index].chroma) {
                let next = groups.remove(index);
                let previous = &mut groups[index - 1];
                previous.end = next.end;
                add_chroma(&mut previous.chroma, next.chroma);
            } else {
                index += 1;
            }
        }
    }
    groups
}

/// The key profile of the best key for `chroma`, rotated to its tonic.
fn best_profile(chroma: &[f64; 12]) -> [f64; 12] {
    let (tonic, minor, _) = rank_keys(chroma)[0];
    let profile = if minor { &MINOR_PROFILE } else { &MAJOR_PROFILE };
    std::array::from_fn(|pc| profile[(pc + 12 - tonic) % 12])
}

/// Move each key change to the frame where it actually happens. The stretches
/// come from 30 s windows, so a change is only known to fall within a window
/// of where they meet: the user wants the exact moment (it is drawn on the
/// timeline, and a performer reads it). Within that span every frame votes for
/// the key before or after (how much better its chroma fits one profile than
/// the other), and the change goes where the votes before it favour the old
/// key the most and the ones after it the new key: the maximum of the running
/// sum of `fit(old) - fit(new)`.
fn refine_boundaries(frames: &[(f64, Peaks)], tuning: f64, stretches: &mut [Stretch]) {
    for index in 1..stretches.len() {
        let (before, after) = stretches.split_at_mut(index);
        let (old, new) = (&mut before[index - 1], &mut after[0]);
        let old_profile = best_profile(&old.chroma);
        let new_profile = best_profile(&new.chroma);
        let from_seconds = (new.start - WINDOW_SECONDS).max(old.start);
        let to_seconds = (new.start + WINDOW_SECONDS).min(new.end);
        let from = frames.partition_point(|(seconds, _)| *seconds < from_seconds);
        let to = frames.partition_point(|(seconds, _)| *seconds < to_seconds);
        let mut running = 0.0;
        let mut best = (0.0, new.start);
        for frame in from..to {
            let chroma = chromagram(&frames[frame..frame + 1], tuning);
            if chroma.iter().sum::<f64>() <= 0.0 {
                continue;
            }
            // The change at this frame: everything voted so far is before it.
            if running > best.0 {
                best = (running, frames[frame].0);
            }
            running += pearson(&chroma, &old_profile) - pearson(&chroma, &new_profile);
        }
        old.end = best.1;
        new.start = best.1;
    }
}

/// The song's chromagram (C first), normalised to sum 1, for the
/// `analyze_key` example's `CHROMA=1` dump. Not part of the analysis API.
#[doc(hidden)]
pub fn debug_chroma(samples: &[f32], sample_rate: u32) -> [f64; 12] {
    let (signal, rate) = decimate(samples, f64::from(sample_rate.max(1)));
    let frames = spectral_peaks(&signal, rate);
    let tuning = estimate_tuning(&frames);
    let mut chroma = chromagram(&frames, tuning);
    let total: f64 = chroma.iter().sum();
    if total > 0.0 {
        chroma.iter_mut().for_each(|value| *value /= total);
    }
    chroma
}

/// (frequency Hz, magnitude) of a frame's peaks.
type Peaks = Vec<(f64, f64)>;

/// The pitched frames of the signal as (seconds, peaks).
fn spectral_peaks(signal: &[f32], rate: f64) -> Vec<(f64, Peaks)> {
    if signal.len() < FRAME {
        return Vec::new();
    }
    let window: Vec<f32> = (0..FRAME)
        .map(|i| (0.5 - 0.5 * (std::f64::consts::TAU * i as f64 / FRAME as f64).cos()) as f32)
        .collect();
    let bin_hz = rate / FRAME as f64;
    let low = ((MIN_HZ / bin_hz).floor() as usize).max(1);
    let high = ((MAX_HZ / bin_hz).ceil() as usize).min(FRAME / 2 - 2);

    let mut frames: Vec<(f64, f64, Peaks)> = Vec::new();
    let mut re = vec![0.0_f32; FRAME];
    let mut im = vec![0.0_f32; FRAME];
    let mut start = 0;
    while start + FRAME <= signal.len() {
        for i in 0..FRAME {
            re[i] = signal[start + i] * window[i];
            im[i] = 0.0;
        }
        fft(&mut re, &mut im);
        let magnitude: Vec<f64> = (0..=high + 1)
            .map(|k| f64::from(re[k] * re[k] + im[k] * im[k]).sqrt())
            .collect();
        let energy: f64 = magnitude[low..=high].iter().map(|m| m * m).sum();
        let frame_max = magnitude[low..=high].iter().copied().fold(0.0, f64::max);
        let mut peaks: Peaks = Vec::new();
        if frame_max > 0.0 {
            for k in low..=high {
                let (a, b, c) = (magnitude[k - 1], magnitude[k], magnitude[k + 1]);
                if b > a && b >= c && b > 0.05 * frame_max {
                    // Parabolic interpolation on the log magnitude.
                    let (la, lb, lc) = (a.max(1e-12).ln(), b.ln(), c.max(1e-12).ln());
                    let denominator = la - 2.0 * lb + lc;
                    let offset = if denominator.abs() > 1e-12 {
                        (0.5 * (la - lc) / denominator).clamp(-0.5, 0.5)
                    } else {
                        0.0
                    };
                    peaks.push(((k as f64 + offset) * bin_hz, b));
                }
            }
            peaks.sort_by(|x, y| y.1.total_cmp(&x.1));
            peaks.truncate(PEAKS_PER_FRAME);
        }
        frames.push((start as f64 / rate, energy, peaks));
        start += HOP;
    }

    // Drop the silent frames (intros, breaks, the song's tail).
    let mut energies: Vec<f64> = frames.iter().map(|f| f.1).filter(|e| *e > 0.0).collect();
    if energies.is_empty() {
        return Vec::new();
    }
    energies.sort_by(f64::total_cmp);
    let floor = SILENT_FRAME_SHARE * energies[energies.len() / 2];
    frames
        .into_iter()
        .filter(|(_, energy, peaks)| *energy > floor && !peaks.is_empty())
        .map(|(seconds, _, peaks)| (seconds, peaks))
        .collect()
}

/// Semitones above A440 (fractional).
fn semitones_from_a440(frequency: f64) -> f64 {
    12.0 * (frequency / 440.0).log2()
}

/// Band tuning in semitones (-0.5..0.5): the circular mean of every peak's
/// distance to the nearest equal-tempered note, weighted by its level.
fn estimate_tuning(frames: &[(f64, Peaks)]) -> f64 {
    let (mut x, mut y) = (0.0, 0.0);
    for (_, peaks) in frames {
        for &(frequency, magnitude) in peaks {
            let deviation = semitones_from_a440(frequency);
            let angle = std::f64::consts::TAU * (deviation - deviation.round());
            x += magnitude * angle.cos();
            y += magnitude * angle.sin();
        }
    }
    if x == 0.0 && y == 0.0 {
        return 0.0;
    }
    y.atan2(x) / std::f64::consts::TAU
}

fn chromagram(frames: &[(f64, Peaks)], tuning: f64) -> [f64; 12] {
    let mut chroma = [0.0; 12];
    for (_, peaks) in frames {
        let mut frame = [0.0; 12];
        for &(frequency, magnitude) in peaks {
            let semitones = semitones_from_a440(frequency) - tuning;
            let nearest = semitones.round();
            if (semitones - nearest).abs() > MAX_DETUNE_SEMITONES {
                continue;
            }
            // A is 9 semitones above C.
            let pitch_class = (nearest as i64 + 9).rem_euclid(12) as usize;
            frame[pitch_class] += magnitude.sqrt();
        }
        let total: f64 = frame.iter().sum();
        if total > 0.0 {
            for (bin, value) in chroma.iter_mut().zip(frame) {
                *bin += value / total;
            }
        }
    }
    chroma
}

fn pearson(a: &[f64], b: &[f64]) -> f64 {
    let n = a.len() as f64;
    let mean_a = a.iter().sum::<f64>() / n;
    let mean_b = b.iter().sum::<f64>() / n;
    let (mut covariance, mut var_a, mut var_b) = (0.0, 0.0, 0.0);
    for (x, y) in a.iter().zip(b) {
        covariance += (x - mean_a) * (y - mean_b);
        var_a += (x - mean_a).powi(2);
        var_b += (y - mean_b).powi(2);
    }
    if var_a <= 0.0 || var_b <= 0.0 {
        return 0.0;
    }
    covariance / (var_a * var_b).sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: u32 = 44_100;

    /// A chord as a sum of harmonic tones (MIDI notes), `seconds` long.
    fn chord(notes: &[i32], seconds: f64, detune_cents: f64) -> Vec<f32> {
        let length = (seconds * f64::from(RATE)) as usize;
        let mut out = vec![0.0_f32; length];
        for &note in notes {
            let frequency = 440.0 * 2f64.powf((f64::from(note - 69) + detune_cents / 100.0) / 12.0);
            for (i, sample) in out.iter_mut().enumerate() {
                let t = i as f64 / f64::from(RATE);
                // A few harmonics, like a real instrument.
                let mut value = 0.0;
                for harmonic in 1..=4 {
                    value += (std::f64::consts::TAU * frequency * f64::from(harmonic) * t).sin()
                        / f64::from(harmonic);
                }
                *sample += (0.1 * value) as f32;
            }
        }
        out
    }

    /// A I-IV-V-I-vi-IV-V-I progression (two seconds a chord) in `tonic`
    /// (MIDI of the tonic around C4), with the bass an octave down.
    fn progression(tonic: i32, minor: bool, detune_cents: f64) -> Vec<f32> {
        // Triads as (root offset, third offset).
        let degrees: &[(i32, i32)] = if minor {
            // i iv v(V) i VI iv V i
            &[
                (0, 3),
                (5, 3),
                (7, 4),
                (0, 3),
                (8, 4),
                (5, 3),
                (7, 4),
                (0, 3),
            ]
        } else {
            &[
                (0, 4),
                (5, 4),
                (7, 4),
                (0, 4),
                (9, 3),
                (5, 4),
                (7, 4),
                (0, 4),
            ]
        };
        let mut song = Vec::new();
        for &(root, third) in degrees {
            let r = tonic + root;
            song.extend(chord(&[r - 12, r, r + third, r + 7], 2.0, detune_cents));
        }
        song
    }

    #[test]
    fn c_major_progression_is_c() {
        let analysis = analyze_key(&progression(60, false, 0.0), RATE);
        assert_eq!(analysis.key.as_deref(), Some("C"), "{analysis:?}");
    }

    #[test]
    fn a_minor_progression_is_a_minor() {
        let analysis = analyze_key(&progression(57, true, 0.0), RATE);
        assert_eq!(analysis.key.as_deref(), Some("Am"), "{analysis:?}");
    }

    #[test]
    fn f_sharp_major_uses_sharp_spelling() {
        let analysis = analyze_key(&progression(66, false, 0.0), RATE);
        assert_eq!(analysis.key.as_deref(), Some("F#"), "{analysis:?}");
    }

    #[test]
    fn a_band_tuned_to_432_hz_keeps_its_key() {
        // 432 Hz is 31.8 cents flat of 440.
        let analysis = analyze_key(&progression(62, false, -31.8), RATE);
        assert_eq!(analysis.key.as_deref(), Some("D"), "{analysis:?}");
        assert!((analysis.tuning_cents + 31.8).abs() < 5.0, "{analysis:?}");
    }

    #[test]
    fn only_relative_triads_is_reported_as_a_relative_doubt() {
        // C and Am taking turns: same notes, two tonics.
        let mut song = Vec::new();
        for _ in 0..4 {
            song.extend(chord(&[48, 60, 64, 67], 2.0, 0.0));
            song.extend(chord(&[45, 57, 60, 64], 2.0, 0.0));
        }
        let analysis = analyze_key(&song, RATE);
        let pair = [analysis.key.clone(), analysis.alternative.clone()];
        assert!(pair.contains(&Some("C".into())), "{analysis:?}");
        assert!(pair.contains(&Some("Am".into())), "{analysis:?}");
        assert!(analysis.relative_doubt, "{analysis:?}");
    }

    #[test]
    fn transposing_a_result_moves_every_key() {
        let analysis = analyze_key(&progression(62, false, 0.0), RATE).transposed(-2);
        assert_eq!(analysis.key.as_deref(), Some("C"));
        assert_eq!(transpose_key_name("A#m", 3).as_deref(), Some("C#m"));
        assert_eq!(transpose_key_name("C", -1).as_deref(), Some("B"));
        assert_eq!(transpose_key_name("Hm", 1), None);
    }

    /// `progression` repeated until it lasts at least `seconds`.
    fn lasting(tonic: i32, seconds: f64) -> Vec<f32> {
        let one = progression(tonic, false, 0.0);
        let mut song = Vec::new();
        while (song.len() as f64) < seconds * f64::from(RATE) {
            song.extend_from_slice(&one);
        }
        song
    }

    #[test]
    fn a_song_that_goes_up_a_tone_is_read_in_the_key_it_lasts_longest() {
        // Re-creates a real case: 3 minutes in D, then the last chorus in E.
        // Blended, the two read as A, the dominant of both.
        let mut song = lasting(62, 112.0);
        song.extend(lasting(64, 64.0));
        let analysis = analyze_key(&song, RATE);
        assert_eq!(analysis.key.as_deref(), Some("D"), "{analysis:?}");
        let sections: Vec<(f64, &str)> = analysis
            .sections
            .iter()
            .map(|s| (s.start_seconds, s.key.as_str()))
            .collect();
        assert_eq!(sections.len(), 2, "{analysis:?}");
        assert_eq!(sections[0], (0.0, "D"));
        assert_eq!(sections[1].1, "E");
        assert!((sections[1].0 - 112.0).abs() <= 32.0, "{analysis:?}");
    }

    /// Triads (root MIDI, third offset), two seconds each, with the bass an
    /// octave down, repeated until they last at least `seconds`.
    fn chords_lasting(triads: &[(i32, i32)], seconds: f64) -> Vec<f32> {
        let mut song = Vec::new();
        while (song.len() as f64) < seconds * f64::from(RATE) {
            for &(r, third) in triads {
                song.extend(chord(&[r - 12, r, r + third, r + 7], 2.0, 0.0));
            }
        }
        song
    }

    #[test]
    fn a_verse_on_the_dominant_is_not_a_modulation() {
        // "Al estar ante ti" (D): verses that lean on A and E minor (no G#)
        // read as A between choruses in D, an A, D, A, D that was not there.
        let verse: &[(i32, i32)] = &[(57, 4), (64, 3), (57, 4), (59, 3), (57, 4), (64, 3)];
        let chorus: &[(i32, i32)] = &[(55, 4), (62, 4), (57, 4), (59, 3), (55, 4), (62, 4)];
        let mut song = Vec::new();
        for _ in 0..2 {
            song.extend(chords_lasting(verse, 60.0));
            song.extend(chords_lasting(chorus, 60.0));
        }
        let analysis = analyze_key(&song, RATE);
        assert_eq!(analysis.key.as_deref(), Some("D"), "{analysis:?}");
        assert!(analysis.sections.is_empty(), "{analysis:?}");
    }

    #[test]
    fn a_real_move_to_the_dominant_is_still_a_modulation() {
        // C, then G sounding its F#: a key change, not a verse on the dominant.
        let mut song = lasting(60, 90.0);
        song.extend(lasting(67, 90.0));
        let analysis = analyze_key(&song, RATE);
        let keys: Vec<&str> = analysis.sections.iter().map(|s| s.key.as_str()).collect();
        assert_eq!(keys, ["C", "G"], "{analysis:?}");
    }

    #[test]
    fn the_key_change_is_placed_where_it_happens_not_on_the_window_grid() {
        // A change that falls mid-window (97 s, not a multiple of 30): the
        // window grid alone puts it at 90 or 120.
        for change in [97.0, 112.0, 133.0] {
            let mut song = Vec::new();
            let one = progression(62, false, 0.0);
            while (song.len() as f64) < change * f64::from(RATE) {
                song.extend_from_slice(&one);
            }
            let truth = song.len() as f64 / f64::from(RATE);
            song.extend(lasting(64, 70.0));
            let analysis = analyze_key(&song, RATE);
            assert_eq!(analysis.sections.len(), 2, "{analysis:?}");
            assert!(
                (analysis.sections[1].start_seconds - truth).abs() <= 1.0,
                "change at {truth}: {analysis:?}"
            );
        }
    }

    #[test]
    fn modulation_is_reported_transposed_with_the_rest() {
        let mut song = lasting(62, 112.0);
        song.extend(lasting(64, 64.0));
        let analysis = analyze_key(&song, RATE).transposed(-2);
        assert_eq!(analysis.key.as_deref(), Some("C"));
        assert_eq!(analysis.sections[1].key, "D");
    }

    #[test]
    fn a_passing_stretch_in_another_key_is_not_a_modulation() {
        // 20 s in another key inside a song in C: under two windows.
        let mut song = lasting(60, 100.0);
        song.extend(lasting(65, 20.0));
        song.extend(lasting(60, 70.0));
        let analysis = analyze_key(&song, RATE);
        assert_eq!(analysis.key.as_deref(), Some("C"), "{analysis:?}");
        assert!(analysis.sections.is_empty(), "{analysis:?}");
    }

    #[test]
    fn a_short_song_has_no_sections() {
        let analysis = analyze_key(&progression(62, false, 0.0), RATE);
        assert!(analysis.sections.is_empty());
    }

    #[test]
    fn silence_has_no_key() {
        let analysis = analyze_key(&vec![0.0; RATE as usize * 4], RATE);
        assert_eq!(analysis.key, None);
    }
}
