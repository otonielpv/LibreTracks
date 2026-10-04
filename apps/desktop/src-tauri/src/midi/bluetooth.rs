//! Bluetooth LE MIDI (plan mobile-midi, paso 06): wireless pedals and
//! controllers (WIDI, CME, M-Vave, AirTurn) for a phone on a music stand.
//!
//! - iOS ships the pairing UI (`CABTMIDICentralViewController`, presented by
//!   the iOS plugin). Once paired, CoreMIDI publishes the device and `midir`
//!   lists it like any other port. iOS remembers pairings itself.
//! - Android has no system UI for this: we scan for the BLE MIDI service UUID,
//!   the user picks a device and `MidiManager.openBluetoothDevice` publishes
//!   it. Android only keeps it published while some app holds it open, so the
//!   address is remembered in `AppSettings::bluetooth_midi_devices` and
//!   reopened at startup and when the app returns to the foreground.
//!
//! After that, a BLE device is an ordinary port: selection, MIDI Learn and
//! hot-plug reconnection (paso 04) all work unchanged.

use serde::Serialize;
use tauri::AppHandle;

/// Error codes the UI turns into a clear message.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub(crate) const PERMISSION_DENIED: &str = "bluetooth_permission_denied";
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub(crate) const BLUETOOTH_OFF: &str = "bluetooth_off";
pub(crate) const UNSUPPORTED: &str = "bluetooth_unsupported";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BluetoothMidiDevice {
    pub address: String,
    pub name: String,
}

/// `addresses` with `address` added, or `None` when it is already there.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub(crate) fn remember(addresses: &[String], address: &str) -> Option<Vec<String>> {
    if addresses.iter().any(|known| known.eq_ignore_ascii_case(address)) {
        return None;
    }
    let mut next = addresses.to_vec();
    next.push(address.to_string());
    Some(next)
}

#[cfg(target_os = "android")]
mod platform {
    use std::thread;

    use tauri::{AppHandle, Manager};

    use super::{remember, BluetoothMidiDevice, BLUETOOTH_OFF, PERMISSION_DENIED};
    use crate::{infra::settings::AppSettingsStore, midi::transport::android as bridge};

    /// How long a scan listens. BLE MIDI devices advertise every ~100 ms; 10 s
    /// also covers a pedal that is still waking up.
    const SCAN_MS: i32 = 10_000;

    pub(crate) fn scan() -> Result<Vec<BluetoothMidiDevice>, String> {
        if !bridge::ensure_bluetooth_permissions()? {
            return Err(PERMISSION_DENIED.into());
        }
        match bridge::scan_bluetooth(SCAN_MS)? {
            None => Err(BLUETOOTH_OFF.into()),
            Some(found) => Ok(found
                .into_iter()
                .map(|(address, name)| BluetoothMidiDevice { address, name })
                .collect()),
        }
    }

    pub(crate) fn connect(app: &AppHandle, address: &str) -> Result<(), String> {
        if !bridge::open_bluetooth(address)? {
            return Err(format!("could not connect to the Bluetooth MIDI device {address}"));
        }
        let store = app.state::<AppSettingsStore>();
        let current = store.current().map_err(|error| error.to_string())?;
        if let Some(addresses) = remember(&current.bluetooth_midi_devices, address) {
            let mut next = current;
            next.bluetooth_midi_devices = addresses;
            crate::midi::dispatch::apply_midi_settings_update(app, &store, next)?;
        }
        crate::midi::watch::notify_changed();
        Ok(())
    }

    /// Reopen every remembered device, off the caller's thread: each one can
    /// take up to 10 s to connect, or fail because it is switched off.
    pub(crate) fn reopen_remembered(app: &AppHandle) {
        let addresses = app
            .state::<AppSettingsStore>()
            .current()
            .map(|settings| settings.bluetooth_midi_devices)
            .unwrap_or_default();
        if addresses.is_empty() {
            return;
        }
        let _ = thread::Builder::new()
            .name("libretracks-midi-ble-reopen".into())
            .spawn(move || {
                let mut reopened = false;
                for address in addresses {
                    reopened |= matches!(bridge::open_bluetooth(&address), Ok(true));
                }
                if reopened {
                    crate::midi::watch::notify_changed();
                }
            });
    }
}

#[cfg(not(target_os = "android"))]
mod platform {
    use tauri::AppHandle;

    use super::{BluetoothMidiDevice, UNSUPPORTED};

    pub(crate) fn scan() -> Result<Vec<BluetoothMidiDevice>, String> {
        Err(UNSUPPORTED.into())
    }

    pub(crate) fn connect(_app: &AppHandle, _address: &str) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }

    pub(crate) fn reopen_remembered(_app: &AppHandle) {}
}

/// Android: scan for BLE MIDI devices (asks for permissions first).
pub(crate) fn scan() -> Result<Vec<BluetoothMidiDevice>, String> {
    platform::scan()
}

/// Android: connect to a scanned device and remember it.
pub(crate) fn connect(app: &AppHandle, address: &str) -> Result<(), String> {
    platform::connect(app, address)
}

/// Android: reopen the remembered devices (startup, back from background).
pub(crate) fn reopen_remembered(app: &AppHandle) {
    platform::reopen_remembered(app)
}

#[cfg(test)]
mod tests {
    use super::remember;
    use crate::infra::settings::AppSettings;

    #[test]
    fn remembers_each_address_once() {
        let first = remember(&[], "AA:BB").unwrap();
        assert_eq!(first, vec!["AA:BB".to_string()]);
        assert_eq!(remember(&first, "aa:bb"), None);
        assert_eq!(
            remember(&first, "CC:DD").unwrap(),
            vec!["AA:BB".to_string(), "CC:DD".to_string()]
        );
    }

    #[test]
    fn bluetooth_devices_round_trip_and_old_settings_still_load() {
        let mut settings = AppSettings::default();
        settings.bluetooth_midi_devices = vec!["AA:BB:CC:DD:EE:FF".into()];
        let json = serde_json::to_value(&settings).unwrap();
        assert_eq!(json["bluetoothMidiDevices"][0], "AA:BB:CC:DD:EE:FF");
        let back: AppSettings = serde_json::from_value(json.clone()).unwrap();
        assert_eq!(back.bluetooth_midi_devices, settings.bluetooth_midi_devices);

        // Settings saved before paso 06 have no such field.
        let mut old = json;
        old.as_object_mut().unwrap().remove("bluetoothMidiDevices");
        old.as_object_mut().unwrap().remove("midiVirtualPort");
        old.as_object_mut().unwrap().remove("midiNetworkSession");
        old.as_object_mut().unwrap().remove("keepMidiInBackground");
        let loaded: AppSettings = serde_json::from_value(old).unwrap();
        // Paso 08: on unless the user turned it off.
        assert!(loaded.keep_midi_in_background);
        assert!(loaded.bluetooth_midi_devices.is_empty());
        assert!(!loaded.midi_virtual_port);
        assert!(!loaded.midi_network_session);
    }
}
