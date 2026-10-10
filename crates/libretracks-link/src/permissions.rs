//! Who may do what. The host checks every incoming command here; the guest
//! UI only mirrors it.
//!
//! `required_permission` matches every `LinkCommand` variant with no `_`
//! arm, on purpose: a new command does not compile until someone decides
//! which role it needs, so nothing is ever born open to everyone.

use serde::{Deserialize, Serialize};

use crate::protocol::LinkCommand;

/// Ordered from least to most capable: each role includes the ones below.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Role {
    /// Sees song, markers, lyrics and playhead. Cannot change anything on
    /// the host.
    Viewer,
    /// Transport, jumps, vamp, jump modes and setlist order.
    Controller,
    /// Everything a controller can do, plus song content (lyrics, chords,
    /// transpose) and the mix. The mix lives here by the user's decision
    /// (2026-10-10): whoever must not touch it joins as controller.
    Editor,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Grants {
    pub role: Role,
}

impl Grants {
    pub const VIEWER: Grants = Grants { role: Role::Viewer };
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Permission {
    View,
    Control,
    Edit,
}

impl Role {
    pub fn allows(self, permission: Permission) -> bool {
        match permission {
            Permission::View => true,
            Permission::Control => self >= Role::Controller,
            Permission::Edit => self >= Role::Editor,
        }
    }
}

pub fn required_permission(command: &LinkCommand) -> Permission {
    match command {
        LinkCommand::Play
        | LinkCommand::Pause
        | LinkCommand::Stop
        | LinkCommand::FadeOutStop
        | LinkCommand::Seek { .. }
        | LinkCommand::JumpToMarker { .. }
        | LinkCommand::JumpToSong { .. }
        | LinkCommand::ToggleVamp { .. }
        | LinkCommand::CancelJump
        | LinkCommand::SetJumpSettings { .. }
        | LinkCommand::ReorderSong { .. } => Permission::Control,
        LinkCommand::SetSongChart { .. }
        | LinkCommand::SetSongTranspose { .. }
        | LinkCommand::SetTrackMix { .. }
        | LinkCommand::SetSongMasterGain { .. }
        | LinkCommand::SetMetronome { .. } => Permission::Edit,
    }
}

pub fn is_allowed(grants: &Grants, command: &LinkCommand) -> bool {
    grants.role.allows(required_permission(command))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// One sample of every command, named as in the design table
    /// (docs/plans/network-sessions/00-DISENO.md §4), with the minimum role
    /// that table gives it. Written as data so the test reads like the table.
    fn table() -> Vec<(&'static str, LinkCommand, Role)> {
        vec![
            ("play", LinkCommand::Play, Role::Controller),
            ("pause", LinkCommand::Pause, Role::Controller),
            ("stop", LinkCommand::Stop, Role::Controller),
            ("fade-out", LinkCommand::FadeOutStop, Role::Controller),
            (
                "seek",
                LinkCommand::Seek {
                    position_seconds: 1.0,
                },
                Role::Controller,
            ),
            (
                "jump to marker",
                LinkCommand::JumpToMarker {
                    marker_id: "m".into(),
                    trigger: "immediate".into(),
                    bars: None,
                },
                Role::Controller,
            ),
            (
                "jump to song",
                LinkCommand::JumpToSong {
                    region_id: "r".into(),
                    trigger: "immediate".into(),
                    bars: None,
                    transition: None,
                    duration_seconds: None,
                },
                Role::Controller,
            ),
            (
                "vamp",
                LinkCommand::ToggleVamp {
                    mode: "section".into(),
                    bars: None,
                },
                Role::Controller,
            ),
            ("cancel jump", LinkCommand::CancelJump, Role::Controller),
            (
                "jump modes",
                LinkCommand::SetJumpSettings {
                    global_jump_mode: Some("nextBar".into()),
                    global_jump_bars: None,
                    song_jump_trigger: None,
                    song_jump_bars: None,
                    song_transition_mode: None,
                    vamp_mode: None,
                    vamp_bars: None,
                },
                Role::Controller,
            ),
            (
                "reorder setlist",
                LinkCommand::ReorderSong {
                    region_id: "r".into(),
                    target_index: 0,
                },
                Role::Controller,
            ),
            (
                "edit lyrics/chords",
                LinkCommand::SetSongChart {
                    region_id: "r".into(),
                    chart: Some(json!({})),
                },
                Role::Editor,
            ),
            (
                "song transpose",
                LinkCommand::SetSongTranspose {
                    region_id: "r".into(),
                    semitones: 1,
                },
                Role::Editor,
            ),
            (
                "track mix",
                LinkCommand::SetTrackMix {
                    track_id: "t".into(),
                    volume: Some(1.0),
                    pan: None,
                    muted: None,
                    solo: None,
                    live: false,
                },
                Role::Editor,
            ),
            (
                "song master",
                LinkCommand::SetSongMasterGain {
                    region_id: "r".into(),
                    master_gain: 1.0,
                    live: true,
                },
                Role::Editor,
            ),
            (
                "metronome",
                LinkCommand::SetMetronome {
                    enabled: Some(true),
                    volume: None,
                },
                Role::Editor,
            ),
        ]
    }

    #[test]
    fn every_role_gets_exactly_what_the_design_table_says() {
        for (name, command, minimum) in table() {
            for role in [Role::Viewer, Role::Controller, Role::Editor] {
                assert_eq!(
                    is_allowed(&Grants { role }, &command),
                    role >= minimum,
                    "{name} for {role:?}"
                );
            }
        }
    }

    #[test]
    fn viewer_cannot_send_any_command() {
        for (name, command, _) in table() {
            assert!(!is_allowed(&Grants::VIEWER, &command), "{name}");
        }
    }

    #[test]
    fn roles_serialize_in_camel_case() {
        assert_eq!(
            serde_json::to_value(Role::Controller).unwrap(),
            json!("controller")
        );
        assert_eq!(
            serde_json::to_value(Grants { role: Role::Editor }).unwrap(),
            json!({ "role": "editor" })
        );
    }
}
