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
fn audio_tracks_and_folders_take_an_eq_midi_does_not() {
    // Plan track-eq-2, E9: las carpetas llevan EQ (sobre la suma de sus hijas).
    let mut session = two_song_session();
    let audio = AudioController::default();
    let mut song = session.engine.song().cloned().unwrap();
    song.tracks.iter_mut().find(|t| t.id == "voz2").unwrap().kind = TrackKind::Folder;
    song.tracks.iter_mut().find(|t| t.id == "bass2").unwrap().kind = TrackKind::Midi;
    song.clips.retain(|clip| clip.track_id != "voz2" && clip.track_id != "bass2");
    session.engine.load_song(song).unwrap();

    session
        .commit_track_eq_model_and_command("voz2", Some(boosted_eq()), &audio)
        .expect("una carpeta lleva EQ");
    assert_eq!(track_of(&session, "voz2").eq, Some(boosted_eq()));
    assert_eq!(
        track_eq_for_engine(&track_of(&session, "voz2")),
        Some(serde_json::to_value(boosted_eq()).unwrap()),
        "y el motor lo recibe"
    );

    let result = session.commit_track_eq_model_and_command("bass2", Some(boosted_eq()), &audio);
    assert!(result.is_err(), "una pista MIDI no lleva EQ");
    assert!(session
        .commit_track_eq_model_and_command("nope", Some(boosted_eq()), &audio)
        .is_err());
    let mut midi = track_of(&session, "bass2");
    midi.eq = Some(boosted_eq());
    assert_eq!(track_eq_for_engine(&midi), None);
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

#[test]
fn a_batch_changes_every_track_with_one_undo_step() {
    let mut session = two_song_session();
    let audio = AudioController::default();
    let undo = session.undo_stack.len();
    let before_voz = track_of(&session, "voz1").eq;

    session
        .commit_track_eqs_model_and_command(
            vec![
                ("bass1".into(), Some(boosted_eq())),
                ("voz1".into(), Some(boosted_eq())),
            ],
            &audio,
        )
        .expect("batch");
    assert_eq!(track_of(&session, "bass1").eq, Some(boosted_eq()));
    assert_eq!(track_of(&session, "voz1").eq, Some(boosted_eq()));
    assert_eq!(session.undo_stack.len(), undo + 1, "un solo paso de deshacer");

    session.undo_action(&audio).expect("undo");
    assert_eq!(track_of(&session, "bass1").eq, None);
    assert_eq!(track_of(&session, "voz1").eq, before_voz);

    // Una pista inexistente en el lote: no cambia ninguna.
    let steps = session.undo_stack.len();
    assert!(session
        .commit_track_eqs_model_and_command(
            vec![("bass1".into(), Some(boosted_eq())), ("nope".into(), Some(boosted_eq()))],
            &audio,
        )
        .is_err());
    assert_eq!(track_of(&session, "bass1").eq, None);
    assert_eq!(session.undo_stack.len(), steps);
}

// --- Plan track-eq-2, paso 04: cues de EQ en vivo ----------------------------

#[test]
fn an_eq_cue_copies_to_the_model_without_an_undo_step() {
    use crate::audio::automation::AutomationAction;
    let mut session = two_song_session();
    let audio = AudioController::default();
    let undo = session.undo_stack.len();
    let revision = session.project_revision;
    let mix_revision = session.mix_revision;

    session
        .apply_automation_action(
            &AutomationAction::SetTrackEq {
                track_id: "bass1".into(),
                eq: Some(boosted_eq()),
                ramp_seconds: Some(4.0),
            },
            &audio,
        )
        .expect("cue");
    assert_eq!(track_of(&session, "bass1").eq, Some(boosted_eq()));
    assert_eq!(session.undo_stack.len(), undo, "la automatización no deshace");
    assert_eq!(session.project_revision, revision);
    assert_ne!(session.mix_revision, mix_revision, "la UI se entera");
    assert_eq!(last_audio_command(&audio), "set_track_eq");

    session
        .apply_automation_action(
            &AutomationAction::SetTrackEqEnabled { track_id: "bass1".into(), enabled: false },
            &audio,
        )
        .expect("bypass cue");
    let stored = track_of(&session, "bass1").eq.unwrap();
    assert!(!stored.enabled);
    assert_eq!(stored.bands, boosted_eq().bands);
    assert_eq!(session.undo_stack.len(), undo);
}

#[test]
fn an_eq_cue_on_a_missing_track_is_rejected() {
    use crate::audio::automation::{AutomationAction, AutomationCue};
    let session = two_song_session();
    let song = session.engine.song().unwrap();
    let check = |action: AutomationAction| {
        let cue = AutomationCue {
            lead: None,
            id: "k".into(),
            name: "EQ".into(),
            at_seconds: 1.0,
            enabled: true,
            max_runs: None,
            actions: vec![action],
        };
        super::validate_automation_cue(song, &session.automation, &cue)
    };
    assert!(check(AutomationAction::SetTrackEq { track_id: "nope".into(), eq: None, ramp_seconds: None }).is_err());
    assert!(check(AutomationAction::SetTrackEqEnabled { track_id: "nope".into(), enabled: true }).is_err());
    assert!(check(AutomationAction::SetTrackEq { track_id: "bass1".into(), eq: None, ramp_seconds: Some(-1.0) }).is_err());
    assert!(check(AutomationAction::SetTrackEq { track_id: "bass1".into(), eq: None, ramp_seconds: Some(1.0) }).is_ok());
    assert!(check(AutomationAction::SetTrackEqEnabled { track_id: "bass1".into(), enabled: false }).is_ok());
}

// --- Plan track-eq-2, paso 09: EQ de máster por canción ----------------------

fn region_master_eq(session: &super::DesktopSession, region_id: &str) -> Option<TrackEq> {
    session
        .engine
        .song()
        .unwrap()
        .regions
        .iter()
        .find(|region| region.id == region_id)
        .unwrap()
        .master
        .eq
        .clone()
}

#[test]
fn the_song_master_eq_is_stored_sent_and_undone() {
    let mut session = two_song_session();
    let audio = AudioController::default();
    let undo = session.undo_stack.len();

    let mut wild = boosted_eq();
    wild.bands[2].gain_db = 99.0;
    session
        .commit_song_master_eq("r1", Some(wild.clone()), &audio)
        .expect("commit master eq");
    assert_eq!(region_master_eq(&session, "r1"), Some(wild.sanitized()));
    assert_eq!(region_master_eq(&session, "r2"), None);
    assert_eq!(session.undo_stack.len(), undo + 1);

    // Lo mismo otra vez no apila nada.
    session
        .commit_song_master_eq("r1", Some(wild.clone()), &audio)
        .expect("same");
    assert_eq!(session.undo_stack.len(), undo + 1);

    session.undo_action(&audio).expect("undo");
    assert_eq!(region_master_eq(&session, "r1"), None);
    session.redo_action(&audio).expect("redo");
    assert_eq!(region_master_eq(&session, "r1"), Some(wild.sanitized()));

    assert!(session.commit_song_master_eq("nope", None, &audio).is_err());

    // En disco va dentro de `master`, y se omite sin EQ.
    let song = serde_json::to_value(session.engine.song().unwrap()).unwrap();
    assert!(song["regions"][0]["master"]["eq"]["bands"].is_array());
    assert!(song["regions"][1]["master"].get("eq").is_none());
}

#[test]
fn the_engine_command_for_the_song_master_eq_has_the_cpp_shape() {
    let command = lt_audio_engine_v2::EngineCommand::SetSongMasterEq {
        region_id: "r1".into(),
        eq: Some(serde_json::to_value(boosted_eq()).unwrap()),
    };
    let json = serde_json::to_value(&command).unwrap();
    assert_eq!(json["type"], "SetSongMasterEq");
    assert_eq!(json["region_id"], "r1");
    assert_eq!(json["eq"]["bands"][2]["gainDb"], 4.5);
    let removal = lt_audio_engine_v2::EngineCommand::SetSongMasterEq { region_id: "r1".into(), eq: None };
    assert!(serde_json::to_value(&removal).unwrap().get("eq").is_none());
}
