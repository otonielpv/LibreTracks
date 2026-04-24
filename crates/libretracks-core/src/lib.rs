pub mod model;
pub mod validation;

pub use model::{
    Clip, Marker, OutputBus, Project, Song, SongRegion, TempoMarker, TempoMetadata, TempoSource,
    Track, TrackKind,
};
pub use validation::{validate_song, DomainError};

#[cfg(test)]
mod tests {
    use crate::{validate_song, Clip, Marker, OutputBus, Song, SongRegion, Track, TrackKind};

    fn valid_song() -> Song {
        Song {
            id: "song_001".into(),
            title: "Digno y Santo".into(),
            artist: Some("Ejemplo".into()),
            key: Some("D".into()),
            bpm: 72.0,
            time_signature: "4/4".into(),
            duration_seconds: 240.0,
            tempo_markers: vec![],
            regions: vec![SongRegion {
                id: "region_intro".into(),
                name: "Cancion".into(),
                start_seconds: 0.0,
                end_seconds: 240.0,
                bpm: 72.0,
                time_signature: "4/4".into(),
            }],
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
            section_markers: vec![Marker {
                id: "section_intro".into(),
                name: "Intro".into(),
                start_seconds: 0.0,
                digit: Some(1),
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
        assert!(json.contains("\"regions\""));
        assert!(json.contains("\"sectionMarkers\""));
    }

    #[test]
    fn rejects_duplicate_marker_digits() {
        let mut song = valid_song();
        song.section_markers.push(Marker {
            id: "section_verse".into(),
            name: "Verse".into(),
            start_seconds: 32.0,
            digit: Some(1),
        });

        let error = validate_song(&song).expect_err("song should be invalid");
        assert!(error.to_string().contains("duplicated"));
    }

    #[test]
    fn resolves_the_current_marker_at_a_position() {
        let mut song = valid_song();
        song.section_markers = vec![
            Marker {
                id: "section_verse".into(),
                name: "Verse".into(),
                start_seconds: 16.0,
                digit: Some(2),
            },
            Marker {
                id: "section_outro".into(),
                name: "Outro".into(),
                start_seconds: 48.0,
                digit: Some(3),
            },
        ];

        let marker = song
            .marker_at(52.0)
            .expect("marker should resolve at position");

        assert_eq!(marker.id, "section_outro");
        assert_eq!(marker.name, "Outro");
    }

    #[test]
    fn auto_names_the_next_marker() {
        let mut song = valid_song();
        song.section_markers.push(Marker {
            id: "section_verse".into(),
            name: "Verse".into(),
            start_seconds: 32.0,
            digit: Some(2),
        });

        assert_eq!(song.next_marker_name(), "Marker 2");
    }
}
