//! What the song panel and the setlist linker show (steps 07-08): which
//! presentation a song is linked to (or which ones look like it), its groups
//! and what each section marker sends.

use libretracks_core::lyrics_match::{match_presentation, PresentationCandidate, PresentationMatch};
use libretracks_core::lead_time::{LeadGrid, LeadUnit};
use libretracks_core::lyrics_schedule::{region_section_markers, section_step_positions};
use libretracks_core::section_vocab::normalize_title;
use libretracks_core::{LyricsLink, LyricsSoftware, Song};
use serde::Serialize;

use crate::clients::{LyricsClient, Presentation};
use crate::plan::{build_plan, ChangePoint, LyricsCommand, MarkerReport};
use crate::structure::SlideInfo;
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

/// What the song shows when it starts before its first section.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartReport {
    /// Chosen automatically (no `LyricsLink.start`).
    pub automatic: bool,
    /// The slide it shows; `None` = blank screen (or no text, below).
    pub slide: Option<u32>,
    /// Only the text goes: the background stays.
    pub clear_text: bool,
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
    /// Every slide of the presentation, for the section editor.
    pub slides: Vec<SlideInfo>,
    pub start: Option<StartReport>,
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
        slides: Vec::new(),
        start: None,
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
            .as_ref()
            .map(|link| link.overrides.clone())
            .unwrap_or_default(),
        slides: stored_link
            .as_ref()
            .map(|link| link.slides.clone())
            .unwrap_or_default(),
        start: stored_link.and_then(|link| link.start),
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
    let lyrics = region.lyrics.clone().unwrap_or_default();
    for (index, marker) in markers.iter().enumerate() {
        let Some(entry) = report.markers.iter_mut().find(|entry| entry.marker_id == marker.id) else {
            continue;
        };
        let end = markers
            .get(index + 1)
            .map_or(region.end_seconds, |next| next.start_seconds);
        entry.end_seconds = end;
        entry.count_in_seconds = grid.fire_seconds(
            marker.start_seconds,
            Some(&libretracks_core::lead_time::LeadTime::Bars { count: 1.0 }),
        );
        entry.timing = lyrics.timing_for(&marker.id);
        entry.lead = lyrics.lead_for(&marker.id);
        if entry.slide_count <= 1 {
            continue;
        }
        entry.change_points = section_step_positions(
            &lyrics,
            &marker.id,
            &grid,
            marker.start_seconds,
            end,
            Some(entry.slide_count),
        )
        .into_iter()
        .map(|at| {
            let bar = grid.musical_span(marker.start_seconds, at, LeadUnit::Bars).floor();
            let bar_start = grid.seconds_after(marker.start_seconds, bar, LeadUnit::Bars);
            let beat = grid.musical_span(bar_start, at, LeadUnit::Beats);
            ChangePoint {
                bar: bar as u32 + 1,
                beat: (beat * 2.0).round() / 2.0 + 1.0,
            }
        })
        .collect();
    }
    report.slides = structure.slides.clone();
    report.start = Some(StartReport {
        automatic: plan.start_automatic,
        slide: match plan.start {
            LyricsCommand::Slide { index, .. } => Some(index),
            _ => None,
        },
        clear_text: plan.start == LyricsCommand::ClearText,
    });
    report.unmatched_sections = plan.unmatched_count();
    report.link_state = LinkState::Linked;
    report.stored = stored;
    report.link = Some(link);
    Ok(report)
}
