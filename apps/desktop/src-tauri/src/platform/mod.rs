//! Platform / OS integration shims: the synchronous native file dialog
//! (`file_dialog`), on-demand OS resource sampling (`resource_monitor`), the
//! Linux WebKitGTK white-screen mitigation (`linux_webkit`), the macOS
//! security-scoped bookmarks that keep session-folder access across reopens and
//! updates (`macos_bookmarks`), and the Android-only Storage Access Framework
//! file flows (`mobile_files`) and JNI output-device enumeration
//! (`android_audio_devices`).

pub mod file_dialog;
pub mod linux_webkit;
pub mod macos_bookmarks;
pub mod resource_monitor;

#[cfg(target_os = "android")]
pub mod android_audio_devices;
#[cfg(target_os = "android")]
pub mod mobile_files;
