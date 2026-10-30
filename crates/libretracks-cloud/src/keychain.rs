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

/// Characters per credential entry.
///
/// Windows Credential Manager caps a credential at 2560 bytes, and `keyring`
/// stores the text as UTF-16, so one entry holds at most 1280 characters.
/// Google's token fits; Microsoft's and Dropbox's do not (their access tokens
/// alone run past a thousand characters), and saving them failed with
/// "Attribute 'password encoded as UTF-16' is longer than platform limit of
/// 2560 chars" right after the user had authorised. Larger blobs are split
/// across several entries. 1000 leaves margin under the limit; the JSON is
/// ASCII, so characters and bytes per character are predictable.
const CHUNK_CHARS: usize = 1000;

/// What the main entry holds when the token is split: this prefix and the
/// number of parts. A real token is JSON and always starts with `{`, so the
/// two can never be confused.
const CHUNKED_PREFIX: &str = "chunks:";

/// Split a serialised token into entry-sized parts. One part means "store it
/// as is", which is also exactly what older builds wrote.
pub(crate) fn split_blob(raw: &str) -> Vec<String> {
    let chars: Vec<char> = raw.chars().collect();
    if chars.len() <= CHUNK_CHARS {
        return vec![raw.to_string()];
    }
    chars
        .chunks(CHUNK_CHARS)
        .map(|part| part.iter().collect())
        .collect()
}

/// The number of parts announced by a main entry, or `None` if it holds the
/// token itself.
pub(crate) fn chunk_count(main: &str) -> Option<usize> {
    main.strip_prefix(CHUNKED_PREFIX)?.parse().ok()
}

pub struct KeychainTokenStore {
    provider: String,
}

impl KeychainTokenStore {
    /// One entry per provider, named by `CloudProvider::key`, so the accounts
    /// never collide and disconnecting one leaves the others alone. A token
    /// too long for one entry also uses `<key>#1`, `<key>#2`… for its parts.
    pub fn new(provider: &str) -> Result<Self, CloudError> {
        // Fail early, here, if there is no credential store at all, as before.
        entry(provider)?;
        Ok(Self {
            provider: provider.to_string(),
        })
    }

    fn part_name(&self, index: usize) -> String {
        format!("{}#{index}", self.provider)
    }

    fn read_main(&self) -> Result<Option<String>, CloudError> {
        read(&entry(&self.provider)?)
    }

    /// Delete parts `from..=to`. Missing ones are fine.
    fn delete_parts(&self, from: usize, to: usize) -> Result<(), CloudError> {
        for index in from..=to {
            delete(&entry(&self.part_name(index))?)?;
        }
        Ok(())
    }
}

fn entry(user: &str) -> Result<keyring::Entry, CloudError> {
    keyring::Entry::new(SERVICE, user)
        .map_err(|e| CloudError::Network(format!("credential store unavailable: {e}")))
}

fn read(entry: &keyring::Entry) -> Result<Option<String>, CloudError> {
    match entry.get_password() {
        Ok(raw) => Ok(Some(raw)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(CloudError::Network(format!(
            "could not read the credential store: {e}"
        ))),
    }
}

fn write(entry: &keyring::Entry, value: &str) -> Result<(), CloudError> {
    entry
        .set_password(value)
        .map_err(|e| CloudError::Network(format!("could not write the credential store: {e}")))
}

fn delete(entry: &keyring::Entry) -> Result<(), CloudError> {
    match entry.delete_credential() {
        // Already gone is the desired end state, not a failure: disconnect
        // must succeed even when called twice or after a manual cleanup.
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(CloudError::Network(format!(
            "could not clear the credential store: {e}"
        ))),
    }
}

impl TokenStore for KeychainTokenStore {
    fn load(&self) -> Result<Option<StoredToken>, CloudError> {
        let Some(main) = self.read_main()? else {
            return Ok(None);
        };
        let raw = match chunk_count(&main) {
            None => main,
            Some(count) => {
                let mut joined = String::new();
                for index in 1..=count {
                    match read(&entry(&self.part_name(index))?)? {
                        Some(part) => joined.push_str(&part),
                        // A part missing is a token that cannot be rebuilt;
                        // treated like a corrupt one below.
                        None => {
                            joined.clear();
                            break;
                        }
                    }
                }
                joined
            }
        };
        match serde_json::from_str(&raw) {
            Ok(token) => Ok(Some(token)),
            // A blob that will not parse is a token from an older shape, or
            // something corrupt. Either way it is unusable, and reporting an
            // error would leave the user permanently unable to connect with no
            // way out from inside the app. Drop it and ask them to sign in
            // again, which always works.
            Err(_) => {
                let _ = self.clear();
                Ok(None)
            }
        }
    }

    fn save(&self, token: &StoredToken) -> Result<(), CloudError> {
        let raw =
            serde_json::to_string(token).map_err(|e| CloudError::Network(e.to_string()))?;
        let previous_parts = self
            .read_main()?
            .as_deref()
            .and_then(chunk_count)
            .unwrap_or(0);
        let parts = split_blob(&raw);

        if parts.len() == 1 {
            write(&entry(&self.provider)?, &parts[0])?;
        } else {
            // Parts first, header last: until the header names them, a
            // half-written set is not what `load` reads.
            for (index, part) in parts.iter().enumerate() {
                write(&entry(&self.part_name(index + 1))?, part)?;
            }
            write(
                &entry(&self.provider)?,
                &format!("{CHUNKED_PREFIX}{}", parts.len()),
            )?;
        }

        // Leftovers from a longer token saved before. Microsoft rotates its
        // refresh token on every refresh, so the length changes routinely.
        let written = if parts.len() == 1 { 0 } else { parts.len() };
        if previous_parts > written {
            self.delete_parts(written + 1, previous_parts)?;
        }
        Ok(())
    }

    fn clear(&self) -> Result<(), CloudError> {
        if let Some(count) = self.read_main()?.as_deref().and_then(chunk_count) {
            self.delete_parts(1, count)?;
        }
        delete(&entry(&self.provider)?)
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
        let main = entry("test-corrupt").unwrap();
        main.set_password("not json at all").unwrap();

        assert_eq!(store.load().unwrap(), None);
        // And it cleaned up after itself, so the next sign-in starts clean.
        assert!(matches!(main.get_password(), Err(keyring::Error::NoEntry)));
    }

    /// A Microsoft-sized token, the one Windows refused to store in one piece.
    fn huge_token(refresh_len: usize) -> StoredToken {
        StoredToken {
            refresh_token: format!("M.C5_BAY.{}", "r".repeat(refresh_len)),
            access_token: format!("EwBwA8l6BAAU{}", "a".repeat(2500)),
            expires_at_unix: 4_599,
        }
    }

    /// The bug: "password encoded as UTF-16 is longer than platform limit of
    /// 2560 chars" when connecting OneDrive or Dropbox on Windows.
    #[test]
    #[ignore = "touches the real OS credential store"]
    fn a_token_too_long_for_one_entry_survives_a_round_trip() {
        let store = KeychainTokenStore::new("test-huge").unwrap();
        let token = huge_token(900);
        store.save(&token).unwrap();
        assert_eq!(store.load().unwrap(), Some(token));
        store.clear().unwrap();
        assert_eq!(store.load().unwrap(), None);
        assert!(matches!(
            entry("test-huge#1").unwrap().get_password(),
            Err(keyring::Error::NoEntry)
        ));
    }

    /// Microsoft rotates the refresh token, so the next save may need fewer
    /// parts. The extra ones must go, or they would linger in the user's
    /// credential manager forever.
    #[test]
    #[ignore = "touches the real OS credential store"]
    fn a_shorter_token_removes_the_parts_it_no_longer_needs() {
        let store = KeychainTokenStore::new("test-shrink").unwrap();
        store.save(&huge_token(3000)).unwrap();
        let small = StoredToken {
            refresh_token: "r".into(),
            access_token: "a".into(),
            expires_at_unix: 1,
        };
        store.save(&small).unwrap();
        assert_eq!(store.load().unwrap(), Some(small));
        for index in 1..=8 {
            assert!(
                matches!(
                    entry(&format!("test-shrink#{index}")).unwrap().get_password(),
                    Err(keyring::Error::NoEntry)
                ),
                "part {index} was left behind"
            );
        }
        store.clear().unwrap();
    }

    #[test]
    fn a_small_token_is_stored_as_is() {
        let raw = r#"{"refresh_token":"1//r","access_token":"ya29.a","expires_at_unix":1}"#;
        assert_eq!(split_blob(raw), vec![raw.to_string()]);
        assert_eq!(chunk_count(raw), None);
    }

    #[test]
    fn a_large_token_splits_into_entry_sized_parts_that_rejoin() {
        let raw = serde_json::to_string(&huge_token(900)).unwrap();
        let parts = split_blob(&raw);
        assert!(parts.len() > 1);
        // UTF-16 doubles every character; Windows allows 2560 bytes.
        assert!(parts.iter().all(|part| part.encode_utf16().count() * 2 <= 2560));
        assert_eq!(parts.concat(), raw);
    }

    #[test]
    fn the_header_announces_the_part_count() {
        assert_eq!(chunk_count("chunks:4"), Some(4));
        assert_eq!(chunk_count("chunks:x"), None);
        assert_eq!(chunk_count("{\"chunks:3\":1}"), None);
    }
}
