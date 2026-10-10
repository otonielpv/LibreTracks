//! Deciding who gets in, and with which role. Pure: no sockets, no clock of
//! its own (the caller passes `now_ms`), no randomness of its own (the caller
//! passes the token generator), so every rule is tested.
//!
//! Rules (docs/plans/network-sessions/00-DISENO.md §4.2):
//! 1. incompatible protocol → rejected with the version the host speaks;
//! 2. an IP that failed too many PINs is locked out for a while;
//! 3. a valid trusted-device token for that device id → its stored role;
//! 4. a PIN equal to the editor PIN → editor; to the controller PIN →
//!    controller; anything else → `badPin` (never a silent downgrade: the
//!    user wanted a role and must know they did not get it);
//! 5. no PIN → viewer;
//! 6. PIN login with `remember` → a new token, stored hashed.

use std::collections::HashMap;
use std::net::IpAddr;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::permissions::{Grants, Role};
use crate::protocol::RejectReason;
use crate::version::negotiate;

pub const MAX_PIN_FAILURES: u32 = 5;
pub const LOCKOUT_MS: u64 = 30_000;

/// A device the host remembers. Persisted by the app; the token itself is
/// never stored, only its hash.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustedDevice {
    pub device_id: String,
    pub device_name: String,
    pub role: Role,
    pub token_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HelloRequest<'a> {
    pub protocol_version: u32,
    pub device_id: &'a str,
    pub device_name: &'a str,
    pub pin: Option<&'a str>,
    pub remember: bool,
    pub token: Option<&'a str>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HelloOutcome {
    Accepted {
        protocol_version: u32,
        grants: Grants,
        /// Only when a new token was issued (PIN login with `remember`).
        new_token: Option<String>,
    },
    Rejected {
        reason: RejectReason,
        expected_protocol: Option<u32>,
    },
}

#[derive(Debug, Clone, Default)]
struct Failures {
    count: u32,
    locked_until_ms: u64,
}

#[derive(Debug, Clone, Default)]
pub struct Pairing {
    control_pin: Option<String>,
    edit_pin: Option<String>,
    trusted: HashMap<String, TrustedDevice>,
    failures: HashMap<IpAddr, Failures>,
}

fn normalize_pin(pin: Option<String>) -> Option<String> {
    pin.map(|pin| pin.trim().to_string())
        .filter(|pin| !pin.is_empty())
}

pub fn hash_token(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Equal-time comparison: a short PIN must not leak its prefix through how
/// long a wrong guess takes.
fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

impl Pairing {
    pub fn new(
        control_pin: Option<String>,
        edit_pin: Option<String>,
        trusted: Vec<TrustedDevice>,
    ) -> Self {
        Self {
            control_pin: normalize_pin(control_pin),
            edit_pin: normalize_pin(edit_pin),
            trusted: trusted
                .into_iter()
                .map(|device| (device.device_id.clone(), device))
                .collect(),
            failures: HashMap::new(),
        }
    }

    pub fn set_pins(&mut self, control_pin: Option<String>, edit_pin: Option<String>) {
        self.control_pin = normalize_pin(control_pin);
        self.edit_pin = normalize_pin(edit_pin);
    }

    pub fn requires_pin_for_roles(&self) -> bool {
        self.control_pin.is_some() || self.edit_pin.is_some()
    }

    pub fn trusted_devices(&self) -> Vec<TrustedDevice> {
        let mut devices: Vec<_> = self.trusted.values().cloned().collect();
        devices.sort_by(|a, b| a.device_name.cmp(&b.device_name));
        devices
    }

    /// Forget a device. Returns whether it was trusted.
    pub fn revoke(&mut self, device_id: &str) -> bool {
        self.trusted.remove(device_id).is_some()
    }

    /// Keep a trusted device's stored role in step with a live role change.
    pub fn update_trusted_role(&mut self, device_id: &str, role: Role) {
        if let Some(device) = self.trusted.get_mut(device_id) {
            device.role = role;
        }
    }

    fn role_for_pin(&self, pin: &str) -> Option<Role> {
        // Editor first: if both PINs are the same, the higher role wins.
        if self
            .edit_pin
            .as_deref()
            .is_some_and(|edit| constant_time_eq(edit, pin))
        {
            return Some(Role::Editor);
        }
        if self
            .control_pin
            .as_deref()
            .is_some_and(|control| constant_time_eq(control, pin))
        {
            return Some(Role::Controller);
        }
        None
    }

    pub fn evaluate(
        &mut self,
        ip: IpAddr,
        now_ms: u64,
        host_protocol: u32,
        request: &HelloRequest<'_>,
        new_token: impl FnOnce() -> String,
    ) -> HelloOutcome {
        let protocol_version = match negotiate(host_protocol, request.protocol_version) {
            Ok(version) => version,
            Err(incompatible) => {
                return HelloOutcome::Rejected {
                    reason: RejectReason::IncompatibleVersion,
                    expected_protocol: Some(incompatible.expected),
                }
            }
        };

        if let Some(token) = request.token {
            if let Some(device) = self.trusted.get_mut(request.device_id) {
                if constant_time_eq(&device.token_hash, &hash_token(token)) {
                    device.device_name = request.device_name.to_string();
                    return HelloOutcome::Accepted {
                        protocol_version,
                        grants: Grants { role: device.role },
                        new_token: None,
                    };
                }
            }
            // A stale or foreign token is not an error: fall through to the
            // PIN (or viewer) path like a first-time device.
        }

        let pin = request.pin.map(str::trim).filter(|pin| !pin.is_empty());
        let Some(pin) = pin else {
            return HelloOutcome::Accepted {
                protocol_version,
                grants: Grants::VIEWER,
                new_token: None,
            };
        };

        let failures = self.failures.entry(ip).or_default();
        if failures.locked_until_ms > now_ms {
            return HelloOutcome::Rejected {
                reason: RejectReason::RateLimited,
                expected_protocol: None,
            };
        }

        let Some(role) = self.role_for_pin(pin) else {
            let failures = self.failures.entry(ip).or_default();
            failures.count += 1;
            if failures.count >= MAX_PIN_FAILURES {
                failures.count = 0;
                failures.locked_until_ms = now_ms + LOCKOUT_MS;
            }
            return HelloOutcome::Rejected {
                reason: RejectReason::BadPin,
                expected_protocol: None,
            };
        };

        self.failures.remove(&ip);
        let new_token = request.remember.then(|| {
            let token = new_token();
            self.trusted.insert(
                request.device_id.to_string(),
                TrustedDevice {
                    device_id: request.device_id.to_string(),
                    device_name: request.device_name.to_string(),
                    role,
                    token_hash: hash_token(&token),
                },
            );
            token
        });

        HelloOutcome::Accepted {
            protocol_version,
            grants: Grants { role },
            new_token,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;

    const IP: IpAddr = IpAddr::V4(Ipv4Addr::new(192, 168, 1, 20));
    const OTHER_IP: IpAddr = IpAddr::V4(Ipv4Addr::new(192, 168, 1, 21));

    fn pairing() -> Pairing {
        Pairing::new(Some("1111".into()), Some("2222".into()), vec![])
    }

    fn hello<'a>(pin: Option<&'a str>, remember: bool, token: Option<&'a str>) -> HelloRequest<'a> {
        HelloRequest {
            protocol_version: 1,
            device_id: "ipad",
            device_name: "iPad de Ana",
            pin,
            remember,
            token,
        }
    }

    fn role(outcome: &HelloOutcome) -> Option<Role> {
        match outcome {
            HelloOutcome::Accepted { grants, .. } => Some(grants.role),
            HelloOutcome::Rejected { .. } => None,
        }
    }

    fn reason(outcome: &HelloOutcome) -> Option<RejectReason> {
        match outcome {
            HelloOutcome::Rejected { reason, .. } => Some(*reason),
            HelloOutcome::Accepted { .. } => None,
        }
    }

    #[test]
    fn no_pin_joins_as_viewer() {
        let outcome = pairing().evaluate(IP, 0, 1, &hello(None, false, None), || unreachable!());
        assert_eq!(role(&outcome), Some(Role::Viewer));
    }

    #[test]
    fn blank_pin_counts_as_no_pin() {
        let outcome =
            pairing().evaluate(IP, 0, 1, &hello(Some("  "), false, None), || unreachable!());
        assert_eq!(role(&outcome), Some(Role::Viewer));
    }

    #[test]
    fn each_pin_gives_its_role() {
        let mut p = pairing();
        let control = p.evaluate(
            IP,
            0,
            1,
            &hello(Some("1111"), false, None),
            || unreachable!(),
        );
        let edit = p.evaluate(
            IP,
            0,
            1,
            &hello(Some(" 2222 "), false, None),
            || unreachable!(),
        );
        assert_eq!(role(&control), Some(Role::Controller));
        assert_eq!(role(&edit), Some(Role::Editor));
    }

    #[test]
    fn same_pin_for_both_roles_gives_editor() {
        let mut p = Pairing::new(Some("9".into()), Some("9".into()), vec![]);
        let outcome = p.evaluate(IP, 0, 1, &hello(Some("9"), false, None), || unreachable!());
        assert_eq!(role(&outcome), Some(Role::Editor));
    }

    #[test]
    fn wrong_pin_is_rejected_not_downgraded() {
        let outcome = pairing().evaluate(
            IP,
            0,
            1,
            &hello(Some("0000"), false, None),
            || unreachable!(),
        );
        assert_eq!(reason(&outcome), Some(RejectReason::BadPin));
    }

    #[test]
    fn disabled_role_pin_is_rejected() {
        let mut p = Pairing::new(None, None, vec![]);
        let outcome = p.evaluate(
            IP,
            0,
            1,
            &hello(Some("1111"), false, None),
            || unreachable!(),
        );
        assert_eq!(reason(&outcome), Some(RejectReason::BadPin));
    }

    #[test]
    fn five_failures_lock_the_ip_for_thirty_seconds() {
        let mut p = pairing();
        for _ in 0..MAX_PIN_FAILURES {
            let outcome = p.evaluate(
                IP,
                1_000,
                1,
                &hello(Some("x"), false, None),
                || unreachable!(),
            );
            assert_eq!(reason(&outcome), Some(RejectReason::BadPin));
        }
        // Even the right PIN is refused while locked.
        let locked = p.evaluate(
            IP,
            1_000 + LOCKOUT_MS - 1,
            1,
            &hello(Some("1111"), false, None),
            || unreachable!(),
        );
        assert_eq!(reason(&locked), Some(RejectReason::RateLimited));
        // Another IP is unaffected.
        let other = p.evaluate(
            OTHER_IP,
            1_000,
            1,
            &hello(Some("1111"), false, None),
            || unreachable!(),
        );
        assert_eq!(role(&other), Some(Role::Controller));
        // After the lockout the right PIN works again.
        let after = p.evaluate(
            IP,
            1_000 + LOCKOUT_MS,
            1,
            &hello(Some("1111"), false, None),
            || unreachable!(),
        );
        assert_eq!(role(&after), Some(Role::Controller));
    }

    #[test]
    fn viewer_join_is_never_rate_limited() {
        let mut p = pairing();
        for _ in 0..MAX_PIN_FAILURES {
            p.evaluate(IP, 0, 1, &hello(Some("x"), false, None), || unreachable!());
        }
        let outcome = p.evaluate(IP, 0, 1, &hello(None, false, None), || unreachable!());
        assert_eq!(role(&outcome), Some(Role::Viewer));
    }

    #[test]
    fn remember_issues_a_token_that_skips_the_pin_next_time() {
        let mut p = pairing();
        let first = p.evaluate(IP, 0, 1, &hello(Some("2222"), true, None), || {
            "secret".into()
        });
        let HelloOutcome::Accepted { new_token, .. } = &first else {
            panic!("expected accepted");
        };
        assert_eq!(new_token.as_deref(), Some("secret"));
        let stored = p.trusted_devices();
        assert_eq!(stored.len(), 1);
        assert_ne!(stored[0].token_hash, "secret", "only the hash is stored");

        let again = p.evaluate(
            IP,
            0,
            1,
            &hello(None, false, Some("secret")),
            || unreachable!(),
        );
        assert_eq!(role(&again), Some(Role::Editor));
    }

    #[test]
    fn without_remember_no_token_is_issued() {
        let mut p = pairing();
        let outcome = p.evaluate(
            IP,
            0,
            1,
            &hello(Some("2222"), false, None),
            || unreachable!(),
        );
        let HelloOutcome::Accepted { new_token, .. } = outcome else {
            panic!();
        };
        assert_eq!(new_token, None);
        assert!(p.trusted_devices().is_empty());
    }

    #[test]
    fn token_of_another_device_does_not_work() {
        let mut p = pairing();
        p.evaluate(IP, 0, 1, &hello(Some("2222"), true, None), || {
            "secret".into()
        });
        let thief = HelloRequest {
            device_id: "phone",
            ..hello(None, false, Some("secret"))
        };
        let outcome = p.evaluate(IP, 0, 1, &thief, || unreachable!());
        assert_eq!(role(&outcome), Some(Role::Viewer));
    }

    #[test]
    fn revoked_device_falls_back_to_viewer() {
        let mut p = pairing();
        p.evaluate(IP, 0, 1, &hello(Some("2222"), true, None), || {
            "secret".into()
        });
        assert!(p.revoke("ipad"));
        let outcome = p.evaluate(
            IP,
            0,
            1,
            &hello(None, false, Some("secret")),
            || unreachable!(),
        );
        assert_eq!(role(&outcome), Some(Role::Viewer));
    }

    #[test]
    fn live_role_change_is_remembered_for_trusted_devices() {
        let mut p = pairing();
        p.evaluate(IP, 0, 1, &hello(Some("2222"), true, None), || {
            "secret".into()
        });
        p.update_trusted_role("ipad", Role::Controller);
        let outcome = p.evaluate(
            IP,
            0,
            1,
            &hello(None, false, Some("secret")),
            || unreachable!(),
        );
        assert_eq!(role(&outcome), Some(Role::Controller));
    }

    #[test]
    fn incompatible_version_is_rejected_with_expected() {
        let request = HelloRequest {
            protocol_version: 7,
            ..hello(None, false, None)
        };
        let outcome = pairing().evaluate(IP, 0, 1, &request, || unreachable!());
        assert_eq!(
            outcome,
            HelloOutcome::Rejected {
                reason: RejectReason::IncompatibleVersion,
                expected_protocol: Some(1)
            }
        );
    }

    #[test]
    fn constant_time_eq_matches_plain_equality() {
        assert!(constant_time_eq("1234", "1234"));
        assert!(!constant_time_eq("1234", "1235"));
        assert!(!constant_time_eq("123", "1234"));
    }
}
