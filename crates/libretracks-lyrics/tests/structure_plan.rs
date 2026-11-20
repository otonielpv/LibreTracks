//! Plan lyrics-sync, paso 05: estructura de cada programa y plan por canción
//! con la canción de prueba (Intro, Verso 1 ×2, Coro ×2, Verso 2, Coro,
//! Puente, Coro, Final).

use libretracks_core::{
    LyricsLink, LyricsSoftware, Marker, MarkerKind, OverrideTarget, SectionOverride,
};
use libretracks_lyrics::plan::{build_plan, LyricsCommand, MarkerStatus};
use libretracks_lyrics::structure::{
    parse_freeshow, parse_holyrics, parse_propresenter, LyricsStructure,
};
use serde_json::Value;

fn fixture(path: &str) -> Value {
    let full = format!("{}/tests/fixtures/{path}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(&full).expect(&full)).expect(&full)
}

fn propresenter() -> LyricsStructure {
    parse_propresenter(&fixture("propresenter/presentation.json")).unwrap()
}

fn freeshow() -> LyricsStructure {
    parse_freeshow(
        "show-waymaker",
        &fixture("freeshow/get_show.json"),
        &fixture("freeshow/get_show_layout.json"),
    )
    .unwrap()
}

fn holyrics() -> LyricsStructure {
    parse_holyrics(
        &fixture("holyrics/GetLyrics.json"),
        Some(&fixture("holyrics/GetSlideDescriptions.json")),
    )
    .unwrap()
}

fn shape(structure: &LyricsStructure) -> Vec<(String, u32, u32)> {
    structure
        .entries
        .iter()
        .map(|entry| (entry.group_label.clone(), entry.slide_count, entry.first_index))
        .collect()
}

fn rows(list: &[(&str, u32, u32)]) -> Vec<(String, u32, u32)> {
    list.iter()
        .map(|(label, count, index)| (label.to_string(), *count, *index))
        .collect()
}

#[test]
fn propresenter_groups_are_flattened_in_order() {
    let structure = propresenter();
    assert_eq!(structure.presentation_id, "PRES-WAYMAKER");
    assert_eq!(structure.title, "Way Maker");
    assert_eq!(
        shape(&structure),
        rows(&[
            ("Intro", 1, 0),
            ("Verse 1", 2, 1),
            ("Chorus", 2, 3),
            ("Verse 2", 1, 5),
            ("Bridge", 1, 6),
            ("Ending", 1, 7),
        ])
    );
    assert!(structure.entries.iter().all(|entry| entry.canonical.is_some()));
}

#[test]
fn freeshow_layout_is_expanded_with_repeats_and_reads_global_groups() {
    let structure = freeshow();
    assert_eq!(
        shape(&structure),
        rows(&[
            ("Intro", 1, 1),
            ("Estrofa 1", 2, 2),
            ("Estribillo", 2, 4),
            ("Estrofa 2", 1, 6),
            ("Estribillo", 2, 7),
            ("Puente", 1, 9),
            ("Estribillo", 2, 10),
            ("Final", 1, 12),
        ])
    );
    // "Estribillo" is a refrain by name but FreeShow says chorus.
    let chorus = &structure.entries[2];
    assert_eq!(chorus.canonical.unwrap().kind, MarkerKind::Chorus);
    // "Final" with globalGroup outro.
    assert_eq!(structure.entries[7].canonical.unwrap().kind, MarkerKind::Outro);
}

#[test]
fn holyrics_order_is_expanded_and_consecutive_slides_group() {
    let structure = holyrics();
    assert_eq!(structure.presentation_id, "812");
    assert_eq!(
        shape(&structure),
        rows(&[
            ("Intro", 1, 0),
            ("Verso 1", 2, 1),
            ("Coro", 2, 3),
            ("Verso 2", 1, 5),
            ("Coro", 2, 6),
            ("Puente", 1, 8),
            ("Coro", 2, 9),
            ("Final", 1, 11),
        ])
    );
    assert!(structure.entries[2].aliases.contains(&"Chorus".to_string()));
}

fn marker(id: &str, kind: MarkerKind, variant: Option<u8>, start: f64) -> Marker {
    Marker {
        id: id.into(),
        name: id.into(),
        start_seconds: start,
        digit: None,
        kind,
        variant,
        color: None,
        category_override: None,
    }
}

fn song_markers() -> Vec<Marker> {
    vec![
        marker("intro", MarkerKind::Intro, None, 0.0),
        marker("v1", MarkerKind::Verse, Some(1), 4.0),
        marker("c", MarkerKind::Chorus, None, 20.0),
        marker("v2", MarkerKind::Verse, Some(2), 28.0),
        marker("c~1", MarkerKind::Chorus, None, 36.0),
        marker("p", MarkerKind::Bridge, None, 44.0),
        marker("c~2", MarkerKind::Chorus, None, 52.0),
        marker("end", MarkerKind::Ending, None, 60.0),
        marker("build", MarkerKind::Build, None, 10.0),
    ]
}

fn link(software: LyricsSoftware, overrides: Vec<SectionOverride>) -> LyricsLink {
    LyricsLink {
        software,
        presentation_id: None,
        presentation_name: "Way Maker".into(),
        overrides,
    }
}

fn section_of(plan: &libretracks_lyrics::plan::SongLyricsPlan, id: &str) -> Option<LyricsCommand> {
    plan.markers.get(id).and_then(|marker| marker.section.clone())
}

fn index_of(plan: &libretracks_lyrics::plan::SongLyricsPlan, id: &str) -> u32 {
    match section_of(plan, id) {
        Some(LyricsCommand::Section { index, .. }) => index,
        other => panic!("{id}: {other:?}"),
    }
}

#[test]
fn propresenter_plan_triggers_groups_by_name_and_steps_with_next() {
    let markers = song_markers();
    let refs: Vec<&Marker> = markers.iter().collect();
    let plan = build_plan(
        LyricsSoftware::ProPresenter,
        &refs,
        &propresenter(),
        &link(LyricsSoftware::ProPresenter, vec![]),
    );
    assert_eq!(
        section_of(&plan, "c~2"),
        Some(LyricsCommand::Section {
            presentation_id: "PRES-WAYMAKER".into(),
            group_label: "Chorus".into(),
            index: 3,
        })
    );
    assert_eq!(
        plan.markers["v1"].steps,
        vec![LyricsCommand::Step {
            presentation_id: "PRES-WAYMAKER".into(),
            index: None
        }]
    );
    // Ending ≈ Ending; cues are not in the plan.
    assert!(!plan.markers.contains_key("build"));
    assert_eq!(plan.unmatched_count(), 0);
}

#[test]
fn freeshow_plan_sends_the_exact_index_of_each_repeat() {
    let markers = song_markers();
    let refs: Vec<&Marker> = markers.iter().collect();
    let plan = build_plan(
        LyricsSoftware::FreeShow,
        &refs,
        &freeshow(),
        &link(LyricsSoftware::FreeShow, vec![]),
    );
    assert_eq!(index_of(&plan, "c"), 4);
    assert_eq!(index_of(&plan, "c~1"), 7);
    assert_eq!(index_of(&plan, "c~2"), 10);
    assert_eq!(index_of(&plan, "v2"), 6);
    assert_eq!(
        plan.markers["c~1"].steps,
        vec![LyricsCommand::Step {
            presentation_id: "show-waymaker".into(),
            index: Some(8)
        }]
    );
    // Final (ending) ≈ outro by equivalence.
    assert_eq!(index_of(&plan, "end"), 12);
    assert_eq!(plan.slide_counts()["v1"], 2);
}

#[test]
fn holyrics_plan_uses_order_positions() {
    let markers = song_markers();
    let refs: Vec<&Marker> = markers.iter().collect();
    let plan = build_plan(
        LyricsSoftware::Holyrics,
        &refs,
        &holyrics(),
        &link(LyricsSoftware::Holyrics, vec![]),
    );
    assert_eq!(index_of(&plan, "intro"), 0);
    assert_eq!(index_of(&plan, "c~1"), 6);
    assert_eq!(index_of(&plan, "p"), 8);
    assert_eq!(index_of(&plan, "c~2"), 9);
    assert_eq!(
        plan.markers["v1"].steps,
        vec![LyricsCommand::Step {
            presentation_id: "812".into(),
            index: Some(2)
        }]
    );
}

#[test]
fn corrections_clear_skip_and_choose_a_group() {
    let markers = song_markers();
    let refs: Vec<&Marker> = markers.iter().collect();
    let overrides = vec![
        SectionOverride {
            marker_id: "intro".into(),
            target: OverrideTarget::Clear,
        },
        SectionOverride {
            marker_id: "p".into(),
            target: OverrideTarget::Skip,
        },
        SectionOverride {
            marker_id: "v2".into(),
            target: OverrideTarget::Group {
                label: "Verse 1".into(),
            },
        },
        SectionOverride {
            marker_id: "ghost".into(),
            target: OverrideTarget::Clear,
        },
    ];
    let plan = build_plan(
        LyricsSoftware::ProPresenter,
        &refs,
        &propresenter(),
        &link(LyricsSoftware::ProPresenter, overrides),
    );
    assert_eq!(section_of(&plan, "intro"), Some(LyricsCommand::Clear));
    assert_eq!(plan.markers["intro"].status, MarkerStatus::Clear);
    assert_eq!(section_of(&plan, "p"), None);
    assert_eq!(plan.markers["p"].status, MarkerStatus::Skip);
    assert_eq!(
        plan.markers["v2"].status,
        MarkerStatus::Matched {
            group_label: "Verse 1".into(),
            automatic: false
        }
    );
    assert!(!plan.markers.contains_key("ghost"));
    let report = plan.report(&refs);
    assert_eq!(report.len(), 8);
    assert_eq!(report[4].marker_id, "c~1");
    assert_eq!(report[4].occurrence, 1);
}

#[test]
fn an_unknown_section_is_unmatched_and_sends_nothing() {
    let markers = [marker("solo", MarkerKind::GuitarSolo, None, 0.0)];
    let refs: Vec<&Marker> = markers.iter().collect();
    let plan = build_plan(
        LyricsSoftware::ProPresenter,
        &refs,
        &propresenter(),
        &link(LyricsSoftware::ProPresenter, vec![]),
    );
    assert_eq!(plan.markers["solo"].status, MarkerStatus::Unmatched);
    assert_eq!(section_of(&plan, "solo"), None);
}
