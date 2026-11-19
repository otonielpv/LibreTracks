//! Plan track-eq, paso 05: confirmar el EQ, deshacerlo y que lo lleve el motor.

use libretracks_core::{EqBandKind, TrackEq, TrackKind};

use crate::audio::engine::{track_eq_for_engine, AudioController};

use super::mix_scene_tests::{track_of, two_song_session};

fn boosted_eq() -> TrackEq {
    let mut eq = TrackEq::default();
    eq.bands[2].gain_db = 4.5;
    eq.bands[2].frequency_hz = 650.0;
    eq
}

/// Deshacer y rehacer reconstruyen el motor con la canción entera: por
/// `UpsertSongTracks` (cada `TrackUpsert` lleva el EQ) o, si el motor aún no
/// tiene la sesión, por `LoadSession` con el `Song` serializado, que también
/// lo lleva. Cualquiera de los dos deja el EQ del modelo en el motor.
fn assert_rebuilt_with(audio: &AudioController, session: &super::DesktopSession, eq: Option<&TrackEq>) {
    let kind = last_audio_command(audio);
    assert!(
        kind == "upsert_song_tracks" || kind == "sync_song",
        "deshacer/rehacer debe reconstruir el motor, fue {kind}"
    );
    let bass = track_of(session, "bass1");
    assert_eq!(
        track_eq_for_engine(&bass),
        eq.map(|eq| serde_json::to_value(eq).unwrap())
    );
    let song_json = serde_json::to_value(session.engine.song().unwrap()).unwrap();
    let written = song_json["tracks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"] == "bass1")
        .unwrap()
        .get("eq")
        .cloned();
    assert_eq!(written, eq.map(|eq| serde_json::to_value(eq).unwrap()));
}

fn last_audio_command(audio: &AudioController) -> String {
    audio
        .debug_snapshot()
        .expect("debug snapshot")
        .last_command
        .map(|trace| trace.kind)
        .unwrap_or_default()
}

#[test]
fn committing_the_eq_stores_it_sends_it_and_undo_redo_follow() {
    let mut session = two_song_session();
    let audio = AudioController::default();
    let undo = session.undo_stack.len();

    session
        .commit_track_eq_model_and_command("bass1", Some(boosted_eq()), &audio)
        .expect("commit eq");
    assert_eq!(track_of(&session, "bass1").eq, Some(boosted_eq()));
    assert_eq!(session.undo_stack.len(), undo + 1);
    // Un comando dirigido al motor, como el pan.
    assert_eq!(last_audio_command(&audio), "set_track_eq");

    // Deshacer reconstruye por UpsertSongTracks, que lleva el EQ de la pista.
    session.undo_action(&audio).expect("undo");
    assert_eq!(track_of(&session, "bass1").eq, None);
    assert_rebuilt_with(&audio, &session, None);

    session.redo_action(&audio).expect("redo");
    assert_eq!(track_of(&session, "bass1").eq, Some(boosted_eq()));
    assert_rebuilt_with(&audio, &session, Some(&boosted_eq()));

    // Quitar el EQ es otro paso de deshacer.
    session
        .commit_track_eq_model_and_command("bass1", None, &audio)
        .expect("remove eq");
    assert_eq!(track_of(&session, "bass1").eq, None);
    // El mismo valor otra vez no apila nada.
    let steps = session.undo_stack.len();
    session
        .commit_track_eq_model_and_command("bass1", None, &audio)
        .expect("same eq");
    assert_eq!(session.undo_stack.len(), steps);
}

#[test]
fn the_realtime_drag_touches_neither_the_model_nor_the_history() {
    let session = two_song_session();
    let audio = AudioController::default();
    let undo = session.undo_stack.len();
    let before = track_of(&session, "voz1");
    let revision = session.project_revision;
    let realtime_before = audio.realtime_control_diagnostics().live_mix_realtime_command_count;

    audio
        .update_live_track_eq("voz1", Some(&boosted_eq()))
        .expect("live eq");

    assert_eq!(track_of(&session, "voz1"), before);
    assert_eq!(session.undo_stack.len(), undo);
    assert_eq!(session.project_revision, revision);
    assert_eq!(
        audio.realtime_control_diagnostics().live_mix_realtime_command_count,
        realtime_before + 1
    );
    assert_eq!(last_audio_command(&audio), "set_track_eq");
}

#[test]
fn out_of_range_values_reach_the_model_and_the_engine_clamped() {
    let mut session = two_song_session();
    let audio = AudioController::default();
    let mut wild = boosted_eq();
    wild.bands[0].frequency_hz = 2.0;
    wild.bands[1].gain_db = 99.0;
    wild.bands[3].q = f64::NAN;
    wild.bands.push(Default::default());

    session
        .commit_track_eq_model_and_command("bass1", Some(wild.clone()), &audio)
        .expect("commit");
    let stored = track_of(&session, "bass1").eq.expect("stored");
    assert_eq!(stored, wild.sanitized());
    assert_eq!(stored.bands.len(), 6);
    assert_eq!(stored.bands[0].frequency_hz, 20.0);
    assert_eq!(stored.bands[1].gain_db, 18.0);
    assert_eq!(stored.bands[3].q, 0.71);
    // Lo que el motor recibe por el upsert también va recortado.
    let mut raw_track = track_of(&session, "bass1");
    raw_track.eq = Some(wild.clone());
    assert_eq!(
        track_eq_for_engine(&raw_track),
        Some(serde_json::to_value(wild.sanitized()).unwrap())
    );
}

#[test]
fn only_audio_tracks_take_an_eq() {
    let mut session = two_song_session();
    let audio = AudioController::default();
    let mut song = session.engine.song().cloned().unwrap();
    song.tracks
        .iter_mut()
        .find(|t| t.id == "voz2")
        .unwrap()
        .kind = TrackKind::Folder;
    song.clips.retain(|clip| clip.track_id != "voz2");
    session.engine.load_song(song).unwrap();

    let result = session.commit_track_eq_model_and_command("voz2", Some(boosted_eq()), &audio);
    assert!(result.is_err(), "una carpeta no lleva EQ");
    assert_eq!(track_of(&session, "voz2").eq, None);
    assert!(session
        .commit_track_eq_model_and_command("nope", Some(boosted_eq()), &audio)
        .is_err());

    // Y aunque una carpeta lo lleve en el modelo, el motor no lo recibe.
    let mut folder = track_of(&session, "voz2");
    folder.eq = Some(boosted_eq());
    assert_eq!(track_eq_for_engine(&folder), None);
}

#[test]
fn splitting_channels_keeps_the_eq_on_both_sides() {
    let mut session = two_song_session();
    let audio = AudioController::default();
    session
        .commit_track_eq_model_and_command("bass1", Some(boosted_eq()), &audio)
        .expect("commit");
    session
        .split_track_channels("bass1", "Bajo L", "Bajo R", &audio)
        .expect("split");
    let song = session.engine.song().unwrap();
    let with_eq: Vec<_> = song
        .tracks
        .iter()
        .filter(|t| t.name.starts_with("Bajo "))
        .map(|t| t.eq.clone())
        .collect();
    assert_eq!(with_eq.len(), 2);
    assert!(with_eq.iter().all(|eq| eq.as_ref() == Some(&boosted_eq())));
    // El tipo de las bandas no se pierde por el camino.
    assert_eq!(with_eq[0].as_ref().unwrap().bands[0].kind, EqBandKind::LowCut);
}
