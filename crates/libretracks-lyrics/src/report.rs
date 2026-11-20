//! What the song panel and the setlist linker show (steps 07-08): which
//! presentation a song is linked to (or which ones look like it), its groups
//! and what each section marker sends.

use libretracks_core::lyrics_match::{match_presentation, PresentationCandidate, PresentationMatch};
use libretracks_core::lead_time::{LeadGrid, LeadUnit};
use libretracks_core::lyrics_schedule::{auto_step_positions, region_section_markers};
use libretracks_core::section_vocab::normalize_title;
use libretracks_core::{LyricsLink, LyricsSoftware, Song};
use serde::Serialize;

use crate::clients::{LyricsClient, Presentation};
use crate::plan::{build_plan, MarkerReport};
use crate::LyricsError;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupInfo {
    pub label: String,
    pub slide_count: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub id: String,
    pub name: String,
    pub score: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum LinkState {
    /// Linked by the user or by an exact unique title.
    Linked,
    /// Not linked; these look like it.
    Suggested,
    /// Nothing found.
    NotFound,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegionReport {
    pub region_id: String,
    pub region_name: String,
    pub link_state: LinkState,
    /// The link the plan would use (stored, or found by exact title).
    pub link: Option<LyricsLink>,
    /// Whether `link` is what the session stores (false = to confirm).
    pub stored: bool,
    pub groups: Vec<GroupInfo>,
    pub markers: Vec<MarkerReport>,
    pub suggestions: Vec<Suggestion>,
    pub unmatched_sections: usize,
}

fn candidates(catalog: &[Presentation]) -> Vec<PresentationCandidate> {
    catalog
        .iter()
        .map(|presentation| PresentationCandidate {
            id: presentation.id.clone(),
            name: presentation.name.clone(),
        })
        .collect()
}

/// The report of one song. `catalog` is the program's list, read once by the
/// caller for a whole setlist.
pub async fn region_report(
    client: &dyn LyricsClient,
    software: LyricsSoftware,
    song: &Song,
    region_id: &str,
    catalog: &[Presentation],
) -> Result<RegionReport, LyricsError> {
    let region = song
        .regions
        .iter()
        .find(|region| region.id == region_id)
        .ok_or_else(|| LyricsError::NotFound {
            what: region_id.to_string(),
        })?;
    let stored_link = region
        .lyrics
        .as_ref()
        .and_then(|lyrics| lyrics.link_for(software))
        .cloned();
    let mut report = RegionReport {
        region_id: region.id.clone(),
        region_name: region.name.clone(),
        link_state: LinkState::NotFound,
        link: None,
        stored: false,
        groups: Vec::new(),
        markers: Vec::new(),
        suggestions: Vec::new(),
        unmatched_sections: 0,
    };
    let by_id = |id: &str| catalog.iter().find(|presentation| presentation.id == id);
    // The stored id if it still names that presentation here; else by name.
    let mut chosen: Option<(String, String, bool)> = stored_link.as_ref().and_then(|link| {
        let id = link.presentation_id.as_deref()?;
        let found = by_id(id)?;
        (normalize_title(&found.name) == normalize_title(&link.presentation_name)
            || link.presentation_name.is_empty())
        .then(|| (found.id.clone(), found.name.clone(), true))
    });
    if chosen.is_none() {
        let wanted = stored_link
            .as_ref()
            .map(|link| link.presentation_name.clone())
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| region.name.clone());
        match match_presentation(&wanted, &candidates(catalog)) {
            PresentationMatch::Exact(id) => {
                let name = by_id(&id).map(|found| found.name.clone()).unwrap_or_default();
                chosen = Some((id, name, stored_link.is_some()));
            }
            PresentationMatch::Suggestions(found) => {
                report.link_state = LinkState::Suggested;
                report.suggestions = found
                    .into_iter()
                    .filter_map(|(id, score)| {
                        Some(Suggestion {
                            name: by_id(&id)?.name.clone(),
                            id,
                            score,
                        })
                    })
                    .collect();
            }
            PresentationMatch::None => {}
        }
    }
    let Some((id, name, stored)) = chosen else {
        report.link = stored_link;
        return Ok(report);
    };
    let link = LyricsLink {
        software,
        presentation_id: Some(id.clone()),
        presentation_name: name,
        overrides: stored_link
            .map(|link| link.overrides)
            .unwrap_or_default(),
    };
    let structure = client.structure(&id).await?;
    let markers = region_section_markers(song, region);
    let plan = build_plan(software, &markers, &structure, &link);
    let mut seen: Vec<String> = Vec::new();
    for entry in &structure.entries {
        if !seen.contains(&entry.group_label) {
            seen.push(entry.group_label.clone());
            report.groups.push(GroupInfo {
                label: entry.group_label.clone(),
                slide_count: entry.slide_count,
            });
        }
    }
    report.markers = plan.report(&markers);
    let grid = LeadGrid::new(song);
    for (index, marker) in markers.iter().enumerate() {
        let Some(entry) = report.markers.iter_mut().find(|entry| entry.marker_id == marker.id) else {
            continue;
        };
        if entry.slide_count <= 1 {
            continue;
        }
        let end = markers
            .get(index + 1)
            .map_or(region.end_seconds, |next| next.start_seconds);
        entry.auto_change_bars = auto_step_positions(&grid, marker.start_seconds, end, entry.slide_count)
            .into_iter()
            .map(|at| grid.musical_span(marker.start_seconds, at, LeadUnit::Bars).floor() as u32 + 1)
            .collect();
    }
    report.unmatched_sections = plan.unmatched_count();
    report.link_state = LinkState::Linked;
    report.stored = stored;
    report.link = Some(link);
    Ok(report)
}
