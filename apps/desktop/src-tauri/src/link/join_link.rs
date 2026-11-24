//! The host's QR code, scanned with the phone's camera.
//!
//! The QR holds `libretracks://join?host=IP:PORT&name=…` (`host::join_url`).
//! Android and iOS open the app with it through the deep-link plugin; this
//! module keeps it until the UI is ready and tells the UI, which opens the
//! network session on the Join tab with the address filled in.
//!
//! Two ways in: a running app gets it through `on_open_url`
//! (`commands::cloud::register_deep_link_handler` hands it here), and an app
//! the link launched reads it at setup with `get_current`. Either way it
//! waits in `PENDING` until the UI takes it, because on a cold start the
//! event goes out before any listener exists.

use std::sync::Mutex;

use tauri::{AppHandle, Emitter};

#[cfg_attr(not(any(target_os = "android", target_os = "ios")), allow(dead_code))]
pub const JOIN_LINK_EVENT: &str = "link://join-link";
const PREFIX: &str = "libretracks://join";

static PENDING: Mutex<Option<String>> = Mutex::new(None);

/// True for the QR's link, whatever comes after the path.
pub fn is_join_link(url: &str) -> bool {
    url.get(..PREFIX.len())
        .is_some_and(|start| start.eq_ignore_ascii_case(PREFIX))
}

/// Keep `url` for the UI and tell it. False when it is not a join link (an
/// OAuth redirect, which belongs to the sign-in waiting for it).
#[cfg_attr(not(any(target_os = "android", target_os = "ios")), allow(dead_code))]
pub fn offer(app: &AppHandle, url: &str) -> bool {
    if !is_join_link(url) {
        return false;
    }
    if let Ok(mut pending) = PENDING.lock() {
        *pending = Some(url.to_string());
    }
    let _ = app.emit(JOIN_LINK_EVENT, url.to_string());
    true
}

/// The link the app was opened with, if any, taken once.
#[tauri::command]
pub fn link_take_join_link() -> Option<String> {
    PENDING.lock().ok().and_then(|mut pending| pending.take())
}

/// At setup: the link that launched the app (cold start).
#[cfg(any(target_os = "android", target_os = "ios"))]
pub fn offer_launch_link(app: &AppHandle) {
    use tauri_plugin_deep_link::DeepLinkExt;

    let Ok(Some(urls)) = app.deep_link().get_current() else {
        return;
    };
    for url in urls {
        if offer(app, url.as_str()) {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_qr_link_is_a_join_link() {
        assert!(is_join_link("libretracks://join?host=192.168.1.5:3041&name=PC"));
        assert!(is_join_link("LibreTracks://join?host=192.168.1.5:3041"));
        assert!(!is_join_link("com.libretracks.app://oauth2redirect/onedrive?code=x"));
        assert!(!is_join_link("libretracks://"));
        assert!(!is_join_link(""));
    }
}
