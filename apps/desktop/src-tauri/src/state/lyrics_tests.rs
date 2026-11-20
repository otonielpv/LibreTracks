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
