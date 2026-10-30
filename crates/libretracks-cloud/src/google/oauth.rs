//! The sign-in itself: building the authorization request, checking what comes
//! back, and turning a code into tokens.
//!
//! Nothing here performs I/O. It builds URLs and form bodies and validates
//! responses, so the whole flow is unit-testable without a network or a
//! browser, and the platform-specific plumbing (a loopback listener on desktop,
//! a deep link on mobile) stays outside.

use url::Url;

use super::client_config::{self, RedirectUri};
use super::{AUTH_ENDPOINT, DRIVE_SCOPE, TOKEN_ENDPOINT};
use crate::oauth::{AuthSession, OAuthProvider, OauthError};

/// Google, as an [`OAuthProvider`].
///
/// A unit struct: the client id, secret and redirect are decided at compile
/// time per platform by [`client_config`], so there is nothing to carry.
#[derive(Debug, Clone, Copy, Default)]
pub struct GoogleOAuth;

/// Start a sign-in for this build's client and redirect.
///
/// `port` matters only on desktop, where it is the port the loopback listener
/// actually bound. Mobile ignores it.
pub fn begin(port: u16) -> Result<AuthSession, OauthError> {
    begin_with_redirect(&client_config::redirect_uri(), port)
}

pub fn begin_with_redirect(redirect: &RedirectUri, port: u16) -> Result<AuthSession, OauthError> {
    AuthSession::begin(client_config::redirect_uri_string(redirect, port))
}

impl OAuthProvider for GoogleOAuth {
    fn name(&self) -> &'static str {
        "Google Drive"
    }

    fn token_endpoint(&self) -> &str {
        TOKEN_ENDPOINT
    }

    /// Must be opened in the *system* browser (or an in-app tab like
    /// ASWebAuthenticationSession / Custom Tabs), never an embedded WebView:
    /// Google rejects those outright with `disallowed_useragent`.
    fn authorization_url(&self, session: &AuthSession) -> String {
        let mut url = Url::parse(AUTH_ENDPOINT).expect("AUTH_ENDPOINT is a valid URL");
        url.query_pairs_mut()
            .append_pair("client_id", client_config::client_id())
            .append_pair("redirect_uri", session.redirect_uri())
            .append_pair("response_type", "code")
            .append_pair("scope", DRIVE_SCOPE)
            .append_pair("code_challenge", &session.code_challenge())
            .append_pair("code_challenge_method", "S256")
            .append_pair("state", session.state())
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

    fn exchange_form(&self, session: &AuthSession, code: &str) -> Vec<(&'static str, String)> {
        let mut form = vec![
            ("client_id", client_config::client_id().to_string()),
            ("code", code.to_string()),
            ("code_verifier", session.code_verifier().to_string()),
            ("grant_type", "authorization_code".to_string()),
            ("redirect_uri", session.redirect_uri().to_string()),
        ];
        if let Some(secret) = client_config::CLIENT_SECRET {
            form.push(("client_secret", secret.to_string()));
        }
        form
    }

    fn refresh_form(&self, refresh_token: &str) -> Vec<(&'static str, String)> {
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
        let session = begin(51763).unwrap();
        let params = params_of(&GoogleOAuth.authorization_url(&session));

        assert_eq!(params["response_type"], "code");
        assert_eq!(params["scope"], DRIVE_SCOPE);
        assert_eq!(params["code_challenge_method"], "S256");
        assert_eq!(params["client_id"], client_config::client_id());
        assert_eq!(params["redirect_uri"], "http://127.0.0.1:51763");
        assert_eq!(params["state"], session.state());
        assert_eq!(params["code_challenge"], session.code_challenge());
    }

    /// Both of these look optional and are not. Dropping access_type=offline
    /// yields no refresh token; dropping prompt=consent yields none on any
    /// sign-in after the first. Either way the user is silently logged out an
    /// hour later, which is the hardest kind of bug to attribute.
    #[test]
    fn authorization_url_asks_for_a_refresh_token() {
        let session = begin(51763).unwrap();
        let params = params_of(&GoogleOAuth.authorization_url(&session));
        assert_eq!(params["access_type"], "offline");
        assert_eq!(params["prompt"], "consent");
    }

    #[test]
    fn token_exchange_form_is_an_authorization_code_grant() {
        let session = begin(51763).unwrap();
        let form: HashMap<_, _> = GoogleOAuth
            .exchange_form(&session, "4/0AY0e-code")
            .into_iter()
            .collect();
        assert_eq!(form["grant_type"], "authorization_code");
        assert_eq!(form["code"], "4/0AY0e-code");
        assert_eq!(form["redirect_uri"], "http://127.0.0.1:51763");
        assert_eq!(form["client_id"], client_config::client_id());
        assert_eq!(form["code_verifier"], session.code_verifier());
    }

    #[test]
    fn refresh_form_is_a_refresh_token_grant() {
        let form: HashMap<_, _> = GoogleOAuth.refresh_form("1//refresh").into_iter().collect();
        assert_eq!(form["grant_type"], "refresh_token");
        assert_eq!(form["refresh_token"], "1//refresh");
        assert!(!form.contains_key("code"));
    }
}
