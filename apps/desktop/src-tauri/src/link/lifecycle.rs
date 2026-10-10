//! What hosting does when the app goes to the background (plan
//! network-sessions, paso 03). Pure, so the rules are tested.
//!
//! - iOS suspends the app's sockets in the background. Instead of leaving
//!   guests talking to a listener that no longer answers, the host closes in
//!   an orderly way (guests see «connection lost» and start reconnecting) and
//!   reopens on the SAME port when it comes back, where the guests' retries
//!   find it on their own.
//! - Android keeps the process (and its sockets) alive through the media
//!   foreground service; desktop never suspends. There, nothing happens.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostPhase {
    Stopped,
    Hosting {
        port: u16,
    },
    /// Closed because the app went to the background; reopen on `port`.
    Suspended {
        port: u16,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LifecycleAction {
    None,
    Suspend,
    Resume { port: u16 },
}

/// Whether this platform suspends the app's sockets in the background.
pub const SUSPENDS_IN_BACKGROUND: bool = cfg!(target_os = "ios");

pub fn on_visibility(
    phase: HostPhase,
    hidden: bool,
    suspends: bool,
) -> (HostPhase, LifecycleAction) {
    match (phase, hidden) {
        (HostPhase::Hosting { port }, true) if suspends => {
            (HostPhase::Suspended { port }, LifecycleAction::Suspend)
        }
        (HostPhase::Suspended { port }, false) => (
            HostPhase::Hosting { port },
            LifecycleAction::Resume { port },
        ),
        (phase, _) => (phase, LifecycleAction::None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ios_host_suspends_in_the_background_and_resumes_on_the_same_port() {
        let (phase, action) = on_visibility(HostPhase::Hosting { port: 3041 }, true, true);
        assert_eq!(phase, HostPhase::Suspended { port: 3041 });
        assert_eq!(action, LifecycleAction::Suspend);
        let (phase, action) = on_visibility(phase, false, true);
        assert_eq!(phase, HostPhase::Hosting { port: 3041 });
        assert_eq!(action, LifecycleAction::Resume { port: 3041 });
    }

    #[test]
    fn platforms_that_keep_sockets_do_nothing() {
        let hosting = HostPhase::Hosting { port: 3040 };
        assert_eq!(
            on_visibility(hosting, true, false),
            (hosting, LifecycleAction::None)
        );
    }

    #[test]
    fn not_hosting_means_nothing_to_do() {
        assert_eq!(
            on_visibility(HostPhase::Stopped, true, true),
            (HostPhase::Stopped, LifecycleAction::None)
        );
        assert_eq!(
            on_visibility(HostPhase::Stopped, false, true),
            (HostPhase::Stopped, LifecycleAction::None)
        );
    }

    #[test]
    fn repeated_events_are_harmless() {
        let suspended = HostPhase::Suspended { port: 1 };
        assert_eq!(
            on_visibility(suspended, true, true),
            (suspended, LifecycleAction::None)
        );
        let hosting = HostPhase::Hosting { port: 1 };
        assert_eq!(
            on_visibility(hosting, false, true),
            (hosting, LifecycleAction::None)
        );
    }
}
