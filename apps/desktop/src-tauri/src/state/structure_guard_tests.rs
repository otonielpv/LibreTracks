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

// ── Editar un bloque (plan arrangement-block-edits, paso 03) ────────────────
//
// "largo" = A B B C: el 2.º verso (bloque `largo-2`) está en [32, 48) con la
// copia `xb~2`; el 1.º (`largo-1`) en [16, 32) con `xb`.

fn r2_structure(song: &Song) -> &libretracks_core::SongStructure {
    song.regions[1].structure.as_ref().expect("estructura")
}

fn block<'a>(song: &'a Song, block_id: &str) -> &'a libretracks_core::ArrangementBlock {
    r2_structure(song)
        .applied_arrangement()
        .expect("aplicado")
        .blocks
        .iter()
        .find(|b| b.id == block_id)
        .unwrap_or_else(|| panic!("bloque {block_id}"))
}

fn clip_of<'a>(song: &'a Song, id: &str) -> &'a libretracks_core::Clip {
    song.clips
        .iter()
        .find(|c| c.id == id)
        .unwrap_or_else(|| panic!("clip {id}"))
}

/// C1: mover, recortar y cambiar la ganancia de un clip, añadir un clip y un
/// aviso, y un arrastre en vivo en el 2.º verso se aceptan; solo ese bloque
/// guarda contenido propio y ni el 1.º verso ni el original cambian.
#[test]
fn edits_in_the_second_copy_stay_in_its_block() {
    let (mut session, audio) = applied();
    let original_before = r2_structure(&song_of(&session)).original.clone();
    let first_copy_before: Vec<_> = song_of(&session)
        .clips
        .iter()
        .filter(|c| c.timeline_start_seconds >= 16.0 && c.timeline_start_seconds < 32.0)
        .cloned()
        .collect();

    session.move_clip("xb~2", 34.0, &audio).expect("mover clip");
    let song = song_of(&session);
    let content = block(&song, "largo-2").content.as_ref().expect("bloque editado");
    close(clip_of(&song, "xb~2").timeline_start_seconds, 34.0, "en el timeline");
    assert!(content.clips.iter().any(|c| c.id == "xb~2"), "en su bloque");

    // Recortar (la ventana se valida contra el WAV de prueba, de 1 s: aquí
    // interesa la guardia, así que se edita el `Song` directamente).
    let mut trimmed = song_of(&session);
    let clip = trimmed.clips.iter_mut().find(|c| c.id == "xb~2").unwrap();
    clip.source_start_seconds = 0.5;
    clip.duration_seconds = 4.0;
    session
        .persist_song_update(trimmed, &audio, AudioChangeImpact::TimelineWindow, true)
        .expect("recortar clip");
    let mut louder = song_of(&session);
    louder.clips.iter_mut().find(|c| c.id == "xb~2").unwrap().gain = 0.5;
    session
        .persist_song_update(louder, &audio, AudioChangeImpact::TimelineWindow, true)
        .expect("ganancia");
    session
        .create_clip("a1", "audio/test.wav", 40.0, &audio)
        .expect("añadir clip");
    let mut with_cue = song_of(&session);
    with_cue
        .section_markers
        .push(marker("todos", 44.0, MarkerKind::AllIn));
    session
        .persist_song_update(with_cue, &audio, AudioChangeImpact::TransportOnly, true)
        .expect("añadir aviso");
    session
        .move_clip_live("xb~2", 35.0, &audio)
        .expect("arrastre en vivo");

    let song = song_of(&session);
    let content = block(&song, "largo-2").content.as_ref().expect("bloque editado");
    let moved = content.clips.iter().find(|c| c.id == "xb~2").expect("xb~2");
    close(moved.timeline_start_seconds, 3.0, "relativo al bloque");
    assert_eq!(moved.gain, 0.5);
    close(moved.duration_seconds, 4.0, "recortado");
    assert_eq!(content.clips.len(), 2, "con el clip nuevo: {:?}", content.clips);
    assert!(content.cue_markers.iter().any(|m| m.id == "todos"));
    assert!(block(&song, "largo-1").content.is_none(), "el 1.º verso sigue al original");
    assert_eq!(r2_structure(&song).original, original_before, "el original no cambia");
    let first_copy: Vec<_> = song
        .clips
        .iter()
        .filter(|c| c.timeline_start_seconds >= 16.0 && c.timeline_start_seconds < 32.0)
        .cloned()
        .collect();
    assert_eq!(first_copy, first_copy_before);
}

/// C2: reordenar los bloques después lleva el cambio con su bloque.
#[test]
fn an_edit_travels_with_its_block_when_reordering() {
    let (mut session, audio) = applied();
    session.move_clip("xb~2", 34.0, &audio).expect("mover clip");

    let mut reordered = r2_structure(&song_of(&session))
        .applied_arrangement()
        .unwrap()
        .clone();
    reordered.blocks.swap(1, 2); // el verso editado pasa delante
    session
        .save_song_arrangement("r2", reordered, true, &audio)
        .expect("reordenar");

    let song = song_of(&session);
    close(clip_of(&song, "xb~2").timeline_start_seconds, 18.0, "con su bloque");
    close(clip_of(&song, "xb").timeline_start_seconds, 32.0, "el otro, en su sitio");
}

/// C3: deshacer la edición deja el bloque como estaba, en un solo paso.
#[test]
fn undoing_an_edit_restores_the_block() {
    let (mut session, audio) = applied();
    let before = song_of(&session);
    session.move_clip("xb~2", 34.0, &audio).expect("mover clip");
    session.move_clip("xb~2", 36.0, &audio).expect("otra vez");

    session.undo_action(&audio).expect("undo");
    let song = song_of(&session);
    close(clip_of(&song, "xb~2").timeline_start_seconds, 34.0, "un paso atrás");
    let content = block(&song, "largo-2").content.as_ref().expect("editado");
    close(
        content.clips.iter().find(|c| c.id == "xb~2").unwrap().timeline_start_seconds,
        2.0,
        "contenido del paso anterior",
    );

    session.undo_action(&audio).expect("undo");
    assert_eq!(song_of(&session), before, "como antes de editar");
}

/// C4: lo que cambia la forma de la canción sigue pidiendo editar el
/// original, y no se guarda nada.
#[test]
fn shape_edits_in_an_arranged_song_are_still_rejected() {
    let (mut session, audio) = applied();
    let before = song_of(&session);
    assert_locked(
        session.update_section_marker("b", "b", 18.0, None, &audio),
        "mover marca de sección",
    );
    assert_locked(
        session.upsert_song_tempo_marker(40.0, 90.0, &audio),
        "marca de tempo",
    );
    let mut longer = song_of(&session);
    longer.regions[1].end_seconds += 2.0;
    assert_locked(
        session.persist_song_update(longer, &audio, AudioChangeImpact::TimelineWindow, true),
        "duración",
    );
    assert_eq!(song_of(&session), before, "nada cambió");
}

/// C5: alargar un clip más allá del final de su bloque lo deja partido en el
/// borde: el resto pasa al bloque siguiente, que también queda editado.
#[test]
fn a_clip_stretched_past_its_block_is_cut_at_the_edge() {
    let (mut session, audio) = applied();
    let mut stretched = song_of(&session);
    let clip = stretched.clips.iter_mut().find(|c| c.id == "xb~2").unwrap();
    clip.timeline_start_seconds = 40.0;
    clip.source_start_seconds = 8.0;
    clip.duration_seconds = 12.0;
    session
        .persist_song_update(stretched, &audio, AudioChangeImpact::TimelineWindow, true)
        .expect("alargar");

    let song = song_of(&session);
    let clip = clip_of(&song, "xb~2");
    close(clip.timeline_start_seconds, 40.0, "inicio");
    close(clip.timeline_start_seconds + clip.duration_seconds, 48.0, "corta en el borde");
    let content = block(&song, "largo-2").content.as_ref().expect("editado");
    let stored = content.clips.iter().find(|c| c.id == "xb~2").unwrap();
    close(stored.duration_seconds, 8.0, "guardado ya cortado");
    // La cola, en el coro (bloque siguiente), que guarda lo que ahora tiene.
    assert!(block(&song, "largo-3").content.is_some(), "la cola edita el coro");
    assert!(
        song.clips
            .iter()
            .any(|c| (c.timeline_start_seconds - 48.0).abs() < 1e-6 && c.file_path == clip.file_path
                && (c.source_start_seconds - 16.0).abs() < 1e-6),
        "la cola del clip sigue sonando en el coro: {:?}",
        song.clips
    );
}

/// C6: editar el 1.º verso no cambia el 2.º (que sigue al original) ni el
/// original.
#[test]
fn editing_the_first_copy_leaves_the_second_and_the_original_alone() {
    let (mut session, audio) = applied();
    let original_before = r2_structure(&song_of(&session)).original.clone();
    // Sin salirse de su bloque (moverlo haría que su cola entrase en el 2.º).
    let mut louder = song_of(&session);
    louder.clips.iter_mut().find(|c| c.id == "xb").unwrap().gain = 0.5;
    session
        .persist_song_update(louder, &audio, AudioChangeImpact::TimelineWindow, true)
        .expect("ganancia");

    let song = song_of(&session);
    assert!(block(&song, "largo-1").content.is_some());
    assert!(block(&song, "largo-2").content.is_none());
    close(clip_of(&song, "xb~2").timeline_start_seconds, 32.0, "el 2.º, como el original");
    assert_eq!(r2_structure(&song).original, original_before);
}

// ── Cues por bloque (paso 04) ───────────────────────────────────────────────
//
// k2 está en 20 (1.º verso) y su copia k2~2 en 36 (2.º verso, [32, 48)).

fn cue_ids_between(session: &DesktopSession, from: f64, to: f64) -> Vec<String> {
    cue_positions(session)
        .into_iter()
        .filter(|(_, at)| *at >= from && *at < to)
        .map(|(id, _)| id)
        .collect()
}

fn jump_cue(id: &str, at: f64, target: f64) -> crate::audio::automation::AutomationCue {
    use crate::audio::automation::{AutomationAction, AutomationJumpTarget};
    crate::audio::automation::AutomationCue {
        actions: vec![AutomationAction::Jump {
            target: AutomationJumpTarget::Frame { seconds: target },
            transition: Default::default(),
            mix_scene_id: None,
        }],
        ..mute_cue(id, at)
    }
}

/// C1: una cue nueva en el 2.º verso se crea y se queda en su bloque; el 1.º
/// no la tiene.
#[test]
fn a_cue_added_to_the_second_copy_stays_in_its_block() {
    let (mut session, audio) = applied();
    session
        .upsert_automation_cue(mute_cue("nueva", 40.0), &audio)
        .expect("crear cue");

    assert_eq!(cue_ids_between(&session, 32.0, 48.0), vec!["k2~2", "nueva"]);
    assert_eq!(cue_ids_between(&session, 16.0, 32.0), vec!["k2"]);
    let song = song_of(&session);
    let content = block(&song, "largo-2").content.as_ref().expect("bloque editado");
    let ids: Vec<_> = content.automation_cues.iter().map(|c| c.id.as_str()).collect();
    assert_eq!(ids, vec!["k2~2", "nueva"]);
    close(content.automation_cues[1].at_seconds, 8.0, "relativa al bloque");
    assert!(block(&song, "largo-1").content.is_none());
    // Fuera de la canción arreglada, como siempre.
    session
        .upsert_automation_cue(mute_cue("fuera", 3.0), &audio)
        .expect("cue en r1");
}

/// C2: volver al original y reaplicar el arreglo conserva la cue en su bloque.
#[test]
fn a_block_cue_survives_switching_arrangements() {
    let (mut session, audio) = applied();
    session
        .upsert_automation_cue(mute_cue("nueva", 40.0), &audio)
        .expect("crear cue");
    session
        .apply_song_arrangement("r2", None, &audio)
        .expect("original");
    assert!(
        cue_positions(&session).iter().all(|(id, _)| id != "nueva"),
        "el original no la tiene"
    );
    session
        .apply_song_arrangement("r2", Some("largo"), &audio)
        .expect("reaplicar");
    assert_eq!(cue_ids_between(&session, 32.0, 48.0), vec!["k2~2", "nueva"]);
}

/// C3: deshacer la creación la quita del timeline y del bloque.
#[test]
fn undoing_a_block_cue_removes_it_from_the_timeline_and_the_block() {
    let (mut session, audio) = applied();
    let before = cue_positions(&session);
    session
        .upsert_automation_cue(mute_cue("nueva", 40.0), &audio)
        .expect("crear cue");
    session.undo_action(&audio).expect("undo");
    assert_eq!(cue_positions(&session), before);
    assert!(block(&song_of(&session), "largo-2").content.is_none());
}

/// C4: un salto dentro del bloque editado sigue apuntando a su bloque tras
/// reordenar; borrar una copia solo la quita de su bloque.
#[test]
fn block_cues_keep_their_jumps_and_deletes_stay_local() {
    let (mut session, audio) = applied();
    session
        .upsert_automation_cue(jump_cue("vuelta", 44.0, 34.0), &audio)
        .expect("cue con salto");
    session
        .delete_automation_cue("k2~2", &audio)
        .expect("borrar la copia");
    assert_eq!(cue_ids_between(&session, 32.0, 48.0), vec!["vuelta"]);
    assert_eq!(cue_ids_between(&session, 16.0, 32.0), vec!["k2"], "el 1.º la conserva");

    let mut reordered = r2_structure(&song_of(&session))
        .applied_arrangement()
        .unwrap()
        .clone();
    reordered.blocks.swap(1, 2);
    session
        .save_song_arrangement("r2", reordered, true, &audio)
        .expect("reordenar");

    let cue = session
        .automation
        .cues
        .iter()
        .find(|c| c.id == "vuelta")
        .expect("cue");
    close(cue.at_seconds, 28.0, "con su bloque");
    match &cue.actions[0] {
        crate::audio::automation::AutomationAction::Jump {
            target: crate::audio::automation::AutomationJumpTarget::Frame { seconds },
            ..
        } => close(*seconds, 18.0, "salto dentro de su bloque"),
        other => panic!("{other:?}"),
    }
    // El verso que sigue al original es ahora la primera aparición: su cue
    // vuelve a llamarse k2.
    assert_eq!(cue_ids_between(&session, 32.0, 48.0), vec!["k2"], "el otro verso, como el original");
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

// ── Cambios de nota en una canción arreglada ───────────────────────────────

fn modulating_song() -> Song {
    let mut song = base_song();
    let r2 = song.regions.iter_mut().find(|r| r.id == "r2").expect("r2");
    r2.key = Some("D".into());
    // El coro (C, en 32) sube a Mi.
    r2.key_changes = vec![libretracks_core::KeyChange {
        id: "up".into(),
        offset_seconds: 24.0,
        key: "E".into(),
    }];
    song
}

fn r2_keys(session: &DesktopSession) -> (Option<String>, Vec<(f64, String)>) {
    let song = song_of(session);
    let r2 = song.regions.iter().find(|r| r.id == "r2").expect("r2");
    (
        r2.key.clone(),
        r2.key_changes
            .iter()
            .map(|change| (change.offset_seconds, change.key.clone()))
            .collect(),
    )
}

#[test]
fn an_arrangement_carries_each_section_in_its_own_key() {
    let (mut session, audio) = captured(modulating_song(), base_cues());
    session
        .save_song_arrangement("r2", arrangement("coro-primero", &["c", "a", "b"]), true, &audio)
        .expect("apply");
    // C (8 s, en Mi) abre la canción; A vuelve a Re al acabar.
    assert_eq!(r2_keys(&session), (Some("E".into()), vec![(8.0, "D".into())]));

    session.apply_song_arrangement("r2", None, &audio).expect("original");
    assert_eq!(r2_keys(&session), (Some("D".into()), vec![(24.0, "E".into())]));
}

#[test]
fn key_change_edits_in_an_arranged_song_are_rejected() {
    let (mut session, audio) = captured(modulating_song(), base_cues());
    session
        .save_song_arrangement("r2", arrangement("largo", &["a", "b", "b", "c"]), true, &audio)
        .expect("apply");
    let before = r2_keys(&session);
    assert_locked(
        session.set_song_region_key_changes("r2", Vec::new(), &audio),
        "quitar los cambios de nota",
    );
    assert_eq!(r2_keys(&session), before);
}

#[test]
fn the_key_of_an_arranged_song_that_does_not_modulate_can_change() {
    let (mut session, audio) = applied();
    session
        .update_song_region_key("r2", Some("G".into()), &audio)
        .expect("a song with one key can change it");
    // Volver al original no la deshace: se apuntó también en él.
    session.apply_song_arrangement("r2", None, &audio).expect("original");
    assert_eq!(r2_keys(&session), (Some("G".into()), vec![]));
}

/// Renombrar un aviso dentro de un bloque editado es cosa de ese bloque: ni
/// sus copias ni el original cambian.
#[test]
fn renaming_a_cue_marker_in_an_edited_block_stays_in_it() {
    let (mut session, audio) = applied();
    // Un aviso en el verso del original, para que tenga copias.
    session
        .apply_song_arrangement("r2", None, &audio)
        .expect("original");
    let mut with_cue = song_of(&session);
    with_cue
        .section_markers
        .push(marker("todos", 20.0, MarkerKind::AllIn));
    with_cue
        .section_markers
        .sort_by(|a, b| a.start_seconds.total_cmp(&b.start_seconds));
    session
        .persist_song_update(with_cue, &audio, AudioChangeImpact::TransportOnly, true)
        .expect("aviso");
    session
        .apply_song_arrangement("r2", Some("largo"), &audio)
        .expect("reaplicar");
    // Editar el 2.º verso para que tenga contenido propio.
    session.move_clip("xb~2", 34.0, &audio).expect("editar");

    session
        .update_section_marker("todos~2", "Solo yo", 36.0, None, &audio)
        .expect("renombrar en el bloque editado");

    let song = song_of(&session);
    let name = |id: &str| {
        song.section_markers
            .iter()
            .find(|m| m.id == id)
            .unwrap_or_else(|| panic!("marca {id}"))
            .name
            .clone()
    };
    assert_eq!(name("todos~2"), "Solo yo");
    assert_eq!(name("todos"), "todos", "la copia del 1.º verso no cambia");
    let original = &r2_structure(&song).original;
    assert_eq!(
        original
            .section_markers
            .iter()
            .find(|m| m.id == "todos")
            .unwrap()
            .name,
        "todos"
    );
}

/// «Restablecer como el original»: el bloque vuelve a seguir a su sección y el
/// timeline lo refleja; deshacer lo devuelve editado.
#[test]
fn resetting_a_block_makes_it_follow_the_original_again() {
    let (mut session, audio) = applied();
    let before = song_of(&session);
    // Sin salirse del bloque (moverlo haría que su cola entrase en el coro,
    // que también quedaría editado).
    let mut louder = song_of(&session);
    louder.clips.iter_mut().find(|c| c.id == "xb~2").unwrap().gain = 0.5;
    session
        .persist_song_update(louder, &audio, AudioChangeImpact::TimelineWindow, true)
        .expect("editar");

    session
        .reset_arrangement_block("r2", "largo", "largo-2", &audio)
        .expect("restablecer");
    let song = song_of(&session);
    assert!(block(&song, "largo-2").content.is_none());
    assert_eq!(song.clips, before.clips, "como el original");

    session.undo_action(&audio).expect("undo");
    let song = song_of(&session);
    assert!(block(&song, "largo-2").content.is_some());
    assert_eq!(clip_of(&song, "xb~2").gain, 0.5, "editado otra vez");
}

// ── «Editar original» y reaplicar (paso 06) ─────────────────────────────────

/// Da contenido propio al 2.º verso (ganancia 0.5 en `xb~2`) sin salirse
/// del bloque.
fn edit_second_verse(session: &mut DesktopSession, audio: &AudioController) {
    let mut louder = song_of(session);
    louder.clips.iter_mut().find(|c| c.id == "xb~2").unwrap().gain = 0.5;
    session
        .persist_song_update(louder, audio, AudioChangeImpact::TimelineWindow, true)
        .expect("editar el 2.º verso");
}

fn arrangement_block<'a>(
    song: &'a Song,
    block_id: &str,
) -> &'a libretracks_core::ArrangementBlock {
    r2_structure(song).arrangements[0]
        .blocks
        .iter()
        .find(|b| b.id == block_id)
        .unwrap_or_else(|| panic!("bloque {block_id}"))
}

/// C1 + C4: volver al original conserva el contenido propio; un cambio del
/// original llega al 1.º verso al reaplicar y no al 2.º, que conserva lo suyo.
#[test]
fn editing_the_original_reaches_the_copies_that_follow_it_but_not_edited_ones() {
    let (mut session, audio) = applied();
    edit_second_verse(&mut session, &audio);

    session
        .apply_song_arrangement("r2", None, &audio)
        .expect("editar original");
    let song = song_of(&session);
    assert!(
        arrangement_block(&song, "largo-2").content.is_some(),
        "el bloque conserva lo suyo con el arreglo quitado"
    );

    // En el original, el verso más bajo.
    let mut quieter = song_of(&session);
    quieter.clips.iter_mut().find(|c| c.id == "xb").unwrap().gain = 0.7;
    session
        .persist_song_update(quieter, &audio, AudioChangeImpact::TimelineWindow, true)
        .expect("editar el original");
    session
        .apply_song_arrangement("r2", Some("largo"), &audio)
        .expect("reaplicar");

    let song = song_of(&session);
    assert_eq!(clip_of(&song, "xb").gain, 0.7, "el 1.º verso recibe el cambio");
    assert_eq!(clip_of(&song, "xb~2").gain, 0.5, "el 2.º conserva lo suyo");
}

/// C2: si la sección del bloque editado desaparece, el aviso lo nombra.
#[test]
fn removing_the_section_of_an_edited_block_reports_the_lost_changes() {
    let (mut session, audio) = applied();
    edit_second_verse(&mut session, &audio);
    session
        .apply_song_arrangement("r2", None, &audio)
        .expect("editar original");
    let mut without_b = song_of(&session);
    without_b.section_markers.retain(|m| m.id != "b");
    session
        .persist_song_update(without_b, &audio, AudioChangeImpact::TransportOnly, true)
        .expect("quitar la marca del verso");

    let result = session
        .apply_song_arrangement("r2", Some("largo"), &audio)
        .expect("reaplicar");
    assert_eq!(result.dropped_blocks.len(), 1);
    assert_eq!(result.dropped_blocks[0].edited_section_names, vec!["b".to_string()]);
}

/// C3: si la sección del bloque editado encoge, lo suyo se recorta y se avisa.
#[test]
fn shortening_the_section_of_an_edited_block_trims_it_and_warns() {
    let (mut session, audio) = applied();
    edit_second_verse(&mut session, &audio);
    session
        .apply_song_arrangement("r2", None, &audio)
        .expect("editar original");
    // El estribillo (c) empieza antes: el verso pasa de 16 a 12 s.
    session
        .update_section_marker("c", "c", 28.0, None, &audio)
        .expect("acortar el verso");

    let result = session
        .apply_song_arrangement("r2", Some("largo"), &audio)
        .expect("reaplicar");
    assert!(
        result
            .warnings
            .iter()
            .any(|w| w.kind == "editedBlockTrimmed" && w.marker_id == "b"),
        "{:?}",
        result.warnings
    );
    let song = song_of(&session);
    let clip = clip_of(&song, "xb~2");
    assert_eq!(clip.gain, 0.5, "conserva lo suyo");
    close(clip.duration_seconds, 12.0, "recortado al verso nuevo");
}
