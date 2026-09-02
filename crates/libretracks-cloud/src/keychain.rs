//! Desktop [`TokenStore`] backed by the operating system credential store.
//!
//! Windows Credential Manager, the macOS Keychain, and Secret Service or the
//! kernel keyring on Linux, reached uniformly through the `keyring` crate.
//!
//! # Why not the settings file
//!
//! A refresh token is standing authorisation to reach part of a real person's
//! Google Drive, valid until they revoke it. In the app settings JSON it would
//! be readable by anything running as that user, would end up in backups, and
//! would travel in any support bundle or screen share. The OS store is what
//! exists to hold this kind of value, and it costs nothing to use.
//!
//! Mobile is excluded here: `keyring` has no Android or iOS backend, so those
//! targets need their own implementation against the Android keystore and the
//! iOS keychain.

#![cfg(not(any(target_os = "android", target_os = "ios")))]

use crate::token::{StoredToken, TokenStore};
use crate::CloudError;

/// Credential-store namespace. Appears verbatim in Credential Manager and
/// Keychain Access, so it is the app name rather than a bundle id.
const SERVICE: &str = "LibreTracks";

pub struct KeychainTokenStore {
    entry: keyring::Entry,
}

impl KeychainTokenStore {
    /// One entry per provider, so adding a second backend later does not
    /// collide with the Google credentials already stored.
    pub fn new(provider: &str) -> Result<Self, CloudError> {
        let entry = keyring::Entry::new(SERVICE, provider)
            .map_err(|e| CloudError::Network(format!("credential store unavailable: {e}")))?;
        Ok(Self { entry })
    }

    pub fn google_drive() -> Result<Self, CloudError> {
        Self::new("google-drive")
    }
}

impl TokenStore for KeychainTokenStore {
    fn load(&self) -> Result<Option<StoredToken>, CloudError> {
        match self.entry.get_password() {
            Ok(raw) => match serde_json::from_str(&raw) {
                Ok(token) => Ok(Some(token)),
                // A blob that will not parse is a token from an older shape, or
                // something corrupt. Either way it is unusable, and reporting an
                // error would leave the user permanently unable to connect with
                // no way out from inside the app. Drop it and ask them to sign
                // in again, which always works.
                Err(_) => {
                    let _ = self.clear();
                    Ok(None)
                }
            },
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(CloudError::Network(format!(
                "could not read the credential store: {e}"
            ))),
        }
    }

    fn save(&self, token: &StoredToken) -> Result<(), CloudError> {
        let raw =
            serde_json::to_string(token).map_err(|e| CloudError::Network(e.to_string()))?;
        self.entry
            .set_password(&raw)
            .map_err(|e| CloudError::Network(format!("could not write the credential store: {e}")))
    }

    fn clear(&self) -> Result<(), CloudError> {
        match self.entry.delete_credential() {
            // Already gone is the desired end state, not a failure: disconnect
            // must succeed even when called twice or after a manual cleanup.
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(CloudError::Network(format!(
                "could not clear the credential store: {e}"
            ))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Round-trips through the real credential store of whatever host runs the
    /// suite. Ignored by default: it writes to the developer machine keychain,
    /// and on Linux CI there is often no Secret Service to talk to at all.
    ///
    /// Run deliberately with:
    /// `cargo test -p libretracks-cloud -- --ignored keychain`
    #[test]
    #[ignore = "touches the real OS credential store"]
    fn a_token_survives_a_round_trip() {
        let store = KeychainTokenStore::new("test-round-trip").unwrap();
        let token = StoredToken {
            refresh_token: "1//test".into(),
            access_token: "ya29.test".into(),
            expires_at_unix: 4_599,
        };

        store.save(&token).unwrap();
        assert_eq!(store.load().unwrap(), Some(token));

        store.clear().unwrap();
        assert_eq!(store.load().unwrap(), None);
        // Clearing twice is not an error.
        store.clear().unwrap();
    }

    #[test]
    #[ignore = "touches the real OS credential store"]
    fn an_unparseable_blob_is_discarded_rather_than_failing_forever() {
        let store = KeychainTokenStore::new("test-corrupt").unwrap();
        store.entry.set_password("not json at all").unwrap();

        assert_eq!(store.load().unwrap(), None);
        // And it cleaned up after itself, so the next sign-in starts clean.
        assert!(matches!(
            store.entry.get_password(),
            Err(keyring::Error::NoEntry)
        ));
    }
}
