//! Lead time ("adelanto"): how long BEFORE its anchor a MIDI clip or an
//! automation cue fires.
//!
//! The use case that drives it (issue #7): a ProPresenter command that changes
//! the lyrics has to go out a beat or a bar before the section starts, so the
//! audience has the words on screen when the singing begins. The item is placed
//! ON the section marker and carries the lead; the runtime works out when the
//! section really starts (linear playback, an arrangement, or a pending live
//! jump into it) and fires the item that much earlier. See
//! `docs/plans/lead-time/00-DISENO.md`.
//!
//! Musical leads are measured on the same beat grid the engine's metronome
//! uses (`libretracks-audio::resolve_song_regions`): the tempo map with its
//! ramps, the warp source tempo inside a warped region, and the time signature
//! from its markers. One beat of lead is one metronome click, whatever the
//! tempo or the warp. Everything here is in source seconds, like every runtime
//! position.

use serde::{Deserialize, Serialize};

use crate::model::Song;
use crate::tempo_ramp::{tempo_spans, TempoSpan};

/// How far ahead of its anchor an item fires.
///
/// `rename_all_fields` is required: without it the struct-variant field names
/// would stay snake_case on the wire while the frontend sends camelCase (the
/// same trap `MidiEventKind` documents).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "unit",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum LeadTime {
    /// Beats of the governing time signature: the denominator's note value, so
    /// in 6/8 a beat is an eighth note, like the metronome.
    Beats { count: f64 },
    /// Bars of the governing time signature. Crossing a signature change, each
    /// side is measured in its own bars.
    Bars { count: f64 },
    /// Fixed wall-clock time on the source timeline.
    Seconds { seconds: f64 },
}

/// The unit a lead is expressed in, without its amount. Used to measure how
/// much of a lead a stretch of the timeline already covers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LeadUnit {
    Beats,
    Bars,
    Seconds,
}

impl LeadTime {
    pub fn unit(&self) -> LeadUnit {
        match self {
            LeadTime::Beats { .. } => LeadUnit::Beats,
            LeadTime::Bars { .. } => LeadUnit::Bars,
            LeadTime::Seconds { .. } => LeadUnit::Seconds,
        }
    }

    /// The amount in its own unit, clamped to a usable value: non-finite or
    /// negative amounts count as no lead.
    pub fn amount(&self) -> f64 {
        let raw = match *self {
            LeadTime::Beats { count } | LeadTime::Bars { count } => count,
            LeadTime::Seconds { seconds } => seconds,
        };
        if raw.is_finite() {
            raw.max(0.0)
        } else {
            0.0
        }
    }

    /// The same unit with another amount.
    pub fn with_amount(&self, amount: f64) -> LeadTime {
        lead_of(self.unit(), amount)
    }

    pub fn is_active(&self) -> bool {
        self.amount() > LEAD_EPSILON
    }
}

/// A lead of `amount` in `unit`.
pub fn lead_of(unit: LeadUnit, amount: f64) -> LeadTime {
    match unit {
        LeadUnit::Beats => LeadTime::Beats { count: amount },
        LeadUnit::Bars => LeadTime::Bars { count: amount },
        LeadUnit::Seconds => LeadTime::Seconds { seconds: amount },
    }
}

/// Leads (and lead remainders) below this are treated as none, so floating
/// noise in a remainder never fires an item a few microseconds early.
pub const LEAD_EPSILON: f64 = 1.0e-6;

/// Whether `lead` is present and non-zero.
pub fn has_lead(lead: Option<&LeadTime>) -> bool {
    lead.is_some_and(LeadTime::is_active)
}

/// One stretch of the beat grid with a single tempo curve and signature.
#[derive(Debug, Clone, Copy)]
struct GridSegment {
    start: f64,
    end: f64,
    tempo: TempoSpan,
    /// Quarter notes in one beat (the signature's denominator note).
    quarters_per_beat: f64,
    beats_per_bar: f64,
}

impl GridSegment {
    fn quarters_per_unit(&self, unit: LeadUnit) -> f64 {
        match unit {
            LeadUnit::Beats => self.quarters_per_beat,
            LeadUnit::Bars => self.quarters_per_beat * self.beats_per_bar,
            LeadUnit::Seconds => 1.0,
        }
    }

    /// How many `unit`s lie between `from` and `to` (both inside the segment).
    fn units_between(&self, from: f64, to: f64, unit: LeadUnit) -> f64 {
        if unit == LeadUnit::Seconds {
            return to - from;
        }
        self.tempo.quarters_between(from, to) / self.quarters_per_unit(unit)
    }

    /// The instant `units` `unit`s before `to`.
    fn seconds_before(&self, to: f64, units: f64, unit: LeadUnit) -> f64 {
        if unit == LeadUnit::Seconds {
            return to - units;
        }
        self.tempo
            .seconds_after(to, -units * self.quarters_per_unit(unit))
    }
}

/// `(numerator, denominator)` of a signature like "6/8"; 4/4 when unreadable,
/// the fallback the rest of the grid uses.
fn parse_signature(signature: &str) -> (f64, f64) {
    signature
        .split_once('/')
        .and_then(|(numerator, denominator)| {
            let numerator = numerator.trim().parse::<u32>().ok()?;
            let denominator = denominator.trim().parse::<u32>().ok()?;
            (numerator > 0 && denominator > 0).then_some((numerator as f64, denominator as f64))
        })
        .unwrap_or((4.0, 4.0))
}

/// The warp source tempo when `position` lies inside a warped region: there the
/// source material plays at that tempo, whatever the map says.
fn warp_source_bpm_at(song: &Song, position: f64) -> Option<f64> {
    song.regions.iter().find_map(|region| {
        if !region.warp_enabled || position < region.start_seconds || position >= region.end_seconds
        {
            return None;
        }
        region
            .warp_source_bpm
            .filter(|bpm| bpm.is_finite() && *bpm > 0.0)
    })
}

fn segment_tempo(song: &Song, spans: &[TempoSpan], start: f64, end: f64) -> TempoSpan {
    if let Some(source_bpm) = warp_source_bpm_at(song, start) {
        return TempoSpan::constant(start, source_bpm);
    }
    spans
        .iter()
        .rev()
        .find(|span| span.start <= start + 1.0e-9)
        .map_or(TempoSpan::constant(start, song.bpm.max(1.0)), |span| {
            span.between(start, end)
        })
}

/// The song's beat grid from 0 to infinity, split wherever the tempo curve or
/// the signature changes. Mirrors `libretracks-audio::resolve_song_regions`.
fn grid_segments(song: &Song) -> Vec<GridSegment> {
    let mut boundaries: Vec<(f64, Option<&str>)> = Vec::new();
    boundaries.extend(
        song.tempo_markers
            .iter()
            .filter(|marker| marker.start_seconds > 0.0)
            .map(|marker| (marker.start_seconds, None)),
    );
    boundaries.extend(
        song.time_signature_markers
            .iter()
            .filter(|marker| marker.start_seconds > 0.0)
            .map(|marker| (marker.start_seconds, Some(marker.signature.as_str()))),
    );
    for region in &song.regions {
        if region.end_seconds <= region.start_seconds {
            continue;
        }
        for edge in [region.start_seconds, region.end_seconds] {
            if edge > 0.0 {
                boundaries.push((edge, None));
            }
        }
    }
    boundaries.retain(|(at, _)| at.is_finite());
    boundaries.sort_by(|left, right| left.0.total_cmp(&right.0));

    let spans = tempo_spans(song);
    let mut segments = Vec::with_capacity(boundaries.len() + 1);
    let mut start = 0.0;
    let mut signature = song.time_signature.as_str();
    let push = |segments: &mut Vec<GridSegment>, start: f64, end: f64, signature: &str| {
        let (numerator, denominator) = parse_signature(signature);
        segments.push(GridSegment {
            start,
            end,
            tempo: segment_tempo(song, &spans, start, end),
            quarters_per_beat: 4.0 / denominator,
            beats_per_bar: numerator,
        });
    };
    for (at, next_signature) in boundaries {
        if at > start {
            push(&mut segments, start, at, signature);
            start = at;
        }
        if let Some(next_signature) = next_signature {
            signature = next_signature;
        }
    }
    push(&mut segments, start, f64::INFINITY, signature);
    segments
}

/// Index of the segment holding the instant just BEFORE `position`: a lead is
/// measured in the music that plays up to that point.
fn segment_before(segments: &[GridSegment], position: f64) -> usize {
    segments
        .iter()
        .rposition(|segment| segment.start < position)
        .unwrap_or(0)
}

/// The song's beat grid, built once and queried many times (the MIDI runtime
/// asks for every clip on every tick). Cheap to build, but not free.
#[derive(Debug, Clone)]
pub struct LeadGrid {
    segments: Vec<GridSegment>,
}

impl LeadGrid {
    pub fn new(song: &Song) -> Self {
        Self {
            segments: grid_segments(song),
        }
    }

    /// The instant `lead` before `actual_start`, in source seconds, never
    /// before 0. `actual_start` is where the item's section really begins in
    /// what plays: the item's own position in linear playback, the jump's
    /// execution point when a jump lands on it.
    pub fn fire_seconds(&self, actual_start: f64, lead: Option<&LeadTime>) -> f64 {
        let Some(lead) = lead.filter(|lead| lead.is_active()) else {
            return actual_start;
        };
        if !actual_start.is_finite() || actual_start <= 0.0 {
            return actual_start.max(0.0);
        }
        let unit = lead.unit();
        let mut remaining = lead.amount();
        if unit == LeadUnit::Seconds {
            return (actual_start - remaining).max(0.0);
        }
        let mut position = actual_start;
        let mut index = segment_before(&self.segments, position);
        loop {
            let segment = &self.segments[index];
            let available = segment.units_between(segment.start, position, unit);
            if available >= remaining - LEAD_EPSILON || index == 0 {
                return segment.seconds_before(position, remaining, unit).max(0.0);
            }
            remaining -= available;
            position = segment.start;
            index -= 1;
        }
    }

    /// How many `unit`s of the grid lie between `from` and `to` (0 when `to` is
    /// not after `from`).
    pub fn musical_span(&self, from: f64, to: f64, unit: LeadUnit) -> f64 {
        if !(from.is_finite() && to.is_finite()) || to <= from {
            return 0.0;
        }
        if unit == LeadUnit::Seconds {
            return to - from;
        }
        self.segments
            .iter()
            .filter(|segment| segment.end > from && segment.start < to)
            .map(|segment| {
                segment.units_between(segment.start.max(from), segment.end.min(to), unit)
            })
            .sum()
    }

    /// The part of `lead` that spills before `landing` for an item anchored at
    /// `anchor` (≥ landing), in the lead's own unit. `None` when the lead fits
    /// between the landing and the anchor, i.e. the item fires normally after
    /// the jump lands, or when the item lies before the landing (the jump does
    /// not play it).
    pub fn remainder_before_landing(
        &self,
        landing: f64,
        anchor: f64,
        lead: Option<&LeadTime>,
    ) -> Option<LeadTime> {
        let lead = lead.filter(|lead| lead.is_active())?;
        if anchor < landing - LEAD_EPSILON {
            return None;
        }
        let covered = self.musical_span(landing, anchor, lead.unit());
        let remainder = lead.amount() - covered;
        (remainder > LEAD_EPSILON).then(|| lead.with_amount(remainder))
    }
}

/// One-off [`LeadGrid::fire_seconds`].
pub fn lead_fire_seconds(song: &Song, actual_start: f64, lead: Option<&LeadTime>) -> f64 {
    if !has_lead(lead) {
        return actual_start;
    }
    LeadGrid::new(song).fire_seconds(actual_start, lead)
}

/// One-off [`LeadGrid::musical_span`].
pub fn musical_span(song: &Song, from: f64, to: f64, unit: LeadUnit) -> f64 {
    LeadGrid::new(song).musical_span(from, to, unit)
}

/// One-off [`LeadGrid::remainder_before_landing`].
pub fn lead_remainder_before_landing(
    song: &Song,
    landing: f64,
    anchor: f64,
    lead: Option<&LeadTime>,
) -> Option<LeadTime> {
    LeadGrid::new(song).remainder_before_landing(landing, anchor, lead)
}

#[cfg(test)]
#[path = "lead_time_tests.rs"]
mod tests;
