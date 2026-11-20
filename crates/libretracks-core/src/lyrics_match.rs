//! Matching LibreTracks to a lyrics program (ProPresenter, FreeShow,
//! Holyrics): a song to its presentation by title, and a section marker to
//! the presentation's group by section name. Pure: the lists come from the
//! program, read elsewhere (`libretracks-lyrics`).

use std::collections::HashMap;

use crate::model::{Marker, MarkerKind};
use crate::section_vocab::{canonical_section, marker_section_id, normalize_title, SectionId};

/// A group of the presentation, as the program names it.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct GroupCandidate {
    pub label: String,
    /// Other names the program gives it (Holyrics' slide description
    /// aliases and tag).
    pub aliases: Vec<String>,
    /// The section the program says it is (FreeShow's global group), when it
    /// says so; otherwise read from `label` and `aliases`.
    pub canonical: Option<SectionId>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GroupMatch {
    /// Index into the candidates.
    pub index: usize,
    /// 3 = same section and number; 2 = same section, one side unnumbered;
    /// 1 = an equivalent section (estribillo ≈ coro).
    pub score: u8,
}

/// Kinds that hold the same text under another name.
fn equivalent(a: MarkerKind, b: MarkerKind) -> bool {
    let pair = |x, y| (a == x && b == y) || (a == y && b == x);
    pair(MarkerKind::Refrain, MarkerKind::Chorus)
        || pair(MarkerKind::Ending, MarkerKind::Outro)
        || pair(MarkerKind::Tag, MarkerKind::Vamp)
}

fn score(section: SectionId, group: SectionId) -> u8 {
    let variant_score = |exact: u8, loose: u8| match (section.variant, group.variant) {
        (a, b) if a == b => exact,
        (Some(_), None) | (None, Some(_)) => loose,
        _ => 0,
    };
    if section.kind == group.kind {
        variant_score(3, 2)
    } else if equivalent(section.kind, group.kind) {
        variant_score(1, 1)
    } else {
        0
    }
}

fn candidate_sections(group: &GroupCandidate) -> Vec<SectionId> {
    let mut sections: Vec<SectionId> = group.canonical.into_iter().collect();
    sections.extend(
        std::iter::once(&group.label)
            .chain(group.aliases.iter())
            .filter_map(|text| canonical_section(text)),
    );
    sections
}

/// The group a section marker shows, best score first and, on a tie, the
/// first in the presentation's order. `None` when nothing is the same or an
/// equivalent section: the marker sends nothing.
pub fn match_group(section: SectionId, groups: &[GroupCandidate]) -> Option<GroupMatch> {
    let mut best: Option<GroupMatch> = None;
    for (index, group) in groups.iter().enumerate() {
        let group_score = candidate_sections(group)
            .into_iter()
            .map(|candidate| score(section, candidate))
            .max()
            .unwrap_or(0);
        if group_score > 0 && best.is_none_or(|best| group_score > best.score) {
            best = Some(GroupMatch {
                index,
                score: group_score,
            });
        }
    }
    best
}

/// A presentation of the program's catalogue.
#[derive(Debug, Clone, PartialEq)]
pub struct PresentationCandidate {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum PresentationMatch {
    /// The normalized title is the same and no other presentation has it.
    Exact(String),
    /// Look-alikes for the user to confirm, best first (at most five).
    Suggestions(Vec<(String, f64)>),
    None,
}

/// Similarity below this is not suggested.
pub const SUGGESTION_THRESHOLD: f64 = 0.75;
const MAX_SUGGESTIONS: usize = 5;

/// The presentation of a song (`region_name`): linked on its own only when
/// one title is exactly the same once normalized; otherwise suggestions.
pub fn match_presentation(
    region_name: &str,
    presentations: &[PresentationCandidate],
) -> PresentationMatch {
    let wanted = normalize_title(region_name);
    if wanted.is_empty() {
        return PresentationMatch::None;
    }
    let normalized: Vec<String> = presentations
        .iter()
        .map(|presentation| normalize_title(&presentation.name))
        .collect();
    let exact: Vec<usize> = (0..presentations.len())
        .filter(|&index| normalized[index] == wanted)
        .collect();
    if exact.len() == 1 {
        return PresentationMatch::Exact(presentations[exact[0]].id.clone());
    }
    let mut scored: Vec<(String, f64)> = presentations
        .iter()
        .zip(&normalized)
        .map(|(presentation, name)| (presentation.id.clone(), title_similarity(&wanted, name)))
        .filter(|(_, similarity)| *similarity >= SUGGESTION_THRESHOLD)
        .collect();
    scored.sort_by(|a, b| b.1.total_cmp(&a.1));
    scored.truncate(MAX_SUGGESTIONS);
    if scored.is_empty() {
        PresentationMatch::None
    } else {
        PresentationMatch::Suggestions(scored)
    }
}

/// How alike two normalized titles are, 0..=1: the best of Jaro-Winkler on
/// the whole title (typos) and the share of words in common (extra words,
/// "Way Maker" vs "Way Maker Live Version").
pub fn title_similarity(a: &str, b: &str) -> f64 {
    if a == b {
        return 1.0;
    }
    let words_a: Vec<&str> = a.split_whitespace().collect();
    let words_b: Vec<&str> = b.split_whitespace().collect();
    let common = words_a.iter().filter(|word| words_b.contains(word)).count();
    let dice = if words_a.is_empty() || words_b.is_empty() {
        0.0
    } else {
        2.0 * common as f64 / (words_a.len() + words_b.len()) as f64
    };
    dice.max(jaro_winkler(a, b))
}

fn jaro_winkler(a: &str, b: &str) -> f64 {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let window = (a.len().max(b.len()) / 2).saturating_sub(1);
    let mut matched_b = vec![false; b.len()];
    let mut matches_a = Vec::new();
    for (i, ca) in a.iter().enumerate() {
        let low = i.saturating_sub(window);
        let high = (i + window + 1).min(b.len());
        for j in low..high {
            if !matched_b[j] && b[j] == *ca {
                matched_b[j] = true;
                matches_a.push(*ca);
                break;
            }
        }
    }
    let m = matches_a.len();
    if m == 0 {
        return 0.0;
    }
    let matches_b: Vec<char> = b
        .iter()
        .zip(&matched_b)
        .filter_map(|(c, matched)| matched.then_some(*c))
        .collect();
    let transpositions = matches_a
        .iter()
        .zip(&matches_b)
        .filter(|(x, y)| x != y)
        .count()
        / 2;
    let m = m as f64;
    let jaro = (m / a.len() as f64 + m / b.len() as f64 + (m - transpositions as f64) / m) / 3.0;
    let prefix = a
        .iter()
        .zip(&b)
        .take(4)
        .take_while(|(x, y)| x == y)
        .count() as f64;
    jaro + prefix * 0.1 * (1.0 - jaro)
}

/// One section marker of a song in time order and which time its section
/// comes round: the third chorus is `occurrence` 2. Arrangement repeats
/// (`"{id}~{n}"`) count like any other marker. Cues and unreadable custom
/// markers are left out.
#[derive(Debug, Clone, PartialEq)]
pub struct SectionOccurrence {
    pub marker_id: String,
    pub section: SectionId,
    pub occurrence: u32,
}

pub fn section_occurrences<'a>(
    markers: impl IntoIterator<Item = &'a Marker>,
) -> Vec<SectionOccurrence> {
    let mut sections: Vec<(&Marker, SectionId)> = markers
        .into_iter()
        .filter_map(|marker| marker_section_id(marker).map(|section| (marker, section)))
        .collect();
    sections.sort_by(|a, b| a.0.start_seconds.total_cmp(&b.0.start_seconds));
    let mut seen: HashMap<SectionId, u32> = HashMap::new();
    sections
        .into_iter()
        .map(|(marker, section)| {
            let count = seen.entry(section).or_insert(0);
            let occurrence = *count;
            *count += 1;
            SectionOccurrence {
                marker_id: marker.id.clone(),
                section,
                occurrence,
            }
        })
        .collect()
}

#[cfg(test)]
#[path = "lyrics_match_tests.rs"]
mod tests;
