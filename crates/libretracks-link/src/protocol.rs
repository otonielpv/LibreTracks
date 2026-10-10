//! Wire protocol v1: JSON over WebSocket.
//!
//! Every message carries a `type` tag; commands inside `command` carry a
//! `cmd` tag. Field AND variant names are camelCase (variants too: a
//! PascalCase variant silently fails to parse against the TS side, see the
//! automation-cue bug). The payloads the host already builds for its own UI
//! (transport snapshot, song view, settings) travel as opaque JSON so this
//! crate does not depend on the desktop models.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::permissions::Grants;

/// Guest → host.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ClientMessage {
    /// First message of every connection. Without a valid hello the host
    /// closes the socket.
    Hello {
        protocol_version: u32,
        /// Stable per install; trusted-device tokens are bound to it.
        device_id: String,
        device_name: String,
        /// `windows`, `macos`, `linux`, `android`, `ios`.
        platform: String,
        app_version: String,
        /// PIN for the controller or editor role. None = viewer.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pin: Option<String>,
        /// Ask the host to remember this device after a PIN login.
        #[serde(default)]
        remember: bool,
        /// Token from an earlier `welcome` (trusted device).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        token: Option<String>,
    },
    Command {
        request_id: u64,
        /// `projectRevision` of the song view the edit was made on. Writes
        /// against a newer host revision are rejected as stale.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        base_revision: Option<u64>,
        command: LinkCommand,
    },
    /// NTP-style clock sample; `t0` is the guest's monotonic ms at send.
    ClockPing { t0: u64 },
}

/// Host → guest.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ServerMessage {
    Welcome {
        protocol_version: u32,
        session_id: String,
        host_name: String,
        grants: Grants,
        /// Present when the guest asked to be remembered.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        token: Option<String>,
        host_monotonic_ms: u64,
    },
    Rejected {
        reason: RejectReason,
        /// For `incompatibleVersion`: the version the host speaks.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        expected_protocol: Option<u32>,
    },
    GrantsChanged {
        grants: Grants,
    },
    /// Transport snapshot, stamped with the host's monotonic clock at the
    /// moment it was taken so the guest can extrapolate the playhead.
    Transport {
        host_monotonic_ms: u64,
        snapshot: Value,
    },
    /// Song view without waveform peaks.
    Song {
        song: Value,
    },
    /// Only what the live view paints (jump modes, vamp, notation).
    LiveSettings {
        settings: Value,
    },
    ClockPong {
        t0: u64,
        /// Host monotonic ms when the ping arrived.
        t1: u64,
        /// Host monotonic ms when the pong left.
        t2: u64,
    },
    Peers {
        peers: Vec<PeerInfo>,
    },
    CommandResult {
        request_id: u64,
        ok: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<CommandRejection>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RejectReason {
    BadPin,
    RateLimited,
    IncompatibleVersion,
    Kicked,
    HostFull,
    /// No valid hello in time, or a malformed one.
    BadHello,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CommandRejection {
    /// The guest's role does not allow it.
    Forbidden,
    /// The host moved past `baseRevision`; reload and retry.
    Stale,
    /// The host could not apply it (unknown id, bad value).
    Invalid,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerInfo {
    pub device_id: String,
    pub device_name: String,
    pub platform: String,
    pub grants: Grants,
}

/// Everything a guest can ask the host to do. Adding a variant does not
/// compile until `permissions::required_permission` classifies it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "cmd", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum LinkCommand {
    // --- transport (controller) ---
    Play,
    Pause,
    Stop,
    FadeOutStop,
    Seek {
        position_seconds: f64,
    },
    JumpToMarker {
        marker_id: String,
        /// Same strings the host's jump settings use (`immediate`,
        /// `nextBar`, `nextMarker`, `afterBars`, …).
        trigger: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        bars: Option<u32>,
    },
    JumpToSong {
        region_id: String,
        trigger: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        bars: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        transition: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        duration_seconds: Option<f64>,
    },
    ToggleVamp {
        mode: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        bars: Option<u32>,
    },
    CancelJump,
    /// The host's global jump settings, as the live view edits them. Every
    /// field is optional: only the ones present change.
    SetJumpSettings {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        global_jump_mode: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        global_jump_bars: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        song_jump_trigger: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        song_jump_bars: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        song_transition_mode: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        vamp_mode: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        vamp_bars: Option<u32>,
    },
    ReorderSong {
        region_id: String,
        target_index: u32,
    },

    // --- song content (editor) ---
    /// Chart as the desktop stores it (`SongChart`), or null to remove it.
    SetSongChart {
        region_id: String,
        chart: Option<Value>,
    },
    SetSongTranspose {
        region_id: String,
        semitones: i32,
    },

    // --- mix (editor) ---
    /// `live: true` streams to the engine during a drag (no undo entry);
    /// `live: false` commits, like a fader release.
    SetTrackMix {
        track_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        volume: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pan: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        muted: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        solo: Option<bool>,
        #[serde(default)]
        live: bool,
    },
    SetSongMasterGain {
        region_id: String,
        master_gain: f64,
        #[serde(default)]
        live: bool,
    },
    SetMetronome {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        enabled: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        volume: Option<f64>,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::permissions::Role;
    use serde_json::json;

    fn round_trip_client(message: ClientMessage, expected: Value) {
        let encoded = serde_json::to_value(&message).unwrap();
        assert_eq!(encoded, expected);
        let decoded: ClientMessage = serde_json::from_value(expected).unwrap();
        assert_eq!(decoded, message);
    }

    fn round_trip_server(message: ServerMessage, expected: Value) {
        let encoded = serde_json::to_value(&message).unwrap();
        assert_eq!(encoded, expected);
        let decoded: ServerMessage = serde_json::from_value(expected).unwrap();
        assert_eq!(decoded, message);
    }

    fn round_trip_command(command: LinkCommand, expected: Value) {
        let encoded = serde_json::to_value(&command).unwrap();
        assert_eq!(encoded, expected);
        let decoded: LinkCommand = serde_json::from_value(expected).unwrap();
        assert_eq!(decoded, command);
    }

    #[test]
    fn hello_round_trips_in_camel_case() {
        round_trip_client(
            ClientMessage::Hello {
                protocol_version: 1,
                device_id: "dev-1".into(),
                device_name: "iPad de Ana".into(),
                platform: "ios".into(),
                app_version: "1.15.0".into(),
                pin: Some("1234".into()),
                remember: true,
                token: None,
            },
            json!({
                "type": "hello",
                "protocolVersion": 1,
                "deviceId": "dev-1",
                "deviceName": "iPad de Ana",
                "platform": "ios",
                "appVersion": "1.15.0",
                "pin": "1234",
                "remember": true
            }),
        );
    }

    #[test]
    fn hello_without_optional_fields_parses() {
        let decoded: ClientMessage = serde_json::from_value(json!({
            "type": "hello",
            "protocolVersion": 1,
            "deviceId": "d",
            "deviceName": "n",
            "platform": "android",
            "appVersion": "1.15.0"
        }))
        .unwrap();
        let ClientMessage::Hello {
            pin,
            token,
            remember,
            ..
        } = decoded
        else {
            panic!("expected hello");
        };
        assert_eq!(pin, None);
        assert_eq!(token, None);
        assert!(!remember);
    }

    #[test]
    fn command_envelope_round_trips() {
        round_trip_client(
            ClientMessage::Command {
                request_id: 7,
                base_revision: Some(42),
                command: LinkCommand::SetSongTranspose {
                    region_id: "r1".into(),
                    semitones: -2,
                },
            },
            json!({
                "type": "command",
                "requestId": 7,
                "baseRevision": 42,
                "command": { "cmd": "setSongTranspose", "regionId": "r1", "semitones": -2 }
            }),
        );
    }

    #[test]
    fn clock_ping_round_trips() {
        round_trip_client(
            ClientMessage::ClockPing { t0: 99 },
            json!({ "type": "clockPing", "t0": 99 }),
        );
    }

    #[test]
    fn server_messages_round_trip() {
        round_trip_server(
            ServerMessage::Welcome {
                protocol_version: 1,
                session_id: "s".into(),
                host_name: "PC".into(),
                grants: Grants { role: Role::Editor },
                token: Some("tok".into()),
                host_monotonic_ms: 10,
            },
            json!({
                "type": "welcome",
                "protocolVersion": 1,
                "sessionId": "s",
                "hostName": "PC",
                "grants": { "role": "editor" },
                "token": "tok",
                "hostMonotonicMs": 10
            }),
        );
        round_trip_server(
            ServerMessage::Rejected {
                reason: RejectReason::IncompatibleVersion,
                expected_protocol: Some(2),
            },
            json!({ "type": "rejected", "reason": "incompatibleVersion", "expectedProtocol": 2 }),
        );
        round_trip_server(
            ServerMessage::Rejected {
                reason: RejectReason::BadPin,
                expected_protocol: None,
            },
            json!({ "type": "rejected", "reason": "badPin" }),
        );
        round_trip_server(
            ServerMessage::GrantsChanged {
                grants: Grants { role: Role::Viewer },
            },
            json!({ "type": "grantsChanged", "grants": { "role": "viewer" } }),
        );
        round_trip_server(
            ServerMessage::Transport {
                host_monotonic_ms: 5,
                snapshot: json!({ "playbackState": "playing" }),
            },
            json!({ "type": "transport", "hostMonotonicMs": 5, "snapshot": { "playbackState": "playing" } }),
        );
        round_trip_server(
            ServerMessage::Song {
                song: json!({ "regions": [] }),
            },
            json!({ "type": "song", "song": { "regions": [] } }),
        );
        round_trip_server(
            ServerMessage::LiveSettings {
                settings: json!({ "vampMode": "section" }),
            },
            json!({ "type": "liveSettings", "settings": { "vampMode": "section" } }),
        );
        round_trip_server(
            ServerMessage::ClockPong {
                t0: 1,
                t1: 2,
                t2: 3,
            },
            json!({ "type": "clockPong", "t0": 1, "t1": 2, "t2": 3 }),
        );
        round_trip_server(
            ServerMessage::Peers {
                peers: vec![PeerInfo {
                    device_id: "d".into(),
                    device_name: "n".into(),
                    platform: "linux".into(),
                    grants: Grants {
                        role: Role::Controller,
                    },
                }],
            },
            json!({ "type": "peers", "peers": [
                { "deviceId": "d", "deviceName": "n", "platform": "linux", "grants": { "role": "controller" } }
            ] }),
        );
        round_trip_server(
            ServerMessage::CommandResult {
                request_id: 3,
                ok: false,
                reason: Some(CommandRejection::Stale),
            },
            json!({ "type": "commandResult", "requestId": 3, "ok": false, "reason": "stale" }),
        );
    }

    #[test]
    fn every_command_round_trips_in_camel_case() {
        round_trip_command(LinkCommand::Play, json!({ "cmd": "play" }));
        round_trip_command(LinkCommand::Pause, json!({ "cmd": "pause" }));
        round_trip_command(LinkCommand::Stop, json!({ "cmd": "stop" }));
        round_trip_command(LinkCommand::FadeOutStop, json!({ "cmd": "fadeOutStop" }));
        round_trip_command(
            LinkCommand::Seek {
                position_seconds: 12.5,
            },
            json!({ "cmd": "seek", "positionSeconds": 12.5 }),
        );
        round_trip_command(
            LinkCommand::JumpToMarker {
                marker_id: "m".into(),
                trigger: "afterBars".into(),
                bars: Some(4),
            },
            json!({ "cmd": "jumpToMarker", "markerId": "m", "trigger": "afterBars", "bars": 4 }),
        );
        round_trip_command(
            LinkCommand::JumpToSong {
                region_id: "r".into(),
                trigger: "regionEnd".into(),
                bars: None,
                transition: Some("fadeOut".into()),
                duration_seconds: Some(2.0),
            },
            json!({ "cmd": "jumpToSong", "regionId": "r", "trigger": "regionEnd", "transition": "fadeOut", "durationSeconds": 2.0 }),
        );
        round_trip_command(
            LinkCommand::ToggleVamp {
                mode: "bars".into(),
                bars: Some(2),
            },
            json!({ "cmd": "toggleVamp", "mode": "bars", "bars": 2 }),
        );
        round_trip_command(LinkCommand::CancelJump, json!({ "cmd": "cancelJump" }));
        round_trip_command(
            LinkCommand::SetJumpSettings {
                global_jump_mode: Some("nextBar".into()),
                global_jump_bars: None,
                song_jump_trigger: None,
                song_jump_bars: Some(8),
                song_transition_mode: None,
                vamp_mode: None,
                vamp_bars: None,
            },
            json!({ "cmd": "setJumpSettings", "globalJumpMode": "nextBar", "songJumpBars": 8 }),
        );
        round_trip_command(
            LinkCommand::ReorderSong {
                region_id: "r".into(),
                target_index: 2,
            },
            json!({ "cmd": "reorderSong", "regionId": "r", "targetIndex": 2 }),
        );
        round_trip_command(
            LinkCommand::SetSongChart {
                region_id: "r".into(),
                chart: Some(json!({ "text": "[C]Hola", "links": [] })),
            },
            json!({ "cmd": "setSongChart", "regionId": "r", "chart": { "text": "[C]Hola", "links": [] } }),
        );
        round_trip_command(
            LinkCommand::SetSongChart {
                region_id: "r".into(),
                chart: None,
            },
            json!({ "cmd": "setSongChart", "regionId": "r", "chart": null }),
        );
        round_trip_command(
            LinkCommand::SetSongTranspose {
                region_id: "r".into(),
                semitones: 3,
            },
            json!({ "cmd": "setSongTranspose", "regionId": "r", "semitones": 3 }),
        );
        round_trip_command(
            LinkCommand::SetTrackMix {
                track_id: "t".into(),
                volume: Some(0.5),
                pan: None,
                muted: Some(true),
                solo: None,
                live: true,
            },
            json!({ "cmd": "setTrackMix", "trackId": "t", "volume": 0.5, "muted": true, "live": true }),
        );
        round_trip_command(
            LinkCommand::SetSongMasterGain {
                region_id: "r".into(),
                master_gain: 0.8,
                live: false,
            },
            json!({ "cmd": "setSongMasterGain", "regionId": "r", "masterGain": 0.8, "live": false }),
        );
        round_trip_command(
            LinkCommand::SetMetronome {
                enabled: Some(false),
                volume: None,
            },
            json!({ "cmd": "setMetronome", "enabled": false }),
        );
    }

    #[test]
    fn unknown_command_is_rejected() {
        assert!(serde_json::from_value::<LinkCommand>(json!({ "cmd": "formatDisk" })).is_err());
    }

    #[test]
    fn pascal_case_variant_is_rejected() {
        // The TS side always sends camelCase; a PascalCase tag means someone
        // dropped `rename_all` and the two sides drifted.
        assert!(serde_json::from_value::<LinkCommand>(json!({ "cmd": "Play" })).is_err());
    }
}
