//! Automatizaciones: el modelo de una cue (instante, acciones y saltos).
//!
//! Vive en el core —no en el crate de escritorio, donde se carga y se ejecuta—
//! porque la instantánea del original de un arreglo (`SongStructure`) guarda
//! las cues de la canción junto a sus clips y marcas.

use serde::{Deserialize, Serialize};

fn default_true() -> bool {
    true
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
        #[serde(
            rename = "fadeInSeconds",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        fade_in_seconds: Option<f64>,
        /// Soft-exit duration in seconds when this cue turns the pad off (or
        /// swaps its key/pack). 0 / absent = the fast performance swap.
        #[serde(
            rename = "fadeOutSeconds",
            default,
            skip_serializing_if = "Option::is_none"
        )]
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
        self.actions
            .iter()
            .map(|action| action.wait_seconds())
            .sum()
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
