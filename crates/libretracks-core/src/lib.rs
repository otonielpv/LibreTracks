pub mod model;
pub mod validation;

pub use model::{
    Clip, OutputBus, Project, Section, Song, Track, TrackKind,
};
pub use validation::{validate_song, DomainError};

#[cfg(test)]
mod tests {
    use crate::{validate_song, Clip, OutputBus, Section, Song, Track, TrackKind};

    fn valid_song() -> Song {
        Song {
            id: "song_001".into(),
            title: "Digno y Santo".into(),
            artist: Some("Ejemplo".into()),
            bpm: 72.0,
            key: Some("D".into()),
            time_signature: "4/4".into(),
            duration_seconds: 240.0,
            tracks: vec![
                Track {
                    id: "track_folder".into(),
                    name: "Rhythm".into(),
                    kind: TrackKind::Folder,
                    parent_track_id: None,
                    volume: 1.0,
                    pan: 0.0,
                    muted: false,
                    solo: false,
                    output_bus_id: OutputBus::Main.id(),
                },
                Track {
                    id: "track_click".into(),
                    name: "Click".into(),
                    kind: TrackKind::Audio,
                    parent_track_id: Some("track_folder".into()),
                    volume: 1.0,
                    pan: 0.0,
                    muted: false,
                    solo: false,
                    output_bus_id: OutputBus::Monitor.id(),
                },
            ],
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
    fn validates_a_well_formed_song() {
        let song = valid_song();
        assert!(validate_song(&song).is_ok());
    }

    #[test]
    fn rejects_clip_that_points_to_unknown_track() {
        let mut song = valid_song();
        song.clips[0].track_id = "missing".into();

        let error = validate_song(&song).expect_err("song should be invalid");
        assert!(error.to_string().contains("unknown track"));
    }

    #[test]
    fn rejects_clips_that_point_to_folder_tracks() {
        let mut song = valid_song();
        song.clips[0].track_id = "track_folder".into();

        let error = validate_song(&song).expect_err("song should be invalid");
        assert!(error.to_string().contains("folder track"));
    }

    #[test]
    fn serializes_song_to_json() {
        let song = valid_song();
        let json = serde_json::to_string_pretty(&song).expect("song should serialize");

        assert!(json.contains("\"title\": \"Digno y Santo\""));
        assert!(json.contains("\"tracks\""));
        assert!(json.contains("\"kind\": \"audio\""));
    }
}
