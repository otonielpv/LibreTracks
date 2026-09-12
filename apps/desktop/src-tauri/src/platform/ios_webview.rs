//! Make the WebView use the whole iPhone screen.
//!
//! Symptom: on a device with a notch, the interface stopped 124 pt short of the
//! right edge and left a black band there. Measured from inside the WebView on
//! an iPhone 16 Pro Max (2026-09-12):
//!
//! ```text
//! inner=832x419  screen=440x956  dpr=3  safe=L62px R62px  shell=956x419@0,0
//! ```
//!
//! The screen is 956 pt wide, the safe-area insets are 62 pt on each side, and
//! the layout viewport came back as 956 - 62 - 62 = 832. That is NOT what
//! `viewport-fit=cover` should do — and the meta tag is present in the built
//! HTML, so the tag is not the problem.
//!
//! The cause is one level below: a `WKWebView` owns a `UIScrollView`, and that
//! scroll view's `contentInsetAdjustmentBehavior` defaults to `.automatic`,
//! which subtracts the safe-area insets from the content area. wry turns off
//! that scroll view's bouncing but leaves this behaviour alone. Setting it to
//! `.never` hands the page the full width; the app's own CSS already keeps its
//! controls clear of the notch with `env(safe-area-inset-*)`, which is where
//! that decision belongs — the backgrounds should reach the edge, the buttons
//! should not.
//!
//! iPad never showed this because its lateral insets are zero.

use objc2::msg_send;
use objc2::runtime::AnyObject;
use tauri::WebviewWindow;

/// `UIScrollViewContentInsetAdjustmentBehavior.never`
const CONTENT_INSET_ADJUSTMENT_NEVER: isize = 2;

pub fn stretch_under_safe_area(window: &WebviewWindow) {
    let result = window.with_webview(|webview| {
        // SAFETY: `inner()` is the WKWebView this window is built on, alive for
        // as long as the window, and this runs on the main thread (Tauri's
        // setup hook). `scrollView` and the setter are public UIKit API.
        unsafe {
            let webview: *mut AnyObject = webview.inner().cast();
            if webview.is_null() {
                return;
            }
            let scroll_view: *mut AnyObject = msg_send![webview, scrollView];
            if scroll_view.is_null() {
                return;
            }
            let _: () = msg_send![
                scroll_view,
                setContentInsetAdjustmentBehavior: CONTENT_INSET_ADJUSTMENT_NEVER
            ];
        }
    });

    if let Err(error) = result {
        // Not fatal: the app runs, it just leaves a black band beside the
        // notch. Worth a line in the log so it is not diagnosed twice.
        eprintln!("[libretracks] could not stretch the WebView under the safe area: {error}");
    }
}
