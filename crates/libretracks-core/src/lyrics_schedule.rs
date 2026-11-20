//! When to send each lyrics change (plan `lyrics-sync`, D15/D16): the third
//! user of the lead planner after MIDI clips and automation cues.
//!
//! Every section marker of a song with lyrics is a [`LeadItem`] anchored on
//! the marker with the song's (or the global) lead; every slide change inside
//! a section is one more, anchored where it falls. The window function emits
//! [`LyricsEvent`]s in firing order, following what the planner says about
//! pending jumps, vamps and landings. No clock, no network, no desktop: the
//! runtime pushes the events to a worker that does the HTTP.

use std::collections::HashMap;

use crate::lead_plan::{LeadItem, LeadPlanner};
use crate::lead_time::{LeadGrid, LeadTime, LeadUnit};
use crate::lyrics_match::section_occurrences;
use crate::model::{Marker, MarkerCategory, Song, SongRegion, StepMode};

const EPSILON: f64 = 1.0e-6;

#[derive(Debug, Clone, PartialEq)]
pub enum LyricsEvent {
    /// The song is about to start: prepare its presentation.
    EnterSong { region_id: String },
    /// A section starts: show its group. `occurrence` is which time this
    /// section comes round in the song (the third chorus is 2).
    Section {
        region_id: String,
        marker_id: String,
        occurrence: u32,
    },
    /// Slide `k` (1-based within the section; 0 is the section itself) of a
    /// section with several slides.
    Step {
        region_id: String,
        marker_id: String,
        k: u32,
    },
    /// The song ended.
    ExitSong { region_id: String },
    /// The playhead landed somewhere (seek, play, jump, song change,
    /// failover): what should be on screen now. `marker_id: None` = inside
    /// the song but before its first section.
    Land {
        region_id: String,
        marker_id: Option<String>,
        occurrence: u32,
        k_passed: u32,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub enum LyricsItemKind {
    EnterSong,
    Section { marker_id: String, occurrence: u32 },
    Step { marker_id: String, k: u32 },
    ExitSong,
}

/// One schedulable lyrics change, owning what a [`LeadItem`] borrows.
#[derive(Debug, Clone, PartialEq)]
pub struct LyricsItem {
    pub id: String,
    pub region_id: String,
    pub kind: LyricsItemKind,
    pub anchor: f64,
    /// `None` = fires on its anchor (the end of a song).
    pub lead: Option<LeadTime>,
}

impl LyricsItem {
    pub fn lead_item(&self) -> LeadItem<'_> {
        LeadItem {
            id: &self.id,
            anchor: self.anchor,
            lead: self.lead.as_ref(),
        }
    }

    fn event(&self) -> LyricsEvent {
        let region_id = self.region_id.clone();
        match &self.kind {
            LyricsItemKind::EnterSong => LyricsEvent::EnterSong { region_id },
            LyricsItemKind::Section {
                marker_id,
                occurrence,
            } => LyricsEvent::Section {
                region_id,
                marker_id: marker_id.clone(),
                occurrence: *occurrence,
            },
            LyricsItemKind::Step { marker_id, k } => LyricsEvent::Step {
                region_id,
                marker_id: marker_id.clone(),
                k: *k,
            },
            LyricsItemKind::ExitSong => LyricsEvent::ExitSong { region_id },
        }
    }
}

fn lyrics_enabled(region: &SongRegion) -> bool {
    region.lyrics.as_ref().is_some_and(|lyrics| lyrics.enabled)
}

/// Section markers inside a region, in time order. Cues never send lyrics.
pub fn region_section_markers<'a>(song: &'a Song, region: &SongRegion) -> Vec<&'a Marker> {
    let mut markers: Vec<&Marker> = song
        .section_markers
        .iter()
        .filter(|marker| {
            marker.category() == MarkerCategory::Section
                && marker.start_seconds >= region.start_seconds - EPSILON
                && marker.start_seconds < region.end_seconds - EPSILON
        })
        .collect();
    markers.sort_by(|a, b| a.start_seconds.total_cmp(&b.start_seconds));
    markers
}

/// Where the slide changes of a section fall, in seconds, for `slides`
/// slides between `start` and `end`: whole bars when they fit (8 bars and 2
/// slides → bar 5), whole beats otherwise.
pub fn auto_step_positions(grid: &LeadGrid, start: f64, end: f64, slides: u32) -> Vec<f64> {
    if slides <= 1 || end <= start {
        return Vec::new();
    }
    let changes = slides - 1;
    let n = f64::from(slides);
    let bars = grid.musical_span(start, end, LeadUnit::Bars).floor();
    let (unit, total) = if bars >= n {
        (LeadUnit::Bars, bars)
    } else {
        let beats = grid.musical_span(start, end, LeadUnit::Beats).floor();
        if beats >= n {
            (LeadUnit::Beats, beats)
        } else {
            (LeadUnit::Seconds, end - start)
        }
    };
    (1..=changes)
        .map(|i| {
            let offset = if unit == LeadUnit::Seconds {
                total * f64::from(i) / n
            } else {
                (total * f64::from(i) / n).floor()
            };
            grid.seconds_after(start, offset, unit)
        })
        .collect()
}

/// Every lyrics item of the song. `slide_counts` (marker id → slides of its
/// group, from the resolved plan) feeds the automatic slide changes; without
/// it, sections only.
pub fn lyrics_items(
    song: &Song,
    grid: &LeadGrid,
    global_lead: &LeadTime,
    slide_counts: Option<&HashMap<String, u32>>,
) -> Vec<LyricsItem> {
    let mut items = Vec::new();
    for (index, region) in song.regions.iter().enumerate() {
        let Some(lyrics) = region.lyrics.as_ref().filter(|lyrics| lyrics.enabled) else {
            continue;
        };
        let lead = lyrics.lead.unwrap_or(*global_lead);
        let region_id = region.id.clone();
        items.push(LyricsItem {
            id: format!("{region_id}#enter"),
            region_id: region_id.clone(),
            kind: LyricsItemKind::EnterSong,
            anchor: region.start_seconds,
            lead: Some(lead),
        });
        let markers = region_section_markers(song, region);
        let occurrences: HashMap<String, u32> = section_occurrences(markers.iter().copied())
            .into_iter()
            .map(|entry| (entry.marker_id, entry.occurrence))
            .collect();
        for (position, marker) in markers.iter().enumerate() {
            let start = marker.start_seconds;
            let end = markers
                .get(position + 1)
                .map_or(region.end_seconds, |next| next.start_seconds);
            items.push(LyricsItem {
                id: marker.id.clone(),
                region_id: region_id.clone(),
                kind: LyricsItemKind::Section {
                    marker_id: marker.id.clone(),
                    occurrence: occurrences.get(&marker.id).copied().unwrap_or(0),
                },
                anchor: start,
                lead: Some(lead),
            });
            let steps: Vec<f64> = match lyrics.step_mode {
                StepMode::Off => Vec::new(),
                StepMode::Manual => lyrics
                    .steps_for(&marker.id)
                    .into_iter()
                    .filter(|beats| *beats > EPSILON)
                    .map(|beats| grid.seconds_after(start, beats, LeadUnit::Beats))
                    .filter(|at| *at < end - EPSILON)
                    .collect(),
                StepMode::Auto => slide_counts
                    .and_then(|counts| counts.get(&marker.id))
                    .map(|slides| auto_step_positions(grid, start, end, *slides))
                    .unwrap_or_default(),
            };
            for (step, at) in steps.into_iter().enumerate() {
                let k = step as u32 + 1;
                items.push(LyricsItem {
                    id: format!("{}#{k}", marker.id),
                    region_id: region_id.clone(),
                    kind: LyricsItemKind::Step {
                        marker_id: marker.id.clone(),
                        k,
                    },
                    anchor: at,
                    lead: Some(lead),
                });
            }
        }
        // Straight into the next song with lyrics: its EnterSong takes over,
        // no clearing in between.
        let next_takes_over = song.regions.iter().enumerate().any(|(other, next)| {
            other != index
                && lyrics_enabled(next)
                && (next.start_seconds - region.end_seconds).abs() < EPSILON
        });
        if !next_takes_over {
            items.push(LyricsItem {
                id: format!("{region_id}#exit"),
                region_id,
                kind: LyricsItemKind::ExitSong,
                anchor: region.end_seconds,
                lead: None,
            });
        }
    }
    items
}

/// What has gone out, so a vamp lap does not resend the section already on
/// screen.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LyricsScheduleState {
    /// The last section sent and the slide it is on.
    showing: Option<(String, u32)>,
    entered: Option<String>,
}

impl LyricsScheduleState {
    pub fn reset(&mut self) {
        *self = Self::default();
    }

    /// Record an event and say whether it changes what is on screen.
    fn admit(&mut self, event: &LyricsEvent) -> bool {
        match event {
            LyricsEvent::EnterSong { region_id } => {
                if self.entered.as_deref() == Some(region_id) {
                    return false;
                }
                self.entered = Some(region_id.clone());
                true
            }
            LyricsEvent::Section { marker_id, .. } => {
                if self
                    .showing
                    .as_ref()
                    .is_some_and(|(showing, k)| showing == marker_id && *k == 0)
                {
                    return false;
                }
                self.showing = Some((marker_id.clone(), 0));
                true
            }
            LyricsEvent::Step { marker_id, k, .. } => {
                self.showing = Some((marker_id.clone(), *k));
                true
            }
            LyricsEvent::ExitSong { region_id } => {
                if self.entered.as_deref() == Some(region_id) {
                    self.entered = None;
                }
                self.showing = None;
                true
            }
            LyricsEvent::Land {
                region_id,
                marker_id,
                k_passed,
                ..
            } => {
                self.entered = Some(region_id.clone());
                self.showing = marker_id.clone().map(|marker| (marker, *k_passed));
                true
            }
        }
    }

    /// Record a landing sent outside the window (the runtime's `Land`).
    pub fn note(&mut self, event: &LyricsEvent) {
        self.admit(event);
    }
}

/// The events whose start falls in `(previous, now]`, in firing order.
/// `planner` must have been synced with what is pending (as the MIDI runtime
/// does) before the call.
pub fn collect_lyrics_events(
    items: &[LyricsItem],
    grid: &LeadGrid,
    planner: &LeadPlanner,
    previous: f64,
    now: f64,
    state: &mut LyricsScheduleState,
) -> Vec<LyricsEvent> {
    if now <= previous {
        return Vec::new();
    }
    let mut due: Vec<(f64, usize)> = Vec::new();
    for (order, item) in items.iter().enumerate() {
        for start in planner.starts(grid, item.lead_item()) {
            if start > previous && start <= now {
                due.push((start, order));
            }
        }
    }
    due.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
    due.into_iter()
        .map(|(_, order)| items[order].event())
        .filter(|event| state.admit(event))
        .collect()
}

/// What should be on screen with the playhead at `position`: the section
/// whose marker it is past and how many of its slide changes have passed.
/// `None` outside every song with lyrics.
pub fn land_lyrics(song: &Song, items: &[LyricsItem], position: f64) -> Option<LyricsEvent> {
    let region = song.regions.iter().find(|region| {
        lyrics_enabled(region)
            && position >= region.start_seconds - EPSILON
            && position < region.end_seconds - EPSILON
    })?;
    let section = items
        .iter()
        .filter(|item| item.region_id == region.id && item.anchor <= position + EPSILON)
        .filter_map(|item| match &item.kind {
            LyricsItemKind::Section {
                marker_id,
                occurrence,
            } => Some((marker_id, *occurrence)),
            _ => None,
        })
        .next_back();
    let Some((marker_id, occurrence)) = section else {
        return Some(LyricsEvent::Land {
            region_id: region.id.clone(),
            marker_id: None,
            occurrence: 0,
            k_passed: 0,
        });
    };
    let k_passed = items
        .iter()
        .filter(|item| item.anchor <= position + EPSILON)
        .filter(|item| {
            matches!(&item.kind, LyricsItemKind::Step { marker_id: step_marker, .. } if step_marker == marker_id)
        })
        .count() as u32;
    Some(LyricsEvent::Land {
        region_id: region.id.clone(),
        marker_id: Some(marker_id.clone()),
        occurrence,
        k_passed,
    })
}

#[cfg(test)]
#[path = "lyrics_schedule_tests.rs"]
mod tests;
