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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AutomationCue {
    pub id: String,
    pub name: String,
    pub at_seconds: f64,
    #[serde(default = "default_true")]
    pub enabled: bool,
    pub action: AutomationAction,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AutomationAction {
    Jump {
        target: AutomationJumpTarget,
        #[serde(default)]
        transition: AutomationTransition,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        mix_scene_id: Option<String>,
    },
}

// `rename_all = "camelCase"` renames the variant TAGS (marker/region/frame,
// unchanged as single words) AND their fields (marker_id → markerId), matching
// the camelCase TS `AutomationJumpTargetSummary`. With snake_case the frontend's
// `markerId` failed to deserialize ("missing field marker_id").
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AutomationJumpTarget {
    Marker { marker_id: String },
    Region { region_id: String },
    Frame { seconds: f64 },
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
                action: AutomationAction::Jump {
                    target: AutomationJumpTarget::Region {
                        region_id: "region_outro".into(),
                    },
                    transition: AutomationTransition {
                        mode: AutomationTransitionMode::FadeOut,
                        duration_seconds: Some(1.5),
                    },
                    mix_scene_id: Some("scene_soft".into()),
                },
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
        let cue: AutomationCue = serde_json::from_str(json).expect("camelCase cue parses");
        let AutomationAction::Jump { target, .. } = cue.action;
        assert_eq!(
            target,
            AutomationJumpTarget::Marker {
                marker_id: "m1".into()
            }
        );

        // And serialization round-trips back to camelCase keys.
        let serialized = serde_json::to_string(&cue).expect("serialize");
        assert!(serialized.contains("\"markerId\""));
        assert!(!serialized.contains("marker_id"));
    }

    #[test]
    fn missing_automation_file_loads_empty_document() {
        let dir = tempfile::tempdir().expect("temp dir");
        let loaded = load_automation(dir.path()).expect("load missing automation");

        assert_eq!(loaded, AutomationDocument::default());
    }
}
