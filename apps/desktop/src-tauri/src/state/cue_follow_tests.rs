//! Las cues de automatización viajan con su canción al moverla, reordenarla,
//! deshacer y rehacer.

use std::fs;

use libretracks_core::{
    warp_timeline_seconds_at, Clip, Song, SongMaster, SongRegion, TempoMarker, Track, TrackKind,
};
use libretracks_project::{create_song_folder, save_song, SONG_FILE_NAME};
use tempfile::tempdir;

use super::carry_cues_with_regions;
use crate::audio::automation::{
    load_automation, AutomationAction, AutomationCue, AutomationDocument, AutomationJumpTarget,
};
use crate::audio::engine::AudioController;
use crate::state::DesktopSession;

fn region(id: &str, start: f64, end: f64) -> SongRegion {
    SongRegion {
        id: id.into(),
        name: id.into(),
        start_seconds: start,
        end_seconds: end,
        transpose_semitones: 0,
        key: None,
        warp_enabled: false,
        warp_source_bpm: None,
        master: SongMaster::default(),
        compact_column_width_rem: None,
    }
}

fn clip(id: &str, start: f64) -> Clip {
    Clip {
        id: id.into(),
        track_id: "a1".into(),
        file_path: "audio/test.wav".into(),
        timeline_start_seconds: start,
        source_start_seconds: 0.0,
        duration_seconds: 1.0,
        gain: 1.0,
        fade_in_seconds: None,
        fade_out_seconds: None,
        color: None,
    }
}

/// 120 BPM 4/4 (un compás = 2 s). Tres canciones de 8 s pegadas.
fn three_songs() -> Song {
    let regions = vec![
        region("r1", 0.0, 8.0),
        region("r2", 8.0, 16.0),
        region("r3", 16.0, 24.0),
    ];
    Song {
        id: "cues".into(),
        title: "Cues".into(),
        artist: None,
        key: None,
        bpm: 120.0,
        time_signature: "4/4".into(),
        duration_seconds: 24.0,
        tempo_markers: vec![],
        time_signature_markers: vec![],
        regions,
        tracks: vec![Track {
            id: "a1".into(),
            name: "a1".into(),
            kind: TrackKind::Audio,
            parent_track_id: None,
            volume: 1.0,
            pan: 0.0,
            muted: false,
            solo: false,
            transpose_enabled: true,
            audio_to: "master".into(),
            mono_downmix: false,
            color: None,
            auto_created: false,
            midi_port: None,
            midi_channel: 1,
            midi_enabled: true,
            collapsed: false,
            height_offset: None,
        }],
        clips: vec![clip("c1", 1.0), clip("c2", 9.0), clip("c3", 17.0)],
        midi_clips: vec![],
        video_clips: vec![],
        section_markers: vec![],
    }
}

fn mute_cue(id: &str, at: f64) -> AutomationCue {
    AutomationCue {
        id: id.into(),
        name: id.into(),
        at_seconds: at,
        enabled: true,
        max_runs: None,
        actions: vec![AutomationAction::SetTrackMute {
            track_id: "a1".into(),
            muted: true,
        }],
    }
}

fn frame_jump_cue(id: &str, at: f64, target: f64) -> AutomationCue {
    AutomationCue {
        id: id.into(),
        name: id.into(),
        at_seconds: at,
        enabled: true,
        max_runs: None,
        actions: vec![AutomationAction::Jump {
            target: AutomationJumpTarget::Frame { seconds: target },
            transition: Default::default(),
            mix_scene_id: None,
        }],
    }
}

fn session_with(song: Song, cues: Vec<AutomationCue>) -> DesktopSession {
    let root = tempdir().expect("temp dir").keep();
    let song_dir = create_song_folder(&root, "cues").expect("song dir");
    fs::create_dir_all(song_dir.join("audio")).expect("audio dir");
    crate::state::tests::write_silent_test_wav(&song_dir.join("audio").join("test.wav"), 1);
    save_song(&song_dir, &song).expect("save song");
    let mut session = DesktopSession::default();
    session.song_file_path = Some(song_dir.join(SONG_FILE_NAME));
    session.song_dir = Some(song_dir);
    session.engine.load_song(song).expect("load song");
    session.automation = AutomationDocument {
        cues,
        track_present: true,
        ..AutomationDocument::default()
    };
    session
}

fn cue_at(session: &DesktopSession, id: &str) -> f64 {
    session
        .automation
        .cues
        .iter()
        .find(|cue| cue.id == id)
        .expect("cue")
        .at_seconds
}

fn frame_target(cue: &AutomationCue) -> f64 {
    match cue.actions.last() {
        Some(AutomationAction::Jump {
            target: AutomationJumpTarget::Frame { seconds },
            ..
        }) => *seconds,
        other => panic!("no es un salto Frame: {other:?}"),
    }
}

fn region_start(session: &DesktopSession, id: &str) -> f64 {
    session
        .engine
        .song()
        .expect("song")
        .regions
        .iter()
        .find(|region| region.id == id)
        .expect("region")
        .start_seconds
}

fn assert_close(actual: f64, expected: f64, what: &str) {
    assert!(
        (actual - expected).abs() < 1e-6,
        "{what}: esperado {expected}, obtenido {actual}"
    );
}

/// C1: reordenar lleva la cue con su canción, a la misma distancia del inicio.
#[test]
fn reordering_carries_the_cue_with_its_song() {
    let mut session = session_with(three_songs(), vec![mute_cue("k3", 19.5)]);
    let audio = AudioController::default();

    session
        .reorder_song_region("r3", 0, &audio)
        .expect("reorder");

    assert_close(
        region_start(&session, "r3"),
        0.0,
        "r3 pasa a ser la primera",
    );
    assert_close(
        cue_at(&session, "k3"),
        3.5,
        "la cue sigue a 3,5 s de su inicio",
    );
    // Y en disco, no sólo en memoria.
    let on_disk = load_automation(session.song_dir.as_ref().unwrap()).expect("load");
    assert_close(on_disk.cues[0].at_seconds, 3.5, "cue guardada");
}

/// C2: mover una canción a la derecha empuja en cascada a las siguientes, y
/// sus cues también se mueven.
#[test]
fn moving_a_song_carries_its_cue_and_the_cues_of_the_songs_it_pushes() {
    let mut session = session_with(
        three_songs(),
        vec![
            mute_cue("k1", 2.0),
            mute_cue("k2", 10.0),
            mute_cue("k3", 18.0),
        ],
    );
    let audio = AudioController::default();

    // r2 se mueve 4 s (dos compases) a la derecha: aterriza encima de r3, que
    // se empuja al siguiente tiempo fuerte tras el nuevo fin de r2 (20 s).
    session.move_song_region("r2", 4.0, &audio).expect("move");

    assert_close(region_start(&session, "r2"), 12.0, "r2 movida");
    let r3 = region_start(&session, "r3");
    assert!(r3 >= 20.0 - 1e-6, "r3 empujada, empieza en {r3}");
    assert_close(cue_at(&session, "k1"), 2.0, "la cue de r1 no se mueve");
    assert_close(cue_at(&session, "k2"), 14.0, "la cue de r2 viaja con ella");
    assert_close(
        cue_at(&session, "k3"),
        r3 + 2.0,
        "la cue de r3 viaja con el empuje",
    );
}

/// C2 (izquierda): mover a la izquierda a un hueco también arrastra la cue.
#[test]
fn moving_a_song_left_carries_its_cue() {
    let mut song = three_songs();
    // Hueco de 4 s antes de r3.
    song.regions[2] = region("r3", 20.0, 28.0);
    song.clips[2] = clip("c3", 21.0);
    song.duration_seconds = 28.0;
    let mut session = session_with(song, vec![mute_cue("k3", 22.0)]);
    let audio = AudioController::default();

    session.move_song_region("r3", -4.0, &audio).expect("move");

    assert_close(cue_at(&session, "k3"), 18.0, "la cue sigue a r3");
}

/// C3: con warp en la canción movida la cue queda en el mismo compás y
/// tiempo visibles respecto al inicio de su canción.
#[test]
fn moving_a_warped_song_keeps_the_cue_on_the_same_visible_beat() {
    let mut song = three_songs();
    song.tempo_markers = vec![TempoMarker {
        id: "t".into(),
        start_seconds: 0.0,
        bpm: 120.0,
    }];
    // r2 suena a 100 BPM y se estira a los 120 de la línea de tiempo.
    song.regions[1].warp_enabled = true;
    song.regions[1].warp_source_bpm = Some(100.0);
    let mut session = session_with(song.clone(), vec![mute_cue("k2", 11.0)]);
    let audio = AudioController::default();

    let view_offset = |song: &Song, cue: f64, region_start: f64| {
        warp_timeline_seconds_at(song, cue) - warp_timeline_seconds_at(song, region_start)
    };
    let before = view_offset(&song, 11.0, 8.0);

    session
        .reorder_song_region("r2", 2, &audio)
        .expect("reorder");

    let after_song = session.engine.song().cloned().expect("song");
    let after = view_offset(
        &after_song,
        cue_at(&session, "k2"),
        region_start(&session, "r2"),
    );
    assert_close(
        after,
        before,
        "misma distancia visible al inicio de la canción",
    );
}

/// C4: un salto `Frame` cuyo destino está en otra canción sigue a esa canción.
#[test]
fn a_frame_jump_target_follows_the_song_that_contains_it() {
    // La cue está en r1 (que no se mueve) y salta a 17 s, dentro de r3.
    let mut session = session_with(three_songs(), vec![frame_jump_cue("j", 6.0, 17.0)]);
    let audio = AudioController::default();

    session
        .reorder_song_region("r3", 1, &audio)
        .expect("reorder");

    let r3 = region_start(&session, "r3");
    let cue = &session.automation.cues[0];
    assert_close(cue.at_seconds, 6.0, "la cue no se mueve: r1 se queda");
    assert_close(frame_target(cue), r3 + 1.0, "el destino sigue a r3");
}

/// Deshacer un movimiento devuelve también las cues; rehacer las vuelve a
/// llevar. Sin esto, deshacer dejaría la cue en la posición de después.
#[test]
fn undo_and_redo_carry_the_cues_back_and_forth() {
    let mut session = session_with(three_songs(), vec![mute_cue("k3", 19.5)]);
    let audio = AudioController::default();

    session
        .reorder_song_region("r3", 0, &audio)
        .expect("reorder");
    assert_close(cue_at(&session, "k3"), 3.5, "tras reordenar");

    session.undo_action(&audio).expect("undo");
    assert_close(cue_at(&session, "k3"), 19.5, "tras deshacer");

    session.redo_action(&audio).expect("redo");
    assert_close(cue_at(&session, "k3"), 3.5, "tras rehacer");
}

/// Si el `Song` no se acepta, el documento de automatización no cambia ni en
/// memoria ni en disco.
#[test]
fn a_rejected_song_update_leaves_the_cues_untouched() {
    let mut session = session_with(three_songs(), vec![mute_cue("k3", 19.5)]);
    let audio = AudioController::default();
    let mut broken = session.engine.song().cloned().expect("song");
    // r3 se traslada (sus cues se arrastrarían) pero el clip apunta a una
    // pista inexistente: la validación rechaza el Song.
    for region in &mut broken.regions {
        if region.id == "r3" {
            region.start_seconds += 8.0;
            region.end_seconds += 8.0;
        }
    }
    broken.clips[2].track_id = "missing".into();
    broken.duration_seconds = 32.0;

    let result = session.persist_song_update_carrying_cues(
        broken,
        &audio,
        crate::state::AudioChangeImpact::StructureRebuild,
        true,
        crate::state::UpdatePhase::Commit,
    );

    assert!(result.is_err(), "el Song roto debe rechazarse");
    assert_close(cue_at(&session, "k3"), 19.5, "en memoria");
    let on_disk = load_automation(session.song_dir.as_ref().unwrap()).expect("load");
    assert_close(on_disk.cues[0].at_seconds, 19.5, "en disco");
}

/// Una canción que cambia de duración no es un traslado: sus cues no se
/// tocan (lo que haya dentro lo recoloca quien la cambió).
#[test]
fn a_resized_song_does_not_drag_its_cues() {
    let before = three_songs();
    let mut after = before.clone();
    after.regions[1].start_seconds = 9.0;
    let mut cues = vec![mute_cue("k2", 10.0)];

    assert!(!carry_cues_with_regions(&before, &after, &mut cues));
    assert_close(cues[0].at_seconds, 10.0, "cue intacta");
}

/// Cambiar el tempo realinea las canciones siguientes a su tiempo fuerte: sus
/// cues van con ellas.
#[test]
fn a_tempo_change_that_realigns_songs_carries_their_cues() {
    let mut session = session_with(three_songs(), vec![mute_cue("k2", 10.0)]);
    let audio = AudioController::default();

    // A 100 BPM un compás son 2,4 s: r1 acaba en 8 y r2 pasa al compás
    // siguiente (9,6 s).
    session.update_song_tempo(100.0, &audio).expect("tempo");

    let r2 = region_start(&session, "r2");
    assert!(
        (r2 - 8.0).abs() > 0.1,
        "r2 se ha realineado (empieza en {r2})"
    );
    assert_close(cue_at(&session, "k2"), r2 + 2.0, "la cue sigue a r2");
}
