//! Platform / OS integration shims: the synchronous native file dialog
//! (`file_dialog`), on-demand OS resource sampling (`resource_monitor`), and the
//! Android-only Storage Access Framework file flows (`mobile_files`) and JNI
//! output-device enumeration (`android_audio_devices`).

pub mod file_dialog;
pub mod resource_monitor;

#[cfg(target_os = "android")]
pub mod android_audio_devices;
#[cfg(target_os = "android")]
pub mod mobile_files;
