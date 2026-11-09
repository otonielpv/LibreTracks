//! What the UI is told about redundancy (step 07 §5): one `redundancy:status`
//! event, emitted on every state change and at most 4 times a second with
//! the offset. Also kept in `RedundancyState` for `get_redundancy_status`.

use libretracks_core::redundancy::lifecycle::{BackupState, MainState, Transition};
use libretracks_core::session_fingerprint::FingerprintDiff;
use serde::Serialize;

use super::role::RedundancyRole;
use crate::midi::message::OutboundMidiMessage;

pub const REDUNDANCY_STATUS_EVENT: &str = "redundancy:status";

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedundancyStatus {
    pub role: RedundancyRole,
    /// Lifecycle state, camelCase: backup `pairing`, `checkingSession`,
    /// `sessionMismatch`, `following`, `armed`, `mainLost`, `standalone`,
    /// `diverged`; main `noBackup`, `backupConnected`, `backupArmed`,
    /// `backupMismatch`, `backupLost`; `off`.
    pub state: String,
    pub offset_ms: Option<f64>,
    pub corrections: u32,
    /// The other machine's name.
    pub other_name: Option<String>,
    pub diffs: Vec<FingerprintDiff>,
    /// Why the last transition happened (English, for logs and tooltips).
    pub reason: String,
    /// A backup that became the main offers this machine to follow it.
    pub role_offer: Option<String>,
    /// The machine closed unexpectedly while it was the main: the pilot
    /// tone stays off until re-armed.
    pub unclean_exit_warning: bool,
    /// The backup runs at another sample rate than the main (it still works:
    /// everything is in seconds).
    pub sample_rate_differs: bool,
    pub pilot_tone_on: bool,
    /// Main side: the backup took over (lost main or planned handover).
    pub handover_by: Option<String>,
}

pub fn backup_state_name(state: BackupState) -> &'static str {
    match state {
        BackupState::Disabled => "off",
        BackupState::Pairing => "pairing",
        BackupState::CheckingSession => "checkingSession",
        BackupState::SessionMismatch => "sessionMismatch",
        BackupState::Following => "following",
        BackupState::Armed => "armed",
        BackupState::MainLost { .. } => "mainLost",
        BackupState::Standalone => "standalone",
        BackupState::Diverged => "diverged",
    }
}

pub fn main_state_name(state: MainState) -> &'static str {
    match state {
        MainState::NoBackup => "noBackup",
        MainState::BackupConnected => "backupConnected",
        MainState::BackupArmed => "backupArmed",
        MainState::BackupMismatch => "backupMismatch",
        MainState::BackupLost => "backupLost",
    }
}

/// The optional MIDI warning (step 07 §4): sent once, on entering
/// `MainLost`, never on the ticks that follow. `bytes` = 2 (program change)
/// or 3 bytes from `redundancy.json`; empty = off.
pub fn main_lost_midi(transition: &Transition, bytes: &[u8]) -> Option<OutboundMidiMessage> {
    if !matches!(transition.to, BackupState::MainLost { .. })
        || matches!(transition.from, BackupState::MainLost { .. })
    {
        return None;
    }
    match bytes {
        [status, data1] => Some(OutboundMidiMessage {
            status: *status,
            data1: *data1,
            data2: 0,
            two_bytes: true,
        }),
        [status, data1, data2] => Some(OutboundMidiMessage {
            status: *status,
            data1: *data1,
            data2: *data2,
            two_bytes: false,
        }),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use libretracks_core::redundancy::lifecycle::{
        BackupLifecycle, BackupObservation, LifecyclePolicy, SessionCheck,
    };

    #[test]
    fn the_main_lost_midi_goes_once_not_every_tick() {
        let mut life = BackupLifecycle::new(LifecyclePolicy::default());
        life.enable();
        let mut sent = Vec::new();
        for step in 0..500u64 {
            let now = step * 20_000_000;
            let transition = life.observe(&BackupObservation {
                now_ns: now,
                connected: true,
                // Lost after two seconds, and stays lost.
                main_alive: step < 100,
                main_audio_ok: true,
                main_fallback_active: false,
                session: SessionCheck::Same,
                offset_seconds: Some(0.0),
                resynced: false,
                main_matches: None,
            });
            if let Some(message) =
                transition.and_then(|transition| main_lost_midi(&transition, &[0xC0, 5]))
            {
                sent.push(message);
            }
        }
        assert_eq!(sent.len(), 1);
        assert!(sent[0].two_bytes);
        assert_eq!((sent[0].status, sent[0].data1), (0xC0, 5));
    }

    #[test]
    fn an_empty_setting_sends_nothing() {
        let transition = Transition {
            from: BackupState::Armed,
            to: BackupState::MainLost { since_ns: 1 },
            reason: "x",
        };
        assert!(main_lost_midi(&transition, &[]).is_none());
        assert!(main_lost_midi(&transition, &[0xB0, 20, 127]).is_some());
    }
}
