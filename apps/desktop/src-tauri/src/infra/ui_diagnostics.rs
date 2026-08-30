//! Last-known frontend state for failures that happen outside JavaScript.
//!
//! A killed iOS `WebContent` process cannot run an error handler: the pixels
//! disappear precisely because the JavaScript process is already gone. The
//! frontend therefore leaves a small, periodically refreshed breadcrumb here.
//! The native WKWebView termination callback writes that breadcrumb to the
//! normal application error log, which remains alive with the audio engine.

use std::sync::{Mutex, OnceLock};

const MAX_STATE_BYTES: usize = 8 * 1024;

static LATEST_UI_STATE: OnceLock<Mutex<String>> = OnceLock::new();

pub fn update_latest(state: String) {
    let state = if state.len() <= MAX_STATE_BYTES {
        state
    } else {
        let mut end = MAX_STATE_BYTES;
        while !state.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}...[truncated]", &state[..end])
    };
    let slot = LATEST_UI_STATE.get_or_init(|| Mutex::new(String::new()));
    match slot.lock() {
        Ok(mut current) => *current = state,
        Err(poisoned) => *poisoned.into_inner() = state,
    }
}

#[cfg(target_os = "ios")]
fn latest() -> String {
    let Some(slot) = LATEST_UI_STATE.get() else {
        return "<no frontend heartbeat received>".to_string();
    };
    match slot.lock() {
        Ok(current) => current.clone(),
        Err(poisoned) => poisoned.into_inner().clone(),
    }
}

#[cfg(target_os = "ios")]
fn log_ios_ui_failure(event: &str) {
    crate::infra::error_log::write_error(&format!("[ios-ui] {event}; last_ui_state={}", latest()));
}

/// Called from Swift after WKWebView reports that iOS terminated WebContent.
#[cfg(target_os = "ios")]
#[no_mangle]
pub extern "C" fn libretracks_log_ios_webcontent_terminated() {
    log_ios_ui_failure("WKWebView WebContent process terminated");
}

/// Memory warnings often precede a Jetsam kill, so retain those too.
#[cfg(target_os = "ios")]
#[no_mangle]
pub extern "C" fn libretracks_log_ios_memory_warning() {
    log_ios_ui_failure("UIApplication received memory warning");
}
