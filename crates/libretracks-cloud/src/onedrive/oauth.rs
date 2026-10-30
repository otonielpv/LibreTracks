//! Microsoft identity platform, as an [`OAuthProvider`].
//!
//! # The refresh token rotates
//!
//! Unlike Google and Dropbox, every refresh answers with a NEW refresh token,
//! and the previous one is on its way out. [`crate::token::StoredToken::apply_refresh`]
//! keeps whichever arrives and [`crate::token::TokenManager`] persists it on
//! every refresh and serialises concurrent ones; this file only has to make
//! sure the forms are right.

use url::Url;

use super::{AUTH_ENDPOINT, CLIENT_ID, SCOPES, TOKEN_ENDPOINT};
use crate::oauth::{AuthSession, OAuthProvider};

#[derive(Debug, Clone, Copy, Default)]
pub struct OneDriveOAuth;

impl OneDriveOAuth {
    /// The client id, or an empty string in a build without one. Callers check
    /// [`super::CLIENT_ID`] before starting a sign-in, so the empty value is
    /// never actually sent.
    fn client_id() -> &'static str {
        CLIENT_ID.unwrap_or("")
    }
}

/// Start a sign-in. `port` is the loopback listener's on desktop and ignored
/// on mobile.
pub fn begin(port: u16) -> Result<AuthSession, crate::oauth::OauthError> {
    AuthSession::begin(super::redirect_uri(port))
}

impl OAuthProvider for OneDriveOAuth {
    fn name(&self) -> &'static str {
        "OneDrive"
    }

    fn token_endpoint(&self) -> &str {
        TOKEN_ENDPOINT
    }

    fn authorization_url(&self, session: &AuthSession) -> String {
        let mut url = Url::parse(AUTH_ENDPOINT).expect("AUTH_ENDPOINT is a valid URL");
        url.query_pairs_mut()
            .append_pair("client_id", Self::client_id())
            .append_pair("redirect_uri", session.redirect_uri())
            .append_pair("response_type", "code")
            .append_pair("response_mode", "query")
            .append_pair("scope", SCOPES)
            .append_pair("code_challenge", &session.code_challenge())
            .append_pair("code_challenge_method", "S256")
            .append_pair("state", session.state())
            // Always offer the account picker. Without it Microsoft silently
            // reuses whichever account the browser is signed into, and someone
            // with a work and a personal account cannot choose.
            .append_pair("prompt", "select_account");
        url.to_string()
    }

    fn exchange_form(&self, session: &AuthSession, code: &str) -> Vec<(&'static str, String)> {
        vec![
            ("client_id", Self::client_id().to_string()),
            ("code", code.to_string()),
            ("code_verifier", session.code_verifier().to_string()),
            ("grant_type", "authorization_code".to_string()),
            ("redirect_uri", session.redirect_uri().to_string()),
            ("scope", SCOPES.to_string()),
        ]
    }

    /// Public client: no secret, ever. Sending one for a "Mobile and desktop"
    /// registration is itself an error (AADSTS700025).
    fn refresh_form(&self, refresh_token: &str) -> Vec<(&'static str, String)> {
        vec![
            ("client_id", Self::client_id().to_string()),
            ("refresh_token", refresh_token.to_string()),
            ("grant_type", "refresh_token".to_string()),
            ("scope", SCOPES.to_string()),
        ]
    }
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
    fn authorization_url_is_a_pkce_code_request_for_the_app_folder() {
        let session = AuthSession::begin("http://localhost:5000").unwrap();
        let params = params_of(&OneDriveOAuth.authorization_url(&session));
        assert!(OneDriveOAuth
            .authorization_url(&session)
            .starts_with("https://login.microsoftonline.com/common/oauth2/v2.0/authorize?"));
        assert_eq!(params["response_type"], "code");
        assert_eq!(params["scope"], SCOPES);
        assert_eq!(params["code_challenge"], session.code_challenge());
        assert_eq!(params["code_challenge_method"], "S256");
        assert_eq!(params["redirect_uri"], "http://localhost:5000");
        assert_eq!(params["state"], session.state());
    }

    #[test]
    fn exchange_and_refresh_never_carry_a_secret() {
        let session = AuthSession::begin("http://localhost:5000").unwrap();
        let exchange: HashMap<_, _> =
            OneDriveOAuth.exchange_form(&session, "M.C1_code").into_iter().collect();
        assert_eq!(exchange["grant_type"], "authorization_code");
        assert_eq!(exchange["code_verifier"], session.code_verifier());
        assert_eq!(exchange["redirect_uri"], "http://localhost:5000");
        assert!(!exchange.contains_key("client_secret"));

        let refresh: HashMap<_, _> = OneDriveOAuth.refresh_form("M.R3_old").into_iter().collect();
        assert_eq!(refresh["grant_type"], "refresh_token");
        assert_eq!(refresh["refresh_token"], "M.R3_old");
        assert!(!refresh.contains_key("client_secret"));
    }
}
