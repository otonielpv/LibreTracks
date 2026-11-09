//! Redundancy channel: a second LibreTracks follows this one as a BACKUP so
//! a hardware switcher (or the desk) can move to it if the main dies.
//! Plan: `docs/plans/redundancy/` (step 01 defines and carries the messages;
//! later steps fill and use them).
//!
//! A backup is not a guest: it plays audio with its own engine, it does not
//! show up in the guests' peer list and there is at most one. It shares the
//! link server (port 3040), the hello, the PIN mechanics and the clock pings.
//!
//! Rules every message follows:
//! - camelCase fields AND variants (the automation-cue bug);
//! - times between machines are timeline SECONDS and monotonic instants,
//!   never frames (the timeline is baked to each machine's load rate) and
//!   never wall-clock time;
//! - idempotent: every A→B message carries a `seq`; applying the same one
//!   twice changes nothing and an older one is dropped ([`SeqGate`]). Vamp
//!   travels as the resulting state, never as a toggle.

use serde::{Deserialize, Serialize};

use crate::pairing::TrustedDevice;

/// Bumped when a backup of an older version would misread a message.
pub const REDUNDANCY_PROTOCOL_VERSION: u32 = 1;

/// Both ends send a [`Heartbeat`](RedundancyMessage::Heartbeat) this often.
pub const HEARTBEAT_INTERVAL_MS: u64 = 250;

/// Default silence after which the other end counts as gone (step 07 makes
/// it adjustable).
pub const DEFAULT_HEARTBEAT_TIMEOUT_MS: u64 = 1_000;

/// Which kind of peer a hello comes from. Old guests send nothing and are
/// guests.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PeerKind {
    #[default]
    Guest,
    Backup,
}

impl PeerKind {
    pub fn is_guest(&self) -> bool {
        *self == PeerKind::Guest
    }
}

/// Where the main's playhead was at one audio callback, and how long that
/// takes to be heard. Filled by steps 02 and 04.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransportClock {
    pub playing: bool,
    /// Timeline (view-time) seconds at the start of that callback.
    pub position_seconds: f64,
    /// Sender's monotonic clock at the start of that callback, in ns, on the
    /// same base as its clock pings (the link's monotonic ms × 1e6).
    pub callback_monotonic_ns: u64,
    pub output_latency_seconds: f64,
    pub sample_rate: u32,
}

/// A jump the main has scheduled and not executed yet.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PendingJump {
    Marker {
        marker_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        execute_at_seconds: Option<f64>,
    },
    Region {
        region_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        execute_at_seconds: Option<f64>,
    },
}

/// The main's vamp, as a state (never a toggle).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VampState {
    pub enabled: bool,
    /// Same strings as the host's vamp settings (`section`, `bars`, …).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bars: Option<u32>,
}

/// One transport change at the main's single door (`DesktopSession`).
/// Jump fields copy `LinkCommand::JumpToMarker` / `JumpToSong`, which in turn
/// are the arguments of `schedule_marker_jump` / `schedule_region_jump`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "intent",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TransportIntent {
    Play {
        from_seconds: f64,
    },
    Pause {
        at_seconds: f64,
    },
    Stop,
    FadeOutStop {
        duration_ms: u32,
    },
    Seek {
        to_seconds: f64,
    },
    ScheduleMarkerJump {
        marker_id: String,
        /// `immediate`, `nextMarker`, `afterBars`, … as in the jump settings.
        trigger: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        bars: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        transition: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        duration_seconds: Option<f64>,
    },
    ScheduleRegionJump {
        region_id: String,
        trigger: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        bars: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        transition: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        duration_seconds: Option<f64>,
    },
    CancelJump,
    /// The vamp AFTER the change: a repeated message must not flip it twice.
    ToggleVamp {
        enabled: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        mode: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        bars: Option<u32>,
    },
    SongChanged {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        song_id: Option<String>,
    },
}

/// What the main tells its backup about itself in the welcome.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedundancySettingsInfo {
    /// The main accepts transport commands forwarded by the backup.
    #[serde(default)]
    pub backup_may_forward: bool,
    #[serde(default)]
    pub heartbeat_timeout_ms: u64,
}

/// Health in one line, for the other end's indicator.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthSummary {
    pub audio_ok: bool,
    pub fallback_active: bool,
    pub pilot_tone_on: bool,
}

/// Healthy until told otherwise: a heartbeat sent before the app reported
/// anything must not read as "no audio" (the backup would declare the main
/// lost).
impl Default for HealthSummary {
    fn default() -> Self {
        Self {
            audio_ok: true,
            fallback_active: false,
            pilot_tone_on: false,
        }
    }
}

/// The backup's lifecycle as the main shows it (step 07 drives it).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BackupPhase {
    Pairing,
    CheckingSession,
    SessionMismatch,
    Following,
    Armed,
    MainLost,
    Standalone,
    Diverged,
}

/// One live-mix control, as the RESULTING value (never a delta). Partial
/// track changes carry only the fields that moved; a full snapshot carries
/// them all.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "control",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum MixControl {
    Track {
        track_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        volume: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pan: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        muted: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        solo: Option<bool>,
    },
    SongMaster {
        region_id: String,
        gain: f64,
    },
    Metronome {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        enabled: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        volume: Option<f64>,
    },
    VoiceGuide {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        enabled: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        volume: Option<f64>,
    },
}

/// Every message of the channel. Travels inside
/// `ServerMessage::Redundancy` / `ClientMessage::Redundancy`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RedundancyMessage {
    /// A → B, right after the backup is let in.
    Welcome {
        version: u32,
        main_name: String,
        /// New on every launch of the main: a different one means the main
        /// restarted and every `seq` starts over.
        instance_id: String,
        settings: RedundancySettingsInfo,
    },
    /// A → B, periodically and after every intent.
    State {
        seq: u64,
        clock: TransportClock,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        song_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        vamp: Option<VampState>,
        #[serde(default)]
        pending_jumps: Vec<PendingJump>,
    },
    /// A → B: live mix (step 09). `full` = the whole mix (on connect and
    /// periodically); otherwise coalesced changes.
    Mix {
        seq: u64,
        #[serde(default)]
        full: bool,
        controls: Vec<MixControl>,
    },
    /// A → B, one per transport change.
    Intent {
        seq: u64,
        intent: TransportIntent,
        /// The main's monotonic ns when the change happened.
        monotonic_ns: u64,
    },
    /// A → B. Opaque here; step 03 defines it.
    Fingerprint {
        version: u32,
        fingerprint: String,
    },
    /// A ↔ B.
    Heartbeat {
        seq: u64,
        monotonic_ns: u64,
        health: HealthSummary,
    },
    /// A backup that became the main, to its old main when it reconnects:
    /// «I am the main now; become my backup?». Never applied on its own: the
    /// old main's user accepts (step 07).
    RoleChange {
        new_main_name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        new_main_address: Option<String>,
    },
    /// B → A: the backup took over («Ahora mando yo»), whether the main is
    /// lost or a planned handover with the main alive. The main turns its
    /// pilot tone off and sends its clients to the new main (step 15).
    Handover {
        new_main_name: String,
        /// `ip:port` of the new main's link server.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        new_main_address: Option<String>,
        /// The new main's remote (browser) address.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        remote_url: Option<String>,
    },
    /// B → A, on connecting: where clients can reach the backup if the main
    /// goes (step 16-17).
    BackupInfo {
        /// `ip:port` the backup hosts its network session on when it takes
        /// over.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        link_address: Option<String>,
        /// The backup's remote (browser) address.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        remote_url: Option<String>,
    },
    /// A → B: the main's network-session access (PINs and trusted guests,
    /// token HASHES only), so its guests can join the backup with the same
    /// role and no PIN when it takes over (step 16).
    GuestAccess {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        control_pin: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        edit_pin: Option<String>,
        #[serde(default)]
        trusted: Vec<TrustedDevice>,
    },
    /// B → A.
    BackupStatus {
        phase: BackupPhase,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        offset_ms: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        last_correction_ms: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        fingerprint: Option<String>,
        /// The backup's live mix differs from the main's last full mix (a
        /// local change: the next snapshot overwrites it).
        #[serde(default, skip_serializing_if = "is_false")]
        mix_diverged: bool,
    },
}

fn is_false(value: &bool) -> bool {
    !*value
}

impl RedundancyMessage {
    /// The sequence number, for the kinds that carry one.
    pub fn seq(&self) -> Option<u64> {
        match self {
            RedundancyMessage::State { seq, .. }
            | RedundancyMessage::Mix { seq, .. }
            | RedundancyMessage::Intent { seq, .. }
            | RedundancyMessage::Heartbeat { seq, .. } => Some(*seq),
            RedundancyMessage::Welcome { .. }
            | RedundancyMessage::Fingerprint { .. }
            | RedundancyMessage::RoleChange { .. }
            | RedundancyMessage::Handover { .. }
            | RedundancyMessage::BackupInfo { .. }
            | RedundancyMessage::GuestAccess { .. }
            | RedundancyMessage::BackupStatus { .. } => None,
        }
    }
}

/// Drops repeated and out-of-date messages. Pure. One gate per stream (the
/// main numbers its states, intents and heartbeats from one counter, so one
/// gate per sender instance is enough).
#[derive(Debug, Clone, Default)]
pub struct SeqGate {
    instance_id: Option<String>,
    last: Option<u64>,
}

impl SeqGate {
    pub fn new() -> Self {
        Self::default()
    }

    /// A new sender instance (the main restarted): sequence starts over.
    pub fn reset_for(&mut self, instance_id: &str) {
        if self.instance_id.as_deref() != Some(instance_id) {
            self.instance_id = Some(instance_id.to_string());
            self.last = None;
        }
    }

    /// True when `seq` is newer than everything accepted so far (and
    /// remembers it); false for a repeat or an older one.
    pub fn accept(&mut self, seq: u64) -> bool {
        if self.last.is_some_and(|last| seq <= last) {
            return false;
        }
        self.last = Some(seq);
        true
    }

    pub fn last(&self) -> Option<u64> {
        self.last
    }
}

/// Whether the other end is still there. Pure: the caller passes the time
/// (any monotonic ms base, as long as it is always the same one).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HeartbeatMonitor {
    last_seen_ms: Option<u64>,
    timeout_ms: u64,
}

impl HeartbeatMonitor {
    pub fn new(timeout_ms: u64) -> Self {
        Self {
            last_seen_ms: None,
            timeout_ms,
        }
    }

    pub fn timeout_ms(&self) -> u64 {
        self.timeout_ms
    }

    pub fn set_timeout_ms(&mut self, timeout_ms: u64) {
        self.timeout_ms = timeout_ms;
    }

    /// Anything heard from the other end counts, not only heartbeats.
    pub fn observe(&mut self, now_ms: u64) {
        self.last_seen_ms = Some(match self.last_seen_ms {
            Some(last) => last.max(now_ms),
            None => now_ms,
        });
    }

    /// Never seen = not alive.
    pub fn is_alive(&self, now_ms: u64) -> bool {
        self.last_seen_ms
            .is_some_and(|last| now_ms.saturating_sub(last) <= self.timeout_ms)
    }

    pub fn silence_ms(&self, now_ms: u64) -> Option<u64> {
        self.last_seen_ms.map(|last| now_ms.saturating_sub(last))
    }

    pub fn forget(&mut self) {
        self.last_seen_ms = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn round_trip(message: &RedundancyMessage) -> Value {
        let text = serde_json::to_string(message).unwrap();
        let back: RedundancyMessage = serde_json::from_str(&text).unwrap();
        assert_eq!(&back, message, "round trip of {text}");
        serde_json::from_str(&text).unwrap()
    }

    fn intent(intent: TransportIntent) -> Value {
        round_trip(&RedundancyMessage::Intent {
            seq: 7,
            intent,
            monotonic_ns: 123,
        })
    }

    fn clock() -> TransportClock {
        TransportClock {
            playing: true,
            position_seconds: 12.5,
            callback_monotonic_ns: 1_000_000,
            output_latency_seconds: 0.01,
            sample_rate: 48_000,
        }
    }

    #[test]
    fn intent_play_round_trips() {
        let value = intent(TransportIntent::Play { from_seconds: 3.5 });
        assert_eq!(value["intent"]["intent"], "play");
        assert_eq!(value["intent"]["fromSeconds"], 3.5);
    }

    #[test]
    fn intent_pause_round_trips() {
        let value = intent(TransportIntent::Pause { at_seconds: 9.0 });
        assert_eq!(value["intent"]["atSeconds"], 9.0);
    }

    #[test]
    fn intent_stop_round_trips() {
        assert_eq!(intent(TransportIntent::Stop)["intent"]["intent"], "stop");
    }

    #[test]
    fn intent_fade_out_stop_round_trips() {
        let value = intent(TransportIntent::FadeOutStop { duration_ms: 2000 });
        assert_eq!(value["intent"]["intent"], "fadeOutStop");
        assert_eq!(value["intent"]["durationMs"], 2000);
    }

    #[test]
    fn intent_seek_round_trips() {
        let value = intent(TransportIntent::Seek { to_seconds: 61.25 });
        assert_eq!(value["intent"]["toSeconds"], 61.25);
    }

    #[test]
    fn intent_schedule_marker_jump_round_trips() {
        let value = intent(TransportIntent::ScheduleMarkerJump {
            marker_id: "m1".into(),
            trigger: "afterBars".into(),
            bars: Some(4),
            transition: Some("fadeOut".into()),
            duration_seconds: Some(1.5),
        });
        assert_eq!(value["intent"]["intent"], "scheduleMarkerJump");
        assert_eq!(value["intent"]["markerId"], "m1");
        assert_eq!(value["intent"]["durationSeconds"], 1.5);
    }

    #[test]
    fn intent_schedule_region_jump_round_trips() {
        let value = intent(TransportIntent::ScheduleRegionJump {
            region_id: "r2".into(),
            trigger: "regionEnd".into(),
            bars: None,
            transition: None,
            duration_seconds: None,
        });
        assert_eq!(value["intent"]["intent"], "scheduleRegionJump");
        assert_eq!(value["intent"]["regionId"], "r2");
        assert!(value["intent"].get("bars").is_none());
    }

    #[test]
    fn intent_cancel_jump_round_trips() {
        assert_eq!(
            intent(TransportIntent::CancelJump)["intent"]["intent"],
            "cancelJump"
        );
    }

    #[test]
    fn intent_toggle_vamp_carries_the_resulting_state() {
        let value = intent(TransportIntent::ToggleVamp {
            enabled: true,
            mode: Some("bars".into()),
            bars: Some(2),
        });
        assert_eq!(value["intent"]["intent"], "toggleVamp");
        assert_eq!(value["intent"]["enabled"], true);
    }

    #[test]
    fn intent_song_changed_round_trips() {
        let value = intent(TransportIntent::SongChanged {
            song_id: Some("s1".into()),
        });
        assert_eq!(value["intent"]["songId"], "s1");
    }

    #[test]
    fn every_message_kind_round_trips() {
        round_trip(&RedundancyMessage::Welcome {
            version: REDUNDANCY_PROTOCOL_VERSION,
            main_name: "PC A".into(),
            instance_id: "abc".into(),
            settings: RedundancySettingsInfo {
                backup_may_forward: true,
                heartbeat_timeout_ms: 1000,
            },
        });
        round_trip(&RedundancyMessage::State {
            seq: 1,
            clock: clock(),
            song_id: Some("s".into()),
            vamp: Some(VampState {
                enabled: false,
                mode: None,
                bars: None,
            }),
            pending_jumps: vec![
                PendingJump::Marker {
                    marker_id: "m".into(),
                    execute_at_seconds: Some(10.0),
                },
                PendingJump::Region {
                    region_id: "r".into(),
                    execute_at_seconds: None,
                },
            ],
        });
        round_trip(&RedundancyMessage::Fingerprint {
            version: 1,
            fingerprint: "f".into(),
        });
        round_trip(&RedundancyMessage::Heartbeat {
            seq: 2,
            monotonic_ns: 5,
            health: HealthSummary {
                audio_ok: true,
                fallback_active: false,
                pilot_tone_on: true,
            },
        });
        round_trip(&RedundancyMessage::BackupStatus {
            phase: BackupPhase::Armed,
            offset_ms: Some(0.8),
            last_correction_ms: None,
            fingerprint: Some("f".into()),
            mix_diverged: false,
        });
    }

    #[test]
    fn default_health_is_healthy() {
        assert!(HealthSummary::default().audio_ok);
        assert!(!HealthSummary::default().fallback_active);
    }

    #[test]
    fn failover_messages_round_trip_in_camel_case() {
        let info = round_trip(&RedundancyMessage::BackupInfo {
            link_address: Some("10.0.0.2:3040".into()),
            remote_url: Some("http://10.0.0.2:3030".into()),
        });
        assert_eq!(info["kind"], "backupInfo");
        assert_eq!(info["linkAddress"], "10.0.0.2:3040");
        let access = round_trip(&RedundancyMessage::GuestAccess {
            control_pin: Some("1111".into()),
            edit_pin: None,
            trusted: vec![TrustedDevice {
                device_id: "tablet".into(),
                device_name: "Tablet".into(),
                role: crate::permissions::Role::Controller,
                token_hash: "abc".into(),
            }],
        });
        assert_eq!(access["kind"], "guestAccess");
        assert_eq!(access["controlPin"], "1111");
        assert_eq!(access["trusted"][0]["tokenHash"], "abc");
        let failover = crate::protocol::ServerMessage::Failover {
            address: Some("10.0.0.2:3040".into()),
        };
        assert_eq!(
            serde_json::to_value(&failover).unwrap(),
            serde_json::json!({ "type": "failover", "address": "10.0.0.2:3040" })
        );
        let redirect = crate::protocol::ServerMessage::Redirect {
            address: "10.0.0.2:3040".into(),
        };
        assert_eq!(
            serde_json::to_value(&redirect).unwrap(),
            serde_json::json!({ "type": "redirect", "address": "10.0.0.2:3040" })
        );
    }

    #[test]
    fn handover_round_trips() {
        let value = round_trip(&RedundancyMessage::Handover {
            new_main_name: "PC B".into(),
            new_main_address: Some("10.0.0.2:3040".into()),
            remote_url: Some("http://10.0.0.2:3030".into()),
        });
        assert_eq!(value["kind"], "handover");
        assert_eq!(value["newMainAddress"], "10.0.0.2:3040");
        assert_eq!(value["remoteUrl"], "http://10.0.0.2:3030");
        round_trip(&RedundancyMessage::Handover {
            new_main_name: "PC B".into(),
            new_main_address: None,
            remote_url: None,
        });
    }

    #[test]
    fn role_change_round_trips() {
        let value = round_trip(&RedundancyMessage::RoleChange {
            new_main_name: "PC B".into(),
            new_main_address: Some("10.0.0.2:3040".into()),
        });
        assert_eq!(value["kind"], "roleChange");
        assert_eq!(value["newMainName"], "PC B");
        assert_eq!(value["newMainAddress"], "10.0.0.2:3040");
        assert_eq!(
            serde_json::to_value(BackupPhase::Diverged).unwrap(),
            "diverged"
        );
    }

    #[test]
    fn json_is_camel_case_against_a_literal() {
        let state = RedundancyMessage::State {
            seq: 3,
            clock: clock(),
            song_id: Some("s1".into()),
            vamp: None,
            pending_jumps: vec![PendingJump::Region {
                region_id: "r".into(),
                execute_at_seconds: Some(2.0),
            }],
        };
        assert_eq!(
            serde_json::to_value(&state).unwrap(),
            json!({
                "kind": "state",
                "seq": 3,
                "clock": {
                    "playing": true,
                    "positionSeconds": 12.5,
                    "callbackMonotonicNs": 1_000_000,
                    "outputLatencySeconds": 0.01,
                    "sampleRate": 48_000
                },
                "songId": "s1",
                "pendingJumps": [{ "kind": "region", "regionId": "r", "executeAtSeconds": 2.0 }]
            })
        );
        let status = RedundancyMessage::BackupStatus {
            phase: BackupPhase::MainLost,
            offset_ms: Some(1.5),
            last_correction_ms: Some(-0.5),
            fingerprint: None,
            mix_diverged: false,
        };
        assert_eq!(
            serde_json::to_value(&status).unwrap(),
            json!({
                "kind": "backupStatus",
                "phase": "mainLost",
                "offsetMs": 1.5,
                "lastCorrectionMs": -0.5
            })
        );
    }

    #[test]
    fn seq_gate_drops_repeats_and_older() {
        let mut gate = SeqGate::new();
        gate.reset_for("a");
        assert!(gate.accept(5));
        assert!(!gate.accept(5), "same seq twice");
        assert!(!gate.accept(4), "older");
        assert!(gate.accept(6));
        assert_eq!(gate.last(), Some(6));
        // Same instance again: nothing changes.
        gate.reset_for("a");
        assert!(!gate.accept(6));
        // The main restarted: its counter starts over.
        gate.reset_for("b");
        assert!(gate.accept(1));
    }

    #[test]
    fn heartbeat_monitor_follows_the_injected_clock() {
        let mut monitor = HeartbeatMonitor::new(1_000);
        assert!(!monitor.is_alive(0), "never seen");
        monitor.observe(10_000);
        assert!(monitor.is_alive(10_000));
        assert!(monitor.is_alive(11_000), "right at the timeout");
        assert!(!monitor.is_alive(11_001), "just past it");
        monitor.observe(11_500);
        assert!(monitor.is_alive(11_600), "revives on the next message");
        // An older observation does not move it back.
        monitor.observe(9_000);
        assert_eq!(monitor.silence_ms(11_600), Some(100));
    }

    #[test]
    fn old_hello_without_peer_kind_is_a_guest() {
        assert_eq!(PeerKind::default(), PeerKind::Guest);
        assert_eq!(serde_json::to_value(PeerKind::Backup).unwrap(), "backup");
    }
}
