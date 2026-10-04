//! Whether the app is on screen, as told by `MainActivity.onStart`/`onStop`.
//!
//! Straight from Kotlin over JNI, like `android_memory`, rather than through
//! the WebView: a backgrounded WebView is exactly the part that stops running
//! reliably. The meter thread reads it to decide when the output stream may be
//! suspended (see `audio::idle_suspend`).

#![cfg(target_os = "android")]

use std::sync::atomic::{AtomicBool, Ordering};

static APP_IN_BACKGROUND: AtomicBool = AtomicBool::new(false);

pub fn app_in_background() -> bool {
    APP_IN_BACKGROUND.load(Ordering::Relaxed)
}

/// # Safety
/// Called by the JVM with valid `JNIEnv`/`jobject` pointers, which we ignore.
/// `visible` is a `jboolean` (0 or 1).
#[no_mangle]
pub extern "C" fn Java_com_libretracks_desktop_MainActivity_nativeOnAppVisibilityChanged(
    _env: *mut std::ffi::c_void,
    _class: *mut std::ffi::c_void,
    visible: u8,
) {
    APP_IN_BACKGROUND.store(visible == 0, Ordering::Relaxed);
    // MIDI: All Notes Off when leaving idle, revalidate ports on return.
    crate::midi::lifecycle::visibility_changed(visible != 0);
    eprintln!(
        "[LT_VISIBILITY] app {}",
        if visible != 0 { "visible" } else { "in background" }
    );
}
