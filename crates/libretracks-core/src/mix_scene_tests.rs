use std::collections::HashSet;

use serde_json::json;

use crate::mix_scene::{
    active_song_track_ids, apply_change, resolve_scene, MixScene, PanChange, ResolvedChange,
    SceneLatches, SceneRule, TrackChange, TrackMix, TrackSelector, VolumeChange,
};
use crate::model::Song;

const PRE_PLAN_AUTOMATION: &str = include_str!("../fixtures/pre_live_scenes.ltautomation");

fn track(id: &str, name: &str, kind: &str, parent: Option<&str>) -> serde_json::Value {
    json!({
        "id": id, "name": name, "kind": kind, "parentTrackId": parent,
        "volume": 1.0, "pan": 0.0, "muted": false, "solo": false, "audioTo": "master"
    })
}

fn clip(track_id: &str, start: f64) -> serde_json::Value {
    json!({
        "id": format!("clip_{track_id}_{start}"), "trackId": track_id, "filePath": "a.wav",
        "timelineStartSeconds": start, "sourceStartSeconds": 0.0, "durationSeconds": 5.0,
        "gain": 1.0, "fadeInSeconds": null, "fadeOutSeconds": null
    })
}

fn song(
    regions: &[(&str, f64, f64)],
    tracks: Vec<serde_json::Value>,
    clips: Vec<serde_json::Value>,
    midi_clips: Vec<(&str, f64)>,
) -> Song {
    let regions: Vec<_> = regions
        .iter()
        .map(|(id, start, end)| {
            json!({"id": id, "name": id, "startSeconds": start, "endSeconds": end})
        })
        .collect();
    let midi_clips: Vec<_> = midi_clips
        .iter()
        .map(|(track_id, start)| {
            json!({"id": format!("m_{track_id}"), "trackId": track_id, "timelineStartSeconds": start})
        })
        .collect();
    serde_json::from_value(json!({
        "id": "song", "title": "Sesion", "artist": null, "key": null, "bpm": 120,
        "timeSignature": "4/4", "durationSeconds": 300, "tempoMarkers": [],
        "timeSignatureMarkers": [], "regions": regions, "tracks": tracks, "clips": clips,
        "midiClips": midi_clips, "sectionMarkers": []
    }))
    .expect("test song parses")
}

fn ids(set: &HashSet<String>) -> Vec<&str> {
    let mut out: Vec<&str> = set.iter().map(String::as_str).collect();
    out.sort();
    out
}

fn mix(volume: f64) -> TrackMix {
    TrackMix {
        volume,
        pan: 0.0,
        muted: false,
        solo: false,
    }
}

fn volume_db(track_id: &str, db: f64) -> ResolvedChange {
    ResolvedChange {
        track_id: track_id.into(),
        change: TrackChange {
            volume: Some(VolumeChange::RelativeDb(db)),
            ..TrackChange::default()
        },
    }
}

fn volume_abs(track_id: &str, volume: f64) -> ResolvedChange {
    ResolvedChange {
        track_id: track_id.into(),
        change: TrackChange {
            volume: Some(VolumeChange::Absolute(volume)),
            ..TrackChange::default()
        },
    }
}

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-9
}

// --- C1: migration --------------------------------------------------------

#[test]
fn pre_plan_scenes_load_as_absolute_track_rules() {
    let document: serde_json::Value = serde_json::from_str(PRE_PLAN_AUTOMATION).unwrap();
    let scenes: Vec<MixScene> = serde_json::from_value(document["mixScenes"].clone()).unwrap();
    assert_eq!(scenes.len(), 3);

    let soft = &scenes[0];
    assert_eq!(soft.name, "Ministrar");
    assert_eq!(soft.ramp_seconds, 0.0);
    assert_eq!(
        soft.rules,
        vec![
            SceneRule {
                select: TrackSelector::Track {
                    track_id: "track_drums".into()
                },
                except: vec![],
                change: TrackChange {
                    volume: Some(VolumeChange::Absolute(0.4)),
                    pan: None,
                    muted: Some(false),
                    solo: None,
                },
            },
            SceneRule {
                select: TrackSelector::Track {
                    track_id: "track_bass".into()
                },
                except: vec![],
                change: TrackChange {
                    pan: Some(PanChange::Absolute(-0.25)),
                    ..TrackChange::default()
                },
            },
            SceneRule {
                select: TrackSelector::Track {
                    track_id: "track_keys".into()
                },
                except: vec![],
                change: TrackChange {
                    solo: Some(true),
                    ..TrackChange::default()
                },
            },
        ]
    );
    assert!(scenes[1].rules.is_empty());
    assert!(scenes[2].rules.is_empty());

    // Saving writes only the new form, and reloading it changes nothing.
    let saved = serde_json::to_string(&scenes).unwrap();
    assert!(!saved.contains("trackOverrides"));
    let reloaded: Vec<MixScene> = serde_json::from_str(&saved).unwrap();
    assert_eq!(reloaded, scenes);
}

// --- C2: serde round trips ------------------------------------------------

#[test]
fn every_selector_and_change_round_trips_in_camel_case() {
    let scene = MixScene {
        id: "s".into(),
        name: "Todo".into(),
        ramp_seconds: 2.0,
        rules: vec![
            SceneRule {
                select: TrackSelector::ActiveSong,
                except: vec![
                    TrackSelector::NameContains {
                        words: vec!["voz".into(), "vox".into()],
                    },
                    TrackSelector::Folder {
                        name: "Voces".into(),
                    },
                    TrackSelector::Track {
                        track_id: "t1".into(),
                    },
                ],
                change: TrackChange {
                    volume: Some(VolumeChange::RelativeDb(-12.0)),
                    pan: Some(PanChange::Relative(0.25)),
                    muted: None,
                    solo: None,
                },
            },
            SceneRule {
                select: TrackSelector::Track {
                    track_id: "t2".into(),
                },
                except: vec![],
                change: TrackChange {
                    volume: Some(VolumeChange::Absolute(0.5)),
                    pan: Some(PanChange::Absolute(-1.0)),
                    muted: Some(true),
                    solo: Some(false),
                },
            },
        ],
    };
    let value = serde_json::to_value(&scene).unwrap();
    assert_eq!(value["rampSeconds"], json!(2.0));
    let rule = &value["rules"][0];
    assert_eq!(rule["select"], json!({"type": "activeSong"}));
    assert_eq!(
        rule["except"][0],
        json!({"type": "nameContains", "words": ["voz", "vox"]})
    );
    assert_eq!(rule["except"][1], json!({"type": "folder", "name": "Voces"}));
    assert_eq!(rule["except"][2], json!({"type": "track", "trackId": "t1"}));
    assert_eq!(rule["change"]["volume"], json!({"type": "relativeDb", "value": -12.0}));
    assert_eq!(rule["change"]["pan"], json!({"type": "relative", "value": 0.25}));
    let second = &value["rules"][1]["change"];
    assert_eq!(second["volume"], json!({"type": "absolute", "value": 0.5}));
    assert_eq!(second["pan"], json!({"type": "absolute", "value": -1.0}));
    assert!(value["rules"][1].get("except").is_none());

    let back: MixScene = serde_json::from_value(value).unwrap();
    assert_eq!(back, scene);
}

// --- C3: active song ------------------------------------------------------

fn bank_song() -> Song {
    // The same session as "strips follow the active song" in
    // midiBankStore.test.ts.
    song(
        &[("r1", 0.0, 100.0), ("r2", 100.0, 200.0), ("r3", 200.0, 300.0)],
        vec![
            track("s1-drums", "Drums", "folder", None),
            track("s1-kick", "Kick", "audio", Some("s1-drums")),
            track("s1-bass", "Bass", "audio", None),
            track("s2-bass", "Bass", "audio", None),
            track("s2-keys", "Keys", "midi", None),
        ],
        vec![clip("s1-kick", 0.0), clip("s1-bass", 10.0), clip("s2-bass", 100.0)],
        vec![("s2-keys", 150.0)],
    )
}

#[test]
fn active_song_tracks_match_the_strip_bank() {
    let song = bank_song();
    let first = active_song_track_ids(&song, 50.0).unwrap();
    assert_eq!(ids(&first), vec!["s1-bass", "s1-drums", "s1-kick"]);
    let second = active_song_track_ids(&song, 120.0).unwrap();
    assert_eq!(ids(&second), vec!["s2-bass", "s2-keys"]);
    // A song whose region holds no clip, and a position outside every song.
    assert_eq!(active_song_track_ids(&song, 250.0), None);
    assert_eq!(active_song_track_ids(&song, 400.0), None);
}

#[test]
fn active_song_climbs_nested_folders() {
    let song = song(
        &[("r1", 0.0, 100.0)],
        vec![
            track("band", "Banda", "folder", None),
            track("drums", "Drums", "folder", Some("band")),
            track("kick", "Kick", "audio", Some("drums")),
            track("other", "Otra", "audio", None),
        ],
        vec![clip("kick", 0.0)],
        vec![],
    );
    let active = active_song_track_ids(&song, 1.0).unwrap();
    assert_eq!(ids(&active), vec!["band", "drums", "kick"]);
}

// --- C4: resolving --------------------------------------------------------

fn worship_song() -> Song {
    song(
        &[("r1", 0.0, 100.0), ("r2", 100.0, 200.0)],
        vec![
            track("bajo", "Bajo", "audio", None),
            track("voz1", "Voz 1", "audio", None),
            track("vox", "VOX", "audio", None),
            track("guia", "Vóz guía", "audio", None),
            track("inst", "Instrumentos", "folder", None),
            track("piano", "Piano", "audio", Some("inst")),
            track("video", "Video", "video", Some("inst")),
            track("other_bajo", "Bajo", "audio", None),
        ],
        vec![
            clip("bajo", 0.0),
            clip("voz1", 0.0),
            clip("vox", 0.0),
            clip("guia", 0.0),
            clip("piano", 0.0),
            clip("other_bajo", 100.0),
        ],
        vec![],
    )
}

fn rule(select: TrackSelector, except: Vec<TrackSelector>) -> SceneRule {
    SceneRule {
        select,
        except,
        change: TrackChange {
            volume: Some(VolumeChange::RelativeDb(-12.0)),
            ..TrackChange::default()
        },
    }
}

fn scene(rules: Vec<SceneRule>) -> MixScene {
    MixScene {
        id: "s".into(),
        name: "s".into(),
        ramp_seconds: 0.0,
        rules,
    }
}

fn picked(scene: &MixScene, song: &Song, position: f64) -> Vec<String> {
    let active = active_song_track_ids(song, position);
    resolve_scene(scene, song, active.as_ref())
        .into_iter()
        .map(|change| change.track_id)
        .collect()
}

#[test]
fn active_song_except_voices_keeps_only_the_band() {
    let song = worship_song();
    let scene = scene(vec![rule(
        TrackSelector::ActiveSong,
        vec![TrackSelector::NameContains {
            words: vec!["voz".into(), " VOX ".into()],
        }],
    )]);
    // Song 1: the bass and the piano; the voices, the folder and the video
    // stay out, and so does the bass of song 2.
    assert_eq!(picked(&scene, &song, 10.0), vec!["bajo", "piano"]);
    assert_eq!(picked(&scene, &song, 110.0), vec!["other_bajo"]);
    // Between songs nothing is picked.
    assert!(picked(&scene, &song, 250.0).is_empty());
}

#[test]
fn folder_picks_its_audio_children_only() {
    let song = worship_song();
    let scene = scene(vec![rule(
        TrackSelector::Folder {
            name: "instrumentos".into(),
        },
        vec![],
    )]);
    assert_eq!(picked(&scene, &song, 10.0), vec!["piano"]);
}

#[test]
fn track_selector_picks_any_kind_and_ignores_the_active_song() {
    let song = worship_song();
    let scene = scene(vec![rule(
        TrackSelector::Track {
            track_id: "inst".into(),
        },
        vec![],
    )]);
    assert_eq!(picked(&scene, &song, 110.0), vec!["inst"]);
    assert_eq!(picked(&scene, &song, 250.0), vec!["inst"]);
}

#[test]
fn later_rules_win_per_field() {
    let song = worship_song();
    let mut second = rule(
        TrackSelector::Track {
            track_id: "bajo".into(),
        },
        vec![],
    );
    second.change = TrackChange {
        volume: Some(VolumeChange::Absolute(0.3)),
        muted: Some(true),
        ..TrackChange::default()
    };
    let mut first = rule(TrackSelector::ActiveSong, vec![]);
    first.change.pan = Some(PanChange::Absolute(0.5));
    let scene = scene(vec![first, second]);
    let active = active_song_track_ids(&song, 10.0);
    let resolved = resolve_scene(&scene, &song, active.as_ref());
    let bajo = resolved.iter().find(|c| c.track_id == "bajo").unwrap();
    assert_eq!(bajo.change.volume, Some(VolumeChange::Absolute(0.3)));
    assert_eq!(bajo.change.pan, Some(PanChange::Absolute(0.5)));
    assert_eq!(bajo.change.muted, Some(true));
}

// --- C5: arithmetic -------------------------------------------------------

#[test]
fn relative_changes_scale_and_clamp() {
    let minus_six = apply_change(
        mix(1.0),
        &TrackChange {
            volume: Some(VolumeChange::RelativeDb(-6.0)),
            ..TrackChange::default()
        },
    );
    assert!((minus_six.volume - 0.501).abs() < 0.001, "{}", minus_six.volume);

    let plus_twelve = apply_change(
        mix(0.8),
        &TrackChange {
            volume: Some(VolumeChange::RelativeDb(12.0)),
            ..TrackChange::default()
        },
    );
    assert_eq!(plus_twelve.volume, 1.0);

    let panned = apply_change(
        TrackMix { pan: 0.8, ..mix(1.0) },
        &TrackChange {
            pan: Some(PanChange::Relative(0.5)),
            muted: Some(true),
            ..TrackChange::default()
        },
    );
    assert_eq!(panned.pan, 1.0);
    assert!(panned.muted);
    assert!(!panned.solo);
}

// --- C6: latches ----------------------------------------------------------

fn current_of<'a>(values: &'a [(&'a str, TrackMix)]) -> impl Fn(&str) -> Option<TrackMix> + 'a {
    move |id| values.iter().find(|(track, _)| *track == id).map(|(_, mix)| *mix)
}

fn target(out: &[(String, TrackMix)], track_id: &str) -> TrackMix {
    out.iter()
        .find(|(id, _)| id == track_id)
        .map(|(_, mix)| *mix)
        .unwrap_or_else(|| panic!("{track_id} not in {out:?}"))
}

#[test]
fn engage_then_release_restores_what_was_there() {
    let mut latches = SceneLatches::default();
    let before = [("bass", mix(0.8)), ("drums", TrackMix { pan: -0.3, ..mix(0.6) })];
    let applied = latches.engage(
        "down",
        vec![volume_db("bass", -6.0), volume_db("drums", -6.0)],
        current_of(&before),
    );
    assert!(close(target(&applied, "bass").volume, 0.8 * 10f64.powf(-0.3)));
    assert!(latches.is_engaged("down"));
    assert_eq!(latches.values_for_save("bass"), Some(mix(0.8)));

    let restored = latches.release("down");
    assert_eq!(target(&restored, "bass"), mix(0.8));
    assert_eq!(target(&restored, "drums"), before[1].1);
    assert!(latches.is_empty());
    assert_eq!(latches.values_for_save("bass"), None);
    assert!(latches.release("down").is_empty());
}

#[test]
fn a_track_the_user_moves_leaves_the_scene() {
    let mut latches = SceneLatches::default();
    let before = [("bass", mix(0.8)), ("drums", mix(0.6))];
    latches.engage(
        "down",
        vec![volume_db("bass", -12.0), volume_db("drums", -12.0)],
        current_of(&before),
    );
    latches.touched_by_user("bass");
    assert_eq!(latches.values_for_save("bass"), None);

    let restored = latches.release("down");
    assert_eq!(restored.len(), 1, "{restored:?}");
    assert_eq!(target(&restored, "drums"), mix(0.6));
}

#[test]
fn stacked_scenes_release_in_either_order() {
    // "down" sets the piano to 0.2, "piano" to 0.9; the one still engaged
    // decides where the shared track goes (D13).
    let before = [("piano", mix(0.7)), ("bass", mix(0.5))];
    let engage_both = |latches: &mut SceneLatches| {
        latches.engage(
            "down",
            vec![volume_abs("piano", 0.2), volume_abs("bass", 0.1)],
            current_of(&before),
        );
        let on_top = latches.engage("piano", vec![volume_abs("piano", 0.9)], current_of(&[]));
        assert_eq!(target(&on_top, "piano").volume, 0.9);
    };

    let mut latches = SceneLatches::default();
    engage_both(&mut latches);
    let out = latches.release("piano");
    assert_eq!(target(&out, "piano").volume, 0.2);
    let out = latches.release("down");
    assert_eq!(target(&out, "piano").volume, 0.7);
    assert_eq!(target(&out, "bass").volume, 0.5);

    let mut latches = SceneLatches::default();
    engage_both(&mut latches);
    let out = latches.release("down");
    assert_eq!(target(&out, "piano").volume, 0.9);
    assert_eq!(target(&out, "bass").volume, 0.5);
    assert_eq!(latches.values_for_save("piano"), Some(mix(0.7)));
    let out = latches.release("piano");
    assert_eq!(target(&out, "piano").volume, 0.7);
}

#[test]
fn relative_scenes_stack_and_save_the_first_value() {
    let mut latches = SceneLatches::default();
    let before = [("bass", mix(1.0))];
    latches.engage("a", vec![volume_db("bass", -6.0)], current_of(&before));
    // The second scene engages over a lowered track: its base stays the
    // value from before any scene.
    let lowered = [("bass", mix(0.5))];
    let out = latches.engage("b", vec![volume_db("bass", -6.0)], current_of(&lowered));
    assert!(close(target(&out, "bass").volume, 10f64.powf(-12.0 / 20.0)));
    assert_eq!(latches.values_for_save("bass"), Some(mix(1.0)));
    assert_eq!(latches.engaged_ids(), vec!["a", "b"]);
}

#[test]
fn updating_an_engaged_scene_keeps_the_base_and_restores_who_left() {
    let mut latches = SceneLatches::default();
    let before = [("bass", mix(0.8)), ("drums", mix(0.6)), ("keys", mix(0.4))];
    latches.engage(
        "down",
        vec![volume_abs("bass", 0.1), volume_abs("drums", 0.1)],
        current_of(&before),
    );
    let during = [("bass", mix(0.1)), ("drums", mix(0.1)), ("keys", mix(0.4))];
    let out = latches.update(
        "down",
        vec![volume_abs("bass", 0.2), volume_abs("keys", 0.2)],
        current_of(&during),
    );
    assert_eq!(target(&out, "bass").volume, 0.2);
    assert_eq!(target(&out, "drums").volume, 0.6);
    assert_eq!(target(&out, "keys").volume, 0.2);
    assert_eq!(latches.values_for_save("bass"), Some(mix(0.8)));
    assert_eq!(latches.values_for_save("drums"), None);
    assert!(latches.update("missing", vec![], current_of(&during)).is_empty());
}

#[test]
fn a_deleted_track_is_forgotten_and_the_rest_still_restore() {
    let mut latches = SceneLatches::default();
    let before = [("bass", mix(0.8)), ("drums", mix(0.6))];
    latches.engage(
        "down",
        vec![volume_abs("bass", 0.1), volume_abs("drums", 0.1)],
        current_of(&before),
    );
    latches.forget_missing_tracks(|track_id| track_id != "bass");
    assert_eq!(latches.values_for_save("bass"), None);
    let restored = latches.release("down");
    assert_eq!(restored, vec![("drums".to_string(), mix(0.6))]);
}
