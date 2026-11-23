//! Planning Center OAuth 2, as an [`OAuthProvider`].
//!
//! A "Public" application (no secret) with PKCE S256, scope `services`. The
//! registered redirects are three loopback ports on desktop and the app's own
//! scheme on mobile; Planning Center matches them exactly, path included.

use libretracks_cloud::oauth::{AuthSession, OAuthProvider, OauthError};
use url::Url;

pub const AUTH_ENDPOINT: &str = "https://api.planningcenteronline.com/oauth/authorize";
pub const TOKEN_ENDPOINT: &str = "https://api.planningcenteronline.com/oauth/token";
pub const SCOPES: &str = "services";

/// Loopback ports registered as `http://127.0.0.1:<port>/oauth/planning-center`.
/// Adding one here without registering it fails only after the user has
/// already authorised.
pub const LOOPBACK_PORTS: [u16; 3] = [53_137, 53_138, 53_139];
pub const REDIRECT_PATH: &str = "/oauth/planning-center";
/// The mobile redirect, registered in the same application.
pub const MOBILE_REDIRECT_URI: &str = "com.libretracks.app:/oauth/planning-center";

/// The client id this build presents, from `LT_PCO_CLIENT_ID` at compile
/// time. Not in the source: the registered application belongs to a test
/// organization until the real one exists. Without it the app does not offer
/// Planning Center at all.
pub const BUILD_CLIENT_ID: Option<&str> = match option_env!("LT_PCO_CLIENT_ID") {
    Some(id) if !id.is_empty() => Some(id),
    _ => None,
};

/// Whether this build can sign in to Planning Center.
pub fn is_configured() -> bool {
    BUILD_CLIENT_ID.is_some()
}

/// The redirect this build sends.
pub fn redirect_uri(port: u16) -> String {
    if cfg!(any(target_os = "ios", target_os = "android")) {
        MOBILE_REDIRECT_URI.to_string()
    } else {
        format!("http://127.0.0.1:{port}{REDIRECT_PATH}")
    }
}

/// Start a sign-in. `port` is the loopback listener's on desktop (one of
/// [`LOOPBACK_PORTS`]) and ignored on mobile.
pub fn begin(port: u16) -> Result<AuthSession, OauthError> {
    AuthSession::begin(redirect_uri(port))
}

#[derive(Debug, Clone)]
pub struct PlanningCenterOAuth {
    client_id: String,
}

impl PlanningCenterOAuth {
    /// With an explicit client id (the probe, tests).
    pub fn new(client_id: impl Into<String>) -> Self {
        Self {
            client_id: client_id.into(),
        }
    }

    /// With the build's client id; `None` when the build has none.
    pub fn from_build() -> Option<Self> {
        BUILD_CLIENT_ID.map(Self::new)
    }
}

impl OAuthProvider for PlanningCenterOAuth {
    fn name(&self) -> &'static str {
        "Planning Center"
    }

    fn token_endpoint(&self) -> &str {
        TOKEN_ENDPOINT
    }

    fn authorization_url(&self, session: &AuthSession) -> String {
        let mut url = Url::parse(AUTH_ENDPOINT).expect("AUTH_ENDPOINT is a valid URL");
        url.query_pairs_mut()
            .append_pair("client_id", &self.client_id)
            .append_pair("redirect_uri", session.redirect_uri())
            .append_pair("response_type", "code")
            .append_pair("scope", SCOPES)
            .append_pair("code_challenge", &session.code_challenge())
            .append_pair("code_challenge_method", "S256")
            .append_pair("state", session.state());
        url.to_string()
    }

    fn exchange_form(&self, session: &AuthSession, code: &str) -> Vec<(&'static str, String)> {
        vec![
            ("grant_type", "authorization_code".to_string()),
            ("client_id", self.client_id.clone()),
            ("code", code.to_string()),
            ("code_verifier", session.code_verifier().to_string()),
            ("redirect_uri", session.redirect_uri().to_string()),
        ]
    }

    fn refresh_form(&self, refresh_token: &str) -> Vec<(&'static str, String)> {
        // A rotated refresh token comes back in the answer and
        // `StoredToken::apply_refresh` keeps it; an omitted one keeps the old.
        vec![
            ("grant_type", "refresh_token".to_string()),
            ("client_id", self.client_id.clone()),
            ("refresh_token", refresh_token.to_string()),
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
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect()
    }

    #[test]
    fn authorization_url_asks_for_services_with_pkce() {
        let session = AuthSession::begin(redirect_uri(LOOPBACK_PORTS[0])).unwrap();
        let url = PlanningCenterOAuth::new("abc").authorization_url(&session);
        let params = params_of(&url);
        assert!(url.starts_with("https://api.planningcenteronline.com/oauth/authorize?"));
        assert_eq!(params["client_id"], "abc");
        assert_eq!(params["scope"], "services");
        assert_eq!(params["response_type"], "code");
        assert_eq!(params["code_challenge"], session.code_challenge());
        assert_eq!(params["code_challenge_method"], "S256");
        assert_eq!(params["state"], session.state());
        assert_eq!(
            params["redirect_uri"],
            "http://127.0.0.1:53137/oauth/planning-center"
        );
    }

    #[test]
    fn exchange_and_refresh_carry_no_secret_and_the_same_redirect() {
        let session = AuthSession::begin(redirect_uri(LOOPBACK_PORTS[1])).unwrap();
        let provider = PlanningCenterOAuth::new("abc");
        let authorize = params_of(&provider.authorization_url(&session));
        let exchange: HashMap<_, _> = provider
            .exchange_form(&session, "code")
            .into_iter()
            .collect();
        assert_eq!(exchange["grant_type"], "authorization_code");
        assert_eq!(exchange["code"], "code");
        assert_eq!(exchange["code_verifier"], session.code_verifier());
        assert_eq!(exchange["redirect_uri"], authorize["redirect_uri"]);
        assert!(!exchange.contains_key("client_secret"));

        let refresh: HashMap<_, _> = provider.refresh_form("r1").into_iter().collect();
        assert_eq!(refresh["grant_type"], "refresh_token");
        assert_eq!(refresh["refresh_token"], "r1");
        assert!(!refresh.contains_key("client_secret"));
    }

    /// Built without `LT_PCO_CLIENT_ID` (CI, forks), the app hides the source.
    #[test]
    fn configured_only_with_a_build_client_id() {
        assert_eq!(
            is_configured(),
            option_env!("LT_PCO_CLIENT_ID").is_some_and(|id| !id.is_empty())
        );
        assert_eq!(PlanningCenterOAuth::from_build().is_some(), is_configured());
    }

    #[test]
    fn loopback_ports_are_distinct() {
        let mut ports = LOOPBACK_PORTS.to_vec();
        ports.sort_unstable();
        ports.dedup();
        assert_eq!(ports.len(), LOOPBACK_PORTS.len());
    }
}
