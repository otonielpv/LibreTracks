//! Who sends lyrics (D19). The same rule as the timeline MIDI: a backup that
//! is following its main (transport locked) does not send; once it hosts
//! (main lost, or standalone) it does. A network guest never plays its local
//! session, so it never sends either.

/// What the device is, in the terms the decision needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SendRole {
    /// No redundancy, or the main.
    Main,
    /// A backup; `hosting` when the main is lost or it runs standalone
    /// (`hosts_for_failover`).
    Backup { hosting: bool },
    /// A guest of a network session.
    Guest,
}

pub fn should_send_lyrics(role: SendRole, enabled: bool, paused: bool) -> bool {
    if !enabled || paused {
        return false;
    }
    match role {
        SendRole::Main => true,
        SendRole::Backup { hosting } => hosting,
        SendRole::Guest => false,
    }
}

/// The role as the desktop knows it: a locked transport is a backup
/// following its main (`DesktopSession::timeline_midi_suppressed`).
pub fn role_from_transport(transport_locked: bool, guest: bool) -> SendRole {
    if guest {
        SendRole::Guest
    } else if transport_locked {
        SendRole::Backup { hosting: false }
    } else {
        SendRole::Main
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn main_and_hosting_backup_send_following_backup_and_guest_never() {
        assert!(should_send_lyrics(SendRole::Main, true, false));
        assert!(should_send_lyrics(SendRole::Backup { hosting: true }, true, false));
        assert!(!should_send_lyrics(SendRole::Backup { hosting: false }, true, false));
        assert!(!should_send_lyrics(SendRole::Guest, true, false));
        assert!(!should_send_lyrics(SendRole::Main, true, true), "paused");
        assert!(!should_send_lyrics(SendRole::Main, false, false), "disabled");
    }

    #[test]
    fn the_gate_matches_the_timeline_midi_suppression() {
        // Locked transport = backup following = MIDI suppressed = no lyrics.
        for locked in [false, true] {
            let sends = should_send_lyrics(role_from_transport(locked, false), true, false);
            assert_eq!(sends, !locked);
        }
        assert!(!should_send_lyrics(role_from_transport(false, true), true, false));
    }
}
