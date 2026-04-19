//! Persistencia y operaciones de proyecto.

mod song_store;

pub use song_store::{
    create_song_folder, load_song, save_song, song_file_path, ProjectError, SONG_FILE_NAME,
};

#[cfg(test)]
mod tests {
    use std::fs;

    use libretracks_core::{Clip, OutputBus, Section, Song, Track, TrackGroup};
    use tempfile::tempdir;

    use crate::{create_song_folder, load_song, save_song, song_file_path, ProjectError};

    fn demo_song() -> Song {
        Song {
            id: "song_001".into(),
            title: "Digno y Santo".into(),
            artist: Some("Ejemplo".into()),
            bpm: 72.0,
            key: Some("D".into()),
            time_signature: "4/4".into(),
            duration_seconds: 240.0,
            tracks: vec![Track {
                id: "track_click".into(),
                name: "Click".into(),
                group_id: Some("group_monitor".into()),
                volume: 1.0,
                pan: 0.0,
                muted: false,
                solo: false,
                output_bus_id: OutputBus::Monitor.id(),
            }],
            groups: vec![TrackGroup {
                id: "group_monitor".into(),
                name: "Click + Guide".into(),
                volume: 1.0,
                muted: false,
                output_bus_id: OutputBus::Monitor.id(),
            }],
            clips: vec![Clip {
                id: "clip_click".into(),
                track_id: "track_click".into(),
                file_path: "audio/click.wav".into(),
                timeline_start_seconds: 0.0,
                source_start_seconds: 0.0,
                duration_seconds: 240.0,
                gain: 1.0,
                fade_in_seconds: None,
                fade_out_seconds: None,
            }],
            sections: vec![Section {
                id: "section_intro".into(),
                name: "Intro".into(),
                start_seconds: 0.0,
                end_seconds: 16.0,
            }],
        }
    }

    #[test]
    fn creates_song_folder_layout() {
        let root = tempdir().expect("temp dir should exist");
        let song_dir =
            create_song_folder(root.path(), "digno-y-santo").expect("folder should be created");

        assert!(song_dir.exists());
        assert!(song_dir.join("audio").exists());
        assert!(song_dir.join("cache").exists());
        assert!(song_dir.join("cache").join("waveforms").exists());
    }

    #[test]
    fn saves_and_loads_song_roundtrip() {
        let root = tempdir().expect("temp dir should exist");
        let song_dir =
            create_song_folder(root.path(), "digno-y-santo").expect("folder should be created");
        let song = demo_song();

        save_song(&song_dir, &song).expect("song should save");
        let loaded = load_song(&song_dir).expect("song should load");

        assert_eq!(loaded, song);
    }

    #[test]
    fn saves_json_with_version_and_camel_case_fields() {
        let root = tempdir().expect("temp dir should exist");
        let song_dir =
            create_song_folder(root.path(), "digno-y-santo").expect("folder should be created");

        save_song(&song_dir, &demo_song()).expect("song should save");

        let json = fs::read_to_string(song_file_path(&song_dir)).expect("song file should exist");
        assert!(json.contains("\"version\": 1"));
        assert!(json.contains("\"timeSignature\""));
        assert!(json.contains("\"timelineStartSeconds\""));
    }

    #[test]
    fn rejects_invalid_song_before_writing() {
        let root = tempdir().expect("temp dir should exist");
        let song_dir =
            create_song_folder(root.path(), "digno-y-santo").expect("folder should be created");
        let mut song = demo_song();
        song.title.clear();

        let error = save_song(&song_dir, &song).expect_err("invalid song should fail");

        match error {
            ProjectError::InvalidSong(_) => {}
            other => panic!("unexpected error: {other}"),
        }
    }
}
