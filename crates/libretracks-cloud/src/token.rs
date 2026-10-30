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
//! of a real person's cloud storage, so it must never land in the settings JSON
//! next to the buffer size. Keeping the platform code outside also lets every
//! rule in this file be tested without a keychain, a network, or a signed build.
//!
//! # Which provider
//!
//! None in particular. The endpoint and the form bodies come from an
//! [`OAuthProvider`]; the rules about when to refresh, what to keep and what
//! "signed out" looks like are the same for all of them and live here once.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;

use serde::{Deserialize, Serialize};

use crate::AccessTokens;
use crate::oauth::{AuthSession, OAuthProvider, TokenResponse};
use crate::CloudError;

/// Refresh this many seconds before the access token actually expires.
///
/// A token that is valid when the request is built can still be rejected by the
/// time a chunk of a slow upload reaches the provider. The margin costs one
/// extra refresh an hour and removes a whole class of intermittent 401s.
const REFRESH_MARGIN_SECS: u64 = 120;

/// What persists between launches.
///
/// Serialisable because every platform credential store takes an opaque blob,
/// not a struct: the OS keeps the bytes safe, this decides what the bytes are.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredToken {
    /// The long-lived credential, issued on the first authorization. It is the
    /// only reason the user does not sign in again every hour. Microsoft
    /// replaces it on every refresh; Google and Dropbox keep it.
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
                // Google needs access_type=offline, Dropbox
                // token_access_type=offline, Microsoft the offline_access
                // scope. Whichever was forgotten, the token cannot be renewed.
                CloudError::Network(
                    "the provider returned no refresh token; offline access was not requested"
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
    /// Google and Dropbox send no `refresh_token` on a refresh: the original
    /// stays valid. Overwriting the stored one with the absent value is the
    /// classic way to break sign-in an hour after it started working, so the
    /// old one is explicitly kept. Microsoft rotates it on every refresh, and
    /// then the new one MUST replace the old, or the session dies within days
    /// once Microsoft retires the credential it has already replaced.
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

/// One lock per provider, shared by every [`TokenManager`] in the process.
///
/// The desktop app builds a fresh manager for each command, and the panel fires
/// several commands at once (both folder listings and the quota). Without this,
/// each would find the same expired token and refresh it in parallel. With
/// Google that only wastes a request; with Microsoft, which rotates the refresh
/// token, the loser of the race can store a credential the winner has already
/// replaced. The lock makes the second caller wait and then find the token the
/// first one just stored.
fn refresh_lock(provider: &'static str) -> Arc<tokio::sync::Mutex<()>> {
    type Locks = HashMap<&'static str, Arc<tokio::sync::Mutex<()>>>;
    static LOCKS: OnceLock<Mutex<Locks>> = OnceLock::new();
    let mut locks = LOCKS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    Arc::clone(locks.entry(provider).or_default())
}

/// Hands out valid access tokens, refreshing behind the caller's back.
pub struct TokenManager {
    provider: Arc<dyn OAuthProvider>,
    store: Box<dyn TokenStore>,
    http: reqwest::Client,
}

impl TokenManager {
    pub fn new(
        provider: Arc<dyn OAuthProvider>,
        store: Box<dyn TokenStore>,
    ) -> Result<Self, CloudError> {
        Ok(Self {
            provider,
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
        let form = self.provider.refresh_form(&token.refresh_token);
        let response = self
            .http
            .post(self.provider.token_endpoint())
            .form(&form)
            .send()
            .await
            .map_err(|e| CloudError::Network(e.to_string()))?;

        // A refresh token dies when the user revokes access, changes their
        // password, or leaves the app unused for months. Google, Microsoft and
        // Dropbox all answer 400 invalid_grant, not 401, so matching on 401
        // alone would surface it as an opaque provider error instead of "sign
        // in again".
        if response.status() == 400 || response.status() == 401 {
            let _ = self.store.clear();
            return Err(CloudError::NotConnected);
        }
        if !response.status().is_success() {
            let status = response.status().as_u16();
            let body = response.text().await.unwrap_or_default();
            return Err(CloudError::Provider {
                provider: self.provider.name(),
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
        let token = self.store.load()?.ok_or(CloudError::NotConnected)?;
        if !token.needs_refresh(now_unix()) {
            return Ok(token.access_token);
        }

        let lock = refresh_lock(self.provider.name());
        let _guard = lock.lock().await;
        // Read again under the lock: whoever held it before us may have just
        // refreshed, and with a rotating provider the refresh token loaded
        // above is no longer the current one.
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
pub async fn exchange_code(
    provider: &dyn OAuthProvider,
    session: &AuthSession,
    code: &str,
) -> Result<StoredToken, CloudError> {
    let http = reqwest::Client::builder()
        .build()
        .map_err(|e| CloudError::Network(e.to_string()))?;

    let response = http
        .post(provider.token_endpoint())
        .form(&provider.exchange_form(session, code))
        .send()
        .await
        .map_err(|e| CloudError::Network(e.to_string()))?;

    if !response.status().is_success() {
        let status = response.status().as_u16();
        let body = response.text().await.unwrap_or_default();
        return Err(CloudError::Provider {
            provider: provider.name(),
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

    /// Microsoft rotates the refresh token on every refresh (Google may too).
    /// The new one must replace the old, or the next renewal uses a credential
    /// the provider has already retired.
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

    // ── TokenManager against a fake token endpoint ───────────────────────────

    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// In-memory store the test can inspect after the manager is done with it.
    #[derive(Clone, Default)]
    struct MemoryStore(Arc<Mutex<Option<StoredToken>>>);

    impl MemoryStore {
        fn holding(token: StoredToken) -> Self {
            Self(Arc::new(Mutex::new(Some(token))))
        }
        fn current(&self) -> Option<StoredToken> {
            self.0.lock().unwrap().clone()
        }
    }

    impl TokenStore for MemoryStore {
        fn load(&self) -> Result<Option<StoredToken>, CloudError> {
            Ok(self.current())
        }
        fn save(&self, token: &StoredToken) -> Result<(), CloudError> {
            *self.0.lock().unwrap() = Some(token.clone());
            Ok(())
        }
        fn clear(&self) -> Result<(), CloudError> {
            *self.0.lock().unwrap() = None;
            Ok(())
        }
    }

    /// A provider whose token endpoint is a socket on this machine. `name` is
    /// distinct per test because it keys the process-wide refresh lock.
    struct FakeProvider {
        name: &'static str,
        endpoint: String,
    }

    impl OAuthProvider for FakeProvider {
        fn name(&self) -> &'static str {
            self.name
        }
        fn token_endpoint(&self) -> &str {
            &self.endpoint
        }
        fn authorization_url(&self, _: &AuthSession) -> String {
            String::new()
        }
        fn exchange_form(&self, _: &AuthSession, _: &str) -> Vec<(&'static str, String)> {
            Vec::new()
        }
        fn refresh_form(&self, refresh_token: &str) -> Vec<(&'static str, String)> {
            vec![
                ("grant_type", "refresh_token".into()),
                ("refresh_token", refresh_token.into()),
            ]
        }
    }

    /// Serve every request with `status` and a body built from the request
    /// number, counting hits. Slow on purpose (50 ms) so concurrent callers
    /// genuinely overlap.
    async fn fake_endpoint(
        status: u16,
        body: impl Fn(usize) -> String + Send + Sync + 'static,
    ) -> (String, Arc<AtomicUsize>) {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let url = format!("http://{}/token", listener.local_addr().unwrap());
        let hits = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&hits);
        let body = Arc::new(body);
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    return;
                };
                let n = counter.fetch_add(1, Ordering::SeqCst);
                let body = Arc::clone(&body);
                tokio::spawn(async move {
                    let mut buf = [0u8; 4096];
                    let _ = stream.read(&mut buf).await;
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    let payload = body(n);
                    let reply = format!(
                        "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
                        payload.len()
                    );
                    let _ = stream.write_all(reply.as_bytes()).await;
                });
            }
        });
        (url, hits)
    }

    fn expired() -> StoredToken {
        StoredToken {
            refresh_token: "r0".into(),
            access_token: "a0".into(),
            expires_at_unix: 0,
        }
    }

    /// Microsoft's case: the refresh answers with a new refresh token, and that
    /// is what has to be in the store afterwards, not the one we sent.
    #[tokio::test]
    async fn a_rotated_refresh_token_is_persisted() {
        let (endpoint, _) = fake_endpoint(200, |_| {
            r#"{"access_token":"a1","refresh_token":"r1","expires_in":3600}"#.into()
        })
        .await;
        let store = MemoryStore::holding(expired());
        let provider = Arc::new(FakeProvider { name: "test-rotation", endpoint });
        let manager = TokenManager::new(provider, Box::new(store.clone())).unwrap();

        assert_eq!(manager.access_token().await.unwrap(), "a1");
        let saved = store.current().unwrap();
        assert_eq!(saved.refresh_token, "r1");
        assert_eq!(saved.access_token, "a1");
        assert!(!saved.needs_refresh(now_unix()));
    }

    /// Several commands at once with an expired token must cost ONE refresh.
    /// With a rotating provider a second one would spend a refresh token the
    /// first has already replaced.
    #[tokio::test]
    async fn concurrent_callers_share_a_single_refresh() {
        let (endpoint, hits) = fake_endpoint(200, |n| {
            format!(r#"{{"access_token":"a{n}","refresh_token":"r{n}","expires_in":3600}}"#)
        })
        .await;
        let store = MemoryStore::holding(expired());
        let provider: Arc<dyn OAuthProvider> =
            Arc::new(FakeProvider { name: "test-concurrent", endpoint });

        let mut tasks = Vec::new();
        for _ in 0..4 {
            let manager =
                TokenManager::new(Arc::clone(&provider), Box::new(store.clone())).unwrap();
            tasks.push(tokio::spawn(async move { manager.access_token().await }));
        }
        for task in tasks {
            assert_eq!(task.await.unwrap().unwrap(), "a0");
        }
        assert_eq!(hits.load(Ordering::SeqCst), 1);
        assert_eq!(store.current().unwrap().refresh_token, "r0");
    }

    /// invalid_grant is a 400. It means "sign in again", and the dead token
    /// must not stay behind to fail the same way on every call.
    #[tokio::test]
    async fn a_dead_grant_signs_the_user_out() {
        let (endpoint, _) = fake_endpoint(400, |_| r#"{"error":"invalid_grant"}"#.into()).await;
        let store = MemoryStore::holding(expired());
        let provider = Arc::new(FakeProvider { name: "test-dead-grant", endpoint });
        let manager = TokenManager::new(provider, Box::new(store.clone())).unwrap();

        assert!(matches!(
            manager.access_token().await,
            Err(CloudError::NotConnected)
        ));
        assert!(store.current().is_none());
    }

    #[tokio::test]
    async fn a_valid_token_is_used_without_touching_the_network() {
        let (endpoint, hits) = fake_endpoint(500, |_| String::new()).await;
        let store = MemoryStore::holding(StoredToken {
            refresh_token: "r".into(),
            access_token: "fresh".into(),
            expires_at_unix: now_unix() + 3600,
        });
        let provider = Arc::new(FakeProvider { name: "test-no-refresh", endpoint });
        let manager = TokenManager::new(provider, Box::new(store)).unwrap();

        assert_eq!(manager.access_token().await.unwrap(), "fresh");
        assert_eq!(hits.load(Ordering::SeqCst), 0);
    }
}
