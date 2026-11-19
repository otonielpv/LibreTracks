//! Edición por lotes de las marcas de la regla (`ruler_markers.rs`).
//!
//! Fixture de `song_structure_tests`: 120 BPM 4/4, secciones a(8) b(16)
//! c(32) m3(40) y la marca de tempo t2 en 8. Sin warp: vista = fuente.

use libretracks_core::{MarkerCategory, MarkerKind, TempoMarker, TimeSignatureMarker};

use super::song_structure::tests::{base_song, close, marker_start, session_with, song_of};
use super::{RulerMarkerKind, RulerMarkerPlacement, RulerMarkerRef};
use crate::audio::engine::AudioController;

fn place(kind: RulerMarkerKind, id: &str, start_seconds: f64) -> RulerMarkerPlacement {
    RulerMarkerPlacement {
        kind,
        id: id.into(),
        start_seconds,
        category_override: None,
    }
}

fn reference(kind: RulerMarkerKind, id: &str) -> RulerMarkerRef {
    RulerMarkerRef { kind, id: id.into() }
}

fn tempo_at(song: &libretracks_core::Song, id: &str) -> f64 {
    song.tempo_markers
        .iter()
        .find(|marker| marker.id == id)
        .unwrap_or_else(|| panic!("tempo {id}"))
        .start_seconds
}

/// Mover secciones y tempo a la vez es UN paso de deshacer: deshacer una vez
/// devuelve todo el grupo a su sitio, no sólo la última marca.
#[test]
fn moving_a_mixed_selection_is_one_undo_step() {
    let mut session = session_with(base_song(), vec![]);
    let audio = AudioController::default();
    let before = song_of(&session);

    session
        .move_ruler_markers(
            &[
                place(RulerMarkerKind::Section, "a", 10.0),
                place(RulerMarkerKind::Section, "b", 18.0),
                place(RulerMarkerKind::Tempo, "t2", 10.0),
            ],
            &audio,
        )
        .expect("move");

    let song = song_of(&session);
    close(marker_start(&song, "a"), 10.0, "a");
    close(marker_start(&song, "b"), 18.0, "b");
    close(tempo_at(&song, "t2"), 10.0, "t2");

    session.undo_action(&audio).expect("undo");
    assert_eq!(song_of(&session), before, "un solo deshacer lo devuelve todo");
}

#[test]
fn duplicating_copies_each_marker_with_a_new_id_and_no_hotkey() {
    let mut base = base_song();
    base.section_markers[0].digit = Some(1);
    let mut session = session_with(base, vec![]);
    let audio = AudioController::default();

    session
        .duplicate_ruler_markers(
            &[
                place(RulerMarkerKind::Section, "a", 24.0),
                place(RulerMarkerKind::Tempo, "t2", 24.0),
            ],
            &audio,
        )
        .expect("duplicate");

    let song = song_of(&session);
    let copies: Vec<_> = song
        .section_markers
        .iter()
        .filter(|marker| (marker.start_seconds - 24.0).abs() < 1e-6)
        .collect();
    assert_eq!(copies.len(), 1);
    let copy = copies[0];
    assert_ne!(copy.id, "a");
    assert_eq!(copy.kind, MarkerKind::Intro);
    // Dos marcas con el mismo dígito harían ambiguo el salto.
    assert_eq!(copy.digit, None);
    // El original sigue donde estaba.
    close(marker_start(&song, "a"), 8.0, "a");
    // Y las marcas siguen ordenadas.
    let starts: Vec<f64> = song.section_markers.iter().map(|m| m.start_seconds).collect();
    let mut sorted = starts.clone();
    sorted.sort_by(|l, r| l.partial_cmp(r).unwrap());
    assert_eq!(starts, sorted);

    assert_eq!(song.tempo_markers.len(), 2);
    let tempo_copy = song
        .tempo_markers
        .iter()
        .find(|marker| marker.id != "t2")
        .expect("tempo copy");
    close(tempo_copy.start_seconds, 24.0, "copia de tempo");
}

#[test]
fn deleting_a_mixed_selection_removes_all_of_it_at_once() {
    let mut base = base_song();
    base.time_signature_markers.push(TimeSignatureMarker {
        id: "ts".into(),
        start_seconds: 16.0,
        signature: "3/4".into(),
    });
    let mut session = session_with(base, vec![]);
    let audio = AudioController::default();
    let before = song_of(&session);

    session
        .delete_ruler_markers(
            &[
                reference(RulerMarkerKind::Section, "b"),
                reference(RulerMarkerKind::Tempo, "t2"),
                reference(RulerMarkerKind::TimeSignature, "ts"),
            ],
            &audio,
        )
        .expect("delete");

    let song = song_of(&session);
    assert!(song.section_markers.iter().all(|marker| marker.id != "b"));
    assert!(song.tempo_markers.is_empty());
    assert!(song.time_signature_markers.is_empty());
    assert_eq!(song.section_markers.len(), 3);

    session.undo_action(&audio).expect("undo");
    assert_eq!(song_of(&session), before);
}

/// Dos tempos no pueden compartir sitio: el que llega gana, como al insertar
/// uno encima de otro.
#[test]
fn a_tempo_moved_onto_another_replaces_it() {
    let mut base = base_song();
    base.tempo_markers.push(TempoMarker {
        id: "t3".into(),
        start_seconds: 20.0,
        bpm: 100.0,
        ramp: false,
    });
    let mut session = session_with(base, vec![]);
    let audio = AudioController::default();

    session
        .move_ruler_markers(&[place(RulerMarkerKind::Tempo, "t2", 20.0)], &audio)
        .expect("move");

    let song = song_of(&session);
    assert_eq!(song.tempo_markers.len(), 1);
    assert_eq!(song.tempo_markers[0].id, "t2");
    close(song.tempo_markers[0].bpm, 120.0, "bpm del que llega");
}

/// Llevar un tempo al cero lo convierte en el tempo base de la canción: en el
/// cero no hay marca, hay valor base.
#[test]
fn a_tempo_moved_to_zero_becomes_the_base_tempo() {
    let mut base = base_song();
    base.tempo_markers[0].bpm = 90.0;
    let mut session = session_with(base, vec![]);
    let audio = AudioController::default();

    session
        .move_ruler_markers(&[place(RulerMarkerKind::Tempo, "t2", 0.0)], &audio)
        .expect("move");

    let song = song_of(&session);
    assert!(song.tempo_markers.is_empty());
    close(song.bpm, 90.0, "bpm base");
}

#[test]
fn a_missing_marker_in_a_move_fails_without_touching_the_song() {
    let mut session = session_with(base_song(), vec![]);
    let audio = AudioController::default();
    let before = song_of(&session);

    let result = session.move_ruler_markers(
        &[
            place(RulerMarkerKind::Section, "a", 10.0),
            place(RulerMarkerKind::Section, "no-existe", 12.0),
        ],
        &audio,
    );

    assert!(result.is_err());
    assert_eq!(song_of(&session), before);
}

/// Una sesión guarda en el cero las marcas de tempo y compás de su primera
/// canción. Copiar o mover sólo secciones (Alt+arrastrar dos secciones) las
/// borraba al absorberlas en el valor base.
#[test]
fn section_only_edits_keep_tempo_and_signature_markers_at_zero() {
    let mut base = base_song();
    base.tempo_markers.push(TempoMarker {
        id: "t0".into(),
        start_seconds: 0.0,
        bpm: 148.0,
        ramp: false,
    });
    base.time_signature_markers.push(TimeSignatureMarker {
        id: "ts0".into(),
        start_seconds: 0.0,
        signature: "4/4".into(),
    });
    let mut session = session_with(base, vec![]);
    let audio = AudioController::default();
    let keeps_origin = |song: &libretracks_core::Song| {
        assert!(song.tempo_markers.iter().any(|marker| marker.id == "t0"), "tempo en 0");
        assert!(
            song.time_signature_markers.iter().any(|marker| marker.id == "ts0"),
            "compás en 0"
        );
    };

    session
        .duplicate_ruler_markers(
            &[
                place(RulerMarkerKind::Section, "a", 24.0),
                place(RulerMarkerKind::Section, "b", 28.0),
            ],
            &audio,
        )
        .expect("duplicate");
    keeps_origin(&song_of(&session));

    session
        .move_ruler_markers(
            &[
                place(RulerMarkerKind::Section, "a", 10.0),
                place(RulerMarkerKind::Section, "b", 18.0),
            ],
            &audio,
        )
        .expect("move");
    keeps_origin(&song_of(&session));
}

/// Alt+arrastrar una sección al carril de avisos: la copia cae como aviso y el
/// original sigue siendo sección.
#[test]
fn a_copy_dropped_in_the_other_lane_takes_that_lane() {
    let mut session = session_with(base_song(), vec![]);
    let audio = AudioController::default();

    session
        .duplicate_ruler_markers(
            &[RulerMarkerPlacement {
                category_override: Some(MarkerCategory::Cue),
                ..place(RulerMarkerKind::Section, "a", 24.0)
            }],
            &audio,
        )
        .expect("duplicate");

    let song = song_of(&session);
    let copy = song
        .section_markers
        .iter()
        .find(|marker| (marker.start_seconds - 24.0).abs() < 1e-6)
        .expect("copy");
    assert_eq!(copy.category_override, Some(MarkerCategory::Cue));
    let original = song.section_markers.iter().find(|marker| marker.id == "a").unwrap();
    assert_eq!(original.category_override, None);
}
