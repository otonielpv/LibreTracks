//! PKCE (RFC 7636) — the reason LibreTracks can talk to Google without holding
//! a secret.
//!
//! # Why this matters more here than in a typical app
//!
//! LibreTracks is AGPL: every byte of it is published. A classic OAuth client
//! secret would therefore be printed in the repository, which is not a secret
//! at all. PKCE removes the need for one — the client invents a random
//! `code_verifier`, sends only its SHA-256 hash when it asks for the
//! authorization code, and reveals the verifier itself when redeeming that
//! code. An attacker who intercepts the redirect gets a code they cannot spend.
//!
//! Google's Android and iOS client types issue no secret at all and rely on
//! exactly this. The "Desktop app" type does still hand you one, but Google
//! documents it as non-confidential for installed apps (RFC 8252 says the same)
//! and PKCE is what actually protects that flow.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use sha2::{Digest, Sha256};

/// A PKCE `code_verifier`: the random secret kept in memory for the length of
/// one sign-in and never written anywhere.
///
/// Not `Clone` and not `Debug`-printable on purpose. A verifier that reaches a
/// log file alongside its redirect is the one way this scheme fails, so the
/// type refuses to be copied around or accidentally formatted.
pub struct CodeVerifier(String);

impl CodeVerifier {
    /// Generate a fresh verifier from the OS random source.
    ///
    /// 32 random bytes encode to 43 base64url characters, the shortest length
    /// RFC 7636 allows (43..=128) and the one every server accepts. All 43
    /// characters are drawn from the unreserved set, so the value survives
    /// being put in a query string untouched.
    pub fn generate() -> Result<Self, PkceError> {
        let mut bytes = [0u8; 32];
        getrandom::getrandom(&mut bytes).map_err(|e| PkceError::Random(e.to_string()))?;
        Ok(Self(URL_SAFE_NO_PAD.encode(bytes)))
    }

    /// Build from an existing string, validating RFC 7636's length rule.
    ///
    /// Only useful for tests and for replaying the spec's vectors; real
    /// verifiers always come from [`CodeVerifier::generate`].
    pub fn from_string(value: impl Into<String>) -> Result<Self, PkceError> {
        let value = value.into();
        if !(43..=128).contains(&value.len()) {
            return Err(PkceError::InvalidLength(value.len()));
        }
        Ok(Self(value))
    }

    /// The `code_challenge` to send with the authorization request: the
    /// base64url-encoded SHA-256 of the verifier ("S256" method).
    ///
    /// The plain method — sending the verifier itself — is also in the spec and
    /// must never be used: it protects nothing.
    pub fn challenge(&self) -> String {
        let digest = Sha256::digest(self.0.as_bytes());
        URL_SAFE_NO_PAD.encode(digest)
    }

    /// The verifier itself, for the token-exchange request that redeems the
    /// authorization code. This is the only place it may leave the type.
    pub fn reveal(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, thiserror::Error)]
pub enum PkceError {
    #[error("the OS random source failed: {0}")]
    Random(String),
    #[error("a code verifier must be 43 to 128 characters, got {0}")]
    InvalidLength(usize),
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 7636, Appendix B. If this ever fails the challenge we send is wrong
    /// and every sign-in is rejected, so it is worth pinning to the spec's own
    /// numbers rather than to whatever our code happens to produce.
    #[test]
    fn matches_the_rfc_7636_test_vector() {
        let verifier =
            CodeVerifier::from_string("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk").unwrap();
        assert_eq!(
            verifier.challenge(),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn generated_verifiers_are_43_chars_and_url_safe() {
        let verifier = CodeVerifier::generate().unwrap();
        assert_eq!(verifier.reveal().len(), 43);
        assert!(verifier
            .reveal()
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    }

    #[test]
    fn generated_verifiers_differ() {
        let a = CodeVerifier::generate().unwrap();
        let b = CodeVerifier::generate().unwrap();
        assert_ne!(a.reveal(), b.reveal());
    }

    #[test]
    fn rejects_lengths_outside_the_spec() {
        assert!(matches!(
            CodeVerifier::from_string("tooshort"),
            Err(PkceError::InvalidLength(8))
        ));
        assert!(CodeVerifier::from_string("x".repeat(129)).is_err());
        assert!(CodeVerifier::from_string("x".repeat(43)).is_ok());
        assert!(CodeVerifier::from_string("x".repeat(128)).is_ok());
    }
}
