//! Modo de canal por pista (plan channel-split, pasos 03 y 04): el comando,
//! el alias del viejo conmutador «Mono» y «Separar canales L/R».

use libretracks_core::ChannelMode;

use crate::audio::engine::AudioController;

use super::mix_scene_tests::{track_of, two_song_session};

#[test]
fn changing_the_channel_mode_persists_and_is_one_undo_step() {
    let mut session = two_song_session();
    let audio = AudioController::default();
    let undo = session.undo_stack.len();

    session
        .update_track_channel_mode("bass1", ChannelMode::Right, &audio)
        .expect("set right");
    assert_eq!(track_of(&session, "bass1").channel_mode, ChannelMode::Right);
    assert_eq!(session.undo_stack.len(), undo + 1);

    // Lo que se guardaría lo trae (el guardado a disco es explícito).
    let written = serde_json::to_value(session.engine.song().unwrap()).unwrap();
    let written_track = written["tracks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"] == "bass1")
        .unwrap();
    assert_eq!(written_track["channelMode"], "right");

    // El mismo modo otra vez no crea paso de deshacer.
    session
        .update_track_channel_mode("bass1", ChannelMode::Right, &audio)
        .expect("same mode");
    assert_eq!(session.undo_stack.len(), undo + 1);

    session.undo_action(&audio).expect("undo");
    assert_eq!(track_of(&session, "bass1").channel_mode, ChannelMode::Stereo);
}

#[test]
fn the_old_mono_toggle_maps_to_mono_and_stereo() {
    let mut session = two_song_session();
    let audio = AudioController::default();

    session
        .update_track_channel_mode("voz1", ChannelMode::Left, &audio)
        .expect("left");
    session
        .update_track_mono_downmix("voz1", true, &audio)
        .expect("mono on");
    assert_eq!(track_of(&session, "voz1").channel_mode, ChannelMode::Mono);
    session
        .update_track_mono_downmix("voz1", false, &audio)
        .expect("mono off");
    assert_eq!(track_of(&session, "voz1").channel_mode, ChannelMode::Stereo);
}

#[test]
fn an_unknown_track_is_an_error() {
    let mut session = two_song_session();
    let audio = AudioController::default();
    assert!(session
        .update_track_channel_mode("nope", ChannelMode::Left, &audio)
        .is_err());
}
