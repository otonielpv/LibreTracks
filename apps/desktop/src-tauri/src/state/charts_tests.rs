//! La letra de una canción: se valida, sus enlaces se anclan a la marca
//! original y cada cambio es un paso de deshacer.

use libretracks_core::{ChartLink, Marker, MarkerKind, Song, SongChart, SongMaster, SongRegion};
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

fn chart(session: &DesktopSession) -> Option<SongChart> {
    session.engine.song().expect("song").regions[0].chart.clone()
}

fn lyrics(links: Vec<ChartLink>) -> SongChart {
    SongChart {
        text: "{section: Coro}
[C]Gracia sublime es".into(),
        links,
    }
}

fn link(marker_id: &str, line_beats: Vec<f64>) -> ChartLink {
    ChartLink {
        marker_id: marker_id.into(),
        section: 0,
        line_beats,
    }
}

#[test]
fn a_chart_is_stored_with_links_normalized_to_existing_original_markers() {
    let mut session = session();
    let audio = AudioController::default();
    session
        .set_song_region_chart(
            "r1",
            Some(lyrics(vec![link("chorus~2", vec![4.0, 0.0]), link("ghost", vec![])])),
            &audio,
        )
        .expect("set chart");

    let stored = chart(&session).expect("chart stored");
    assert_eq!(stored.links, vec![link("chorus", vec![0.0, 4.0])]);
}

#[test]
fn an_empty_text_clears_the_chart() {
    let mut session = session();
    let audio = AudioController::default();
    session
        .set_song_region_chart("r1", Some(lyrics(vec![])), &audio)
        .expect("set");
    session
        .set_song_region_chart(
            "r1",
            Some(SongChart { text: "  
".into(), links: vec![] }),
            &audio,
        )
        .expect("blank");
    assert!(chart(&session).is_none());
}

#[test]
fn an_oversized_chart_is_refused_and_nothing_changes() {
    let mut session = session();
    let audio = AudioController::default();
    let huge = SongChart {
        text: "a".repeat(SongChart::MAX_TEXT_BYTES + 1),
        links: vec![],
    };
    assert!(session.set_song_region_chart("r1", Some(huge), &audio).is_err());
    assert!(chart(&session).is_none());
}

#[test]
fn removing_a_chart_can_be_undone() {
    let mut session = session();
    let audio = AudioController::default();
    session
        .set_song_region_chart("r1", Some(lyrics(vec![link("chorus", vec![])])), &audio)
        .expect("set");
    session.set_song_region_chart("r1", None, &audio).expect("clear");
    assert!(chart(&session).is_none());

    session.undo_action(&audio).expect("undo");
    assert_eq!(chart(&session), Some(lyrics(vec![link("chorus", vec![])])));
}

#[test]
fn an_unknown_song_is_an_error() {
    let mut session = session();
    let audio = AudioController::default();
    assert!(session
        .set_song_region_chart("nope", Some(lyrics(vec![])), &audio)
        .is_err());
}
