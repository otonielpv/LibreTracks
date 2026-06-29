pub mod model;
pub mod validation;
pub mod warp;

pub use model::{
    default_audio_to, parse_audio_output_route, Clip, Marker, MarkerCategory, MarkerKind, Project,
    Song, SongMaster, SongRegion, TempoMarker, TempoMetadata, TempoSource, TimeSignatureMarker,
    Track, TrackKind,
};
pub use validation::{
    validate_song, DomainError, MAX_TRANSPOSE_SEMITONES, MAX_WARP_SOURCE_BPM,
    MIN_TRANSPOSE_SEMITONES, MIN_WARP_SOURCE_BPM,
};
pub use warp::{
    audible_clip_duration_seconds, effective_bpm_at, region_warp_ratio, region_warp_ratio_in_song,
    semitones_to_pitch_scale, source_seconds_at_view, warp_timeline_duration_seconds,
    warp_timeline_seconds_at,
};

#[cfg(test)]
mod tests {
    use crate::{
        validate_song, Clip, Marker, MarkerKind, Song, SongMaster, SongRegion, Track, TrackKind,
        MAX_TRANSPOSE_SEMITONES, MIN_TRANSPOSE_SEMITONES,
    };

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
            time_signature_markers: vec![],
            regions: vec![SongRegion {
                id: "region_intro".into(),
                name: "Cancion".into(),
                start_seconds: 0.0,
                end_seconds: 240.0,
                transpose_semitones: 0,
                warp_enabled: false,
                warp_source_bpm: None,
                master: SongMaster::default(),
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
                    transpose_enabled: true,
                    audio_to: "master".into(),
                    color: None,
                    auto_created: false,
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
                    transpose_enabled: true,
                    audio_to: "ext:2-3".into(),
                    color: None,
                    auto_created: false,
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
                color: None,
            }],
            section_markers: vec![Marker {
                id: "section_intro".into(),
                name: "Intro".into(),
                start_seconds: 0.0,
                digit: Some(1),
                kind: MarkerKind::Custom,
                variant: None,
                color: None,
            }],
        }
    }

    #[test]
    fn validates_a_well_formed_song() {
        let song = valid_song();
        assert!(validate_song(&song).is_ok());
    }

    #[test]
    fn allows_regions_beyond_song_duration() {
        let mut song = valid_song();
        song.regions.push(SongRegion {
            id: "region_outro".into(),
            name: "Outro".into(),
            start_seconds: 240.0,
            end_seconds: 360.0,
            transpose_semitones: 0,
            warp_enabled: false,
            warp_source_bpm: None,
            master: SongMaster::default(),
        });

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
    fn rejects_clip_that_falls_outside_every_region() {
        // valid_song() has region [0, 240). Move the clip start beyond
        // the region so no region contains its start.
        let mut song = valid_song();
        song.clips[0].timeline_start_seconds = 300.0;
        song.clips[0].duration_seconds = 10.0;

        let error = validate_song(&song).expect_err("song should be invalid");
        assert!(
            error.to_string().contains("falls outside every region"),
            "expected outside-region error, got: {error}"
        );
    }

    #[test]
    fn rejects_clip_that_crosses_a_region_boundary() {
        // valid_song() has region [0, 240). Insert a second region [240, 360)
        // so the boundary is real, then make the clip extend across it.
        let mut song = valid_song();
        song.regions.push(SongRegion {
            id: "region_outro".into(),
            name: "Outro".into(),
            start_seconds: 240.0,
            end_seconds: 360.0,
            transpose_semitones: 0,
            warp_enabled: false,
            warp_source_bpm: None,
            master: SongMaster::default(),
        });
        // Clip starts inside region_intro [0, 240) but extends past 240.
        song.clips[0].timeline_start_seconds = 230.0;
        song.clips[0].duration_seconds = 30.0;

        let error = validate_song(&song).expect_err("song should be invalid");
        assert!(
            error.to_string().contains("spans the boundary"),
            "expected boundary error, got: {error}"
        );
    }

    #[test]
    fn allows_sub_frame_clip_region_boundary_rounding() {
        let mut song = valid_song();
        song.regions[0].end_seconds = 10.0;
        song.regions.push(SongRegion {
            id: "region_outro".into(),
            name: "Outro".into(),
            start_seconds: 10.5,
            end_seconds: 20.0,
            transpose_semitones: 0,
            warp_enabled: false,
            warp_source_bpm: None,
            master: SongMaster::default(),
        });
        song.clips[0].timeline_start_seconds = 0.0;
        song.clips[0].duration_seconds = 10.0000005;

        validate_song(&song).expect("tiny boundary rounding must be accepted");
    }

    #[test]
    fn allows_clip_when_song_has_no_regions() {
        // Empty-regions edge case: a song bootstrap with clips but no
        // regions yet should still validate. Auto-create-region logic at
        // the desktop layer is responsible for materialising the region
        // before the song is persisted long-term.
        let mut song = valid_song();
        song.regions.clear();

        assert!(validate_song(&song).is_ok());
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
    fn accepts_warp_disabled_with_no_source_bpm() {
        let song = valid_song();
        assert_eq!(song.regions[0].warp_enabled, false);
        assert!(song.regions[0].warp_source_bpm.is_none());
        assert!(validate_song(&song).is_ok());
    }

    #[test]
    fn accepts_warp_disabled_with_persisted_source_bpm() {
        // Toggling warp off must not invalidate a previously-configured BPM —
        // users expect to flip warp back on without re-entering the value.
        let mut song = valid_song();
        song.regions[0].warp_enabled = false;
        song.regions[0].warp_source_bpm = Some(120.0);
        assert!(validate_song(&song).is_ok());
    }

    #[test]
    fn accepts_warp_enabled_with_valid_source_bpm() {
        let mut song = valid_song();
        song.regions[0].warp_enabled = true;
        song.regions[0].warp_source_bpm = Some(140.0);
        assert!(validate_song(&song).is_ok());
    }

    #[test]
    fn rejects_warp_enabled_without_source_bpm() {
        let mut song = valid_song();
        song.regions[0].warp_enabled = true;
        song.regions[0].warp_source_bpm = None;
        let err = validate_song(&song).expect_err("warp without source bpm");
        assert!(err.to_string().contains("warp enabled"));
    }

    #[test]
    fn rejects_warp_source_bpm_out_of_range() {
        let mut song = valid_song();
        song.regions[0].warp_enabled = true;
        song.regions[0].warp_source_bpm = Some(10.0); // below MIN_WARP_SOURCE_BPM
        assert!(validate_song(&song).is_err());

        song.regions[0].warp_source_bpm = Some(500.0); // above MAX_WARP_SOURCE_BPM
        assert!(validate_song(&song).is_err());
    }

    #[test]
    fn rejects_warp_source_bpm_non_finite() {
        let mut song = valid_song();
        song.regions[0].warp_enabled = true;
        song.regions[0].warp_source_bpm = Some(f64::NAN);
        assert!(validate_song(&song).is_err());

        song.regions[0].warp_source_bpm = Some(f64::INFINITY);
        assert!(validate_song(&song).is_err());
    }

    #[test]
    fn legacy_song_json_without_warp_fields_deserializes() {
        // Round-trip a project file saved before warp existed. serde defaults
        // must fill in warp_enabled=false and warp_source_bpm=None so older
        // projects load without manual migration.
        let legacy_region_json = r#"{
            "id": "region_legacy",
            "name": "Legacy",
            "startSeconds": 0.0,
            "endSeconds": 30.0,
            "transposeSemitones": 0
        }"#;
        let region: crate::model::SongRegion =
            serde_json::from_str(legacy_region_json).expect("legacy json should parse");
        assert_eq!(region.warp_enabled, false);
        assert!(region.warp_source_bpm.is_none());
    }

    #[test]
    fn warp_fields_round_trip_through_json() {
        let mut song = valid_song();
        song.regions[0].warp_enabled = true;
        song.regions[0].warp_source_bpm = Some(132.5);
        let json = serde_json::to_string(&song).expect("serialize");
        let back: Song = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back.regions[0].warp_enabled, true);
        assert_eq!(back.regions[0].warp_source_bpm, Some(132.5));
    }

    #[test]
    fn deserializes_legacy_region_and_track_defaults() {
        let json = r#"{
            "id":"song_legacy",
            "title":"Legacy",
            "artist":null,
            "key":null,
            "bpm":120,
            "timeSignature":"4/4",
            "durationSeconds":60,
            "tempoMarkers":[],
            "timeSignatureMarkers":[],
            "regions":[{"id":"region_1","name":"Legacy","startSeconds":0,"endSeconds":60}],
            "tracks":[{"id":"track_1","name":"Track","kind":"audio","parentTrackId":null,"volume":1,"pan":0,"muted":false,"solo":false,"audioTo":"master"}],
            "clips":[],
            "sectionMarkers":[]
        }"#;

        let song: Song = serde_json::from_str(json).expect("song should deserialize");

        assert_eq!(song.regions[0].transpose_semitones, 0);
        assert!(song.tracks[0].transpose_enabled);
    }

    #[test]
    fn validates_region_transpose_range() {
        let mut song = valid_song();
        song.regions[0].transpose_semitones = MIN_TRANSPOSE_SEMITONES;
        assert!(validate_song(&song).is_ok());

        song.regions[0].transpose_semitones = MAX_TRANSPOSE_SEMITONES;
        assert!(validate_song(&song).is_ok());

        song.regions[0].transpose_semitones = MIN_TRANSPOSE_SEMITONES - 1;
        let error = validate_song(&song).expect_err("song should be invalid");
        assert!(error.to_string().contains("invalid transpose semitones"));

        song.regions[0].transpose_semitones = MAX_TRANSPOSE_SEMITONES + 1;
        let error = validate_song(&song).expect_err("song should be invalid");
        assert!(error.to_string().contains("invalid transpose semitones"));
    }

    #[test]
    fn rejects_duplicate_marker_digits() {
        let mut song = valid_song();
        song.section_markers.push(Marker {
            id: "section_verse".into(),
            name: "Verse".into(),
            start_seconds: 32.0,
            digit: Some(1),
            kind: MarkerKind::Custom,
            variant: None,
            color: None,
        });

        let error = validate_song(&song).expect_err("song should be invalid");
        assert!(error.to_string().contains("duplicated"));
    }

    #[test]
    fn allows_section_markers_beyond_song_duration() {
        let mut song = valid_song();
        song.section_markers.push(Marker {
            id: "section_outro".into(),
            name: "Outro".into(),
            start_seconds: 360.0,
            digit: Some(2),
            kind: MarkerKind::Custom,
            variant: None,
            color: None,
        });

        assert!(validate_song(&song).is_ok());
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
                kind: MarkerKind::Custom,
                variant: None,
                color: None,
            },
            Marker {
                id: "section_outro".into(),
                name: "Outro".into(),
                start_seconds: 48.0,
                digit: Some(3),
                kind: MarkerKind::Custom,
                variant: None,
                color: None,
            },
        ];

        let marker = song
            .marker_at(52.0)
            .expect("marker should resolve at position");

        assert_eq!(marker.id, "section_outro");
        assert_eq!(marker.name, "Outro");
    }

    #[test]
    fn resolves_the_current_marker_beyond_song_duration() {
        let mut song = valid_song();
        song.duration_seconds = 8.0;
        song.section_markers = vec![
            Marker {
                id: "section_verse".into(),
                name: "Verse".into(),
                start_seconds: 4.0,
                digit: Some(2),
                kind: MarkerKind::Custom,
                variant: None,
                color: None,
            },
            Marker {
                id: "section_outro".into(),
                name: "Outro".into(),
                start_seconds: 12.0,
                digit: Some(3),
                kind: MarkerKind::Custom,
                variant: None,
                color: None,
            },
        ];

        let marker = song
            .marker_at(13.0)
            .expect("marker should resolve beyond song duration");

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
            kind: MarkerKind::Custom,
            variant: None,
            color: None,
        });

        assert_eq!(song.next_marker_name(), "Marker 2");
    }
}
