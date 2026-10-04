//! MIDI transports: the only platform-specific part of MIDI.
//!
//! Everything above this trait (listener and writer threads, the byte framer,
//! MIDI Learn dispatch, the output scheduler) is shared by every platform. A
//! transport only lists ports, opens them, delivers raw bytes and sends raw
//! bytes. Choosing one is the single `cfg` in [`platform_transport`].
//!
//! Connections are owned by the thread that opened them (the listener thread
//! for inputs, the per-port writer thread for outputs) and dropped there, so
//! they don't need to be `Send`: some `midir` backends aren't.

use std::sync::{Arc, OnceLock};

use serde::Serialize;

#[cfg(target_os = "android")]
mod android;
#[cfg(any(target_os = "android", test))]
mod android_ports;
#[cfg(target_os = "ios")]
mod ios_network;
#[cfg(not(target_os = "android"))]
mod midir;
#[cfg(any(target_os = "ios", target_os = "android", test))]
pub(crate) mod virtual_names;
#[cfg(target_os = "ios")]
mod virtual_ports;
// Every current target has a backend; the null transport stays for tests and
// as the obvious fallback for a future target without one.
#[cfg(test)]
pub(crate) mod null;

/// Callback a transport calls with raw bytes from an input port. It may get
/// one message or several per call; the listener's framer splits them.
pub(crate) type OnBytes = Box<dyn FnMut(&[u8]) + Send + 'static>;

pub(crate) trait MidiTransport: Send + Sync + 'static {
    fn input_names(&self) -> Result<Vec<String>, String>;
    fn output_names(&self) -> Result<Vec<String>, String>;
    fn open_input(&self, name: &str, on_bytes: OnBytes)
        -> Result<Box<dyn InputConnection>, String>;
    fn open_output(&self, name: &str) -> Result<Box<dyn OutputConnection>, String>;
    fn capabilities(&self) -> MidiCapabilities;

    /// Ask to be told when ports appear or disappear. Returns false when the
    /// transport can't notify (then `midi::watch` polls instead).
    fn watch(&self, _on_change: Box<dyn Fn() + Send + Sync>) -> bool {
        false
    }

    /// Publish (or stop publishing) "LibreTracks In" / "LibreTracks Out" for
    /// other apps on this device. Only where `virtual_ports` is a capability.
    fn set_virtual_ports(&self, _enabled: bool) -> Result<(), String> {
        Ok(())
    }

    /// iOS network (RTP-MIDI) session. Only where `network_session` is a
    /// capability.
    fn set_network_session(&self, _enabled: bool) -> Result<(), String> {
        Ok(())
    }
}

/// An open input. Dropping it closes the port.
pub(crate) trait InputConnection {}

/// An open output. Dropping it closes the port.
pub(crate) trait OutputConnection {
    fn send(&mut self, bytes: &[u8]) -> Result<(), String>;
}

/// What MIDI can do on this platform. The UI shows MIDI tabs and buttons
/// from this, never from "is this a phone".
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MidiCapabilities {
    /// False when the platform has no MIDI at all.
    pub available: bool,
    /// The app can pair Bluetooth LE MIDI devices itself.
    pub bluetooth_pairing: bool,
    /// iOS network (RTP-MIDI) session.
    pub network_session: bool,
    /// The app can publish its own virtual ports.
    pub virtual_ports: bool,
}

/// The transport for this build. One instance for the whole process.
pub(crate) fn platform_transport() -> Arc<dyn MidiTransport> {
    static TRANSPORT: OnceLock<Arc<dyn MidiTransport>> = OnceLock::new();
    TRANSPORT
        .get_or_init(|| {
            #[cfg(not(target_os = "android"))]
            let transport: Arc<dyn MidiTransport> = Arc::new(midir::MidirTransport::default());
            #[cfg(target_os = "android")]
            let transport: Arc<dyn MidiTransport> = Arc::new(android::AndroidTransport::default());
            transport
        })
        .clone()
}
