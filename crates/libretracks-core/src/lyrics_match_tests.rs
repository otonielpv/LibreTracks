use super::*;
use crate::model::{Marker, MarkerKind};
use crate::section_vocab::canonical_section;

fn group(label: &str) -> GroupCandidate {
    GroupCandidate {
        label: label.into(),
        ..GroupCandidate::default()
    }
}

fn section(text: &str) -> SectionId {
    canonical_section(text).expect(text)
}

fn matched<'a>(text: &str, groups: &'a [GroupCandidate]) -> Option<&'a str> {
    match_group(section(text), groups).map(|found| groups[found.index].label.as_str())
}

#[test]
fn chorus_matches_chorus_with_or_without_number() {
    assert_eq!(matched("Coro", &[group("Verse"), group("Chorus")]), Some("Chorus"));
    // SongSelect names it "Chorus 1" where Planning Center says "Chorus".
    assert_eq!(matched("Coro", &[group("Verse 1"), group("Chorus 1")]), Some("Chorus 1"));
}

#[test]
fn the_numbered_group_wins_and_falls_back_to_the_unnumbered_one() {
    let groups = [group("Verse"), group("Verse 2"), group("Chorus")];
    assert_eq!(matched("Verso 2", &groups), Some("Verse 2"));
    assert_eq!(matched("Verso 3", &groups), Some("Verse"));
    // A different number is different text.
    assert_eq!(matched("Verso 3", &[group("Verse 1"), group("Verse 2")]), None);
}

#[test]
fn equivalent_sections_match_only_when_nothing_better() {
    assert_eq!(matched("Final", &[group("Verse"), group("Outro")]), Some("Outro"));
    assert_eq!(matched("Final", &[group("Outro"), group("Ending")]), Some("Ending"));
}

#[test]
fn refrain_shows_a_refrain_or_nothing_never_the_chorus() {
    assert_eq!(matched("Refrain", &[group("Verse"), group("Chorus")]), None);
    assert_eq!(
        matched("Refrain", &[group("Chorus"), group("Refrain")]),
        Some("Refrain")
    );
    assert_eq!(matched("Coro", &[group("Refrain")]), None);
}

#[test]
fn bridge_never_matches_pre_chorus() {
    assert_eq!(matched("Puente", &[group("Pre-Chorus"), group("Verse")]), None);
}

#[test]
fn ties_go_to_the_first_group_in_order() {
    let groups = [group("Chorus"), group("Coro")];
    assert_eq!(match_group(section("Coro"), &groups).unwrap().index, 0);
}

#[test]
fn canonical_and_aliases_count() {
    // FreeShow: label translated, global group says what it is.
    let freeshow = GroupCandidate {
        label: "Estribillo bonito".into(),
        aliases: vec![],
        canonical: Some(section("chorus")),
    };
    // Holyrics: a user-defined name with an alias.
    let holyrics = GroupCandidate {
        label: "Louvor".into(),
        aliases: vec!["Ponte".into()],
        canonical: None,
    };
    let groups = [freeshow, holyrics];
    assert_eq!(match_group(section("Coro"), &groups).unwrap().index, 0);
    assert_eq!(match_group(section("Puente"), &groups).unwrap().index, 1);
}

fn presentation(id: &str, name: &str) -> PresentationCandidate {
    PresentationCandidate {
        id: id.into(),
        name: name.into(),
    }
}

#[test]
fn songs_link_to_presentations_only_on_a_unique_exact_title() {
    let catalogue = [
        presentation("1", "Way Maker"),
        presentation("2", "Cuan grande es el"),
        presentation("3", "Oceans"),
        presentation("4", "Oceans (Live)"),
    ];
    assert_eq!(
        match_presentation("Way Maker (En vivo)", &catalogue),
        PresentationMatch::Exact("1".into())
    );
    assert_eq!(
        match_presentation("01 Cuán Grande Es Él - G", &catalogue),
        PresentationMatch::Exact("2".into())
    );
    match match_presentation("Oceans", &catalogue) {
        PresentationMatch::Suggestions(found) => {
            let ids: Vec<&str> = found.iter().map(|(id, _)| id.as_str()).collect();
            assert!(ids.contains(&"3") && ids.contains(&"4"), "{ids:?}");
        }
        other => panic!("two equal titles must never link alone: {other:?}"),
    }
    assert_eq!(
        match_presentation("Santo Espíritu", &catalogue),
        PresentationMatch::None
    );
}

#[test]
fn look_alike_titles_are_suggested_best_first() {
    let catalogue = [
        presentation("a", "Waymaker"),
        presentation("b", "Way Maker Acoustic"),
        presentation("c", "Goodness of God"),
    ];
    match match_presentation("Way Maker", &catalogue) {
        PresentationMatch::Suggestions(found) => {
            assert!(found.len() >= 2);
            assert!(!found.iter().any(|(id, _)| id == "c"));
            assert!(found.windows(2).all(|pair| pair[0].1 >= pair[1].1));
        }
        other => panic!("{other:?}"),
    }
}

fn marker(id: &str, kind: MarkerKind, start: f64) -> Marker {
    Marker {
        id: id.into(),
        name: String::new(),
        start_seconds: start,
        digit: None,
        kind,
        variant: None,
        color: None,
        category_override: None,
    }
}

#[test]
fn arrangement_repeats_count_as_later_occurrences() {
    let markers = [
        marker("c~2", MarkerKind::Chorus, 60.0),
        marker("v", MarkerKind::Verse, 0.0),
        marker("c", MarkerKind::Chorus, 20.0),
        marker("build", MarkerKind::Build, 25.0),
        marker("c~1", MarkerKind::Chorus, 40.0),
    ];
    let found: Vec<(String, u32)> = section_occurrences(&markers)
        .into_iter()
        .map(|occurrence| (occurrence.marker_id, occurrence.occurrence))
        .collect();
    assert_eq!(
        found,
        vec![
            ("v".into(), 0),
            ("c".into(), 0),
            ("c~1".into(), 1),
            ("c~2".into(), 2),
        ]
    );
}

/// Plan smart-chart-import, paso 09 (C1): the items of the recorded plan
/// against a session where one title has a live suffix and a key.
#[test]
fn plan_items_match_session_songs_by_title() {
    let plan: serde_json::Value = serde_json::from_str(include_str!(
        "../../libretracks-pco/tests/fixtures/plan_items.json"
    ))
    .unwrap();
    let items: Vec<PresentationCandidate> = plan["data"]
        .as_array()
        .unwrap()
        .iter()
        .take(4)
        .map(|item| PresentationCandidate {
            id: item["id"].as_str().unwrap().into(),
            name: item["attributes"]["title"].as_str().unwrap().into(),
        })
        .collect();
    let songs = [
        ("r1", "Cancion de Prueba Uno (En vivo) - E"),
        ("r2", "01 Test Song Two"),
        ("r3", "Amazing Grace"),
        ("r4", "Otra canción"),
    ]
    .map(|(id, name)| PresentationCandidate {
        id: id.into(),
        name: name.into(),
    });
    let matches = match_titles(&items, &songs);
    let exact: Vec<Option<&str>> = matches.iter().map(|found| found.exact.as_deref()).collect();
    assert_eq!(exact, [Some("r1"), Some("r2"), Some("r3"), None]);
    assert!(matches[3].suggestions.is_empty());
}
