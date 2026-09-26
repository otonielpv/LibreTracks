//! Arrangement and undo coverage for video clips (paso 03 del plan de vídeo).
//!
//! The rule under test: a video clip follows the song holding its start
//! exactly like an audio clip does — moved, pushed and deleted with it — and
//! every video edit is one undo step.

use std::fs;

use libretracks_core::{Clip, Song, SongMaster, SongRegion, Track, TrackKind, VideoClip, VideoFit};
use libretracks_project::{create_song_folder, save_song, SONG_FILE_NAME};
use tempfile::tempdir;

use crate::audio::engine::AudioController;

use super::{DesktopSession, VideoClipProps};

fn region(id: &str, start: f64, end: f64) -> SongRegion {
    SongRegion {
        id: id.into(),
        name: id.into(),
        start_seconds: start,
        end_seconds: end,
        transpose_semitones: 0,
        key: None,
        warp_enabled: false,
        warp_source_bpm: None,
        master: SongMaster::default(),
        compact_column_width_rem: None,
    }
}

fn track(id: &str, kind: TrackKind) -> Track {
    Track {
        id: id.into(),
        name: id.into(),
        kind,
        parent_track_id: None,
        volume: 1.0,
        pan: 0.0,
        muted: false,
        solo: false,
        transpose_enabled: true,
        audio_to: "master".into(),
        mono_downmix: false,
        color: None,
        auto_created: false,
        midi_port: None,
        midi_channel: 1,
        midi_enabled: true,
        collapsed: false,
        height_offset: None,
    }
}

fn audio_clip(id: &str, start: f64) -> Clip {
    Clip {
        id: id.into(),
        track_id: "a1".into(),
        file_path: "audio/test.wav".into(),
        timeline_start_seconds: start,
        source_start_seconds: 0.0,
        duration_seconds: 4.0,
        gain: 1.0,
        fade_in_seconds: None,
        fade_out_seconds: None,
        color: None,
    }
}

fn video_clip(id: &str, track_id: &str, start: f64) -> VideoClip {
    VideoClip {
        id: id.into(),
        track_id: track_id.into(),
        file_path: "D:/Visuales/letras.mp4".into(),
        timeline_start_seconds: start,
        source_start_seconds: 0.0,
        duration_seconds: 6.0,
        fade_in_seconds: None,
        fade_out_seconds: None,
        fit: None,
        color: None,
    }
}

/// Two songs of 12 s. Each has an audio clip at +1 s and a video clip at +2 s.
fn two_song_session() -> DesktopSession {
    let song = Song {
        id: "video_arrangement".into(),
        title: "Video".into(),
        artist: None,
        key: None,
        bpm: 120.0,
        time_signature: "4/4".into(),
        duration_seconds: 24.0,
        tempo_markers: vec![],
        time_signature_markers: vec![],
        regions: vec![region("r1", 0.0, 12.0), region("r2", 12.0, 24.0)],
        tracks: vec![
            track("a1", TrackKind::Audio),
            track("v1", TrackKind::Video),
            track("v2", TrackKind::Video),
        ],
        clips: vec![audio_clip("c1", 1.0), audio_clip("c2", 13.0)],
        midi_clips: vec![],
        video_clips: vec![video_clip("vc1", "v1", 2.0), video_clip("vc2", "v1", 14.0)],
        section_markers: vec![],
    };

    let root = tempdir().expect("temp dir").keep();
    let song_dir = create_song_folder(&root, "video_arrangement").expect("song dir");
    fs::create_dir_all(song_dir.join("audio")).expect("audio dir");
    super::tests::write_silent_test_wav(&song_dir.join("audio").join("test.wav"), 12);
    save_song(&song_dir, &song).expect("save song");

    let mut session = DesktopSession::default();
    session.song_file_path = Some(song_dir.join(SONG_FILE_NAME));
    session.song_dir = Some(song_dir);
    session.engine.load_song(song).expect("load song");
    session
}

fn song(session: &DesktopSession) -> Song {
    session.engine.song().cloned().expect("song loaded")
}

fn video_start(session: &DesktopSession, id: &str) -> Option<f64> {
    song(session)
        .video_clips
        .iter()
        .find(|clip| clip.id == id)
        .map(|clip| clip.timeline_start_seconds)
}

fn audio_start(session: &DesktopSession, id: &str) -> Option<f64> {
    song(session)
        .clips
        .iter()
        .find(|clip| clip.id == id)
        .map(|clip| clip.timeline_start_seconds)
}

#[test]
fn moving_a_song_moves_its_video_clips_like_its_audio_clips() {
    let mut session = two_song_session();
    let audio = AudioController::default();
    session
        .move_song_region("r2", 4.0, &audio)
        .expect("move second song right");

    assert_eq!(audio_start(&session, "c2"), Some(17.0));
    assert_eq!(video_start(&session, "vc2"), Some(18.0));
    // The other song's clips stay put.
    assert_eq!(audio_start(&session, "c1"), Some(1.0));
    assert_eq!(video_start(&session, "vc1"), Some(2.0));
}

#[test]
fn a_song_pushed_by_another_takes_its_video_clips_along() {
    let mut session = two_song_session();
    let audio = AudioController::default();
    // Dropping the first song on top of the second cascades the second one.
    session
        .move_song_region("r1", 6.0, &audio)
        .expect("move first song into the second");

    let pushed = song(&session);
    let r2 = pushed
        .regions
        .iter()
        .find(|region| region.id == "r2")
        .expect("r2 survives");
    let c2_delta = audio_start(&session, "c2").expect("c2") - 13.0;
    let vc2_delta = video_start(&session, "vc2").expect("vc2") - 14.0;
    assert!(c2_delta > 0.0, "the second song was pushed");
    assert!(
        (c2_delta - vc2_delta).abs() < 1e-9,
        "video pushed by {vc2_delta}, audio by {c2_delta}"
    );
    assert!(video_start(&session, "vc2").expect("vc2") >= r2.start_seconds);
}

#[test]
fn deleting_a_song_deletes_its_video_clips() {
    let mut session = two_song_session();
    let audio = AudioController::default();
    session
        .delete_song_region("r2", &audio)
        .expect("delete second song");

    assert_eq!(video_start(&session, "vc2"), None);
    assert_eq!(video_start(&session, "vc1"), Some(2.0));
}

#[test]
fn deleting_a_video_track_takes_its_clips_and_leaves_the_others() {
    let mut session = two_song_session();
    let audio = AudioController::default();
    session
        .move_video_clip("vc2", 14.0, Some("v2"), &audio)
        .expect("move vc2 to the second video track");
    session
        .delete_tracks(&["v1".to_string()], &audio)
        .expect("delete first video track");

    let after = song(&session);
    assert!(after.video_clips.iter().all(|clip| clip.track_id == "v2"));
    assert_eq!(after.video_clips.len(), 1);
    assert!(after.tracks.iter().any(|track| track.id == "v2"));
}

#[test]
fn a_song_holding_only_video_is_not_pruned_as_empty() {
    let mut session = two_song_session();
    let audio = AudioController::default();
    // Removing the audio track leaves the songs with video only; the pruning
    // that deleting a track runs must not take the songs with it.
    session
        .delete_tracks(&["a1".to_string()], &audio)
        .expect("delete audio track");
    assert_eq!(song(&session).regions.len(), 2);
}

#[test]
fn video_clips_cannot_be_moved_to_a_non_video_track() {
    let mut session = two_song_session();
    let audio = AudioController::default();
    assert!(session
        .move_video_clip("vc1", 3.0, Some("a1"), &audio)
        .is_err());
    assert_eq!(video_start(&session, "vc1"), Some(2.0));
}

#[test]
fn soloing_a_video_track_does_not_reach_the_engine() {
    let mut session = two_song_session();
    let audio = AudioController::default();
    session
        .update_track("v1", None, None, None, None, Some(true), None, &audio)
        .expect("solo video track");
    assert!(song(&session)
        .tracks
        .iter()
        .any(|track| track.id == "v1" && track.solo));
    let diagnostics = audio.realtime_control_diagnostics();
    assert_eq!(diagnostics.live_mix_realtime_command_count, 0);
    assert_eq!(diagnostics.commit_mix_command_count, 0);
    assert_eq!(diagnostics.commit_model_only_count, 1);
}

/// Apply `edit`, then check undo restores the clips as they were and redo
/// brings the edit back.
fn assert_undoable(edit: impl FnOnce(&mut DesktopSession, &AudioController)) {
    let mut session = two_song_session();
    let audio = AudioController::default();
    let before = song(&session).video_clips;

    edit(&mut session, &audio);
    let after = song(&session).video_clips;
    assert_ne!(after, before, "the edit changed nothing");

    session.undo_action(&audio).expect("undo");
    assert_eq!(song(&session).video_clips, before, "undo restores");
    session.redo_action(&audio).expect("redo");
    assert_eq!(song(&session).video_clips, after, "redo re-applies");
}

#[test]
fn creating_a_video_clip_is_undoable() {
    assert_undoable(|session, audio| {
        session
            .create_video_clip("v2", "D:/Visuales/fondo.mov", 3.0, 0.0, 10.0, audio)
            .expect("create");
    });
}

#[test]
fn moving_a_video_clip_is_undoable() {
    assert_undoable(|session, audio| {
        session
            .move_video_clip("vc1", 5.0, None, audio)
            .expect("move");
    });
}

#[test]
fn trimming_a_video_clip_is_undoable() {
    assert_undoable(|session, audio| {
        session
            .trim_video_clip("vc1", 3.0, 7.0, audio)
            .expect("trim");
    });
}

#[test]
fn splitting_a_video_clip_is_undoable() {
    assert_undoable(|session, audio| {
        session
            .split_video_clips(&["vc1".to_string()], 4.0, audio)
            .expect("split");
    });
}

#[test]
fn deleting_a_video_clip_is_undoable() {
    assert_undoable(|session, audio| {
        session
            .delete_video_clips(&["vc1".to_string()], audio)
            .expect("delete");
    });
}

#[test]
fn duplicating_and_restyling_a_video_clip_are_undoable() {
    assert_undoable(|session, audio| {
        session
            .duplicate_video_clips(&["vc1".to_string()], audio)
            .expect("duplicate");
    });
    assert_undoable(|session, audio| {
        session
            .update_video_clip(
                "vc1",
                VideoClipProps {
                    fade_in_seconds: Some(1.0),
                    fade_out_seconds: Some(0.5),
                    fit: Some(VideoFit::Stretch),
                    color: Some("#00ff00".into()),
                },
                audio,
            )
            .expect("update");
    });
}

#[test]
fn placing_videos_on_an_audio_track_creates_a_video_track_next_to_it() {
    let mut session = two_song_session();
    let audio = AudioController::default();
    session
        .place_video_clips(
            &[
                ("D:/Visuales/intro.mp4".into(), 5.0),
                ("D:/Visuales/coro.mp4".into(), 3.0),
            ],
            1.0,
            Some("a1"),
            &audio,
        )
        .expect("place");
    let after = song(&session);
    let new_track = &after.tracks[1];
    assert_eq!(new_track.kind, TrackKind::Video);
    assert_eq!(new_track.name, "intro");
    let placed: Vec<_> = after
        .video_clips
        .iter()
        .filter(|clip| clip.track_id == new_track.id)
        .map(|clip| (clip.timeline_start_seconds, clip.duration_seconds))
        .collect();
    assert_eq!(placed, vec![(1.0, 5.0), (6.0, 3.0)]);
    // One undo step removes the clips and the track together.
    session.undo_action(&audio).expect("undo");
    assert_eq!(song(&session).tracks.len(), 3);
}

#[test]
fn placing_videos_on_a_video_track_uses_it() {
    let mut session = two_song_session();
    let audio = AudioController::default();
    session
        .place_video_clips(&[("D:/x.mp4".into(), 2.0)], 8.0, Some("v2"), &audio)
        .expect("place");
    let after = song(&session);
    assert_eq!(after.tracks.len(), 3);
    assert!(after
        .video_clips
        .iter()
        .any(|clip| clip.track_id == "v2" && clip.timeline_start_seconds == 8.0));
}

/// Paso 05, C6: editing and saving a session that holds video — which is what
/// a phone does, where video is read-only — keeps every video clip intact.
#[test]
fn editing_and_saving_keeps_video_clips_intact() {
    let mut session = two_song_session();
    let audio = AudioController::default();
    let before = song(&session).video_clips;

    session
        .move_clip("c1", 2.0, &audio)
        .expect("an audio edit, as on mobile");
    session.save_project().expect("save");

    let saved = libretracks_project::load_song_from_file(
        session.song_file_path.as_ref().expect("song file"),
    )
    .expect("reload");
    assert_eq!(saved.video_clips, before);
    assert!(saved
        .tracks
        .iter()
        .any(|track| track.kind == TrackKind::Video));
}
