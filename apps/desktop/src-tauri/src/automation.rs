use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};
use thiserror::Error;

pub const AUTOMATION_FILE_NAME: &str = "automation.ltautomation";

#[derive(Debug, Error)]
pub enum AutomationError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AutomationDocument {
    #[serde(default)]
    pub cues: Vec<AutomationCue>,
    #[serde(default)]
    pub mix_scenes: Vec<MixScene>,
    /// Whether the user has added the automation track to the timeline. The
    /// track is a synthetic UI lane (not a real song `Track`); its presence is
    /// what gives the cues meaning, so removing the track clears `cues`.
    #[serde(default)]
    pub track_present: bool,
    /// Id of the audio track the automation lane sits *after* in the timeline
    /// order. `None` = first row. Persisted by id so it survives reordering of
    /// the real tracks without index recomputation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub track_after_id: Option<String>,
}

/// A cue is a "job": an ordered list of actions executed in sequence when the
/// playhead reaches `at_seconds`. A jump, if present, must be the last action
/// (it's scheduled sample-exact in the native engine as the culmination).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AutomationCue {
    pub id: String,
    pub name: String,
    pub at_seconds: f64,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Max times this cue fires per playback session. `None` = unlimited. Used to
    /// break loops (e.g. "jump back to the chorus, but only twice"). The run
    /// count itself is session state, not persisted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_runs: Option<u32>,
    /// Ordered actions. The legacy single `action` key is aliased here and the
    /// custom deserializer accepts either a single action object or an array,
    /// so existing automation.ltautomation files migrate transparently.
    #[serde(default, alias = "action", deserialize_with = "deserialize_actions")]
    pub actions: Vec<AutomationAction>,
}

/// Deserialize `actions: [...]` (new) or legacy `action: {...}` (single).
/// Implemented over an untagged helper so both shapes round-trip into a Vec.
fn deserialize_actions<'de, D>(deserializer: D) -> Result<Vec<AutomationAction>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    // The cue struct already routes the `actions` key here; legacy files carry
    // `action` instead, handled by a flattened alias in a wrapper. Simplest
    // robust approach: accept either a sequence or a single action object.
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum OneOrMany {
        Many(Vec<AutomationAction>),
        One(AutomationAction),
    }

    match OneOrMany::deserialize(deserializer)? {
        OneOrMany::Many(actions) => Ok(actions),
        OneOrMany::One(action) => Ok(vec![action]),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AutomationAction {
    Jump {
        target: AutomationJumpTarget,
        #[serde(default)]
        transition: AutomationTransition,
        #[serde(
            rename = "mixSceneId",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        mix_scene_id: Option<String>,
    },
    SetTrackMute {
        #[serde(rename = "trackId")]
        track_id: String,
        muted: bool,
    },
    SetTrackSolo {
        #[serde(rename = "trackId")]
        track_id: String,
        solo: bool,
    },
    SetTrackMix {
        #[serde(rename = "trackId")]
        track_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        volume: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pan: Option<f64>,
        #[serde(
            rename = "rampSeconds",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        ramp_seconds: Option<f64>,
    },
    ApplyScene {
        #[serde(rename = "sceneId")]
        scene_id: String,
        /// Ramp the scene's volume/pan changes over this many seconds when
        /// applied (None / 0 = instant).
        #[serde(
            rename = "rampSeconds",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        ramp_seconds: Option<f64>,
    },
    SetPad {
        enabled: bool,
        #[serde(rename = "padId")]
        pad_id: String,
        #[serde(rename = "padKey")]
        pad_key: i32,
        volume: f64,
        output: String,
        /// Soft-entrance duration in seconds when this cue turns the pad on.
        /// 0 / absent = the pad enters at its normal (near-instant) speed.
        #[serde(rename = "fadeInSeconds", default, skip_serializing_if = "Option::is_none")]
        fade_in_seconds: Option<f64>,
        /// Soft-exit duration in seconds when this cue turns the pad off (or
        /// swaps its key/pack). 0 / absent = the fast performance swap.
        #[serde(rename = "fadeOutSeconds", default, skip_serializing_if = "Option::is_none")]
        fade_out_seconds: Option<f64>,
    },
    Wait {
        #[serde(rename = "durationSeconds")]
        duration_seconds: f64,
    },
}

impl AutomationAction {
    pub fn is_jump(&self) -> bool {
        matches!(self, AutomationAction::Jump { .. })
    }

    /// Wait duration in seconds for `Wait` actions, else 0.
    pub fn wait_seconds(&self) -> f64 {
        match self {
            AutomationAction::Wait { duration_seconds } => duration_seconds.max(0.0),
            _ => 0.0,
        }
    }
}

impl AutomationCue {
    /// The job's terminal jump action, if any. By invariant (validated) a jump
    /// is the last action and there is at most one.
    pub fn jump_action(&self) -> Option<&AutomationAction> {
        self.actions.last().filter(|action| action.is_jump())
    }

    /// Total wait time before the jump (= sum of all waits, since the jump is
    /// last). The jump's effective trigger is `at_seconds + this`.
    pub fn pre_jump_wait_seconds(&self) -> f64 {
        self.actions.iter().map(|action| action.wait_seconds()).sum()
    }

    /// Non-jump actions paired with their effective offset from `at_seconds`
    /// (running sum of preceding waits). Used to fire mix actions on time.
    pub fn timed_pre_jump_actions(&self) -> Vec<(f64, AutomationAction)> {
        let mut offset = 0.0;
        let mut out = Vec::new();
        for action in &self.actions {
            match action {
                AutomationAction::Wait { duration_seconds } => {
                    offset += duration_seconds.max(0.0);
                }
                AutomationAction::Jump { .. } => {}
                other => out.push((offset, other.clone())),
            }
        }
        out
    }
}

// NOTE: for internally-tagged enums, serde's `rename_all` renames the variant
// TAGS but NOT the fields inside struct variants — so the fields must be renamed
// per-field to match the camelCase the frontend sends. Without these explicit
// renames `markerId` failed to deserialize ("missing field marker_id").
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AutomationJumpTarget {
    Marker {
        #[serde(rename = "markerId")]
        marker_id: String,
    },
    Region {
        #[serde(rename = "regionId")]
        region_id: String,
    },
    Frame {
        seconds: f64,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AutomationTransition {
    #[serde(default)]
    pub mode: AutomationTransitionMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_seconds: Option<f64>,
}

impl Default for AutomationTransition {
    fn default() -> Self {
        Self {
            mode: AutomationTransitionMode::Instant,
            duration_seconds: None,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AutomationTransitionMode {
    #[default]
    Instant,
    FadeOut,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MixScene {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub track_overrides: Vec<MixSceneTrackOverride>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MixSceneTrackOverride {
    pub track_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub volume: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pan: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub muted: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub solo: Option<bool>,
}

pub fn automation_file_path(song_dir: impl AsRef<Path>) -> PathBuf {
    song_dir.as_ref().join(AUTOMATION_FILE_NAME)
}

pub fn load_automation(song_dir: impl AsRef<Path>) -> Result<AutomationDocument, AutomationError> {
    let path = automation_file_path(song_dir);
    if !path.exists() {
        return Ok(AutomationDocument::default());
    }
    let json = fs::read_to_string(path)?;
    Ok(serde_json::from_str(&json)?)
}

pub fn save_automation(
    song_dir: impl AsRef<Path>,
    automation: &AutomationDocument,
) -> Result<PathBuf, AutomationError> {
    let path = automation_file_path(song_dir);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(automation)?;
    fs::write(&path, json)?;
    Ok(path)
}

fn default_true() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn automation_document_round_trips() {
        let dir = tempfile::tempdir().expect("temp dir");
        let document = AutomationDocument {
            cues: vec![AutomationCue {
                id: "cue_1".into(),
                name: "Jump early".into(),
                at_seconds: 42.0,
                enabled: true,
                max_runs: Some(2),
                actions: vec![
                    AutomationAction::SetTrackMute {
                        track_id: "track_voice".into(),
                        muted: true,
                    },
                    AutomationAction::Wait {
                        duration_seconds: 2.0,
                    },
                    AutomationAction::SetPad {
                        enabled: true,
                        pad_id: "organic".into(),
                        pad_key: 7,
                        volume: 0.7,
                        output: "master".into(),
                        fade_in_seconds: Some(3.0),
                        fade_out_seconds: None,
                    },
                    AutomationAction::Jump {
                        target: AutomationJumpTarget::Region {
                            region_id: "region_outro".into(),
                        },
                        transition: AutomationTransition {
                            mode: AutomationTransitionMode::FadeOut,
                            duration_seconds: Some(1.5),
                        },
                        mix_scene_id: Some("scene_soft".into()),
                    },
                ],
            }],
            mix_scenes: vec![MixScene {
                id: "scene_soft".into(),
                name: "Soft".into(),
                track_overrides: vec![MixSceneTrackOverride {
                    track_id: "track_drums".into(),
                    volume: Some(0.4),
                    pan: None,
                    muted: Some(false),
                    solo: None,
                }],
            }],
            track_present: true,
            track_after_id: Some("track_drums".into()),
        };

        save_automation(dir.path(), &document).expect("save automation");
        let loaded = load_automation(dir.path()).expect("load automation");

        assert_eq!(loaded, document);
    }

    #[test]
    fn jump_target_uses_camel_case_fields() {
        // The frontend speaks camelCase; deserialization must accept regionId /
        // markerId (not region_id) or upsert_automation_cue rejects the cue.
        let json = r#"{
            "id": "cue_1",
            "name": "Jump",
            "atSeconds": 10.0,
            "enabled": true,
            "action": {
                "type": "jump",
                "target": { "kind": "marker", "markerId": "m1" },
                "transition": { "mode": "fade_out", "durationSeconds": 1.5 },
                "mixSceneId": "s1"
            }
        }"#;
        // The legacy single `action` key migrates into a one-element `actions`.
        let cue: AutomationCue = serde_json::from_str(json).expect("camelCase cue parses");
        assert_eq!(cue.actions.len(), 1);
        let AutomationAction::Jump { target, .. } = &cue.actions[0] else {
            panic!("expected jump");
        };
        assert_eq!(
            target,
            &AutomationJumpTarget::Marker {
                marker_id: "m1".into()
            }
        );

        // And serialization round-trips back to camelCase keys.
        let serialized = serde_json::to_string(&cue).expect("serialize");
        assert!(serialized.contains("\"markerId\""));
        assert!(serialized.contains("\"mixSceneId\""));
        assert!(!serialized.contains("marker_id"));
        assert!(!serialized.contains("mix_scene_id"));

        // Region target deserializes from regionId too.
        let region_json = r#"{ "kind": "region", "regionId": "r1" }"#;
        let region: AutomationJumpTarget =
            serde_json::from_str(region_json).expect("regionId parses");
        assert_eq!(
            region,
            AutomationJumpTarget::Region {
                region_id: "r1".into()
            }
        );
    }

    #[test]
    fn multi_action_cue_round_trips_and_helpers() {
        let json = r#"{
            "id": "c1", "name": "Job", "atSeconds": 10.0, "enabled": true,
            "actions": [
                { "type": "setTrackMute", "trackId": "t1", "muted": true },
                { "type": "wait", "durationSeconds": 2.0 },
                { "type": "applyScene", "sceneId": "s1" },
                { "type": "jump",
                  "target": { "kind": "region", "regionId": "r1" },
                  "transition": { "mode": "instant" } }
            ]
        }"#;
        let cue: AutomationCue = serde_json::from_str(json).expect("multi-action parses");
        assert_eq!(cue.actions.len(), 4);
        // Helpers: jump is last, waits sum, pre-jump timed actions carry offsets.
        assert!(cue.jump_action().is_some());
        assert_eq!(cue.pre_jump_wait_seconds(), 2.0);
        let timed = cue.timed_pre_jump_actions();
        assert_eq!(timed.len(), 2); // mute + applyScene (wait/jump excluded)
        assert_eq!(timed[0].0, 0.0); // mute at offset 0
        assert_eq!(timed[1].0, 2.0); // applyScene after the 2s wait

        // camelCase fields survive serialization.
        let serialized = serde_json::to_string(&cue).expect("serialize");
        assert!(serialized.contains("\"trackId\""));
        assert!(serialized.contains("\"durationSeconds\""));
        assert!(serialized.contains("\"sceneId\""));
    }

    #[test]
    fn timed_pre_jump_actions_accumulate_multiple_waits() {
        // mute @0, wait 1, solo @1, wait 0.5, mix @1.5, jump (effective @1.5).
        let json = r#"{
            "id": "c1", "name": "J", "atSeconds": 5.0, "enabled": true,
            "actions": [
                { "type": "setTrackMute", "trackId": "t1", "muted": true },
                { "type": "wait", "durationSeconds": 1.0 },
                { "type": "setTrackSolo", "trackId": "t1", "solo": true },
                { "type": "wait", "durationSeconds": 0.5 },
                { "type": "setTrackMix", "trackId": "t1", "volume": 0.5 },
                { "type": "jump",
                  "target": { "kind": "marker", "markerId": "m1" },
                  "transition": { "mode": "instant" } }
            ]
        }"#;
        let cue: AutomationCue = serde_json::from_str(json).expect("parses");
        assert_eq!(cue.pre_jump_wait_seconds(), 1.5);
        let timed = cue.timed_pre_jump_actions();
        assert_eq!(timed.len(), 3);
        assert_eq!(timed[0].0, 0.0); // mute
        assert_eq!(timed[1].0, 1.0); // solo after first wait
        assert_eq!(timed[2].0, 1.5); // mix after both waits
    }

    #[test]
    fn jumpless_job_has_no_jump_action() {
        let json = r#"{
            "id": "c1", "name": "MixOnly", "atSeconds": 3.0, "enabled": true,
            "actions": [
                { "type": "setTrackMute", "trackId": "t1", "muted": true },
                { "type": "applyScene", "sceneId": "s1", "rampSeconds": 2.0 }
            ]
        }"#;
        let cue: AutomationCue = serde_json::from_str(json).expect("parses");
        assert!(cue.jump_action().is_none());
        assert_eq!(cue.pre_jump_wait_seconds(), 0.0);
        // Both actions are timed (no jump/wait to exclude).
        assert_eq!(cue.timed_pre_jump_actions().len(), 2);
    }

    #[test]
    fn max_runs_round_trips_and_omits_when_none() {
        let with_limit: AutomationCue = serde_json::from_str(
            r#"{ "id":"c","name":"n","atSeconds":1.0,"enabled":true,"maxRuns":2,
                 "actions":[{ "type":"wait","durationSeconds":1.0 }] }"#,
        )
        .expect("parses maxRuns");
        assert_eq!(with_limit.max_runs, Some(2));
        assert!(serde_json::to_string(&with_limit)
            .unwrap()
            .contains("\"maxRuns\":2"));

        // Unlimited cue omits the field on serialize.
        let unlimited: AutomationCue = serde_json::from_str(
            r#"{ "id":"c","name":"n","atSeconds":1.0,"enabled":true,
                 "actions":[{ "type":"wait","durationSeconds":1.0 }] }"#,
        )
        .expect("parses no maxRuns");
        assert_eq!(unlimited.max_runs, None);
        assert!(!serde_json::to_string(&unlimited)
            .unwrap()
            .contains("maxRuns"));
    }

    #[test]
    fn ramp_seconds_round_trips_on_mix_and_scene() {
        let cue: AutomationCue = serde_json::from_str(
            r#"{ "id":"c","name":"n","atSeconds":1.0,"enabled":true,"actions":[
                 { "type":"setTrackMix","trackId":"t1","volume":0.3,"rampSeconds":1.5 },
                 { "type":"applyScene","sceneId":"s1","rampSeconds":2.0 }
               ] }"#,
        )
        .expect("parses ramps");
        match &cue.actions[0] {
            AutomationAction::SetTrackMix { ramp_seconds, .. } => {
                assert_eq!(*ramp_seconds, Some(1.5))
            }
            _ => panic!("expected mix"),
        }
        match &cue.actions[1] {
            AutomationAction::ApplyScene { ramp_seconds, .. } => {
                assert_eq!(*ramp_seconds, Some(2.0))
            }
            _ => panic!("expected applyScene"),
        }
        let json = serde_json::to_string(&cue).unwrap();
        assert!(json.contains("\"rampSeconds\":1.5"));
        assert!(json.contains("\"rampSeconds\":2.0"));
    }

    #[test]
    fn document_migrates_multiple_legacy_action_cues() {
        // A whole document written by the old single-`action` schema must load.
        let json = r#"{
            "cues": [
                { "id":"a","name":"A","atSeconds":1.0,"enabled":true,
                  "action": { "type":"jump",
                    "target": { "kind":"region","regionId":"r1" },
                    "transition": { "mode":"instant" } } },
                { "id":"b","name":"B","atSeconds":2.0,"enabled":true,
                  "action": { "type":"jump",
                    "target": { "kind":"marker","markerId":"m1" },
                    "transition": { "mode":"fade_out","durationSeconds":1.0 } } }
            ],
            "mixScenes": [],
            "trackPresent": true
        }"#;
        let doc: AutomationDocument = serde_json::from_str(json).expect("legacy doc loads");
        assert_eq!(doc.cues.len(), 2);
        assert_eq!(doc.cues[0].actions.len(), 1);
        assert_eq!(doc.cues[1].actions.len(), 1);
        assert!(doc.cues[0].jump_action().is_some());
        assert!(doc.track_present);
    }

    #[test]
    fn missing_automation_file_loads_empty_document() {
        let dir = tempfile::tempdir().expect("temp dir");
        let loaded = load_automation(dir.path()).expect("load missing automation");

        assert_eq!(loaded, AutomationDocument::default());
    }
}
