//! Where the bar starts in a click without accent, from the guide.
//!
//! Every click sounds the same, so the click alone counts bars from its first
//! beat: a song whose bar 1 comes two beats after the first click ("Es Él",
//! Felipe S. Santos: the click starts on beat 3) got every bar, and with them
//! every guide marker, half a bar off. The guide knows better: it speaks in
//! the bar before its section and finishes right before the section's
//! downbeat ("Coro, dos, tres, cuatro"). So, among the beats of a bar, the
//! downbeat is the one the announcements end closest before.
//!
//! A single announcement START does not tell: a guide speaks on beats 1 and 3 alike.
//! Consistently aligned section starts do tell, however: when most names start
//! on the same beat, their different word lengths must not move that beat.
//! And a guide that speaks at the start of the bar before ("La bondad de
//! Dios", Church of the City) ends its words two beats or more before the
//! downbeat, closer to the wrong one. Its counts are surer: the beat after a
//! count's last number ("…tres, cuatro") is a downbeat, so when the guide
//! counts, the counts decide.
//!
//! Before the guide, the click's own tempo changes: a click jumps to a new
//! tempo on a bar line. "Fiesta en el desierto" (Montesanto) goes from 125
//! to 140 and back on its first click's bars; the guide, two beats off,
//! left the change on beat 3 and a bar of 132 off the click by 50 ms.

use crate::guide::GuideAnalysis;
use crate::guide_text::is_section_kind;

/// Fragments closer than this (in beats) are one announcement: "Coro" and
/// its count-in, or the numbers of a count. The intro's "Intro… uno, dos"
/// leaves 1.3 beats between them.
const CHAIN_GAP_BEATS: f64 = 1.5;
/// The last word can run a little past the downbeat (see
/// `ANNOUNCEMENT_TAIL_BEATS` in songAnalysisPlan.ts): that downbeat still
/// follows it.
const TAIL_BEATS: f64 = 0.3;
/// Fewer announcements than this is too little to move the bar.
const MIN_ANNOUNCEMENTS: usize = 2;
/// The best phase must beat the runner-up by this much (mean beats from an
/// announcement's end to the next downbeat). On the real guide above the
/// right phase averages ~1 beat and the one two beats off ~3.
const MIN_MARGIN_BEATS: f64 = 0.75;
const MIN_SECTION_STARTS: usize = 3;
const SECTION_START_SHARE: f64 = 0.75;
const ON_BEAT_SHARE: f64 = 0.2;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum GuideEvidence {
    Ends,
    SectionStarts,
    CountEnds,
    CountOnsets,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct GuidePhase {
    pub pickup: usize,
    pub evidence: GuideEvidence,
}

/// How many beats of `beat_times` (one run of a click without accent, with
/// no gap) come before its first downbeat: 0..beats_per_bar. None when the
/// guide does not say clearly, and the bars stay counted from the first beat.
/// Guide and click must share a time base (the same render).
pub(crate) fn pickup_from_guide(
    beat_times: &[f64],
    beats_per_bar: usize,
    guide: &GuideAnalysis,
) -> Option<GuidePhase> {
    if beats_per_bar < 2 || beat_times.len() < beats_per_bar * 2 {
        return None;
    }
    let first = beat_times[0];
    let last = *beat_times.last()?;
    let beat = (last - first) / (beat_times.len() - 1) as f64;
    if !(beat > 0.0) {
        return None;
    }
    if let Some(phase) = phase_from_count_onsets(beat_times, beats_per_bar, beat, guide) {
        return Some(GuidePhase {
            pickup: phase,
            evidence: GuideEvidence::CountOnsets,
        });
    }
    if let Some(phase) = phase_from_counts(beat_times, beats_per_bar, beat, guide) {
        return Some(GuidePhase {
            pickup: phase,
            evidence: GuideEvidence::CountEnds,
        });
    }
    if let Some(phase) = phase_from_section_starts(beat_times, beats_per_bar, beat, guide) {
        return Some(GuidePhase {
            pickup: phase,
            evidence: GuideEvidence::SectionStarts,
        });
    }
    let ends = announcement_ends(guide, beat);
    let ends: Vec<f64> = ends
        .into_iter()
        .filter(|&end| end > first && end < last - beat * beats_per_bar as f64)
        .collect();
    if ends.len() < MIN_ANNOUNCEMENTS {
        return None;
    }
    let mut scores: Vec<(usize, f64)> = (0..beats_per_bar)
        .map(|phase| {
            let total: f64 = ends
                .iter()
                .map(|&end| {
                    let from = end - TAIL_BEATS * beat;
                    // The first beat at or after `from`, then on to a downbeat.
                    let index = beat_times.partition_point(|&t| t < from);
                    let ahead = (beats_per_bar + phase - index % beats_per_bar) % beats_per_bar;
                    let downbeat = beat_times
                        .get(index + ahead)
                        .copied()
                        .unwrap_or(last + beat * ahead as f64);
                    (downbeat - end) / beat
                })
                .sum();
            (phase, total / ends.len() as f64)
        })
        .collect();
    scores.sort_by(|a, b| a.1.total_cmp(&b.1));
    (scores[1].1 - scores[0].1 >= MIN_MARGIN_BEATS).then_some(GuidePhase {
        pickup: scores[0].0,
        evidence: GuideEvidence::Ends,
    })
}

/// Consecutive numbers must land on consecutive beats of this reading.
/// A word's tail can cross the next downbeat; its number still identifies
/// the beat on which it began. Half-time counts do not validate double time.
fn phase_from_count_onsets(
    beat_times: &[f64],
    beats_per_bar: usize,
    beat: f64,
    guide: &GuideAnalysis,
) -> Option<usize> {
    let mut words: Vec<_> = guide
        .announcements
        .iter()
        .flat_map(|announcement| &announcement.count_words)
        .collect();
    words.sort_by(|a, b| a.start_seconds.total_cmp(&b.start_seconds));
    let nearest = |seconds: f64| {
        let next = beat_times.partition_point(|&time| time < seconds);
        [
            next.checked_sub(1),
            (next < beat_times.len()).then_some(next),
        ]
        .into_iter()
        .flatten()
        .filter(|&index| (beat_times[index] - seconds).abs() <= ON_BEAT_SHARE * beat)
        .min_by(|&a, &b| {
            (beat_times[a] - seconds)
                .abs()
                .total_cmp(&(beat_times[b] - seconds).abs())
        })
    };
    let mut phase = None;
    for pair in words.windows(2) {
        let (a, b) = (pair[0], pair[1]);
        if a.number == 0
            || usize::from(b.number) > beats_per_bar
            || usize::from(b.number) != usize::from(a.number) + 1
        {
            continue;
        }
        let (Some(first), Some(second)) = (nearest(a.start_seconds), nearest(b.start_seconds))
        else {
            continue;
        };
        if second != first + 1 {
            continue;
        }
        let here = (first + beats_per_bar - usize::from(a.number - 1)) % beats_per_bar;
        if phase.is_some_and(|known| known != here) {
            return None;
        }
        phase = Some(here);
    }
    phase
}

fn phase_from_section_starts(
    beat_times: &[f64],
    beats_per_bar: usize,
    beat: f64,
    guide: &GuideAnalysis,
) -> Option<usize> {
    let mut votes = vec![0_usize; beats_per_bar];
    let mut total = 0;
    for announcement in &guide.announcements {
        let Some(group) = guide.groups.get(announcement.group) else {
            continue;
        };
        let section = group.counted_in
            || group.labels.iter().any(|label| {
                is_section_kind(label)
                    || label.rsplit_once('_').is_some_and(|(kind, variant)| {
                        is_section_kind(kind) && variant.parse::<u8>().is_ok()
                    })
            });
        if !section
            || announcement.start_seconds < beat_times[0] - ON_BEAT_SHARE * beat
            || announcement.start_seconds > *beat_times.last()?
        {
            continue;
        }
        total += 1;
        let next = beat_times.partition_point(|&time| time < announcement.start_seconds);
        let nearest = [
            next.checked_sub(1),
            (next < beat_times.len()).then_some(next),
        ]
        .into_iter()
        .flatten()
        .min_by(|&a, &b| {
            (beat_times[a] - announcement.start_seconds)
                .abs()
                .total_cmp(&(beat_times[b] - announcement.start_seconds).abs())
        })?;
        if (beat_times[nearest] - announcement.start_seconds).abs() <= ON_BEAT_SHARE * beat {
            votes[nearest % beats_per_bar] += 1;
        }
    }
    let (phase, &support) = votes.iter().enumerate().max_by_key(|(_, votes)| **votes)?;
    (support >= MIN_SECTION_STARTS && support as f64 >= SECTION_START_SHARE * total as f64)
        .then_some(phase)
}

/// The numbers of one count can be a half note apart ("uno . dos . | uno,
/// dos, tres, cuatro"): two beats and a breath.
const COUNT_CHAIN_GAP_BEATS: f64 = 2.5;

/// The phase every count of the guide agrees on: the first beat after a
/// count's last fragment ends is a downbeat. None without counts, or when
/// they disagree.
fn phase_from_counts(
    beat_times: &[f64],
    beats_per_bar: usize,
    beat: f64,
    guide: &GuideAnalysis,
) -> Option<usize> {
    let is_count = |group: usize| {
        guide.groups.get(group).is_some_and(|group| {
            group
                .labels
                .iter()
                .any(|label| label == "count" || label == "spoken_count")
        })
    };
    let mut announcements: Vec<_> = guide.announcements.iter().collect();
    announcements.sort_by(|a, b| a.start_seconds.total_cmp(&b.start_seconds));
    let (first, last) = (beat_times[0], *beat_times.last()?);
    let mut phase: Option<usize> = None;
    for (index, announcement) in announcements.iter().enumerate() {
        if !is_count(announcement.group) {
            continue;
        }
        // Only where the speech stops: a fragment a breath later is the
        // count going on (its "uno, dos" may not have matched a clip), or
        // more words.
        let goes_on = announcements.get(index + 1).is_some_and(|next| {
            next.start_seconds - announcement.end_seconds < COUNT_CHAIN_GAP_BEATS * beat
        });
        let from = announcement.end_seconds - TAIL_BEATS * beat;
        if goes_on || from <= first || from >= last {
            continue;
        }
        let here = beat_times.partition_point(|&t| t < from) % beats_per_bar;
        if phase.is_some_and(|known| known != here) {
            return None;
        }
        phase = Some(here);
    }
    phase
}

/// Beats in each window either side of a tempo change, all at one tempo.
const STEADY_BEATS: usize = 4;
/// Within a window, beats this far apart from its mean (share of a beat) are
/// still one tempo: onset noise. Ramps and a click following the band are
/// not steady, and say nothing.
const STEADY_SHARE: f64 = 0.006;
/// A jump in beat length of this share at least is a tempo change (70 → 71
/// is 1.4 %).
const CHANGE_SHARE: f64 = 0.012;

/// How many beats of `beat_times` (one run of a click without accent) come
/// before its first downbeat, from where its tempo jumps: there a bar starts.
/// None without such a jump, or when the jumps disagree on the bar.
pub(crate) fn pickup_from_tempo_changes(beat_times: &[f64], beats_per_bar: usize) -> Option<usize> {
    if beats_per_bar < 2 || beat_times.len() < 2 * STEADY_BEATS + 1 {
        return None;
    }
    let lengths: Vec<f64> = beat_times.windows(2).map(|w| w[1] - w[0]).collect();
    let steady = |window: &[f64]| -> Option<f64> {
        let mean = window.iter().sum::<f64>() / window.len() as f64;
        (mean > 0.0
            && window
                .iter()
                .all(|&l| (l - mean).abs() <= STEADY_SHARE * mean))
        .then_some(mean)
    };
    let mut phase: Option<usize> = None;
    let mut index = STEADY_BEATS;
    while index + STEADY_BEATS <= lengths.len() {
        let before = steady(&lengths[index - STEADY_BEATS..index]);
        let after = steady(&lengths[index..index + STEADY_BEATS]);
        if let (Some(before), Some(after)) = (before, after) {
            // At once, from one beat to the next: a ramp moves a little each
            // beat and adds up to as much.
            let jump = (lengths[index] - lengths[index - 1]).abs();
            if (after - before).abs() >= CHANGE_SHARE * before && jump >= CHANGE_SHARE * before {
                // Beat `index` is the first at the new tempo: a downbeat.
                let here = index % beats_per_bar;
                if phase.is_some_and(|known| known != here) {
                    return None;
                }
                phase = Some(here);
                index += STEADY_BEATS;
                continue;
            }
        }
        index += 1;
    }
    phase
}

/// Where each announcement ends: the end of its last fragment.
fn announcement_ends(guide: &GuideAnalysis, beat: f64) -> Vec<f64> {
    let mut fragments: Vec<(f64, f64)> = guide
        .announcements
        .iter()
        .map(|a| (a.start_seconds, a.end_seconds))
        .collect();
    fragments.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut ends: Vec<f64> = Vec::new();
    for (index, &(_, end)) in fragments.iter().enumerate() {
        let chained = fragments
            .get(index + 1)
            .is_some_and(|&(next_start, _)| next_start - end < CHAIN_GAP_BEATS * beat);
        if !chained {
            ends.push(end);
        }
    }
    ends
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pickup_from_guide(
        times: &[f64],
        beats_per_bar: usize,
        guide: &GuideAnalysis,
    ) -> Option<usize> {
        super::pickup_from_guide(times, beats_per_bar, guide).map(|phase| phase.pickup)
    }
    use crate::guide::GuideAnnouncement;

    fn guide(fragments: &[(f64, f64)]) -> GuideAnalysis {
        GuideAnalysis {
            announcements: fragments
                .iter()
                .map(|&(start_seconds, end_seconds)| GuideAnnouncement {
                    start_seconds,
                    end_seconds,
                    group: 0,
                    count_words: Vec::new(),
                })
                .collect(),
            groups: Vec::new(),
        }
    }

    /// The fragments the guide analysis found on "Es Él" (Felipe S. Santos,
    /// 70 BPM): its bars start at 1.714 s, two beats after the click's first.
    const ES_EL: &[(f64, f64)] = &[
        (0.08, 0.57),
        (1.71, 2.12),
        (2.57, 3.02),
        (3.43, 4.71),
        (22.30, 25.28),
        (51.43, 52.12),
        (77.15, 77.57),
        (78.00, 80.14),
        (97.72, 100.71),
        (126.86, 127.55),
        (152.58, 153.00),
        (153.42, 154.73),
        (155.14, 155.57),
        (174.86, 175.29),
        (193.72, 195.02),
        (195.43, 196.71),
        (216.01, 217.15),
        (234.86, 235.29),
        (235.71, 237.86),
        (257.15, 257.57),
        (276.01, 278.16),
        (278.57, 279.00),
        (296.58, 298.73),
        (299.14, 299.57),
        (318.86, 319.40),
        (337.72, 338.15),
        (338.57, 339.02),
        (339.43, 340.71),
        (360.00, 360.43),
        (380.58, 381.05),
    ];

    fn beats(start: f64, bpm: f64, count: usize) -> Vec<f64> {
        (0..count).map(|i| start + i as f64 * 60.0 / bpm).collect()
    }

    #[test]
    fn a_real_guide_finds_the_bar_two_beats_after_the_click() {
        assert_eq!(
            pickup_from_guide(&beats(0.0, 70.0, 460), 4, &guide(ES_EL)),
            Some(2)
        );
    }

    #[test]
    fn a_click_already_on_the_bar_keeps_it() {
        let shifted: Vec<(f64, f64)> = ES_EL
            .iter()
            .map(|&(s, e)| (s + 120.0 / 70.0, e + 120.0 / 70.0))
            .collect();
        assert_eq!(
            pickup_from_guide(&beats(0.0, 70.0, 460), 4, &guide(&shifted)),
            Some(0)
        );
    }

    #[test]
    fn too_little_guide_says_nothing() {
        assert_eq!(
            pickup_from_guide(&beats(0.0, 70.0, 460), 4, &guide(&[(51.43, 52.12)])),
            None
        );
        assert_eq!(
            pickup_from_guide(&beats(0.0, 70.0, 460), 4, &guide(&[])),
            None
        );
    }

    /// "Fiesta en el desierto": 16 bars of 125 from the first click, then 140.
    fn fiesta(pickup: usize) -> Vec<f64> {
        let mut times = beats(0.061, 125.0, 64 + pickup);
        times.extend(beats(
            0.061 + (64 + pickup) as f64 * 60.0 / 125.0,
            140.0,
            400,
        ));
        times
    }

    #[test]
    fn a_tempo_change_starts_a_bar() {
        assert_eq!(pickup_from_tempo_changes(&fiesta(0), 4), Some(0));
        // The change two beats into the click: the bars start two beats in.
        assert_eq!(pickup_from_tempo_changes(&fiesta(2), 4), Some(2));
    }

    #[test]
    fn a_steady_click_or_a_ramp_says_nothing() {
        assert_eq!(pickup_from_tempo_changes(&beats(0.0, 70.0, 460), 4), None);
        // 120 → 100 a little every beat.
        let mut ramp = vec![0.0];
        for i in 0..60 {
            let bpm = 120.0 - i as f64 / 3.0;
            ramp.push(ramp[i] + 60.0 / bpm);
        }
        assert_eq!(pickup_from_tempo_changes(&ramp, 4), None);
    }

    #[test]
    fn tempo_changes_that_disagree_say_nothing() {
        // On a bar at 64, then two beats into one at 202.
        let mut times = fiesta(0);
        times.truncate(202);
        let change = times[201] + 60.0 / 140.0;
        times.extend(beats(change, 115.0, 40));
        assert_eq!(pickup_from_tempo_changes(&times, 4), None);
        times.truncate(200);
        let change = times[199] + 60.0 / 140.0;
        times.extend(beats(change, 115.0, 40));
        assert_eq!(pickup_from_tempo_changes(&times, 4), Some(0));
    }

    fn counted(fragments: &[(f64, f64, bool)]) -> GuideAnalysis {
        GuideAnalysis {
            announcements: fragments
                .iter()
                .map(|&(start_seconds, end_seconds, count)| GuideAnnouncement {
                    start_seconds,
                    end_seconds,
                    group: usize::from(count),
                    count_words: Vec::new(),
                })
                .collect(),
            groups: [vec![], vec!["count".to_string()]]
                .into_iter()
                .map(|labels| crate::guide::GuideGroup {
                    labels,
                    transcript: None,
                    match_cost: None,
                    counted_in: false,
                    occurrences: 1,
                    first_start_seconds: 0.0,
                    first_end_seconds: 0.0,
                })
                .collect(),
        }
    }

    /// The fragments the guide analysis found on "La bondad de Dios" (Church
    /// of the City, 68 BPM, bars from the click's first beat at 0.028 s): a
    /// count "1 . 2 . 1 2 3 4" and then announcements said at the start of
    /// the bar before their section.
    const BONDAD: &[(f64, f64, bool)] = &[
        (0.03, 0.44, true),
        (1.79, 2.24, true),
        // "uno, dos": no clip matched it.
        (3.56, 4.89, false),
        (5.32, 5.77, true),
        (6.20, 6.66, true),
        (17.67, 18.49, false),
        (47.68, 48.10, false),
        (72.38, 73.20, false),
        (74.14, 74.92, false),
        (86.51, 87.36, false),
        (114.74, 115.88, false),
        (116.50, 116.93, false),
        (141.20, 142.03, false),
        (155.33, 155.86, false),
        (178.27, 179.41, false),
        (183.56, 184.10, false),
        (185.32, 186.10, false),
        (210.03, 210.85, false),
        (211.79, 212.68, false),
        (224.15, 224.58, false),
    ];

    #[test]
    fn a_guide_that_counts_puts_the_bar_after_its_count() {
        let click = beats(0.028, 68.0, 380);
        assert_eq!(pickup_from_guide(&click, 4, &counted(BONDAD)), Some(0));
        // Without the count to go by, its announcements say another bar.
        let words: Vec<(f64, f64)> = BONDAD[5..].iter().map(|&(s, e, _)| (s, e)).collect();
        assert_ne!(pickup_from_guide(&click, 4, &guide(&words)), Some(0));
    }

    fn sections(fragments: &[(f64, f64)]) -> GuideAnalysis {
        let mut analysis = counted(
            &fragments
                .iter()
                .map(|&(s, e)| (s, e, false))
                .collect::<Vec<_>>(),
        );
        analysis.groups[0].labels = vec!["verse_2".to_string()];
        analysis
    }

    #[test]
    fn consistent_section_starts_do_not_follow_word_lengths() {
        let click = beats(0.002, 148.0, 604);
        // Measured guide fragments, including the opening count + Intro.
        let analysis = sections(&[
            (0.00, 3.29),
            (8.11, 8.60),
            (14.60, 16.41),
            (40.54, 42.13),
            (53.51, 54.33),
            (66.50, 67.17),
            (72.97, 73.80),
            (79.47, 80.32),
            (92.44, 93.12),
            (98.92, 99.39),
            (103.79, 105.37),
            (123.24, 124.07),
            (129.73, 130.55),
            (142.71, 143.39),
            (149.19, 149.66),
            (152.44, 154.02),
            (171.89, 172.72),
            (184.87, 186.60),
            (204.33, 205.91),
            (223.79, 224.29),
            (230.27, 230.77),
            (243.26, 243.72),
        ]);
        let phase = super::pickup_from_guide(&click, 4, &analysis).unwrap();
        assert_eq!(phase.pickup, 0);
        assert_eq!(phase.evidence, GuideEvidence::SectionStarts);
    }

    #[test]
    fn section_start_consensus_is_relative_to_the_click_not_to_zero() {
        for phase in 0..4 {
            let fragments: Vec<_> = (0..8)
                .map(|i| {
                    let start = 1.0 + (8 * i + phase) as f64 * 0.5;
                    (start + 0.02, start + 0.8)
                })
                .collect();
            let result =
                super::pickup_from_guide(&beats(1.0, 120.0, 100), 4, &sections(&fragments))
                    .unwrap();
            assert_eq!(result.pickup, phase);
            assert_eq!(result.evidence, GuideEvidence::SectionStarts);
        }
    }

    #[test]
    fn ambiguous_or_sparse_section_starts_do_not_override_other_evidence() {
        let click = beats(0.0, 120.0, 200);
        let fragments: Vec<_> = (0..8)
            .map(|i| {
                let start = (8 * i + 2 * (i % 2)) as f64 * 0.5;
                (start, start + 0.3)
            })
            .collect();
        assert_eq!(
            phase_from_section_starts(&click, 4, 0.5, &sections(&fragments)),
            None
        );
        assert_eq!(
            phase_from_section_starts(&click, 4, 0.5, &sections(&fragments[..2])),
            None
        );
        let off_beat: Vec<_> = fragments.iter().map(|&(s, e)| (s + 0.2, e + 0.2)).collect();
        assert_eq!(
            phase_from_section_starts(&click, 4, 0.5, &sections(&off_beat)),
            None
        );
    }

    #[test]
    fn counts_take_priority_over_consistent_section_starts() {
        let mut analysis = counted(&[
            (1.0, 1.3, true),
            (1.5, 1.8, true),
            (5.0, 5.3, false),
            (9.0, 9.3, false),
            (13.0, 13.3, false),
        ]);
        analysis.groups[0].labels = vec!["chorus".to_string()];
        let result = super::pickup_from_guide(&beats(0.0, 120.0, 100), 4, &analysis).unwrap();
        assert_eq!(result.pickup, 0);
        assert_eq!(result.evidence, GuideEvidence::CountEnds);
    }

    #[test]
    fn numbered_onsets_locate_pickups_independently_of_the_count_tail() {
        let click = beats(0.015, 147.0, 100);
        let beat = 60.0 / 147.0;
        for pickup in 0..4 {
            for tail in [0.2, 0.6, 1.1] {
                let origin = 0.015 + (4 + pickup) as f64 * beat;
                let mut analysis = counted(&[(origin, origin + (3.0 + tail) * beat, true)]);
                analysis.announcements[0].count_words = (1..=4)
                    .map(|number| crate::guide::CountWord {
                        number,
                        start_seconds: origin + f64::from(number - 1) * beat + 0.01,
                    })
                    .collect();
                let phase = super::pickup_from_guide(&click, 4, &analysis).unwrap();
                assert_eq!(phase.pickup, pickup);
                assert_eq!(phase.evidence, GuideEvidence::CountOnsets);
            }
        }
    }

    #[test]
    fn count_numbers_must_agree_with_the_selected_readings_beats() {
        let click = beats(0.0, 120.0, 100);
        let mut analysis = counted(&[(2.0, 6.0, true)]);
        let words = |spacing: f64, offset: f64| {
            (1..=4)
                .map(|number| crate::guide::CountWord {
                    number,
                    start_seconds: 2.0 + offset + f64::from(number - 1) * spacing,
                })
                .collect::<Vec<_>>()
        };
        analysis.announcements[0].count_words = words(1.0, 0.0);
        assert_eq!(phase_from_count_onsets(&click, 4, 0.5, &analysis), None);
        analysis.announcements[0].count_words = words(0.5, 0.2);
        assert_eq!(phase_from_count_onsets(&click, 4, 0.5, &analysis), None);
        analysis.announcements[0].count_words = words(0.5, 0.0);
        assert_eq!(phase_from_count_onsets(&click, 4, 0.5, &analysis), Some(0));
        let mut conflicting = analysis.announcements[0].clone();
        for word in &mut conflicting.count_words {
            word.start_seconds += 4.5;
        }
        analysis.announcements.push(conflicting);
        assert_eq!(phase_from_count_onsets(&click, 4, 0.5, &analysis), None);
    }

    #[test]
    fn section_consensus_requires_three_starts_and_three_quarters_support() {
        let click = beats(0.0, 120.0, 200);
        let mut analysis = sections(&[(4.0, 4.3), (8.0, 8.3), (12.0, 12.3), (17.0, 17.3)]);
        assert_eq!(
            phase_from_section_starts(&click, 4, 0.5, &analysis),
            Some(0)
        );
        analysis
            .announcements
            .push(crate::guide::GuideAnnouncement {
                start_seconds: 21.0,
                end_seconds: 21.3,
                group: 0,
                count_words: Vec::new(),
            });
        assert_eq!(phase_from_section_starts(&click, 4, 0.5, &analysis), None);
        analysis.groups[0].labels = vec!["drums_in".to_string()];
        assert_eq!(phase_from_section_starts(&click, 4, 0.5, &analysis), None);
        analysis.groups[0].counted_in = true;
        analysis.announcements.pop();
        assert_eq!(
            phase_from_section_starts(&click, 4, 0.5, &analysis),
            Some(0)
        );
    }

    #[test]
    fn es_el_counts_agree_with_its_announcements() {
        // "Intro… uno, dos, tres, cuatro" and the counts after "Coro": the
        // bars two beats after the click's first.
        let fragments: Vec<(f64, f64, bool)> = ES_EL
            .iter()
            .map(|&(s, e)| (s, e, [1.71, 2.57, 3.43, 155.14, 339.43].contains(&s)))
            .collect();
        assert_eq!(
            pickup_from_guide(&beats(0.0, 70.0, 460), 4, &counted(&fragments)),
            Some(2)
        );
    }

    #[test]
    fn announcements_spread_over_the_bar_say_nothing() {
        // Ends on every beat alike: no phase stands out.
        let spread: Vec<(f64, f64)> = (0..16)
            .map(|i| {
                let end = 10.0 + i as f64 * (3.0 * 60.0 / 70.0 * 4.0 + 60.0 / 70.0) + 0.4;
                (end - 0.5, end)
            })
            .collect();
        assert_eq!(
            pickup_from_guide(&beats(0.0, 70.0, 460), 4, &guide(&spread)),
            None
        );
    }
}
