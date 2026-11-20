//! What a presentation looks like, whatever program it comes from (D8): its
//! groups in presentation order, how many slides each has and where each
//! appearance starts in the program's own slide index. Each program's JSON is
//! read here; the plan only sees [`LyricsStructure`].

use libretracks_core::lyrics_match::GroupCandidate;
use libretracks_core::section_vocab::{canonical_section, SectionId};
use serde::Serialize;
use serde_json::Value;

use crate::LyricsError;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructureEntry {
    pub group_label: String,
    /// Other names of the group (Holyrics' slide description aliases).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub aliases: Vec<String>,
    #[serde(skip)]
    pub canonical: Option<SectionId>,
    pub slide_count: u32,
    /// Index of this appearance's first slide in the program's own numbering
    /// (FreeShow: 1-based layout position; Holyrics: 0-based position in the
    /// order; ProPresenter: 0-based slide of the flattened groups).
    pub first_index: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricsStructure {
    pub presentation_id: String,
    pub title: String,
    /// One per appearance of a group, in presentation order.
    pub entries: Vec<StructureEntry>,
}

impl LyricsStructure {
    /// The distinct groups, in order of first appearance, for matching.
    pub fn group_candidates(&self) -> Vec<GroupCandidate> {
        let mut seen: Vec<&str> = Vec::new();
        let mut candidates = Vec::new();
        for entry in &self.entries {
            if seen.contains(&entry.group_label.as_str()) {
                continue;
            }
            seen.push(&entry.group_label);
            candidates.push(GroupCandidate {
                label: entry.group_label.clone(),
                aliases: entry.aliases.clone(),
                canonical: entry.canonical,
            });
        }
        candidates
    }

    /// The `occurrence`-th appearance of a group (0 = first); the first one
    /// when the presentation has fewer (the text is the same).
    pub fn appearance(&self, label: &str, occurrence: u32) -> Option<&StructureEntry> {
        let mut appearances = self
            .entries
            .iter()
            .filter(|entry| entry.group_label == label);
        let first = appearances.clone().next()?;
        Some(appearances.nth(occurrence as usize).unwrap_or(first))
    }
}

fn text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

fn unexpected(what: &str) -> LyricsError {
    LyricsError::unexpected(format!("respuesta inesperada: {what}"))
}

/// ProPresenter `GET /v1/presentation/{uuid}`: groups flattened in their
/// order (the spec lists no arrangements; the group trigger does not need
/// them).
pub fn parse_propresenter(json: &Value) -> Result<LyricsStructure, LyricsError> {
    let presentation = json.get("presentation").unwrap_or(json);
    let id = presentation.get("id").unwrap_or(&Value::Null);
    let presentation_id = id
        .get("uuid")
        .and_then(text)
        .ok_or_else(|| unexpected("presentación sin uuid"))?;
    let title = id.get("name").and_then(text).unwrap_or_default();
    let groups = presentation
        .get("groups")
        .and_then(Value::as_array)
        .ok_or_else(|| unexpected("presentación sin grupos"))?;
    let mut entries = Vec::new();
    let mut index = 0u32;
    for group in groups {
        let label = group.get("name").and_then(text).unwrap_or_default();
        let slides = group
            .get("slides")
            .and_then(Value::as_array)
            .map_or(0, |slides| slides.len() as u32);
        entries.push(StructureEntry {
            canonical: canonical_section(&label),
            group_label: label,
            aliases: Vec::new(),
            slide_count: slides.max(1),
            first_index: index,
        });
        index += slides.max(1);
    }
    Ok(LyricsStructure {
        presentation_id,
        title,
        entries,
    })
}

/// FreeShow: `get_show_layout` (the active layout expanded, one entry per
/// slide, `parent` starts a group) plus `get_show` (each slide's `group` and
/// `globalGroup`). The section is matched on `globalGroup`, not on the label
/// the user may have translated.
pub fn parse_freeshow(
    show_id: &str,
    show: &Value,
    layout: &Value,
) -> Result<LyricsStructure, LyricsError> {
    let show = show.get("data").unwrap_or(show);
    let layout = layout.get("data").unwrap_or(layout);
    let title = show.get("name").and_then(text).unwrap_or_default();
    let slides = show.get("slides").cloned().unwrap_or(Value::Null);
    let rows = layout
        .as_array()
        .ok_or_else(|| unexpected("disposición de FreeShow sin filas"))?;
    let mut entries: Vec<StructureEntry> = Vec::new();
    for (position, row) in rows.iter().enumerate() {
        let kind = row.get("type").and_then(Value::as_str).unwrap_or("parent");
        let index = row
            .get("index")
            .and_then(Value::as_u64)
            .map_or(position as u32 + 1, |index| index as u32);
        if kind == "child" {
            if let Some(last) = entries.last_mut() {
                last.slide_count += 1;
                continue;
            }
        }
        let slide_id = row.get("id").and_then(text).unwrap_or_default();
        let slide = slides.get(&slide_id).unwrap_or(&Value::Null);
        let data = row.get("data").unwrap_or(&Value::Null);
        let label = slide
            .get("group")
            .or_else(|| data.get("group"))
            .and_then(text)
            .unwrap_or_default();
        let global = slide
            .get("globalGroup")
            .or_else(|| data.get("globalGroup"))
            .and_then(text);
        let canonical = global
            .as_deref()
            .and_then(canonical_section)
            .or_else(|| canonical_section(&label));
        entries.push(StructureEntry {
            group_label: label,
            aliases: global.into_iter().collect(),
            canonical,
            slide_count: 1,
            first_index: index,
        });
    }
    Ok(LyricsStructure {
        presentation_id: show_id.to_string(),
        title,
        entries,
    })
}

/// Holyrics `GetLyrics` (+ `GetSlideDescriptions` for the user's names and
/// aliases): slides in `order` (1-based slide numbers; all of them in a row
/// when absent), consecutive slides with the same description form a group.
pub fn parse_holyrics(
    lyrics: &Value,
    descriptions: Option<&Value>,
) -> Result<LyricsStructure, LyricsError> {
    let lyrics = lyrics.get("data").unwrap_or(lyrics);
    let presentation_id = lyrics
        .get("id")
        .and_then(text)
        .ok_or_else(|| unexpected("canción de Holyrics sin id"))?;
    let title = lyrics.get("title").and_then(text).unwrap_or_default();
    let slides = lyrics
        .get("slides")
        .and_then(Value::as_array)
        .ok_or_else(|| unexpected("canción de Holyrics sin diapositivas"))?;
    let order: Vec<usize> = lyrics
        .get("order")
        .and_then(Value::as_str)
        .map(|order| {
            order
                .split(',')
                .filter_map(|number| number.trim().parse::<usize>().ok())
                .filter(|number| *number >= 1 && *number <= slides.len())
                .map(|number| number - 1)
                .collect()
        })
        .filter(|order: &Vec<usize>| !order.is_empty())
        .unwrap_or_else(|| (0..slides.len()).collect());
    let description_list: Vec<Value> = descriptions
        .map(|value| value.get("data").unwrap_or(value))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let aliases_of = |label: &str| -> Vec<String> {
        description_list
            .iter()
            .find(|entry| entry.get("name").and_then(Value::as_str) == Some(label))
            .map(|entry| {
                let mut names: Vec<String> = entry
                    .get("aliases")
                    .and_then(Value::as_array)
                    .map(|aliases| aliases.iter().filter_map(text).collect())
                    .unwrap_or_default();
                names.extend(entry.get("tag").and_then(text));
                names
            })
            .unwrap_or_default()
    };
    let mut entries: Vec<StructureEntry> = Vec::new();
    let mut previous_slide: Option<usize> = None;
    for (position, slide_index) in order.iter().enumerate() {
        let label = slides[*slide_index]
            .get("slide_description")
            .and_then(text)
            .unwrap_or_default();
        let continues = entries.last().is_some_and(|last| {
            last.group_label == label
                && !label.is_empty()
                && previous_slide.is_some_and(|previous| previous + 1 == *slide_index)
        });
        previous_slide = Some(*slide_index);
        if continues {
            entries.last_mut().expect("checked").slide_count += 1;
            continue;
        }
        let aliases = aliases_of(&label);
        let canonical = canonical_section(&label)
            .or_else(|| aliases.iter().find_map(|alias| canonical_section(alias)));
        entries.push(StructureEntry {
            group_label: label,
            aliases,
            canonical,
            slide_count: 1,
            first_index: position as u32,
        });
    }
    Ok(LyricsStructure {
        presentation_id,
        title,
        entries,
    })
}
