//! Un clip MIDI sigue a la canción que contiene su inicio igual que un clip de
//! audio o de vídeo: se mueve, se empuja y se borra con ella.
//!
//! Hasta este arreglo `move_song_region`, `shift_song_suffix`, el desplazamiento
//! por cambio de tono sin warp y `delete_song_region` trataban audio y vídeo
//! pero se olvidaban de `midi_clips`, que viven en su propia lista: al mover
//! una canción en la DAW sus clips MIDI se quedaban donde estaban.

use std::fs;

use libretracks_core::{Clip, MidiClip, Song, SongMaster, SongRegion, Track, TrackKind};
use libretracks_project::{create_song_folder, save_song, SONG_FILE_NAME};
use tempfile::tempdir;

use crate::audio::engine::AudioController;

use super::DesktopSession;

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

fn track(id: &str, kind: TrackKind) -> Track {
    Track {
        id: id.into(),
        name: id.into(),
        kind,
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
    }
}

fn audio_clip(id: &str, start: f64) -> Clip {
    Clip {
        id: id.into(),
        track_id: "a1".into(),
        file_path: "audio/test.wav".into(),
        timeline_start_seconds: start,
        source_start_seconds: 0.0,
        duration_seconds: 4.0,
        gain: 1.0,
        fade_in_seconds: None,
        fade_out_seconds: None,
        color: None,
    }
}

fn midi_clip(id: &str, start: f64) -> MidiClip {
    MidiClip {
        id: id.into(),
        track_id: "m1".into(),
        timeline_start_seconds: start,
        name: String::new(),
        events: vec![],
        color: None,
    }
}

/// Dos canciones de 12 s. Cada una con un clip de audio a +1 s y uno MIDI a
/// +3 s.
fn two_song_session() -> DesktopSession {
    let song = Song {
        id: "midi_arrangement".into(),
        title: "Midi".into(),
        artist: None,
        key: None,
        bpm: 120.0,
        time_signature: "4/4".into(),
        duration_seconds: 24.0,
        tempo_markers: vec![],
        time_signature_markers: vec![],
        regions: vec![region("r1", 0.0, 12.0), region("r2", 12.0, 24.0)],
        tracks: vec![track("a1", TrackKind::Audio), track("m1", TrackKind::Midi)],
        clips: vec![audio_clip("c1", 1.0), audio_clip("c2", 13.0)],
        midi_clips: vec![midi_clip("mc1", 3.0), midi_clip("mc2", 15.0)],
        video_clips: vec![],
        section_markers: vec![],
    };

    let root = tempdir().expect("temp dir").keep();
    let song_dir = create_song_folder(&root, "midi_arrangement").expect("song dir");
    fs::create_dir_all(song_dir.join("audio")).expect("audio dir");
    super::tests::write_silent_test_wav(&song_dir.join("audio").join("test.wav"), 12);
    save_song(&song_dir, &song).expect("save song");

    let mut session = DesktopSession::default();
    session.song_file_path = Some(song_dir.join(SONG_FILE_NAME));
    session.song_dir = Some(song_dir);
    session.engine.load_song(song).expect("load song");
    session
}

fn song(session: &DesktopSession) -> Song {
    session.engine.song().cloned().expect("song loaded")
}

fn midi_start(session: &DesktopSession, id: &str) -> Option<f64> {
    song(session)
        .midi_clips
        .iter()
        .find(|clip| clip.id == id)
        .map(|clip| clip.timeline_start_seconds)
}

fn audio_start(session: &DesktopSession, id: &str) -> Option<f64> {
    song(session)
        .clips
        .iter()
        .find(|clip| clip.id == id)
        .map(|clip| clip.timeline_start_seconds)
}

#[test]
fn moving_a_song_moves_its_midi_clips() {
    let mut session = two_song_session();
    let audio = AudioController::default();
    session
        .move_song_region("r2", 4.0, &audio)
        .expect("move second song right");

    assert_eq!(midi_start(&session, "mc2"), Some(19.0));
    // La otra canción no se toca.
    assert_eq!(midi_start(&session, "mc1"), Some(3.0));
}

#[test]
fn a_song_pushed_by_another_takes_its_midi_clips_along() {
    let mut session = two_song_session();
    let audio = AudioController::default();
    // Soltar la primera encima de la segunda empuja la segunda en cascada.
    session
        .move_song_region("r1", 6.0, &audio)
        .expect("move first song into the second");

    let c2_delta = audio_start(&session, "c2").expect("c2") - 13.0;
    let mc2_delta = midi_start(&session, "mc2").expect("mc2") - 15.0;
    assert!(c2_delta > 0.0, "la segunda canción no fue empujada");
    assert!(
        (c2_delta - mc2_delta).abs() < 1e-9,
        "MIDI empujado {mc2_delta}, audio {c2_delta}"
    );
}

#[test]
fn transposing_without_warp_shifts_the_following_midi_clips() {
    let mut session = two_song_session();
    let audio = AudioController::default();
    // Sin warp el tono cambia la duración de la canción (varispeed), y las
    // que vienen detrás se desplazan para no solaparse ni dejar hueco.
    session
        .update_song_region_transpose("r1", 2, &audio)
        .expect("transpose first song");

    let c2_delta = audio_start(&session, "c2").expect("c2") - 13.0;
    let mc2_delta = midi_start(&session, "mc2").expect("mc2") - 15.0;
    assert!(
        c2_delta.abs() > 1e-6,
        "el tono no desplazó la segunda canción"
    );
    assert!(
        (c2_delta - mc2_delta).abs() < 1e-9,
        "MIDI desplazado {mc2_delta}, audio {c2_delta}"
    );
}

#[test]
fn deleting_a_song_deletes_its_midi_clips() {
    let mut session = two_song_session();
    let audio = AudioController::default();
    session
        .delete_song_region("r2", &audio)
        .expect("delete second song");

    assert_eq!(midi_start(&session, "mc2"), None);
    assert_eq!(midi_start(&session, "mc1"), Some(3.0));
}
