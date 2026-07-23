//! WebKitGTK white-screen mitigation for Linux desktop builds.
//!
//! On Linux, Tauri renders the UI through WebKitGTK. On many modern setups the
//! DMABUF-based renderer WebKitGTK uses by default fails to allocate GPU buffers
//! and the window comes up as a blank white screen with nothing painted — a
//! well-known WebKitGTK issue, not an application bug. It bites hardest on:
//!
//!   - NVIDIA proprietary drivers,
//!   - immutable/atomic distros (Bazzite, Fedora Silverblue, SteamOS, …) where
//!     the WebKitGTK stack ships in a slightly different shape than upstream
//!     expects,
//!   - some Wayland compositors.
//!
//! The fix that virtually every affected Tauri app converges on is to force
//! WebKitGTK off the DMABUF renderer by exporting `WEBKIT_DISABLE_DMABUF_RENDERER=1`
//! before the webview is created. It falls back to a software/GL path that is a
//! hair slower to composite but paints reliably. For our UI (a DAW transport, not
//! a 3D canvas) the difference is imperceptible.
//!
//! We apply it here in-process so users never have to know the flag exists or
//! touch a terminal — the whole point is that it "just works" on a fresh install.
//!
//! ## Escape hatch
//!
//! A user whose machine renders fine with the accelerated path and who would
//! rather keep it can opt out by setting `LIBRETRACKS_KEEP_DMABUF=1` in their
//! environment. And if the variable is *already* set (by the user, a wrapper
//! script, or an AppImage launcher), we never override their explicit choice.

/// Apply the Linux WebKitGTK white-screen mitigation.
///
/// MUST be called before the Tauri `Builder` is constructed / the webview is
/// created — WebKitGTK reads these variables once at renderer init, so setting
/// them later has no effect.
///
/// No-op on non-Linux targets.
pub fn apply_webkit_workarounds() {
    #[cfg(target_os = "linux")]
    {
        // Explicit opt-out: the user wants to keep the accelerated DMABUF path.
        if std::env::var_os("LIBRETRACKS_KEEP_DMABUF").is_some() {
            return;
        }

        // Never clobber a value the user (or a launcher wrapper) already set —
        // respect their explicit choice in either direction.
        if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
            // SAFETY: called at the very start of `run()`, single-threaded,
            // before any webview or worker thread exists. This flag is consumed
            // only by WebKitGTK, so the Windows env/FFI desync gotcha (Rust
            // set_var not visible to the in-process C++ engine) does not apply.
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }
}
