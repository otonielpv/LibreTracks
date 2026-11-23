//! Planning Center account and the read-only calls of the chart import
//! (plan smart-chart-import). Thin glue: everything testable lives in
//! `libretracks-pco`; the sign-in reuses the cloud's loopback (desktop) and
//! deep link (mobile), and the token goes to the same credential store under
//! its own entry, `planning-center`. Nothing here writes to Planning Center.

use std::sync::Arc;

use serde::Serialize;
use tauri::AppHandle;

use libretracks_cloud::oauth::OAuthProvider;
use libretracks_cloud::token::TokenManager;
use libretracks_pco::{
    is_configured, Page, PcoAccount, PcoArrangement, PcoClient, PcoError, PcoPlan, PcoPlanItem,
    PcoServiceType, PcoSong, PlanningCenterOAuth,
};

use super::cloud::{token_store_for_key, SIGN_IN_TIMEOUT};

const KEYCHAIN_KEY: &str = "planning-center";

fn oauth() -> Result<Arc<PlanningCenterOAuth>, PcoError> {
    PlanningCenterOAuth::from_build()
        .map(Arc::new)
        .ok_or(PcoError::NotConfigured)
}

fn unexpected(message: impl ToString) -> PcoError {
    PcoError::Unexpected {
        message: message.to_string(),
    }
}

fn manager(app: &AppHandle) -> Result<TokenManager, PcoError> {
    let store = token_store_for_key(app, KEYCHAIN_KEY).map_err(unexpected)?;
    TokenManager::new(oauth()?, store).map_err(PcoError::from)
}

fn client(app: &AppHandle) -> Result<PcoClient, PcoError> {
    PcoClient::new(Arc::new(manager(app)?))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PcoStatus {
    /// This build has a client id. Without it the UI offers nothing.
    pub configured: bool,
    /// `disconnected`, `connected` or `expired` (the account was connected
    /// and Planning Center no longer accepts it: connect again).
    pub state: &'static str,
    pub account: Option<PcoAccount>,
    /// Connected but the account could not be read (offline, no access).
    pub error: Option<PcoError>,
}

#[tauri::command]
pub async fn pco_status(app: AppHandle) -> Result<PcoStatus, PcoError> {
    if !is_configured() {
        return Ok(PcoStatus {
            configured: false,
            state: "disconnected",
            account: None,
            error: None,
        });
    }
    if !manager(&app)?.is_connected() {
        return Ok(PcoStatus {
            configured: true,
            state: "disconnected",
            account: None,
            error: None,
        });
    }
    Ok(match client(&app)?.me().await {
        Ok(account) => PcoStatus {
            configured: true,
            state: "connected",
            account: Some(account),
            error: None,
        },
        Err(PcoError::SignedOut) => PcoStatus {
            configured: true,
            state: "expired",
            account: None,
            error: None,
        },
        Err(error) => PcoStatus {
            configured: true,
            state: "connected",
            account: None,
            error: Some(error),
        },
    })
}

/// Sign in: the system browser, the redirect back, the token to the store.
#[tauri::command]
pub async fn pco_sign_in(app: AppHandle) -> Result<(), PcoError> {
    use libretracks_cloud::token::exchange_code;
    use tauri_plugin_opener::OpenerExt;

    let oauth = oauth()?;

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let (session, params) = {
        let listener = libretracks_cloud::loopback::LoopbackListener::bind_first_free(
            &libretracks_pco::oauth::LOOPBACK_PORTS,
        )
        .await
        .map_err(PcoError::from)?;
        let session = libretracks_pco::oauth::begin(listener.port()).map_err(unexpected)?;
        app.opener()
            .open_url(oauth.authorization_url(&session), None::<&str>)
            .map_err(unexpected)?;
        let params = tokio::time::timeout(SIGN_IN_TIMEOUT, listener.wait_for_redirect())
            .await
            .map_err(|_| unexpected("the sign-in timed out"))?
            .map_err(PcoError::from)?;
        (session, params)
    };

    #[cfg(any(target_os = "android", target_os = "ios"))]
    let (session, params) = {
        let session = libretracks_pco::oauth::begin(0).map_err(unexpected)?;
        let (sender, receiver) = tokio::sync::oneshot::channel();
        *super::cloud::pending_redirect()
            .lock()
            .map_err(|_| unexpected("the deep link slot is poisoned"))? = Some(sender);
        app.opener()
            .open_url(oauth.authorization_url(&session), None::<&str>)
            .map_err(unexpected)?;
        let raw = tokio::time::timeout(SIGN_IN_TIMEOUT, receiver)
            .await
            .map_err(|_| unexpected("the sign-in timed out"))?
            .map_err(|_| unexpected("the sign-in was interrupted"))?;
        let params = libretracks_cloud::redirect::parse_redirect_str(&raw).map_err(PcoError::from)?;
        (session, params)
    };

    // Never skip: only the flow that started this sign-in knows the state.
    session.verify_state(&params.state).map_err(unexpected)?;
    let token = exchange_code(oauth.as_ref(), &session, &params.code)
        .await
        .map_err(PcoError::from)?;
    manager(&app)?.adopt(&token).map_err(PcoError::from)
}

/// Forget the account: the credential store entry goes.
#[tauri::command]
pub async fn pco_sign_out(app: AppHandle) -> Result<(), PcoError> {
    manager(&app)?.disconnect().map_err(PcoError::from)
}

#[tauri::command]
pub async fn pco_search_songs(app: AppHandle, query: String, page: u32) -> Result<Page<PcoSong>, PcoError> {
    client(&app)?.search_songs(&query, page).await
}

#[tauri::command]
pub async fn pco_arrangements(app: AppHandle, song_id: String) -> Result<Vec<PcoArrangement>, PcoError> {
    client(&app)?.arrangements(&song_id).await
}

#[tauri::command]
pub async fn pco_arrangement(
    app: AppHandle,
    song_id: String,
    arrangement_id: String,
) -> Result<PcoArrangement, PcoError> {
    client(&app)?.arrangement(&song_id, &arrangement_id).await
}

#[tauri::command]
pub async fn pco_service_types(app: AppHandle) -> Result<Vec<PcoServiceType>, PcoError> {
    client(&app)?.service_types().await
}

#[tauri::command]
pub async fn pco_upcoming_plans(app: AppHandle, service_type_id: String) -> Result<Vec<PcoPlan>, PcoError> {
    client(&app)?.upcoming_plans(&service_type_id).await
}

#[tauri::command]
pub async fn pco_plan_items(
    app: AppHandle,
    service_type_id: String,
    plan_id: String,
) -> Result<Vec<PcoPlanItem>, PcoError> {
    client(&app)?.plan_items(&service_type_id, &plan_id).await
}
