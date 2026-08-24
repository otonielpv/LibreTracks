//! Platform / OS integration shims: the synchronous native file dialog
//! (`file_dialog`), on-demand OS resource sampling (`resource_monitor`), the
//! Linux WebKitGTK white-screen mitigation (`linux_webkit`), the macOS
//! security-scoped bookmarks that keep session-folder access across reopens and
//! updates (`macos_bookmarks`), and the Android-only Storage Access Framework
//! file flows (`mobile_files`), JNI output-device enumeration
//! (`android_audio_devices`) and the JNI memory-pressure handler
//! (`android_memory`).
//!
//! [`append_platform_output_devices`] is the one seam the audio layer uses to
//! fold the Android-only endpoint enumeration into an engine device list.

pub mod file_dialog;
pub mod linux_webkit;
pub mod macos_bookmarks;
pub mod resource_monitor;

#[cfg(target_os = "android")]
pub mod android_audio_devices;
#[cfg(target_os = "android")]
pub mod android_memory;
#[cfg(target_os = "android")]
pub mod mobile_files;

/// Append the output endpoints the audio engine's own backend cannot see.
///
/// Only Android has any. Its Oboe backend knows the AAudio *default route* and
/// nothing else (see `audio_device_manager_oboe.cpp::list_devices`), so a
/// plugged-in USB interface / Bluetooth headset exists only behind
/// `AudioManager.getDevices()` — the JNI enumeration in
/// [`android_audio_devices`]. Everywhere else the engine enumerates the
/// hardware itself and this is a no-op.
///
/// Call this on EVERY engine device list that feeds a decision — the Settings
/// list AND the "is my saved device still there?" probe in `apply_settings`.
/// Merging it into only one of them is exactly how a USB interface stayed
/// invisible on Android while the enumeration itself worked fine.
pub fn append_platform_output_devices(devices: &mut Vec<lt_audio_engine_v2::DeviceInfo>) {
    #[cfg(target_os = "android")]
    let extra = android_audio_devices::enumerate_output_devices();
    #[cfg(not(target_os = "android"))]
    let extra: Vec<lt_audio_engine_v2::DeviceInfo> = Vec::new();
    merge_output_devices(devices, extra);
}

/// The merge itself, split from the `cfg`-gated enumeration above so it is
/// exercised on every host. Android-only code is compiled by nothing in the
/// desktop test run (`cargo check` on Windows/macOS/Linux skips the whole
/// module), so anything testable has to live outside the `cfg`.
fn merge_output_devices(
    devices: &mut Vec<lt_audio_engine_v2::DeviceInfo>,
    extra: Vec<lt_audio_engine_v2::DeviceInfo>,
) {
    for device in extra {
        // Engine entries stay authoritative on an id collision: the engine
        // knows the negotiated rate/buffer of an endpoint it actually opened,
        // the enumeration only ever knows the name and channel count.
        if !devices.iter().any(|d| d.device_id == device.device_id) {
            devices.push(device);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lt_audio_engine_v2::DeviceInfo;

    fn device(id: &str, name: &str) -> DeviceInfo {
        DeviceInfo {
            device_id: id.to_string(),
            device_name: name.to_string(),
            backend: "oboe".to_string(),
            sample_rate: 0,
            buffer_size: 0,
            output_channel_count: 2,
            output_channel_names: Vec::new(),
            supported_sample_rates: Vec::new(),
            last_error: String::new(),
            fallback_active: false,
        }
    }

    #[test]
    fn platform_endpoints_are_appended_after_the_engine_entry() {
        // The engine's own entry is the empty-id "system default" and must stay
        // first: the Settings UI renders index 0 as the default option.
        let mut devices = vec![device("", "Salida de audio del sistema (AAudio)")];
        merge_output_devices(
            &mut devices,
            vec![device("2", "Altavoz"), device("27", "USB - Scarlett 2i2")],
        );

        let ids: Vec<&str> = devices.iter().map(|d| d.device_id.as_str()).collect();
        assert_eq!(ids, ["", "2", "27"]);
    }

    #[test]
    fn a_colliding_id_keeps_the_engine_entry() {
        let mut devices = vec![device("27", "engine view of the interface")];
        merge_output_devices(&mut devices, vec![device("27", "enumerated view")]);

        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].device_name, "engine view of the interface");
    }
}
