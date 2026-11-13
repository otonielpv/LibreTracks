use super::*;

use crate::audio::automation::AutomationDocument;

/// Two songs: "a" (0-20 s) with a chorus marker at 8 s, "b" (20-30 s).
fn song() -> Song {
    serde_json::from_value(serde_json::json!({
        "id": "session", "title": "Set", "durationSeconds": 30.0,
        "regions": [
            {"id": "a", "name": "A", "startSeconds": 0.0, "endSeconds": 20.0},
            {"id": "b", "name": "B", "startSeconds": 20.0, "endSeconds": 30.0}
        ],
        "tracks": [
            {"id": "drums", "name": "Drums", "kind": "audio", "parentTrackId": null,
             "volume": 0.8, "pan": 0.0, "muted": false, "solo": false},
            {"id": "keys", "name": "Keys", "kind": "audio", "parentTrackId": null,
             "volume": 1.0, "pan": 0.0, "muted": true, "solo": false}
        ],
        "clips": [],
        "sectionMarkers": [
            {"id": "chorus", "name": "Chorus", "startSeconds": 8.0, "digit": null}
        ]
    }))
    .unwrap()
}

fn document(cues: serde_json::Value) -> AutomationDocument {
    serde_json::from_value(serde_json::json!({
        "cues": cues,
        "mixScenes": [{
            "id": "quiet", "name": "Quiet", "rampSeconds": 0.0,
            "rules": [{"select": {"type": "track", "trackId": "drums"},
                       "change": {"volume": {"type": "absolute", "value": 0.2}}}]
        }],
        "trackPresent": true
    }))
    .unwrap()
}

fn plan(cues: serde_json::Value, region_id: &str) -> Option<RenderAutomation> {
    let song = song();
    let automation = document(cues);
    let settings = AppSettings::default();
    plan_render_automation(&AutomationPlanInputs {
        song: &song,
        automation: &automation,
        region_id,
        settings: &settings,
        pads_dir: "pads".into(),
    })
}

fn segments(plan: &RenderAutomation) -> Vec<(f64, f64)> {
    plan.segments.iter().map(|segment| (segment.start_seconds, segment.end_seconds)).collect()
}

fn keys(keys: &[RenderKey]) -> Vec<(f64, f32)> {
    keys.iter().map(|key| (key.seconds, key.value)).collect()
}

fn track<'a>(plan: &'a RenderAutomation, id: &str) -> &'a RenderTrackAutomation {
    plan.tracks.iter().find(|track| track.track_id == id).expect("track has keys")
}

#[test]
fn no_cues_in_the_song_means_no_plan() {
    let cues = serde_json::json!([
        {"id": "c", "name": "B mute", "atSeconds": 22.0,
         "actions": [{"type": "setTrackMute", "trackId": "drums", "muted": true}]}
    ]);
    assert!(plan(cues.clone(), "a").is_none());
    assert!(plan(cues, "b").is_some());
}

#[test]
fn disabled_lane_or_cue_plans_nothing() {
    let song = song();
    let mut automation = document(serde_json::json!([
        {"id": "c", "name": "Mute", "atSeconds": 2.0,
         "actions": [{"type": "setTrackMute", "trackId": "drums", "muted": true}]}
    ]));
    automation.track_enabled = false;
    let settings = AppSettings::default();
    let inputs = AutomationPlanInputs {
        song: &song,
        automation: &automation,
        region_id: "a",
        settings: &settings,
        pads_dir: String::new(),
    };
    assert!(plan_render_automation(&inputs).is_none());
}

#[test]
fn a_jump_back_with_no_limit_plays_the_section_twice_then_goes_on() {
    let plan = plan(
        serde_json::json!([
            {"id": "loop", "name": "Again", "atSeconds": 14.0,
             "actions": [{"type": "jump", "target": {"kind": "marker", "markerId": "chorus"}}]}
        ]),
        "a",
    )
    .unwrap();
    assert_eq!(segments(&plan), vec![(0.0, 14.0), (8.0, 20.0)]);
    // A short declick around the cut, on the tracks only.
    assert_eq!(
        keys(&plan.master_gain),
        vec![(0.0, 1.0), (14.0 - JUMP_DECLICK_SECONDS, 1.0), (14.0, 0.0), (14.0, 0.0),
             (14.0 + JUMP_DECLICK_SECONDS, 1.0)]
    );
}

#[test]
fn max_runs_limits_the_loop() {
    let plan = plan(
        serde_json::json!([
            {"id": "loop", "name": "x3", "atSeconds": 14.0, "maxRuns": 2,
             "actions": [{"type": "jump", "target": {"kind": "marker", "markerId": "chorus"},
                          "transition": {"mode": "fade_out", "durationSeconds": 1.0}}]}
        ]),
        "a",
    )
    .unwrap();
    assert_eq!(segments(&plan), vec![(0.0, 14.0), (8.0, 14.0), (8.0, 20.0)]);
    // The fade-out ends on each cut and the fade-in starts there.
    let master = keys(&plan.master_gain);
    assert!(master.contains(&(13.0, 1.0)) && master.contains(&(14.0, 0.0)));
    assert!(master.contains(&(19.0, 1.0)) && master.contains(&(20.0, 0.0)));
    assert!(master.contains(&(21.0, 1.0)));
}

#[test]
fn a_jump_out_of_the_song_is_ignored() {
    let plan = plan(
        serde_json::json!([
            {"id": "next", "name": "Next song", "atSeconds": 18.0,
             "actions": [{"type": "jump", "target": {"kind": "region", "regionId": "b"}}]},
            {"id": "m", "name": "Mute", "atSeconds": 19.0,
             "actions": [{"type": "setTrackMute", "trackId": "drums", "muted": true}]}
        ]),
        "a",
    )
    .unwrap();
    assert_eq!(segments(&plan), vec![(0.0, 20.0)]);
    assert_eq!(keys(&track(&plan, "drums").mute), vec![(0.0, 0.0), (19.0, 1.0)]);
}

#[test]
fn mix_changes_follow_the_output_timeline_across_a_jump() {
    let plan = plan(
        serde_json::json!([
            {"id": "down", "name": "Down", "atSeconds": 10.0,
             "actions": [{"type": "setTrackMix", "trackId": "drums", "volume": 0.4,
                          "rampSeconds": 2.0}]},
            {"id": "loop", "name": "Again", "atSeconds": 14.0, "maxRuns": 1,
             "actions": [{"type": "jump", "target": {"kind": "marker", "markerId": "chorus"}}]}
        ]),
        "a",
    )
    .unwrap();
    // First pass ramps at 10 s; the second pass (output 14 s = source 8 s)
    // fires the cue again at source 10 s = output 16 s, from where it is.
    assert_eq!(
        keys(&track(&plan, "drums").gain),
        vec![(0.0, 0.8), (10.0, 0.8), (12.0, 0.4), (16.0, 0.4), (18.0, 0.4)]
    );
}

#[test]
fn a_new_change_cuts_a_ramp_where_it_is() {
    let plan = plan(
        serde_json::json!([
            {"id": "down", "name": "Down", "atSeconds": 10.0,
             "actions": [{"type": "setTrackMix", "trackId": "drums", "volume": 0.0,
                          "rampSeconds": 4.0}]},
            {"id": "up", "name": "Up", "atSeconds": 12.0,
             "actions": [{"type": "setTrackMix", "trackId": "drums", "volume": 1.0}]}
        ]),
        "a",
    )
    .unwrap();
    assert_eq!(
        keys(&track(&plan, "drums").gain),
        vec![(0.0, 0.8), (10.0, 0.8), (12.0, 0.4), (12.0, 1.0)]
    );
}

#[test]
fn waits_delay_the_actions_and_the_jump() {
    let plan = plan(
        serde_json::json!([
            {"id": "c", "name": "Out", "atSeconds": 4.0, "maxRuns": 1, "actions": [
                {"type": "setTrackMute", "trackId": "drums", "muted": true},
                {"type": "wait", "durationSeconds": 2.0},
                {"type": "setTrackMute", "trackId": "drums", "muted": false},
                {"type": "wait", "durationSeconds": 1.0},
                {"type": "jump", "target": {"kind": "frame", "seconds": 1.0}}
            ]}
        ]),
        "a",
    )
    .unwrap();
    assert_eq!(segments(&plan), vec![(0.0, 7.0), (1.0, 20.0)]);
    assert_eq!(
        keys(&track(&plan, "drums").mute),
        // First pass at 4 and 6; the cue is spent on the second pass.
        vec![(0.0, 0.0), (4.0, 1.0), (6.0, 0.0)]
    );
}

#[test]
fn untouched_tracks_get_no_keys_and_solo_brings_every_track_in() {
    let plan = plan(
        serde_json::json!([
            {"id": "s", "name": "Solo drums", "atSeconds": 5.0,
             "actions": [{"type": "setTrackSolo", "trackId": "drums", "solo": true}]}
        ]),
        "a",
    )
    .unwrap();
    assert_eq!(keys(&track(&plan, "drums").solo), vec![(0.0, 0.0), (5.0, 1.0)]);
    let keys_track = track(&plan, "keys");
    assert_eq!(keys(&keys_track.solo), vec![(0.0, 0.0)]);
    // Keys is muted in the model but no cue touches its mute: still ignored.
    assert!(keys_track.mute.is_empty());
    assert!(keys_track.gain.is_empty());
}

#[test]
fn scenes_engage_and_restore() {
    let plan = plan(
        serde_json::json!([
            {"id": "on", "name": "Quiet", "atSeconds": 3.0,
             "actions": [{"type": "applyScene", "sceneId": "quiet", "rampSeconds": 1.0}]},
            {"id": "off", "name": "Back", "atSeconds": 6.0,
             "actions": [{"type": "applyScene", "sceneId": "quiet", "mode": "restore"}]}
        ]),
        "a",
    )
    .unwrap();
    assert_eq!(
        keys(&track(&plan, "drums").gain),
        vec![(0.0, 0.8), (3.0, 0.8), (4.0, 0.2), (6.0, 0.2), (6.0, 0.8)]
    );
}

#[test]
fn click_guide_and_pad_changes_land_on_the_output_timeline() {
    let plan = plan(
        serde_json::json!([
            {"id": "c", "name": "Intro", "atSeconds": 2.0, "actions": [
                {"type": "setMetronome", "enabled": false},
                {"type": "setVoiceGuide", "language": "en"},
                {"type": "setPad", "enabled": true, "padId": "warm", "padKey": 14,
                 "volume": 0.5, "output": "monitor", "fadeInSeconds": 3.0}
            ]},
            {"id": "c2", "name": "Click back", "atSeconds": 9.0,
             "actions": [{"type": "setMetronome", "subdivision": 2}]}
        ]),
        "a",
    )
    .unwrap();
    assert_eq!(plan.metronome.len(), 2);
    assert_eq!((plan.metronome[0].seconds, plan.metronome[0].enabled), (2.0, false));
    // No `enabled` in the cue: the click stays as the last cue left it.
    assert_eq!((plan.metronome[1].seconds, plan.metronome[1].enabled), (9.0, false));
    assert_eq!(plan.metronome[1].config.subdivision, 2);
    assert_eq!(plan.voice_guide[0].lang, "en");
    assert!(plan.voice_guide[0].enabled);
    assert_eq!(plan.pad[0].key, 11);
    assert_eq!(plan.pad[0].fade_in_seconds, 3.0);
    assert_eq!(plan.pads_dir, "pads");
}

#[test]
fn a_jump_scene_applies_on_landing() {
    let plan = plan(
        serde_json::json!([
            {"id": "loop", "name": "Again", "atSeconds": 14.0, "maxRuns": 1,
             "actions": [{"type": "jump", "target": {"kind": "marker", "markerId": "chorus"},
                          "mixSceneId": "quiet"}]}
        ]),
        "a",
    )
    .unwrap();
    assert_eq!(keys(&track(&plan, "drums").gain), vec![(0.0, 0.8), (14.0, 0.8), (14.0, 0.2)]);
}
