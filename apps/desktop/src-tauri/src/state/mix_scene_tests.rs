//! Mix scenes in the session (plan live-scenes): a cue applying a pre-plan
//! scene, and the latch, restore and save rules built on the core's
//! `SceneLatches`.

use std::fs;

use libretracks_core::{Clip, Song, SongMaster, SongRegion, Track, TrackKind};
use libretracks_project::{create_song_folder, save_song, SONG_FILE_NAME};
use tempfile::tempdir;

use crate::audio::automation::{AutomationAction, MixScene};
use crate::audio::engine::AudioController;

use super::DesktopSession;

fn region(id: &str, start: f64, end: f64) -> SongRegion {
    SongRegion {
        key_changes: Vec::new(),
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
        chart: None,
        cover_image: None,
        voice_guide_count_style: None,
        structure: None,
    }
}

fn track(id: &str, name: &str, volume: f64) -> Track {
    Track {
        id: id.into(),
        name: name.into(),
        kind: TrackKind::Audio,
        parent_track_id: None,
        volume,
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
        match_aliases: Vec::new(),
        song_region_id: None,
    }
}

fn clip(track_id: &str, start: f64) -> Clip {
    Clip {
        id: format!("clip_{track_id}"),
        track_id: track_id.into(),
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

/// Two 12 s songs, each with a bass and a voice.
pub(super) fn two_song_session() -> DesktopSession {
    let song = Song {
        id: "scenes".into(),
        title: "Scenes".into(),
        artist: None,
        key: None,
        bpm: 120.0,
        time_signature: "4/4".into(),
        duration_seconds: 24.0,
        tempo_markers: vec![],
        time_signature_markers: vec![],
        regions: vec![region("r1", 0.0, 12.0), region("r2", 12.0, 24.0)],
        tracks: vec![
            track("bass1", "Bajo", 0.8),
            track("voz1", "Voz", 0.9),
            track("bass2", "Bajo", 0.7),
            track("voz2", "Voz", 0.6),
        ],
        clips: vec![
            clip("bass1", 1.0),
            clip("voz1", 1.0),
            clip("bass2", 13.0),
            clip("voz2", 13.0),
        ],
        midi_clips: vec![],
        video_clips: vec![],
        section_markers: vec![],
    };

    let root = tempdir().expect("temp dir").keep();
    let song_dir = create_song_folder(&root, "scenes").expect("song dir");
    fs::create_dir_all(song_dir.join("audio")).expect("audio dir");
    super::tests::write_silent_test_wav(&song_dir.join("audio").join("test.wav"), 24);
    save_song(&song_dir, &song).expect("save song");

    let mut session = DesktopSession::default();
    session.song_file_path = Some(song_dir.join(SONG_FILE_NAME));
    session.song_dir = Some(song_dir);
    session.engine.load_song(song).expect("load song");
    session
}

pub(super) fn track_of(session: &DesktopSession, track_id: &str) -> Track {
    session
        .engine
        .song()
        .and_then(|song| song.tracks.iter().find(|track| track.id == track_id))
        .cloned()
        .expect("track exists")
}

#[test]
fn a_cue_applies_a_pre_plan_scene_as_before() {
    let mut session = two_song_session();
    let audio = AudioController::default();
    let scene: MixScene = serde_json::from_str(
        r#"{
            "id": "soft",
            "name": "Soft",
            "trackOverrides": [
                { "trackId": "bass1", "volume": 0.4, "muted": true },
                { "trackId": "voz2", "pan": -0.5, "solo": true },
                { "trackId": "missing", "volume": 0.1 }
            ]
        }"#,
    )
    .expect("pre-plan scene parses");
    session.automation.mix_scenes.push(scene);

    session
        .apply_automation_action(
            &AutomationAction::ApplyScene {
                scene_id: "soft".into(),
                ramp_seconds: None,
            },
            &audio,
        )
        .expect("apply scene");

    let bass = track_of(&session, "bass1");
    assert_eq!((bass.volume, bass.pan, bass.muted, bass.solo), (0.4, 0.0, true, false));
    // A scene by id reaches a track of another song: ids do not follow the
    // active song.
    let voice = track_of(&session, "voz2");
    assert_eq!((voice.volume, voice.pan, voice.muted, voice.solo), (0.6, -0.5, false, true));
    let untouched = track_of(&session, "voz1");
    assert_eq!((untouched.volume, untouched.muted), (0.9, false));
    assert!(session.active_mix_ramps.is_empty());

    // With a ramp the model lands at once and the ramp moves volume/pan.
    let mut session = two_song_session();
    session.automation.mix_scenes = vec![serde_json::from_str(
        r#"{"id":"soft","name":"Soft","trackOverrides":[{"trackId":"bass1","volume":0.4}]}"#,
    )
    .unwrap()];
    session
        .apply_automation_action(
            &AutomationAction::ApplyScene {
                scene_id: "soft".into(),
                ramp_seconds: Some(2.0),
            },
            &audio,
        )
        .expect("apply scene with ramp");
    assert_eq!(track_of(&session, "bass1").volume, 0.4);
    let ramp = &session.active_mix_ramps[0];
    assert_eq!(ramp.track_id, "bass1");
    assert_eq!(ramp.volume, Some((0.8, 0.4)));
    assert_eq!(ramp.pan, None);
}
