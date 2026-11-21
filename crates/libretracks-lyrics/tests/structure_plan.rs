//! Plan lyrics-sync, paso 05: estructura de cada programa y plan por canción
//! con la canción de prueba (Intro, Verso 1 ×2, Coro ×2, Verso 2, Coro,
//! Puente, Coro, Final).

use libretracks_core::{
    LyricsLink, LyricsSoftware, Marker, MarkerKind, OverrideTarget, SectionOverride, SlideSelection,
    StartTarget,
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
    // LibreTracks' numbering: the title slide is 0, the lyrics start at 1
    // (the client makes it Holyrics' own when sending).
    assert_eq!(
        shape(&structure),
        rows(&[
            ("Intro", 1, 1),
            ("Verso 1", 2, 2),
            ("Coro", 2, 4),
            ("Verso 2", 1, 6),
            ("Coro", 2, 7),
            ("Puente", 1, 9),
            ("Coro", 2, 10),
            ("Final", 1, 12),
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
        slides: vec![],
        start: None,
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
    assert_eq!(index_of(&plan, "intro"), 1);
    assert_eq!(index_of(&plan, "c~1"), 7);
    assert_eq!(index_of(&plan, "p"), 9);
    assert_eq!(index_of(&plan, "c~2"), 10);
    assert_eq!(
        plan.markers["v1"].steps,
        vec![LyricsCommand::Step {
            presentation_id: "812".into(),
            index: Some(3)
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

/// The real FreeShow song of 2026-11-20 ("Digno"): Verso 1, Coro 1 twice in
/// a row (FreeShow shows "CORO 1 1", "CORO 1 2"), Verso 2, Coro 2 four
/// times, Puente four times. Consecutive appearances of a group are ONE
/// section with that many slides, whether the label carries the part
/// number or not.
fn digno(labels_with_part: bool) -> LyricsStructure {
    // (group, global group, times in a row, the same slide repeated?)
    let groups: &[(&str, &str, usize, bool)] = &[
        ("Verso 1", "verse", 1, false),
        ("Coro 1", "chorus", 2, false),
        ("Verso 2", "verse", 1, false),
        ("Coro 2", "chorus", 4, true),
        ("Puente", "bridge", 4, true),
    ];
    let mut slides = serde_json::Map::new();
    let mut layout = Vec::new();
    for (group, global, times, same_slide) in groups {
        for part in 1..=*times {
            // A repeated slide is the same id in the layout; two different
            // slides of one group may carry "Coro 1 1", "Coro 1 2".
            let id = if *same_slide { group.to_string() } else { format!("{group}-{part}") };
            let label = if labels_with_part && *times > 1 && !*same_slide {
                format!("{group} {part}")
            } else {
                group.to_string()
            };
            slides.insert(id.clone(), serde_json::json!({ "group": label, "globalGroup": global }));
            layout.push(serde_json::json!({ "type": "parent", "id": id, "index": layout.len() }));
        }
    }
    parse_freeshow(
        "digno",
        &serde_json::json!({ "data": { "name": "Digno (Worthy)", "slides": slides } }),
        &serde_json::json!({ "data": layout }),
    )
    .unwrap()
}

#[test]
fn a_group_repeated_in_a_row_is_one_section_with_several_slides() {
    for with_part in [false, true] {
        let structure = digno(with_part);
        assert_eq!(
            shape(&structure),
            rows(&[
                ("Verso 1", 1, 1),
                ("Coro 1", 2, 2),
                ("Verso 2", 1, 4),
                ("Coro 2", 4, 5),
                ("Puente", 4, 9),
            ]),
            "labels with part number: {with_part}"
        );
        let markers = [
            marker("v1", MarkerKind::Verse, Some(1), 0.0),
            marker("c1", MarkerKind::Chorus, Some(1), 16.0),
            marker("p", MarkerKind::Bridge, None, 48.0),
        ];
        let refs: Vec<&Marker> = markers.iter().collect();
        let plan = build_plan(
            LyricsSoftware::FreeShow,
            &refs,
            &structure,
            &link(LyricsSoftware::FreeShow, vec![]),
        );
        assert_eq!(index_of(&plan, "c1"), 2);
        let steps: Vec<Option<u32>> = plan.markers["c1"]
            .steps
            .iter()
            .map(|step| match step {
                LyricsCommand::Step { index, .. } => *index,
                _ => None,
            })
            .collect();
        assert_eq!(steps, vec![Some(3)], "Coro 1 → its second slide (CORO 1 2)");
        assert_eq!(plan.markers["p"].steps.len(), 3, "Puente: slides 2, 3 and 4");
        assert_eq!(plan.slide_counts()["c1"], 2);
    }
}

#[test]
fn part_numbers_come_off_labels_but_single_numbers_stay() {
    use libretracks_lyrics::structure::base_label;
    assert_eq!(base_label("Coro 1 2"), "Coro 1");
    assert_eq!(base_label("Chorus 1 (2)"), "Chorus 1");
    assert_eq!(base_label("Coro 2"), "Coro 2");
    assert_eq!(base_label("Puente"), "Puente");
    assert_eq!(base_label("2 3"), "2 3");
}

#[test]
fn every_program_lists_each_slide_unmerged_with_its_first_line() {
    // FreeShow: the expanded layout, 1-based; a repeated chorus is listed
    // each time it comes round.
    let fs = freeshow();
    assert_eq!(fs.slides.len(), 12);
    assert_eq!((fs.slides[1].index, fs.slides[1].group_label.as_str()), (2, "Estrofa 1"));
    assert_eq!(fs.slides[2].group_label, "Estrofa 1");
    // ProPresenter: 0-based across the groups, with the slide text.
    let pp = propresenter();
    assert_eq!(pp.slides.len(), 8);
    assert_eq!((pp.slides[2].index, pp.slides[2].text.as_str()), (2, "b"));
    // Holyrics: its title slide first (0), then the order from 1.
    let hl = holyrics();
    assert_eq!(hl.slides.len(), 13);
    assert!(hl.slides[0].title && hl.slides[0].text == "Way Maker");
    assert_eq!((hl.slides[7].index, hl.slides[7].text.as_str()), (7, "c"));
}

#[test]
fn chosen_slides_replace_the_group_and_every_change_is_absolute() {
    let markers = song_markers();
    let refs: Vec<&Marker> = markers.iter().collect();
    let mut chosen = link(LyricsSoftware::ProPresenter, vec![]);
    chosen.slides = vec![SlideSelection {
        marker_id: "c~1".into(),
        indexes: vec![4, 99, 3],
    }];
    let plan = build_plan(LyricsSoftware::ProPresenter, &refs, &propresenter(), &chosen);
    let repeat = &plan.markers["c~1"];
    assert!(repeat.custom_slides);
    // 99 is not in the presentation: dropped.
    assert_eq!(repeat.indexes, vec![4, 3]);
    assert_eq!(
        repeat.section,
        Some(LyricsCommand::Slide {
            presentation_id: "PRES-WAYMAKER".into(),
            index: 4
        })
    );
    assert_eq!(
        repeat.steps,
        vec![LyricsCommand::Step {
            presentation_id: "PRES-WAYMAKER".into(),
            index: Some(3)
        }]
    );
    // Only that repeat: the first chorus keeps its group.
    assert!(!plan.markers["c"].custom_slides);
    assert!(matches!(section_of(&plan, "c"), Some(LyricsCommand::Section { .. })));
}

#[test]
fn song_start_is_the_title_slide_when_there_is_one_else_a_blank_screen() {
    let markers = song_markers();
    let refs: Vec<&Marker> = markers.iter().collect();
    let plain = link(LyricsSoftware::ProPresenter, vec![]);
    // The fixture opens on "Intro", not a title: automatic = blank.
    let plan = build_plan(LyricsSoftware::ProPresenter, &refs, &propresenter(), &plain);
    assert_eq!(plan.start, LyricsCommand::Clear);
    assert!(plan.start_automatic);

    let mut titled = propresenter();
    titled.slides[0].group_label = "Título".into();
    let plan = build_plan(LyricsSoftware::ProPresenter, &refs, &titled, &plain);
    assert_eq!(
        plan.start,
        LyricsCommand::Slide {
            presentation_id: "PRES-WAYMAKER".into(),
            index: 0
        }
    );

    let mut forced = plain.clone();
    forced.start = Some(StartTarget::Clear);
    let plan = build_plan(LyricsSoftware::ProPresenter, &refs, &titled, &forced);
    assert_eq!(plan.start, LyricsCommand::Clear);
    assert!(!plan.start_automatic);

    forced.start = Some(StartTarget::Slide { index: 5 });
    let plan = build_plan(LyricsSoftware::ProPresenter, &refs, &titled, &forced);
    assert_eq!(
        plan.start,
        LyricsCommand::Slide {
            presentation_id: "PRES-WAYMAKER".into(),
            index: 5
        }
    );
}

#[test]
fn holyrics_slide_text_leaves_the_chords_out() {
    let lyrics = serde_json::json!({ "data": {
        "id": "1", "title": "Digno de alabar",
        "slides": [
            { "text": "//    F
Digno de alabar
Cristo", "styled_text": "Digno de alabar
Cristo", "slide_description": "Coro 1" },
            { "text": "//    G
Solo con acordes", "slide_description": "Coro 1" }
        ]
    }});
    let structure = parse_holyrics(&lyrics, None).unwrap();
    assert_eq!(structure.slides[1].text, "Digno de alabar
Cristo");
    // Without `styled_text`, the `//` chord lines are dropped.
    assert_eq!(structure.slides[2].text, "Solo con acordes");
}

/// A FreeShow show that opens with a slide WITHOUT a group holding the
/// song's name, then the verse: the verse's index counts that slide (FreeShow
/// numbers the layout by position), and the automatic song start picks it.
#[test]
fn freeshow_unnamed_title_slide_first_keeps_every_index_and_is_the_start() {
    let show = serde_json::json!({ "data": {
        "name": "Digno de alabar",
        "slides": {
            "t":  { "group": "", "items": [{ "lines": [{ "text": [{ "value": "Digno de alabar" }] }] }] },
            "v1": { "group": "Verso 1", "globalGroup": "verse",
                    "items": [{ "lines": [{ "text": [{ "value": "Cargaste Tú mi cruz" }] }] }] },
            "c1": { "group": "Coro 1", "globalGroup": "chorus",
                    "items": [{ "lines": [{ "text": [{ "value": "Digno de alabar" }] }] }] }
        }
    }});
    let layout = serde_json::json!({ "data": [
        { "type": "parent", "id": "t" },
        { "type": "parent", "id": "v1" },
        { "type": "parent", "id": "c1" },
        { "type": "parent", "id": "c1" }
    ]});
    let structure = parse_freeshow("s1", &show, &layout).unwrap();
    // index_select_slide counts layout positions from 1: title 1, verse 2.
    let verse = structure.entries.iter().find(|entry| entry.group_label == "Verso 1").unwrap();
    assert_eq!(verse.first_index, 2);
    let chorus = structure.entries.iter().find(|entry| entry.group_label == "Coro 1").unwrap();
    assert_eq!((chorus.first_index, chorus.slide_count), (3, 2));
    assert_eq!(structure.title_slide().map(|slide| slide.index), Some(1));

    // The plan sends the verse marker to slide 2 and starts the song on 1.
    let markers = vec![marker("v1", MarkerKind::Verse, Some(1), 4.0)];
    let refs: Vec<&Marker> = markers.iter().collect();
    let plan = build_plan(LyricsSoftware::FreeShow, &refs, &structure, &link(LyricsSoftware::FreeShow, vec![]));
    assert_eq!(index_of(&plan, "v1"), 2);
    assert_eq!(
        plan.start,
        LyricsCommand::Slide { presentation_id: "s1".into(), index: 1 }
    );
}

/// An unnamed first slide that is lyrics (not the title) is not a start.
#[test]
fn an_unnamed_first_slide_with_lyrics_is_not_taken_for_the_title() {
    let show = serde_json::json!({ "data": {
        "name": "Digno de alabar",
        "slides": { "a": { "group": "", "items": [{ "lines": [{ "text": [{ "value": "Cargaste Tú mi cruz" }] }] }] } }
    }});
    let layout = serde_json::json!({ "data": [{ "type": "parent", "id": "a" }] });
    assert!(parse_freeshow("s1", &show, &layout).unwrap().title_slide().is_none());
}
