//! The concrete orders of one song (D7, D9, D13, D14): for each section
//! marker, the order that shows its group and the orders of its slide
//! changes. Built once per song from its markers, the presentation's
//! structure and the user's corrections; nothing is looked up while playing
//! (D18).

use std::collections::HashMap;

use libretracks_core::lyrics_match::{match_group, section_occurrences};
use libretracks_core::section_vocab::marker_section_id;
use libretracks_core::{LyricsLink, LyricsSoftware, Marker, OverrideTarget};
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
    /// A slide inside the section: absolute `index` where the program allows
    /// it, `None` = next slide (ProPresenter).
    Step {
        presentation_id: String,
        index: Option<u32>,
    },
    /// Blank the lyrics.
    Clear,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum MarkerStatus {
    /// Matched by name; `automatic` false when a correction chose it.
    Matched { group_label: String, automatic: bool },
    /// The user said: blank the screen here.
    Clear,
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
}

#[derive(Debug, Clone, PartialEq)]
pub struct SongLyricsPlan {
    pub software: LyricsSoftware,
    pub presentation_id: String,
    pub presentation_title: String,
    pub prepare: LyricsCommand,
    pub clear: LyricsCommand,
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
    /// Automatic slide changes: the bar of the section each falls on
    /// (1-based: "changes on bar 5"). Filled by the report.
    pub auto_change_bars: Vec<u32>,
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
                    auto_change_bars: Vec::new(),
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
        let plan = match chosen {
            Err(MarkerStatus::Clear) => MarkerPlan {
                status: MarkerStatus::Clear,
                section: Some(LyricsCommand::Clear),
                slide_count: 0,
                steps: Vec::new(),
            },
            Err(status) => MarkerPlan {
                status,
                section: None,
                slide_count: 0,
                steps: Vec::new(),
            },
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
                }
            }
        };
        plans.insert(marker.id.clone(), plan);
    }

    SongLyricsPlan {
        software,
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
