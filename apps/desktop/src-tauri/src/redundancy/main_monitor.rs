//! The main's side of the lifecycle (redundancy step 07): reads what the
//! backup sends (heartbeats, status, a role-change offer), keeps
//! `MainLifecycle` and tells the UI. `BackupLost` is a warning only: nothing
//! here touches the main's audio.

use libretracks_core::redundancy::lifecycle::{MainLifecycle, ReportedPhase, RoleOffer};
use libretracks_link::redundancy::{
    BackupPhase, HeartbeatMonitor, RedundancyMessage, DEFAULT_HEARTBEAT_TIMEOUT_MS,
};

/// Pure: messages and ticks in, lifecycle out.
#[derive(Debug)]
pub struct MainMonitorCore {
    pub lifecycle: MainLifecycle,
    monitor: HeartbeatMonitor,
    reported: Option<ReportedPhase>,
    pub offset_ms: Option<f64>,
    /// The backup took over (step 15): who, and its remote, once.
    handover: Option<Handover>,
}

/// The backup told this main it took over.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Handover {
    pub new_main_name: String,
    pub new_main_address: Option<String>,
    pub remote_url: Option<String>,
}

impl Default for MainMonitorCore {
    fn default() -> Self {
        Self {
            lifecycle: MainLifecycle::default(),
            monitor: HeartbeatMonitor::new(DEFAULT_HEARTBEAT_TIMEOUT_MS),
            reported: None,
            offset_ms: None,
            handover: None,
        }
    }
}

fn reported(phase: BackupPhase) -> ReportedPhase {
    match phase {
        BackupPhase::Pairing | BackupPhase::CheckingSession => ReportedPhase::CheckingSession,
        BackupPhase::SessionMismatch => ReportedPhase::SessionMismatch,
        BackupPhase::Following => ReportedPhase::Following,
        BackupPhase::Armed => ReportedPhase::Armed,
        BackupPhase::MainLost => ReportedPhase::MainLost,
        BackupPhase::Standalone => ReportedPhase::Standalone,
        BackupPhase::Diverged => ReportedPhase::Diverged,
    }
}

impl MainMonitorCore {
    pub fn on_message(&mut self, message: RedundancyMessage, now_ms: u64) {
        self.monitor.observe(now_ms);
        match message {
            RedundancyMessage::BackupStatus {
                phase, offset_ms, ..
            } => {
                self.reported = Some(reported(phase));
                self.offset_ms = offset_ms;
            }
            RedundancyMessage::RoleChange {
                new_main_name,
                new_main_address,
            } => self.lifecycle.offer_role_change(RoleOffer {
                new_main_name,
                new_main_address,
            }),
            RedundancyMessage::Handover {
                new_main_name,
                new_main_address,
                remote_url,
            } => {
                // The old main becomes the new main's backup only if its
                // user accepts (the offer); the handover itself is acted on
                // at once (tone off, clients moved).
                self.lifecycle.offer_role_change(RoleOffer {
                    new_main_name: new_main_name.clone(),
                    new_main_address: new_main_address.clone(),
                });
                self.handover = Some(Handover {
                    new_main_name,
                    new_main_address,
                    remote_url,
                });
            }
            _ => {}
        }
    }

    /// A handover that arrived since the last call.
    pub fn take_handover(&mut self) -> Option<Handover> {
        self.handover.take()
    }

    /// Returns whether the state changed.
    pub fn tick(&mut self, backup_connected: bool, now_ms: u64) -> bool {
        if !backup_connected {
            self.monitor.forget();
            self.reported = None;
        }
        self.lifecycle
            .observe(
                backup_connected,
                backup_connected && self.monitor.is_alive(now_ms),
                self.reported,
            )
            .is_some()
    }
}

#[cfg(test)]
mod tests {
    use std::net::{IpAddr, Ipv4Addr};
    use std::time::Duration;

    use libretracks_core::redundancy::lifecycle::MainState;
    use libretracks_link::{connect_as_backup, start_host, GuestConfig, GuestState, HostConfig};

    use super::*;

    #[test]
    fn a_handover_is_an_offer_plus_an_action_taken_once() {
        let mut core = MainMonitorCore::default();
        core.on_message(
            RedundancyMessage::Handover {
                new_main_name: "PC B".into(),
                new_main_address: Some("10.0.0.2:3040".into()),
                remote_url: Some("http://10.0.0.2:3030".into()),
            },
            0,
        );
        let handover = core.take_handover().expect("handover");
        assert_eq!(handover.remote_url.as_deref(), Some("http://10.0.0.2:3030"));
        assert!(core.take_handover().is_none(), "acted on once");
        assert_eq!(
            core.lifecycle.pending_offer().map(|offer| offer.new_main_name.as_str()),
            Some("PC B")
        );
    }

    #[test]
    fn heartbeats_and_status_drive_the_main_lifecycle() {
        let mut core = MainMonitorCore::default();
        assert!(!core.tick(false, 0));
        core.on_message(
            RedundancyMessage::BackupStatus {
                phase: BackupPhase::Armed,
                offset_ms: Some(0.7),
                last_correction_ms: None,
                fingerprint: None,
                mix_diverged: false,
            },
            100,
        );
        assert!(core.tick(true, 100));
        assert_eq!(core.lifecycle.state(), MainState::BackupArmed);
        // Connected but silent for over the timeout: lost.
        assert!(core.tick(true, 100 + DEFAULT_HEARTBEAT_TIMEOUT_MS + 1));
        assert_eq!(core.lifecycle.state(), MainState::BackupLost);
    }

    /// Step 15 C2: a backup that takes over with the main alive tells it
    /// over the open channel; the main's monitor sees the handover.
    #[test]
    fn a_planned_handover_reaches_the_live_main() {
        tauri::async_runtime::block_on(async {
            let mut main = start_host(HostConfig {
                bind_ip: IpAddr::from(Ipv4Addr::LOCALHOST),
                preferred_port: 0,
                port_attempts: 1,
                accept_guests: false,
                accept_backup: true,
                backup_pin: Some("4321".into()),
                ..HostConfig::new("PC A")
            })
            .await
            .unwrap();
            let port = main.handle.port();
            let mut backup = connect_as_backup(GuestConfig {
                pin: Some("4321".into()),
                ..GuestConfig::new(format!("ws://127.0.0.1:{port}"), "pc-b")
            })
            .unwrap();
            tokio::time::timeout(Duration::from_secs(5), async {
                while backup.handle.state() != GuestState::Connected {
                    let _ = backup.events.recv().await;
                }
            })
            .await
            .unwrap();
            assert!(backup.handle.send_redundancy(RedundancyMessage::Handover {
                new_main_name: "PC B".into(),
                new_main_address: Some("127.0.0.1:3041".into()),
                remote_url: Some("http://127.0.0.1:3030".into()),
            }));
            let mut core = MainMonitorCore::default();
            let handover = tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    let message = main.backup_messages.recv().await.unwrap();
                    core.on_message(message, 0);
                    if let Some(handover) = core.take_handover() {
                        return handover;
                    }
                }
            })
            .await
            .unwrap();
            assert_eq!(handover.new_main_name, "PC B");
            assert!(core.lifecycle.pending_offer().is_some());
            main.handle.stop();
        });
    }

    /// C7: the backup became the main and reconnects to the old main to
    /// offer the swap; the old main keeps its role until its user accepts.
    #[test]
    fn a_role_change_offer_waits_for_the_old_mains_user() {
        tauri::async_runtime::block_on(async {
            let mut old_main = start_host(HostConfig {
                bind_ip: IpAddr::from(Ipv4Addr::LOCALHOST),
                preferred_port: 0,
                port_attempts: 1,
                accept_guests: false,
                accept_backup: true,
                backup_pin: Some("4321".into()),
                ..HostConfig::new("PC A")
            })
            .await
            .unwrap();
            let port = old_main.handle.port();
            let mut new_main = connect_as_backup(GuestConfig {
                pin: Some("4321".into()),
                ..GuestConfig::new(format!("ws://127.0.0.1:{port}"), "pc-b")
            })
            .unwrap();
            tokio::time::timeout(Duration::from_secs(5), async {
                while new_main.handle.state() != GuestState::Connected {
                    let _ = new_main.events.recv().await;
                }
            })
            .await
            .unwrap();
            assert!(new_main.handle.send_redundancy(RedundancyMessage::RoleChange {
                new_main_name: "PC B".into(),
                new_main_address: Some("10.0.0.2:3040".into()),
            }));

            let mut core = MainMonitorCore::default();
            tokio::time::timeout(Duration::from_secs(5), async {
                while core.lifecycle.pending_offer().is_none() {
                    let message = old_main.backup_messages.recv().await.unwrap();
                    core.on_message(message, 0);
                }
            })
            .await
            .unwrap();
            // Still the main: nothing changed on its own.
            core.tick(true, 0);
            assert!(core.lifecycle.pending_offer().is_some());
            // The user accepts: now (and only now) the switch can happen.
            let offer = core.lifecycle.accept_offer().unwrap();
            assert_eq!(offer.new_main_name, "PC B");
            assert_eq!(offer.new_main_address.as_deref(), Some("10.0.0.2:3040"));
            old_main.handle.stop();
        });
    }
}
