//! Keeping the user signed in between launches.
//!
//! # Where the token actually lives
//!
//! Not here. This module defines the shape and the refresh rules; the bytes go
//! into the operating system credential store (Windows Credential Manager, the
//! macOS and iOS keychains, the Android keystore, Secret Service on Linux) via
//! a [`TokenStore`] the desktop app supplies.
//!
//! That split is deliberate. A refresh token grants continuing access to part
//! of a real person's Drive, so it must never land in the settings JSON next to
//! the buffer size. Keeping the platform code outside also lets every rule in
//! this file be tested without a keychain, a network, or a signed build.

use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;

use serde::{Deserialize, Serialize};

use crate::google::drive::AccessTokens;
use crate::google::oauth::{refresh_form, AuthSession, TokenResponse};
use crate::google::TOKEN_ENDPOINT;
use crate::CloudError;

/// Refresh this many seconds before the access token actually expires.
///
/// A token that is valid when the request is built can still be rejected by the
/// time a chunk of a slow upload reaches Google. The margin costs one extra
/// refresh an hour and removes a whole class of intermittent 401s.
const REFRESH_MARGIN_SECS: u64 = 120;

/// What persists between launches.
///
/// Serialisable because every platform credential store takes an opaque blob,
/// not a struct: the OS keeps the bytes safe, this decides what the bytes are.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredToken {
    /// The long-lived credential. Google issues it once, on the first
    /// authorization, and it is the only reason the user does not sign in
    /// again every hour.
    pub refresh_token: String,
    /// The short-lived one actually sent with API calls. Roughly an hour.
    pub access_token: String,
    /// Unix seconds at which `access_token` stops being valid.
    pub expires_at_unix: u64,
}

impl StoredToken {
    /// Build from a fresh token response.
    pub fn from_response(response: &TokenResponse, now_unix: u64) -> Result<Self, CloudError> {
        let refresh_token = response
            .refresh_token
            .clone()
            .ok_or_else(|| {
                CloudError::Network(
                    "Google returned no refresh token; the request was missing access_type=offline"
                        .into(),
                )
            })?;
        Ok(Self {
            refresh_token,
            access_token: response.access_token.clone(),
            expires_at_unix: now_unix + response.expires_in,
        })
    }

    /// Whether the access token needs renewing, margin included.
    pub fn needs_refresh(&self, now_unix: u64) -> bool {
        now_unix + REFRESH_MARGIN_SECS >= self.expires_at_unix
    }

    /// Fold a refresh response into the stored token.
    ///
    /// A refresh response carries no `refresh_token` — Google only sends one on
    /// the first authorization. Overwriting the stored one with the absent
    /// value is the classic way to break sign-in an hour after it started
    /// working, so the old one is explicitly kept.
    pub fn apply_refresh(&mut self, response: &TokenResponse, now_unix: u64) {
        self.access_token = response.access_token.clone();
        self.expires_at_unix = now_unix + response.expires_in;
        if let Some(rotated) = response.refresh_token.clone() {
            self.refresh_token = rotated;
        }
    }
}

/// Persistence for the signed-in account, backed by the OS credential store.
pub trait TokenStore: Send + Sync {
    fn load(&self) -> Result<Option<StoredToken>, CloudError>;
    fn save(&self, token: &StoredToken) -> Result<(), CloudError>;
    /// Forget the account. Used by "Disconnect account", which App Store
    /// guideline 5.1.1(v) expects to exist inside the app.
    fn clear(&self) -> Result<(), CloudError>;
}

/// Hands out valid access tokens, refreshing behind the caller's back.
pub struct TokenManager {
    store: Box<dyn TokenStore>,
    http: reqwest::Client,
}

impl TokenManager {
    pub fn new(store: Box<dyn TokenStore>) -> Result<Self, CloudError> {
        Ok(Self {
            store,
            http: reqwest::Client::builder()
                .build()
                .map_err(|e| CloudError::Network(e.to_string()))?,
        })
    }

    /// Store the token from a completed sign-in.
    pub fn adopt(&self, token: &StoredToken) -> Result<(), CloudError> {
        self.store.save(token)
    }

    pub fn is_connected(&self) -> bool {
        matches!(self.store.load(), Ok(Some(_)))
    }

    pub fn disconnect(&self) -> Result<(), CloudError> {
        self.store.clear()
    }

    async fn refresh(&self, token: &mut StoredToken) -> Result<(), CloudError> {
        let form = refresh_form(&token.refresh_token);
        let response = self
            .http
            .post(TOKEN_ENDPOINT)
            .form(&form)
            .send()
            .await
            .map_err(|e| CloudError::Network(e.to_string()))?;

        // A refresh token dies when the user revokes access, changes their
        // password, or leaves the app unused for six months. Google answers
        // 400 invalid_grant, not 401, so matching on the status alone would
        // surface it as an opaque provider error instead of "sign in again".
        if response.status() == 400 || response.status() == 401 {
            let _ = self.store.clear();
            return Err(CloudError::NotConnected);
        }
        if !response.status().is_success() {
            let status = response.status().as_u16();
            let body = response.text().await.unwrap_or_default();
            return Err(CloudError::Provider {
                provider: "Google Drive",
                status,
                body,
            });
        }

        let parsed: TokenResponse = response
            .json()
            .await
            .map_err(|e| CloudError::Network(e.to_string()))?;
        token.apply_refresh(&parsed, now_unix());
        self.store.save(token)
    }
}

#[async_trait]
impl AccessTokens for TokenManager {
    async fn access_token(&self) -> Result<String, CloudError> {
        let mut token = self.store.load()?.ok_or(CloudError::NotConnected)?;
        if token.needs_refresh(now_unix()) {
            self.refresh(&mut token).await?;
        }
        Ok(token.access_token)
    }
}

/// Redeem an authorization code for the first pair of tokens.
///
/// The one call that must be made while the [`AuthSession`] is still alive: it
/// carries the PKCE verifier that proves this is the same client that asked for
/// the code in the first place.
pub async fn exchange_code(session: &AuthSession, code: &str) -> Result<StoredToken, CloudError> {
    let http = reqwest::Client::builder()
        .build()
        .map_err(|e| CloudError::Network(e.to_string()))?;

    let response = http
        .post(TOKEN_ENDPOINT)
        .form(&session.token_exchange_form(code))
        .send()
        .await
        .map_err(|e| CloudError::Network(e.to_string()))?;

    if !response.status().is_success() {
        let status = response.status().as_u16();
        let body = response.text().await.unwrap_or_default();
        return Err(CloudError::Provider {
            provider: "Google Drive",
            status,
            body,
        });
    }

    let parsed: TokenResponse = response
        .json()
        .await
        .map_err(|e| CloudError::Network(e.to_string()))?;
    StoredToken::from_response(&parsed, now_unix())
}

/// Seconds since the Unix epoch.
///
/// A clock set before 1970 would panic on unwrap, so it saturates instead: a
/// wrong clock should make a token look expired and force a refresh, never take
/// down the app.
pub fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn response(access: &str, refresh: Option<&str>, expires_in: u64) -> TokenResponse {
        serde_json::from_value(match refresh {
            Some(r) => serde_json::json!({
                "access_token": access,
                "refresh_token": r,
                "expires_in": expires_in
            }),
            None => serde_json::json!({
                "access_token": access,
                "expires_in": expires_in
            }),
        })
        .unwrap()
    }

    #[test]
    fn a_first_exchange_becomes_a_stored_token() {
        let token = StoredToken::from_response(&response("ya29.a", Some("1//r"), 3599), 1_000).unwrap();
        assert_eq!(token.refresh_token, "1//r");
        assert_eq!(token.access_token, "ya29.a");
        assert_eq!(token.expires_at_unix, 4_599);
    }

    /// Google omits the refresh token when the authorization request forgot
    /// access_type=offline. Failing loudly here beats storing a token that
    /// cannot be renewed and discovering it an hour later.
    #[test]
    fn a_first_exchange_without_a_refresh_token_is_rejected() {
        let err = StoredToken::from_response(&response("ya29.a", None, 3599), 1_000);
        assert!(matches!(err, Err(CloudError::Network(_))));
    }

    /// The bug this exists to prevent: a refresh response has no refresh token,
    /// and folding it in naively wipes the only credential that survives a
    /// restart.
    #[test]
    fn refreshing_keeps_the_existing_refresh_token() {
        let mut token = StoredToken {
            refresh_token: "1//original".into(),
            access_token: "ya29.old".into(),
            expires_at_unix: 1_000,
        };
        token.apply_refresh(&response("ya29.new", None, 3599), 5_000);

        assert_eq!(token.refresh_token, "1//original");
        assert_eq!(token.access_token, "ya29.new");
        assert_eq!(token.expires_at_unix, 8_599);
    }

    /// Google may rotate the refresh token. When it sends a new one it must
    /// replace the old, or the next renewal uses a credential Google has
    /// already retired.
    #[test]
    fn a_rotated_refresh_token_replaces_the_old_one() {
        let mut token = StoredToken {
            refresh_token: "1//original".into(),
            access_token: "ya29.old".into(),
            expires_at_unix: 1_000,
        };
        token.apply_refresh(&response("ya29.new", Some("1//rotated"), 3599), 5_000);
        assert_eq!(token.refresh_token, "1//rotated");
    }

    #[test]
    fn a_token_is_renewed_before_it_actually_expires() {
        let token = StoredToken {
            refresh_token: "r".into(),
            access_token: "a".into(),
            expires_at_unix: 10_000,
        };
        assert!(!token.needs_refresh(10_000 - REFRESH_MARGIN_SECS - 1));
        // Inside the margin: still technically valid, renewed anyway so a slow
        // upload does not have it expire mid-transfer.
        assert!(token.needs_refresh(10_000 - REFRESH_MARGIN_SECS));
        assert!(token.needs_refresh(10_000));
        assert!(token.needs_refresh(99_999));
    }
}
