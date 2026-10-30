//! The provider-independent half of an OAuth sign-in.
//!
//! Google, Microsoft and Dropbox all speak the same authorization-code grant
//! with PKCE: open a browser, get a code back on a redirect, trade it for a
//! refresh token, trade that for access tokens forever after. What differs is
//! the endpoints, the extra parameters each one insists on, and whether the
//! refresh token rotates. That difference is [`OAuthProvider`]; everything
//! else lives here once.
//!
//! Nothing here performs I/O. It builds URLs and form bodies and validates
//! responses, so the flow is unit-testable without a network or a browser.

use serde::Deserialize;

use crate::pkce::{CodeVerifier, PkceError};

/// What one OAuth provider needs to be told, and how.
///
/// Implemented once per backend (`google::oauth::GoogleOAuth`, and so on).
/// [`crate::token::TokenManager`] and [`crate::token::exchange_code`] only
/// ever see this trait, which is what lets a second provider be a new file
/// instead of a fork of the token code.
pub trait OAuthProvider: Send + Sync {
    /// Human name, for error messages: "Google Drive", "OneDrive", "Dropbox".
    ///
    /// Also keys the process-wide refresh lock, so two providers must never
    /// share one.
    fn name(&self) -> &'static str;

    /// Where codes and refresh tokens are exchanged for access tokens.
    fn token_endpoint(&self) -> &str;

    /// The URL to open in the system browser for this sign-in.
    fn authorization_url(&self, session: &AuthSession) -> String;

    /// Form body that redeems an authorization code.
    fn exchange_form(&self, session: &AuthSession, code: &str) -> Vec<(&'static str, String)>;

    /// Form body that trades a refresh token for a fresh access token.
    fn refresh_form(&self, refresh_token: &str) -> Vec<(&'static str, String)>;
}

/// One sign-in attempt, alive from the moment the browser opens until the
/// redirect comes back. Holds the two values that must not leak or drift: the
/// PKCE verifier and the anti-forgery state.
pub struct AuthSession {
    verifier: CodeVerifier,
    state: String,
    redirect_uri: String,
}

impl AuthSession {
    /// Start a sign-in that will come back on `redirect_uri`.
    pub fn begin(redirect_uri: impl Into<String>) -> Result<Self, OauthError> {
        Ok(Self {
            verifier: CodeVerifier::generate()?,
            state: random_state()?,
            redirect_uri: redirect_uri.into(),
        })
    }

    /// Check the `state` echoed back by the redirect.
    ///
    /// This is what stops another process on the machine from feeding us an
    /// authorization code obtained for a different account or a different app,
    /// a real concern for the desktop loopback flow where anything on the box
    /// can hit 127.0.0.1.
    pub fn verify_state(&self, returned_state: &str) -> Result<(), OauthError> {
        if returned_state == self.state {
            Ok(())
        } else {
            Err(OauthError::StateMismatch)
        }
    }

    /// The state value, for building the request and for tests. Not secret.
    pub fn state(&self) -> &str {
        &self.state
    }

    /// The redirect exactly as it must appear in BOTH the authorization request
    /// and the code exchange. Every provider rejects the exchange if the two
    /// differ by so much as a trailing slash.
    pub fn redirect_uri(&self) -> &str {
        &self.redirect_uri
    }

    /// S256 challenge for the authorization request.
    pub fn code_challenge(&self) -> String {
        self.verifier.challenge()
    }

    /// The verifier, for the code exchange only.
    pub fn code_verifier(&self) -> &str {
        self.verifier.reveal()
    }
}

/// A token endpoint's answer. The three providers agree on these fields.
#[derive(Debug, Clone, Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    /// Present on the first exchange. On a refresh it depends on the provider:
    /// Google and Dropbox omit it and the stored one stays valid; Microsoft
    /// sends a new one every time and the old one is on its way out. Losing
    /// this distinction is how an app ends up overwriting a good refresh token
    /// with nothing, or keeping a dead one.
    #[serde(default)]
    pub refresh_token: Option<String>,
    /// Lifetime of the access token in seconds: an hour or four, in practice.
    pub expires_in: u64,
}

/// An anti-forgery token: 128 bits of randomness, URL-safe.
fn random_state() -> Result<String, OauthError> {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine as _;
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).map_err(|e| OauthError::Random(e.to_string()))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

#[derive(Debug, thiserror::Error)]
pub enum OauthError {
    #[error("the OS random source failed: {0}")]
    Random(String),
    #[error("the redirect carried a different state than the one we sent")]
    StateMismatch,
    #[error(transparent)]
    Pkce(#[from] PkceError),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_round_trips_and_a_forged_one_is_rejected() {
        let session = AuthSession::begin("http://127.0.0.1:1234").unwrap();
        assert!(session.verify_state(session.state()).is_ok());
        assert!(matches!(
            session.verify_state("not-the-state"),
            Err(OauthError::StateMismatch)
        ));
    }

    #[test]
    fn each_sign_in_gets_a_fresh_state_and_verifier() {
        let a = AuthSession::begin("x:/cb").unwrap();
        let b = AuthSession::begin("x:/cb").unwrap();
        assert_ne!(a.state(), b.state());
        assert_ne!(a.code_verifier(), b.code_verifier());
    }

    #[test]
    fn the_challenge_belongs_to_the_verifier() {
        let session = AuthSession::begin("x:/cb").unwrap();
        let verifier = CodeVerifier::from_string(session.code_verifier().to_string()).unwrap();
        assert_eq!(session.code_challenge(), verifier.challenge());
    }

    /// A refresh response from Google or Dropbox legitimately omits
    /// refresh_token. Parsing must not fail there, or every token renewal
    /// breaks an hour after sign-in.
    #[test]
    fn a_refresh_response_without_a_refresh_token_parses() {
        let json = r#"{"access_token":"ya29.x","expires_in":3599}"#;
        let parsed: TokenResponse = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.access_token, "ya29.x");
        assert_eq!(parsed.expires_in, 3599);
        assert!(parsed.refresh_token.is_none());
    }

    #[test]
    fn a_first_exchange_response_keeps_the_refresh_token() {
        let json = r#"{"access_token":"ya29.x","expires_in":3599,"refresh_token":"1//r","token_type":"Bearer"}"#;
        let parsed: TokenResponse = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.refresh_token.as_deref(), Some("1//r"));
    }
}
