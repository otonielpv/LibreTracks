//! Mix scenes in the session (plan live-scenes): a cue applying a pre-plan
//! scene, and the latch, restore and save rules built on the core's
//! `SceneLatches`.

use std::fs;

use libretracks_core::{Clip, Song, SongMaster, SongRegion, Track, TrackKind};
use libretracks_project::{create_song_folder, save_song, SONG_FILE_NAME};
use tempfile::tempdir;

use libretracks_core::mix_scene::{
    PanChange, SceneRule, TrackChange, TrackSelector, VolumeChange,
};
use libretracks_project::load_song_from_file;

use crate::audio::automation::{
    automation_file_path, save_automation, AutomationAction, MixScene, SceneMode,
};
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
                mode: SceneMode::Apply,
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
    // Cues fire while playing; stopped, a scene lands at once.
    session.engine.play().expect("play");
    session
        .apply_automation_action(
            &AutomationAction::ApplyScene {
                scene_id: "soft".into(),
                ramp_seconds: Some(2.0),
                mode: SceneMode::Apply,
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

// --- Paso 02: latch, restore, save --------------------------------------

/// "Music down": every track of the active song but the voices, -12 dB,
/// panned, muted and soloed so every field is exercised.
fn music_down(ramp_seconds: f64) -> MixScene {
    MixScene {
        id: "down".into(),
        name: "Bajar música".into(),
        ramp_seconds,
        rules: vec![SceneRule {
            select: TrackSelector::ActiveSong,
            except: vec![TrackSelector::NameContains {
                words: vec!["voz".into()],
            }],
            change: TrackChange {
                volume: Some(VolumeChange::RelativeDb(-12.0)),
                pan: Some(PanChange::Absolute(0.5)),
                muted: Some(true),
                solo: Some(true),
            },
        }],
    }
}

fn everything_down() -> MixScene {
    MixScene {
        id: "all".into(),
        name: "Todo".into(),
        ramp_seconds: 0.0,
        rules: vec![SceneRule {
            select: TrackSelector::ActiveSong,
            except: vec![],
            change: TrackChange {
                volume: Some(VolumeChange::Absolute(0.1)),
                ..TrackChange::default()
            },
        }],
    }
}

fn mix_of(session: &DesktopSession, track_id: &str) -> (f64, f64, bool, bool) {
    let track = track_of(session, track_id);
    (track.volume, track.pan, track.muted, track.solo)
}

const ALL_TRACKS: [&str; 4] = ["bass1", "voz1", "bass2", "voz2"];

#[test]
fn toggling_twice_leaves_every_field_as_it_was() {
    let mut session = two_song_session();
    let audio = AudioController::default();
    session.automation.mix_scenes.push(music_down(0.0));
    let before: Vec<_> = ALL_TRACKS.iter().map(|id| mix_of(&session, id)).collect();

    let snapshot = session
        .trigger_mix_scene("down", SceneMode::Toggle, &audio)
        .expect("engage");
    assert_eq!(snapshot.active_mix_scene_ids, vec!["down".to_string()]);
    let (volume, pan, muted, solo) = mix_of(&session, "bass1");
    assert!((volume - 0.8 * 10f64.powf(-0.6)).abs() < 1e-9);
    assert_eq!((pan, muted, solo), (0.5, true, true));
    // The voice and the second song are not touched.
    assert_eq!(mix_of(&session, "voz1"), before[1]);
    assert_eq!(mix_of(&session, "bass2"), before[2]);

    let snapshot = session
        .trigger_mix_scene("down", SceneMode::Toggle, &audio)
        .expect("release");
    assert!(snapshot.active_mix_scene_ids.is_empty());
    let after: Vec<_> = ALL_TRACKS.iter().map(|id| mix_of(&session, id)).collect();
    assert_eq!(after, before);
}

#[test]
fn a_track_moved_by_hand_keeps_the_value_it_was_given() {
    let mut session = two_song_session();
    let audio = AudioController::default();
    session.automation.mix_scenes.push(everything_down());
    session
        .trigger_mix_scene("all", SceneMode::Apply, &audio)
        .expect("engage");
    assert_eq!(track_of(&session, "voz1").volume, 0.1);

    // The fader commit, the same path a MIDI fader ends in.
    session
        .commit_track_mix_model_and_command("bass1", Some(0.33), None, None, None, None, &audio)
        .expect("commit fader");

    session
        .trigger_mix_scene("all", SceneMode::Restore, &audio)
        .expect("release");
    assert_eq!(track_of(&session, "bass1").volume, 0.33);
    assert_eq!(track_of(&session, "voz1").volume, 0.9);
}

#[test]
fn saving_with_a_scene_engaged_writes_the_mix_from_before() {
    let mut session = two_song_session();
    let audio = AudioController::default();
    session.automation.mix_scenes.push(music_down(0.0));
    session
        .trigger_mix_scene("down", SceneMode::Apply, &audio)
        .expect("engage");
    assert!(track_of(&session, "bass1").muted);

    session.save_project().expect("save");
    let song_file = session.song_file_path.clone().expect("song file");
    let reloaded = load_song_from_file(&song_file).expect("reload");
    let bass = reloaded.tracks.iter().find(|t| t.id == "bass1").unwrap();
    assert_eq!((bass.volume, bass.pan, bass.muted, bass.solo), (0.8, 0.0, false, false));

    let (_, exported, _) = session
        .prepare_session_package_export()
        .expect("ltset export source");
    let bass = exported.tracks.iter().find(|t| t.id == "bass1").unwrap();
    assert_eq!((bass.volume, bass.muted), (0.8, false));

    // The scene is still engaged and still sounding after the save.
    assert!(track_of(&session, "bass1").muted);
}

#[test]
fn toggling_adds_no_undo_entry_and_writes_no_automation() {
    let mut session = two_song_session();
    let audio = AudioController::default();
    session.automation.mix_scenes.push(music_down(0.0));
    let song_dir = session.song_dir.clone().unwrap();
    save_automation(&song_dir, &session.automation).expect("seed automation");
    let path = automation_file_path(&song_dir);
    let written = fs::read_to_string(&path).unwrap();
    let modified = fs::metadata(&path).unwrap().modified().unwrap();
    let undo = session.undo_stack.len();
    let revision = session.project_revision;

    session
        .trigger_mix_scene("down", SceneMode::Toggle, &audio)
        .expect("engage");
    session
        .trigger_mix_scene("down", SceneMode::Toggle, &audio)
        .expect("release");

    assert_eq!(session.undo_stack.len(), undo);
    assert_eq!(session.project_revision, revision);
    assert_eq!(fs::read_to_string(&path).unwrap(), written);
    assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), modified);
}

#[test]
fn releasing_mid_ramp_starts_from_where_the_ramp_was() {
    let mut session = two_song_session();
    let audio = AudioController::default();
    session.automation.mix_scenes.push(everything_down());
    session.engine.play().expect("play");

    session
        .trigger_mix_scene_runtime("all", SceneMode::Apply, Some(2.0), &audio)
        .expect("engage with ramp");
    let ramp = session
        .active_mix_ramps
        .iter()
        .find(|ramp| ramp.track_id == "bass1")
        .expect("bass ramp");
    assert_eq!(ramp.volume, Some((0.8, 0.1)));

    // Halfway through the ramp, before any tick mirrored it into the model.
    session.engine.seek(1.0).expect("move playhead");
    session
        .trigger_mix_scene_runtime("all", SceneMode::Restore, Some(2.0), &audio)
        .expect("release mid ramp");
    let ramp = session
        .active_mix_ramps
        .iter()
        .find(|ramp| ramp.track_id == "bass1")
        .expect("bass ramp back");
    let (from, to) = ramp.volume.expect("volume ramp");
    assert!((from - 0.45).abs() < 1e-9, "starts mid way, got {from}");
    assert_eq!(to, 0.8);
    assert_eq!(track_of(&session, "bass1").volume, 0.8);
}

#[test]
fn a_scene_triggered_while_stopped_lands_at_once() {
    let mut session = two_song_session();
    let audio = AudioController::default();
    let mut scene = everything_down();
    scene.ramp_seconds = 3.0;
    session.automation.mix_scenes.push(scene);
    session
        .trigger_mix_scene("all", SceneMode::Toggle, &audio)
        .expect("engage");
    assert!(session.active_mix_ramps.is_empty());
    assert_eq!(track_of(&session, "bass1").volume, 0.1);
}

#[test]
fn cues_engage_toggle_and_restore_a_scene() {
    let mut session = two_song_session();
    let audio = AudioController::default();
    session.automation.mix_scenes.push(everything_down());
    let cue = |mode| AutomationAction::ApplyScene {
        scene_id: "all".into(),
        ramp_seconds: None,
        mode,
    };

    // A restore of a scene nobody engaged does nothing.
    session
        .apply_automation_action(&cue(SceneMode::Restore), &audio)
        .unwrap();
    assert_eq!(track_of(&session, "bass1").volume, 0.8);

    session
        .apply_automation_action(&cue(SceneMode::Apply), &audio)
        .unwrap();
    assert_eq!(session.snapshot().active_mix_scene_ids, vec!["all".to_string()]);
    session
        .apply_automation_action(&cue(SceneMode::Toggle), &audio)
        .unwrap();
    assert!(session.snapshot().active_mix_scene_ids.is_empty());
    assert_eq!(track_of(&session, "bass1").volume, 0.8);
    session
        .apply_automation_action(&cue(SceneMode::Toggle), &audio)
        .unwrap();
    assert_eq!(track_of(&session, "bass1").volume, 0.1);
    session
        .apply_automation_action(&cue(SceneMode::Restore), &audio)
        .unwrap();
    assert_eq!(track_of(&session, "bass1").volume, 0.8);
}

#[test]
fn a_pre_plan_apply_scene_cue_has_the_apply_mode() {
    let action: AutomationAction =
        serde_json::from_str(r#"{"type":"applyScene","sceneId":"s","rampSeconds":2.0}"#)
            .expect("old cue parses");
    assert_eq!(
        action,
        AutomationAction::ApplyScene {
            scene_id: "s".into(),
            ramp_seconds: Some(2.0),
            mode: SceneMode::Apply,
        }
    );
    // Apply is written as before (no key); the others carry their mode.
    assert!(!serde_json::to_string(&action).unwrap().contains("mode"));
    let toggle = AutomationAction::ApplyScene {
        scene_id: "s".into(),
        ramp_seconds: None,
        mode: SceneMode::Toggle,
    };
    let json = serde_json::to_string(&toggle).unwrap();
    assert!(json.contains(r#""mode":"toggle""#), "{json}");
    assert_eq!(serde_json::from_str::<AutomationAction>(&json).unwrap(), toggle);
}

// --- Paso 03: order -------------------------------------------------------

#[test]
fn reordering_scenes_persists_the_new_order() {
    let mut session = two_song_session();
    let audio = AudioController::default();
    let named = |id: &str| MixScene {
        id: id.into(),
        name: id.into(),
        ramp_seconds: 0.0,
        rules: vec![],
    };
    session.automation.mix_scenes = vec![named("a"), named("b"), named("c")];

    let snapshot = session
        .reorder_mix_scenes(&["c".into(), "ghost".into(), "a".into()], &audio)
        .expect("reorder");
    let order: Vec<_> = snapshot.mix_scenes.iter().map(|scene| scene.id.as_str()).collect();
    assert_eq!(order, vec!["c", "a", "b"]);

    let saved = crate::audio::automation::load_automation(session.song_dir.as_ref().unwrap())
        .expect("load automation");
    let order: Vec<_> = saved.mix_scenes.iter().map(|scene| scene.id.as_str()).collect();
    assert_eq!(order, vec!["c", "a", "b"]);
}

// --- Paso 06: song changes and edge cases --------------------------------

/// "Music down" by rule: every audio track of the active song, -12 dB.
fn song_down(ramp_seconds: f64) -> MixScene {
    MixScene {
        id: "down".into(),
        name: "Bajar".into(),
        ramp_seconds,
        rules: vec![SceneRule {
            select: TrackSelector::ActiveSong,
            except: vec![],
            change: TrackChange {
                volume: Some(VolumeChange::RelativeDb(-12.0)),
                ..TrackChange::default()
            },
        }],
    }
}

fn down_12(volume: f64) -> f64 {
    volume * 10f64.powf(-12.0 / 20.0)
}

fn close(actual: f64, expected: f64) -> bool {
    (actual - expected).abs() < 1e-9
}

#[test]
fn an_engaged_scene_moves_to_the_next_song() {
    let mut session = two_song_session();
    let audio = AudioController::default();
    session.automation.mix_scenes.push(song_down(0.0));
    session.trigger_mix_scene("down", SceneMode::Apply, &audio).unwrap();
    assert!(close(track_of(&session, "bass1").volume, down_12(0.8)));
    assert_eq!(track_of(&session, "bass2").volume, 0.7);

    session.seek(13.0, &audio).expect("into song 2");
    assert_eq!(track_of(&session, "bass1").volume, 0.8, "song 1 back");
    assert_eq!(track_of(&session, "voz1").volume, 0.9);
    assert!(close(track_of(&session, "bass2").volume, down_12(0.7)), "song 2 down");
    assert_eq!(session.snapshot().active_mix_scene_ids, vec!["down".to_string()]);

    session.trigger_mix_scene("down", SceneMode::Restore, &audio).unwrap();
    assert_eq!(track_of(&session, "bass2").volume, 0.7);
    assert_eq!(track_of(&session, "voz2").volume, 0.6);
    assert_eq!(track_of(&session, "bass1").volume, 0.8);
}

#[test]
fn between_songs_the_scene_waits_for_the_next_one() {
    let mut session = two_song_session();
    let audio = AudioController::default();
    // A two-second gap between the songs.
    session.engine.song_mut().unwrap().regions[0].end_seconds = 10.0;
    session.automation.mix_scenes.push(song_down(0.0));
    session.trigger_mix_scene("down", SceneMode::Apply, &audio).unwrap();

    session.seek(11.0, &audio).expect("into the gap");
    assert_eq!(track_of(&session, "bass1").volume, 0.8, "the song that left is back");
    assert_eq!(track_of(&session, "bass2").volume, 0.7, "the next one not yet");
    assert_eq!(session.snapshot().active_mix_scene_ids, vec!["down".to_string()]);

    session.seek(13.0, &audio).expect("into song 2");
    assert!(close(track_of(&session, "bass2").volume, down_12(0.7)));
}

#[test]
fn stop_keeps_the_scene_and_a_cut_ramp_lands_on_its_value() {
    let mut session = two_song_session();
    let audio = AudioController::default();
    session.automation.mix_scenes.push(song_down(4.0));
    session.engine.play().expect("play");
    session
        .trigger_mix_scene_runtime("down", SceneMode::Apply, None, &audio)
        .unwrap();
    assert!(!session.active_mix_ramps.is_empty());
    // A tick halfway mirrored the ramp into the model.
    session.mirror_track_mix_into_model("bass1", Some(0.5), None, None, None);

    session.stop(&audio).expect("stop");
    assert!(session.active_mix_ramps.is_empty());
    assert!(close(track_of(&session, "bass1").volume, down_12(0.8)), "landed, not mid-way");
    assert_eq!(session.snapshot().active_mix_scene_ids, vec!["down".to_string()]);

    // Same for a seek inside the song.
    session.trigger_mix_scene("down", SceneMode::Restore, &audio).unwrap();
    session.engine.play().expect("play");
    session
        .trigger_mix_scene_runtime("down", SceneMode::Apply, None, &audio)
        .unwrap();
    session.mirror_track_mix_into_model("bass1", Some(0.5), None, None, None);
    session.seek(5.0, &audio).expect("seek in song 1");
    assert!(session.active_mix_ramps.is_empty());
    assert!(close(track_of(&session, "bass1").volume, down_12(0.8)));
}

#[test]
fn editing_or_deleting_an_engaged_scene_leaves_the_mix_right() {
    let mut session = two_song_session();
    let audio = AudioController::default();
    session.automation.mix_scenes.push(song_down(0.0));
    session.trigger_mix_scene("down", SceneMode::Apply, &audio).unwrap();

    // Now only the bass, and to a fixed level.
    let mut edited = song_down(0.0);
    edited.rules = vec![SceneRule {
        select: TrackSelector::NameContains {
            words: vec!["bajo".into()],
        },
        except: vec![],
        change: TrackChange {
            volume: Some(VolumeChange::Absolute(0.2)),
            ..TrackChange::default()
        },
    }];
    session.upsert_mix_scene(edited, &audio).expect("edit");
    assert_eq!(track_of(&session, "bass1").volume, 0.2);
    assert_eq!(track_of(&session, "voz1").volume, 0.9, "the voice left the scene");

    session.delete_mix_scene("down", &audio).expect("delete");
    assert_eq!(track_of(&session, "bass1").volume, 0.8, "restored before deleting");
    assert!(session.snapshot().active_mix_scene_ids.is_empty());
}

#[test]
fn deleting_an_engaged_track_then_releasing_restores_the_rest() {
    let mut session = two_song_session();
    let audio = AudioController::default();
    session.automation.mix_scenes.push(song_down(0.0));
    session.trigger_mix_scene("down", SceneMode::Apply, &audio).unwrap();

    session.delete_tracks(&["bass1".into()], &audio).expect("delete track");
    session
        .trigger_mix_scene("down", SceneMode::Restore, &audio)
        .expect("release without error");
    assert_eq!(track_of(&session, "voz1").volume, 0.9);
}

// --- Paso 07: scenes in session templates --------------------------------

fn template_session() -> (DesktopSession, std::path::PathBuf, tempfile::TempDir) {
    let mut session = two_song_session();
    let mut by_id = everything_down();
    by_id.id = "by-id".into();
    by_id.rules[0].select = TrackSelector::Track {
        track_id: "bass1".into(),
    };
    session.automation.mix_scenes = vec![music_down(2.0), by_id];
    let temp = tempfile::tempdir().expect("tempdir");
    let template_path = temp.path().join("Banda.lttemplate");
    (session, template_path, temp)
}

#[test]
fn a_template_carries_only_the_scenes_made_of_rules() {
    let (session, template_path, _temp) = template_session();
    let dropped = session
        .save_current_as_template(template_path.clone())
        .expect("save template");
    assert_eq!(dropped, 1);
    let document: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&template_path).unwrap()).unwrap();
    let ids: Vec<&str> = document["mixScenes"]
        .as_array()
        .expect("scenes in the template")
        .iter()
        .map(|scene| scene["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec!["down"]);
    // An app from before the plan reads the same file: the song parses and
    // the extra key is ignored.
    let song = load_song_from_file(&template_path).expect("older reader still parses it");
    assert_eq!(song.tracks.len(), 4);
}

#[test]
fn a_session_from_the_template_has_the_scene_and_it_works() {
    let (session, template_path, temp) = template_session();
    session.save_current_as_template(template_path.clone()).unwrap();

    let mut fresh = DesktopSession::default();
    let audio = AudioController::default();
    fresh
        .create_song_from_template_path(
            template_path,
            temp.path().join("Domingo.ltsession"),
            super::ExistingProjectDir::Refuse,
            &audio,
        )
        .expect("create from template");
    let ids: Vec<String> = fresh.automation.mix_scenes.iter().map(|s| s.id.clone()).collect();
    assert_eq!(ids, vec!["down".to_string()]);
    let saved = crate::audio::automation::load_automation(fresh.song_dir.as_ref().unwrap()).unwrap();
    assert_eq!(saved.mix_scenes.len(), 1, "written to the new session's automation file");

    // A song imported afterwards: its tracks get the scene.
    {
        let song = fresh.engine.song_mut().unwrap();
        song.regions = vec![region("r1", 0.0, 12.0)];
        song.tracks = vec![track("bajo", "Bajo", 0.8), track("voz", "Voz", 0.9)];
        song.clips = vec![clip("bajo", 1.0), clip("voz", 1.0)];
    }
    fresh.trigger_mix_scene("down", SceneMode::Apply, &audio).unwrap();
    assert!(track_of(&fresh, "bajo").muted);
    assert!(!track_of(&fresh, "voz").muted, "the voice is excepted");
}

#[test]
fn a_template_from_before_the_plan_opens_without_scenes() {
    let temp = tempfile::tempdir().expect("tempdir");
    let template_path = temp.path().join("Vieja.lttemplate");
    let template = super::strip_song_to_template(track_of_song(&two_song_session()));
    libretracks_project::save_song_to_file(&template_path, &template).expect("old template");
    assert!(!fs::read_to_string(&template_path).unwrap().contains("mixScenes"));

    let mut fresh = DesktopSession::default();
    fresh
        .create_song_from_template_path(
            template_path,
            temp.path().join("Nueva.ltsession"),
            super::ExistingProjectDir::Refuse,
            &AudioController::default(),
        )
        .expect("old template opens");
    assert!(fresh.automation.mix_scenes.is_empty());
}

fn track_of_song(session: &DesktopSession) -> Song {
    session.engine.song().cloned().expect("song loaded")
}
