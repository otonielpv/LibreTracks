//! From a click analysis to the tempo and time signature markers of one song.
//!
//! The analysis speaks in seconds from the start of the song; the session
//! keeps one tempo map for every song in it. Each song owns its stretch of
//! that map from its very start: a tempo and a time signature marker always
//! go on the song's start, so nothing of the song before leaks into it (the
//! click may start a moment after the song, or on a pickup).
//!
//! Where the bar must restart (the song's start, its first downbeat after a
//! pickup, the click coming back off the previous grid after a gap) the
//! proposal puts a TIME SIGNATURE marker, even with the same meter. A tempo
//! change in a click that goes on is placed on the grid instead, so the meter
//! only shows up again where it really changes. The engine's metronome
//! restarts the bar at any marker, but the timeline grid only at a time
//! signature marker: a tempo marker keeps the beat phase, as in Ableton. See
//! `docs/plans/completed/song-analysis/00-DISENO.md` §3.

use serde::{Deserialize, Serialize};

use crate::click::ClickAnalysis;

/// Two positions this close are the same marker (the 1 ms the editors use).
const SAME_POSITION_SECONDS: f64 = 0.0005;
/// A first downbeat this close after the song start goes exactly on it: bar
/// 1 is the song's start. Click stems often start a few ms in (12.6 ms in
/// "Rey de Reyes"), and an MP3 adds its encoder delay (25.6 ms in "Digno",
/// Yvonne): a pickup bar that short is only in the way, and the grid a few
/// ms ahead of the click is not heard. Farther, the song starts on a pickup
/// ("Es Él" starts two beats before its bar 1; "Fiesta en el desierto" 61
/// ms in, enough for the voice guide's count to come in early).
const SNAP_TO_SONG_START_SECONDS: f64 = 0.03;
/// A segment that starts this close to where the previous one's bars end
/// continues its grid; its marker goes on the grid. Only a few ms: moving
/// a marker further off the click's downbeat is heard (20 ms offsets for
/// bars on end in "Digno de adorar"); past this the previous tempo is
/// adjusted to land on it instead.
const GRID_SNAP_SECONDS: f64 = 0.003;
/// Right after the previous segment, a start this far off its grid (as a
/// share of a beat) is still the next bar: the previous tempo is adjusted to
/// land on it. Farther is the click coming back after a gap.
const CONTIGUOUS_BEATS: f64 = 0.5;
/// The session's own start: every grid starts a bar there.
const SESSION_ORIGIN_SECONDS: f64 = 0.0001;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SongSpan {
    pub start_seconds: f64,
    pub end_seconds: f64,
}

/// The session's tempo map today.
#[derive(Debug, Clone, PartialEq)]
pub struct ExistingTiming {
    pub bpm: f64,
    pub time_signature: String,
    /// (start, bpm)
    pub tempo_markers: Vec<(f64, f64)>,
    /// (start, signature)
    pub signature_markers: Vec<(f64, String)>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposedTempoMarker {
    pub start_seconds: f64,
    pub bpm: f64,
    /// Ramps to the next marker's bpm (`TempoMarker::ramp`).
    #[serde(default)]
    pub ramp: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposedSignatureMarker {
    pub start_seconds: f64,
    pub signature: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TempoProposal {
    pub tempo_markers: Vec<ProposedTempoMarker>,
    pub signature_markers: Vec<ProposedSignatureMarker>,
    /// What rules the start of the song today, for the review screen.
    pub current_bpm: f64,
    pub current_signature: String,
    /// The song already has exactly these markers.
    pub unchanged: bool,
}

fn value_at<T: Clone>(base: &T, markers: &[(f64, T)], at: f64) -> T {
    let mut value = base.clone();
    let mut best = f64::NEG_INFINITY;
    for (start, marker_value) in markers {
        if *start <= at + SAME_POSITION_SECONDS && *start >= best {
            best = *start;
            value = marker_value.clone();
        }
    }
    value
}

/// One segment of the analysis on the session's timeline.
struct Placement {
    start: f64,
    /// Where the click's grid really starts: `start`, but for a first
    /// downbeat a few ms into the song, whose marker goes on the song's
    /// start. The bars that follow are counted from here, so the tempo is
    /// not stretched to make up those ms.
    grid_start: f64,
    bpm: f64,
    /// A ramp from `bpm` to this across its bars.
    end_bpm: Option<f64>,
    beats_per_bar: u32,
    beat_unit: u32,
    /// Bars from `start` to where the next segment follows on.
    bars: u32,
    restarts_bar: bool,
}

impl Placement {
    fn bar_seconds(&self) -> f64 {
        240.0 * f64::from(self.beats_per_bar) / (self.bpm * f64::from(self.beat_unit))
    }

    /// Whether this grid carries on into a segment whose first downbeat the
    /// click puts at `start`, so no time signature marker has to restart the
    /// bar there. A click that follows the band ends a bar a few dozen ms off
    /// its rounded tempo: within `GRID_SNAP_SECONDS` the next marker moves
    /// onto the grid, and right after this segment (no gap) up to
    /// `CONTIGUOUS_BEATS` this tempo is set to land exactly on it.
    fn continue_into(&mut self, start: &mut f64) -> bool {
        if let Some(end_bpm) = self.end_bpm {
            // A ramp was built to span its bars in the click's time: it lands
            // on the next downbeat but for rounding, unless the click stopped.
            let quarters = f64::from(self.bars) * f64::from(self.beats_per_bar) * 4.0
                / f64::from(self.beat_unit);
            let end = self.grid_start + 120.0 * quarters / (self.bpm + end_bpm);
            let beat = 240.0 / ((self.bpm + end_bpm) / 2.0 * f64::from(self.beat_unit));
            if (*start - end).abs() <= CONTIGUOUS_BEATS * beat {
                *start = end;
                return true;
            }
            return false;
        }
        let bar = self.bar_seconds();
        if !(bar > 0.0) {
            return false;
        }
        let bars = ((*start - self.grid_start) / bar).round().max(1.0);
        let grid_end = self.grid_start + bars * bar;
        let off = *start - grid_end;
        if off.abs() <= GRID_SNAP_SECONDS {
            *start = grid_end;
            return true;
        }
        let beat = bar / f64::from(self.beats_per_bar.max(1));
        if bars as u32 == self.bars && off.abs() <= CONTIGUOUS_BEATS * beat {
            let beats = bars * f64::from(self.beats_per_bar);
            let exact = 240.0 * beats / ((*start - self.grid_start) * f64::from(self.beat_unit));
            // Two decimals when they still land on the grid (71.03, not
            // 71.031); three otherwise.
            let hundredths = (exact * 100.0).round() / 100.0;
            let landing =
                self.grid_start + 240.0 * beats / (hundredths * f64::from(self.beat_unit));
            self.bpm = if (landing - *start).abs() <= GRID_SNAP_SECONDS {
                hundredths
            } else {
                (exact * 1000.0).round() / 1000.0
            };
            *start = self.grid_start + bars * self.bar_seconds();
            return true;
        }
        false
    }
}

pub fn propose_tempo_markers(
    analysis: &ClickAnalysis,
    span: SongSpan,
    existing: &ExistingTiming,
) -> TempoProposal {
    let inside = |start: f64| {
        start >= span.start_seconds - SAME_POSITION_SECONDS
            && start < span.end_seconds - SAME_POSITION_SECONDS
    };
    let kept_tempo: Vec<(f64, f64)> = existing
        .tempo_markers
        .iter()
        .filter(|(start, _)| !inside(*start))
        .cloned()
        .collect();
    let kept_signatures: Vec<(f64, String)> = existing
        .signature_markers
        .iter()
        .filter(|(start, _)| !inside(*start))
        .cloned()
        .collect();

    let mut running_bpm = value_at(&existing.bpm, &kept_tempo, span.start_seconds);
    let mut running_signature = value_at(
        &existing.time_signature,
        &kept_signatures,
        span.start_seconds,
    );
    // Where each segment's grid starts, and whether the bar restarts there.
    let mut placements: Vec<Placement> = Vec::new();
    for (index, segment) in analysis.segments.iter().enumerate() {
        let bar = segment.bar_seconds();
        let downbeat = span.start_seconds + segment.start_seconds;
        let mut start = downbeat;
        let mut bars = segment.bars;
        if index == 0 && bar > 0.0 {
            // Carry the grid back to the song start, so the bars before the
            // first click (a silent intro) are on it too. A grid estimated a
            // hair before the song (from the music) moves forward instead.
            let back = ((downbeat - span.start_seconds) / bar + 1.0e-3).floor();
            start -= back * bar;
            bars = (i64::from(bars) + back as i64).max(1) as u32;
        }
        let grid_start = start;
        if index == 0 && start - span.start_seconds < SNAP_TO_SONG_START_SECONDS {
            start = span.start_seconds;
        }
        let mut grid_start = grid_start;
        let mut continues = false;
        if let Some(previous) = placements.last_mut() {
            // A grid moved onto the song start is a few ms off the click's:
            // the bar restarts where the click goes on.
            continues = previous.continue_into(&mut start)
                && (previous.start - previous.grid_start).abs() <= GRID_SNAP_SECONDS;
            grid_start = start;
        }
        if !inside(start) {
            continue;
        }
        placements.push(Placement {
            start,
            grid_start,
            bpm: segment.bpm,
            end_bpm: segment.end_bpm,
            beats_per_bar: segment.beats_per_bar,
            beat_unit: segment.beat_unit,
            bars,
            // The bar restarts here: the song's first downbeat, or the click
            // coming back off the previous segment's grid (after a gap).
            restarts_bar: (index == 0 || !continues) && start > SESSION_ORIGIN_SECONDS,
        });
    }

    let mut tempo_markers: Vec<ProposedTempoMarker> = Vec::new();
    let mut signature_markers: Vec<ProposedSignatureMarker> = Vec::new();
    // The song's own start: its tempo and meter, whatever the song before
    // ends on. After a pickup the bar restarts on the first downbeat.
    if let Some(first) = placements.first() {
        let signature = format!("{}/{}", first.beats_per_bar, first.beat_unit);
        let pickup = first.start > span.start_seconds + SAME_POSITION_SECONDS;
        if pickup || first.end_bpm.is_none() {
            tempo_markers.push(ProposedTempoMarker {
                start_seconds: span.start_seconds,
                bpm: first.bpm,
                ramp: false,
            });
            running_bpm = first.bpm;
        }
        signature_markers.push(ProposedSignatureMarker {
            start_seconds: span.start_seconds,
            signature: signature.clone(),
        });
        running_signature = signature;
    }
    for (index, placement) in placements.iter().enumerate() {
        let signature = format!("{}/{}", placement.beats_per_bar, placement.beat_unit);
        let at_song_start = placement.start <= span.start_seconds + SAME_POSITION_SECONDS;
        // A ramp needs its marker, and so does the stretch after one: the
        // ramp glides to the next marker, wherever that is.
        let after_ramp = index > 0 && placements[index - 1].end_bpm.is_some();
        let needs_tempo = if index == 0 {
            placement.end_bpm.is_some()
        } else {
            placement.bpm != running_bpm
                || placement.restarts_bar
                || placement.end_bpm.is_some()
                || after_ramp
        };
        if needs_tempo {
            tempo_markers.push(ProposedTempoMarker {
                start_seconds: placement.start,
                bpm: placement.bpm,
                ramp: placement.end_bpm.is_some(),
            });
            running_bpm = placement.end_bpm.unwrap_or(placement.bpm);
        }
        // Same meter where the grid goes on is no marker: only a new meter,
        // or a bar that must restart.
        let restarts = placement.restarts_bar && !(index == 0 && at_song_start);
        if signature != running_signature || restarts {
            signature_markers.push(ProposedSignatureMarker {
                start_seconds: placement.start,
                signature: signature.clone(),
            });
            running_signature = signature;
        }
    }

    // A ramp at the end (a ritardando into the last chord) lands on a marker
    // of its own, or it would glide on to the next song's.
    if let Some(last) = placements.last().filter(|last| last.end_bpm.is_some()) {
        let end_bpm = last.end_bpm.unwrap_or(last.bpm);
        let quarters =
            f64::from(last.bars) * f64::from(last.beats_per_bar) * 4.0 / f64::from(last.beat_unit);
        let end = (last.grid_start + 120.0 * quarters / (last.bpm + end_bpm))
            .min(span.end_seconds - 2.0 * SAME_POSITION_SECONDS);
        if end > last.start {
            tempo_markers.push(ProposedTempoMarker {
                start_seconds: end,
                bpm: end_bpm,
                ramp: false,
            });
        }
    }

    let existing_inside_tempo: Vec<(f64, f64)> = existing
        .tempo_markers
        .iter()
        .filter(|(start, _)| inside(*start))
        .cloned()
        .collect();
    let existing_inside_signatures: Vec<(f64, String)> = existing
        .signature_markers
        .iter()
        .filter(|(start, _)| inside(*start))
        .cloned()
        .collect();
    let same_positions = |a: f64, b: f64| (a - b).abs() < SAME_POSITION_SECONDS * 2.0;
    // At the session's start a marker is the song's own tempo and meter
    // (applying writes it there).
    let at_origin = |start: f64| start <= SESSION_ORIGIN_SECONDS;
    let origin_tempo_kept = tempo_markers
        .iter()
        .filter(|m| at_origin(m.start_seconds) && !m.ramp)
        .all(|m| (m.bpm - existing.bpm).abs() < 0.005);
    let origin_signature_kept = signature_markers
        .iter()
        .filter(|m| at_origin(m.start_seconds))
        .all(|m| m.signature == existing.time_signature);
    let tempo_markers_off_origin: Vec<&ProposedTempoMarker> = tempo_markers
        .iter()
        .filter(|m| !at_origin(m.start_seconds) || m.ramp)
        .collect();
    let signature_markers_off_origin: Vec<&ProposedSignatureMarker> = signature_markers
        .iter()
        .filter(|m| !at_origin(m.start_seconds))
        .collect();
    let unchanged = origin_tempo_kept
        && origin_signature_kept
        && tempo_markers_off_origin.len() == existing_inside_tempo.len()
        && signature_markers_off_origin.len() == existing_inside_signatures.len()
        && tempo_markers_off_origin
            .iter()
            .zip(&existing_inside_tempo)
            .all(|(new, old)| {
                !new.ramp
                    && same_positions(new.start_seconds, old.0)
                    && (new.bpm - old.1).abs() < 0.005
            })
        && signature_markers_off_origin
            .iter()
            .zip(&existing_inside_signatures)
            .all(|(new, old)| same_positions(new.start_seconds, old.0) && new.signature == old.1);

    TempoProposal {
        tempo_markers,
        signature_markers,
        current_bpm: value_at(&existing.bpm, &existing.tempo_markers, span.start_seconds),
        current_signature: value_at(
            &existing.time_signature,
            &existing.signature_markers,
            span.start_seconds,
        ),
        unchanged,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::click::TempoSegment;

    fn segment(start: f64, bpm: f64, beats_per_bar: u32, bars: u32) -> TempoSegment {
        TempoSegment {
            start_seconds: start,
            bpm,
            beats_per_bar,
            beat_unit: 4,
            bars,
            end_bpm: None,
        }
    }

    fn analysis(segments: Vec<TempoSegment>) -> ClickAnalysis {
        ClickAnalysis {
            segments,
            warnings: Vec::new(),
            beat_count: 0,
            downbeat_known: true,
        }
    }

    fn timing() -> ExistingTiming {
        ExistingTiming {
            bpm: 120.0,
            time_signature: "4/4".into(),
            tempo_markers: Vec::new(),
            signature_markers: Vec::new(),
        }
    }

    fn span(start: f64, end: f64) -> SongSpan {
        SongSpan {
            start_seconds: start,
            end_seconds: end,
        }
    }

    #[test]
    fn first_downbeat_on_the_song_start_is_a_marker_there() {
        let proposal = propose_tempo_markers(
            &analysis(vec![segment(0.001, 90.0, 4, 40)]),
            span(100.0, 220.0),
            &timing(),
        );
        assert_eq!(
            proposal.tempo_markers,
            vec![ProposedTempoMarker {
                start_seconds: 100.0,
                bpm: 90.0,
                ramp: false
            }]
        );
        // Same meter, but the bar restarts on the song's first downbeat: the
        // timeline grid only does that at a time signature marker.
        assert_eq!(
            proposal.signature_markers,
            vec![ProposedSignatureMarker {
                start_seconds: 100.0,
                signature: "4/4".into(),
            }]
        );
        assert_eq!(proposal.current_bpm, 120.0);
        assert!(!proposal.unchanged);
    }

    fn positions(markers: &[ProposedSignatureMarker]) -> Vec<f64> {
        markers.iter().map(|m| m.start_seconds).collect()
    }

    #[test]
    fn a_grid_starting_just_before_the_song_moves_forward_a_bar() {
        // Estimated from the music: first downbeat 80 ms before the song.
        let proposal = propose_tempo_markers(
            &analysis(vec![segment(-0.08, 127.0, 4, 40)]),
            span(100.0, 220.0),
            &timing(),
        );
        let bar = 4.0 * 60.0 / 127.0;
        assert_eq!(proposal.tempo_markers.len(), 1, "{proposal:?}");
        assert_eq!(proposal.tempo_markers[0].start_seconds, 100.0);
        let restarts = positions(&proposal.signature_markers);
        assert_eq!(restarts.len(), 2, "{proposal:?}");
        assert!((restarts[1] - (99.92 + bar)).abs() < 1e-9);
    }

    #[test]
    fn grid_is_carried_back_to_the_song_start() {
        // 90 BPM 4/4: a bar is 2.666 s. A downbeat 6 s in → 2 bars back,
        // and the 0.67 s before that are a pickup.
        let proposal = propose_tempo_markers(
            &analysis(vec![segment(6.0, 90.0, 4, 40)]),
            span(100.0, 220.0),
            &timing(),
        );
        let bar = 4.0 * 60.0 / 90.0;
        assert_eq!(proposal.tempo_markers.len(), 1, "{proposal:?}");
        assert_eq!(proposal.tempo_markers[0].start_seconds, 100.0);
        let restarts = positions(&proposal.signature_markers);
        assert_eq!(restarts[0], 100.0);
        assert!((restarts[1] - (106.0 - 2.0 * bar)).abs() < 1e-9);
    }

    #[test]
    fn a_click_a_few_ms_into_the_song_starts_bar_one_on_the_song() {
        // "Rey de Reyes": the click stem starts 15 ms in; an MP3's encoder
        // delay is ~26 ms.
        for offset in [0.015, 0.028] {
            let proposal = propose_tempo_markers(
                &analysis(vec![segment(offset, 147.0, 4, 40)]),
                span(100.0, 220.0),
                &timing(),
            );
            assert_eq!(proposal.tempo_markers.len(), 1, "{proposal:?}");
            assert_eq!(proposal.tempo_markers[0].start_seconds, 100.0);
            assert_eq!(positions(&proposal.signature_markers), vec![100.0]);
        }
    }

    #[test]
    fn bar_one_on_the_song_start_does_not_stretch_the_tempo() {
        // The click starts 25 ms in, at 125, and goes to 140 on bar 17.
        // Counted from the song start the 125 came out 124.84 to land there
        // ("Fiesta en el desierto", 61 ms in: 124.75); the grid restarts
        // the bar on the click instead.
        let bar = 240.0 / 125.0;
        let first = segment(0.025, 125.0, 4, 16);
        let second = segment(0.025 + 16.0 * bar, 140.0, 4, 8);
        let proposal = propose_tempo_markers(
            &analysis(vec![first, second]),
            span(100.0, 220.0),
            &timing(),
        );
        let markers: Vec<(f64, f64)> = proposal
            .tempo_markers
            .iter()
            .map(|m| (m.start_seconds, m.bpm))
            .collect();
        assert_eq!(markers.len(), 2, "{proposal:?}");
        assert_eq!(markers[0], (100.0, 125.0));
        assert!(
            (markers[1].0 - (100.025 + 16.0 * bar)).abs() < 1e-9,
            "{markers:?}"
        );
        assert_eq!(markers[1].1, 140.0);
        assert_eq!(
            positions(&proposal.signature_markers),
            vec![100.0, markers[1].0],
            "{proposal:?}"
        );
    }

    #[test]
    fn a_song_on_a_pickup_has_its_tempo_from_its_start() {
        // "Es Él": the click starts two beats before bar 1. The song before
        // (120 BPM) must not rule those two beats.
        let beat = 60.0 / 70.0;
        let proposal = propose_tempo_markers(
            &analysis(vec![segment(2.0 * beat, 70.0, 4, 40)]),
            span(100.0, 260.0),
            &timing(),
        );
        assert_eq!(
            proposal.tempo_markers,
            vec![ProposedTempoMarker {
                start_seconds: 100.0,
                bpm: 70.0,
                ramp: false
            }]
        );
        let restarts = positions(&proposal.signature_markers);
        assert_eq!(restarts.len(), 2, "{proposal:?}");
        assert_eq!(restarts[0], 100.0);
        assert!((restarts[1] - (100.0 + 2.0 * beat)).abs() < 1e-9);
    }

    #[test]
    fn markers_already_in_place_are_unchanged() {
        let mut existing = timing();
        existing.tempo_markers = vec![(100.0, 90.0), (224.0, 120.0)];
        existing.signature_markers = vec![(100.0, "4/4".into()), (224.0, "4/4".into())];
        let proposal = propose_tempo_markers(
            &analysis(vec![segment(0.0, 90.0, 4, 40)]),
            span(100.0, 220.0),
            &existing,
        );
        assert!(proposal.unchanged, "{proposal:?}");
    }

    #[test]
    fn same_tempo_at_the_session_start_is_unchanged() {
        // At 0 the markers are the song's own tempo and meter.
        let proposal = propose_tempo_markers(
            &analysis(vec![segment(0.0, 120.0, 4, 40)]),
            span(0.0, 120.0),
            &timing(),
        );
        assert_eq!(proposal.tempo_markers.len(), 1);
        assert!(proposal.unchanged, "{proposal:?}");
    }

    #[test]
    fn a_song_always_starts_with_its_own_tempo_and_meter() {
        // Even when the song before ends on the same tempo: editing that one
        // later must not move this one.
        let proposal = propose_tempo_markers(
            &analysis(vec![segment(0.0, 120.0, 4, 40)]),
            span(100.0, 220.0),
            &timing(),
        );
        assert_eq!(proposal.tempo_markers.len(), 1);
        assert_eq!(proposal.tempo_markers[0].start_seconds, 100.0);
        assert_eq!(positions(&proposal.signature_markers), vec![100.0]);
    }

    #[test]
    fn a_tempo_change_mid_song_is_a_second_marker() {
        let first = segment(0.0, 120.0, 4, 8);
        let second = segment(16.0, 90.0, 4, 8);
        let proposal =
            propose_tempo_markers(&analysis(vec![first, second]), span(10.0, 60.0), &timing());
        assert_eq!(proposal.tempo_markers.len(), 2);
        assert_eq!(proposal.tempo_markers[0].start_seconds, 10.0);
        assert_eq!(proposal.tempo_markers[1].start_seconds, 26.0);
        assert_eq!(proposal.tempo_markers[1].bpm, 90.0);
    }

    #[test]
    fn same_tempo_off_the_grid_restarts_it() {
        // After a gap the click comes back half a beat late: same BPM, but
        // the grid must restart there.
        let first = segment(0.0, 120.0, 4, 8);
        let second = segment(20.25, 120.0, 4, 8);
        let proposal =
            propose_tempo_markers(&analysis(vec![first, second]), span(0.0, 60.0), &timing());
        assert_eq!(proposal.tempo_markers.len(), 2);
        assert_eq!(proposal.tempo_markers[1].start_seconds, 20.25);
        // …and the grid only restarts at a time signature marker.
        assert_eq!(positions(&proposal.signature_markers), vec![0.0, 20.25]);
    }

    #[test]
    fn a_tempo_change_on_the_grid_needs_no_signature_marker() {
        let first = segment(0.0, 120.0, 4, 8);
        let second = segment(16.0, 90.0, 4, 8);
        let proposal =
            propose_tempo_markers(&analysis(vec![first, second]), span(0.0, 60.0), &timing());
        assert_eq!(
            positions(&proposal.signature_markers),
            vec![0.0],
            "{proposal:?}"
        );
    }

    #[test]
    fn a_click_that_follows_the_band_restarts_no_bar() {
        // One-bar tempos as the click reads them: each fitted on its own
        // bar, so its grid ends a few dozen ms off the next downbeat.
        let mut segments = vec![segment(0.0, 71.0, 4, 8)];
        let mut at = 8.0 * 4.0 * 60.0 / 71.0;
        for (bpm, real_bar) in [(69.39, 3.73), (56.0, 4.28), (58.5, 4.10), (71.0, 3.38)] {
            segments.push(segment(at, bpm, 4, 1));
            at += real_bar;
        }
        segments.push(segment(at, 71.0, 4, 16));
        let proposal = propose_tempo_markers(&analysis(segments), span(100.0, 220.0), &timing());
        let mid_song: Vec<_> = proposal
            .signature_markers
            .iter()
            .filter(|m| m.start_seconds > 100.0)
            .collect();
        assert!(mid_song.is_empty(), "{proposal:#?}");
        // Every marker stays on the click's downbeat (the last 71 goes on
        // in the final stretch, which needs no marker of its own).
        let last = proposal.tempo_markers.last().expect("markers");
        assert_eq!(proposal.tempo_markers.len(), 5, "{proposal:#?}");
        assert!(
            (last.start_seconds - (100.0 + at - 3.38)).abs() < 0.03,
            "{proposal:#?}"
        );
    }

    #[test]
    fn a_tempo_a_few_ms_off_the_grid_stays_on_the_click() {
        // 12 ms off the 120 grid: heard if the marker moved there. It stays
        // on the click's downbeat and the 120 before it lands on it instead.
        let first = segment(0.0, 120.0, 4, 8);
        let second = segment(16.012, 90.0, 4, 8);
        let proposal =
            propose_tempo_markers(&analysis(vec![first, second]), span(0.0, 60.0), &timing());
        let markers: Vec<(f64, f64)> = proposal
            .tempo_markers
            .iter()
            .map(|m| (m.start_seconds, m.bpm))
            .collect();
        assert_eq!(markers.len(), 2, "{proposal:?}");
        assert!((markers[1].0 - 16.012).abs() < 0.001 && markers[1].1 == 90.0);
        let landing = 32.0 * 60.0 / markers[0].1;
        assert!((landing - 16.012).abs() < 0.003, "{proposal:?}");
        assert_eq!(
            positions(&proposal.signature_markers),
            vec![0.0],
            "{proposal:?}"
        );
    }

    #[test]
    fn a_ramp_is_a_ramp_marker_and_lands_on_one() {
        // 72 for 8 bars, then a 2-bar ritardando to 56 into the end.
        let steady = segment(0.0, 72.0, 4, 8);
        let start = 8.0 * 4.0 * 60.0 / 72.0;
        let ramp = TempoSegment {
            end_bpm: Some(56.0),
            ..segment(start, 72.0, 4, 2)
        };
        let proposal =
            propose_tempo_markers(&analysis(vec![steady, ramp]), span(100.0, 200.0), &timing());
        let markers: Vec<(f64, f64, bool)> = proposal
            .tempo_markers
            .iter()
            .map(|m| (m.start_seconds, m.bpm, m.ramp))
            .collect();
        let ramp_end = 100.0 + start + 120.0 * 8.0 / (72.0 + 56.0);
        assert_eq!(markers.len(), 3, "{proposal:#?}");
        assert_eq!(markers[0], (100.0, 72.0, false));
        // 72 again at the ramp's start: it needs its own marker.
        assert!((markers[1].0 - (100.0 + start)).abs() < 1e-9 && markers[1].2);
        assert!((markers[2].0 - ramp_end).abs() < 1e-9 && markers[2].1 == 56.0 && !markers[2].2);
        assert!(
            proposal
                .signature_markers
                .iter()
                .all(|m| m.start_seconds == 100.0),
            "{proposal:#?}"
        );
    }

    #[test]
    fn nothing_found_proposes_nothing() {
        let proposal = propose_tempo_markers(&analysis(vec![]), span(100.0, 220.0), &timing());
        assert!(proposal.tempo_markers.is_empty());
        assert!(proposal.signature_markers.is_empty());
    }
}
