//! WebKitGTK compatibility policy for Linux desktop builds.
//!
//! Disabling the DMABUF renderer is a useful workaround for affected
//! proprietary NVIDIA drivers, but WebKit then falls back to SHM transport and
//! UI rendering gets measurably slower. Applying the workaround to every Linux
//! machine made healthy AMD and Intel systems use that slow path too.
//!
//! The release AppImage is post-processed to use the host WebKitGTK/GTK/Mesa
//! stack instead of mixing libraries from the build distro with the host GPU
//! stack. Here we only enable the DMABUF workaround automatically when an
//! NVIDIA kernel driver is detected.
//! `LIBRETRACKS_DISABLE_DMABUF=1` forces the compatibility path and
//! `LIBRETRACKS_KEEP_DMABUF=1` forces the accelerated path. An existing
//! `WEBKIT_DISABLE_DMABUF_RENDERER` value is always respected.

#[cfg(target_os = "linux")]
fn nvidia_kernel_driver_present() -> bool {
    if std::path::Path::new("/proc/driver/nvidia/version").exists() {
        return true;
    }

    let Ok(cards) = std::fs::read_dir("/sys/class/drm") else {
        return false;
    };
    cards.filter_map(Result::ok).any(|card| {
        std::fs::read_to_string(card.path().join("device/vendor"))
            .map(|vendor| vendor.trim().eq_ignore_ascii_case("0x10de"))
            .unwrap_or(false)
    })
}

/// Apply Linux WebKitGTK compatibility settings before Tauri creates a webview.
///
/// No-op on non-Linux targets.
pub fn apply_webkit_workarounds() {
    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("LIBRETRACKS_KEEP_DMABUF").is_some()
            || std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_some()
        {
            return;
        }

        let force_compatibility = std::env::var_os("LIBRETRACKS_DISABLE_DMABUF").is_some();
        if force_compatibility || nvidia_kernel_driver_present() {
            // SAFETY: called at the start of run(), single-threaded, before any
            // webview or worker exists. WebKitGTK reads this setting at init.
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }
}
