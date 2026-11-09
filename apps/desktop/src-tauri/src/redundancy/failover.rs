//! Moving clients to the new main (redundancy steps 16-17).
//!
//! - The backup tells the main where it can be reached (`BackupInfo`); the
//!   main announces it to its network-session guests (`Failover`) and keeps
//!   it for its remote (step 17).
//! - The main replicates its guest access (PINs, trusted guests' token
//!   hashes) to the backup (`GuestAccess`).
//! - When the backup loses the main or takes command, it starts hosting a
//!   network session with that access, so the guests get in with the same
//!   role and no PIN.
//! - On a handover the main redirects its guests at once (`Redirect`).

use std::sync::Mutex;

use libretracks_core::redundancy::lifecycle::BackupState;
use libretracks_link::redundancy::RedundancyMessage;
use libretracks_link::{HostConfig, HostHandle, TrustedDevice};
use tauri::{AppHandle, Manager};

use super::main_monitor::Handover;

/// The main's guest access, as the backup received it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct GuestAccess {
    pub control_pin: Option<String>,
    pub edit_pin: Option<String>,
    pub trusted: Vec<TrustedDevice>,
}

/// Where the backup said it can be reached (main side).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct BackupAddresses {
    pub link_address: Option<String>,
    pub remote_url: Option<String>,
}

#[derive(Default)]
pub struct FailoverState {
    /// Backup side.
    replicated_access: Mutex<Option<GuestAccess>>,
    /// Main side.
    backup_addresses: Mutex<Option<BackupAddresses>>,
}

/// Whether a backup in `state` hosts a network session for the main's
/// guests: only once it carries the show (lost main or took command). While
/// it follows, the guests belong to the main.
pub fn hosts_for_failover(state: BackupState) -> bool {
    matches!(state, BackupState::MainLost { .. } | BackupState::Standalone)
}

/// The main's access merged into this machine's hosting config: the main's
/// PINs (its guests know those) and the union of trusted guests.
pub fn merge_access(host: &mut HostConfig, access: &GuestAccess) {
    host.control_pin = access.control_pin.clone().or(host.control_pin.take());
    host.edit_pin = access.edit_pin.clone().or(host.edit_pin.take());
    for device in &access.trusted {
        if !host
            .trusted
            .iter()
            .any(|known| known.device_id == device.device_id)
        {
            host.trusted.push(device.clone());
        }
    }
}

// --- main side ---

/// What the main sends its backup about its guests.
pub fn guest_access_message(app: &AppHandle) -> Option<RedundancyMessage> {
    let link = app.state::<crate::link::LinkState>();
    let config = link.config.lock().ok()?;
    let trusted = crate::link::host::with_handle(app, |handle| handle.trusted_devices())
        .unwrap_or_else(|| config.trusted.clone());
    Some(RedundancyMessage::GuestAccess {
        control_pin: crate::link::config::NetworkSessionConfig::pin(&config.control_pin),
        edit_pin: crate::link::config::NetworkSessionConfig::pin(&config.edit_pin),
        trusted,
    })
}

/// The backup said where it is: guests of a hosted session hear it now.
pub fn backup_announced(app: &AppHandle, addresses: BackupAddresses) {
    if let Some(handle) = crate::link::host::with_handle(app, HostHandle::clone) {
        handle.set_failover_address(addresses.link_address.clone());
    }
    super::remote_failover::backup_remote(app, addresses.remote_url.clone());
    if let Ok(mut slot) = app.state::<FailoverState>().backup_addresses.lock() {
        *slot = Some(addresses);
    }
}

/// The backup is gone: nowhere to fail over to.
pub fn backup_gone(app: &AppHandle) {
    let had = app
        .state::<FailoverState>()
        .backup_addresses
        .lock()
        .ok()
        .and_then(|mut slot| slot.take())
        .is_some();
    if had {
        if let Some(handle) = crate::link::host::with_handle(app, HostHandle::clone) {
            handle.set_failover_address(None);
        }
        super::remote_failover::backup_remote(app, None);
    }
}

/// Hosting started on the main after the backup announced itself.
pub fn hosting_started(app: &AppHandle, handle: &HostHandle) {
    let address = app
        .state::<FailoverState>()
        .backup_addresses
        .lock()
        .ok()
        .and_then(|slot| slot.as_ref().and_then(|a| a.link_address.clone()));
    if address.is_some() {
        handle.set_failover_address(address);
    }
}

/// This main handed over to its backup: send its guests and remote clients
/// there.
pub fn main_handed_over(app: &AppHandle, handle: &HostHandle, handover: &Handover) {
    if let Some(address) = &handover.new_main_address {
        // The guests are on the network session's server, which may be
        // `handle` itself or another one.
        let hosting = crate::link::host::with_handle(app, HostHandle::clone);
        hosting.as_ref().unwrap_or(handle).redirect_guests(address);
    }
    super::remote_failover::handed_over(app, handover.remote_url.clone());
}

// --- backup side ---

pub fn store_replicated_access(app: &AppHandle, access: GuestAccess) {
    if let Ok(mut slot) = app.state::<FailoverState>().replicated_access.lock() {
        *slot = Some(access);
    }
}

/// The access a backup hosting for failover uses, if it has one.
pub fn replicated_access(app: &AppHandle) -> Option<GuestAccess> {
    let role = app.state::<super::role::RedundancyState>().role();
    if role != super::role::RedundancyRole::Backup {
        return None;
    }
    app.state::<FailoverState>()
        .replicated_access
        .lock()
        .ok()
        .and_then(|slot| slot.clone())
}

/// The backup now carries the show: host the main's guests.
pub fn start_hosting_for_failover(app: &AppHandle) {
    let already = crate::link::host::with_handle(app, |_| ()).is_some();
    if already {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = crate::link::host::start(&app).await {
            eprintln!("[redundancy] could not host for failover: {error}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use libretracks_link::Role;

    #[test]
    fn the_backup_hosts_only_once_it_carries_the_show() {
        assert!(!hosts_for_failover(BackupState::Following));
        assert!(!hosts_for_failover(BackupState::Armed));
        assert!(!hosts_for_failover(BackupState::Pairing));
        assert!(!hosts_for_failover(BackupState::SessionMismatch));
        assert!(!hosts_for_failover(BackupState::Diverged));
        assert!(hosts_for_failover(BackupState::MainLost { since_ns: 1 }));
        assert!(hosts_for_failover(BackupState::Standalone));
    }

    #[test]
    fn the_mains_access_is_merged_not_replacing_the_backups_own_guests() {
        let device = |id: &str| TrustedDevice {
            device_id: id.into(),
            device_name: id.into(),
            role: Role::Controller,
            token_hash: format!("hash-{id}"),
        };
        let mut host = HostConfig {
            control_pin: Some("9999".into()),
            edit_pin: Some("8888".into()),
            trusted: vec![device("own")],
            ..HostConfig::new("PC B")
        };
        merge_access(
            &mut host,
            &GuestAccess {
                control_pin: Some("1111".into()),
                edit_pin: None,
                trusted: vec![device("tablet"), device("own")],
            },
        );
        assert_eq!(host.control_pin.as_deref(), Some("1111"), "the main's PIN");
        assert_eq!(host.edit_pin.as_deref(), Some("8888"), "kept when the main has none");
        let ids: Vec<_> = host.trusted.iter().map(|d| d.device_id.as_str()).collect();
        assert_eq!(ids, vec!["own", "tablet"]);
    }
}
