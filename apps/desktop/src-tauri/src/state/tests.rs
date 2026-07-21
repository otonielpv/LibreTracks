use std::{fs, path::Path, thread, time::Duration};

use libretracks_audio::{JumpTrigger, PlaybackState, TransitionType};
use libretracks_core::{
    source_seconds_at_view, validate_song, warp_timeline_seconds_at, Clip, Marker, MarkerKind,
    Song, SongRegion, TempoMarker, Track, TrackKind,
};
use libretracks_project::{
    create_song_folder, export_region_as_package, generate_waveform_summary, load_song, save_song,
    save_song_to_file,
    SONG_FILE_NAME,
};
use tempfile::tempdir;

use crate::automation::AutomationDocument;
use crate::models::view::{musical_position_summary, song_to_view};
use crate::models::LibraryAssetSummary;

use super::{
    build_empty_song, list_library_assets, next_downbeat_after_in_view_timeline,
    place_bundled_audio_and_repoint, realign_regions_after_warp_tempo_change,
    reconcile_regions_and_clips, write_library_manifest, write_library_manifest_assets,
    AudioFileImportPayload, AudioFilePathImportPayload, ClipMoveRequest,
    CreateAudioTrackWithClipRequest, CreateClipRequest, DesktopSession, TransportClock,
    WaveformMemoryCache,
};

fn demo_song() -> Song {
    Song {
        id: "song_move".into(),
        title: "Move Demo".into(),
        artist: None,
        key: None,
        bpm: 120.0,
        time_signature: "4/4".into(),
        duration_seconds: 12.0,
        tempo_markers: vec![],
        time_signature_markers: vec![],
        regions: vec![SongRegion {
            id: "region_1".into(),
            name: "Move Demo".into(),
            start_seconds: 0.0,
            end_seconds: 12.0,
            transpose_semitones: 0,
            warp_enabled: false,
            warp_source_bpm: None,
            key: None,
            master: libretracks_core::SongMaster::default(),
        }],
        tracks: vec![Track {
            id: "track_1".into(),
            name: "Track 1".into(),
            kind: TrackKind::Audio,
            parent_track_id: None,
            volume: 1.0,
            pan: 0.0,
            muted: false,
            solo: false,
            transpose_enabled: true,
            audio_to: "master".to_string(),
            color: None,
            auto_created: false,
        }],
        clips: vec![Clip {
            id: "clip_1".into(),
            track_id: "track_1".into(),
            file_path: "audio/test.wav".into(),
            timeline_start_seconds: 1.0,
            source_start_seconds: 0.0,
            duration_seconds: 4.0,
            gain: 1.0,
            fade_in_seconds: None,
            fade_out_seconds: None,
            color: None,
        }],
        section_markers: vec![],
    }
}

fn demo_song_with_section() -> Song {
    let mut song = demo_song();
    song.section_markers.push(Marker {
        id: "section_1".into(),
        name: "Intro".into(),
        start_seconds: 1.0,
        digit: Some(1),
        kind: MarkerKind::Custom,
        variant: None,
        color: None,
    });
    song
}

fn demo_song_with_varispeed_region() -> Song {
    let mut song = demo_song();
    song.duration_seconds = 24.0;
    song.regions = vec![SongRegion {
        id: "region_varispeed".into(),
        name: "Varispeed".into(),
        start_seconds: 5.0,
        end_seconds: 20.0,
        transpose_semitones: 3,
        warp_enabled: false,
        warp_source_bpm: None,
        key: None,
        master: libretracks_core::SongMaster::default(),
    }];
    // Keep the clip inside the varispeed region ([5, 20]) so the song
    // satisfies the clip-inside-region invariant.
    song.clips[0].timeline_start_seconds = 5.0;
    song.clips[0].duration_seconds = 15.0;
    song
}

#[test]
fn musical_position_summary_uses_time_signature_beat_unit() {
    let mut song = demo_song();
    song.time_signature = "6/8".into();
    song.bpm = 120.0;

    let summary = musical_position_summary(&song, 0.25);

    assert_eq!(summary.bar_number, 1);
    assert_eq!(summary.beat_in_bar, 2);
    assert_eq!(summary.display, "1.2.00");
}

#[test]
fn musical_position_summary_remains_stable_for_long_positions() {
    let song = demo_song();

    let summary = musical_position_summary(&song, 3600.125);

    assert_eq!(summary.bar_number, 1801);
    assert_eq!(summary.beat_in_bar, 1);
    assert_eq!(summary.sub_beat, 25);
    assert_eq!(summary.display, "1801.1.25");
}

#[test]
fn musical_position_summary_uses_tempo_markers_beyond_song_duration() {
    let mut song = demo_song();
    song.duration_seconds = 8.0;
    song.bpm = 120.0;
    song.tempo_markers = vec![TempoMarker {
        id: "tempo_far".into(),
        start_seconds: 12.0,
        bpm: 60.0,
    }];

    let summary = musical_position_summary(&song, 13.0);

    assert_eq!(summary.bar_number, 7);
    assert_eq!(summary.beat_in_bar, 2);
    assert_eq!(summary.sub_beat, 0);
    assert_eq!(summary.display, "7.2.00");
}

fn demo_song_with_two_sections() -> Song {
    let mut song = demo_song_with_section();
    song.section_markers.push(Marker {
        id: "section_2".into(),
        name: "Verse".into(),
        start_seconds: 4.0,
        digit: Some(2),
        kind: MarkerKind::Custom,
        variant: None,
        color: None,
    });
    song
}

fn demo_song_with_three_sections() -> Song {
    let mut song = demo_song_with_two_sections();
    song.section_markers.push(Marker {
        id: "section_3".into(),
        name: "Bridge".into(),
        start_seconds: 8.0,
        digit: Some(3),
        kind: MarkerKind::Custom,
        variant: None,
        color: None,
    });
    song
}

fn demo_song_with_region_changes_and_sections() -> Song {
    let mut song = demo_song();
    song.duration_seconds = 18.0;
    song.regions = vec![
        SongRegion {
            id: "region_1".into(),
            name: "Intro".into(),
            start_seconds: 0.0,
            end_seconds: 8.0,
            transpose_semitones: 0,
            warp_enabled: false,
            warp_source_bpm: None,
            key: None,
            master: libretracks_core::SongMaster::default(),
        },
        SongRegion {
            id: "region_2".into(),
            name: "Bridge".into(),
            start_seconds: 8.0,
            end_seconds: 14.0,
            transpose_semitones: 0,
            warp_enabled: false,
            warp_source_bpm: None,
            key: None,
            master: libretracks_core::SongMaster::default(),
        },
        SongRegion {
            id: "region_3".into(),
            name: "Outro".into(),
            start_seconds: 14.0,
            end_seconds: 18.0,
            transpose_semitones: 0,
            warp_enabled: false,
            warp_source_bpm: None,
            key: None,
            master: libretracks_core::SongMaster::default(),
        },
    ];
    // Keep the clip inside region_1 ([0, 8]) — and small enough that it
    // still fits after the reflow test shrinks region_1 to [0, 6] — so the
    // song satisfies the clip-inside-region invariant. These tests exercise
    // region/marker geometry and jumps, not the clip itself.
    song.clips[0].timeline_start_seconds = 1.0;
    song.clips[0].duration_seconds = 4.0;
    song.section_markers = vec![
        Marker {
            id: "section_1".into(),
            name: "Intro".into(),
            start_seconds: 1.0,
            digit: Some(1),
            kind: MarkerKind::Custom,
            variant: None,
            color: None,
        },
        Marker {
            id: "section_2".into(),
            name: "Outro".into(),
            start_seconds: 15.0,
            digit: Some(2),
            kind: MarkerKind::Custom,
            variant: None,
            color: None,
        },
    ];
    song
}

fn demo_song_with_folder_track() -> Song {
    let mut song = demo_song();
    song.tracks.insert(
        0,
        Track {
            id: "folder_1".into(),
            name: "Folder".into(),
            kind: TrackKind::Folder,
            parent_track_id: None,
            volume: 1.0,
            pan: 0.0,
            muted: false,
            solo: false,
            transpose_enabled: false,
            audio_to: "master".to_string(),
            color: None,
            auto_created: false,
        },
    );
    // Make the audio track a child of the folder.
    if let Some(t) = song.tracks.iter_mut().find(|t| t.id == "track_1") {
        t.parent_track_id = Some("folder_1".into());
    }
    song
}

fn write_silent_test_wav(path: &Path, duration_seconds: u32) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("wav parent dir should exist");
    }
    let spec = hound::WavSpec {
        channels: 2,
        sample_rate: 44_100,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(path, spec).expect("wav should be created");
    for _ in 0..(44_100 * duration_seconds) {
        writer.write_sample(0_i16).expect("sample should write");
        writer.write_sample(0_i16).expect("sample should write");
    }
    writer.finalize().expect("wav should finalize");
}

fn session_with_song_dir(song_name: &str, song: Song) -> DesktopSession {
    let root = tempdir().expect("temp dir should exist");
    let root_path = root.keep();
    let song_dir = create_song_folder(&root_path, song_name).expect("song dir should exist");
    fs::create_dir_all(song_dir.join("audio")).expect("audio dir should exist");
    write_silent_test_wav(&song_dir.join("audio").join("test.wav"), 12);
    save_song(&song_dir, &song).expect("song should save");

    let mut session = DesktopSession::default();
    session.song_file_path = Some(song_dir.join(SONG_FILE_NAME));
    session.song_dir = Some(song_dir);
    session
        .engine
        .load_song(song)
        .expect("song should load into engine");
    session
}

fn hierarchy_song() -> Song {
    Song {
        id: "song_hierarchy".into(),
        title: "Hierarchy Demo".into(),
        artist: None,
        key: None,
        bpm: 120.0,
        time_signature: "4/4".into(),
        duration_seconds: 12.0,
        tempo_markers: vec![],
        time_signature_markers: vec![],
        regions: vec![SongRegion {
            id: "region_1".into(),
            name: "Hierarchy Demo".into(),
            start_seconds: 0.0,
            end_seconds: 12.0,
            transpose_semitones: 0,
            warp_enabled: false,
            warp_source_bpm: None,
            key: None,
            master: libretracks_core::SongMaster::default(),
        }],
        tracks: vec![
            Track {
                id: "track_folder_a".into(),
                name: "Folder A".into(),
                kind: TrackKind::Folder,
                parent_track_id: None,
                volume: 1.0,
                pan: 0.0,
                muted: false,
                solo: false,
                transpose_enabled: true,
                audio_to: "master".to_string(),
                color: None,
                auto_created: false,
            },
            Track {
                id: "track_child_a".into(),
                name: "Child A".into(),
                kind: TrackKind::Audio,
                parent_track_id: Some("track_folder_a".into()),
                volume: 1.0,
                pan: 0.0,
                muted: false,
                solo: false,
                transpose_enabled: true,
                audio_to: "master".to_string(),
                color: None,
                auto_created: false,
            },
            Track {
                id: "track_folder_b".into(),
                name: "Folder B".into(),
                kind: TrackKind::Folder,
                parent_track_id: None,
                volume: 1.0,
                pan: 0.0,
                muted: false,
                solo: false,
                transpose_enabled: true,
                audio_to: "master".to_string(),
                color: None,
                auto_created: false,
            },
            Track {
                id: "track_child_b".into(),
                name: "Child B".into(),
                kind: TrackKind::Audio,
                parent_track_id: Some("track_folder_b".into()),
                volume: 1.0,
                pan: 0.0,
                muted: false,
                solo: false,
                transpose_enabled: true,
                audio_to: "master".to_string(),
                color: None,
                auto_created: false,
            },
        ],
        clips: vec![],
        section_markers: vec![],
    }
}

#[test]
fn transport_clock_advances_only_while_running() {
    let mut clock = TransportClock::default();
    clock.start_from(1.25);

    thread::sleep(Duration::from_millis(20));
    let running_position = clock.current_position(PlaybackState::Playing);
    assert!(running_position > 1.25);

    clock.pause_at(running_position);
    thread::sleep(Duration::from_millis(20));

    let paused_position = clock.current_position(PlaybackState::Paused);
    assert!((paused_position - running_position).abs() < 0.02);
}

#[test]
fn transport_clock_seek_reanchors_without_accumulating_old_elapsed_time() {
    let mut clock = TransportClock::default();
    clock.start_from(0.5);

    thread::sleep(Duration::from_millis(12));
    let advanced_position = clock.current_position(PlaybackState::Playing);
    assert!(advanced_position > 0.5);

    clock.seek_to(3.0);
    thread::sleep(Duration::from_millis(12));

    let seek_position = clock.current_position(PlaybackState::Paused);
    assert!((seek_position - 3.0).abs() < 0.001);

    clock.start_from(seek_position);
    thread::sleep(Duration::from_millis(12));
    let resumed_position = clock.current_position(PlaybackState::Playing);
    assert!(resumed_position > 3.0);
    assert!(resumed_position < 3.2);
}

#[test]
fn snapshot_exposes_transport_clock_summary_after_immediate_jump() {
    let mut session = DesktopSession::default();
    session
        .engine
        .load_song(demo_song_with_section())
        .expect("song should load into engine");

    let audio = crate::audio_engine::AudioController::default();
    let snapshot = session
        .schedule_marker_jump(
            "section_1",
            JumpTrigger::Immediate,
            TransitionType::Instant,
            &audio,
        )
        .expect("immediate jump should execute");

    assert_eq!(snapshot.transport_clock.anchor_position_seconds, 1.0);
    assert_eq!(
        snapshot.transport_clock.last_seek_position_seconds,
        Some(1.0)
    );
    assert_eq!(snapshot.transport_clock.last_start_position_seconds, None);
    assert_eq!(snapshot.transport_clock.last_jump_position_seconds, None);
    assert!(!snapshot.transport_clock.running);
}

#[test]
fn extending_last_region_right_grows_the_song_duration() {
    // Bug: with a single region whose end sits at the song end, dragging the
    // right edge outward did nothing because the song duration capped it.
    // Extending the last region right is allowed and the song must grow to
    // envelop it (otherwise the engine validator rejects "Region outside
    // song"). Contents are NOT moved — only the named span grows.
    let mut session = session_with_song_dir("extend_region", demo_song());
    let audio = crate::audio_engine::AudioController::default();

    session
        .update_song_region("region_1", "Move Demo", 0.0, 30.0, &audio)
        .expect("extending the last region right should succeed");

    let song = session.engine.song().expect("song should be loaded");
    let region = song
        .regions
        .iter()
        .find(|region| region.id == "region_1")
        .expect("region should still exist");
    assert_eq!(region.end_seconds, 30.0);
    // The song duration grew to cover the extended region.
    assert_eq!(song.duration_seconds, 30.0);
    // The clip inside was untouched.
    let clip = &song.clips[0];
    assert_eq!(clip.timeline_start_seconds, 1.0);
    assert_eq!(clip.duration_seconds, 4.0);
}

#[test]
fn snapshot_exposes_transport_clock_summary_after_seek() {
    let mut session = DesktopSession::default();
    session
        .engine
        .load_song(demo_song())
        .expect("song should load into engine");

    let audio = crate::audio_engine::AudioController::default();
    let snapshot = session.seek(2.75, &audio).expect("seek should succeed");

    assert_eq!(snapshot.position_seconds, 2.75);
    assert_eq!(snapshot.transport_clock.anchor_position_seconds, 2.75);
    assert_eq!(
        snapshot.transport_clock.last_seek_position_seconds,
        Some(2.75)
    );
    assert_eq!(snapshot.transport_clock.last_start_position_seconds, None);
    assert_eq!(snapshot.transport_clock.last_jump_position_seconds, None);
    assert!(!snapshot.transport_clock.running);

    let drift = snapshot
        .last_drift_sample
        .expect("seek should capture drift sample");
    assert_eq!(drift.event, "seek");
    assert_eq!(drift.transport_position_seconds, 2.75);
    assert_eq!(drift.engine_position_seconds, 2.75);
    assert_eq!(drift.transport_minus_engine_seconds, 0.0);
}

#[test]
fn snapshot_reports_seek_position_in_view_seconds_for_varispeed_region() {
    let song = demo_song_with_varispeed_region();
    let expected_source_seconds = source_seconds_at_view(&song, 10.0);
    let mut session = DesktopSession::default();
    session
        .engine
        .load_song(song)
        .expect("song should load into engine");

    let audio = crate::audio_engine::AudioController::default();
    let snapshot = session.seek(10.0, &audio).expect("seek should succeed");

    assert!(
        (session.engine.position_seconds() - expected_source_seconds).abs() < 1e-9,
        "engine should seek source-time"
    );
    assert!(
        (snapshot.position_seconds - 10.0).abs() < 1e-9,
        "snapshot should report view-time"
    );
    assert!(
        (snapshot.transport_clock.anchor_position_seconds - 10.0).abs() < 1e-9,
        "transport clock anchor should report view-time"
    );
    assert!(
        (snapshot
            .transport_clock
            .last_seek_position_seconds
            .expect("seek anchor should be recorded")
            - 10.0)
            .abs()
            < 1e-9
    );
}

#[test]
fn scheduled_jump_snapshot_reports_execute_time_in_view_seconds_for_varispeed_region() {
    let mut song = demo_song_with_varispeed_region();
    song.section_markers.push(Marker {
        id: "section_target".into(),
        name: "Target".into(),
        start_seconds: 18.0,
        digit: Some(1),
        kind: MarkerKind::Custom,
        variant: None,
        color: None,
    });
    let expected_execute_seconds = warp_timeline_seconds_at(&song, 18.0);
    let mut session = DesktopSession::default();
    session
        .engine
        .load_song(song)
        .expect("song should load into engine");

    let audio = crate::audio_engine::AudioController::default();
    session.seek(10.0, &audio).expect("seek should succeed");
    let snapshot = session
        .schedule_marker_jump(
            "section_target",
            JumpTrigger::NextMarker,
            TransitionType::Instant,
            &audio,
        )
        .expect("jump should schedule");

    let pending = snapshot
        .pending_marker_jump
        .expect("pending jump should be exposed");
    assert!(
        (pending.execute_at_seconds - expected_execute_seconds).abs() < 1e-9,
        "snapshot pending execute time should be view-time"
    );
}

#[test]
fn transport_timeline_scales_bpm_inside_varispeed_region() {
    let mut song = demo_song_with_varispeed_region();
    song.bpm = 120.0;
    song.regions[0].transpose_semitones = -2;
    let runtime = super::song_with_warped_timeline_for_transport(&song);
    let scale = 2.0_f64.powf(-2.0 / 12.0);
    let start_marker = runtime
        .tempo_markers
        .iter()
        .find(|marker| marker.id == "region_varispeed_varispeed_start")
        .expect("varispeed start tempo marker should be injected");
    let end_marker = runtime
        .tempo_markers
        .iter()
        .find(|marker| marker.id == "region_varispeed_varispeed_end")
        .expect("varispeed end tempo marker should be injected");

    assert!((start_marker.start_seconds - 5.0).abs() < 1e-9);
    assert!((start_marker.bpm - 120.0 * scale).abs() < 1e-9);
    assert!((end_marker.bpm - 120.0).abs() < 1e-9);
    assert!(end_marker.start_seconds > song.regions[0].end_seconds);
}

#[test]
fn snapshot_after_playing_seek_keeps_visual_clock_running() {
    let mut session = DesktopSession::default();
    session
        .engine
        .load_song(demo_song())
        .expect("song should load into engine");
    session.engine.play().expect("engine should enter playback");
    session.engine.seek(3.5).expect("engine seek should work");
    session.transport_clock.seek_while_playing(3.5);

    let snapshot = session.snapshot();

    assert_eq!(snapshot.playback_state, "playing");
    assert!(snapshot.position_seconds >= 3.5);
    assert!(snapshot.position_seconds < 3.55);
    assert_eq!(snapshot.transport_clock.anchor_position_seconds, 3.5);
    assert_eq!(
        snapshot.transport_clock.last_seek_position_seconds,
        Some(3.5)
    );
    assert!(snapshot.transport_clock.running);
}

#[test]
fn pause_freezes_position_after_real_playback() {
    let mut session = session_with_song_dir("pause-freeze-demo", demo_song());
    let audio = crate::audio_engine::AudioController::default();

    let playing_snapshot = session.play(&audio).expect("play should succeed");
    assert_eq!(playing_snapshot.playback_state, "playing");

    let drift = playing_snapshot
        .last_drift_sample
        .expect("play should capture drift sample");
    assert_eq!(drift.event, "play");
    assert!(drift.runtime_running);
    assert!(drift.max_observed_delta_seconds < 0.05);

    thread::sleep(Duration::from_millis(35));

    let paused_snapshot = session.pause(&audio).expect("pause should succeed");
    let paused_position = paused_snapshot.position_seconds;

    assert_eq!(paused_snapshot.playback_state, "paused");
    assert!(paused_position > 0.0);
    assert!(!paused_snapshot.transport_clock.running);

    thread::sleep(Duration::from_millis(35));
    let frozen_snapshot = session
        .snapshot_with_sync(&audio)
        .expect("snapshot should keep paused position");

    assert_eq!(frozen_snapshot.playback_state, "paused");
    assert!((frozen_snapshot.position_seconds - paused_position).abs() < 0.01);
}

#[test]
fn play_does_not_synchronously_prepare_missing_audio() {
    let root = tempdir().expect("temp dir should exist");
    let root_path = root.keep();
    let song = demo_song();
    let song_dir =
        create_song_folder(&root_path, "async-play-demo").expect("song dir should exist");
    fs::create_dir_all(song_dir.join("audio")).expect("audio dir should exist");
    save_song(&song_dir, &song).expect("song should save");

    let mut session = DesktopSession::default();
    session.song_file_path = Some(song_dir.join(SONG_FILE_NAME));
    session.song_dir = Some(song_dir);
    session
        .engine
        .load_song(song)
        .expect("song should load into engine");
    let audio = crate::audio_engine::AudioController::default();

    let snapshot = session
        .play(&audio)
        .expect("play should not prepare inline");

    assert_eq!(snapshot.playback_state, "playing");
}

#[test]
// Needs the real engine's playhead estimate; the no-link stub reports a
// static snapshot. Runs under `npm run test:native`.
#[cfg_attr(feature = "no-link", ignore = "requires real engine output")]
fn repeated_seeks_while_playing_keep_latest_seek_anchor() {
    let mut session = session_with_song_dir("rapid-seek-demo", demo_song());
    let audio = crate::audio_engine::AudioController::default();

    session.play(&audio).expect("play should succeed");
    thread::sleep(Duration::from_millis(15));
    session
        .seek(2.0, &audio)
        .expect("first seek should succeed");
    let snapshot = session
        .seek(3.5, &audio)
        .expect("second seek should succeed");

    assert_eq!(snapshot.playback_state, "playing");
    assert!(snapshot.position_seconds >= 3.5);
    assert!(snapshot.position_seconds < 3.65);
    assert_eq!(
        snapshot.transport_clock.last_seek_position_seconds,
        Some(3.5)
    );
    assert!(snapshot.transport_clock.running);

    let debug_snapshot = audio
        .debug_snapshot()
        .expect("debug snapshot should succeed");
    assert!(debug_snapshot.command_count >= 4);
    assert_eq!(
        debug_snapshot.playhead.last_start_reason.as_deref(),
        Some("seek")
    );
    assert!(debug_snapshot.playhead.running);
    assert!(
        debug_snapshot
            .playhead
            .estimated_position_seconds
            .unwrap_or_default()
            >= 3.5
    );

    let drift = snapshot
        .last_drift_sample
        .expect("seek should capture drift sample while playing");
    assert_eq!(drift.event, "seek");
    assert!(drift.runtime_running);
    assert!(drift.runtime_estimated_position_seconds.unwrap_or_default() >= 3.5);
}

#[test]
fn move_track_supports_inserting_before_another_track() {
    let mut tracks = hierarchy_song().tracks;

    super::reparent_track(
        &mut tracks,
        "track_folder_b",
        None,
        Some("track_folder_a"),
        None,
    )
    .expect("folder should move before another folder");

    let ordered_ids = tracks
        .iter()
        .map(|track| track.id.as_str())
        .collect::<Vec<_>>();
    assert_eq!(
        ordered_ids,
        vec![
            "track_folder_b",
            "track_child_b",
            "track_folder_a",
            "track_child_a"
        ]
    );
}

#[test]
fn reparent_track_sets_inherit_route_when_entering_new_folder() {
    let mut tracks = hierarchy_song().tracks;
    let folder_b = tracks
        .iter_mut()
        .find(|track| track.id == "track_folder_b")
        .expect("folder should exist");
    folder_b.audio_to = "ext:2-3".to_string();

    super::reparent_track(
        &mut tracks,
        "track_folder_b",
        Some("track_child_a"),
        None,
        Some("track_folder_a"),
    )
    .expect("moving into a folder should succeed");

    let moved = tracks
        .iter()
        .find(|track| track.id == "track_folder_b")
        .expect("moved track should exist");
    assert_eq!(moved.parent_track_id.as_deref(), Some("track_folder_a"));
    assert_eq!(moved.audio_to, "inherit");
}

#[test]
fn reparent_track_keeps_manual_route_when_reordering_inside_same_folder() {
    let mut tracks = hierarchy_song().tracks;
    let child_a = tracks
        .iter_mut()
        .find(|track| track.id == "track_child_a")
        .expect("child should exist");
    child_a.audio_to = "ext:2-3".to_string();

    super::reparent_track(
        &mut tracks,
        "track_child_a",
        None,
        Some("track_child_b"),
        Some("track_folder_a"),
    )
    .expect("reordering inside same folder should succeed");

    let moved = tracks
        .iter()
        .find(|track| track.id == "track_child_a")
        .expect("moved track should exist");
    assert_eq!(moved.parent_track_id.as_deref(), Some("track_folder_a"));
    assert_eq!(moved.audio_to, "ext:2-3");
}

#[test]
fn song_to_view_preserves_track_ids_and_parent_ids_verbatim() {
    let song = Song {
        id: "song_ids".into(),
        title: "ID Audit".into(),
        artist: None,
        key: None,
        bpm: 120.0,
        time_signature: "4/4".into(),
        duration_seconds: 8.0,
        tempo_markers: vec![],
        time_signature_markers: vec![],
        regions: vec![SongRegion {
            id: "region_1".into(),
            name: "ID Audit".into(),
            start_seconds: 0.0,
            end_seconds: 8.0,
            transpose_semitones: 0,
            warp_enabled: false,
            warp_source_bpm: None,
            key: None,
            master: libretracks_core::SongMaster::default(),
        }],
        tracks: vec![
            Track {
                id: "folder_main".into(),
                name: "Folder".into(),
                kind: TrackKind::Folder,
                parent_track_id: None,
                volume: 1.0,
                pan: 0.0,
                muted: false,
                solo: false,
                transpose_enabled: true,
                audio_to: "master".to_string(),
                color: None,
                auto_created: false,
            },
            Track {
                id: "track-drums_01".into(),
                name: "Drums".into(),
                kind: TrackKind::Audio,
                parent_track_id: Some("folder_main".into()),
                volume: 1.0,
                pan: 0.0,
                muted: false,
                solo: false,
                transpose_enabled: true,
                audio_to: "master".to_string(),
                color: None,
                auto_created: false,
            },
        ],
        clips: vec![],
        section_markers: vec![],
    };

    let view = song_to_view(
        &song,
        &AutomationDocument::default(),
        &std::collections::HashMap::new(),
        &WaveformMemoryCache::default(),
        7,
        None,
        true,
    );

    assert_eq!(view.tracks[0].id, "folder_main");
    assert_eq!(view.tracks[0].parent_track_id, None);
    assert_eq!(view.tracks[1].id, "track-drums_01");
    assert_eq!(
        view.tracks[1].parent_track_id.as_deref(),
        Some("folder_main")
    );
}

#[test]
// Asserts on real playback drift; the no-link stub does not run audio.
// Runs under `npm run test:native`.
#[cfg_attr(feature = "no-link", ignore = "requires real engine output")]
fn executing_section_jump_reanchors_transport_and_runtime() {
    let mut session = session_with_song_dir("jump-resync-demo", demo_song_with_three_sections());
    let audio = crate::audio_engine::AudioController::default();

    session.seek(3.95, &audio).expect("seek should succeed");
    session.play(&audio).expect("play should succeed");
    session
        .schedule_marker_jump(
            "section_3",
            JumpTrigger::NextMarker,
            TransitionType::Instant,
            &audio,
        )
        .expect("jump should schedule");

    thread::sleep(Duration::from_millis(70));
    let snapshot = session
        .snapshot_with_sync(&audio)
        .expect("sync should execute jump");

    assert_eq!(snapshot.playback_state, "playing");
    assert!(snapshot.pending_marker_jump.is_none());
    assert!(snapshot.position_seconds >= 8.0);
    assert!(snapshot.position_seconds < 8.3);
    assert_eq!(
        snapshot
            .current_marker
            .expect("current marker should exist after jump")
            .name,
        "Bridge"
    );
    assert!(
        snapshot
            .transport_clock
            .last_jump_position_seconds
            .unwrap_or_default()
            >= 8.0
    );

    let drift = snapshot
        .last_drift_sample
        .expect("jump should capture drift sample");
    assert_eq!(drift.event, "jump");
    assert!(drift.runtime_running);
    assert!(drift.transport_position_seconds >= 8.0);
    assert!(drift.max_observed_delta_seconds < 0.1);

    let debug_snapshot = audio
        .debug_snapshot()
        .expect("debug snapshot should succeed");
    assert_eq!(
        debug_snapshot.playhead.last_start_reason.as_deref(),
        Some("transport_resync")
    );
}

#[test]
fn playback_continues_after_song_end_is_reached() {
    let mut session = session_with_song_dir("song-end-demo", demo_song());
    let audio = crate::audio_engine::AudioController::default();

    session.seek(11.98, &audio).expect("seek should succeed");
    session.play(&audio).expect("play should succeed");

    thread::sleep(Duration::from_millis(60));
    let snapshot = session
        .snapshot_with_sync(&audio)
        .expect("sync should keep transport running past song end");

    assert_eq!(snapshot.playback_state, "playing");
    assert!(snapshot.position_seconds > 12.0);
    assert!(snapshot.transport_clock.running);
    assert!(snapshot.transport_clock.anchor_position_seconds > 12.0);
    assert_eq!(
        snapshot
            .last_drift_sample
            .as_ref()
            .map(|drift| drift.event.as_str()),
        Some("play")
    );

    let debug_snapshot = audio
        .debug_snapshot()
        .expect("debug snapshot should succeed");
    assert!(debug_snapshot.playhead.running);
}

#[test]
fn moving_a_clip_stays_in_memory_until_save() {
    let root = tempdir().expect("temp dir should exist");
    let song_dir = create_song_folder(root.path(), "move-demo").expect("song dir should exist");
    fs::create_dir_all(song_dir.join("audio")).expect("audio dir should exist");
    save_song(&song_dir, &demo_song()).expect("song should save");

    let mut session = DesktopSession::default();
    session.song_dir = Some(song_dir.clone());
    session
        .engine
        .load_song(demo_song())
        .expect("song should load into engine");

    let audio = crate::audio_engine::AudioController::default();
    let snapshot = session
        .move_clip("clip_1", 6.5, &audio)
        .expect("clip should move");
    let song_view = session
        .song_view()
        .expect("song view should build")
        .expect("song view should exist");

    assert_eq!(snapshot.playback_state, "stopped");
    assert_eq!(
        song_view
            .clips
            .first()
            .expect("clip summary should exist")
            .timeline_start_seconds,
        6.5
    );

    let saved_song = load_song(&song_dir).expect("song json should load");
    assert_eq!(saved_song.clips[0].timeline_start_seconds, 1.0);
    assert_eq!(session.engine.playback_state(), PlaybackState::Stopped);
}

#[test]
fn batch_move_can_reassign_clip_to_another_track() {
    // Dragging a clip vertically onto another lane: the batch move
    // carries target_track_id, so position and track change together in
    // one operation. The origin track (auto_created) is then pruned
    // because it lost its only clip.
    let mut song = demo_song();
    song.tracks[0].auto_created = true;
    song.tracks.push(Track {
        id: "track_2".into(),
        name: "Track 2".into(),
        kind: TrackKind::Audio,
        parent_track_id: None,
        volume: 1.0,
        pan: 0.0,
        muted: false,
        solo: false,
        transpose_enabled: true,
        audio_to: "master".to_string(),
        color: None,
        auto_created: false,
    });
    let mut session = session_with_song_dir("batch-move-track", song);
    let audio = crate::audio_engine::AudioController::default();

    session
        .move_clips_batch(
            &[ClipMoveRequest {
                clip_id: "clip_1".into(),
                timeline_start_seconds: 3.0,
                target_track_id: Some("track_2".into()),
            }],
            &audio,
        )
        .expect("batch move with track change should succeed");

    let song_view = session
        .song_view()
        .expect("song view should build")
        .expect("song view should exist");
    let clip = song_view
        .clips
        .iter()
        .find(|clip| clip.id == "clip_1")
        .expect("clip should still exist");
    assert_eq!(clip.track_id, "track_2");
    assert_eq!(clip.timeline_start_seconds, 3.0);
    // Origin track was auto-created and is now empty → pruned.
    assert!(song_view.tracks.iter().all(|track| track.id != "track_1"));
}

#[test]
fn batch_move_rejects_folder_as_target_track() {
    let mut song = demo_song_with_folder_track();
    let folder_id = song
        .tracks
        .iter()
        .find(|track| track.kind == TrackKind::Folder)
        .expect("folder track should exist")
        .id
        .clone();
    let mut session = session_with_song_dir("batch-move-folder", song);
    let audio = crate::audio_engine::AudioController::default();

    let result = session.move_clips_batch(
        &[ClipMoveRequest {
            clip_id: "clip_1".into(),
            timeline_start_seconds: 1.0,
            target_track_id: Some(folder_id),
        }],
        &audio,
    );
    assert!(result.is_err(), "moving a clip onto a folder must fail");
}

#[test]
fn moving_a_clip_before_bar_one_clamps_to_the_timeline_start() {
    // The clip-inside-region invariant no longer allows a clip to start
    // before 0 (it would fall outside every region), so moving to a
    // negative position clamps the clip to the timeline start.
    let mut session = session_with_song_dir("negative-clip-start", demo_song());
    let audio = crate::audio_engine::AudioController::default();

    session
        .move_clip("clip_1", -1.5, &audio)
        .expect("clip should move");
    let song = session.engine.song().expect("song should remain loaded");

    assert_eq!(song.clips[0].timeline_start_seconds, 0.0);
}

#[test]
fn live_track_mix_updates_skip_disk_model_and_project_revision() {
    let mut session = session_with_song_dir("live-mix-demo", demo_song());
    let song_dir = session
        .song_dir
        .clone()
        .expect("song dir should exist for loaded session");
    save_song(&song_dir, &demo_song()).expect("seed song should save");

    let audio = crate::audio_engine::AudioController::default();
    let initial_revision = session.snapshot().project_revision;

    // Category A: bridge-only, no model mutation, no undo, no revision bump.
    audio
        .update_live_track_mix(
            "track_1",
            Some(0.61),
            Some(-0.22),
            Some(true),
            Some(true),
            None,
        )
        .expect("live mix update should succeed");

    let diagnostics = audio.realtime_control_diagnostics();
    assert_eq!(diagnostics.live_mix_realtime_command_count, 1);
    assert_eq!(diagnostics.session_rebuild_count, 0);
    assert_eq!(diagnostics.live_mix_ensure_live_track_count, 0);

    let updated_song = session
        .song_view()
        .expect("song view should build")
        .expect("song view should exist");
    let updated_track = updated_song
        .tracks
        .into_iter()
        .find(|track| track.id == "track_1")
        .expect("updated track should exist");

    // Rust model must NOT have changed — Category A is bridge-only.
    assert_eq!(session.snapshot().project_revision, initial_revision);
    assert_eq!(updated_track.volume, 1.0);
    assert_eq!(updated_track.pan, 0.0);
    assert!(!updated_track.muted);
    assert!(!updated_track.solo);

    let saved_song = load_song(&song_dir).expect("song json should load");
    let saved_track = saved_song
        .tracks
        .into_iter()
        .find(|track| track.id == "track_1")
        .expect("saved track should exist");
    assert_eq!(saved_track.volume, 1.0);
    assert_eq!(saved_track.pan, 0.0);
    assert!(!saved_track.muted);
    assert!(!saved_track.solo);
}

#[test]
fn realtime_slider_drag_does_not_sync_session() {
    let audio = crate::audio_engine::AudioController::default();

    for i in 0..200 {
        audio
            .update_live_track_mix("track_1", Some(i as f64 / 200.0), None, None, None, None)
            .expect("realtime gain update should send");
    }

    let diagnostics = audio.realtime_control_diagnostics();
    assert_eq!(diagnostics.live_mix_realtime_command_count, 200);
    assert_eq!(diagnostics.session_rebuild_count, 0);
    assert_eq!(diagnostics.live_mix_ensure_live_track_count, 0);
}

#[test]
fn realtime_pan_drag_does_not_rebuild_session() {
    let audio = crate::audio_engine::AudioController::default();

    for i in 0..200 {
        let pan = -1.0 + (i as f64 / 100.0);
        audio
            .update_live_track_mix("track_1", None, Some(pan), None, None, None)
            .expect("realtime pan update should send");
    }

    let diagnostics = audio.realtime_control_diagnostics();
    assert_eq!(diagnostics.live_mix_realtime_command_count, 200);
    assert_eq!(diagnostics.session_rebuild_count, 0);
    assert_eq!(diagnostics.live_mix_ensure_live_track_count, 0);
}

#[test]
fn metronome_realtime_commands_do_not_use_full_config_path() {
    let audio = crate::audio_engine::AudioController::default();

    for i in 0..20 {
        audio
            .set_metronome_enabled_realtime(i % 2 == 0)
            .expect("realtime metronome toggle should send");
    }
    audio
        .set_metronome_volume_realtime(0.42)
        .expect("realtime metronome volume should send");

    let diagnostics = audio.realtime_control_diagnostics();
    assert_eq!(diagnostics.metronome_realtime_toggle_count, 20);
    assert_eq!(diagnostics.metronome_realtime_volume_count, 1);
    assert_eq!(diagnostics.session_rebuild_count, 0);
    assert_eq!(diagnostics.live_mix_ensure_live_track_count, 0);
}

#[test]
fn live_track_mix_commit_undoes_in_single_step() {
    let mut session = session_with_song_dir("live-mix-undo-demo", demo_song());
    let audio = crate::audio_engine::AudioController::default();

    // Category A bridge: realtime command only, no model mutation, no undo entry.
    audio
        .update_live_track_mix(
            "track_1",
            Some(0.61),
            Some(-0.22),
            Some(true),
            Some(true),
            None,
        )
        .expect("live mix update should succeed");
    assert_eq!(session.undo_stack.len(), 0);

    session
        .commit_track_mix_model_and_command(
            "track_1",
            Some(0.61),
            Some(-0.22),
            Some(true),
            Some(true),
            None,
            &audio,
        )
        .expect("mix commit should succeed");
    assert_eq!(session.undo_stack.len(), 1);

    session.undo_action(&audio).expect("undo should succeed");
    let track = session
        .song_view()
        .expect("song view should build")
        .expect("song view should exist")
        .tracks
        .into_iter()
        .find(|track| track.id == "track_1")
        .expect("track should exist after undo");

    assert_eq!(track.volume, 1.0);
    assert_eq!(track.pan, 0.0);
    assert!(!track.muted);
    assert!(!track.solo);
}

#[test]
fn repeated_region_transpose_changes_group_into_one_undo_entry() {
    let mut session = session_with_song_dir("transpose-undo-demo", demo_song());
    let audio = crate::audio_engine::AudioController::default();

    session
        .update_song_region_transpose("region_1", 1, &audio)
        .expect("first transpose change should succeed");
    session
        .update_song_region_transpose("region_1", 2, &audio)
        .expect("second transpose change should succeed");

    assert_eq!(session.undo_stack.len(), 1);

    session.undo_action(&audio).expect("undo should succeed");
    let region = session
        .song_view()
        .expect("song view should build")
        .expect("song view should exist")
        .regions
        .into_iter()
        .find(|region| region.id == "region_1")
        .expect("region should exist after undo");

    assert_eq!(region.transpose_semitones, 0);
}

#[test]
fn live_clip_move_commit_undoes_in_single_step() {
    let mut session = session_with_song_dir("live-clip-move-demo", demo_song());
    let audio = crate::audio_engine::AudioController::default();
    let initial_revision = session.snapshot().project_revision;

    session
        .move_clip_live("clip_1", 3.0, &audio)
        .expect("first live move should succeed");
    session
        .move_clip_live("clip_1", 4.5, &audio)
        .expect("second live move should succeed");
    assert_eq!(session.snapshot().project_revision, initial_revision);
    assert_eq!(session.undo_stack.len(), 0);

    session
        .move_clip("clip_1", 6.0, &audio)
        .expect("clip commit should succeed");
    assert_eq!(session.undo_stack.len(), 1);

    session.undo_action(&audio).expect("undo should succeed");
    let clip = session
        .song_view()
        .expect("song view should build")
        .expect("song should exist")
        .clips
        .into_iter()
        .find(|clip| clip.id == "clip_1")
        .expect("clip should exist after undo");

    assert!((clip.timeline_start_seconds - 1.0).abs() < 0.0001);
}

#[test]
fn importing_wavs_into_a_loaded_song_appends_tracks_instead_of_replacing_them() {
    let mut session = session_with_song_dir("append-import-demo", demo_song());
    let song_dir = session
        .song_dir
        .clone()
        .expect("song dir should exist for loaded session");
    save_song(&song_dir, &demo_song()).expect("seed song should save");

    let imports_root = tempdir().expect("temp dir should exist");
    let imported_click = imports_root.path().join("click.wav");
    write_silent_test_wav(&imported_click, 6);

    let audio = crate::audio_engine::AudioController::default();
    let snapshot = session
        .import_audio_files_into_current_song(&[imported_click], &audio, |_, _| {})
        .expect("import should append tracks");
    let snapshot_song = session
        .song_view()
        .expect("song view should build")
        .expect("song summary should exist");
    assert_eq!(snapshot.project_revision, snapshot_song.project_revision);
    assert_eq!(snapshot_song.tracks.len(), 2);
    assert_eq!(snapshot_song.clips.len(), 2);
    assert!(snapshot_song
        .tracks
        .iter()
        .any(|track| track.id == "track_1"));
    assert!(snapshot_song
        .tracks
        .iter()
        .any(|track| track.id == "track_click" || track.id == "track_click-1"));

    let saved_song = load_song(&song_dir).expect("song json should load");
    assert_eq!(saved_song.tracks.len(), 1);
    assert_eq!(saved_song.clips.len(), 1);
}

#[test]
fn importing_library_assets_keeps_the_current_arrangement_unchanged() {
    let mut session = session_with_song_dir("library-import-demo", demo_song());
    let imports_root = tempdir().expect("temp dir should exist");
    let imported_click = imports_root.path().join("click.wav");
    write_silent_test_wav(&imported_click, 6);
    let imported_click_path = imported_click
        .canonicalize()
        .unwrap_or_else(|_| imported_click.clone())
        .to_string_lossy()
        .replace('\\', "/");

    let before = session
        .song_view()
        .expect("song view should build")
        .expect("song should be loaded");
    let assets = session
        .import_audio_files_into_library(&[imported_click], |_, _| {})
        .expect("library import should succeed");
    let after = session
        .song_view()
        .expect("song view should build")
        .expect("song should stay loaded");

    assert_eq!(before.tracks.len(), after.tracks.len());
    assert_eq!(before.clips.len(), after.clips.len());
    assert!(assets
        .iter()
        .any(|asset| asset.file_path.replace('\\', "/") == imported_click_path));
}

#[test]
fn import_audio_files_from_bytes_returns_only_newly_imported_assets() {
    let mut session = session_with_song_dir("library-import-bytes-demo", demo_song());
    let song_dir = session.song_dir.clone().expect("song dir should exist");

    write_silent_test_wav(&song_dir.join("audio").join("existing-a.wav"), 2);
    write_silent_test_wav(&song_dir.join("audio").join("existing-b.wav"), 3);
    write_silent_test_wav(&song_dir.join("audio").join("existing-c.wav"), 4);
    write_library_manifest_assets(
        &song_dir,
        &[
            LibraryAssetSummary {
                file_name: "existing-a.wav".into(),
                file_path: "audio/existing-a.wav".into(),
                duration_seconds: 2.0,
                is_missing: false,
                folder_path: None,
            },
            LibraryAssetSummary {
                file_name: "existing-b.wav".into(),
                file_path: "audio/existing-b.wav".into(),
                duration_seconds: 3.0,
                is_missing: false,
                folder_path: None,
            },
            LibraryAssetSummary {
                file_name: "existing-c.wav".into(),
                file_path: "audio/existing-c.wav".into(),
                duration_seconds: 4.0,
                is_missing: false,
                folder_path: None,
            },
        ],
    )
    .expect("manifest should save");

    let imports_root = tempdir().expect("temp dir should exist");
    let dropped_a = imports_root.path().join("dropped-a.wav");
    let dropped_b = imports_root.path().join("dropped-b.wav");
    write_silent_test_wav(&dropped_a, 5);
    write_silent_test_wav(&dropped_b, 6);

    let imported_assets = session
        .import_audio_files_from_bytes(&[
            AudioFileImportPayload {
                file_name: "dropped-a.wav".into(),
                bytes: fs::read(&dropped_a).expect("first dropped wav should read"),
            },
            AudioFileImportPayload {
                file_name: "dropped-b.wav".into(),
                bytes: fs::read(&dropped_b).expect("second dropped wav should read"),
            },
        ])
        .expect("byte import should succeed");

    assert_eq!(imported_assets.len(), 2);
    assert!(imported_assets
        .iter()
        .any(|asset| asset.file_path == "audio/dropped-a.wav"));
    assert!(imported_assets
        .iter()
        .any(|asset| asset.file_path == "audio/dropped-b.wav"));
    assert!(imported_assets
        .iter()
        .all(|asset| asset.file_name.starts_with("dropped-")));

    let all_assets = session
        .get_library_assets()
        .expect("full library assets should still load");
    assert_eq!(all_assets.len(), 6);
}

#[test]
fn import_audio_files_from_paths_registers_original_without_project_audio_copy() {
    let mut session = session_with_song_dir("library-import-paths-demo", demo_song());
    let song_dir = session.song_dir.clone().expect("song dir should exist");

    let imports_root = tempdir().expect("temp dir should exist");
    let external_audio = imports_root.path().join("external-loop.wav");
    write_silent_test_wav(&external_audio, 5);
    let external_audio_path = external_audio
        .canonicalize()
        .unwrap_or_else(|_| external_audio.clone())
        .to_string_lossy()
        .replace('\\', "/");

    let imported_assets = session
        .import_audio_files_from_paths(&[AudioFilePathImportPayload {
            file_name: "external-loop.wav".into(),
            source_path: external_audio.to_string_lossy().to_string(),
        }])
        .expect("path import should succeed");

    assert_eq!(imported_assets.len(), 1);
    assert_eq!(imported_assets[0].file_path, external_audio_path);
    assert!(
        !song_dir.join("audio").join("external-loop.wav").exists(),
        "path-based imports must not copy source audio into the project audio folder"
    );

    let all_assets = session
        .get_library_assets()
        .expect("full library assets should load");
    assert!(all_assets
        .iter()
        .any(|asset| asset.file_path == external_audio_path));
}

#[test]
// Package import asks the engine for source peaks, which the no-link stub
// cannot produce. Runs under `npm run test:native`.
#[cfg_attr(feature = "no-link", ignore = "requires real engine output")]
fn import_song_package_returns_library_assets_for_missing_audio_references() {
    let source_root = tempdir().expect("temp dir should exist");
    let source_song_dir = create_song_folder(source_root.path(), "package-source")
        .expect("source song dir should exist");
    let source_song = demo_song();
    save_song(&source_song_dir, &source_song).expect("source song should save");
    write_library_manifest_assets(
        &source_song_dir,
        &[LibraryAssetSummary {
            file_name: "test.wav".into(),
            file_path: "audio/test.wav".into(),
            duration_seconds: 4.0,
            is_missing: false,
            folder_path: Some("Imported/Refs".into()),
        }],
    )
    .expect("source manifest should save");

    let package_path = source_song_dir.join("demo.ltpkg");
    let export_cache_root = tempdir().expect("export cache root");
    export_region_as_package(
        export_cache_root.path(),
        &source_song_dir,
        &source_song,
        "region_1",
        &package_path,
        false,
    )
    .expect("package should export");

    let target_root = tempdir().expect("temp dir should exist");
    let target_song_dir = create_song_folder(target_root.path(), "package-import-target")
        .expect("target song dir should exist");
    let target_song = build_empty_song("song_target".into(), "Target".into());
    save_song(&target_song_dir, &target_song).expect("target song should save");

    let mut session = DesktopSession::default();
    session.song_file_path = Some(target_song_dir.join(SONG_FILE_NAME));
    session.song_dir = Some(target_song_dir);
    session
        .engine
        .load_song(target_song)
        .expect("target song should load into engine");
    let audio = crate::audio_engine::AudioController::default();

    let result = session
        .import_song_package(&package_path.to_string_lossy(), 0.0, &audio)
        .expect("package import should succeed");

    let imported_asset = result
        .library_assets
        .iter()
        .find(|asset| asset.file_path == "audio/test.wav")
        .unwrap_or_else(|| {
            panic!(
                "missing imported asset in response: {:?}",
                result.library_assets
            )
        });
    assert!(imported_asset.is_missing);

    let song_view = session
        .song_view()
        .expect("song view should build")
        .expect("song should exist");
    assert!(song_view
        .clips
        .iter()
        .any(|clip| { clip.file_path == "audio/test.wav" && clip.is_missing }));
    assert_eq!(result.snapshot.project_revision, song_view.project_revision);
}

#[test]
fn create_clip_adds_a_library_asset_to_an_existing_audio_track() {
    let mut session = session_with_song_dir("create-clip-demo", demo_song());
    let audio = crate::audio_engine::AudioController::default();

    session
        .create_clip("track_1", "audio/test.wav", 4.0, &audio)
        .expect("clip should be created");

    let song_view = session
        .song_view()
        .expect("song view should build")
        .expect("song should exist");
    assert_eq!(song_view.clips.len(), 2);
    assert!(song_view.clips.iter().any(|clip| {
        clip.track_id == "track_1"
            && clip.file_path == "audio/test.wav"
            && (clip.timeline_start_seconds - 4.0).abs() < 0.0001
    }));

    let saved_song = load_song(
        session
            .song_dir
            .as_ref()
            .expect("song dir should remain available"),
    )
    .expect("song file should save");
    assert_eq!(saved_song.clips.len(), 1);
}

#[test]
fn create_clips_batch_persists_multiple_clips_with_one_song_update() {
    let mut session = session_with_song_dir("create-clips-batch-demo", demo_song());
    let audio = crate::audio_engine::AudioController::default();
    let song_dir = session.song_dir.clone().expect("song dir should exist");
    write_silent_test_wav(&song_dir.join("audio").join("test-2.wav"), 5);

    let snapshot = session
        .create_clips_batch(
            &[
                CreateClipRequest {
                    track_id: "track_1".into(),
                    file_path: "audio/test.wav".into(),
                    timeline_start_seconds: 4.0,
                },
                CreateClipRequest {
                    track_id: "track_1".into(),
                    file_path: "audio/test-2.wav".into(),
                    timeline_start_seconds: 9.5,
                },
            ],
            &audio,
        )
        .expect("clips batch should succeed");

    assert_eq!(snapshot.project_revision, 1);

    let song_view = session
        .song_view()
        .expect("song view should build")
        .expect("song should exist");
    assert_eq!(song_view.clips.len(), 3);
    assert!(song_view.clips.iter().any(|clip| {
        clip.file_path == "audio/test.wav" && (clip.timeline_start_seconds - 4.0).abs() < 0.0001
    }));
    assert!(song_view.clips.iter().any(|clip| {
        clip.file_path == "audio/test-2.wav"
            && (clip.timeline_start_seconds - 9.5).abs() < 0.0001
            && (clip.duration_seconds - 5.0).abs() < 0.0001
    }));

    let saved_song = load_song(&song_dir).expect("song file should stay unchanged until save");
    assert_eq!(saved_song.clips.len(), 1);
}

#[test]
fn create_audio_tracks_with_clips_adds_tracks_and_clips_in_one_update() {
    let mut session = session_with_song_dir("create-audio-tracks-demo", demo_song());
    let audio = crate::audio_engine::AudioController::default();
    let song_dir = session.song_dir.clone().expect("song dir should exist");
    write_silent_test_wav(&song_dir.join("audio").join("loop-a.wav"), 3);
    write_silent_test_wav(&song_dir.join("audio").join("loop-b.wav"), 4);

    let snapshot = session
        .create_audio_tracks_with_clips(
            &[
                CreateAudioTrackWithClipRequest {
                    track_name: "Loop A".into(),
                    file_path: "audio/loop-a.wav".into(),
                    timeline_start_seconds: 0.0,
                },
                CreateAudioTrackWithClipRequest {
                    track_name: "Loop B".into(),
                    file_path: "audio/loop-b.wav".into(),
                    timeline_start_seconds: 0.0,
                },
            ],
            &audio,
        )
        .expect("batch track+clip creation should succeed");

    // The whole batch is a single song update regardless of asset count —
    // this is the property that makes a second drop instant instead of
    // rebuilding the session once per asset.
    assert_eq!(snapshot.project_revision, 1);

    let song_view = session
        .song_view()
        .expect("song view should build")
        .expect("song should exist");
    // demo_song starts with 1 track + 1 clip; the batch added 2 of each.
    assert_eq!(song_view.tracks.len(), 3);
    assert_eq!(song_view.clips.len(), 3);
    // New tracks are persistent (not auto-created one-shots).
    assert!(song_view
        .tracks
        .iter()
        .any(|track| track.name == "Loop A" && !track.auto_created));
    assert!(song_view
        .tracks
        .iter()
        .any(|track| track.name == "Loop B" && !track.auto_created));
}

#[test]
fn create_audio_tracks_with_clips_rejects_empty_track_name() {
    let mut session = session_with_song_dir("create-audio-tracks-empty", demo_song());
    let audio = crate::audio_engine::AudioController::default();
    let song_dir = session.song_dir.clone().expect("song dir should exist");
    write_silent_test_wav(&song_dir.join("audio").join("loop-a.wav"), 3);

    let result = session.create_audio_tracks_with_clips(
        &[CreateAudioTrackWithClipRequest {
            track_name: "   ".into(),
            file_path: "audio/loop-a.wav".into(),
            timeline_start_seconds: 0.0,
        }],
        &audio,
    );

    assert!(result.is_err());
}

#[test]
fn get_library_assets_reads_audio_files_from_the_session_audio_directory() {
    let root = tempdir().expect("temp dir should exist");
    let root_path = root.keep();
    let song_dir =
        create_song_folder(&root_path, "library-assets-demo").expect("song dir should exist");
    let imported_a = song_dir.join("audio").join("alpha.wav");
    let imported_b = song_dir.join("audio").join("beta.wav");
    write_silent_test_wav(&imported_b, 4);
    write_silent_test_wav(&imported_a, 2);

    let mut session = DesktopSession::default();
    session.song_dir = Some(song_dir);

    let assets = session
        .get_library_assets()
        .expect("library assets should load");

    assert_eq!(assets.len(), 2);
    assert_eq!(assets[0].file_name, "alpha.wav");
    assert_eq!(assets[0].file_path, "audio/alpha.wav");
    assert!((assets[0].duration_seconds - 2.0).abs() < 0.001);
    assert_eq!(assets[1].file_name, "beta.wav");
}

#[test]
fn get_library_assets_preserves_folder_from_manifest() {
    let root = tempdir().expect("temp dir should exist");
    let root_path = root.keep();
    let song_dir =
        create_song_folder(&root_path, "library-bpm-demo").expect("song dir should exist");
    let audio_path = song_dir.join("audio").join("click.wav");
    write_silent_test_wav(&audio_path, 2);
    write_library_manifest_assets(
        &song_dir,
        &[LibraryAssetSummary {
            file_name: "click.wav".into(),
            file_path: "audio/click.wav".into(),
            duration_seconds: 2.0,
            is_missing: false,
            folder_path: Some("Percusion/Clicks".into()),
        }],
    )
    .expect("manifest should save");

    let assets = list_library_assets(&song_dir, None).expect("library assets should load");

    assert_eq!(assets.len(), 1);
    assert_eq!(assets[0].file_path, "audio/click.wav");
    assert_eq!(assets[0].folder_path.as_deref(), Some("Percusion/Clicks"));
}

#[test]
fn library_manifest_overrides_audio_directory_scanning_for_empty_songs() {
    let root = tempdir().expect("temp dir should exist");
    let root_path = root.keep();
    let song_dir =
        create_song_folder(&root_path, "library-manifest-demo").expect("song dir should exist");
    write_silent_test_wav(&song_dir.join("audio").join("carry-over.wav"), 3);
    write_library_manifest(&song_dir, &[]).expect("manifest should save");

    let assets = list_library_assets(
        &song_dir,
        Some(&build_empty_song("song_1".into(), "Nueva".into())),
    )
    .expect("library assets should load");

    assert!(assets.is_empty());
}

#[test]
fn delete_library_asset_removes_unused_files_from_the_song_library() {
    let mut session = session_with_song_dir(
        "library-delete-demo",
        build_empty_song("song_1".into(), "Nueva".into()),
    );
    let song_dir = session.song_dir.clone().expect("song dir should exist");
    let audio_path = song_dir.join("audio").join("remove-me.wav");
    write_silent_test_wav(&audio_path, 5);
    write_library_manifest(&song_dir, &["audio/remove-me.wav".to_string()])
        .expect("manifest should save");

    let assets = session
        .delete_library_asset("audio/remove-me.wav")
        .expect("delete should succeed");

    assert!(assets.is_empty());
    assert!(!audio_path.exists());
}

#[test]
fn delete_library_asset_rejects_files_used_by_existing_clips() {
    let mut session = session_with_song_dir("library-delete-used-demo", demo_song());

    let error = session
        .delete_library_asset("audio/test.wav")
        .expect_err("delete should be rejected");

    assert!(error.to_string().contains("already used on the timeline"));
}

fn song_with_folder_hierarchy() -> Song {
    let mut song = demo_song();
    // A parent folder track + a child audio routed to a custom bus, plus the
    // existing "track_1" — enough to exercise hierarchy + routing survival.
    song.tracks.insert(
        0,
        Track {
            id: "folder_1".into(),
            name: "Drums".into(),
            kind: TrackKind::Folder,
            parent_track_id: None,
            volume: 0.5,
            pan: -0.3,
            muted: true,
            solo: true,
            transpose_enabled: false,
            audio_to: "bus_a".to_string(),
            color: Some("#ff0000".into()),
            auto_created: true,
        },
    );
    song.tracks.push(Track {
        id: "track_child".into(),
        name: "Kick".into(),
        kind: TrackKind::Audio,
        parent_track_id: Some("folder_1".into()),
        volume: 0.8,
        pan: 0.2,
        muted: false,
        solo: false,
        transpose_enabled: true,
        audio_to: "bus_a".to_string(),
        color: Some("#00ff00".into()),
        auto_created: true,
    });
    song
}

#[test]
fn strip_song_to_template_keeps_structure_and_drops_content() {
    let template = super::strip_song_to_template(song_with_folder_hierarchy());

    // Content is gone.
    assert!(template.clips.is_empty());
    assert!(template.regions.is_empty());
    assert!(template.section_markers.is_empty());
    assert!(template.tempo_markers.is_empty());

    // Structure survives: same three tracks with hierarchy + routing intact.
    assert_eq!(template.tracks.len(), 3);
    let folder = &template.tracks[0];
    assert_eq!(folder.id, "folder_1");
    assert_eq!(folder.kind, TrackKind::Folder);
    assert_eq!(folder.audio_to, "bus_a");
    assert_eq!(folder.color.as_deref(), Some("#ff0000"));
    let child = template
        .tracks
        .iter()
        .find(|track| track.id == "track_child")
        .expect("child track survives");
    assert_eq!(child.parent_track_id.as_deref(), Some("folder_1"));
    assert_eq!(child.audio_to, "bus_a");

    // Mix is reset and every track is pinned as explicit so the layout is
    // not eroded by the empty-auto-track cleanup.
    for track in &template.tracks {
        assert_eq!(track.volume, 1.0);
        assert_eq!(track.pan, 0.0);
        assert!(!track.muted);
        assert!(!track.solo);
        assert!(track.transpose_enabled);
        assert!(!track.auto_created);
    }
}

#[test]
fn build_template_song_stamps_fresh_id_and_title() {
    let song = super::build_template_song(
        song_with_folder_hierarchy(),
        "song_new".into(),
        "My Show".into(),
    );
    assert_eq!(song.id, "song_new");
    assert_eq!(song.title, "My Show");
    assert!(song.clips.is_empty());
    assert_eq!(song.tracks.len(), 3);
}

#[test]
fn create_song_from_template_path_builds_project_with_template_structure() {
    // Arrange: write a template file to disk from a structured song.
    let temp = tempfile::tempdir().expect("tempdir");
    let template_path = temp.path().join("band.lttemplate");
    let template = super::strip_song_to_template(song_with_folder_hierarchy());
    save_song_to_file(&template_path, &template).expect("template saves");

    // Act: create a brand-new project from that template.
    let mut session = DesktopSession::default();
    let audio = crate::audio_engine::AudioController::default();
    let target_pick = temp.path().join("NewProject.ltsession");
    session
        .create_song_from_template_path(template_path, target_pick, &audio)
        .expect("create from template succeeds");

    // Assert: the loaded song carries the template's tracks and no clips.
    let song = session.engine.song().cloned().expect("song is loaded");
    assert_eq!(song.title, "NewProject");
    assert_eq!(song.tracks.len(), 3);
    assert!(song.clips.is_empty());
    assert!(song.regions.is_empty());
    assert!(temp.path().join("NewProject").join("audio").is_dir());
}

#[test]
fn create_library_folder_persists_empty_virtual_folders() {
    let mut session = session_with_song_dir(
        "library-create-folder-demo",
        build_empty_song("song_1".into(), "Nueva".into()),
    );

    let folders = session
        .create_library_folder("Sets/Intro")
        .expect("folder should be created");

    assert_eq!(folders, vec!["Sets/Intro".to_string()]);
    assert_eq!(
        session
            .get_library_folders()
            .expect("folders should load after creation"),
        vec!["Sets/Intro".to_string()]
    );
}

#[test]
fn move_library_asset_updates_virtual_folder_without_moving_files() {
    let mut session = session_with_song_dir(
        "library-move-folder-demo",
        build_empty_song("song_1".into(), "Nueva".into()),
    );
    let song_dir = session.song_dir.clone().expect("song dir should exist");
    let audio_path = song_dir.join("audio").join("move-me.wav");
    write_silent_test_wav(&audio_path, 3);
    write_library_manifest_assets(
        &song_dir,
        &[LibraryAssetSummary {
            file_name: "move-me.wav".into(),
            file_path: "audio/move-me.wav".into(),
            duration_seconds: 3.0,
            is_missing: false,
            folder_path: None,
        }],
    )
    .expect("manifest should save");

    session
        .create_library_folder("Set A")
        .expect("folder should be created");
    let assets = session
        .move_library_asset("audio/move-me.wav", Some("Set A".into()))
        .expect("asset should move logically");

    assert_eq!(assets.len(), 1);
    assert_eq!(assets[0].folder_path.as_deref(), Some("Set A"));
    assert!(audio_path.exists());
    assert_eq!(
        session
            .get_library_folders()
            .expect("folders should still exist"),
        vec!["Set A".to_string()]
    );
}

#[test]
fn rename_library_folder_updates_assets_and_nested_folders() {
    let mut session = session_with_song_dir(
        "library-rename-folder-demo",
        build_empty_song("song_1".into(), "Nueva".into()),
    );
    let song_dir = session.song_dir.clone().expect("song dir should exist");
    let audio_path = song_dir.join("audio").join("move-me.wav");
    write_silent_test_wav(&audio_path, 3);
    write_library_manifest_assets(
        &song_dir,
        &[LibraryAssetSummary {
            file_name: "move-me.wav".into(),
            file_path: "audio/move-me.wav".into(),
            duration_seconds: 3.0,
            is_missing: false,
            folder_path: Some("Set A/Sub".into()),
        }],
    )
    .expect("manifest should save");
    session
        .create_library_folder("Set A")
        .expect("parent folder should exist");
    session
        .create_library_folder("Set A/Sub")
        .expect("child folder should exist");

    let assets = session
        .rename_library_folder("Set A", "Set B")
        .expect("folder should rename");

    assert_eq!(assets[0].folder_path.as_deref(), Some("Set B/Sub"));
    assert_eq!(
        session.get_library_folders().expect("folders should load"),
        vec!["Set B".to_string(), "Set B/Sub".to_string()]
    );
}

#[test]
fn delete_library_folder_moves_assets_back_to_root() {
    let mut session = session_with_song_dir(
        "library-delete-folder-demo",
        build_empty_song("song_1".into(), "Nueva".into()),
    );
    let song_dir = session.song_dir.clone().expect("song dir should exist");
    let audio_path = song_dir.join("audio").join("move-me.wav");
    write_silent_test_wav(&audio_path, 3);
    write_library_manifest_assets(
        &song_dir,
        &[LibraryAssetSummary {
            file_name: "move-me.wav".into(),
            file_path: "audio/move-me.wav".into(),
            duration_seconds: 3.0,
            is_missing: false,
            folder_path: Some("Set A/Sub".into()),
        }],
    )
    .expect("manifest should save");
    session
        .create_library_folder("Set A")
        .expect("parent folder should exist");
    session
        .create_library_folder("Set A/Sub")
        .expect("child folder should exist");

    let assets = session
        .delete_library_folder("Set A")
        .expect("folder should delete");

    assert_eq!(assets[0].folder_path, None);
    assert!(session
        .get_library_folders()
        .expect("folders should load")
        .is_empty());
}

#[test]
fn build_empty_song_starts_with_an_empty_arrangement_at_120_bpm() {
    let song = super::build_empty_song("song_empty".into(), "Nueva Cancion".into());

    assert!(song.regions.is_empty());
    assert_eq!(song.bpm, 120.0);
    assert_eq!(song.time_signature, "4/4");
    assert!(song.tracks.is_empty());
    assert!(song.clips.is_empty());
    assert!(song.section_markers.is_empty());
}

#[test]
fn project_revision_changes_after_mutating_the_song_structure() {
    let mut session = session_with_song_dir("project-revision-demo", demo_song());
    let audio = crate::audio_engine::AudioController::default();
    let initial_snapshot = session.snapshot();

    let updated_snapshot = session
        .move_clip("clip_1", 4.25, &audio)
        .expect("clip should move");

    assert!(updated_snapshot.project_revision > initial_snapshot.project_revision);
}

#[test]
fn undo_and_redo_restore_song_state() {
    let mut session = session_with_song_dir("undo-redo-demo", demo_song());
    let audio = crate::audio_engine::AudioController::default();

    let moved_snapshot = session
        .move_clip("clip_1", 4.25, &audio)
        .expect("clip should move");
    let moved_song = session
        .song_view()
        .expect("song view should build")
        .expect("song should exist");
    assert!(moved_snapshot.project_revision > 0);
    assert!(moved_song
        .clips
        .iter()
        .find(|clip| clip.id == "clip_1")
        .map(|clip| (clip.timeline_start_seconds - 4.25).abs() < 0.0001)
        .unwrap_or(false));

    let undone_snapshot = session.undo_action(&audio).expect("undo should succeed");
    let undone_song = session
        .song_view()
        .expect("song view should build")
        .expect("song should exist");
    assert!(undone_snapshot.project_revision > moved_snapshot.project_revision);
    assert!(undone_song
        .clips
        .iter()
        .find(|clip| clip.id == "clip_1")
        .map(|clip| (clip.timeline_start_seconds - 1.0).abs() < 0.0001)
        .unwrap_or(false));

    let redone_snapshot = session.redo_action(&audio).expect("redo should succeed");
    let redone_song = session
        .song_view()
        .expect("song view should build")
        .expect("song should exist");
    assert!(redone_snapshot.project_revision > undone_snapshot.project_revision);
    assert!(redone_song
        .clips
        .iter()
        .find(|clip| clip.id == "clip_1")
        .map(|clip| (clip.timeline_start_seconds - 4.25).abs() < 0.0001)
        .unwrap_or(false));
}

#[test]
// Exercises the real engine's waveform cache counters; the no-link stub
// performs no analysis. Runs under `npm run test:native`.
#[cfg_attr(feature = "no-link", ignore = "requires real engine output")]
fn waveform_requests_reuse_the_in_memory_cache_after_song_load() {
    let root = tempdir().expect("temp dir should exist");
    let song_dir =
        create_song_folder(root.path(), "waveform-cache-demo").expect("song dir should exist");
    let wav_path = song_dir.join("audio").join("test.wav");
    write_silent_test_wav(&wav_path, 6);
    generate_waveform_summary(&song_dir, "audio/test.wav").expect("waveform should generate");
    save_song(&song_dir, &demo_song()).expect("song should save");

    let mut session = DesktopSession::default();
    let audio = crate::audio_engine::AudioController::default();
    session
        .load_song_from_path(demo_song(), song_dir, &audio)
        .expect("song should load");

    let perf_after_load = session.performance_snapshot();
    let first_waveform = session
        .load_waveforms_internal(&["audio/test.wav".to_string()], None, None)
        .expect("waveform should load");
    let perf_after_first_request = session.performance_snapshot();
    let second_waveform = session
        .load_waveforms_internal(&["audio/test.wav".to_string()], None, None)
        .expect("waveform should load from cache");
    let perf_after_second_request = session.performance_snapshot();

    assert_eq!(first_waveform.len(), 1);
    assert_eq!(second_waveform.len(), 1);
    assert!(perf_after_load.waveform_cache_misses > 0);
    assert!(
        perf_after_second_request.waveform_cache_hits
            > perf_after_first_request.waveform_cache_hits
    );
}

#[test]
fn waveform_cache_miss_does_not_decode_inline() {
    // Regression guard for the post-import UI freeze: a cache MISS must NOT
    // be decoded synchronously (that held the session lock for seconds).
    // With no background queue wired, a miss now yields an EMPTY result
    // instead of decoding inline (which previously returned 1).
    let root = tempdir().expect("temp dir should exist");
    let song_dir =
        create_song_folder(root.path(), "waveform-miss-demo").expect("song dir should exist");
    let wav_path = song_dir.join("audio").join("test.wav");
    write_silent_test_wav(&wav_path, 6);
    // NOTE: intentionally NO generate_waveform_summary() here, so the lookup
    // is a genuine cache miss.
    save_song(&song_dir, &demo_song()).expect("song should save");

    let mut session = DesktopSession::default();
    let audio = crate::audio_engine::AudioController::default();
    session
        .load_song_from_path(demo_song(), song_dir, &audio)
        .expect("song should load");

    let result = session
        .load_waveforms_internal(&["audio/test.wav".to_string()], None, None)
        .expect("call should succeed");

    // Old behavior decoded inline and returned 1; new behavior enqueues
    // (here: no queue) and returns nothing for the miss.
    assert!(
        result.is_empty(),
        "a cache miss must not be decoded synchronously"
    );
}

#[test]
fn waveform_queue_test_helper_tracks_pending() {
    // The test-only queue does not drain, so enqueued keys stay in_flight.
    // (We can't build a real AppHandle here, so this exercises the queue's
    // pending bookkeeping in isolation rather than through load_*_waveforms.)
    let queue = super::WaveformGenerationQueue::new_for_test();
    assert_eq!(queue.pending_count(), 0);
}

#[test]
fn creating_a_section_marker_stays_in_memory_until_save() {
    let root = tempdir().expect("temp dir should exist");
    let song_dir = create_song_folder(root.path(), "section-demo").expect("song dir should exist");
    fs::create_dir_all(song_dir.join("audio")).expect("audio dir should exist");
    save_song(&song_dir, &demo_song()).expect("song should save");

    let mut session = DesktopSession::default();
    session.song_dir = Some(song_dir.clone());
    session
        .engine
        .load_song(demo_song())
        .expect("song should load into engine");

    let audio = crate::audio_engine::AudioController::default();
    let snapshot = session
        .create_section_marker(2.0, None, None, None, &audio)
        .expect("section marker should be created");
    let song_view = session
        .song_view()
        .expect("song view should build")
        .expect("song summary should exist");

    assert_eq!(snapshot.project_revision, song_view.project_revision);
    assert_eq!(song_view.section_markers.len(), 1);
    assert_eq!(song_view.section_markers[0].name, "Marker 0");

    let saved_song = load_song(&song_dir).expect("song json should load");
    assert!(saved_song.section_markers.is_empty());
}

#[test]
fn deleting_a_clip_stays_in_memory_until_save() {
    let root = tempdir().expect("temp dir should exist");
    let song_dir =
        create_song_folder(root.path(), "clip-delete-demo").expect("song dir should exist");
    fs::create_dir_all(song_dir.join("audio")).expect("audio dir should exist");
    save_song(&song_dir, &demo_song()).expect("song should save");

    let mut session = DesktopSession::default();
    session.song_dir = Some(song_dir.clone());
    session
        .engine
        .load_song(demo_song())
        .expect("song should load into engine");

    let audio = crate::audio_engine::AudioController::default();
    let snapshot = session
        .delete_clip("clip_1", &audio)
        .expect("clip should delete");
    let song_view = session
        .song_view()
        .expect("song view should build")
        .expect("song summary should exist");

    assert_eq!(snapshot.project_revision, song_view.project_revision);
    assert!(song_view.clips.is_empty());

    let saved_song = load_song(&song_dir).expect("song json should load");
    assert_eq!(saved_song.clips.len(), 1);
    assert_eq!(session.engine.playback_state(), PlaybackState::Stopped);
}

#[test]
fn deleting_the_last_clip_shrinks_song_duration_even_if_markers_remain() {
    let root = tempdir().expect("temp dir should exist");
    let song_dir =
        create_song_folder(root.path(), "clip-delete-shrink-demo").expect("song dir should exist");
    fs::create_dir_all(song_dir.join("audio")).expect("audio dir should exist");

    let mut song = demo_song();
    song.section_markers.push(Marker {
        id: "section_far".into(),
        name: "Far".into(),
        start_seconds: 6.0,
        digit: None,
        kind: MarkerKind::Custom,
        variant: None,
        color: None,
    });
    save_song(&song_dir, &song).expect("song should save");

    let mut session = DesktopSession::default();
    session.song_dir = Some(song_dir.clone());
    session
        .engine
        .load_song(song)
        .expect("song should load into engine");

    let audio = crate::audio_engine::AudioController::default();
    let snapshot = session
        .delete_clip("clip_1", &audio)
        .expect("clip should delete");
    let song_view = session
        .song_view()
        .expect("song view should build")
        .expect("song summary should exist");

    assert_eq!(snapshot.project_revision, song_view.project_revision);
    assert!(song_view.clips.is_empty());
    assert_eq!(song_view.duration_seconds, 1.0);
    assert_eq!(song_view.section_markers.len(), 1);
    assert_eq!(song_view.section_markers[0].start_seconds, 6.0);
}

#[test]
fn updating_a_clip_window_stays_in_memory_until_save() {
    let root = tempdir().expect("temp dir should exist");
    let song_dir =
        create_song_folder(root.path(), "clip-window-demo").expect("song dir should exist");
    fs::create_dir_all(song_dir.join("audio")).expect("audio dir should exist");

    let wav_path = song_dir.join("audio").join("test.wav");
    let spec = hound::WavSpec {
        channels: 2,
        sample_rate: 44_100,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(&wav_path, spec).expect("wav should be created");
    for _ in 0..(44_100 * 8) {
        writer.write_sample(0_i16).expect("sample should write");
        writer.write_sample(0_i16).expect("sample should write");
    }
    writer.finalize().expect("wav should finalize");
    save_song(&song_dir, &demo_song()).expect("song should save");

    let mut session = DesktopSession::default();
    session.song_dir = Some(song_dir.clone());
    session
        .engine
        .load_song(demo_song())
        .expect("song should load into engine");

    let audio = crate::audio_engine::AudioController::default();
    let snapshot = session
        .update_clip_window("clip_1", 2.0, 1.5, 2.25, &audio)
        .expect("clip window should update");
    let updated_clip = session
        .song_view()
        .expect("song view should build")
        .expect("song summary should exist")
        .clips
        .into_iter()
        .find(|clip| clip.id == "clip_1")
        .expect("updated clip should exist");

    assert!(snapshot.project_revision > 0);
    assert_eq!(updated_clip.timeline_start_seconds, 2.0);
    assert_eq!(updated_clip.source_start_seconds, 1.5);
    assert_eq!(updated_clip.duration_seconds, 2.25);

    let saved_song = load_song(&song_dir).expect("song json should load");
    assert_eq!(saved_song.clips[0].timeline_start_seconds, 1.0);
    assert_eq!(saved_song.clips[0].source_start_seconds, 0.0);
    assert_eq!(saved_song.clips[0].duration_seconds, 4.0);
}

#[test]
fn duplicating_a_clip_stays_in_memory_until_save() {
    let root = tempdir().expect("temp dir should exist");
    let song_dir =
        create_song_folder(root.path(), "clip-duplicate-demo").expect("song dir should exist");
    fs::create_dir_all(song_dir.join("audio")).expect("audio dir should exist");
    save_song(&song_dir, &demo_song()).expect("song should save");

    let mut session = DesktopSession::default();
    session.song_dir = Some(song_dir.clone());
    session
        .engine
        .load_song(demo_song())
        .expect("song should load into engine");

    let audio = crate::audio_engine::AudioController::default();
    let snapshot = session
        .duplicate_clip("clip_1", 6.0, &audio)
        .expect("clip should duplicate");
    let snapshot_song = session
        .song_view()
        .expect("song view should build")
        .expect("song summary should exist");
    assert_eq!(snapshot.project_revision, snapshot_song.project_revision);
    assert_eq!(snapshot_song.clips.len(), 2);
    assert!(snapshot_song
        .clips
        .iter()
        .any(|clip| clip.id != "clip_1" && clip.timeline_start_seconds == 6.0));
    let duplicated_clip = snapshot_song
        .clips
        .iter()
        .find(|clip| clip.id != "clip_1")
        .expect("duplicated clip should exist");
    assert_eq!(duplicated_clip.file_path, "audio/test.wav");
    assert_eq!(
        fs::read_dir(song_dir.join("audio"))
            .expect("audio dir should be readable")
            .count(),
        0
    );

    let saved_song = load_song(&song_dir).expect("song json should load");
    assert_eq!(saved_song.clips.len(), 1);
}

#[test]
// Pre-dates the clip-inside-region invariant: it duplicates a clip to a
// position outside every region, which save_song now rejects. Kept for
// reference until the region/clip duplication behaviour is revisited.
#[ignore = "scenario invalid under the clip-inside-region invariant; revisit duplication behaviour"]
fn duplicating_a_clip_does_not_stretch_the_last_region() {
    let root = tempdir().expect("temp dir should exist");
    let song_dir = create_song_folder(root.path(), "clip-duplicate-region-demo")
        .expect("song dir should exist");
    fs::create_dir_all(song_dir.join("audio")).expect("audio dir should exist");

    let mut song = demo_song();
    song.regions[0].end_seconds = 2.0;
    // Shrink the clip to fit inside the shortened region ([0, 2]) so the
    // starting song is valid; the test then checks that duplicating the
    // clip past the region does not stretch the region.
    song.clips[0].timeline_start_seconds = 0.0;
    song.clips[0].duration_seconds = 2.0;
    save_song(&song_dir, &song).expect("song should save");

    let mut session = DesktopSession::default();
    session.song_dir = Some(song_dir.clone());
    session
        .engine
        .load_song(song)
        .expect("song should load into engine");

    let audio = crate::audio_engine::AudioController::default();
    let snapshot = session
        .duplicate_clip("clip_1", 6.0, &audio)
        .expect("clip should duplicate without stretching regions");
    let song_view = session
        .song_view()
        .expect("song view should build")
        .expect("song summary should exist");

    assert!(snapshot.project_revision > 0);
    assert_eq!(song_view.duration_seconds, 10.0);
    assert_eq!(song_view.regions.len(), 1);
    assert_eq!(song_view.regions[0].end_seconds, 2.0);
}

#[test]
fn scheduling_and_cancelling_a_section_jump_updates_snapshot() {
    let mut session = DesktopSession::default();
    session
        .engine
        .load_song(demo_song_with_section())
        .expect("song should load into engine");

    let audio = crate::audio_engine::AudioController::default();
    let scheduled_snapshot = session
        .schedule_marker_jump(
            "section_1",
            JumpTrigger::AfterBars(6),
            TransitionType::Instant,
            &audio,
        )
        .expect("jump should schedule");

    let pending_jump = scheduled_snapshot
        .pending_marker_jump
        .expect("pending jump should exist");
    assert_eq!(pending_jump.target_marker_id, "section_1");
    assert_eq!(pending_jump.target_marker_name, "Intro");
    assert_eq!(pending_jump.trigger, "after_bars:6");

    let cancelled_snapshot = session
        .cancel_marker_jump(&audio)
        .expect("jump should cancel");
    assert!(cancelled_snapshot.pending_marker_jump.is_none());
}

#[test]
fn scheduling_after_bars_across_regions_exposes_cumulative_execute_time_in_snapshot() {
    let mut session = DesktopSession::default();
    session
        .engine
        .load_song(demo_song_with_region_changes_and_sections())
        .expect("song should load into engine");

    let audio = crate::audio_engine::AudioController::default();
    session.seek(7.0, &audio).expect("seek should work");

    let snapshot = session
        .schedule_marker_jump(
            "section_2",
            JumpTrigger::AfterBars(2),
            TransitionType::Instant,
            &audio,
        )
        .expect("jump should schedule");

    let pending_jump = snapshot
        .pending_marker_jump
        .expect("pending jump should exist");
    assert_eq!(pending_jump.target_marker_id, "section_2");
    assert_eq!(pending_jump.target_marker_name, "Outro");
    assert_eq!(pending_jump.trigger, "after_bars:2");
    assert!((pending_jump.execute_at_seconds - 10.0).abs() < 0.0001);
}

#[test]
fn transport_only_updates_preserve_cross_region_after_bars_schedule() {
    let root = tempdir().expect("temp dir should exist");
    let song_dir = create_song_folder(root.path(), "transport-only-cross-region-pending-jump")
        .expect("song dir should exist");
    fs::create_dir_all(song_dir.join("audio")).expect("audio dir should exist");

    let mut session = DesktopSession::default();
    session.song_dir = Some(song_dir);
    session
        .engine
        .load_song(demo_song_with_region_changes_and_sections())
        .expect("song should load into engine");

    let audio = crate::audio_engine::AudioController::default();
    session.seek(7.0, &audio).expect("seek should work");
    session
        .schedule_marker_jump(
            "section_2",
            JumpTrigger::AfterBars(2),
            TransitionType::Instant,
            &audio,
        )
        .expect("jump should schedule");

    let snapshot = session
        .update_section_marker("section_1", "Intro B", 1.0, &audio)
        .expect("section marker update should succeed");

    let pending_jump = snapshot
        .pending_marker_jump
        .expect("pending jump should survive transport-only change");
    assert_eq!(pending_jump.target_marker_id, "section_2");
    assert_eq!(pending_jump.target_marker_name, "Outro");
    assert_eq!(pending_jump.trigger, "after_bars:2");
    assert!((pending_jump.execute_at_seconds - 10.0).abs() < 0.0001);
}

#[test]
fn scheduling_an_immediate_section_jump_updates_position_and_current_marker() {
    let mut session = DesktopSession::default();
    session
        .engine
        .load_song(demo_song_with_section())
        .expect("song should load into engine");
    session.engine.seek(0.0).expect("seek should work");

    let audio = crate::audio_engine::AudioController::default();
    let snapshot = session
        .schedule_marker_jump(
            "section_1",
            JumpTrigger::Immediate,
            TransitionType::Instant,
            &audio,
        )
        .expect("immediate jump should execute");

    assert!(snapshot.pending_marker_jump.is_none());
    assert_eq!(snapshot.position_seconds, 1.0);
    assert_eq!(
        snapshot
            .current_marker
            .expect("current marker should exist")
            .name,
        "Intro"
    );
}

#[test]
fn transport_only_updates_preserve_pending_jump_when_target_survives() {
    let root = tempdir().expect("temp dir should exist");
    let song_dir = create_song_folder(root.path(), "transport-only-pending-jump")
        .expect("song dir should exist");
    fs::create_dir_all(song_dir.join("audio")).expect("audio dir should exist");

    let mut session = DesktopSession::default();
    session.song_dir = Some(song_dir);
    session
        .engine
        .load_song(demo_song_with_two_sections())
        .expect("song should load into engine");

    let audio = crate::audio_engine::AudioController::default();
    session
        .schedule_marker_jump(
            "section_2",
            JumpTrigger::NextMarker,
            TransitionType::Instant,
            &audio,
        )
        .expect("jump should schedule");

    let snapshot = session
        .update_section_marker("section_1", "Intro B", 1.0, &audio)
        .expect("section marker update should succeed");

    let pending_jump = snapshot
        .pending_marker_jump
        .expect("pending jump should survive transport-only change");
    assert_eq!(pending_jump.target_marker_id, "section_2");
    assert_eq!(pending_jump.target_marker_name, "Verse");
    assert_eq!(pending_jump.trigger, "next_marker");
}

#[test]
fn transport_only_updates_drop_pending_jump_when_target_moves_before_position() {
    let root = tempdir().expect("temp dir should exist");
    let song_dir = create_song_folder(root.path(), "transport-only-stale-pending-jump")
        .expect("song dir should exist");
    fs::create_dir_all(song_dir.join("audio")).expect("audio dir should exist");

    let mut session = DesktopSession::default();
    session.song_dir = Some(song_dir);
    session
        .engine
        .load_song(demo_song_with_two_sections())
        .expect("song should load into engine");

    let audio = crate::audio_engine::AudioController::default();
    session.seek(5.0, &audio).expect("seek should work");
    session
        .schedule_marker_jump(
            "section_2",
            JumpTrigger::NextMarker,
            TransitionType::Instant,
            &audio,
        )
        .expect("jump should schedule");

    let snapshot = session
        .update_section_marker("section_2", "Verse", 3.0, &audio)
        .expect("section marker update should succeed");

    assert_eq!(snapshot.position_seconds, 5.0);
    assert!(snapshot.pending_marker_jump.is_none());
}

#[test]
fn deleting_target_section_clears_pending_jump() {
    let root = tempdir().expect("temp dir should exist");
    let song_dir = create_song_folder(root.path(), "delete-target-pending-jump")
        .expect("song dir should exist");
    fs::create_dir_all(song_dir.join("audio")).expect("audio dir should exist");

    let mut session = DesktopSession::default();
    session.song_dir = Some(song_dir);
    session
        .engine
        .load_song(demo_song_with_two_sections())
        .expect("song should load into engine");

    let audio = crate::audio_engine::AudioController::default();
    session
        .schedule_marker_jump(
            "section_2",
            JumpTrigger::AfterBars(2),
            TransitionType::Instant,
            &audio,
        )
        .expect("jump should schedule");

    let snapshot = session
        .delete_section_marker("section_2", &audio)
        .expect("target section marker should delete");

    assert!(snapshot.pending_marker_jump.is_none());
}

#[test]
fn seek_to_pending_jump_target_clears_pending_jump_in_snapshot() {
    let mut session = DesktopSession::default();
    session
        .engine
        .load_song(demo_song_with_two_sections())
        .expect("song should load into engine");
    session.engine.seek(1.5).expect("seek should work");

    let audio = crate::audio_engine::AudioController::default();
    session
        .schedule_marker_jump(
            "section_2",
            JumpTrigger::NextMarker,
            TransitionType::Instant,
            &audio,
        )
        .expect("jump should schedule");

    let snapshot = session
        .seek(4.0, &audio)
        .expect("seek should clear pending jump");

    assert_eq!(snapshot.position_seconds, 4.0);
    assert!(snapshot.pending_marker_jump.is_none());
    assert_eq!(
        snapshot.transport_clock.last_seek_position_seconds,
        Some(4.0)
    );
}

#[test]
fn updating_a_section_marker_stays_in_memory_until_save() {
    let root = tempdir().expect("temp dir should exist");
    let song_dir =
        create_song_folder(root.path(), "section-update-demo").expect("song dir should exist");
    fs::create_dir_all(song_dir.join("audio")).expect("audio dir should exist");
    save_song(&song_dir, &demo_song_with_section()).expect("song should save");

    let mut session = DesktopSession::default();
    session.song_dir = Some(song_dir.clone());
    session
        .engine
        .load_song(demo_song_with_section())
        .expect("song should load into engine");

    let audio = crate::audio_engine::AudioController::default();
    let snapshot = session
        .update_section_marker("section_1", "Verse", 2.5, &audio)
        .expect("section marker should update");
    let updated_section = session
        .song_view()
        .expect("song view should build")
        .expect("song summary should exist")
        .section_markers
        .into_iter()
        .find(|section| section.id == "section_1")
        .expect("updated section should exist");
    assert!(snapshot.project_revision > 0);
    assert_eq!(updated_section.name, "Verse");
    assert_eq!(updated_section.start_seconds, 2.5);

    let saved_song = load_song(&song_dir).expect("song json should load");
    assert_eq!(saved_song.section_markers[0].name, "Intro");
    assert_eq!(saved_song.section_markers[0].start_seconds, 1.0);
}

#[test]
fn deleting_a_section_marker_stays_in_memory_until_save() {
    let root = tempdir().expect("temp dir should exist");
    let song_dir =
        create_song_folder(root.path(), "section-delete-demo").expect("song dir should exist");
    fs::create_dir_all(song_dir.join("audio")).expect("audio dir should exist");
    save_song(&song_dir, &demo_song_with_section()).expect("song should save");

    let mut session = DesktopSession::default();
    session.song_dir = Some(song_dir.clone());
    session
        .engine
        .load_song(demo_song_with_section())
        .expect("song should load into engine");

    let audio = crate::audio_engine::AudioController::default();
    let snapshot = session
        .delete_section_marker("section_1", &audio)
        .expect("section marker should delete");
    let song_view = session
        .song_view()
        .expect("song view should build")
        .expect("song summary should exist");

    assert_eq!(snapshot.project_revision, song_view.project_revision);
    assert!(song_view.section_markers.is_empty());

    let saved_song = load_song(&song_dir).expect("song json should load");
    assert_eq!(saved_song.section_markers.len(), 1);
}

#[test]
fn creating_a_song_region_splits_the_existing_range() {
    // No clips: splitting the single region at 2..5 would otherwise leave
    // demo_song's [1, 5] clip crossing the new boundary. This test checks
    // region-split geometry, so an empty timeline is the right fixture.
    let mut song = demo_song();
    song.clips.clear();
    let mut session = session_with_song_dir("region-create-demo", song);
    let song_dir = session.song_dir.clone().expect("song dir should exist");

    let audio = crate::audio_engine::AudioController::default();
    let snapshot = session
        .create_song_region(2.0, 5.0, &audio)
        .expect("song region should be created");
    let song_view = session
        .song_view()
        .expect("song view should build")
        .expect("song summary should exist");
    let created_region = song_view
        .regions
        .iter()
        .find(|region| region.start_seconds == 2.0 && region.end_seconds == 5.0)
        .expect("created region should exist");

    assert_eq!(snapshot.project_revision, song_view.project_revision);
    assert_eq!(song_view.regions.len(), 3);
    // One region already exists, so the new one is named "Song 2".
    assert_eq!(created_region.name, "Song 2");

    let saved_song = load_song(&song_dir).expect("song json should load");
    assert_eq!(saved_song.regions.len(), 1);
}

#[test]
fn creating_a_song_region_beyond_song_duration_preserves_its_bounds() {
    let mut session = session_with_song_dir("region-beyond-duration-demo", demo_song());
    let song_dir = session.song_dir.clone().expect("song dir should exist");

    let audio = crate::audio_engine::AudioController::default();
    let snapshot = session
        .create_song_region(12.0, 24.0, &audio)
        .expect("song region should be created beyond song duration");
    let song_view = session
        .song_view()
        .expect("song view should build")
        .expect("song summary should exist");
    let created_region = song_view
        .regions
        .iter()
        .find(|region| region.start_seconds == 12.0 && region.end_seconds == 24.0)
        .expect("created region should exist");

    assert!(snapshot.project_revision > 0);
    assert_eq!(song_view.duration_seconds, 12.0);
    assert_eq!(song_view.regions.len(), 2);
    // One region already exists, so the new one is named "Song 2".
    assert_eq!(created_region.name, "Song 2");

    let saved_song = load_song(&song_dir).expect("song json should load");
    assert_eq!(saved_song.regions.len(), 1);
    assert_eq!(saved_song.regions[0].end_seconds, 12.0);
}

#[test]
fn updating_a_song_region_reflows_neighbors_and_preserves_coverage() {
    let mut session = session_with_song_dir(
        "region-update-demo",
        demo_song_with_region_changes_and_sections(),
    );

    let audio = crate::audio_engine::AudioController::default();
    let snapshot = session
        .update_song_region("region_2", "Song B", 6.0, 16.0, &audio)
        .expect("song region should update");
    let song_view = session
        .song_view()
        .expect("song view should build")
        .expect("song summary should exist");
    let updated_region = song_view
        .regions
        .iter()
        .find(|region| region.id == "region_2")
        .expect("updated region should exist");

    assert!(snapshot.project_revision > 0);
    assert_eq!(song_view.regions.len(), 3);
    assert_eq!(song_view.regions[0].start_seconds, 0.0);
    assert_eq!(song_view.regions[0].end_seconds, 6.0);
    assert_eq!(updated_region.name, "Song B");
    assert_eq!(updated_region.start_seconds, 6.0);
    assert_eq!(updated_region.end_seconds, 16.0);
    assert_eq!(song_view.regions[2].start_seconds, 16.0);
    assert_eq!(song_view.regions[2].end_seconds, 18.0);
}

#[test]
fn deleting_a_song_region_preserves_neighbor_region_bounds() {
    let mut session = session_with_song_dir(
        "region-delete-demo",
        demo_song_with_region_changes_and_sections(),
    );

    let audio = crate::audio_engine::AudioController::default();
    let snapshot = session
        .delete_song_region("region_2", &audio)
        .expect("song region should delete");
    let song_view = session
        .song_view()
        .expect("song view should build")
        .expect("song summary should exist");

    assert_eq!(snapshot.project_revision, song_view.project_revision);
    assert_eq!(song_view.regions.len(), 2);
    assert_eq!(song_view.regions[0].id, "region_1");
    assert_eq!(song_view.regions[0].start_seconds, 0.0);
    assert_eq!(song_view.regions[0].end_seconds, 8.0);
    assert_eq!(song_view.regions[1].id, "region_3");
    assert_eq!(song_view.regions[1].start_seconds, 14.0);
    assert_eq!(song_view.regions[1].end_seconds, 18.0);
}

#[test]
fn splitting_a_song_region_divides_it_in_two_at_the_cursor() {
    let mut session = session_with_song_dir(
        "region-split-demo",
        demo_song_with_region_changes_and_sections(),
    );
    let audio = crate::audio_engine::AudioController::default();

    // region_1 "Intro" spans [0, 8]. Split at 4s (no warp, so view==source).
    session
        .split_song_region("region_1", 4.0, &audio)
        .expect("region should split");
    let song_view = session
        .song_view()
        .expect("song view should build")
        .expect("song summary should exist");

    // Now four regions; the split halves are contiguous and tile [0, 8].
    assert_eq!(song_view.regions.len(), 4);
    let left = song_view
        .regions
        .iter()
        .find(|r| r.id == "region_1")
        .expect("left half keeps the original id");
    assert_eq!(left.start_seconds, 0.0);
    assert_eq!(left.end_seconds, 4.0);
    assert_eq!(left.name, "Intro");

    let right = song_view
        .regions
        .iter()
        .find(|r| (r.start_seconds - 4.0).abs() < 0.0001 && r.id != "region_1")
        .expect("right half exists at the cut");
    assert_eq!(right.end_seconds, 8.0);
    assert_eq!(right.name, "Intro (2)");

    // The clip at [1,5] crossed the cut at 4, so it was split into [1,4] and
    // [4,5] — each half now sits entirely inside one song (no clip straddles
    // the new boundary, which the engine would reject).
    assert_eq!(song_view.clips.len(), 2);
    let mut starts: Vec<f64> = song_view
        .clips
        .iter()
        .map(|clip| clip.timeline_start_seconds)
        .collect();
    starts.sort_by(|a, b| a.partial_cmp(b).unwrap());
    assert!((starts[0] - 1.0).abs() < 0.0001);
    assert!((starts[1] - 4.0).abs() < 0.0001);
    let total: f64 = song_view.clips.iter().map(|c| c.duration_seconds).sum();
    assert!(
        (total - 4.0).abs() < 0.0001,
        "no audio lost: 1..5 = 4s total"
    );
}

#[test]
fn splitting_a_song_region_outside_its_range_is_rejected() {
    let mut session = session_with_song_dir(
        "region-split-invalid",
        demo_song_with_region_changes_and_sections(),
    );
    let audio = crate::audio_engine::AudioController::default();

    // 12s is inside region_2, not region_1 → splitting region_1 there is invalid.
    let result = session.split_song_region("region_1", 12.0, &audio);
    assert!(matches!(
        result,
        Err(crate::error::DesktopError::InvalidSplitPoint)
    ));

    // Region layout is untouched.
    let song_view = session
        .song_view()
        .expect("song view should build")
        .expect("song summary should exist");
    assert_eq!(song_view.regions.len(), 3);
}

#[test]
fn resolve_external_insert_keeps_free_position_but_bumps_overlap_to_setlist_end() {
    // Regions span [0,8], [8,14], [14,18] (duration 18).
    let session = session_with_song_dir(
        "external-insert-resolve",
        demo_song_with_region_changes_and_sections(),
    );

    // A 5s project dropped at 30s is past everything → no overlap → kept.
    assert!((session.resolve_external_insert_seconds(30.0, 5.0) - 30.0).abs() < 0.0001);

    // A 5s project dropped at 10s would cover [10,15], overlapping region_2
    // and region_3 → bumped to the setlist end (> 18).
    let bumped = session.resolve_external_insert_seconds(10.0, 5.0);
    assert!(
        bumped >= 18.0,
        "overlap should push the insert past the setlist end (18s), got {bumped}"
    );
}

#[test]
fn reconcile_regions_and_clips_keeps_a_clip_from_crossing_into_the_next_song() {
    // Two songs [0,100] and [100,200]. A clip in the first song is a hair
    // longer than the region end (100.05), which without reconciliation would
    // cross into the second song — the exact "clip spans the boundary" import
    // error (Reaper region end vs. audio item length mismatch).
    let mut song = demo_song();
    song.regions = vec![
        SongRegion {
            id: "a".into(),
            name: "A".into(),
            start_seconds: 0.0,
            end_seconds: 100.0,
            transpose_semitones: 0,
            warp_enabled: false,
            warp_source_bpm: None,
            key: None,
            master: libretracks_core::SongMaster::default(),
        },
        SongRegion {
            id: "b".into(),
            name: "B".into(),
            start_seconds: 100.0,
            end_seconds: 200.0,
            transpose_semitones: 0,
            warp_enabled: false,
            warp_source_bpm: None,
            key: None,
            master: libretracks_core::SongMaster::default(),
        },
    ];
    song.clips = vec![Clip {
        id: "c".into(),
        track_id: song.tracks[0].id.clone(),
        file_path: "audio/x.wav".into(),
        timeline_start_seconds: 0.0,
        source_start_seconds: 0.0,
        duration_seconds: 100.05,
        gain: 1.0,
        fade_in_seconds: None,
        fade_out_seconds: None,
        color: None,
    }];

    reconcile_regions_and_clips(&mut song);

    // The overrunning clip was split at the 100s boundary, so no clip crosses.
    for clip in &song.clips {
        let clip_end = clip.timeline_start_seconds + clip.duration_seconds;
        let crosses = song.regions.iter().any(|region| {
            clip.timeline_start_seconds < region.start_seconds - 0.0001
                && clip_end > region.start_seconds + 0.0001
        });
        assert!(
            !crosses,
            "no clip may cross a region boundary after reconcile"
        );
    }
    // First region still ends at/under the next region's start.
    assert!(song.regions[0].end_seconds <= 100.0 + 0.0001);
}

#[test]
fn deleting_a_song_region_evicts_section_markers_inside_its_range() {
    // Regression: section markers used to survive their song's deletion,
    // leaving an orphan marker whose frame fell outside any remaining song
    // range. The next LoadSession then failed C++ validation with
    // "Marker X is outside its song", so the user could only delete a song
    // after manually removing every marker first.
    let mut session = session_with_song_dir(
        "region-delete-section-markers",
        demo_song_with_region_changes_and_sections(),
    );

    let audio = crate::audio_engine::AudioController::default();
    // section_2 lives at 15.0s, inside region_3 ([14, 18]); section_1 at
    // 1.0s is inside region_1 and must be untouched.
    session
        .delete_song_region("region_3", &audio)
        .expect("song region should delete");
    let song_view = session
        .song_view()
        .expect("song view should build")
        .expect("song summary should exist");

    let section_ids: Vec<&str> = song_view
        .section_markers
        .iter()
        .map(|marker| marker.id.as_str())
        .collect();
    assert_eq!(
        section_ids,
        vec!["section_1"],
        "the marker inside the deleted region should be evicted, the other kept"
    );
}

#[test]
fn deleting_the_last_song_region_leaves_the_song_without_regions() {
    let mut session = session_with_song_dir("region-delete-last-demo", demo_song_with_section());

    let audio = crate::audio_engine::AudioController::default();
    let snapshot = session
        .delete_song_region("region_1", &audio)
        .expect("last song region should delete");
    let song_view = session
        .song_view()
        .expect("song view should build")
        .expect("song summary should exist");

    assert_eq!(snapshot.project_revision, song_view.project_revision);
    assert!(song_view.regions.is_empty());
}

#[test]
fn updating_song_tempo_without_regions_does_not_create_one() {
    let mut session = session_with_song_dir("song-tempo-without-regions", demo_song());
    let audio = crate::audio_engine::AudioController::default();

    {
        let song = session.engine.song_mut().expect("song should exist");
        song.regions.clear();
    }

    let snapshot = session
        .update_song_tempo(148.0, &audio)
        .expect("song tempo update should not fail without regions");
    let song_view = session
        .song_view()
        .expect("song view should build")
        .expect("song summary should exist");

    assert!(snapshot.project_revision > 0);
    assert!(song_view.regions.is_empty());
    assert_eq!(song_view.bpm, 148.0);
    let diagnostics = audio.realtime_control_diagnostics();
    assert_eq!(diagnostics.transport_timing_update_count, 1);
    assert_eq!(
        diagnostics.session_rebuild_count, 0,
        "tempo commits must refresh native timing without reloading sources"
    );
}

#[test]
fn updating_song_tempo_preserves_existing_tempo_markers_while_updating_the_base_bpm() {
    let mut session = session_with_song_dir("song-tempo-reset-demo", demo_song());
    let audio = crate::audio_engine::AudioController::default();

    session
        .upsert_song_tempo_marker(12.0, 91.0, &audio)
        .expect("tempo marker should be created");

    let snapshot = session
        .update_song_tempo(91.0, &audio)
        .expect("song tempo should update");
    let song_view = session
        .song_view()
        .expect("song view should build")
        .expect("song summary should exist");

    assert_eq!(snapshot.project_revision, song_view.project_revision);
    assert_eq!(song_view.bpm, 91.0);
    assert_eq!(song_view.tempo_markers.len(), 1);
    assert!((song_view.tempo_markers[0].start_seconds - 12.0).abs() < 0.0001);
    assert!((song_view.tempo_markers[0].bpm - 91.0).abs() < 0.0001);
}

#[test]
fn disabling_region_warp_restores_timeline_bpm_to_source_bpm() {
    let mut session = session_with_song_dir("region-warp-disable-bpm-demo", demo_song());
    let audio = crate::audio_engine::AudioController::default();

    session
        .update_song_tempo(91.0, &audio)
        .expect("source tempo should update");
    session
        .update_song_region_warp("region_1", true, Some(91.0), &audio)
        .expect("warp should enable");
    session
        .update_song_tempo(100.0, &audio)
        .expect("timeline tempo should update while warped");
    session
        .update_song_region_warp("region_1", false, None, &audio)
        .expect("warp should disable");

    let song_view = session
        .song_view()
        .expect("song view should build")
        .expect("song summary should exist");

    assert_eq!(song_view.bpm, 91.0);
    assert_eq!(song_view.regions[0].warp_enabled, false);
    assert_eq!(song_view.regions[0].warp_source_bpm, Some(91.0));
}

#[test]
fn changing_warped_region_tempo_keeps_following_song_on_downbeat() {
    let mut song = demo_song();
    song.bpm = 120.0;
    song.time_signature = "4/4".into();
    song.tempo_markers = vec![
        TempoMarker {
            id: "tempo_middle".into(),
            start_seconds: 10.0,
            bpm: 130.0,
        },
        TempoMarker {
            id: "tempo_following".into(),
            start_seconds: 17.384615384615387,
            bpm: 140.0,
        },
    ];
    song.regions = vec![
        SongRegion {
            id: "region_intro".into(),
            name: "Intro".into(),
            start_seconds: 0.0,
            end_seconds: 9.0,
            transpose_semitones: 0,
            warp_enabled: false,
            warp_source_bpm: None,
            key: None,
            master: libretracks_core::SongMaster::default(),
        },
        SongRegion {
            id: "region_middle".into(),
            name: "Warped".into(),
            start_seconds: 10.0,
            end_seconds: 17.0,
            transpose_semitones: 0,
            warp_enabled: true,
            warp_source_bpm: Some(130.0),
            key: None,
            master: libretracks_core::SongMaster::default(),
        },
        SongRegion {
            id: "region_following".into(),
            name: "Following".into(),
            start_seconds: 17.384615384615387,
            end_seconds: 25.0,
            transpose_semitones: 0,
            warp_enabled: false,
            warp_source_bpm: None,
            key: None,
            master: libretracks_core::SongMaster::default(),
        },
    ];
    song.clips = vec![
        Clip {
            id: "clip_middle".into(),
            track_id: "track_1".into(),
            file_path: "audio/middle.wav".into(),
            timeline_start_seconds: 10.0,
            source_start_seconds: 0.0,
            duration_seconds: 7.0,
            gain: 1.0,
            fade_in_seconds: None,
            fade_out_seconds: None,
            color: None,
        },
        Clip {
            id: "clip_following".into(),
            track_id: "track_1".into(),
            file_path: "audio/following.wav".into(),
            timeline_start_seconds: 17.384615384615387,
            source_start_seconds: 0.0,
            duration_seconds: 7.0,
            gain: 1.0,
            fade_in_seconds: None,
            fade_out_seconds: None,
            color: None,
        },
    ];

    let previous_song = song.clone();
    song.tempo_markers[0].bpm = 110.0;
    realign_regions_after_warp_tempo_change(&previous_song, &mut song);

    let middle = song
        .regions
        .iter()
        .find(|region| region.id == "region_middle")
        .expect("middle region");
    let following = song
        .regions
        .iter()
        .find(|region| region.id == "region_following")
        .expect("following region");
    let following_clip = song
        .clips
        .iter()
        .find(|clip| clip.id == "clip_following")
        .expect("following clip");
    let following_tempo = song
        .tempo_markers
        .iter()
        .find(|marker| marker.id == "tempo_following")
        .expect("following tempo marker");

    let expected_view_start = next_downbeat_after_in_view_timeline(
        &song,
        warp_timeline_seconds_at(&song, middle.end_seconds),
    );
    let actual_view_start = warp_timeline_seconds_at(&song, following.start_seconds);
    assert!((actual_view_start - expected_view_start).abs() < 0.0001);
    assert!((following.start_seconds - following_clip.timeline_start_seconds).abs() < 0.0001);
    assert!((following.start_seconds - following_tempo.start_seconds).abs() < 0.0001);
    assert!(following.start_seconds > 17.384615384615387);
    validate_song(&song).expect("realigned song should validate");
}

#[test]
fn updating_song_time_signature_preserves_existing_time_signature_markers() {
    let mut session = session_with_song_dir("song-time-signature-reset-demo", demo_song());
    let audio = crate::audio_engine::AudioController::default();

    session
        .upsert_song_time_signature_marker(8.0, "3/4", &audio)
        .expect("time signature marker should be created");

    let snapshot = session
        .update_song_time_signature("6/8", &audio)
        .expect("song time signature should update");
    let song_view = session
        .song_view()
        .expect("song view should build")
        .expect("song summary should exist");

    assert_eq!(snapshot.project_revision, song_view.project_revision);
    assert_eq!(song_view.time_signature, "6/8");
    assert_eq!(song_view.time_signature_markers.len(), 1);
    assert!((song_view.time_signature_markers[0].start_seconds - 8.0).abs() < 0.0001);
    assert_eq!(song_view.time_signature_markers[0].signature, "3/4");
}

#[test]
fn creating_a_section_marker_beyond_song_duration_preserves_its_position() {
    let mut session = session_with_song_dir("section-beyond-duration-demo", demo_song());
    let audio = crate::audio_engine::AudioController::default();

    let snapshot = session
        .create_section_marker(24.0, None, None, None, &audio)
        .expect("section marker should be created beyond song duration");
    let song_view = session
        .song_view()
        .expect("song view should build")
        .expect("song summary should exist");

    assert!(snapshot.project_revision > 0);
    assert_eq!(song_view.duration_seconds, 12.0);
    assert_eq!(song_view.section_markers.len(), 1);
    assert_eq!(song_view.section_markers[0].start_seconds, 24.0);
}

#[test]
fn creating_a_tempo_marker_beyond_song_duration_preserves_its_position() {
    let mut session = session_with_song_dir("tempo-beyond-duration-demo", demo_song());
    let audio = crate::audio_engine::AudioController::default();

    let snapshot = session
        .upsert_song_tempo_marker(24.0, 91.0, &audio)
        .expect("tempo marker should be created beyond song duration");
    let song_view = session
        .song_view()
        .expect("song view should build")
        .expect("song summary should exist");

    assert!(snapshot.project_revision > 0);
    assert_eq!(song_view.duration_seconds, 12.0);
    assert_eq!(song_view.tempo_markers.len(), 1);
    assert_eq!(song_view.tempo_markers[0].start_seconds, 24.0);
    assert_eq!(song_view.tempo_markers[0].bpm, 91.0);
}

// ── Phase 9: section marker MixerOnly path ────────────────────────────────

#[test]
fn section_marker_create_does_not_trigger_session_rebuild() {
    // Section markers are Rust-model-only — C++ must not receive a LoadSession.
    // Verified by checking that realtime_command_count stays at zero (no commands sent).
    let mut session = session_with_song_dir("section-create-demo", demo_song());
    let audio = crate::audio_engine::AudioController::default();
    let initial_revision = session.snapshot().project_revision;

    let snapshot = session
        .create_section_marker(2.5, None, None, None, &audio)
        .expect("section marker should be created");

    let diagnostics = audio.realtime_control_diagnostics();
    assert_eq!(diagnostics.live_mix_realtime_command_count, 0);
    assert_eq!(diagnostics.session_rebuild_count, 0);
    // Revision bumps (model changed) but no realtime commands were sent.
    assert!(snapshot.project_revision > initial_revision);

    let song_view = session
        .song_view()
        .expect("song view should build")
        .expect("song view should exist");
    assert_eq!(song_view.section_markers.len(), 1);
    assert_eq!(song_view.section_markers[0].start_seconds, 2.5);
}

#[test]
fn section_marker_update_does_not_trigger_session_rebuild() {
    let mut session = session_with_song_dir("section-update-demo", demo_song_with_section());
    let audio = crate::audio_engine::AudioController::default();

    session
        .update_section_marker("section_1", "Verse", 3.0, &audio)
        .expect("section marker update should succeed");

    let diagnostics = audio.realtime_control_diagnostics();
    assert_eq!(diagnostics.live_mix_realtime_command_count, 0);
    assert_eq!(diagnostics.session_rebuild_count, 0);

    let song_view = session
        .song_view()
        .expect("song view should build")
        .expect("song view should exist");
    assert_eq!(song_view.section_markers[0].name, "Verse");
    assert_eq!(song_view.section_markers[0].start_seconds, 3.0);
}

#[test]
fn section_marker_delete_does_not_trigger_session_rebuild() {
    let mut session = session_with_song_dir("section-delete-demo", demo_song_with_section());
    let audio = crate::audio_engine::AudioController::default();

    session
        .delete_section_marker("section_1", &audio)
        .expect("section marker deletion should succeed");

    let diagnostics = audio.realtime_control_diagnostics();
    assert_eq!(diagnostics.live_mix_realtime_command_count, 0);
    assert_eq!(diagnostics.session_rebuild_count, 0);

    let song_view = session
        .song_view()
        .expect("song view should build")
        .expect("song view should exist");
    assert_eq!(song_view.section_markers.len(), 0);
}

#[test]
fn section_marker_assign_digit_does_not_trigger_session_rebuild() {
    let mut session = session_with_song_dir("section-digit-demo", demo_song_with_section());
    let audio = crate::audio_engine::AudioController::default();

    session
        .assign_section_marker_digit("section_1", Some(3), &audio)
        .expect("assign digit should succeed");

    let diagnostics = audio.realtime_control_diagnostics();
    assert_eq!(diagnostics.live_mix_realtime_command_count, 0);
    assert_eq!(diagnostics.session_rebuild_count, 0);

    let song_view = session
        .song_view()
        .expect("song view should build")
        .expect("song view should exist");
    assert_eq!(song_view.section_markers[0].digit, Some(3));
}

#[test]
fn set_section_marker_kind_updates_kind_without_session_rebuild() {
    let mut session = session_with_song_dir("section-kind-demo", demo_song_with_section());
    let audio = crate::audio_engine::AudioController::default();

    session
        .set_section_marker_kind("section_1", MarkerKind::Chorus, Some(2), &audio)
        .expect("set kind should succeed");

    // Changing kind/variant is a live marker update for the voice guide, not
    // a full session rebuild (which would interrupt playback).
    let diagnostics = audio.realtime_control_diagnostics();
    assert_eq!(diagnostics.session_rebuild_count, 0);

    let song_view = session
        .song_view()
        .expect("song view should build")
        .expect("song view should exist");
    assert_eq!(song_view.section_markers[0].kind, MarkerKind::Chorus);
    assert_eq!(song_view.section_markers[0].variant, Some(2));
}

#[test]
fn set_section_marker_kind_rejects_unknown_section() {
    let mut session = session_with_song_dir("section-kind-missing", demo_song_with_section());
    let audio = crate::audio_engine::AudioController::default();

    let result = session.set_section_marker_kind("nope", MarkerKind::Verse, None, &audio);
    assert!(matches!(
        result,
        Err(crate::error::DesktopError::SectionNotFound(_))
    ));
}

// ── Phase 5: set_track_transpose_enabled_realtime path ───────────────────

#[test]
fn transpose_enabled_toggle_sends_realtime_command_not_load_session() {
    let mut session = session_with_song_dir("transpose-enabled-demo", demo_song());
    let audio = crate::audio_engine::AudioController::default();
    let initial_revision = session.snapshot().project_revision;

    session
        .update_track_transpose_enabled("track_1", false, &audio)
        .expect("transpose enable toggle should succeed");

    let diagnostics = audio.realtime_control_diagnostics();
    // set_track_transpose_enabled_realtime sends one CmdSetTrackTransposeEnabled.
    // It is counted as a realtime command (live_mix_realtime_command_count).
    assert_eq!(diagnostics.session_rebuild_count, 0);
    // Revision bumps because the Rust model changed.
    assert!(session.snapshot().project_revision > initial_revision);

    let song_view = session
        .song_view()
        .expect("song view should build")
        .expect("song view should exist");
    let track = song_view
        .tracks
        .into_iter()
        .find(|t| t.id == "track_1")
        .expect("track should exist");
    assert!(!track.transpose_enabled);
}

#[test]
fn save_project_persists_pending_song_changes() {
    let mut session = session_with_song_dir("save-project-demo", demo_song());
    let song_dir = session
        .song_dir
        .clone()
        .expect("song dir should exist for loaded session");
    save_song(&song_dir, &demo_song()).expect("seed song should save");

    let audio = crate::audio_engine::AudioController::default();
    session
        .move_clip("clip_1", 6.5, &audio)
        .expect("clip should move");

    let unsaved_song = load_song(&song_dir).expect("song json should load");
    assert_eq!(unsaved_song.clips[0].timeline_start_seconds, 1.0);

    session.save_project().expect("save should succeed");

    let saved_song = load_song(&song_dir).expect("song json should load");
    assert_eq!(saved_song.clips[0].timeline_start_seconds, 6.5);
}

// ── Phase 11 (second pass): strict thin-bridge enforcement tests ──────────

/// Category A: realtime bridge sends command but must NOT mutate the Rust model.
#[test]
fn realtime_bridge_does_not_mutate_rust_model() {
    let mut session = session_with_song_dir("realtime-bridge-model-demo", demo_song());
    let audio = crate::audio_engine::AudioController::default();

    let before = session
        .song_view()
        .expect("song view should build")
        .expect("song view should exist")
        .tracks
        .into_iter()
        .find(|t| t.id == "track_1")
        .expect("track should exist");

    // Category A: direct audio controller call, no session involvement.
    audio
        .update_live_track_mix("track_1", Some(0.5), Some(0.3), Some(true), None, None)
        .expect("realtime update should succeed");

    let after = session
        .song_view()
        .expect("song view should build")
        .expect("song view should exist")
        .tracks
        .into_iter()
        .find(|t| t.id == "track_1")
        .expect("track should exist");

    // Rust model must be unchanged — Category A is bridge-only.
    assert_eq!(after.volume, before.volume);
    assert_eq!(after.pan, before.pan);
    assert_eq!(after.muted, before.muted);
}

/// Category A: realtime bridge must not create an undo entry.
#[test]
fn realtime_bridge_does_not_create_undo_entry() {
    let mut session = session_with_song_dir("realtime-bridge-undo-demo", demo_song());
    let audio = crate::audio_engine::AudioController::default();

    let undo_before = session.undo_stack.len();

    for _ in 0..10 {
        audio
            .update_live_track_mix("track_1", Some(0.8), None, None, None, None)
            .expect("realtime update should succeed");
    }

    assert_eq!(
        session.undo_stack.len(),
        undo_before,
        "undo stack must not grow from realtime commands"
    );
}

/// Category A: realtime bridge must not increment the project revision.
#[test]
fn realtime_bridge_does_not_bump_project_revision() {
    let mut session = session_with_song_dir("realtime-bridge-revision-demo", demo_song());
    let audio = crate::audio_engine::AudioController::default();

    let revision_before = session.snapshot().project_revision;

    for i in 0..20 {
        audio
            .update_live_track_mix("track_1", Some(i as f64 / 20.0), None, None, None, None)
            .expect("realtime update should succeed");
    }

    assert_eq!(
        session.snapshot().project_revision,
        revision_before,
        "project revision must not change from Category A commands"
    );
}

/// Commit path (pointer-up): must bump revision and send exactly one realtime command.
#[test]
fn commit_track_mix_bumps_revision_and_sends_one_realtime_command() {
    let mut session = session_with_song_dir("commit-mix-demo", demo_song());
    let audio = crate::audio_engine::AudioController::default();

    let revision_before = session.snapshot().project_revision;
    let diag_before = audio.realtime_control_diagnostics();

    session
        .commit_track_mix_model_and_command("track_1", Some(0.75), None, None, None, None, &audio)
        .expect("commit should succeed");

    let revision_after = session.snapshot().project_revision;
    let diag_after = audio.realtime_control_diagnostics();

    assert!(
        revision_after > revision_before,
        "commit must bump project revision"
    );
    assert_eq!(
        diag_after.live_mix_realtime_command_count - diag_before.live_mix_realtime_command_count,
        1,
        "commit must send exactly one targeted realtime command"
    );
    assert_eq!(
        diag_after.commit_mix_command_count,
        diag_before.commit_mix_command_count + 1,
        "commit must increment commit_mix_command_count"
    );
    assert_eq!(
        diag_after.session_rebuild_count, 0,
        "commit must not trigger a session rebuild"
    );
}

/// Commit path: must create one undo entry.
#[test]
fn commit_track_mix_creates_one_undo_entry() {
    let mut session = session_with_song_dir("commit-undo-demo", demo_song());
    let audio = crate::audio_engine::AudioController::default();

    let undo_before = session.undo_stack.len();

    session
        .commit_track_mix_model_and_command("track_1", Some(0.5), None, None, None, None, &audio)
        .expect("commit should succeed");
    session
        .commit_track_mix_model_and_command("track_1", Some(0.6), None, None, None, None, &audio)
        .expect("commit should succeed");

    assert_eq!(
        session.undo_stack.len(),
        undo_before + 2,
        "each commit must create exactly one undo entry"
    );
}

/// Track name change must not send any audio command.
#[test]
fn update_track_name_does_not_send_audio_command() {
    let mut session = session_with_song_dir("name-change-demo", demo_song());
    let audio = crate::audio_engine::AudioController::default();

    let diag_before = audio.realtime_control_diagnostics();

    // Name-only change via update_track_name_only.
    session
        .update_track_name_only("track_1", "New Name", &audio)
        .expect("name change should succeed");

    let diag_after = audio.realtime_control_diagnostics();

    assert_eq!(
        diag_after.live_mix_realtime_command_count, diag_before.live_mix_realtime_command_count,
        "name-only change must not send any audio command"
    );
    assert_eq!(diag_after.session_rebuild_count, 0);

    let song_view = session
        .song_view()
        .expect("song view should build")
        .expect("song view should exist");
    let track = song_view
        .tracks
        .into_iter()
        .find(|t| t.id == "track_1")
        .expect("track");
    assert_eq!(track.name, "New Name");
}

/// Legacy broad sync is deleted. Realtime slider drags must never trigger a session rebuild.
#[test]
fn realtime_slider_drags_never_trigger_session_rebuild() {
    let audio = crate::audio_engine::AudioController::default();

    // 100 realtime commands (slider drags) must NOT increment session_rebuild_count.
    for i in 0..100 {
        audio
            .update_live_track_mix("track_1", Some(i as f64 / 100.0), None, None, None, None)
            .expect("realtime update should succeed");
    }

    let diag = audio.realtime_control_diagnostics();
    assert_eq!(diag.live_mix_realtime_command_count, 100);
    assert_eq!(
        diag.session_rebuild_count, 0,
        "realtime slider drags must never trigger a session rebuild"
    );
}

/// session_rebuild_count must increment only for structural changes, not for mixer changes.
#[test]
fn session_rebuild_count_does_not_increment_for_mixer_changes() {
    let audio = crate::audio_engine::AudioController::default();

    // Category A — no rebuild.
    audio
        .update_live_track_mix("track_1", Some(0.5), None, None, None, None)
        .expect("realtime update should succeed");
    audio
        .set_metronome_enabled_realtime(true)
        .expect("metronome toggle should succeed");
    audio
        .set_metronome_volume_realtime(0.7)
        .expect("metronome volume should succeed");
    audio
        .set_track_transpose_enabled_realtime("track_1", false)
        .expect("transpose enabled should succeed");

    assert_eq!(
        audio.realtime_control_diagnostics().session_rebuild_count,
        0,
        "Category A commands must never trigger a session rebuild"
    );
}

/// Metronome toggle must use realtime commands, not session rebuild.
#[test]
fn metronome_toggle_uses_realtime_command_not_session_rebuild() {
    let audio = crate::audio_engine::AudioController::default();

    for i in 0..10 {
        audio
            .set_metronome_enabled_realtime(i % 2 == 0)
            .expect("metronome toggle should succeed");
    }
    audio
        .set_metronome_volume_realtime(0.5)
        .expect("metronome volume should succeed");

    let diag = audio.realtime_control_diagnostics();
    assert_eq!(diag.metronome_realtime_toggle_count, 10);
    assert_eq!(diag.metronome_realtime_volume_count, 1);
    assert_eq!(
        diag.session_rebuild_count, 0,
        "metronome commands must never rebuild the session"
    );
}

/// Folder track volume change must use realtime command, not session rebuild.
#[test]
fn folder_track_volume_uses_realtime_command_not_session_rebuild() {
    let mut session = session_with_song_dir("folder-track-demo", demo_song_with_folder_track());
    let audio = crate::audio_engine::AudioController::default();

    // Folder track volume change — Category A bridge.
    audio
        .update_live_track_mix("folder_1", Some(0.6), None, None, None, None)
        .expect("folder track realtime update should succeed");

    let diag = audio.realtime_control_diagnostics();
    assert_eq!(
        diag.session_rebuild_count, 0,
        "folder track Category A command must not rebuild session"
    );
    assert_eq!(diag.live_mix_realtime_command_count, 1);

    // Commit the folder track volume change — Category B (commit), still no rebuild.
    session
        .commit_track_mix_model_and_command("folder_1", Some(0.6), None, None, None, None, &audio)
        .expect("folder track commit should succeed");

    let diag = audio.realtime_control_diagnostics();
    assert_eq!(
        diag.session_rebuild_count, 0,
        "folder track commit must not rebuild session"
    );
}

// ── Phase 10: new commit classification tests ─────────────────────────────

/// commit_track_mix_model_and_command must increment commit_mix_command_count.
#[test]
fn commit_mix_increments_commit_mix_command_count() {
    let mut session = session_with_song_dir("commit-mix-count-demo", demo_song());
    let audio = crate::audio_engine::AudioController::default();

    assert_eq!(
        audio
            .realtime_control_diagnostics()
            .commit_mix_command_count,
        0
    );

    session
        .commit_track_mix_model_and_command("track_1", Some(0.8), None, None, None, None, &audio)
        .expect("commit should succeed");

    assert_eq!(
        audio
            .realtime_control_diagnostics()
            .commit_mix_command_count,
        1,
        "commit_mix must increment commit_mix_command_count"
    );
    assert_eq!(
        audio.realtime_control_diagnostics().commit_model_only_count,
        0,
        "commit_mix must not increment commit_model_only_count"
    );
}

/// update_track_metadata must increment commit_model_only_count and send no audio command.
#[test]
fn metadata_commit_increments_commit_model_only_count() {
    let mut session = session_with_song_dir("metadata-count-demo", demo_song());
    let audio = crate::audio_engine::AudioController::default();

    assert_eq!(
        audio.realtime_control_diagnostics().commit_model_only_count,
        0
    );

    session
        .update_track_metadata("track_1", "Renamed", &audio)
        .expect("metadata update should succeed");

    let diag = audio.realtime_control_diagnostics();
    assert_eq!(
        diag.commit_model_only_count, 1,
        "update_track_metadata must increment commit_model_only_count"
    );
    assert_eq!(
        diag.commit_mix_command_count, 0,
        "update_track_metadata must not increment commit_mix_command_count"
    );
    assert_eq!(
        diag.live_mix_realtime_command_count, 0,
        "update_track_metadata must not send any realtime audio command"
    );
}

/// Mute commit uses Category B (targeted command), never a full session reload.
#[test]
fn commit_mute_sends_targeted_command_not_session_reload() {
    let mut session = session_with_song_dir("commit-mute-demo", demo_song());
    let audio = crate::audio_engine::AudioController::default();

    session
        .commit_track_mix_model_and_command("track_1", None, None, Some(true), None, None, &audio)
        .expect("mute commit should succeed");

    let diag = audio.realtime_control_diagnostics();
    assert_eq!(
        diag.session_rebuild_count, 0,
        "mute commit must not rebuild session"
    );
    assert_eq!(
        diag.live_mix_realtime_command_count, 1,
        "mute commit must send exactly one command"
    );
    assert_eq!(diag.commit_mix_command_count, 1);
}

/// Solo commit uses Category B (targeted command), never a full session reload.
#[test]
fn commit_solo_sends_targeted_command_not_session_reload() {
    let mut session = session_with_song_dir("commit-solo-demo", demo_song());
    let audio = crate::audio_engine::AudioController::default();

    session
        .commit_track_mix_model_and_command("track_1", None, None, None, Some(true), None, &audio)
        .expect("solo commit should succeed");

    let diag = audio.realtime_control_diagnostics();
    assert_eq!(
        diag.session_rebuild_count, 0,
        "solo commit must not rebuild session"
    );
    assert_eq!(
        diag.live_mix_realtime_command_count, 1,
        "solo commit must send exactly one command"
    );
    assert_eq!(diag.commit_mix_command_count, 1);
}

/// Pan commit uses Category B (targeted command), never a full session reload.
#[test]
fn commit_pan_sends_targeted_command_not_session_reload() {
    let mut session = session_with_song_dir("commit-pan-demo", demo_song());
    let audio = crate::audio_engine::AudioController::default();

    session
        .commit_track_mix_model_and_command("track_1", None, Some(-0.5), None, None, None, &audio)
        .expect("pan commit should succeed");

    let diag = audio.realtime_control_diagnostics();
    assert_eq!(
        diag.session_rebuild_count, 0,
        "pan commit must not rebuild session"
    );
    assert_eq!(
        diag.live_mix_realtime_command_count, 1,
        "pan commit must send exactly one command"
    );
    assert_eq!(diag.commit_mix_command_count, 1);
}

/// Multiple mix commits accumulate commit_mix_command_count correctly.
#[test]
fn commit_mix_command_count_accumulates_across_multiple_commits() {
    let mut session = session_with_song_dir("commit-count-accum-demo", demo_song());
    let audio = crate::audio_engine::AudioController::default();

    for i in 1..=5 {
        session
            .commit_track_mix_model_and_command(
                "track_1",
                Some(i as f64 / 10.0),
                None,
                None,
                None,
                None,
                &audio,
            )
            .expect("commit should succeed");
    }

    assert_eq!(
        audio
            .realtime_control_diagnostics()
            .commit_mix_command_count,
        5
    );
    assert_eq!(
        audio.realtime_control_diagnostics().session_rebuild_count,
        0
    );
}

/// commit_model_only_count and commit_mix_command_count are independent counters.
#[test]
fn mix_and_metadata_commit_counts_are_independent() {
    let mut session = session_with_song_dir("commit-independent-demo", demo_song());
    let audio = crate::audio_engine::AudioController::default();

    session
        .update_track_metadata("track_1", "Renamed", &audio)
        .expect("name update should succeed");
    session
        .commit_track_mix_model_and_command("track_1", Some(0.5), None, None, None, None, &audio)
        .expect("mix commit should succeed");
    session
        .update_track_metadata("track_1", "Renamed Again", &audio)
        .expect("name update should succeed");

    let diag = audio.realtime_control_diagnostics();
    assert_eq!(diag.commit_model_only_count, 2, "two name updates");
    assert_eq!(diag.commit_mix_command_count, 1, "one mix commit");
    assert_eq!(diag.session_rebuild_count, 0);
}

#[test]
fn place_bundled_audio_reuses_existing_original_and_copies_missing_one() {
    let dir = tempdir().expect("tempdir");
    let song_dir = dir.path();

    // An original source that still exists on disk: the clip must keep
    // pointing at it and NO copy should be written into audio/.
    let original = song_dir.join("present.wav");
    fs::write(&original, b"present-bytes").expect("write original");
    let original_path = original.to_string_lossy().to_string();

    let mut song = build_empty_song("song_pkg".into(), "Pkg".into());
    song.clips.push(Clip {
        id: "clip_present".into(),
        track_id: "t".into(),
        file_path: original_path.clone(),
        timeline_start_seconds: 0.0,
        source_start_seconds: 0.0,
        duration_seconds: 1.0,
        gain: 1.0,
        fade_in_seconds: None,
        fade_out_seconds: None,
        color: None,
    });
    // A clip whose original is GONE: it must be copied into audio/ and
    // re-pointed there.
    song.clips.push(Clip {
        id: "clip_missing".into(),
        track_id: "t".into(),
        file_path: song_dir.join("gone.wav").to_string_lossy().to_string(),
        timeline_start_seconds: 0.0,
        source_start_seconds: 0.0,
        duration_seconds: 1.0,
        gain: 1.0,
        fade_in_seconds: None,
        fade_out_seconds: None,
        color: None,
    });

    let mut bundled = std::collections::HashMap::new();
    bundled.insert("present.wav".to_string(), b"present-bytes".to_vec());
    bundled.insert("gone.wav".to_string(), b"gone-bytes".to_vec());

    place_bundled_audio_and_repoint(song_dir, &mut song, &bundled).expect("place");

    // Present original: clip untouched, no copy created.
    assert_eq!(song.clips[0].file_path, original_path);
    assert!(
        !song_dir.join("audio").join("present.wav").exists(),
        "existing original must not be copied into audio/"
    );

    // Missing original: copied and re-pointed under audio/.
    assert_eq!(song.clips[1].file_path, "audio/gone.wav");
    assert_eq!(
        fs::read(song_dir.join("audio").join("gone.wav")).expect("copied"),
        b"gone-bytes"
    );
}
