//! Protocol versioning. Bands mix app versions all the time, so a host
//! accepts its own version and the previous one; anything else is rejected
//! with the version the host expects, so the guest can say which side needs
//! updating.

/// Bump when a message or command changes shape in a way an older peer
/// cannot read. Adding an optional field does not need a bump.
///
/// - 1: typed commands, transport/song/live-settings mirroring.
/// - 2: mirror mode, `invoke` of desktop commands and relayed app events.
///   A v1 host would silently drop `invoke`, so a v2 guest must be told to
///   update it instead.
pub const PROTOCOL_VERSION: u32 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Incompatible {
    /// The version the host speaks.
    pub expected: u32,
    /// The version the guest offered.
    pub offered: u32,
}

/// Decide the version a connection will use. `Ok` carries the guest's
/// version: the host talks down to a guest one version behind.
pub fn negotiate(host: u32, guest: u32) -> Result<u32, Incompatible> {
    if guest == host || guest.checked_add(1) == Some(host) {
        Ok(guest)
    } else {
        Err(Incompatible {
            expected: host,
            offered: guest,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_version_is_accepted() {
        assert_eq!(negotiate(1, 1), Ok(1));
    }

    #[test]
    fn guest_one_version_behind_is_accepted() {
        assert_eq!(negotiate(2, 1), Ok(1));
    }

    #[test]
    fn guest_two_versions_behind_is_rejected_with_expected_version() {
        assert_eq!(
            negotiate(3, 1),
            Err(Incompatible {
                expected: 3,
                offered: 1
            })
        );
    }

    #[test]
    fn guest_newer_than_host_is_rejected() {
        assert_eq!(
            negotiate(1, 2),
            Err(Incompatible {
                expected: 1,
                offered: 2
            })
        );
    }

    #[test]
    fn version_zero_host_does_not_overflow() {
        assert_eq!(negotiate(0, 0), Ok(0));
        assert!(negotiate(0, u32::MAX).is_err());
    }
}
