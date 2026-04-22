//! Persistencia y operaciones de proyecto.

mod importer;
mod song_store;
mod waveform;

pub use importer::{
    append_wav_files_to_song, import_wav_song, read_wav_metadata, AppendWavFilesResult,
    ImportOperationMetrics, ImportedAudioFile, ImportedSong, ProjectImportRequest, WavMetadata,
};
pub use song_store::{
    create_song_folder, load_song, load_song_from_file, save_song, save_song_to_file,
    song_file_path, ProjectError, SONG_FILE_NAME,
};
pub use waveform::{
    analyze_wav_file, generate_waveform_summary, load_waveform_summary, waveform_file_path,
    waveform_file_path_for_source, write_waveform_summary, AnalyzedWav, TempoCandidate,
    WaveformSummary,
};

#[cfg(test)]
mod tests {
    use std::{fs, path::Path};

    use hound::{SampleFormat, WavSpec, WavWriter};
    use libretracks_core::{
        Clip, Marker, OutputBus, Song, TempoMetadata, TempoSource, Track, TrackKind,
    };
    use tempfile::tempdir;

    use crate::{
        analyze_wav_file, append_wav_files_to_song, create_song_folder, import_wav_song, load_song,
        load_waveform_summary, read_wav_metadata, save_song, song_file_path, waveform_file_path,
        ProjectError, ProjectImportRequest,
    };

    fn demo_song() -> Song {
        Song {
            id: "song_001".into(),
            title: "Digno y Santo".into(),
            artist: Some("Ejemplo".into()),
            bpm: 72.0,
            tempo_metadata: TempoMetadata {
                source: TempoSource::Manual,
                confidence: None,
                reference_file_path: None,
            },
            key: Some("D".into()),
            time_signature: "4/4".into(),
            duration_seconds: 240.0,
            tracks: vec![Track {
                id: "track_click".into(),
                name: "Click".into(),
                kind: TrackKind::Audio,
                parent_track_id: None,
                volume: 1.0,
                pan: 0.0,
                muted: false,
                solo: false,
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
            section_markers: vec![Marker {
                id: "section_intro".into(),
                name: "Intro".into(),
                start_seconds: 0.0,
                digit: Some(1),
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
        assert!(json.contains("\"version\": 3"));
        assert!(json.contains("\"timeSignature\""));
        assert!(json.contains("\"timelineStartSeconds\""));
        assert!(json.contains("\"sectionMarkers\""));
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

    fn write_test_wav(path: &Path, sample_rate: u32, channels: u16, duration_seconds: u32) {
        let spec = WavSpec {
            channels,
            sample_rate,
            bits_per_sample: 16,
            sample_format: SampleFormat::Int,
        };

        let mut writer = WavWriter::create(path, spec).expect("wav should be created");
        let total_frames = sample_rate * duration_seconds;

        for _ in 0..total_frames {
            for _ in 0..channels {
                writer
                    .write_sample(0_i16)
                    .expect("sample should be written");
            }
        }

        writer.finalize().expect("wav should finalize");
    }

    fn write_float_test_wav(path: &Path, sample_rate: u32, channels: u16, duration_seconds: u32) {
        let spec = WavSpec {
            channels,
            sample_rate,
            bits_per_sample: 32,
            sample_format: SampleFormat::Float,
        };

        let mut writer = WavWriter::create(path, spec).expect("wav should be created");
        let total_frames = sample_rate * duration_seconds;

        for frame in 0..total_frames {
            let sample = if frame % 2 == 0 { 0.5_f32 } else { -0.25_f32 };
            for _ in 0..channels {
                writer
                    .write_sample(sample)
                    .expect("sample should be written");
            }
        }

        writer.finalize().expect("wav should finalize");
    }

    fn write_click_test_wav(
        path: &Path,
        sample_rate: u32,
        channels: u16,
        duration_seconds: u32,
        bpm: f64,
    ) {
        let spec = WavSpec {
            channels,
            sample_rate,
            bits_per_sample: 16,
            sample_format: SampleFormat::Int,
        };

        let mut writer = WavWriter::create(path, spec).expect("wav should be created");
        let total_frames = sample_rate * duration_seconds;
        let frames_per_beat = ((f64::from(sample_rate) * 60.0) / bpm).round() as u32;
        let click_frames = (sample_rate / 80).max(1);

        for frame in 0..total_frames {
            let sample = if frame % frames_per_beat < click_frames {
                i16::MAX / 2
            } else {
                0_i16
            };
            for _ in 0..channels {
                writer
                    .write_sample(sample)
                    .expect("sample should be written");
            }
        }

        writer.finalize().expect("wav should finalize");
    }

    #[test]
    fn reads_wav_metadata_and_duration() {
        let root = tempdir().expect("temp dir should exist");
        let wav_path = root.path().join("drums.wav");
        write_test_wav(&wav_path, 48_000, 2, 2);

        let metadata = read_wav_metadata(&wav_path).expect("metadata should be readable");

        assert_eq!(metadata.channels, 2);
        assert_eq!(metadata.sample_rate, 48_000);
        assert!((metadata.duration_seconds - 2.0).abs() < 0.001);
    }

    #[test]
    fn analyzes_click_track_and_estimates_tempo() {
        let root = tempdir().expect("temp dir should exist");
        let wav_path = root.path().join("click.wav");
        write_click_test_wav(&wav_path, 44_100, 1, 8, 120.0);

        let analysis = analyze_wav_file(&wav_path).expect("analysis should succeed");
        let tempo_candidate = analysis
            .tempo_candidate
            .expect("tempo candidate should be detected");

        assert!((tempo_candidate.bpm - 120.0).abs() < 2.0);
        assert!(tempo_candidate.confidence > 0.1);
    }

    #[test]
    fn analyzes_click_track_and_snaps_near_integer_bpm() {
        let root = tempdir().expect("temp dir should exist");
        let wav_path = root.path().join("click-91.wav");
        write_click_test_wav(&wav_path, 44_100, 1, 12, 91.0);

        let analysis = analyze_wav_file(&wav_path).expect("analysis should succeed");
        let tempo_candidate = analysis
            .tempo_candidate
            .expect("tempo candidate should be detected");

        assert_eq!(tempo_candidate.bpm, 91.0);
        assert!(tempo_candidate.confidence > 0.1);
    }

    #[test]
    fn imports_wav_files_and_creates_song_structure() {
        let root = tempdir().expect("temp dir should exist");
        let imports_dir = root.path().join("imports");
        fs::create_dir_all(&imports_dir).expect("imports dir should exist");

        let drums_path = imports_dir.join("drums.wav");
        let bass_path = imports_dir.join("bass.wav");
        write_test_wav(&drums_path, 44_100, 2, 3);
        write_test_wav(&bass_path, 44_100, 1, 2);

        let request = ProjectImportRequest {
            song_id: "song_002".into(),
            title: "Import Demo".into(),
            artist: Some("LibreTracks".into()),
            bpm: Some(120.0),
            key: None,
            time_signature: "4/4".into(),
            wav_files: vec![drums_path.clone(), bass_path.clone()],
        };

        let imported = import_wav_song(root.path(), "import-demo", &request)
            .expect("wav import should succeed");

        assert_eq!(imported.song.title, "Import Demo");
        assert_eq!(imported.song.tracks.len(), 2);
        assert_eq!(imported.song.clips.len(), 2);
        assert!(imported.song.section_markers.is_empty());
        assert!((imported.song.duration_seconds - 3.0).abs() < 0.001);
        assert!(imported.song_dir.join("audio").join("drums.wav").exists());
        assert!(imported.song_dir.join("audio").join("bass.wav").exists());
        assert!(waveform_file_path(&imported.song_dir, "audio/drums.wav").exists());

        let loaded = load_song(&imported.song_dir).expect("imported song should load");
        assert_eq!(loaded.tracks.len(), 2);
        assert_eq!(loaded.clips[0].timeline_start_seconds, 0.0);

        let waveform = load_waveform_summary(&imported.song_dir, "audio/drums.wav")
            .expect("waveform should load");
        assert_eq!(waveform.bucket_count, waveform.peaks.len());
        assert_eq!(waveform.bucket_count, waveform.min_peaks.len());
        assert_eq!(waveform.bucket_count, waveform.max_peaks.len());
        assert!(waveform.bucket_count >= 2048);
        assert!(waveform.duration_seconds > 0.0);
    }

    #[test]
    fn imports_detected_tempo_and_prioritizes_click_like_file_names() {
        let root = tempdir().expect("temp dir should exist");
        let imports_dir = root.path().join("imports");
        fs::create_dir_all(&imports_dir).expect("imports dir should exist");

        let click_path = imports_dir.join("guide-click.wav");
        let drums_path = imports_dir.join("drums.wav");
        write_click_test_wav(&click_path, 44_100, 1, 8, 120.0);
        write_click_test_wav(&drums_path, 44_100, 1, 8, 90.0);

        let request = ProjectImportRequest {
            song_id: "song_004".into(),
            title: "Detected Tempo Demo".into(),
            artist: None,
            bpm: None,
            key: None,
            time_signature: "4/4".into(),
            wav_files: vec![drums_path, click_path],
        };

        let imported = import_wav_song(root.path(), "detected-tempo-demo", &request)
            .expect("import should work");

        assert!((imported.song.bpm - 120.0).abs() < 2.0);
        assert_eq!(imported.song.tempo_metadata.source, TempoSource::AutoImport);
        assert_eq!(
            imported.song.tempo_metadata.reference_file_path.as_deref(),
            Some("audio/guide-click.wav")
        );
        assert!(imported.song.tempo_metadata.confidence.unwrap_or_default() > 0.1);
    }

    #[test]
    fn analyzes_float_stereo_wav_without_buffering_the_full_file_shape() {
        let root = tempdir().expect("temp dir should exist");
        let wav_path = root.path().join("pads.wav");
        write_float_test_wav(&wav_path, 48_000, 2, 2);

        let analysis = analyze_wav_file(&wav_path).expect("analysis should succeed");

        assert_eq!(analysis.channels, 2);
        assert_eq!(analysis.sample_rate, 48_000);
        assert!((analysis.duration_seconds - 2.0).abs() < 0.001);
        assert_eq!(
            analysis.waveform.bucket_count,
            analysis.waveform.max_peaks.len()
        );
        assert_eq!(
            analysis.waveform.bucket_count,
            analysis.waveform.min_peaks.len()
        );
    }

    #[test]
    fn load_waveform_summary_rejects_invalid_cache_instead_of_regenerating_inside_the_reader() {
        let root = tempdir().expect("temp dir should exist");
        let song_dir = create_song_folder(root.path(), "invalid-waveform-cache")
            .expect("song dir should exist");
        let wav_path = song_dir.join("audio").join("click.wav");
        write_test_wav(&wav_path, 44_100, 2, 1);

        fs::write(
            waveform_file_path(&song_dir, "audio/click.wav"),
            r#"{"version":1,"durationSeconds":0.0,"bucketCount":0,"peaks":[],"minPeaks":[],"maxPeaks":[]}"#,
        )
        .expect("invalid waveform should be written");

        let error = load_waveform_summary(&song_dir, "audio/click.wav")
            .expect_err("invalid waveform should fail");
        assert!(matches!(error, ProjectError::InvalidWaveformSummary(_)));
    }

    #[test]
    fn rejects_non_wav_imports() {
        let root = tempdir().expect("temp dir should exist");
        let text_path = root.path().join("notes.txt");
        fs::write(&text_path, "not audio").expect("fixture should be written");

        let request = ProjectImportRequest {
            song_id: "song_003".into(),
            title: "Bad Import".into(),
            artist: None,
            bpm: Some(100.0),
            key: None,
            time_signature: "4/4".into(),
            wav_files: vec![text_path],
        };

        let error =
            import_wav_song(root.path(), "bad-import", &request).expect_err("import should fail");

        match error {
            ProjectError::UnsupportedAudioFormat { .. } => {}
            other => panic!("unexpected error: {other}"),
        }
    }

    #[test]
    fn appends_wav_files_without_replacing_existing_tracks() {
        let root = tempdir().expect("temp dir should exist");
        let song_dir =
            create_song_folder(root.path(), "append-demo").expect("song dir should exist");
        let existing_audio_path = song_dir.join("audio").join("click.wav");
        write_test_wav(&existing_audio_path, 44_100, 2, 2);

        let mut song = demo_song();
        song.duration_seconds = 4.0;
        save_song(&song_dir, &song).expect("song should save");

        let imports_dir = root.path().join("imports");
        fs::create_dir_all(&imports_dir).expect("imports dir should exist");
        let duplicate_click_path = imports_dir.join("click.wav");
        write_test_wav(&duplicate_click_path, 44_100, 2, 3);

        let appended_song = append_wav_files_to_song(&song_dir, &song, &[duplicate_click_path])
            .expect("append should succeed");

        assert_eq!(appended_song.song.tracks.len(), 2);
        assert_eq!(appended_song.song.clips.len(), 2);
        assert!(appended_song
            .song
            .tracks
            .iter()
            .any(|track| track.id == "track_click"));
        assert!(appended_song
            .song
            .tracks
            .iter()
            .any(|track| track.id == "track_click-1" && track.name == "Click 1"));
        assert!(appended_song
            .song
            .clips
            .iter()
            .any(|clip| clip.track_id == "track_click-1" && clip.file_path == "audio/click-1.wav"));
        assert!(song_dir.join("audio").join("click.wav").exists());
        assert!(song_dir.join("audio").join("click-1.wav").exists());
        assert!(waveform_file_path(&song_dir, "audio/click-1.wav").exists());
        assert!((appended_song.song.duration_seconds - 4.0).abs() < 0.001);
    }

    #[test]
    fn rejects_legacy_group_projects_with_a_clear_error() {
        let root = tempdir().expect("temp dir should exist");
        let song_dir =
            create_song_folder(root.path(), "legacy-groups").expect("folder should be created");

        fs::write(
            song_file_path(&song_dir),
            r#"{
  "version": 1,
  "id": "legacy",
  "title": "Legacy Song",
  "artist": null,
  "bpm": 120.0,
  "key": null,
  "timeSignature": "4/4",
  "durationSeconds": 10.0,
  "tracks": [
    {
      "id": "track_1",
      "name": "Track 1",
      "groupId": "group_1",
      "volume": 1.0,
      "pan": 0.0,
      "muted": false,
      "solo": false,
      "outputBusId": "main"
    }
  ],
  "groups": [
    {
      "id": "group_1",
      "name": "Old Group",
      "volume": 1.0,
      "muted": false,
      "outputBusId": "main"
    }
  ],
  "clips": [],
  "sections": []
}"#,
        )
        .expect("legacy song should be written");

        let error = load_song(&song_dir).expect_err("legacy song should be rejected");
        assert!(matches!(error, ProjectError::LegacyGroupFormatUnsupported));
    }

    #[test]
    fn migrates_v2_sections_to_v3_markers_on_load() {
        let root = tempdir().expect("temp dir should exist");
        let song_dir =
            create_song_folder(root.path(), "migrate-v2").expect("folder should be created");

        fs::write(
            song_file_path(&song_dir),
            r#"{
  "version": 2,
  "id": "legacy-song",
  "title": "Legacy Song",
  "artist": null,
  "bpm": 98.0,
  "key": null,
  "timeSignature": "4/4",
  "durationSeconds": 90.0,
  "tracks": [],
  "clips": [],
  "sections": [
    {
      "id": "section_verse",
      "name": "Verse",
      "startSeconds": 32.0,
      "endSeconds": 48.0
    },
    {
      "id": "section_intro",
      "name": "Intro",
      "startSeconds": 8.0,
      "endSeconds": 16.0
    }
  ]
}"#,
        )
        .expect("legacy song should be written");

        let migrated = load_song(&song_dir).expect("legacy song should migrate");

        assert_eq!(migrated.section_markers.len(), 2);
        assert_eq!(migrated.section_markers[0].id, "section_intro");
        assert_eq!(migrated.section_markers[0].start_seconds, 8.0);
        assert_eq!(migrated.section_markers[0].digit, None);
        assert_eq!(migrated.section_markers[1].id, "section_verse");
        assert_eq!(migrated.tempo_metadata.source, TempoSource::Manual);
    }
}
