//! Dropbox backend.
//!
//! # App folder access
//!
//! The Dropbox app is registered with "App folder" access, so every path this
//! code sends is relative to `Apps/LibreTracks` in the user's Dropbox and the
//! rest of their files cannot be reached, by construction. It is Dropbox's
//! equivalent of Drive's `drive.file`, and like OneDrive's the boundary is a
//! folder: a package the user drops into `Apps/LibreTracks/Sessions` by hand
//! shows up in the app.
//!
//! # Development mode caps the app at 500 users
//!
//! Until Dropbox approves the app for production, no more than 500 accounts
//! can connect. Request production approval BEFORE announcing the feature, or
//! the 501st user gets an error nobody can fix from inside the app.

pub mod client;
pub mod oauth;

/// Scopes requested. `account_info.read` is only for the quota.
pub const SCOPES: &str =
    "files.metadata.read files.content.read files.content.write account_info.read";

pub const AUTH_ENDPOINT: &str = "https://www.dropbox.com/oauth2/authorize";
pub const TOKEN_ENDPOINT: &str = "https://api.dropboxapi.com/oauth2/token";

/// App key of this project's Dropbox app (registered 2026-10-30). Public by
/// nature (PKCE, no secret), so it lives in the source like Google's client
/// ids. A fork sets `LIBRETRACKS_DROPBOX_APP_KEY` at build time to use its own;
/// see [`crate::onedrive::REGISTERED_CLIENT_ID`].
pub const REGISTERED_APP_KEY: &str = "zja1w62v8or5jkw";

/// The app key this build presents: the build-time override when set and
/// non-empty, the registered one otherwise.
pub const APP_KEY: Option<&str> = match option_env!("LIBRETRACKS_DROPBOX_APP_KEY") {
    Some(key) if !key.is_empty() => Some(key),
    _ => Some(REGISTERED_APP_KEY),
};

/// Loopback ports registered as redirect URIs in the Dropbox App Console.
///
/// Dropbox matches the redirect URI exactly, port included, so the listener
/// cannot take whatever port the OS hands out the way it does for Google and
/// Microsoft. Three, so that one held by some other program does not block
/// the sign-in. Every one of them must be registered as
/// `http://127.0.0.1:<port>`; adding a port here without registering it fails
/// only after the user has already authorised.
pub const LOOPBACK_PORTS: [u16; 3] = [53_134, 53_135, 53_136];

/// The redirect this build sends.
///
/// On mobile, the scheme Dropbox's own SDKs use, which Dropbox recognises for
/// any app key without registering an https URL. It has to be declared to the
/// deep-link plugin, which is why the app key cannot be swapped without
/// touching `tauri.conf.json` too.
pub fn redirect_uri(port: u16) -> String {
    if cfg!(any(target_os = "ios", target_os = "android")) {
        format!("db-{}://2/token", APP_KEY.unwrap_or(""))
    } else {
        format!("http://127.0.0.1:{port}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_redirects_to_the_registered_loopback_port() {
        assert_eq!(redirect_uri(LOOPBACK_PORTS[0]), "http://127.0.0.1:53134");
    }

    #[test]
    fn loopback_ports_are_distinct() {
        let mut ports = LOOPBACK_PORTS.to_vec();
        ports.dedup();
        assert_eq!(ports.len(), LOOPBACK_PORTS.len());
    }
}
