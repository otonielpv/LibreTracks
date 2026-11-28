//! Guía de la secuencia (voz guía «solo en saltos»): marcar o descartar la
//! pista a mano y lo que el frontend lee para avisar de las canciones sin guía.

use crate::audio::engine::AudioController;
use crate::models::view::region_to_summary;

use super::mix_scene_tests::{track_of, two_song_session};

fn has_guide(session: &super::DesktopSession, region_id: &str) -> bool {
    let song = session.engine.song().unwrap();
    let region = song.regions.iter().find(|r| r.id == region_id).unwrap();
    region_to_summary(song, region).has_guide_track
}

#[test]
fn marking_a_guide_track_persists_and_is_one_undo_step() {
    let mut session = two_song_session();
    let audio = AudioController::default();
    let undo = session.undo_stack.len();
    assert!(!has_guide(&session, "r1"));
    assert!(!has_guide(&session, "r2"));

    session
        .update_track_guide("voz2", Some(true), &audio)
        .expect("mark guide");
    assert_eq!(track_of(&session, "voz2").guide, Some(true));
    assert_eq!(session.undo_stack.len(), undo + 1);
    // Solo la canción donde suena esa pista deja de avisar.
    assert!(!has_guide(&session, "r1"));
    assert!(has_guide(&session, "r2"));

    let written = serde_json::to_value(session.engine.song().unwrap()).unwrap();
    let tracks = written["tracks"].as_array().unwrap();
    let voz2 = tracks.iter().find(|t| t["id"] == "voz2").unwrap();
    assert_eq!(voz2["guide"], true);
    // Sin tocar no se escribe: las sesiones sin cambios quedan igual.
    let bass1 = tracks.iter().find(|t| t["id"] == "bass1").unwrap();
    assert!(bass1.get("guide").is_none());

    // Lo mismo otra vez no crea paso de deshacer.
    session
        .update_track_guide("voz2", Some(true), &audio)
        .expect("same");
    assert_eq!(session.undo_stack.len(), undo + 1);

    session.undo_action(&audio).expect("undo");
    assert_eq!(track_of(&session, "voz2").guide, None);
    assert!(!has_guide(&session, "r2"));
}

#[test]
fn a_track_named_guide_counts_until_the_user_discards_it() {
    let mut session = two_song_session();
    let audio = AudioController::default();
    let mut song = session.engine.song().unwrap().clone();
    song.tracks
        .iter_mut()
        .find(|t| t.id == "voz1")
        .unwrap()
        .name = "Guía".into();
    session.engine.load_song(song).unwrap();
    assert!(has_guide(&session, "r1"));

    session
        .update_track_guide("voz1", Some(false), &audio)
        .expect("discard");
    assert!(!has_guide(&session, "r1"));
}

#[test]
fn an_unknown_track_is_an_error() {
    let mut session = two_song_session();
    let audio = AudioController::default();
    assert!(session.update_track_guide("nope", Some(true), &audio).is_err());
}
