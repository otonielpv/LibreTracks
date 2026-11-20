//! Plan lyrics-sync: el vínculo de letra de una canción en la sesión.

use libretracks_core::{
    LyricsLink, LyricsSoftware, Marker, MarkerKind, RegionLyrics, Song, SongMaster, SongRegion,
};
use libretracks_project::{create_song_folder, save_song, SONG_FILE_NAME};
use tempfile::tempdir;

use crate::audio::engine::AudioController;

use super::DesktopSession;

fn session() -> DesktopSession {
    let song = Song {
        id: "lyrics".into(),
        title: "Charts".into(),
        artist: None,
        key: None,
        bpm: 120.0,
        time_signature: "4/4".into(),
        duration_seconds: 20.0,
        tempo_markers: vec![],
        time_signature_markers: vec![],
        regions: vec![SongRegion {
            drum_loop: None,
            lyrics: Some(RegionLyrics {
                links: vec![LyricsLink {
                    software: LyricsSoftware::FreeShow,
                    presentation_id: Some("show-1".into()),
                    presentation_name: "Song".into(),
                    overrides: vec![],
                }],
                ..RegionLyrics::default()
            }),
            key_changes: Vec::new(),
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
            cover_image: None,
            voice_guide_count_style: None,
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
    let song_dir = create_song_folder(&root, "lyrics").expect("song dir");
    save_song(&song_dir, &song).expect("save song");
    let mut session = DesktopSession::default();
    session.song_file_path = Some(song_dir.join(SONG_FILE_NAME));
    session.song_dir = Some(song_dir);
    session.engine.load_song(song).expect("load song");
    session
}

#[test]
fn splitting_a_song_copies_its_lyrics_link_to_both_halves() {
    let mut session = session();
    let audio = AudioController::default();
    session.split_song_region("r1", 10.0, &audio).expect("split");
    let song = session.engine.song().expect("song");
    assert_eq!(song.regions.len(), 2);
    for region in &song.regions {
        let lyrics = region.lyrics.as_ref().expect("lyrics copied");
        assert_eq!(lyrics.links[0].presentation_name, "Song");
    }
}

fn link_named(name: &str) -> LyricsLink {
    LyricsLink {
        software: LyricsSoftware::Holyrics,
        presentation_id: Some("812".into()),
        presentation_name: name.into(),
        overrides: vec![],
    }
}

#[test]
fn linking_a_song_is_one_undo_step() {
    let mut session = session();
    let audio = AudioController::default();
    let lyrics = RegionLyrics {
        links: vec![link_named("Way Maker")],
        ..RegionLyrics::default()
    };
    session
        .set_region_lyrics("r1", Some(lyrics.clone()), &audio)
        .expect("set");
    assert_eq!(session.engine.song().unwrap().regions[0].lyrics, Some(lyrics));
    session.undo_action(&audio).expect("undo");
    let restored = session.engine.song().unwrap().regions[0].lyrics.clone();
    assert_eq!(restored.unwrap().links[0].software, LyricsSoftware::FreeShow);
}

#[test]
fn a_link_found_by_name_is_stored_without_an_undo_step_and_keeps_the_rest() {
    let mut session = session();
    let audio = AudioController::default();
    session
        .store_lyrics_link_silently("r1", link_named("Way Maker"), &audio)
        .expect("store");
    let lyrics = session.engine.song().unwrap().regions[0]
        .lyrics
        .clone()
        .expect("lyrics");
    // The FreeShow link stays; the Holyrics one is added.
    assert_eq!(lyrics.links.len(), 2);
    assert!(session.undo_action(&audio).is_err() || {
        let after = session.engine.song().unwrap().regions[0].lyrics.clone().unwrap();
        after.links.len() == 2
    });
}

#[test]
fn edits_reach_the_lyrics_worker_only_while_lyrics_are_on() {
    let mut session = session();
    let audio = AudioController::default();
    let (sender, mut inbox) = tokio::sync::mpsc::unbounded_channel();
    session
        .set_region_lyrics("r1", None, &audio)
        .expect("edit while off");
    assert!(inbox.try_recv().is_err(), "no worker yet");
    session.lyrics.sender = Some(sender);
    session
        .set_region_lyrics("r1", Some(RegionLyrics::default()), &audio)
        .expect("edit while on");
    assert!(matches!(
        inbox.try_recv(),
        Ok(libretracks_lyrics::worker::WorkerInput::Song(_))
    ));
}
