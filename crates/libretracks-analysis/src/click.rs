//! Tempo map and meter from a click track.
//!
//! A multitrack's click stem is the most reliable tempo source there is: it is
//! the exact grid the band plays to, and its accent says where each bar starts.
//! So instead of estimating a tempo from the music, this reads the clicks:
//!
//! 1. find every click and measure its level and apparent pitch;
//! 2. group the clicks into classes (accent, beat, subdivision);
//! 3. drop subdivisions, take the accents as downbeats;
//! 4. cut the beats into bars and the bars into constant-tempo segments.
//!
//! Segments always start on a downbeat. The engine's metronome restarts the
//! bar at every tempo marker (`timing_segment_start` in
//! `metronome_renderer.cpp`), so a marker anywhere else would make the app's
//! click disagree with the multitrack's.

use crate::bar_phase::{pickup_from_guide, pickup_from_tempo_changes, GuideEvidence};
use crate::fft::fft;
use crate::guide::GuideAnalysis;
use serde::Serialize;

/// How loosely beats may follow their tempo before a segment is cut.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Tolerances {
    /// Largest distance from a beat to the straight line fitted through its
    /// segment.
    pub fit_residual: f64,
    /// Largest drift a rounded BPM may build up across its segment.
    pub rounding_drift: f64,
    /// A segment starts on its first beat as heard, not where the line
    /// fitted through its beats starts. A rendered click is exact to the
    /// sample, and on a bar whose tempo changes halfway the fitted start sits
    /// tens of ms off the real downbeat: the markers then miss the click.
    /// Beats estimated from the music are jittery, and the fit is better.
    pub start_on_first_beat: bool,
}

/// A generated click sits within a millisecond of its grid; 10 ms still keeps
/// a sloppy bounce together.
const CLICK_TOLERANCES: Tolerances = Tolerances {
    fit_residual: 0.010,
    rounding_drift: 0.008,
    start_on_first_beat: true,
};
/// Shortest gap between two clicks: a 16th at 300 BPM is 50 ms.
const REFRACTORY_SECONDS: f64 = 0.050;
/// Part of each click its features are measured on.
const FEATURE_WINDOW_SECONDS: f64 = 0.015;
/// Smallest pitch jump that may separate two click sounds (~1/3 semitone).
/// The real test is the jump against the spread inside each group, see
/// `feature_levels`.
const PITCH_GAP_OCTAVES: f64 = 0.03;
/// Smallest level jump that may separate two click sounds. Real clicks have
/// shown beats only 2.3 dB above their off-beats.
const LEVEL_GAP_DB: f64 = 1.0;
/// A group split must jump this many times the spread of either side.
const SPLIT_OVER_SPREAD: f64 = 2.0;
/// Below this pulse, 3, 6, 9 or 12 clicks per accent are eighths of a
/// compound meter (6/8 at 74 is an eighth every 0.405 s).
const COMPOUND_EIGHTH_MAX_SECONDS: f64 = 0.45;
/// A beat closer than this to the one before (share of the beat) may be a
/// stray off-beat (see `without_stray_offbeats`)...
const STRAY_OFFBEAT_SHARE: f64 = 0.75;
/// ...when the beats either side of it are a beat apart, within this.
const STRAY_BEAT_TOLERANCE: f64 = 0.1;
/// Clicks closer than this (over 270 a minute) are subdivisions: the beat is
/// every other one. A real 6/8 at 76 clicked in sixteenths runs at 0.197 s.
const SUBDIVISION_MAX_SECONDS: f64 = 0.22;
/// The same for a click without accent: nothing says it is a compound meter,
/// so anything over 176 a minute is read as eighths (128 BPM clicked in
/// eighths is 0.234 s; a real 98 BPM click in eighths, 0.306 s, came out at
/// 196 with a 0.3 s limit and put every guide marker half a bar early).
const UNACCENTED_SUBDIVISION_MAX_SECONDS: f64 = 0.34;
/// Fewer beats than this is not a click track.
const MIN_BEATS: usize = 4;
/// Neighbouring segments this far apart (as a fraction of the tempo) are a
/// real tempo change, not rounding.
const ERRATIC_CHANGE_FRACTION: f64 = 0.015;
/// Segments this short (in bars) that change the tempo are suspicious.
const ERRATIC_SHORT_BARS: u32 = 2;
/// This many short tempo changes, going up and down at least
/// `ERRATIC_MIN_REVERSALS` times, is not a song changing tempo a few times or
/// drifting one way (ritardando, accelerando). It is either a live click that
/// follows the band through a free passage ("Digno de adorar", Miel San
/// Marcos: 58, 61, 56, 60, 68, 72... bar after bar, every bar clean), or a
/// misread click. `MISREAD_INTERVAL_SHARE` tells them apart.
const ERRATIC_MIN_SHORT_CHANGES: usize = 4;
const ERRATIC_MIN_REVERSALS: usize = 2;
/// A live click holds each tempo for a bar or more, so even through a free
/// passage most clicks follow the previous interval to the millisecond (the
/// real one above changes it at about one click in ten). A misread one
/// wobbles: a missed or stray click, or onsets smeared by bleed, change
/// nearly every interval. Over this share of intervals stepping by more than
/// `MISREAD_INTERVAL_STEP` makes it misread.
const MISREAD_INTERVAL_SHARE: f64 = 0.4;
const MISREAD_INTERVAL_STEP: f64 = 0.03;
/// Segments whose tempos are this close count as the same tempo when
/// choosing the dominant one.
const SAME_TEMPO_FRACTION: f64 = 0.01;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TempoSegment {
    /// First downbeat of the segment, in seconds from the start of the
    /// analysed audio.
    pub start_seconds: f64,
    /// Quarter-note BPM, the unit `Song::bpm` uses whatever the meter.
    pub bpm: f64,
    pub beats_per_bar: u32,
    pub beat_unit: u32,
    /// Bars the segment spans (the last one may be incomplete).
    pub bars: u32,
    /// A tempo ramp: the tempo goes linearly (in time) from `bpm` at the
    /// start to this at the end of the segment's bars. None: steady.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_bpm: Option<f64>,
}

impl TempoSegment {
    /// Quarter notes in the segment's bars.
    pub fn quarters(&self) -> f64 {
        f64::from(self.bars) * f64::from(self.beats_per_bar) * 4.0 / f64::from(self.beat_unit)
    }

    /// How long its bars last: at its tempo, or at a ramp's average.
    pub fn duration_seconds(&self) -> f64 {
        match self.end_bpm {
            Some(end_bpm) => 120.0 * self.quarters() / (self.bpm + end_bpm),
            None => f64::from(self.bars) * self.bar_seconds(),
        }
    }

    pub fn signature(&self) -> String {
        format!("{}/{}", self.beats_per_bar, self.beat_unit)
    }

    pub fn beat_seconds(&self) -> f64 {
        240.0 / (self.bpm * f64::from(self.beat_unit))
    }

    pub fn bar_seconds(&self) -> f64 {
        self.beat_seconds() * f64::from(self.beats_per_bar)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ClickWarningKind {
    /// No click in the audio.
    NoClick,
    /// Every click sounds the same: where the bar starts is a guess.
    NoAccent,
    /// The click stops and starts again inside the song.
    ClickGap,
    /// The tempo changes bar after bar (ritardando, accelerando).
    VariableTempo,
    /// One bar of a different length between bars of the same meter.
    IrregularBar,
    /// Eighths accented every three were read as 6/8: which accent starts
    /// the bar is a guess.
    CompoundGuess,
    /// No click: the tempo was estimated from the music, and beat 1 is a
    /// guess.
    EstimatedWithoutClick,
    /// The music's pulse is weak: the tempo may be wrong, or double or half.
    UncertainTempo,
    /// The click's tempo jumped up and down bar after bar: it could not be
    /// read reliably, and the song got its dominant tempo instead.
    UnreliableClick,
    /// The click follows the band through a free passage: its tempo changes
    /// bar after bar, and the markers follow it.
    FreeTempo,
    /// The click has no accent and was read as eighths: one click in two is
    /// the beat (see `analyze_click_as_eighths`).
    ClickReadAsEighths,
    /// The click has no accent, and where the bar starts was taken from the
    /// guide's announcements instead of its first click (see `bar_phase`).
    DownbeatFromGuide,
    /// The click has no accent, and where the bar starts was taken from where
    /// its tempo changes instead of its first click (see `bar_phase`).
    DownbeatFromTempoChange,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClickWarning {
    pub seconds: f64,
    pub kind: ClickWarningKind,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClickAnalysis {
    pub segments: Vec<TempoSegment>,
    pub warnings: Vec<ClickWarning>,
    pub beat_count: usize,
    /// false: no accent, bars counted from the first click.
    pub downbeat_known: bool,
}

/// Analyse a mono click track. `fallback_beats_per_bar` is the meter used when
/// the click has no accent (normally the song's current numerator).
pub fn analyze_click(
    samples: &[f32],
    sample_rate: u32,
    fallback_beats_per_bar: u32,
) -> ClickAnalysis {
    analyze_click_reading(samples, sample_rate, fallback_beats_per_bar, false, None)
        .expect("the plain reading always exists")
}

/// `analyze_click`, or with `as_eighths` `analyze_click_as_eighths`, with the
/// song's guide analysed from the same render: a click without accent then
/// starts its bars where the announcements say (see `bar_phase`), not on its
/// first click.
pub fn analyze_click_with_guide(
    samples: &[f32],
    sample_rate: u32,
    fallback_beats_per_bar: u32,
    as_eighths: bool,
    guide: &GuideAnalysis,
) -> Option<ClickAnalysis> {
    analyze_click_reading(
        samples,
        sample_rate,
        fallback_beats_per_bar,
        as_eighths,
        Some(guide),
    )
}

/// The same click read as eighths: one click in two is the beat, at half the
/// tempo. A click without accent cannot tell a beat from an eighth (one every
/// 0.42 s is 142, or 71 in eighths: "Digno de adorar", Miel San Marcos, is
/// 71), and nothing in the audio settles it: the music's own pulse halved
/// real songs at 125-128 on real multitracks as readily as it got this one
/// right. So, as Ableton's ÷2 / ×2, the user picks. The beat is the first
/// click and every other one from there: a click starts on a beat. `None`
/// for a click with accent, whose accent already says where the beats are.
pub fn analyze_click_as_eighths(
    samples: &[f32],
    sample_rate: u32,
    fallback_beats_per_bar: u32,
) -> Option<ClickAnalysis> {
    analyze_click_reading(samples, sample_rate, fallback_beats_per_bar, true, None)
}

fn analyze_click_reading(
    samples: &[f32],
    sample_rate: u32,
    fallback_beats_per_bar: u32,
    as_eighths: bool,
    guide: Option<&GuideAnalysis>,
) -> Option<ClickAnalysis> {
    let onsets = detect_onsets(samples, sample_rate);
    let (beats, downbeat_known) = classify(&onsets);
    if as_eighths && downbeat_known {
        return None;
    }
    let mut warnings = Vec::new();
    let beats = if downbeat_known {
        beats
    } else {
        let beats = fold_subdivisions(beats, UNACCENTED_SUBDIVISION_MAX_SECONDS);
        if as_eighths {
            warnings.push(ClickWarning {
                seconds: beats.first().map_or(0.0, |b| b.seconds),
                kind: ClickWarningKind::ClickReadAsEighths,
            });
            beats.into_iter().step_by(2).collect()
        } else {
            beats
        }
    };
    if beats.len() < MIN_BEATS {
        warnings.push(ClickWarning {
            seconds: 0.0,
            kind: ClickWarningKind::NoClick,
        });
        return Some(ClickAnalysis {
            segments: Vec::new(),
            warnings,
            beat_count: beats.len(),
            downbeat_known: false,
        });
    }
    let mut pickup = 0;
    if !downbeat_known {
        warnings.push(ClickWarning {
            seconds: beats[0].seconds,
            kind: ClickWarningKind::NoAccent,
        });
        // The first run only: after a gap the click starts counting again,
        // and nothing says it comes back on the same beat of the bar.
        let first_run = (1..beats.len())
            .find(|&index| is_gap(&beats, index))
            .unwrap_or(beats.len());
        let times: Vec<f64> = beats[..first_run].iter().map(|b| b.seconds).collect();
        let beats_per_bar = fallback_beats_per_bar.max(1) as usize;
        // A jump in tempo is on a bar line: surer than the guide.
        let from_tempo = pickup_from_tempo_changes(&times, beats_per_bar);
        if let Some(found) = from_tempo {
            pickup = found;
            if pickup > 0 {
                warnings.push(ClickWarning {
                    seconds: times[pickup],
                    kind: ClickWarningKind::DownbeatFromTempoChange,
                });
            }
        }
        let found = guide.filter(|_| from_tempo.is_none()).and_then(|guide| {
            let found = pickup_from_guide(&times, beats_per_bar, guide);
            if as_eighths {
                return found;
            }
            // The same clicks as eighths: a guide that says where the bar
            // starts at that tempo is right about the plain reading too. At
            // the plain tempo the bar is half the real one, and the speech
            // ending on an off-beat click would pass for a downbeat.
            let eighths: Vec<f64> = times.iter().copied().step_by(2).collect();
            let alternate = pickup_from_guide(&eighths, beats_per_bar, guide).map(|mut phase| {
                phase.pickup = phase.pickup * 2 % beats_per_bar;
                phase
            });
            match (found, alternate) {
                (Some(direct), Some(other))
                    if direct.evidence >= other.evidence
                        && direct.evidence != GuideEvidence::Ends =>
                {
                    Some(direct)
                }
                (_, Some(other)) => Some(other),
                (direct, None) => direct,
            }
        });
        if let Some(found) = found {
            pickup = found.pickup;
            if pickup > 0 {
                warnings.push(ClickWarning {
                    seconds: times[pickup],
                    kind: ClickWarningKind::DownbeatFromGuide,
                });
            }
        }
    }
    Some(tempo_map_from_beats(
        &beats,
        downbeat_known,
        pickup,
        fallback_beats_per_bar,
        CLICK_TOLERANCES,
        warnings,
    ))
}

/// Beats (with their downbeats) to the analysis: bars, constant-tempo
/// segments that start on downbeats, and the warnings about them. Shared by
/// the click and by the tempo estimated from the music. Without known
/// downbeats, the first `pickup` beats come before the first bar.
pub(crate) fn tempo_map_from_beats(
    beats: &[Beat],
    downbeat_known: bool,
    pickup: usize,
    fallback_beats_per_bar: u32,
    tolerances: Tolerances,
    mut warnings: Vec<ClickWarning>,
) -> ClickAnalysis {
    let bars = build_bars(
        beats,
        downbeat_known,
        pickup,
        fallback_beats_per_bar.max(1),
        &mut warnings,
    );
    let mut segments = segment_bars(&bars, tolerances, &mut warnings);
    match erratic_span(&segments) {
        Some((from, to)) if misread_between(beats, from, to) => {
            // Dozens of markers that jump around are worse than one tempo
            // that is a little off: keep the dominant one and say so.
            segments = vec![dominant_segment(&segments)];
            warnings.retain(|w| w.kind != ClickWarningKind::IrregularBar);
            warnings.push(ClickWarning {
                seconds: from,
                kind: ClickWarningKind::UnreliableClick,
            });
        }
        Some((from, _)) => {
            // The click is right: the band plays free here. One warning for
            // the passage instead of one per drifting bar.
            flag_tempo_and_meter_oddities(&segments, &mut warnings);
            warnings.retain(|w| w.kind != ClickWarningKind::VariableTempo);
            warnings.push(ClickWarning {
                seconds: from,
                kind: ClickWarningKind::FreeTempo,
            });
        }
        None => flag_tempo_and_meter_oddities(&segments, &mut warnings),
    }
    warnings.sort_by(|a, b| a.seconds.total_cmp(&b.seconds));
    ClickAnalysis {
        segments,
        warnings,
        beat_count: beats.len(),
        downbeat_known,
    }
}

// ── 1. Clicks ───────────────────────────────────────────────────────────────

/// (seconds, level dB, apparent pitch Hz) of every click, for the
/// `analyze_click` example's `--onsets` dump. Not part of the analysis API.
#[doc(hidden)]
pub fn debug_onsets(samples: &[f32], sample_rate: u32) -> Vec<(f64, f64, f64)> {
    detect_onsets(samples, sample_rate)
        .into_iter()
        .map(|onset| (onset.seconds, onset.level_db, onset.pitch_octaves.exp2()))
        .collect()
}

#[derive(Debug, Clone, Copy)]
struct Onset {
    seconds: f64,
    level_db: f64,
    pitch_octaves: f64,
}

fn detect_onsets(samples: &[f32], sample_rate: u32) -> Vec<Onset> {
    let rate = f64::from(sample_rate.max(1));
    // A peak envelope at 1 ms: fine enough to find clicks, cheap on a whole song.
    let hop = ((rate / 1000.0).round() as usize).max(1);
    let envelope: Vec<f32> = samples
        .chunks(hop)
        .map(|chunk| chunk.iter().fold(0.0_f32, |max, x| max.max(x.abs())))
        .collect();
    let global_peak = envelope.iter().copied().fold(0.0_f32, f32::max);
    if global_peak < 1.0e-4 {
        return Vec::new();
    }
    // A click stem is mostly silence; the median is its noise floor (bleed,
    // dither). The 5 % floor keeps a quiet subdivision above the threshold.
    let threshold = (0.05 * global_peak).max(4.0 * median(&envelope));
    let release = 0.5 * threshold;
    let refractory_blocks = ((REFRACTORY_SECONDS * rate) as usize / hop).max(1);
    let window = ((FEATURE_WINDOW_SECONDS * rate) as usize).max(4);

    let mut onsets = Vec::new();
    let mut armed = true;
    let mut last_block: Option<usize> = None;
    for (block, &level) in envelope.iter().enumerate() {
        let in_refractory = last_block.is_some_and(|last| block < last + refractory_blocks);
        if !armed {
            // Re-arm only once the previous click's tail has died away.
            if level < release && !in_refractory {
                armed = true;
            }
            continue;
        }
        if level < threshold || in_refractory {
            continue;
        }
        armed = false;
        last_block = Some(block);

        let from = (block * hop).saturating_sub(2 * hop);
        let to = (block * hop + window).min(samples.len());
        let local_peak = samples[from..to]
            .iter()
            .fold(0.0_f32, |max, x| max.max(x.abs()));
        // The start, to the sample: the first one past a quarter of the peak.
        let onset = from
            + samples[from..to]
                .iter()
                .position(|x| x.abs() >= 0.25 * local_peak)
                .unwrap_or(0);
        let pitch_end = (onset + PITCH_WINDOW_FACTOR * window).min(samples.len());
        let frequency = click_pitch(&samples[onset..pitch_end], rate);
        onsets.push(Onset {
            seconds: onset as f64 / rate,
            level_db: 20.0 * f64::from(local_peak.max(1.0e-9)).log10(),
            pitch_octaves: frequency.max(1.0).log2(),
        });
    }
    onsets
}

/// Zero-padded FFT size for a click's pitch.
const PITCH_FFT_SIZE: usize = 8192;
/// The pitch is read on three feature windows (45 ms): the start can move a
/// millisecond with the render rate (a resampled click rings a little ahead
/// of itself), and on 15 ms that changed one alternating click's mean pitch
/// by 5 % (Dios de promesas at 48 kHz). The 24 real clicks give the same
/// tempo map at 22.05, 44.1 and 48 kHz with 45 ms, but not with 15 or 30.
const PITCH_WINDOW_FACTOR: usize = 3;
/// Band the pitch is read in: above hum and the click's thump, below what a
/// 22.05 kHz render still carries, so every render rate sees the same band.
const PITCH_BAND_HZ: (f64, f64) = (200.0, 8000.0);

/// Apparent pitch: the power-weighted mean of the click's spectrum, in
/// octaves. Two ways that pick one value were tried and both read one click
/// sound as two pitches with no spread between them, which `feature_levels`
/// takes for an accent: zero crossings (a period more or less in the window,
/// depending on where the samples fell: Eres Todopoderoso at 48 kHz gave
/// bars of 7/4, 1/4, 11/4 … where 44.1 kHz gave 4/4) and the strongest
/// partial (woodblocks with two partials of near equal strength, 757 and
/// 807 Hz, flip between them). A mean moves smoothly instead.
fn click_pitch(window: &[f32], rate: f64) -> f64 {
    if window.len() < 4 {
        return 0.0;
    }
    let size = PITCH_FFT_SIZE.max(window.len().next_power_of_two());
    let mut re = vec![0.0_f32; size];
    let mut im = vec![0.0_f32; size];
    let last = (window.len() - 1) as f32;
    for (i, &x) in window.iter().enumerate() {
        let hann = 0.5 - 0.5 * (std::f32::consts::TAU * i as f32 / last).cos();
        re[i] = x * hann;
    }
    fft(&mut re, &mut im);
    let bin_hz = rate / size as f64;
    let from = ((PITCH_BAND_HZ.0 / bin_hz).ceil() as usize).max(1);
    let to = ((PITCH_BAND_HZ.1.min(0.5 * rate) / bin_hz) as usize).min(size / 2);
    let (mut weighted, mut total) = (0.0_f64, 0.0_f64);
    for bin in from..to {
        let power = f64::from(re[bin] * re[bin] + im[bin] * im[bin]);
        weighted += power * (bin as f64 * bin_hz).log2();
        total += power;
    }
    if total <= 0.0 {
        return 0.0;
    }
    (weighted / total).exp2()
}

fn median(values: &[f32]) -> f32 {
    if values.is_empty() {
        return 0.0;
    }
    let mut sorted = values.to_vec();
    let middle = sorted.len() / 2;
    sorted.select_nth_unstable_by(middle, f32::total_cmp);
    sorted[middle]
}

// ── 2–3. Classes, subdivisions and downbeats ────────────────────────────────

#[derive(Debug, Clone, Copy)]
pub(crate) struct Beat {
    pub seconds: f64,
    pub downbeat: bool,
}

/// Spread of a sorted run, ignoring its outer 5 % on each side (a stray
/// click must not make a whole group look noisy).
fn spread(sorted: &[f64]) -> f64 {
    if sorted.len() < 2 {
        return 0.0;
    }
    let trim = sorted.len() / 20;
    sorted[sorted.len() - 1 - trim] - sorted[trim]
}

/// Levels of one feature (0 = lowest). A group is split at the jump between
/// two neighbours (in sorted order) when the jump is above `min_gap` AND well
/// above the spread inside both halves: a real click measures its own pitch
/// with ±10 % of noise, so a fixed threshold either misses quiet accents or
/// splits one sound in two at random. At most three levels; each must hold a
/// few clicks.
fn feature_levels(values: &[f64], min_gap: f64) -> Vec<usize> {
    let n = values.len();
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|a, b| values[*a].total_cmp(&values[*b]));
    let sorted: Vec<f64> = order.iter().map(|&index| values[index]).collect();
    let min_members = (n / 50).max(2);

    // Groups as [start, end) ranges of `sorted`.
    let mut groups: Vec<(usize, usize)> = vec![(0, n)];
    while groups.len() < 3 {
        let mut best: Option<(usize, usize, f64)> = None;
        for (group, &(start, end)) in groups.iter().enumerate() {
            if end - start < 2 * min_members {
                continue;
            }
            for split in (start + min_members)..=(end - min_members) {
                let gap = sorted[split] - sorted[split - 1];
                if gap <= min_gap {
                    continue;
                }
                let noise = spread(&sorted[start..split]).max(spread(&sorted[split..end]));
                let ratio = gap / noise.max(1.0e-9);
                if ratio > SPLIT_OVER_SPREAD && best.is_none_or(|(_, _, r)| ratio > r) {
                    best = Some((group, split, ratio));
                }
            }
        }
        let Some((group, split, _)) = best else { break };
        let (start, end) = groups[group];
        groups[group] = (start, split);
        groups.insert(group + 1, (split, end));
    }

    let mut levels = vec![0; n];
    for (level, &(start, end)) in groups.iter().enumerate() {
        for &index in &order[start..end] {
            levels[index] = level;
        }
    }
    levels
}

fn classify(onsets: &[Onset]) -> (Vec<Beat>, bool) {
    let n = onsets.len();
    let all_beats = |downbeat: &dyn Fn(usize) -> bool| -> Vec<Beat> {
        onsets
            .iter()
            .enumerate()
            .map(|(index, onset)| Beat {
                seconds: onset.seconds,
                downbeat: downbeat(index),
            })
            .collect()
    };
    if n < MIN_BEATS {
        return (all_beats(&|_| false), false);
    }

    let pitch = feature_levels(
        &onsets.iter().map(|o| o.pitch_octaves).collect::<Vec<_>>(),
        PITCH_GAP_OCTAVES,
    );
    let level = feature_levels(
        &onsets.iter().map(|o| o.level_db).collect::<Vec<_>>(),
        LEVEL_GAP_DB,
    );
    // Classes from most to least salient: higher pitch first, then louder.
    let mut keys: Vec<(usize, usize)> = (0..n).map(|i| (pitch[i], level[i])).collect();
    keys.sort_unstable();
    keys.dedup();
    keys.reverse();
    let class_of: Vec<usize> = (0..n)
        .map(|i| {
            keys.iter()
                .position(|key| *key == (pitch[i], level[i]))
                .unwrap_or(0)
        })
        .collect();
    let count = |class: usize| class_of.iter().filter(|c| **c == class).count();

    if keys.len() < 2 || count(0) * 10 > n * 6 {
        return (all_beats(&|_| false), false);
    }

    // Subdivisions: the least salient of three or more classes, if dropping
    // it leaves a regular grid with more beats than accents. With only two
    // classes "accent + beats" and "beats + subdivisions" look the same, and
    // the tempo check below sorts them out.
    let mut keep: Vec<bool> = vec![true; n];
    if keys.len() >= 3 {
        let weakest = keys.len() - 1;
        let accents = count(0);
        let weak = count(weakest);
        let rest = n - weak;
        let rest_times: Vec<f64> = (0..n)
            .filter(|i| class_of[*i] != weakest)
            .map(|i| onsets[i].seconds)
            .collect();
        if (rest - accents) as f64 >= 1.5 * accents as f64
            && weak as f64 >= 0.9 * rest as f64
            && is_regular(&rest_times)
        {
            for (index, class) in class_of.iter().enumerate() {
                if *class == weakest {
                    keep[index] = false;
                }
            }
        }
    }

    let beats: Vec<Beat> = (0..n)
        .filter(|i| keep[*i])
        .map(|i| Beat {
            seconds: onsets[i].seconds,
            downbeat: class_of[i] == 0,
        })
        .collect();

    // Strong and weak clicks taking turns are a beat and its off-beat (a
    // ballad at 79 clicked in eighths), not bars of two: seen on real
    // multitracks, where a 2/4 bar accent is the rare case. Kept as bars only
    // when the "beat" would be slower than 40 BPM.
    let accent_times: Vec<f64> = beats
        .iter()
        .filter(|b| b.downbeat)
        .map(|b| b.seconds)
        .collect();
    let accent_period = median_interval(&accent_times);
    let beats_per_accent = beats.len() as f64 / accent_times.len().max(1) as f64;
    if accent_period.is_some_and(|period| (0.3..=1.5).contains(&period))
        && (beats_per_accent - 2.0).abs() < 0.25
    {
        let beats = without_stray_offbeats(&accent_times, accent_period.unwrap_or(0.0))
            .into_iter()
            .map(|seconds| Beat {
                seconds,
                downbeat: false,
            })
            .collect();
        return (beats, false);
    }
    (fold_subdivisions(beats, SUBDIVISION_MAX_SECONDS), true)
}

/// An off-beat louder than the rest passes for a beat: "La bondad de Dios"
/// (Church of the City, 68 in eighths) has one 6 ms early and louder, which
/// put a beat of 104 in a bar and every bar after it a beat off. One that
/// falls between two beats a beat apart is that off-beat.
fn without_stray_offbeats(times: &[f64], period: f64) -> Vec<f64> {
    if !(period > 0.0) {
        return times.to_vec();
    }
    let mut kept: Vec<f64> = Vec::with_capacity(times.len());
    for (index, &time) in times.iter().enumerate() {
        let stray = kept
            .last()
            .zip(times.get(index + 1))
            .is_some_and(|(&last, &next)| {
                time - last < STRAY_OFFBEAT_SHARE * period
                    && ((next - last) - period).abs() <= STRAY_BEAT_TOLERANCE * period
            });
        if !stray {
            kept.push(time);
        }
    }
    kept
}

/// Keep every other click, counted from each accent, while the clicks are
/// too fast to be beats: under `SUBDIVISION_MAX_SECONDS` apart, or 8 or 16 to
/// an accent (eighths of a 4/4 that all sound alike).
fn fold_subdivisions(mut beats: Vec<Beat>, max_subdivision_seconds: f64) -> Vec<Beat> {
    for _ in 0..3 {
        let times: Vec<f64> = beats.iter().map(|b| b.seconds).collect();
        let Some(period) = median_interval(&times) else {
            break;
        };
        let accents = beats.iter().filter(|b| b.downbeat).count().max(1);
        let per_accent = (beats.len() as f64 / accents as f64).round() as usize;
        let accented = beats.iter().any(|b| b.downbeat);
        let too_fast = period < max_subdivision_seconds
            || (accented && matches!(per_accent, 8 | 16) && period < COMPOUND_EIGHTH_MAX_SECONDS);
        if !too_fast || (accented && per_accent % 2 != 0) {
            break;
        }
        let mut offset = 0_usize;
        beats.retain(|beat| {
            if beat.downbeat {
                offset = 0;
            }
            let keep = offset % 2 == 0;
            offset += 1;
            keep
        });
    }
    beats
}

fn median_interval(times: &[f64]) -> Option<f64> {
    if times.len() < 2 {
        return None;
    }
    let mut intervals: Vec<f64> = times.windows(2).map(|w| w[1] - w[0]).collect();
    intervals.sort_by(f64::total_cmp);
    Some(intervals[intervals.len() / 2])
}

/// At least 80 % of the intervals within 20 % of the median.
fn is_regular(times: &[f64]) -> bool {
    let Some(median) = median_interval(times) else {
        return false;
    };
    let intervals: Vec<f64> = times.windows(2).map(|w| w[1] - w[0]).collect();
    let close = intervals
        .iter()
        .filter(|interval| (**interval - median).abs() <= 0.2 * median)
        .count();
    close * 5 >= intervals.len() * 4
}

// ── 4. Bars and segments ────────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct Bar {
    beats: Vec<f64>,
    /// The next bar starts right where this one ends (no gap in the click).
    continues: bool,
}

/// A gap: an interval much longer than the ones around it. A tempo halving is
/// not a gap, because the interval after it is just as long.
fn is_gap(beats: &[Beat], index: usize) -> bool {
    let interval = beats[index].seconds - beats[index - 1].seconds;
    let previous = (index >= 2).then(|| beats[index - 1].seconds - beats[index - 2].seconds);
    let next = beats
        .get(index + 1)
        .map(|beat| beat.seconds - beats[index].seconds);
    match (previous, next) {
        (Some(p), Some(n)) => interval > 1.8 * p && interval > 1.8 * n,
        (Some(p), None) => interval > 1.8 * p,
        (None, Some(n)) => interval > 1.8 * n,
        (None, None) => false,
    }
}

fn build_bars(
    beats: &[Beat],
    downbeat_known: bool,
    pickup: usize,
    fallback_beats_per_bar: u32,
    warnings: &mut Vec<ClickWarning>,
) -> Vec<Bar> {
    let mut bars: Vec<Bar> = Vec::new();
    let mut current: Option<Bar> = None;
    for (index, beat) in beats.iter().enumerate() {
        let gap = index > 0 && is_gap(beats, index);
        if gap {
            warnings.push(ClickWarning {
                seconds: beats[index - 1].seconds,
                kind: ClickWarningKind::ClickGap,
            });
            if let Some(mut bar) = current.take() {
                bar.continues = false;
                bars.push(bar);
            }
        }
        let starts_bar = match &current {
            // Before any bar (the first run, or after a gap). The pickup
            // only counts in the first run, before any bar was cut.
            None if downbeat_known => beat.downbeat,
            None => !(bars.is_empty() && index < pickup),
            Some(bar) => {
                if downbeat_known {
                    beat.downbeat
                } else {
                    bar.beats.len() as u32 >= fallback_beats_per_bar
                }
            }
        };
        if starts_bar {
            if let Some(bar) = current.take() {
                bars.push(bar);
            }
            current = Some(Bar {
                beats: vec![beat.seconds],
                continues: true,
            });
        } else if let Some(bar) = current.as_mut() {
            bar.beats.push(beat.seconds);
        }
        // Beats before the first downbeat (a pickup) belong to no bar.
    }
    if let Some(mut bar) = current {
        bar.continues = false;
        bars.push(bar);
    }
    bars
}

/// Least-squares line through `times` against their index: (intercept,
/// period, largest residual).
fn fit_line(times: &[f64]) -> (f64, f64, f64) {
    let n = times.len() as f64;
    if times.len() < 2 {
        return (times.first().copied().unwrap_or(0.0), 0.0, 0.0);
    }
    let mean_k = (n - 1.0) / 2.0;
    let mean_t = times.iter().sum::<f64>() / n;
    let mut covariance = 0.0;
    let mut variance = 0.0;
    for (k, t) in times.iter().enumerate() {
        let dk = k as f64 - mean_k;
        covariance += dk * (t - mean_t);
        variance += dk * dk;
    }
    let period = covariance / variance;
    let intercept = mean_t - period * mean_k;
    let residual = times
        .iter()
        .enumerate()
        .map(|(k, t)| (t - (intercept + period * k as f64)).abs())
        .fold(0.0, f64::max);
    (intercept, period, residual)
}

struct SegmentDraft {
    times: Vec<f64>,
    beats_per_bar: u32,
    bars: u32,
}

fn segment_bars(
    bars: &[Bar],
    tolerances: Tolerances,
    warnings: &mut Vec<ClickWarning>,
) -> Vec<TempoSegment> {
    let mut drafts: Vec<SegmentDraft> = Vec::new();
    let mut current: Option<SegmentDraft> = None;
    let mut previous_continues = false;
    for bar in bars {
        let length = bar.beats.len() as u32;
        let joins = current.as_ref().is_some_and(|draft| {
            // The last bar before a gap or the end may be cut short.
            let fits_meter = if bar.continues {
                length == draft.beats_per_bar
            } else {
                length <= draft.beats_per_bar
            };
            previous_continues && fits_meter && {
                let mut times = draft.times.clone();
                times.extend_from_slice(&bar.beats);
                fit_line(&times).2 <= tolerances.fit_residual
            }
        });
        if joins {
            if let Some(draft) = current.as_mut() {
                draft.times.extend_from_slice(&bar.beats);
                draft.bars += 1;
            }
        } else {
            // A last bar cut short (the song's final hit after a ritardando)
            // keeps the meter it was in.
            let beats_per_bar = match current.as_ref() {
                Some(previous) if !bar.continues && length < previous.beats_per_bar => {
                    previous.beats_per_bar
                }
                _ => length,
            };
            if let Some(draft) = current.take() {
                drafts.push(draft);
            }
            current = Some(SegmentDraft {
                times: bar.beats.clone(),
                beats_per_bar,
                bars: 1,
            });
        }
        previous_continues = bar.continues;
    }
    if let Some(draft) = current {
        drafts.push(draft);
    }

    let mut segments: Vec<TempoSegment> = Vec::new();
    for draft in drafts {
        let period = if draft.times.len() >= 2 {
            fit_line(&draft.times).1
        } else if let Some(previous) = segments.last() {
            // A lone click (a final hit): the tempo it was played at.
            previous.beat_seconds()
        } else {
            continue;
        };
        if !(period.is_finite() && period > 0.0) {
            continue;
        }
        // Compound meters are clicked in eighths: 6, 9 or 12 fast clicks a
        // bar, or an accent every 3 (on 1 and 4 of a 6/8).
        let compound = period < COMPOUND_EIGHTH_MAX_SECONDS;
        let (beats_per_bar, beat_unit, bars) = match draft.beats_per_bar.max(1) {
            n @ (6 | 9 | 12) if compound => (n, 8, draft.bars),
            3 if compound => (6, 8, draft.bars.div_ceil(2)),
            n => (n, 4, draft.bars),
        };
        let (fitted_start, bpm) =
            round_tempo(&draft.times, period, beat_unit, tolerances.rounding_drift);
        let start_seconds = if tolerances.start_on_first_beat {
            draft.times[0]
        } else {
            fitted_start
        };
        if draft.beats_per_bar == 3 && beat_unit == 8 {
            warnings.push(ClickWarning {
                seconds: start_seconds,
                kind: ClickWarningKind::CompoundGuess,
            });
        }
        segments.push(TempoSegment {
            start_seconds,
            bpm,
            beats_per_bar,
            beat_unit,
            bars,
            end_bpm: None,
        });
    }
    segments
}

/// The coarsest BPM (whole, half, tenth, hundredth) that still lands every
/// beat within `max_drift`, and the start that goes with it.
fn round_tempo(times: &[f64], period: f64, beat_unit: u32, max_drift: f64) -> (f64, f64) {
    let unit = f64::from(beat_unit);
    let raw_bpm = 240.0 / (period * unit);
    let fit = |bpm: f64| {
        let rounded_period = 240.0 / (bpm * unit);
        let intercept = times
            .iter()
            .enumerate()
            .map(|(k, t)| t - k as f64 * rounded_period)
            .sum::<f64>()
            / times.len().max(1) as f64;
        let drift = times
            .iter()
            .enumerate()
            .map(|(k, t)| (t - (intercept + k as f64 * rounded_period)).abs())
            .fold(0.0, f64::max);
        (intercept, drift)
    };
    let mut fallback = None;
    for step in [1.0, 0.5, 0.1, 0.01] {
        let bpm = (raw_bpm / step).round() * step;
        // Strip float noise: 92.50000000001 → 92.5.
        let bpm = (bpm * 100.0).round() / 100.0;
        let (intercept, drift) = fit(bpm);
        if drift <= max_drift || times.len() < 2 {
            return (intercept, bpm);
        }
        fallback = Some((intercept, bpm));
    }
    fallback.unwrap_or((times.first().copied().unwrap_or(0.0), raw_bpm))
}

/// Whether the beats in `from..=to` wobble (see `MISREAD_INTERVAL_SHARE`).
fn misread_between(beats: &[Beat], from: f64, to: f64) -> bool {
    let times: Vec<f64> = beats
        .iter()
        .map(|b| b.seconds)
        .filter(|t| (from - 1.0e-3..=to + 1.0e-3).contains(t))
        .collect();
    let intervals: Vec<f64> = times.windows(2).map(|w| w[1] - w[0]).collect();
    if intervals.len() < 2 {
        return false;
    }
    let steps = intervals
        .windows(2)
        .filter(|pair| (pair[1] / pair[0] - 1.0).abs() > MISREAD_INTERVAL_STEP)
        .count();
    steps as f64 > MISREAD_INTERVAL_SHARE * (intervals.len() - 1) as f64
}

/// The stretch where the tempo map jumps around, if it does (see
/// `ERRATIC_MIN_SHORT_CHANGES`): from the first short change to the end of
/// the last one.
fn erratic_span(segments: &[TempoSegment]) -> Option<(f64, f64)> {
    let mut short_changes = 0;
    let mut reversals = 0;
    let mut last_direction = 0.0_f64;
    let mut first_change: Option<f64> = None;
    let mut last_change_end = 0.0_f64;
    for pair in segments.windows(2) {
        let [before, after] = pair else {
            continue;
        };
        let change = (after.bpm - before.bpm) / before.bpm;
        if change.abs() <= ERRATIC_CHANGE_FRACTION {
            continue;
        }
        if after.bars <= ERRATIC_SHORT_BARS || before.bars <= ERRATIC_SHORT_BARS {
            short_changes += 1;
            first_change.get_or_insert(after.start_seconds);
            last_change_end = after.start_seconds + f64::from(after.bars) * after.bar_seconds();
        }
        let direction = change.signum();
        if last_direction != 0.0 && direction != last_direction {
            reversals += 1;
        }
        last_direction = direction;
    }
    let from = first_change?;
    (short_changes >= ERRATIC_MIN_SHORT_CHANGES && reversals >= ERRATIC_MIN_REVERSALS)
        .then_some((from, last_change_end))
}

/// The tempo most of the song's bars agree on, as one segment anchored on
/// the longest run at that tempo and spanning the whole click.
fn dominant_segment(segments: &[TempoSegment]) -> TempoSegment {
    let beats = |s: &TempoSegment| f64::from(s.bars) * f64::from(s.beats_per_bar);
    let support = |bpm: f64| {
        segments
            .iter()
            .filter(|s| ((s.bpm - bpm) / bpm).abs() <= SAME_TEMPO_FRACTION)
            .map(beats)
            .sum::<f64>()
    };
    let dominant_bpm = segments
        .iter()
        .map(|s| s.bpm)
        .max_by(|a, b| support(*a).total_cmp(&support(*b)))
        .unwrap_or(120.0);
    // Ties go to the earliest run (`max_by` keeps the last of equals).
    let anchor = segments
        .iter()
        .rev()
        .filter(|s| ((s.bpm - dominant_bpm) / dominant_bpm).abs() <= SAME_TEMPO_FRACTION)
        .max_by(|a, b| beats(a).total_cmp(&beats(b)))
        .unwrap_or(&segments[0]);
    let end = segments
        .iter()
        .map(|s| s.start_seconds + f64::from(s.bars) * s.bar_seconds())
        .fold(anchor.start_seconds, f64::max);
    let mut segment = anchor.clone();
    // Back to the first click on the anchor's grid, so the bars before it
    // line up too (the proposal carries it to the song start).
    let first = segments[0].start_seconds;
    let bar = segment.bar_seconds();
    if bar > 0.0 {
        let bars_before = ((segment.start_seconds - first) / bar).floor().max(0.0);
        segment.start_seconds -= bars_before * bar;
        segment.bars = (((end - segment.start_seconds) / bar).ceil() as u32).max(1);
    }
    segment
}

fn flag_tempo_and_meter_oddities(segments: &[TempoSegment], warnings: &mut Vec<ClickWarning>) {
    // Three or more one-bar segments in a row: the tempo is drifting.
    let mut run_start: Option<usize> = None;
    for index in 0..=segments.len() {
        let short = segments.get(index).is_some_and(|s| s.bars == 1);
        match (short, run_start) {
            (true, None) => run_start = Some(index),
            (false, Some(start)) => {
                if index - start >= 3 {
                    warnings.push(ClickWarning {
                        seconds: segments[start].start_seconds,
                        kind: ClickWarningKind::VariableTempo,
                    });
                }
                run_start = None;
            }
            _ => {}
        }
    }
    // A lone bar of another meter between two of the same.
    for window in segments.windows(3) {
        let [before, odd, after] = window else {
            continue;
        };
        if odd.bars == 1
            && before.beats_per_bar == after.beats_per_bar
            && odd.beats_per_bar != before.beats_per_bar
        {
            warnings.push(ClickWarning {
                seconds: odd.start_seconds,
                kind: ClickWarningKind::IrregularBar,
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: u32 = 48_000;
    const HIGH: f64 = 1500.0;
    const LOW: f64 = 1000.0;

    /// A click: a decaying sine burst, like most generated click sounds.
    fn add_click(buffer: &mut [f32], seconds: f64, frequency: f64, amplitude: f32) {
        let start = (seconds * f64::from(RATE)).round() as usize;
        let length = (0.030 * f64::from(RATE)) as usize;
        for i in 0..length {
            let Some(sample) = buffer.get_mut(start + i) else {
                break;
            };
            let t = i as f64 / f64::from(RATE);
            let envelope = (-t / 0.006).exp();
            *sample +=
                amplitude * (envelope * (std::f64::consts::TAU * frequency * t).sin()) as f32;
        }
    }

    struct Click {
        seconds: f64,
        frequency: f64,
        amplitude: f32,
    }

    fn render(clicks: &[Click]) -> Vec<f32> {
        let end = clicks.iter().map(|c| c.seconds).fold(0.0, f64::max) + 1.0;
        let mut buffer = vec![0.0_f32; (end * f64::from(RATE)) as usize];
        for click in clicks {
            add_click(&mut buffer, click.seconds, click.frequency, click.amplitude);
        }
        buffer
    }

    /// `bars` bars at `bpm` (beat-unit BPM) from `start`, accent on beat 1.
    fn bars_at(start: f64, bpm: f64, beats_per_bar: u32, bars: u32) -> (Vec<Click>, f64) {
        let period = 60.0 / bpm;
        let mut clicks = Vec::new();
        let mut t = start;
        for _ in 0..bars {
            for beat in 0..beats_per_bar {
                clicks.push(Click {
                    seconds: t,
                    frequency: if beat == 0 { HIGH } else { LOW },
                    amplitude: 0.8,
                });
                t += period;
            }
        }
        (clicks, t)
    }

    fn assert_close(actual: f64, expected: f64, tolerance: f64) {
        assert!(
            (actual - expected).abs() <= tolerance,
            "expected {expected}, got {actual}"
        );
    }

    fn kinds(analysis: &ClickAnalysis) -> Vec<ClickWarningKind> {
        analysis.warnings.iter().map(|w| w.kind).collect()
    }

    #[test]
    fn a_loud_offbeat_is_not_a_beat() {
        // Real ("La bondad de Dios", 68): the off-beat after 127.087 s came
        // 6 ms early and loud enough to pass for a beat.
        let beat = 60.0 / 68.0;
        let mut times: Vec<f64> = (0..12).map(|i| 120.0 + i as f64 * beat).collect();
        times.insert(5, 120.0 + 4.5 * beat - 0.006);
        let kept = without_stray_offbeats(&times, beat);
        assert_eq!(kept.len(), 12);
        assert!(kept.windows(2).all(|w| ((w[1] - w[0]) - beat).abs() < 1e-9));
        // A real tempo change keeps every beat.
        let faster: Vec<f64> = (0..6)
            .map(|i| 120.0 + i as f64 * beat)
            .chain((1..6).map(|i| 120.0 + 5.0 * beat + i as f64 * beat * 0.7))
            .collect();
        assert_eq!(without_stray_offbeats(&faster, beat), faster);
    }

    #[test]
    fn steady_four_four_click_is_one_segment() {
        let (clicks, _) = bars_at(0.5, 120.0, 4, 16);
        let analysis = analyze_click(&render(&clicks), RATE, 4);
        assert!(analysis.downbeat_known);
        assert_eq!(analysis.segments.len(), 1, "{analysis:?}");
        let segment = &analysis.segments[0];
        assert_eq!(segment.bpm, 120.0);
        assert_eq!(segment.signature(), "4/4");
        assert_eq!(segment.bars, 16);
        assert_close(segment.start_seconds, 0.5, 0.001);
        assert!(analysis.warnings.is_empty(), "{:?}", analysis.warnings);
    }

    #[test]
    fn one_click_sound_between_samples_is_not_an_accent() {
        // Real (Eres Todopoderoso rendered at 48 kHz): one recorded click,
        // starting at a different point of its wave each time, read as 1667
        // and 1733 Hz with no spread between them, and became bars of 7/4,
        // 1/4, 11/4 … This sound read as 1667 and 1700 Hz the same way.
        let period = 60.0 / 130.0;
        let mut buffer = vec![0.0_f32; (34.0 * f64::from(RATE)) as usize];
        for beat in 0..64 {
            let seconds = 0.5 + beat as f64 * period + beat as f64 * 0.000_013_7;
            let first = (seconds * f64::from(RATE)).ceil() as usize;
            for (i, sample) in buffer[first..first + 1440].iter_mut().enumerate() {
                let t = (first + i) as f64 / f64::from(RATE) - seconds;
                let phase = beat as f64 * 0.9;
                let tone = (std::f64::consts::TAU * 1700.0 * t + phase).sin() + 0.2;
                let attack = (t / 0.001).min(1.0);
                *sample += (0.5 * attack * (-t / 0.006).exp() * tone) as f32;
            }
        }
        // One sound, one pitch: well inside the gap that splits two.
        let pitches: Vec<f64> = detect_onsets(&buffer, RATE)
            .iter()
            .map(|onset| onset.pitch_octaves)
            .collect();
        assert_eq!(pitches.len(), 64);
        let (low, high) = pitches
            .iter()
            .fold((f64::MAX, f64::MIN), |(lo, hi), p| (lo.min(*p), hi.max(*p)));
        assert!(
            high - low < PITCH_GAP_OCTAVES / 3.0,
            "{} .. {} Hz",
            low.exp2(),
            high.exp2()
        );
        let analysis = analyze_click(&buffer, RATE, 4);
        assert!(!analysis.downbeat_known, "{analysis:?}");
        assert_eq!(analysis.segments[0].bpm, 130.0);
    }

    #[test]
    fn accent_every_three_beats_is_three_four() {
        let (clicks, _) = bars_at(0.0, 100.0, 3, 12);
        let analysis = analyze_click(&render(&clicks), RATE, 4);
        assert_eq!(analysis.segments.len(), 1, "{analysis:?}");
        assert_eq!(analysis.segments[0].bpm, 100.0);
        assert_eq!(analysis.segments[0].signature(), "3/4");
    }

    #[test]
    fn tempo_change_starts_a_segment_on_the_new_downbeat() {
        let (mut clicks, end) = bars_at(0.5, 120.0, 4, 8);
        let (more, _) = bars_at(end, 90.0, 4, 8);
        clicks.extend(more);
        let analysis = analyze_click(&render(&clicks), RATE, 4);
        assert_eq!(analysis.segments.len(), 2, "{analysis:?}");
        assert_eq!(analysis.segments[0].bpm, 120.0);
        assert_eq!(analysis.segments[0].bars, 8);
        assert_eq!(analysis.segments[1].bpm, 90.0);
        assert_close(analysis.segments[1].start_seconds, 0.5 + 8.0 * 2.0, 0.001);
    }

    #[test]
    fn six_fast_clicks_per_bar_is_six_eight_in_quarter_bpm() {
        // Eighths at 0.25 s: quarter = 0.5 s = 120 BPM.
        let (clicks, _) = bars_at(0.0, 240.0, 6, 8);
        let analysis = analyze_click(&render(&clicks), RATE, 4);
        assert_eq!(analysis.segments.len(), 1, "{analysis:?}");
        assert_eq!(analysis.segments[0].signature(), "6/8");
        assert_eq!(analysis.segments[0].bpm, 120.0);
    }

    #[test]
    fn quieter_subdivisions_are_ignored() {
        let (mut clicks, _) = bars_at(0.0, 100.0, 4, 8);
        let half = 0.3;
        let offbeats: Vec<Click> = clicks
            .iter()
            .map(|c| Click {
                seconds: c.seconds + half,
                frequency: LOW,
                amplitude: 0.25,
            })
            .collect();
        clicks.extend(offbeats);
        clicks.sort_by(|a, b| a.seconds.total_cmp(&b.seconds));
        let analysis = analyze_click(&render(&clicks), RATE, 4);
        assert_eq!(analysis.segments.len(), 1, "{analysis:?}");
        assert_eq!(analysis.segments[0].bpm, 100.0);
        assert_eq!(analysis.segments[0].signature(), "4/4");
    }

    #[test]
    fn click_without_accent_keeps_the_fallback_meter_and_warns() {
        let clicks: Vec<Click> = (0..32)
            .map(|i| Click {
                seconds: 0.25 + i as f64 * 0.5,
                frequency: LOW,
                amplitude: 0.8,
            })
            .collect();
        let analysis = analyze_click(&render(&clicks), RATE, 3);
        assert!(!analysis.downbeat_known);
        assert!(kinds(&analysis).contains(&ClickWarningKind::NoAccent));
        assert_eq!(analysis.segments.len(), 1, "{analysis:?}");
        assert_eq!(analysis.segments[0].bpm, 120.0);
        assert_eq!(analysis.segments[0].signature(), "3/4");
        assert_close(analysis.segments[0].start_seconds, 0.25, 0.001);
    }

    #[test]
    fn silence_is_no_click() {
        let analysis = analyze_click(&vec![0.0; RATE as usize * 5], RATE, 4);
        assert!(analysis.segments.is_empty());
        assert_eq!(kinds(&analysis), vec![ClickWarningKind::NoClick]);
    }

    #[test]
    fn half_bpm_is_kept_when_the_click_needs_it() {
        let (clicks, _) = bars_at(0.0, 92.5, 4, 16);
        let analysis = analyze_click(&render(&clicks), RATE, 4);
        assert_eq!(analysis.segments.len(), 1, "{analysis:?}");
        assert_eq!(analysis.segments[0].bpm, 92.5);
    }

    #[test]
    fn ritardando_warns_of_variable_tempo() {
        let (mut clicks, mut t) = bars_at(0.0, 120.0, 4, 8);
        let mut period = 0.5;
        for _ in 0..5 {
            for beat in 0..4 {
                clicks.push(Click {
                    seconds: t,
                    frequency: if beat == 0 { HIGH } else { LOW },
                    amplitude: 0.8,
                });
                t += period;
                period *= 1.04;
            }
        }
        let analysis = analyze_click(&render(&clicks), RATE, 4);
        assert!(
            kinds(&analysis).contains(&ClickWarningKind::VariableTempo),
            "{analysis:?}"
        );
        assert_eq!(analysis.segments[0].bpm, 120.0);
    }

    #[test]
    fn a_live_click_through_a_free_passage_keeps_its_markers() {
        let (mut clicks, mut t) = bars_at(0.0, 120.0, 4, 8);
        for bpm in [114.0, 128.0, 116.0, 131.0, 118.0] {
            let (more, end) = bars_at(t, bpm, 4, 2);
            clicks.extend(more);
            t = end;
        }
        let (more, _) = bars_at(t, 120.0, 4, 8);
        clicks.extend(more);
        let analysis = analyze_click(&render(&clicks), RATE, 4);
        let bpms: Vec<f64> = analysis.segments.iter().map(|s| s.bpm).collect();
        assert_eq!(bpms, [120.0, 114.0, 128.0, 116.0, 131.0, 118.0, 120.0]);
        assert!(
            kinds(&analysis).contains(&ClickWarningKind::FreeTempo),
            "{analysis:?}"
        );
        assert!(!kinds(&analysis).contains(&ClickWarningKind::UnreliableClick));
        assert!(!kinds(&analysis).contains(&ClickWarningKind::VariableTempo));
    }

    #[test]
    fn a_wobbling_click_gets_its_dominant_tempo() {
        let (mut clicks, end) = bars_at(0.0, 120.0, 4, 8);
        // Onsets smeared ±30 ms (bleed, a sloppy click) for 12 bars.
        let (mut middle, end) = bars_at(end, 120.0, 4, 12);
        let mut seed = 7_u32;
        for click in &mut middle {
            seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12_345);
            let unit = f64::from(seed >> 16 & 0x7fff) / f64::from(0x7fff);
            click.seconds += (unit - 0.5) * 0.06;
        }
        clicks.extend(middle);
        let (more, _) = bars_at(end, 120.0, 4, 8);
        clicks.extend(more);
        let analysis = analyze_click(&render(&clicks), RATE, 4);
        assert_eq!(analysis.segments.len(), 1, "{analysis:?}");
        assert_eq!(analysis.segments[0].bpm, 120.0);
        assert_close(analysis.segments[0].start_seconds, 0.0, 0.001);
        assert!(
            kinds(&analysis).contains(&ClickWarningKind::UnreliableClick),
            "{analysis:?}"
        );
        assert!(!kinds(&analysis).contains(&ClickWarningKind::VariableTempo));
    }

    /// Clicks all alike every `period` from `start`.
    fn unaccented(start: f64, period: f64, count: usize) -> Vec<Click> {
        (0..count)
            .map(|i| Click {
                seconds: start + i as f64 * period,
                frequency: LOW,
                amplitude: 0.8,
            })
            .collect()
    }

    #[test]
    fn an_unaccented_click_can_be_read_as_eighths() {
        // "Digno de adorar": a click every 0.4225 s (142), the song at 71.
        let eighth = 60.0 / 142.0;
        let samples = render(&unaccented(0.5, eighth, 160));
        assert_eq!(analyze_click(&samples, RATE, 4).segments[0].bpm, 142.0);
        let eighths = analyze_click_as_eighths(&samples, RATE, 4).expect("no accent");
        assert_eq!(eighths.segments.len(), 1, "{eighths:?}");
        assert_eq!(eighths.segments[0].bpm, 71.0);
        assert_close(eighths.segments[0].start_seconds, 0.5, 0.002);
        assert_eq!(eighths.segments[0].bars, 20);
        assert!(kinds(&eighths).contains(&ClickWarningKind::ClickReadAsEighths));
    }

    /// A guide whose announcements end half a beat before the downbeats
    /// at `first_downbeat + k * bar`, every four bars.
    fn guide_ending_before(
        first_downbeat: f64,
        bar: f64,
        beat: f64,
        count: usize,
    ) -> GuideAnalysis {
        GuideAnalysis {
            announcements: (0..count)
                .map(|k| {
                    let downbeat = first_downbeat + (4 * k + 2) as f64 * bar;
                    crate::guide::GuideAnnouncement {
                        start_seconds: downbeat - bar,
                        end_seconds: downbeat - beat / 2.0,
                        group: 0,
                        count_words: Vec::new(),
                    }
                })
                .collect(),
            groups: Vec::new(),
        }
    }

    #[test]
    fn an_unaccented_click_starts_its_bars_where_the_guide_says() {
        // "Es Él": a click in eighths at 140 for a song at 70 whose bar 1
        // comes two beats after the first click.
        let eighth = 60.0 / 140.0;
        let samples = render(&unaccented(0.0, eighth, 400));
        let beat = 2.0 * eighth;
        let guide = guide_ending_before(2.0 * beat, 4.0 * beat, beat, 10);
        let eighths = analyze_click_with_guide(&samples, RATE, 4, true, &guide).expect("no accent");
        assert_eq!(eighths.segments[0].bpm, 70.0);
        assert_close(eighths.segments[0].start_seconds, 2.0 * beat, 0.002);
        assert!(kinds(&eighths).contains(&ClickWarningKind::DownbeatFromGuide));
        // Read at 140 its bars are half the real one; they still start on a
        // real downbeat, not on the off-beat click the speech ends on.
        let plain = analyze_click_with_guide(&samples, RATE, 4, false, &guide).expect("plain");
        assert_eq!(plain.segments[0].bpm, 140.0);
        let bar = 4.0 * eighth;
        let phase = (plain.segments[0].start_seconds / bar).fract();
        assert!(phase < 0.01 || phase > 0.99, "{plain:?}");
        // Without the guide the bars count from the first click, as before.
        let unguided = analyze_click_as_eighths(&samples, RATE, 4).expect("no accent");
        assert_close(unguided.segments[0].start_seconds, 0.0, 0.002);
    }

    #[test]
    fn an_accented_click_has_no_eighths_reading() {
        let (clicks, _) = bars_at(0.5, 142.0, 4, 16);
        assert!(analyze_click_as_eighths(&render(&clicks), RATE, 4).is_none());
    }

    #[test]
    fn half_tempo_word_tails_do_not_override_section_start_consensus() {
        let beat = 60.0 / 148.0;
        let samples = render(&unaccented(0.0, beat, 200));
        let mut guide = guide_ending_before(beat, 4.0 * beat, beat, 8);
        for announcement in &mut guide.announcements {
            announcement.end_seconds = announcement.start_seconds + 2.0 * beat;
        }
        guide.groups.push(crate::guide::GuideGroup {
            labels: vec!["chorus".to_string()],
            transcript: None,
            match_cost: None,
            counted_in: false,
            occurrences: 8,
            first_start_seconds: guide.announcements[0].start_seconds,
            first_end_seconds: guide.announcements[0].end_seconds,
        });
        let plain = analyze_click_with_guide(&samples, RATE, 4, false, &guide).unwrap();
        assert_eq!(plain.segments[0].bpm, 148.0);
        assert_close(plain.segments[0].start_seconds, beat, 0.002);
        assert!(kinds(&plain).contains(&ClickWarningKind::DownbeatFromGuide));
    }

    #[test]
    fn a_few_real_tempo_changes_are_kept() {
        let (mut clicks, mut t) = bars_at(0.0, 120.0, 4, 8);
        for bpm in [100.0, 120.0, 100.0] {
            let (more, end) = bars_at(t, bpm, 4, 8);
            clicks.extend(more);
            t = end;
        }
        let analysis = analyze_click(&render(&clicks), RATE, 4);
        assert_eq!(analysis.segments.len(), 4, "{analysis:?}");
        assert!(!kinds(&analysis).contains(&ClickWarningKind::UnreliableClick));
    }

    #[test]
    fn a_gap_in_the_click_warns_and_restarts() {
        let (mut clicks, end) = bars_at(0.0, 120.0, 4, 8);
        let (more, _) = bars_at(end + 7.3, 120.0, 4, 8);
        clicks.extend(more);
        let analysis = analyze_click(&render(&clicks), RATE, 4);
        assert!(kinds(&analysis).contains(&ClickWarningKind::ClickGap));
        assert_eq!(analysis.segments.len(), 2, "{analysis:?}");
        assert_close(analysis.segments[1].start_seconds, end + 7.3, 0.001);
    }

    #[test]
    fn a_lone_two_four_bar_is_flagged() {
        let (mut clicks, end) = bars_at(0.0, 120.0, 4, 4);
        let (odd, end) = bars_at(end, 120.0, 2, 1);
        let (rest, _) = bars_at(end, 120.0, 4, 4);
        clicks.extend(odd);
        clicks.extend(rest);
        let analysis = analyze_click(&render(&clicks), RATE, 4);
        let signatures: Vec<String> = analysis.segments.iter().map(|s| s.signature()).collect();
        assert_eq!(signatures, vec!["4/4", "2/4", "4/4"]);
        assert!(kinds(&analysis).contains(&ClickWarningKind::IrregularBar));
    }

    #[test]
    fn sixteenths_under_a_dotted_quarter_accent_fold_to_six_eight() {
        // A real 6/8 at 76: clicks every 0.197 s, accent every six. The beat
        // is every other click: eighths of 0.395 s, accent every three.
        let clicks: Vec<Click> = (0..96)
            .map(|i| Click {
                seconds: i as f64 * 0.1975,
                frequency: if i % 6 == 0 { 2000.0 } else { LOW },
                amplitude: 0.8,
            })
            .collect();
        let analysis = analyze_click(&render(&clicks), RATE, 4);
        assert_eq!(analysis.segments.len(), 1, "{analysis:?}");
        assert_eq!(analysis.segments[0].signature(), "6/8");
        assert_close(analysis.segments[0].bpm, 76.0, 0.05);
        assert!(kinds(&analysis).contains(&ClickWarningKind::CompoundGuess));
    }

    #[test]
    fn strong_and_weak_clicks_taking_turns_are_beats_and_off_beats() {
        // A ballad at 79 clicked in eighths: beats 2.3 dB above off-beats,
        // with the beat's pitch wobbling (as measured on a real stem).
        let clicks: Vec<Click> = (0..120)
            .map(|i| {
                let on_beat = i % 2 == 0;
                Click {
                    seconds: i as f64 * 60.0 / 158.0,
                    frequency: if on_beat {
                        [967.0, 901.0, 867.0][i % 3]
                    } else {
                        834.0
                    },
                    amplitude: if on_beat { 0.67 } else { 0.51 },
                }
            })
            .collect();
        let analysis = analyze_click(&render(&clicks), RATE, 4);
        assert_eq!(analysis.segments.len(), 1, "{analysis:?}");
        assert_eq!(analysis.segments[0].bpm, 79.0);
        assert_eq!(analysis.segments[0].signature(), "4/4");
        assert!(!analysis.downbeat_known);
    }

    #[test]
    fn unaccented_clicks_over_200_a_minute_are_eighths() {
        let clicks: Vec<Click> = (0..64)
            .map(|i| Click {
                seconds: i as f64 * 60.0 / 256.0,
                frequency: LOW,
                amplitude: 0.8,
            })
            .collect();
        let analysis = analyze_click(&render(&clicks), RATE, 4);
        assert_eq!(analysis.segments[0].bpm, 128.0, "{analysis:?}");
    }

    #[test]
    fn unaccented_eighths_of_a_98_bpm_song_are_not_196() {
        let clicks: Vec<Click> = (0..64)
            .map(|i| Click {
                seconds: i as f64 * 60.0 / 196.0,
                frequency: LOW,
                amplitude: 0.8,
            })
            .collect();
        let analysis = analyze_click(&render(&clicks), RATE, 4);
        assert_eq!(analysis.segments[0].bpm, 98.0, "{analysis:?}");
    }

    #[test]
    fn a_final_hit_after_the_last_bar_keeps_the_meter() {
        let (mut clicks, end) = bars_at(0.0, 120.0, 4, 8);
        // One last accented hit, late (a held ending).
        clicks.push(Click {
            seconds: end + 0.9,
            frequency: HIGH,
            amplitude: 0.8,
        });
        let analysis = analyze_click(&render(&clicks), RATE, 4);
        assert!(
            analysis.segments.iter().all(|s| s.signature() == "4/4"),
            "{analysis:?}"
        );
    }

    #[test]
    fn low_noise_floor_does_not_add_clicks() {
        let (clicks, _) = bars_at(0.5, 120.0, 4, 8);
        let mut buffer = render(&clicks);
        let mut seed = 12345_u32;
        for sample in &mut buffer {
            seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12345);
            *sample += ((seed >> 16) as f32 / 32768.0 - 1.0) * 0.002;
        }
        let analysis = analyze_click(&buffer, RATE, 4);
        assert_eq!(analysis.beat_count, 32);
        assert_eq!(analysis.segments.len(), 1, "{analysis:?}");
        assert_eq!(analysis.segments[0].bpm, 120.0);
    }
}
