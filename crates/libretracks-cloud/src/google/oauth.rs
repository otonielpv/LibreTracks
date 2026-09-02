//! The sign-in itself: building the authorization request, checking what comes
//! back, and turning a code into tokens.
//!
//! Nothing here performs I/O. It builds URLs and form bodies and validates
//! responses, so the whole flow is unit-testable without a network or a
//! browser, and the platform-specific plumbing (a loopback listener on desktop,
//! a deep link on mobile) stays outside.

use serde::Deserialize;
use url::Url;

use super::client_config::{self, RedirectUri};
use super::{AUTH_ENDPOINT, DRIVE_SCOPE};
use crate::pkce::{CodeVerifier, PkceError};

/// One sign-in attempt, alive from the moment the browser opens until the
/// redirect comes back. Holds the two values that must not leak or drift: the
/// PKCE verifier and the anti-forgery state.
pub struct AuthSession {
    verifier: CodeVerifier,
    state: String,
    redirect_uri: String,
}

impl AuthSession {
    /// Start a sign-in for this build's client and redirect.
    ///
    /// `port` matters only on desktop, where it is the port the loopback
    /// listener actually bound. Mobile ignores it.
    pub fn begin(port: u16) -> Result<Self, OauthError> {
        let redirect = client_config::redirect_uri();
        Self::begin_with_redirect(&redirect, port)
    }

    pub fn begin_with_redirect(redirect: &RedirectUri, port: u16) -> Result<Self, OauthError> {
        Ok(Self {
            verifier: CodeVerifier::generate()?,
            state: random_state()?,
            redirect_uri: client_config::redirect_uri_string(redirect, port),
        })
    }

    /// The URL to open in the system browser.
    ///
    /// Must be the *system* browser (or an in-app tab like
    /// ASWebAuthenticationSession / Custom Tabs), never an embedded WebView:
    /// Google rejects those outright with `disallowed_useragent`.
    pub fn authorization_url(&self) -> String {
        let mut url = Url::parse(AUTH_ENDPOINT).expect("AUTH_ENDPOINT is a valid URL");
        url.query_pairs_mut()
            .append_pair("client_id", client_config::client_id())
            .append_pair("redirect_uri", &self.redirect_uri)
            .append_pair("response_type", "code")
            .append_pair("scope", DRIVE_SCOPE)
            .append_pair("code_challenge", &self.verifier.challenge())
            .append_pair("code_challenge_method", "S256")
            .append_pair("state", &self.state)
            // Without this Google issues an access token that dies in an hour
            // and no refresh token at all, so the user would be asked to sign
            // in again every hour. It is the single most common reason a
            // working-looking OAuth integration is unusable in practice.
            .append_pair("access_type", "offline")
            // Google returns a refresh token only on the *first* authorization
            // for a given client and user. Someone who disconnects and
            // reconnects would otherwise get no refresh token, appear to sign
            // in fine, and be logged out an hour later. Forcing the consent
            // screen makes every sign-in yield one.
            .append_pair("prompt", "consent");
        url.to_string()
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

    /// Form body that redeems an authorization code for tokens.
    pub fn token_exchange_form(&self, code: &str) -> Vec<(&'static str, String)> {
        let mut form = vec![
            ("client_id", client_config::client_id().to_string()),
            ("code", code.to_string()),
            ("code_verifier", self.verifier.reveal().to_string()),
            ("grant_type", "authorization_code".to_string()),
            ("redirect_uri", self.redirect_uri.clone()),
        ];
        if let Some(secret) = client_config::CLIENT_SECRET {
            form.push(("client_secret", secret.to_string()));
        }
        form
    }

    /// The state value, for tests and for logging a mismatch without exposing
    /// the verifier.
    pub fn state(&self) -> &str {
        &self.state
    }
}

/// Form body that trades a refresh token for a fresh access token.
pub fn refresh_form(refresh_token: &str) -> Vec<(&'static str, String)> {
    let mut form = vec![
        ("client_id", client_config::client_id().to_string()),
        ("refresh_token", refresh_token.to_string()),
        ("grant_type", "refresh_token".to_string()),
    ];
    if let Some(secret) = client_config::CLIENT_SECRET {
        form.push(("client_secret", secret.to_string()));
    }
    form
}

/// Google's answer to a token request.
#[derive(Debug, Clone, Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    /// Present on the first exchange; absent from every refresh, which reuses
    /// the token already stored. Losing this distinction is how an app ends up
    /// overwriting a good refresh token with nothing.
    #[serde(default)]
    pub refresh_token: Option<String>,
    /// Lifetime of the access token in seconds: an hour, in practice.
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
    use std::collections::HashMap;

    fn params_of(url: &str) -> HashMap<String, String> {
        Url::parse(url)
            .unwrap()
            .query_pairs()
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect()
    }

    #[test]
    fn authorization_url_carries_every_required_parameter() {
        let session = AuthSession::begin(51763).unwrap();
        let params = params_of(&session.authorization_url());

        assert_eq!(params["response_type"], "code");
        assert_eq!(params["scope"], DRIVE_SCOPE);
        assert_eq!(params["code_challenge_method"], "S256");
        assert_eq!(params["client_id"], client_config::client_id());
        assert_eq!(params["redirect_uri"], "http://127.0.0.1:51763");
        assert_eq!(params["state"], session.state());
        assert!(!params["code_challenge"].is_empty());
    }

    /// Both of these look optional and are not. Dropping access_type=offline
    /// yields no refresh token; dropping prompt=consent yields none on any
    /// sign-in after the first. Either way the user is silently logged out an
    /// hour later, which is the hardest kind of bug to attribute.
    #[test]
    fn authorization_url_asks_for_a_refresh_token() {
        let session = AuthSession::begin(51763).unwrap();
        let params = params_of(&session.authorization_url());
        assert_eq!(params["access_type"], "offline");
        assert_eq!(params["prompt"], "consent");
    }

    #[test]
    fn the_challenge_matches_the_verifier_that_will_be_sent() {
        let session = AuthSession::begin(1234).unwrap();
        let params = params_of(&session.authorization_url());
        let form: HashMap<_, _> = session.token_exchange_form("abc").into_iter().collect();

        let verifier = CodeVerifier::from_string(form["code_verifier"].clone()).unwrap();
        assert_eq!(params["code_challenge"], verifier.challenge());
    }

    #[test]
    fn state_round_trips_and_a_forged_one_is_rejected() {
        let session = AuthSession::begin(1234).unwrap();
        assert!(session.verify_state(session.state()).is_ok());
        assert!(matches!(
            session.verify_state("not-the-state"),
            Err(OauthError::StateMismatch)
        ));
    }

    #[test]
    fn each_sign_in_gets_a_fresh_state_and_verifier() {
        let a = AuthSession::begin(1).unwrap();
        let b = AuthSession::begin(1).unwrap();
        assert_ne!(a.state(), b.state());
        let fa: HashMap<_, _> = a.token_exchange_form("c").into_iter().collect();
        let fb: HashMap<_, _> = b.token_exchange_form("c").into_iter().collect();
        assert_ne!(fa["code_verifier"], fb["code_verifier"]);
    }

    #[test]
    fn token_exchange_form_is_an_authorization_code_grant() {
        let session = AuthSession::begin(51763).unwrap();
        let form: HashMap<_, _> = session
            .token_exchange_form("4/0AY0e-code")
            .into_iter()
            .collect();
        assert_eq!(form["grant_type"], "authorization_code");
        assert_eq!(form["code"], "4/0AY0e-code");
        assert_eq!(form["redirect_uri"], "http://127.0.0.1:51763");
        assert_eq!(form["client_id"], client_config::client_id());
    }

    #[test]
    fn refresh_form_is_a_refresh_token_grant() {
        let form: HashMap<_, _> = refresh_form("1//refresh").into_iter().collect();
        assert_eq!(form["grant_type"], "refresh_token");
        assert_eq!(form["refresh_token"], "1//refresh");
        assert!(!form.contains_key("code"));
    }

    /// A refresh response legitimately omits refresh_token. Parsing must not
    /// fail there, or every token renewal breaks an hour after sign-in.
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
