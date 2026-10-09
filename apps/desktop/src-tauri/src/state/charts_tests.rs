//! La partitura de una canción: se copia a `charts/`, sus puntos se anclan a la
//! marca original y cada cambio es un paso de deshacer.

use std::fs;

use libretracks_core::{Marker, MarkerKind, Song, SongMaster, SongRegion};
use libretracks_project::{create_song_folder, save_song, SONG_FILE_NAME};
use tempfile::tempdir;

use crate::audio::engine::AudioController;

use super::DesktopSession;

const PDF: &[u8] = b"%PDF-1.7\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF";

fn session() -> DesktopSession {
    let song = Song {
        id: "charts".into(),
        title: "Charts".into(),
        artist: None,
        key: None,
        bpm: 120.0,
        time_signature: "4/4".into(),
        duration_seconds: 20.0,
        tempo_markers: vec![],
        time_signature_markers: vec![],
        regions: vec![SongRegion {
            id: "r1".into(),
            name: "Song".into(),
            start_seconds: 0.0,
            end_seconds: 20.0,
            transpose_semitones: 0,
            key: None,
            warp_enabled: false,
            warp_source_bpm: None,
            master: SongMaster::default(),
            compact_column_width_rem: None,
            chart: None,
            structure: None,
        }],
        tracks: vec![],
        clips: vec![],
        midi_clips: vec![],
        video_clips: vec![],
        section_markers: vec![Marker {
            id: "chorus".into(),
            name: "Chorus".into(),
            start_seconds: 4.0,
            digit: None,
            kind: MarkerKind::Chorus,
            variant: None,
            color: None,
            category_override: None,
        }],
    };
    let root = tempdir().expect("temp dir").keep();
    let song_dir = create_song_folder(&root, "charts").expect("song dir");
    save_song(&song_dir, &song).expect("save song");
    let mut session = DesktopSession::default();
    session.song_file_path = Some(song_dir.join(SONG_FILE_NAME));
    session.song_dir = Some(song_dir);
    session.engine.load_song(song).expect("load song");
    session
}

fn chart(session: &DesktopSession) -> Option<libretracks_core::SongChart> {
    session.engine.song().expect("song").regions[0].chart.clone()
}

#[test]
fn a_chart_is_copied_into_the_session_and_assigned_to_the_song() {
    let mut session = session();
    let audio = AudioController::default();
    session
        .set_song_region_chart_from_bytes("r1", "Acordes.pdf", PDF, &audio)
        .expect("set chart");

    let chart = chart(&session).expect("chart assigned");
    assert_eq!(chart.file_path, "charts/Acordes.pdf");
    let on_disk = session.song_region_chart_path("r1").expect("path");
    assert_eq!(fs::read(on_disk).expect("copied"), PDF);
}

#[test]
fn a_second_chart_with_the_same_name_does_not_overwrite_the_first() {
    let mut session = session();
    let audio = AudioController::default();
    session
        .set_song_region_chart_from_bytes("r1", "a.pdf", PDF, &audio)
        .expect("first");
    session
        .set_song_region_chart_from_bytes("r1", "a.pdf", PDF, &audio)
        .expect("second");
    assert_eq!(chart(&session).expect("chart").file_path, "charts/a (2).pdf");
}

#[test]
fn something_that_is_not_a_pdf_is_refused_and_nothing_changes() {
    let mut session = session();
    let audio = AudioController::default();
    let error = session
        .set_song_region_chart_from_bytes("r1", "song.pdf", b"RIFF....WAVE", &audio)
        .expect_err("not a pdf");
    assert!(error.to_string().contains("not a PDF"), "{error}");
    assert!(chart(&session).is_none());
}

#[test]
fn an_anchor_set_from_a_repeat_is_stored_on_the_original_marker() {
    let mut session = session();
    let audio = AudioController::default();
    session
        .set_song_region_chart_from_bytes("r1", "a.pdf", PDF, &audio)
        .expect("chart");
    session
        .set_song_chart_anchor("r1", "chorus~2", 1, 0.5, &audio)
        .expect("anchor");

    let chart = chart(&session).expect("chart");
    assert_eq!(chart.anchors.len(), 1);
    assert_eq!(chart.anchors[0].marker_id, "chorus");
    assert!(session
        .set_song_chart_anchor("r1", "ghost", 0, 0.0, &audio)
        .is_err());
}

#[test]
fn replacing_the_chart_drops_anchors_that_pointed_into_the_old_one() {
    let mut session = session();
    let audio = AudioController::default();
    session
        .set_song_region_chart_from_bytes("r1", "a.pdf", PDF, &audio)
        .expect("chart");
    session
        .set_song_chart_anchor("r1", "chorus", 0, 0.3, &audio)
        .expect("anchor");
    session
        .set_song_region_chart_from_bytes("r1", "b.pdf", PDF, &audio)
        .expect("replace");
    assert!(chart(&session).expect("chart").anchors.is_empty());
}

#[test]
fn removing_a_chart_can_be_undone_and_its_file_is_still_there() {
    let mut session = session();
    let audio = AudioController::default();
    session
        .set_song_region_chart_from_bytes("r1", "a.pdf", PDF, &audio)
        .expect("chart");
    session.clear_song_region_chart("r1", &audio).expect("clear");
    assert!(chart(&session).is_none());

    session.undo_action(&audio).expect("undo");
    assert!(chart(&session).is_some());
    let path = session.song_region_chart_path("r1").expect("path");
    assert!(path.is_file(), "undo must find the PDF on disk");
}
