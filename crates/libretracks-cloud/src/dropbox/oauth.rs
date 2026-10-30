//! Dropbox OAuth 2, as an [`OAuthProvider`].
//!
//! Dropbox issues short-lived access tokens (four hours) and, when asked with
//! `token_access_type=offline`, a refresh token that does not rotate and does
//! not expire until the user revokes it.

use url::Url;

use super::{APP_KEY, AUTH_ENDPOINT, SCOPES, TOKEN_ENDPOINT};
use crate::oauth::{AuthSession, OAuthProvider};

#[derive(Debug, Clone, Copy, Default)]
pub struct DropboxOAuth;

impl DropboxOAuth {
    /// Empty in a build without an app key. Callers check
    /// [`super::APP_KEY`] before starting a sign-in.
    fn app_key() -> &'static str {
        APP_KEY.unwrap_or("")
    }
}

/// Start a sign-in. `port` is the loopback listener's on desktop (one of
/// [`super::LOOPBACK_PORTS`]) and ignored on mobile.
pub fn begin(port: u16) -> Result<AuthSession, crate::oauth::OauthError> {
    AuthSession::begin(super::redirect_uri(port))
}

impl OAuthProvider for DropboxOAuth {
    fn name(&self) -> &'static str {
        "Dropbox"
    }

    fn token_endpoint(&self) -> &str {
        TOKEN_ENDPOINT
    }

    fn authorization_url(&self, session: &AuthSession) -> String {
        let mut url = Url::parse(AUTH_ENDPOINT).expect("AUTH_ENDPOINT is a valid URL");
        url.query_pairs_mut()
            .append_pair("client_id", Self::app_key())
            .append_pair("redirect_uri", session.redirect_uri())
            .append_pair("response_type", "code")
            .append_pair("code_challenge", &session.code_challenge())
            .append_pair("code_challenge_method", "S256")
            .append_pair("state", session.state())
            .append_pair("scope", SCOPES)
            // Without this Dropbox issues a four-hour token and no refresh
            // token, and the user signs in again every afternoon.
            .append_pair("token_access_type", "offline");
        url.to_string()
    }

    fn exchange_form(&self, session: &AuthSession, code: &str) -> Vec<(&'static str, String)> {
        vec![
            ("client_id", Self::app_key().to_string()),
            ("code", code.to_string()),
            ("code_verifier", session.code_verifier().to_string()),
            ("grant_type", "authorization_code".to_string()),
            ("redirect_uri", session.redirect_uri().to_string()),
        ]
    }

    fn refresh_form(&self, refresh_token: &str) -> Vec<(&'static str, String)> {
        vec![
            ("client_id", Self::app_key().to_string()),
            ("refresh_token", refresh_token.to_string()),
            ("grant_type", "refresh_token".to_string()),
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

    /// token_access_type=offline is the one parameter whose absence looks
    /// fine for four hours and then logs the user out.
    #[test]
    fn authorization_url_asks_for_offline_access_with_pkce() {
        let session = AuthSession::begin("http://127.0.0.1:53134").unwrap();
        let url = DropboxOAuth.authorization_url(&session);
        let params = params_of(&url);
        assert!(url.starts_with("https://www.dropbox.com/oauth2/authorize?"));
        assert_eq!(params["token_access_type"], "offline");
        assert_eq!(params["response_type"], "code");
        assert_eq!(params["code_challenge"], session.code_challenge());
        assert_eq!(params["code_challenge_method"], "S256");
        assert_eq!(params["redirect_uri"], "http://127.0.0.1:53134");
        assert_eq!(params["state"], session.state());
    }

    #[test]
    fn exchange_and_refresh_carry_no_secret() {
        let session = AuthSession::begin("http://127.0.0.1:53134").unwrap();
        let exchange: HashMap<_, _> =
            DropboxOAuth.exchange_form(&session, "code").into_iter().collect();
        assert_eq!(exchange["grant_type"], "authorization_code");
        assert_eq!(exchange["code_verifier"], session.code_verifier());
        assert_eq!(exchange["redirect_uri"], "http://127.0.0.1:53134");
        assert!(!exchange.contains_key("client_secret"));

        let refresh: HashMap<_, _> = DropboxOAuth.refresh_form("sl.r").into_iter().collect();
        assert_eq!(refresh["grant_type"], "refresh_token");
        assert!(!refresh.contains_key("client_secret"));
    }
}
