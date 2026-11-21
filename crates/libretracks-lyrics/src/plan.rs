//! The concrete orders of one song (D7, D9, D13, D14): for each section
//! marker, the order that shows its group and the orders of its slide
//! changes. Built once per song from its markers, the presentation's
//! structure and the user's corrections; nothing is looked up while playing
//! (D18).

use std::collections::HashMap;

use libretracks_core::lyrics_match::{match_group, section_occurrences};
use libretracks_core::section_vocab::marker_section_id;
use libretracks_core::{LyricsLink, LyricsSoftware, Marker, OverrideTarget, StartTarget};
use serde::Serialize;

use crate::structure::LyricsStructure;

/// One order to the lyrics program. Each carries everything it needs to land
/// on its own (D7): a lost or late order is fixed by the next section.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum LyricsCommand {
    /// Get the presentation ready without showing it.
    Prepare { presentation_id: String },
    /// Show a group: by name (ProPresenter) or by the index of this
    /// appearance (FreeShow layout position, Holyrics order position).
    Section {
        presentation_id: String,
        group_label: String,
        index: u32,
    },
    /// One exact slide of the presentation, from wherever the program is: a
    /// section whose slides the user chose, or the song's start slide.
    Slide { presentation_id: String, index: u32 },
    /// A slide inside the section: absolute `index` where the program allows
    /// it, `None` = next slide (ProPresenter).
    Step {
        presentation_id: String,
        index: Option<u32>,
    },
    /// Blank the screen: no text and no background.
    Clear,
    /// Take only the text away: the background stays (interludes).
    ClearText,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum MarkerStatus {
    /// Matched by name; `automatic` false when a correction chose it.
    Matched { group_label: String, automatic: bool },
    /// The user said: blank the screen here.
    Clear,
    /// The user said: take the text away here, keep the background.
    ClearText,
    /// The user said: send nothing here.
    Skip,
    /// No group matches: nothing is sent (amber in the UI).
    Unmatched,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MarkerPlan {
    pub status: MarkerStatus,
    pub section: Option<LyricsCommand>,
    pub slide_count: u32,
    /// Order of slide `k` (1-based) at `steps[k - 1]`.
    pub steps: Vec<LyricsCommand>,
    /// The program's indexes of the slides this marker shows, in order.
    pub indexes: Vec<u32>,
    /// The slides were chosen by hand in the section editor.
    pub custom_slides: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SongLyricsPlan {
    pub software: LyricsSoftware,
    pub presentation_id: String,
    pub presentation_title: String,
    pub prepare: LyricsCommand,
    pub clear: LyricsCommand,
    /// What goes up when the song starts before its first section: its
    /// start slide, or `Clear`.
    pub start: LyricsCommand,
    /// `start` came from the automatic choice, not from the user.
    pub start_automatic: bool,
    /// By full marker id (`~n` included).
    pub markers: HashMap<String, MarkerPlan>,
    /// Marker ids in time order.
    pub order: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkerReport {
    pub marker_id: String,
    pub marker_name: String,
    pub occurrence: u32,
    pub start_seconds: f64,
    #[serde(flatten)]
    pub status: MarkerStatus,
    pub slide_count: u32,
    /// The program's indexes of the slides this marker shows.
    pub slides: Vec<u32>,
    pub custom_slides: bool,
    /// Where the next section (or the song) starts, in source seconds.
    pub end_seconds: f64,
    /// One bar before the marker: where the section recorder starts playing.
    pub count_in_seconds: f64,
    /// How its slides change, as stored (or from the song's mode).
    pub timing: libretracks_core::SlideTiming,
    /// Its own lead, if it has one (else the song's or the global one).
    pub lead: Option<libretracks_core::lead_time::LeadTime>,
    /// Where each slide change falls in the section, by its timing.
    /// Filled by the report.
    pub change_points: Vec<ChangePoint>,
}

/// A point of a section: bar and beat, both 1-based (bar 2, beat 3.5).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangePoint {
    pub bar: u32,
    pub beat: f64,
}

impl SongLyricsPlan {
    /// For the song panel: what each marker shows.
    pub fn report(&self, markers: &[&Marker]) -> Vec<MarkerReport> {
        let occurrences: HashMap<String, u32> = section_occurrences(markers.iter().copied())
            .into_iter()
            .map(|entry| (entry.marker_id, entry.occurrence))
            .collect();
        self.order
            .iter()
            .filter_map(|id| {
                let plan = self.markers.get(id)?;
                let marker = markers.iter().find(|marker| &marker.id == id)?;
                Some(MarkerReport {
                    marker_id: id.clone(),
                    marker_name: marker.name.clone(),
                    occurrence: occurrences.get(id).copied().unwrap_or(0),
                    start_seconds: marker.start_seconds,
                    status: plan.status.clone(),
                    slide_count: plan.slide_count,
                    slides: plan.indexes.clone(),
                    custom_slides: plan.custom_slides,
                    end_seconds: marker.start_seconds,
                    count_in_seconds: marker.start_seconds,
                    timing: libretracks_core::SlideTiming::Auto,
                    lead: None,
                    change_points: Vec::new(),
                })
            })
            .collect()
    }

    /// Slides of each marker's group, for the automatic slide changes.
    pub fn slide_counts(&self) -> HashMap<String, u32> {
        self.markers
            .iter()
            .map(|(id, plan)| (id.clone(), plan.slide_count))
            .collect()
    }

    pub fn unmatched_count(&self) -> usize {
        self.markers
            .values()
            .filter(|plan| plan.status == MarkerStatus::Unmatched)
            .count()
    }
}

/// The plan of one song. `markers` are the song's section markers (cues are
/// skipped here anyway), `link` its presentation in this program.
pub fn build_plan(
    software: LyricsSoftware,
    markers: &[&Marker],
    structure: &LyricsStructure,
    link: &LyricsLink,
) -> SongLyricsPlan {
    let presentation_id = structure.presentation_id.clone();
    let candidates = structure.group_candidates();
    let mut sorted: Vec<&Marker> = markers.to_vec();
    sorted.sort_by(|a, b| a.start_seconds.total_cmp(&b.start_seconds));
    let occurrences: HashMap<String, u32> = section_occurrences(sorted.iter().copied())
        .into_iter()
        .map(|entry| (entry.marker_id, entry.occurrence))
        .collect();
    // Occurrence of each chosen group label, counted along the song: a
    // correction to "Chorus 1" on two markers takes its two appearances.
    let mut label_counts: HashMap<String, u32> = HashMap::new();
    let mut plans = HashMap::new();
    let mut order = Vec::new();

    for marker in sorted {
        if marker.category() != libretracks_core::MarkerCategory::Section {
            continue;
        }
        order.push(marker.id.clone());
        let chosen: Result<(String, bool), MarkerStatus> = match link.override_for(&marker.id) {
            Some(OverrideTarget::Clear) => Err(MarkerStatus::Clear),
            Some(OverrideTarget::ClearText) => Err(MarkerStatus::ClearText),
            Some(OverrideTarget::Skip) => Err(MarkerStatus::Skip),
            Some(OverrideTarget::Group { label }) => {
                if structure.appearance(label, 0).is_some() {
                    Ok((label.clone(), false))
                } else {
                    Err(MarkerStatus::Unmatched)
                }
            }
            None => marker_section_id(marker)
                .and_then(|section| match_group(section, &candidates))
                .map(|found| (candidates[found.index].label.clone(), true))
                .ok_or(MarkerStatus::Unmatched),
        };
        // Slides chosen by hand win over the group (but not over "blank" or
        // "send nothing"); ones the presentation no longer has are dropped.
        let chosen_slides: Option<Vec<u32>> = link
            .slides_for(&marker.id)
            .map(|indexes| {
                indexes
                    .iter()
                    .copied()
                    .filter(|index| structure.has_slide(*index))
                    .collect::<Vec<u32>>()
            })
            .filter(|indexes| !indexes.is_empty());
        let plan = match chosen {
            Err(MarkerStatus::ClearText) => MarkerPlan {
                status: MarkerStatus::ClearText,
                section: Some(LyricsCommand::ClearText),
                slide_count: 0,
                steps: Vec::new(),
                indexes: Vec::new(),
                custom_slides: false,
            },
            Err(MarkerStatus::Clear) => MarkerPlan {
                status: MarkerStatus::Clear,
                section: Some(LyricsCommand::Clear),
                slide_count: 0,
                steps: Vec::new(),
                indexes: Vec::new(),
                custom_slides: false,
            },
            Err(MarkerStatus::Unmatched) if chosen_slides.is_some() => {
                custom_plan(&presentation_id, structure, chosen_slides.unwrap_or_default())
            }
            Err(status) => MarkerPlan {
                status,
                section: None,
                slide_count: 0,
                steps: Vec::new(),
                indexes: Vec::new(),
                custom_slides: false,
            },
            Ok(_) if chosen_slides.is_some() => {
                custom_plan(&presentation_id, structure, chosen_slides.unwrap_or_default())
            }
            Ok((label, automatic)) => {
                let count = label_counts.entry(label.clone()).or_insert(0);
                // Matched by section: the k-th time this section comes round
                // (D7). Chosen by hand: the k-th time this label was chosen.
                let occurrence = if automatic {
                    occurrences.get(&marker.id).copied().unwrap_or(*count)
                } else {
                    *count
                };
                *count += 1;
                let entry = structure
                    .appearance(&label, occurrence)
                    .expect("label exists in the structure");
                let steps = (1..entry.slide_count)
                    .map(|k| LyricsCommand::Step {
                        presentation_id: presentation_id.clone(),
                        index: match software {
                            LyricsSoftware::ProPresenter => None,
                            _ => Some(entry.first_index + k),
                        },
                    })
                    .collect();
                MarkerPlan {
                    status: MarkerStatus::Matched {
                        group_label: label.clone(),
                        automatic,
                    },
                    section: Some(LyricsCommand::Section {
                        presentation_id: presentation_id.clone(),
                        group_label: label,
                        index: entry.first_index,
                    }),
                    slide_count: entry.slide_count,
                    steps,
                    indexes: (0..entry.slide_count)
                        .map(|k| entry.first_index + k)
                        .collect(),
                    custom_slides: false,
                }
            }
        };
        plans.insert(marker.id.clone(), plan);
    }

    let auto_start = || {
        structure
            .title_slide()
            .map_or(LyricsCommand::Clear, |slide| LyricsCommand::Slide {
                presentation_id: presentation_id.clone(),
                index: slide.index,
            })
    };
    let (start, start_automatic) = match &link.start {
        Some(StartTarget::Clear) => (LyricsCommand::Clear, false),
        Some(StartTarget::ClearText) => (LyricsCommand::ClearText, false),
        Some(StartTarget::Slide { index }) if structure.has_slide(*index) => (
            LyricsCommand::Slide {
                presentation_id: presentation_id.clone(),
                index: *index,
            },
            false,
        ),
        _ => (auto_start(), true),
    };

    SongLyricsPlan {
        software,
        start,
        start_automatic,
        prepare: LyricsCommand::Prepare {
            presentation_id: presentation_id.clone(),
        },
        presentation_id,
        presentation_title: structure.title.clone(),
        clear: LyricsCommand::Clear,
        markers: plans,
        order,
    }
}

/// A marker showing the slides the user chose: the first one exactly, then
/// each of the others by its absolute index (every program allows it).
fn custom_plan(presentation_id: &str, structure: &LyricsStructure, indexes: Vec<u32>) -> MarkerPlan {
    let label = structure
        .slides
        .iter()
        .find(|slide| Some(slide.index) == indexes.first().copied())
        .map(|slide| slide.group_label.clone())
        .unwrap_or_default();
    MarkerPlan {
        status: MarkerStatus::Matched {
            group_label: label,
            automatic: false,
        },
        section: Some(LyricsCommand::Slide {
            presentation_id: presentation_id.to_string(),
            index: indexes[0],
        }),
        slide_count: indexes.len() as u32,
        steps: indexes[1..]
            .iter()
            .map(|index| LyricsCommand::Step {
                presentation_id: presentation_id.to_string(),
                index: Some(*index),
            })
            .collect(),
        indexes,
        custom_slides: true,
    }
}
