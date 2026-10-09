//! Modelo `SongStructure`: serde y validación (paso 02 del plan de arreglos).

use crate::automation::{AutomationAction, AutomationCue, AutomationJumpTarget};
use crate::model::*;
use crate::validation::{validate_song_structure, DomainError};

fn marker(id: &str, start: f64, kind: MarkerKind) -> Marker {
    Marker {
        id: id.into(),
        name: id.into(),
        start_seconds: start,
        digit: None,
        kind,
        variant: None,
        color: None,
        category_override: None,
    }
}

/// Una estructura con todas las listas con al menos un elemento.
fn full_structure() -> SongStructure {
    SongStructure {
        original: OriginalSnapshot {
            origin_seconds: 0.0,
            duration_seconds: 16.0,
            base_bpm: 120.0,
            base_time_signature: "4/4".into(),
            clips: vec![Clip {
                id: "c1".into(),
                track_id: "a1".into(),
                file_path: "audio/a.wav".into(),
                timeline_start_seconds: 0.0,
                source_start_seconds: 0.5,
                duration_seconds: 16.0,
                gain: 1.0,
                fade_in_seconds: Some(0.01),
                fade_out_seconds: None,
                color: None,
            }],
            midi_clips: vec![MidiClip {
                id: "m1".into(),
                track_id: "midi".into(),
                timeline_start_seconds: 2.0,
                name: "luces".into(),
                events: vec![MidiEvent {
                    id: "e1".into(),
                    at_seconds: 0.0,
                    channel: None,
                    kind: MidiEventKind::ProgramChange { program: 3 },
                }],
                color: None,
            }],
            video_clips: vec![VideoClip {
                id: "v1".into(),
                track_id: "video".into(),
                file_path: "video/a.mp4".into(),
                timeline_start_seconds: 0.0,
                source_start_seconds: 0.0,
                duration_seconds: 8.0,
                fade_in_seconds: None,
                fade_out_seconds: None,
                fit: None,
                color: None,
            }],
            tempo_markers: vec![TempoMarker {
                id: "t1".into(),
                start_seconds: 0.0,
                bpm: 120.0,
            }],
            time_signature_markers: vec![TimeSignatureMarker {
                id: "ts1".into(),
                start_seconds: 0.0,
                signature: "4/4".into(),
            }],
            section_markers: vec![
                marker("verso", 0.0, MarkerKind::Verse),
                marker("coro", 8.0, MarkerKind::Chorus),
                marker("build", 12.0, MarkerKind::Build),
            ],
            automation_cues: vec![AutomationCue {
                id: "k1".into(),
                name: "Al coro".into(),
                at_seconds: 6.0,
                enabled: true,
                max_runs: Some(1),
                actions: vec![AutomationAction::Jump {
                    target: AutomationJumpTarget::Marker {
                        marker_id: "coro".into(),
                    },
                    transition: Default::default(),
                    mix_scene_id: None,
                }],
            }],
        },
        sections: vec![
            OriginalSection {
                marker_id: "verso".into(),
                start_seconds: 0.0,
                end_seconds: 8.0,
            },
            OriginalSection {
                marker_id: "coro".into(),
                start_seconds: 8.0,
                end_seconds: 16.0,
            },
        ],
        arrangements: vec![Arrangement {
            id: "domingo".into(),
            name: "Domingo".into(),
            blocks: vec![
                ArrangementBlock {
                    id: "b1".into(),
                    section_marker_id: "verso".into(),
                },
                ArrangementBlock {
                    id: "b2".into(),
                    section_marker_id: "coro".into(),
                },
                ArrangementBlock {
                    id: "b3".into(),
                    section_marker_id: "coro".into(),
                },
            ],
        }],
        applied_arrangement_id: Some("domingo".into()),
    }
}

fn region_with(structure: Option<SongStructure>) -> SongRegion {
    SongRegion {
        id: "r1".into(),
        name: "Canción".into(),
        start_seconds: 10.0,
        end_seconds: 26.0,
        transpose_semitones: 0,
        key: None,
        warp_enabled: false,
        warp_source_bpm: None,
        master: SongMaster::default(),
        compact_column_width_rem: None,
        chart: None,
        structure,
    }
}

/// C1: ida y vuelta exacta con todas las listas llenas.
#[test]
fn a_region_with_a_full_structure_round_trips_exactly() {
    let region = region_with(Some(full_structure()));
    let json = serde_json::to_string(&region).expect("serialize");
    // camelCase en todos los niveles, también dentro de la instantánea.
    for key in [
        "\"structure\"",
        "\"appliedArrangementId\"",
        "\"sectionMarkerId\"",
        "\"automationCues\"",
        "\"baseBpm\"",
        "\"markerId\"",
    ] {
        assert!(json.contains(key), "falta {key} en {json}");
    }
    let back: SongRegion = serde_json::from_str(&json).expect("deserialize");
    assert_eq!(back, region);
}

#[test]
fn a_region_without_structure_does_not_write_the_field() {
    let json = serde_json::to_string(&region_with(None)).expect("serialize");
    assert!(!json.contains("structure"), "{json}");
}

/// Compatibilidad: una versión que no conoce un campo de la región lo ignora
/// (el core no usa `deny_unknown_fields`). Es lo que hará una 1.13 con
/// `structure`.
#[test]
fn an_unknown_region_field_is_ignored_on_load() {
    let json = r#"{
        "id": "r1",
        "name": "Futuro",
        "startSeconds": 0.0,
        "endSeconds": 8.0,
        "campoDelFuturo": { "loQueSea": [1, 2, 3] }
    }"#;
    let region: SongRegion = serde_json::from_str(json).expect("ignora el campo");
    assert_eq!(region.name, "Futuro");
    assert_eq!(region.structure, None);
}

#[test]
fn a_full_structure_is_valid() {
    validate_song_structure("r1", &full_structure()).expect("válida");
}

// ── C3: una prueba por regla ──────────────────────────────────────────────

#[test]
fn rejects_a_block_that_names_an_unknown_section() {
    let mut structure = full_structure();
    structure.arrangements[0].blocks[1].section_marker_id = "puente".into();
    assert_eq!(
        validate_song_structure("r1", &structure),
        Err(DomainError::ArrangementUnknownSection {
            region_id: "r1".into(),
            arrangement_id: "domingo".into(),
            section_marker_id: "puente".into(),
        })
    );
}

#[test]
fn rejects_an_arrangement_without_blocks() {
    let mut structure = full_structure();
    structure.arrangements[0].blocks.clear();
    assert_eq!(
        validate_song_structure("r1", &structure),
        Err(DomainError::EmptyArrangement {
            region_id: "r1".into(),
            arrangement_id: "domingo".into(),
        })
    );
}

#[test]
fn rejects_an_applied_arrangement_that_does_not_exist() {
    let mut structure = full_structure();
    structure.applied_arrangement_id = Some("sabado".into());
    assert_eq!(
        validate_song_structure("r1", &structure),
        Err(DomainError::UnknownAppliedArrangement {
            region_id: "r1".into(),
            arrangement_id: "sabado".into(),
        })
    );
}

type BreakSnapshot = Box<dyn Fn(&mut OriginalSnapshot)>;
type BreakStructure = Box<dyn Fn(&mut SongStructure)>;

#[test]
fn rejects_snapshot_positions_outside_the_original_duration() {
    let cases: Vec<(&str, BreakSnapshot)> = vec![
        (
            "clip",
            Box::new(|o| o.clips[0].timeline_start_seconds = 16.0),
        ),
        (
            "clip que se sale",
            Box::new(|o| o.clips[0].duration_seconds = 17.0),
        ),
        (
            "clip negativo",
            Box::new(|o| o.clips[0].timeline_start_seconds = -1.0),
        ),
        (
            "midi",
            Box::new(|o| o.midi_clips[0].timeline_start_seconds = 20.0),
        ),
        (
            "vídeo",
            Box::new(|o| o.video_clips[0].duration_seconds = 30.0),
        ),
        (
            "tempo",
            Box::new(|o| o.tempo_markers[0].start_seconds = 99.0),
        ),
        (
            "compás",
            Box::new(|o| o.time_signature_markers[0].start_seconds = 16.0),
        ),
        (
            "marca",
            Box::new(|o| o.section_markers[2].start_seconds = 16.5),
        ),
        ("cue", Box::new(|o| o.automation_cues[0].at_seconds = 40.0)),
    ];
    for (what, break_it) in cases {
        let mut structure = full_structure();
        break_it(&mut structure.original);
        let error = validate_song_structure("r1", &structure).expect_err(what);
        assert!(
            matches!(error, DomainError::InvalidOriginalSnapshot { .. }),
            "{what}: {error:?}"
        );
    }
}

#[test]
fn rejects_non_finite_snapshot_values() {
    let cases: Vec<(&str, BreakStructure)> = vec![
        (
            "duración",
            Box::new(|s| s.original.duration_seconds = f64::NAN),
        ),
        (
            "duración cero",
            Box::new(|s| s.original.duration_seconds = 0.0),
        ),
        (
            "bpm base",
            Box::new(|s| s.original.base_bpm = f64::INFINITY),
        ),
        ("origen", Box::new(|s| s.original.origin_seconds = f64::NAN)),
        (
            "clip",
            Box::new(|s| s.original.clips[0].source_start_seconds = f64::NAN),
        ),
        (
            "tempo",
            Box::new(|s| s.original.tempo_markers[0].bpm = f64::NAN),
        ),
        (
            "sección",
            Box::new(|s| s.sections[1].end_seconds = f64::NAN),
        ),
    ];
    for (what, break_it) in cases {
        let mut structure = full_structure();
        break_it(&mut structure);
        assert!(
            matches!(
                validate_song_structure("r1", &structure),
                Err(DomainError::InvalidOriginalSnapshot { .. })
            ),
            "{what}"
        );
    }
}

/// Las posiciones de la instantánea son las del timeline al capturar: se
/// validan relativas a `origin_seconds`.
#[test]
fn snapshot_positions_are_checked_relative_to_the_origin() {
    let mut structure = full_structure();
    structure.original.origin_seconds = 100.0;
    let error = validate_song_structure("r1", &structure).expect_err("todo queda antes del origen");
    assert!(matches!(error, DomainError::InvalidOriginalSnapshot { .. }));

    let shift = |x: &mut f64| *x += 100.0;
    let original = &mut structure.original;
    original
        .clips
        .iter_mut()
        .for_each(|c| shift(&mut c.timeline_start_seconds));
    original
        .midi_clips
        .iter_mut()
        .for_each(|c| shift(&mut c.timeline_start_seconds));
    original
        .video_clips
        .iter_mut()
        .for_each(|c| shift(&mut c.timeline_start_seconds));
    original
        .tempo_markers
        .iter_mut()
        .for_each(|m| shift(&mut m.start_seconds));
    original
        .time_signature_markers
        .iter_mut()
        .for_each(|m| shift(&mut m.start_seconds));
    original
        .section_markers
        .iter_mut()
        .for_each(|m| shift(&mut m.start_seconds));
    original
        .automation_cues
        .iter_mut()
        .for_each(|c| shift(&mut c.at_seconds));
    validate_song_structure("r1", &structure).expect("trasladado con su origen, válido");
}

#[test]
fn rejects_sections_out_of_order_or_past_the_end() {
    let mut structure = full_structure();
    structure.sections.swap(0, 1);
    assert!(
        validate_song_structure("r1", &structure).is_err(),
        "desordenadas"
    );

    let mut structure = full_structure();
    structure.sections[1].end_seconds = 17.0;
    assert!(
        validate_song_structure("r1", &structure).is_err(),
        "pasada del final"
    );
}

#[test]
fn rejects_duplicate_arrangement_ids() {
    let mut structure = full_structure();
    let mut copy = structure.arrangements[0].clone();
    for (index, block) in copy.blocks.iter_mut().enumerate() {
        block.id = format!("otro{index}");
    }
    structure.arrangements.push(copy);
    assert_eq!(
        validate_song_structure("r1", &structure),
        Err(DomainError::DuplicateSongStructureId {
            region_id: "r1".into(),
            id: "domingo".into(),
        })
    );
}

#[test]
fn rejects_duplicate_block_ids() {
    let mut structure = full_structure();
    structure.arrangements[0].blocks[2].id = "b1".into();
    assert_eq!(
        validate_song_structure("r1", &structure),
        Err(DomainError::DuplicateSongStructureId {
            region_id: "r1".into(),
            id: "b1".into(),
        })
    );
}

#[test]
fn validate_song_checks_the_structure_of_every_region() {
    let mut structure = full_structure();
    structure.arrangements[0].blocks.clear();
    let song = Song {
        id: "s".into(),
        title: "S".into(),
        artist: None,
        key: None,
        bpm: 120.0,
        time_signature: "4/4".into(),
        duration_seconds: 30.0,
        tempo_markers: vec![],
        time_signature_markers: vec![],
        regions: vec![region_with(Some(structure))],
        tracks: vec![],
        clips: vec![],
        midi_clips: vec![],
        video_clips: vec![],
        section_markers: vec![],
    };
    assert!(matches!(
        crate::validate_song(&song),
        Err(DomainError::EmptyArrangement { .. })
    ));
}
