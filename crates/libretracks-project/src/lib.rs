//! Persistencia y operaciones de proyecto.

mod importer;
mod song_store;
mod waveform;

pub use importer::{
    append_wav_files_to_song, import_wav_song, read_wav_metadata, ImportedAudioFile, ImportedSong,
    ProjectImportRequest, WavMetadata,
};
pub use song_store::{
    create_song_folder, load_song, save_song, song_file_path, ProjectError, SONG_FILE_NAME,
};
pub use waveform::{
    generate_waveform_summary, load_waveform_summary, waveform_file_path, WaveformSummary,
};

#[cfg(test)]
mod tests {
    use std::{fs, path::Path};

    use hound::{SampleFormat, WavSpec, WavWriter};
    use libretracks_core::{Clip, OutputBus, Section, Song, Track, TrackKind};
    use tempfile::tempdir;

    use crate::{
        append_wav_files_to_song, create_song_folder, import_wav_song, load_song,
        load_waveform_summary, read_wav_metadata, save_song, song_file_path, waveform_file_path,
        ProjectError, ProjectImportRequest,
    };

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
        assert!(json.contains("\"version\": 2"));
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

    fn write_test_wav(
        path: &Path,
        sample_rate: u32,
        channels: u16,
        duration_seconds: u32,
    ) {
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
                writer.write_sample(0_i16).expect("sample should be written");
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
            bpm: 120.0,
            key: None,
            time_signature: "4/4".into(),
            wav_files: vec![drums_path.clone(), bass_path.clone()],
        };

        let imported = import_wav_song(root.path(), "import-demo", &request)
            .expect("wav import should succeed");

        assert_eq!(imported.song.title, "Import Demo");
        assert_eq!(imported.song.tracks.len(), 2);
        assert_eq!(imported.song.clips.len(), 2);
        assert!(imported.song.sections.is_empty());
        assert!((imported.song.duration_seconds - 3.0).abs() < 0.001);
        assert!(imported.song_dir.join("audio").join("drums.wav").exists());
        assert!(imported.song_dir.join("audio").join("bass.wav").exists());
        assert!(waveform_file_path(&imported.song_dir, "audio/drums.wav").exists());

        let loaded = load_song(&imported.song_dir).expect("imported song should load");
        assert_eq!(loaded.tracks.len(), 2);
        assert_eq!(loaded.clips[0].timeline_start_seconds, 0.0);

        let waveform =
            load_waveform_summary(&imported.song_dir, "audio/drums.wav").expect("waveform should load");
        assert_eq!(waveform.bucket_count, waveform.peaks.len());
        assert_eq!(waveform.bucket_count, waveform.min_peaks.len());
        assert_eq!(waveform.bucket_count, waveform.max_peaks.len());
        assert!(waveform.bucket_count >= 2048);
        assert!(waveform.duration_seconds > 0.0);
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
            bpm: 100.0,
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
        let song_dir = create_song_folder(root.path(), "append-demo").expect("song dir should exist");
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

        assert_eq!(appended_song.tracks.len(), 2);
        assert_eq!(appended_song.clips.len(), 2);
        assert!(appended_song.tracks.iter().any(|track| track.id == "track_click"));
        assert!(appended_song
            .tracks
            .iter()
            .any(|track| track.id == "track_click-1" && track.name == "Click 1"));
        assert!(appended_song
            .clips
            .iter()
            .any(|clip| clip.track_id == "track_click-1" && clip.file_path == "audio/click-1.wav"));
        assert!(song_dir.join("audio").join("click.wav").exists());
        assert!(song_dir.join("audio").join("click-1.wav").exists());
        assert!(waveform_file_path(&song_dir, "audio/click-1.wav").exists());
        assert!((appended_song.duration_seconds - 4.0).abs() < 0.001);
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
}
