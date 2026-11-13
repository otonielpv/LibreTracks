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

// ── Paso 04: «Separar canales L/R» ─────────────────────────────────────────

fn song_json(session: &super::DesktopSession) -> String {
    serde_json::to_string(session.engine.song().unwrap()).unwrap()
}

/// `bass1` con tres clips (fundidos y ganancias distintos) dentro de una
/// carpeta, con color, volumen, paneo y salida propios.
fn three_clip_session() -> (super::DesktopSession, AudioController) {
    let mut session = two_song_session();
    let mut song = session.engine.song().cloned().unwrap();
    let mut folder = track_of(&session, "bass1");
    folder.id = "folder".into();
    folder.name = "Carpeta".into();
    folder.kind = libretracks_core::TrackKind::Folder;
    song.tracks.insert(0, folder);
    let bass = song.tracks.iter_mut().find(|t| t.id == "bass1").unwrap();
    bass.parent_track_id = Some("folder".into());
    bass.color = Some("#ff0000".into());
    bass.pan = -0.25;
    bass.audio_to = "ext:2-3".into();
    let first = song.clips.iter().find(|c| c.track_id == "bass1").unwrap().clone();
    song.clips.push(libretracks_core::Clip {
        id: "bass1_b".into(),
        timeline_start_seconds: 5.5,
        duration_seconds: 2.0,
        gain: 0.5,
        fade_in_seconds: Some(0.1),
        ..first.clone()
    });
    song.clips.push(libretracks_core::Clip {
        id: "bass1_c".into(),
        timeline_start_seconds: 8.0,
        duration_seconds: 3.0,
        source_start_seconds: 1.5,
        fade_out_seconds: Some(0.3),
        ..first
    });
    session.engine.load_song(song).unwrap();
    (session, AudioController::default())
}

fn clips_of(session: &super::DesktopSession, track_id: &str) -> Vec<libretracks_core::Clip> {
    session
        .engine
        .song()
        .unwrap()
        .clips
        .iter()
        .filter(|c| c.track_id == track_id)
        .cloned()
        .collect()
}

fn mono_summary() -> libretracks_project::WaveformSummary {
    libretracks_project::WaveformSummary {
        version: 6,
        duration_seconds: 24.0,
        sample_rate: 44_100,
        lods: vec![libretracks_project::WaveformLod {
            resolution_frames: 256,
            min_peaks: vec![0.0],
            max_peaks: vec![0.0],
            min_peaks_right: Vec::new(),
            max_peaks_right: Vec::new(),
        }],
        seek_index: Vec::new(),
        source_size: 0,
        source_modified_millis: 0,
    }
}

#[test]
fn splitting_a_stereo_track_makes_a_left_and_a_right_copy() {
    let (mut session, audio) = three_clip_session();
    let original = track_of(&session, "bass1");
    let original_clips = clips_of(&session, "bass1");
    assert_eq!(original_clips.len(), 3);

    session
        .split_track_channels("bass1", "Bajo L", "Bajo R", &audio)
        .expect("split");

    let song = session.engine.song().unwrap().clone();
    let index = song.tracks.iter().position(|t| t.id == "bass1").unwrap();
    let left = &song.tracks[index];
    let right = &song.tracks[index + 1];
    assert_ne!(right.id, left.id);
    assert_eq!((left.name.as_str(), right.name.as_str()), ("Bajo L", "Bajo R"));
    assert_eq!(left.channel_mode, ChannelMode::Left);
    assert_eq!(right.channel_mode, ChannelMode::Right);
    for track in [left, right] {
        assert_eq!(track.parent_track_id.as_deref(), Some("folder"));
        assert_eq!(track.color, original.color);
        assert_eq!(track.volume, original.volume);
        assert_eq!(track.pan, original.pan);
        assert_eq!(track.audio_to, original.audio_to);
        assert_eq!(track.transpose_enabled, original.transpose_enabled);
    }

    let right_clips = clips_of(&session, &right.id);
    assert_eq!(clips_of(&session, "bass1"), original_clips);
    assert_eq!(right_clips.len(), 3);
    for (copy, source) in right_clips.iter().zip(&original_clips) {
        assert_ne!(copy.id, source.id);
        assert_eq!(
            libretracks_core::Clip {
                id: source.id.clone(),
                track_id: source.track_id.clone(),
                ..copy.clone()
            },
            *source,
            "misma ruta, tiempos, fundidos y ganancia"
        );
    }
}

#[test]
fn one_undo_goes_back_exactly_and_redo_returns() {
    let (mut session, audio) = three_clip_session();
    let before = song_json(&session);
    session
        .split_track_channels("bass1", "Bajo L", "Bajo R", &audio)
        .expect("split");
    let after = song_json(&session);
    assert_ne!(before, after);

    session.undo_action(&audio).expect("undo");
    assert_eq!(song_json(&session), before);
    session.redo_action(&audio).expect("redo");
    assert_eq!(song_json(&session), after);
}

#[test]
fn mono_only_folder_and_midi_tracks_are_refused_untouched() {
    let (mut session, audio) = three_clip_session();
    let mut song = session.engine.song().cloned().unwrap();
    let mut midi = track_of(&session, "voz1");
    midi.id = "midi".into();
    midi.kind = libretracks_core::TrackKind::Midi;
    song.tracks.push(midi);
    session.engine.load_song(song).unwrap();
    // Todos los clips de la sesión usan el mismo fichero: en la caché, mono.
    session
        .waveform_cache
        .insert_for_test("audio/test.wav", mono_summary());
    let before = song_json(&session);
    let undo = session.undo_stack.len();

    for track_id in ["bass1", "folder", "midi"] {
        assert!(
            session
                .split_track_channels(track_id, "L", "R", &audio)
                .is_err(),
            "{track_id} no se puede separar"
        );
    }
    assert_eq!(song_json(&session), before);
    assert_eq!(session.undo_stack.len(), undo);
}

#[test]
fn the_split_survives_saving_and_an_ltset_round_trip() {
    use libretracks_project::{
        export_session_as_package, extract_session_package, load_song_from_file, save_song,
    };
    let (mut session, audio) = three_clip_session();
    session
        .split_track_channels("bass1", "Bajo L", "Bajo R", &audio)
        .expect("split");
    let song = session.engine.song().cloned().unwrap();
    let right_id = song.tracks[song.tracks.iter().position(|t| t.id == "bass1").unwrap() + 1]
        .id
        .clone();
    let check = |loaded: &libretracks_core::Song, what: &str| {
        let mode_of = |id: &str| loaded.tracks.iter().find(|t| t.id == id).unwrap().channel_mode;
        assert_eq!(mode_of("bass1"), ChannelMode::Left, "{what}");
        assert_eq!(mode_of(&right_id), ChannelMode::Right, "{what}");
        assert_eq!(loaded.clips.iter().filter(|c| c.track_id == right_id).count(), 3, "{what}");
    };

    let song_dir = session.song_dir.clone().unwrap();
    save_song(&song_dir, &song).expect("save");
    let reopened =
        load_song_from_file(song_dir.join(libretracks_project::SONG_FILE_NAME)).expect("reopen");
    check(&reopened, "guardar y abrir");

    let package = song_dir.join("set.ltset");
    export_session_as_package(&song_dir, &song_dir, &song, &[], &package, true, |_, _| {})
        .expect("export");
    let root = tempfile::tempdir().expect("temp").keep();
    let extracted =
        extract_session_package(&root.join("Importada"), &package, |_, _| {}).expect("extract");
    check(&load_song_from_file(&extracted.song_file).expect("load"), ".ltset");
}

#[test]
fn an_arranged_song_keeps_both_tracks_when_switching_arrangements() {
    use super::song_structure::tests::{arrangement, base_cues, base_song, captured, song_of};

    let (mut session, audio) = captured(base_song(), base_cues());
    session
        .save_song_arrangement("r2", arrangement("largo", &["a", "b", "b", "c"]), false, &audio)
        .expect("guardar");
    // Un bloque con contenido propio (un clip que no está en el original).
    let mut song = song_of(&session);
    let structure = song.regions[1].structure.as_mut().unwrap();
    let base_clip = structure.original.clips[0].clone();
    structure.arrangements[0].blocks[2].content = Some(libretracks_core::BlockContent {
        duration_seconds: 16.0,
        clips: vec![libretracks_core::Clip {
            id: "propio".into(),
            timeline_start_seconds: 1.0,
            duration_seconds: 2.0,
            ..base_clip
        }],
        ..Default::default()
    });
    session.engine.load_song(song).unwrap();
    session
        .apply_song_arrangement("r2", Some("largo"), &audio)
        .expect("aplicar");
    let left_count = clips_of(&session, "a1").len();
    assert!(clips_of(&session, "a1").iter().any(|c| c.id.starts_with("propio")));

    session
        .split_track_channels("a1", "a1 L", "a1 R", &audio)
        .expect("split en canción arreglada");
    let song = song_of(&session);
    let right_id = song.tracks[1].id.clone();
    assert_eq!(clips_of(&session, &right_id).len(), left_count);

    session
        .apply_song_arrangement("r2", None, &audio)
        .expect("volver al original");
    assert_eq!(
        clips_of(&session, &right_id).len(),
        clips_of(&session, "a1").len(),
        "original: las dos pistas con sus clips"
    );
    session
        .apply_song_arrangement("r2", Some("largo"), &audio)
        .expect("reaplicar");
    let left = clips_of(&session, "a1");
    let right = clips_of(&session, &right_id);
    assert_eq!(left.len(), left_count);
    assert_eq!(right.len(), left_count);
    assert!(
        right.iter().any(|c| c.id.starts_with("propio")),
        "el contenido propio del bloque también llega a la pista R"
    );
    for (l, r) in left.iter().zip(&right) {
        assert_eq!(l.timeline_start_seconds, r.timeline_start_seconds);
        assert_eq!(l.file_path, r.file_path);
    }
}
