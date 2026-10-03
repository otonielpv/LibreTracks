//! Guardia de edición de canciones con arreglo aplicado (paso 05).
//!
//! Mismo fixture que `song_structure_tests.rs`: r2 = A [8,16) · B [16,32) ·
//! C [32,40), con el arreglo "largo" (A B B C) aplicado → r2 en [8, 56).

use libretracks_core::{MarkerKind, Song};

use super::super::song_structure::tests::{
    arrangement, base_cues, base_song, captured, clip_start, close, cue_positions, marker,
    marker_start, mute_cue, song_of, span,
};
use super::base_id;
use crate::audio::engine::AudioController;
use crate::infra::error::DesktopError;
use crate::state::{AudioChangeImpact, DesktopSession};

fn applied() -> (DesktopSession, AudioController) {
    let (mut session, audio) = captured(base_song(), base_cues());
    session
        .save_song_arrangement(
            "r2",
            arrangement("largo", &["a", "b", "b", "c"]),
            true,
            &audio,
        )
        .expect("apply");
    (session, audio)
}

fn assert_locked<T: std::fmt::Debug>(result: Result<T, DesktopError>, what: &str) {
    match result {
        Err(DesktopError::SongStructureLocked {
            region_id,
            arrangement_name,
        }) => {
            assert_eq!(region_id, "r2", "{what}");
            assert_eq!(arrangement_name, "largo", "{what}");
        }
        other => panic!("{what}: se esperaba SongStructureLocked, llegó {other:?}"),
    }
}

/// C1: mover, recortar, cambiar la ganancia de un clip, mover una marca y
/// añadir un clip en la canción arreglada se rechazan y el `Song` no cambia.
#[test]
fn clip_and_marker_edits_in_an_arranged_song_are_rejected_untouched() {
    let (mut session, audio) = applied();
    let before = song_of(&session);

    assert_locked(session.move_clip("xa", 9.0, &audio), "mover clip");
    assert_locked(
        session.update_clip_window("xb", 16.0, 0.0, 0.5, &audio),
        "recortar clip",
    );
    let mut louder = song_of(&session);
    louder.clips.iter_mut().find(|c| c.id == "xc").unwrap().gain = 0.5;
    assert_locked(
        session.persist_song_update(louder, &audio, AudioChangeImpact::TimelineWindow, true),
        "ganancia de clip",
    );
    assert_locked(
        session.update_section_marker("b", "b", 18.0, None, &audio),
        "mover marca",
    );
    assert_locked(
        session.create_clip("a1", "audio/test.wav", 30.0, &audio),
        "añadir clip",
    );
    // Arrastre en vivo: también pasa por la guardia.
    assert_locked(
        session.move_clip_live("xa", 9.5, &audio),
        "arrastre en vivo",
    );

    assert_eq!(song_of(&session), before, "nada cambió");
}

/// Las cues de la canción arreglada también están protegidas (viven fuera
/// del `Song`, pero se perderían igual al reaplicar).
#[test]
fn cue_edits_in_an_arranged_song_are_rejected() {
    let (mut session, audio) = applied();
    let before = cue_positions(&session);
    assert_locked(
        session.upsert_automation_cue(mute_cue("nueva", 30.0), &audio),
        "crear cue",
    );
    assert_locked(session.delete_automation_cue("k2", &audio), "borrar cue");
    assert_eq!(cue_positions(&session), before);
    // Fuera de la canción arreglada, libre.
    session
        .upsert_automation_cue(mute_cue("fuera", 3.0), &audio)
        .expect("cue en r1");
}

/// Editar otra canción no dispara la guardia.
#[test]
fn edits_in_another_song_are_free() {
    let (mut session, audio) = applied();
    session.move_clip("c1", 2.0, &audio).expect("clip de r1");
    session
        .move_clip("c3", 58.5, &audio)
        .expect("clip de r3, tras la arreglada");
    close(clip_start(&song_of(&session), "c3"), 58.5, "movido");
}

/// C2: borrar una pista se acepta y reaplicar no la resucita.
#[test]
fn deleting_a_track_also_removes_its_clips_from_the_original() {
    let mut song = base_song();
    let mut second = song.tracks[0].clone();
    second.id = "a2".into();
    second.name = "a2".into();
    song.tracks.push(second);
    let mut extra = song.clips[2].clone();
    extra.id = "xb_a2".into();
    extra.track_id = "a2".into();
    song.clips.push(extra);
    let (mut session, audio) = captured(song, base_cues());
    session
        .save_song_arrangement(
            "r2",
            arrangement("largo", &["a", "b", "b", "c"]),
            true,
            &audio,
        )
        .expect("apply");
    assert!(song_of(&session).clips.iter().any(|c| c.id == "xb_a2~2"));

    session.delete_track("a2", &audio).expect("borrar pista");

    let song = song_of(&session);
    assert!(song.clips.iter().all(|c| c.track_id != "a2"));
    let original = &song.regions[1].structure.as_ref().unwrap().original;
    assert!(
        original.clips.iter().all(|c| c.track_id != "a2"),
        "fuera del original"
    );
    // Reaplicar (volver al original y otra vez al arreglo) no la resucita.
    session
        .apply_song_arrangement("r2", None, &audio)
        .expect("original");
    session
        .apply_song_arrangement("r2", Some("largo"), &audio)
        .expect("reaplicar");
    assert!(song_of(&session).clips.iter().all(|c| c.track_id != "a2"));
}

/// C2: mover la canción entera se acepta (el original es relativo).
#[test]
fn moving_or_reordering_an_arranged_song_is_allowed() {
    let (mut session, audio) = applied();
    session
        .reorder_song_region("r2", 0, &audio)
        .expect("reordenar");
    let song = song_of(&session);
    assert_eq!(span(&song, "r2").0, 0.0, "r2 primera");
    close(clip_start(&song, "xb~2"), 24.0, "su contenido viaja");
    // Y sigue siendo el arreglo: volver al original funciona desde ahí.
    session
        .apply_song_arrangement("r2", None, &audio)
        .expect("original tras mover");
    assert_eq!(span(&song_of(&session), "r2"), (0.0, 32.0));
}

/// C2: renombrar o recolorear una marca se propaga a sus copias y al
/// original.
#[test]
fn renaming_or_recoloring_a_marker_reaches_every_copy_and_the_original() {
    let (mut session, audio) = applied();
    let start = marker_start(&song_of(&session), "b~2");

    session
        .update_section_marker("b~2", "Verso grande", start, None, &audio)
        .expect("renombrar la copia");
    session
        .set_section_marker_color("b", Some("#ff0000".into()), &audio)
        .expect("recolorear la primera");

    let song = song_of(&session);
    for id in ["b", "b~2"] {
        let m = song.section_markers.iter().find(|m| m.id == id).unwrap();
        assert_eq!(m.name, "Verso grande", "{id}");
        assert_eq!(m.color.as_deref(), Some("#ff0000"), "{id}");
    }
    let original = &song.regions[1].structure.as_ref().unwrap().original;
    let in_original = original
        .section_markers
        .iter()
        .find(|m| m.id == "b")
        .unwrap();
    assert_eq!(in_original.name, "Verso grande");
    assert_eq!(in_original.color.as_deref(), Some("#ff0000"));
    // Al cambiar de arreglo sale renombrada en todas sus copias.
    session
        .save_song_arrangement("r2", arrangement("tres", &["b", "b", "b"]), true, &audio)
        .expect("otro arreglo");
    let names: Vec<String> = song_of(&session)
        .section_markers
        .iter()
        .filter(|m| base_id(&m.id) == "b")
        .map(|m| m.name.clone())
        .collect();
    assert_eq!(names, vec!["Verso grande"; 3]);
}

/// C3: lo que es de la pista es libre y no toca el original.
#[test]
fn track_level_edits_are_free_and_leave_the_original_alone() {
    let (mut session, audio) = applied();
    let original_before = song_of(&session).regions[1].structure.clone();
    session
        .update_track(
            "a1",
            Some("Voz"),
            Some(0.5),
            Some(-0.3),
            Some(true),
            Some(true),
            Some("monitor"),
            &audio,
        )
        .expect("volumen, pan, mute, solo, ruta y nombre");
    session
        .update_track_color("a1", Some("#00ff00"), &audio)
        .expect("color de pista");
    let song = song_of(&session);
    assert_eq!(song.regions[1].structure, original_before);
    assert_eq!(song.tracks[0].name, "Voz");
}

/// C4: recapturar tras quitar una marca quita los bloques huérfanos y avisa
/// con la lista de arreglos afectados.
#[test]
fn recapturing_after_removing_a_marker_drops_orphan_blocks_and_reports_them() {
    let (mut session, audio) = captured(base_song(), base_cues());
    session
        .save_song_arrangement(
            "r2",
            arrangement("domingo", &["a", "b", "c", "b"]),
            false,
            &audio,
        )
        .expect("domingo");
    session
        .save_song_arrangement("r2", arrangement("solo-verso", &["b"]), false, &audio)
        .expect("solo verso");
    // "Editar original": aquí no hay arreglo aplicado, se edita libremente.
    session
        .delete_section_marker("b", &audio)
        .expect("quitar la marca del verso");

    let result = session
        .capture_song_structure("r2", &audio)
        .expect("recapture");

    let dropped: Vec<(String, Vec<String>, bool)> = result
        .dropped_blocks
        .iter()
        .map(|d| {
            (
                d.arrangement_name.clone(),
                d.section_names.clone(),
                d.arrangement_removed,
            )
        })
        .collect();
    assert_eq!(
        dropped,
        vec![
            ("domingo".to_string(), vec!["b".to_string()], false),
            ("solo-verso".to_string(), vec!["b".to_string()], true),
        ]
    );
    let structure = song_of(&session).regions[1].structure.clone().unwrap();
    assert_eq!(structure.arrangements.len(), 1, "solo-verso se quedó vacío");
    let blocks: Vec<&str> = structure.arrangements[0]
        .blocks
        .iter()
        .map(|b| b.section_marker_id.as_str())
        .collect();
    assert_eq!(blocks, vec!["a", "c"]);
}

/// "Editar original": volver al original desbloquea, se edita, y aplicar el
/// arreglo recaptura el original editado.
#[test]
fn edit_original_then_reapply_uses_the_edited_original() {
    let (mut session, audio) = applied();
    session
        .apply_song_arrangement("r2", None, &audio)
        .expect("editar original");
    session
        .move_clip("xa", 9.0, &audio)
        .expect("ahora se puede");

    session
        .apply_song_arrangement("r2", Some("largo"), &audio)
        .expect("reaplicar");

    close(
        clip_start(&song_of(&session), "xa"),
        9.0,
        "la edición sobrevive",
    );
}

#[test]
fn copy_ids_strip_to_their_base() {
    assert_eq!(base_id("coro~2"), "coro");
    assert_eq!(base_id("coro~12"), "coro");
    assert_eq!(base_id("coro"), "coro");
    assert_eq!(base_id("r1~start"), "r1~start");
    assert_eq!(base_id("x~"), "x~");
}

/// Un `Song` cualquiera sin arreglos no paga la guardia ni la dispara.
#[test]
fn songs_without_structures_are_untouched() {
    let song: Song = base_song();
    let mut edited = song.clone();
    edited
        .section_markers
        .push(marker("nueva", 3.0, MarkerKind::Custom));
    super::reconcile_song_structures(&song, &mut edited).expect("sin arreglos");
}
