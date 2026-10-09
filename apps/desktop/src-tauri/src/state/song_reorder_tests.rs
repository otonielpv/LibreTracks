//! Reordenar canciones por posición de lista (vistas compacta y live).

use std::fs;

use libretracks_core::{
    Clip, Marker, MarkerKind, MidiClip, Song, SongMaster, SongRegion, TempoMarker, Track, TrackKind,
};
use libretracks_project::{create_song_folder, save_song, SONG_FILE_NAME};
use tempfile::tempdir;

use super::reorder_song_regions;
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
        chart: None,
        structure: None,
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

fn section(id: &str, start: f64) -> Marker {
    Marker {
        id: id.into(),
        name: id.into(),
        start_seconds: start,
        digit: None,
        kind: MarkerKind::default(),
        variant: None,
        color: None,
        category_override: None,
    }
}

/// 120 BPM 4/4: un compás = 2 s.
fn song_with(regions: Vec<SongRegion>, clips: Vec<Clip>) -> Song {
    Song {
        id: "reorder".into(),
        title: "Reorder".into(),
        artist: None,
        key: None,
        bpm: 120.0,
        time_signature: "4/4".into(),
        duration_seconds: regions.iter().map(|r| r.end_seconds).fold(0.0, f64::max),
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
        clips,
        midi_clips: vec![],
        video_clips: vec![],
        section_markers: vec![],
    }
}

/// Tres canciones de 8 s pegadas, cada una con un clip a +1 s.
fn three_back_to_back() -> Song {
    song_with(
        vec![
            region("r1", 0.0, 8.0),
            region("r2", 8.0, 16.0),
            region("r3", 16.0, 24.0),
        ],
        vec![clip("c1", 1.0), clip("c2", 9.0), clip("c3", 17.0)],
    )
}

fn span(song: &Song, id: &str) -> (f64, f64) {
    let region = song.regions.iter().find(|r| r.id == id).expect("region");
    (region.start_seconds, region.end_seconds)
}

fn clip_start(song: &Song, id: &str) -> f64 {
    song.clips
        .iter()
        .find(|c| c.id == id)
        .expect("clip")
        .timeline_start_seconds
}

fn order(song: &Song) -> Vec<&str> {
    song.regions.iter().map(|r| r.id.as_str()).collect()
}

fn assert_close(actual: f64, expected: f64, what: &str) {
    assert!(
        (actual - expected).abs() < 1e-6,
        "{what}: esperado {expected}, obtenido {actual}"
    );
}

#[test]
fn moving_the_last_song_first_carries_everything_inside_it() {
    let mut song = three_back_to_back();
    song.tempo_markers = vec![TempoMarker {
        id: "t3".into(),
        start_seconds: 16.0,
        bpm: 120.0,
    }];
    song.section_markers = vec![section("s2", 10.0), section("s3", 20.0)];
    song.midi_clips = vec![MidiClip {
        id: "m3".into(),
        track_id: "a1".into(),
        timeline_start_seconds: 18.0,
        name: String::new(),
        events: vec![],
        color: None,
    }];

    assert!(reorder_song_regions(&mut song, "r3", 0));

    assert_eq!(order(&song), vec!["r3", "r1", "r2"]);
    assert_eq!(span(&song, "r3"), (0.0, 8.0));
    assert_eq!(span(&song, "r1"), (8.0, 16.0));
    assert_eq!(span(&song, "r2"), (16.0, 24.0));
    assert_close(clip_start(&song, "c3"), 1.0, "clip de r3");
    assert_close(clip_start(&song, "c1"), 9.0, "clip de r1");
    assert_close(clip_start(&song, "c2"), 17.0, "clip de r2");
    // La marca de tempo clavada en el inicio viaja con su canción.
    assert_close(song.tempo_markers[0].start_seconds, 0.0, "tempo de r3");
    // Marcas de sección y clips MIDI también, y las listas quedan ordenadas.
    let sections: Vec<(&str, f64)> = song
        .section_markers
        .iter()
        .map(|m| (m.id.as_str(), m.start_seconds))
        .collect();
    assert_eq!(sections, vec![("s3", 4.0), ("s2", 18.0)]);
    assert_close(
        song.midi_clips[0].timeline_start_seconds,
        2.0,
        "clip MIDI de r3",
    );
}

#[test]
fn moving_a_song_down_the_list() {
    let mut song = three_back_to_back();

    assert!(reorder_song_regions(&mut song, "r1", 1));

    assert_eq!(order(&song), vec!["r2", "r1", "r3"]);
    assert_close(clip_start(&song, "c2"), 1.0, "clip de r2");
    assert_close(clip_start(&song, "c1"), 9.0, "clip de r1");
    assert_close(clip_start(&song, "c3"), 17.0, "r3 no se mueve");
}

#[test]
fn gaps_stay_with_their_list_position_when_not_on_a_downbeat() {
    // r1 acaba en 8 (tiempo fuerte) pero r2 empieza en 9.3: hueco libre de
    // 1,3 s. r2 acaba en 13 y r3 empieza en 13, a mitad de compás.
    let mut song = song_with(
        vec![
            region("r1", 0.0, 8.0),
            region("r2", 9.3, 13.0),
            region("r3", 13.0, 17.0),
        ],
        vec![clip("c1", 1.0), clip("c2", 10.0), clip("c3", 14.0)],
    );

    assert!(reorder_song_regions(&mut song, "r1", 2));

    assert_eq!(order(&song), vec!["r2", "r3", "r1"]);
    assert_eq!(span(&song, "r2").0, 0.0);
    // Primer hueco (1,3 s) entre las posiciones 1 y 2 de la lista.
    assert_close(span(&song, "r3").0, 3.7 + 1.3, "inicio de r3");
    // Segundo hueco (0 s), sin ajustar a compás porque no lo estaba.
    assert_close(span(&song, "r1").0, 9.0, "inicio de r1");
    assert_close(clip_start(&song, "c1"), 10.0, "clip de r1");
}

#[test]
fn boundaries_on_a_downbeat_land_on_the_next_downbeat() {
    // Cada canción empieza en el compás siguiente al final de la anterior,
    // como las coloca la importación: r1 acaba en 5 → r2 en 6; r2 acaba en 11
    // → r3 en 12.
    let mut song = song_with(
        vec![
            region("r1", 0.0, 5.0),
            region("r2", 6.0, 11.0),
            region("r3", 12.0, 15.0),
        ],
        vec![clip("c1", 1.0), clip("c2", 7.0), clip("c3", 13.0)],
    );

    assert!(reorder_song_regions(&mut song, "r3", 0));

    assert_eq!(order(&song), vec!["r3", "r1", "r2"]);
    assert_eq!(span(&song, "r3"), (0.0, 3.0));
    // r3 acaba en 3 → siguiente compás en 4.
    assert_close(span(&song, "r1").0, 4.0, "inicio de r1");
    // r1 acaba en 9 → siguiente compás en 10.
    assert_close(span(&song, "r2").0, 10.0, "inicio de r2");
    assert_close(clip_start(&song, "c2"), 11.0, "clip de r2");
}

#[test]
fn same_position_or_unknown_song_is_a_no_op() {
    let mut song = three_back_to_back();
    let before = song.clone();

    assert!(!reorder_song_regions(&mut song, "r2", 1));
    assert!(!reorder_song_regions(&mut song, "nope", 0));
    // Un índice fuera de rango significa "al final": r3 ya lo está.
    assert!(!reorder_song_regions(&mut song, "r3", 99));
    assert_eq!(song, before);
}

#[test]
fn reordering_through_the_session_is_one_undo_step() {
    let song = three_back_to_back();
    let root = tempdir().expect("temp dir").keep();
    let song_dir = create_song_folder(&root, "reorder").expect("song dir");
    fs::create_dir_all(song_dir.join("audio")).expect("audio dir");
    crate::state::tests::write_silent_test_wav(&song_dir.join("audio").join("test.wav"), 1);
    save_song(&song_dir, &song).expect("save song");
    let mut session = DesktopSession::default();
    session.song_file_path = Some(song_dir.join(SONG_FILE_NAME));
    session.song_dir = Some(song_dir);
    session.engine.load_song(song).expect("load song");
    let audio = AudioController::default();

    session
        .reorder_song_region("r3", 0, &audio)
        .expect("reorder");
    let after = session.engine.song().cloned().expect("song");
    assert_eq!(order(&after), vec!["r3", "r1", "r2"]);

    session.undo_action(&audio).expect("undo");
    let undone = session.engine.song().cloned().expect("song");
    assert_eq!(order(&undone), vec!["r1", "r2", "r3"]);
    assert_close(clip_start(&undone, "c3"), 17.0, "deshacer devuelve el clip");
}
