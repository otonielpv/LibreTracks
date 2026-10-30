//! Microsoft OneDrive backend, over Microsoft Graph.
//!
//! # The app folder, and nothing else
//!
//! The one scope that touches files is `Files.ReadWrite.AppFolder`: the app
//! reaches `Apps/LibreTracks` in the user's OneDrive (Graph's `approot`) and
//! nothing outside it. It is Microsoft's equivalent of Drive's `drive.file`,
//! with one difference in our favour: the boundary is a *folder*, so a package
//! the user drops into `Apps/LibreTracks/Sessions` from the OneDrive website is
//! visible to the app, which `drive.file` can never offer.
//!
//! Never widen this to `Files.ReadWrite` or `Files.ReadWrite.All`: a user who
//! sees "read and write all your files" for a setlist app is right to refuse.
//!
//! # Personal and work accounts
//!
//! The app is registered for "personal Microsoft accounts and accounts in any
//! organisational directory" and signs in through the `common` tenant. A
//! church's Microsoft 365 admin may block user consent to third-party apps; the
//! user then sees Microsoft's "needs admin approval" page, which is the honest
//! answer and nothing this code can work around.

pub mod client;
pub mod oauth;

/// Scopes requested. `offline_access` is what makes Microsoft issue a refresh
/// token at all; without it the user signs in again every hour.
pub const SCOPES: &str = "Files.ReadWrite.AppFolder offline_access";

/// The `common` endpoint accepts both personal and work/school accounts.
pub const AUTH_ENDPOINT: &str = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
pub const TOKEN_ENDPOINT: &str = "https://login.microsoftonline.com/common/oauth2/v2.0/token";

/// Application (client) id of the Azure app registration, injected at build
/// time like Google's secret.
///
/// It is not a secret: OneDrive is registered as a public client and the flow
/// is protected by PKCE, so no client secret exists at all. It stays a build
/// input for the other reason Google's secret is one: an AGPL fork rebuilt
/// from this repository must register its own app rather than run against
/// this project's registration and show its name on the consent screen.
///
/// `None` in a build without `LIBRETRACKS_ONEDRIVE_CLIENT_ID`, and then the
/// provider reports itself as not configured before any browser opens.
pub const CLIENT_ID: Option<&str> = option_env!("LIBRETRACKS_ONEDRIVE_CLIENT_ID");

/// Mobile redirect: a private scheme registered under "Mobile and desktop
/// applications" in the Azure portal, and declared to the deep-link plugin in
/// `tauri.conf.json`. Reverse-domain, per RFC 8252, so no other app has a
/// reason to claim it.
pub const MOBILE_REDIRECT_URI: &str = "com.libretracks.app:/oauth2redirect/onedrive";

/// The redirect this build sends.
///
/// Desktop answers on the loopback interface. Microsoft ignores the port when
/// matching a `localhost` redirect for a public client, so registering plain
/// `http://localhost` covers whatever port the listener got. It must be the
/// name `localhost`: the portal refuses to register `127.0.0.1` for this
/// platform, and the match is textual.
pub fn redirect_uri(port: u16) -> String {
    if cfg!(any(target_os = "ios", target_os = "android")) {
        MOBILE_REDIRECT_URI.to_string()
    } else {
        format!("http://localhost:{port}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_redirects_to_localhost_with_the_listener_port() {
        assert_eq!(redirect_uri(51763), "http://localhost:51763");
    }

    /// Without offline_access there is no refresh token, and the first
    /// exchange is rejected by `StoredToken::from_response`.
    #[test]
    fn the_scopes_ask_for_a_refresh_token_and_only_the_app_folder() {
        let scopes: Vec<_> = SCOPES.split(' ').collect();
        assert!(scopes.contains(&"offline_access"));
        assert!(scopes.contains(&"Files.ReadWrite.AppFolder"));
        assert!(!scopes.iter().any(|s| *s == "Files.ReadWrite" || s.ends_with(".All")));
    }
}
