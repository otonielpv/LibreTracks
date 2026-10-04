//! MIDI **output**: the mirror of the input listener in `midi/mod.rs`.
//!
//! LibreTracks sends MIDI to drive external show software (lighting desks,
//! lyric projection). Messages originate from MIDI tracks on the timeline and
//! are pushed from the transport tick, not from the audio thread — see
//! `state/midi_runtime.rs` for the scheduling side.
//!
//! The connection is owned by a dedicated thread rather than being shared: a
//! transport connection isn't guaranteed to be `Send`, and the transport tick
//! must never block on a device that has gone away. Sends are queued over a channel and
//! drained by that thread, so a wedged device costs a bounded queue instead of
//! a stalled transport.

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, RecvTimeoutError, Sender},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::Duration,
};

use super::transport::{platform_transport, MidiTransport};

pub use super::message::{panic_messages, OutboundMidiMessage};

const OUTPUT_POLL_INTERVAL: Duration = Duration::from_millis(5);
const OUTPUT_STARTUP_TIMEOUT: Duration = Duration::from_secs(2);

struct OutputHandle {
    should_stop: Arc<AtomicBool>,
    sender: Sender<OutboundMidiMessage>,
    thread: JoinHandle<()>,
}

/// Owns the open MIDI output ports.
///
/// There is a *default* port (the app-wide setting, used by tracks that don't
/// name one) plus any number of per-track ports, opened on demand. Two ports
/// are needed the moment a show drives, say, a lighting desk and lyric
/// projection through different virtual cables.
pub struct MidiOutputManager {
    transport: Arc<dyn MidiTransport>,
    /// The app-wide port.
    active: Mutex<DefaultPort>,
    /// Ports opened because a track asked for them by name, keyed by port
    /// name. Kept open until `close_all`, since a show reuses them every bar.
    extra: Mutex<HashMap<String, Option<OutputHandle>>>,
}

/// The app-wide port: what the user selected and whether it is open. Selected
/// but not open means *waiting* for the device to (re)appear.
#[derive(Default)]
struct DefaultPort {
    desired: Option<String>,
    handle: Option<OutputHandle>,
}

impl Default for MidiOutputManager {
    fn default() -> Self {
        Self::with_transport(platform_transport())
    }
}

impl MidiOutputManager {
    pub(crate) fn with_transport(transport: Arc<dyn MidiTransport>) -> Self {
        Self {
            transport,
            active: Mutex::new(DefaultPort::default()),
            extra: Mutex::new(HashMap::new()),
        }
    }

    /// Open `selected_device`, closing whatever was open before. `None` (or a
    /// blank name) just closes. Re-selecting the already-open port is a no-op
    /// so saving unrelated settings doesn't interrupt a running show.
    pub fn restart(&self, selected_device: Option<String>) -> Result<(), String> {
        let normalized = selected_device.and_then(|name| {
            let trimmed = name.trim().to_string();
            (!trimmed.is_empty()).then_some(trimmed)
        });

        let mut active = self
            .active
            .lock()
            .map_err(|_| "midi output state lock poisoned".to_string())?;

        if active.handle.is_some() && active.desired == normalized {
            return Ok(());
        }

        if let Some(handle) = active.handle.take() {
            stop_output(handle);
        }
        active.desired = normalized;

        let result = match active.desired.clone() {
            // A port that fails to open stays selected and waiting: the
            // watcher opens it when it appears.
            Some(port_name) => spawn_output(Arc::clone(&self.transport), port_name, false)
                .map(|handle| active.handle = Some(handle)),
            None => Ok(()),
        };
        drop(active);
        super::watch::ensure_running();
        result
    }

    /// React to a new device list. A port that has gone is closed; a port
    /// that comes back is reopened with All Notes Off first, because the
    /// note-offs sent while it was away never arrived. Per-track ports that
    /// failed to open are retried when their name appears. Returns true when
    /// it opened or closed anything.
    pub(crate) fn on_devices_changed(&self, outputs: &[String]) -> bool {
        let present = |name: &str| outputs.iter().any(|output| output == name);
        let mut changed = false;

        if let Ok(mut active) = self.active.lock() {
            if let Some(name) = active.desired.clone() {
                if !present(&name) {
                    if let Some(handle) = active.handle.take() {
                        stop_output(handle);
                        changed = true;
                    }
                } else if active.handle.is_none() {
                    match spawn_output(Arc::clone(&self.transport), name, true) {
                        Ok(handle) => {
                            active.handle = Some(handle);
                            changed = true;
                        }
                        Err(error) => {
                            eprintln!("[libretracks-midi] reopening output failed: {error}")
                        }
                    }
                }
            }
        }

        if let Ok(mut extra) = self.extra.lock() {
            for (name, entry) in extra.iter_mut() {
                if !present(name) {
                    if let Some(handle) = entry.take() {
                        stop_output(handle);
                        changed = true;
                    }
                } else if entry.is_none() {
                    if let Ok(handle) =
                        spawn_output(Arc::clone(&self.transport), name.clone(), true)
                    {
                        *entry = Some(handle);
                        changed = true;
                    }
                }
            }
        }

        changed
    }

    /// The app-wide port is selected but not open.
    pub(crate) fn is_waiting(&self) -> bool {
        self.active
            .lock()
            .map(|active| active.desired.is_some() && active.handle.is_none())
            .unwrap_or(false)
    }

    /// Whether the watcher has anything to do for outputs.
    pub(crate) fn wants_ports(&self) -> bool {
        let default = self
            .active
            .lock()
            .map(|active| active.desired.is_some())
            .unwrap_or(false);
        default
            || self
                .extra
                .lock()
                .map(|extra| !extra.is_empty())
                .unwrap_or(false)
    }

    /// True when the app-wide port is open.
    ///
    /// Note this is NOT the gate for doing any MIDI work: a song whose tracks
    /// all name their own ports has no app-wide port and would report `false`
    /// while still having everything to send. `send_to` opens named ports on
    /// demand, so the tick must reach it regardless — see
    /// `advance_midi_playback`, which gates on the song having MIDI clips.
    pub fn is_default_port_open(&self) -> bool {
        self.active
            .lock()
            .map(|active| active.handle.is_some())
            .unwrap_or(false)
    }

    /// Queue messages for delivery on the app-wide port. Never blocks on the
    /// device; if the port is closed the messages are dropped, which is what we
    /// want for a transport running without any MIDI hardware attached.
    pub fn send(&self, messages: &[OutboundMidiMessage]) {
        if messages.is_empty() {
            return;
        }
        let Ok(active) = self.active.lock() else {
            return;
        };
        let Some(handle) = active.handle.as_ref() else {
            return;
        };
        for message in messages {
            // A disconnected receiver means the writer thread is gone; the next
            // restart() will rebuild it. Dropping here beats propagating an
            // error into the transport tick.
            let _ = handle.sender.send(*message);
        }
    }

    /// Queue messages on a named port, opening it the first time it is asked
    /// for. `port_name` of `None` routes to the app-wide port.
    ///
    /// A port that fails to open is remembered as unavailable (a `None` entry)
    /// so a missing device costs one failed attempt, not one per tick.
    pub fn send_to(&self, port_name: Option<&str>, messages: &[OutboundMidiMessage]) {
        let Some(port_name) = port_name else {
            self.send(messages);
            return;
        };
        if messages.is_empty() {
            return;
        }

        let Ok(mut extra) = self.extra.lock() else {
            return;
        };
        if !extra.contains_key(port_name) {
            let handle =
                spawn_output(Arc::clone(&self.transport), port_name.to_string(), false).ok();
            extra.insert(port_name.to_string(), handle);
            // A named port now exists to watch (and to retry if it failed).
            super::watch::ensure_running();
        }
        let handle = &extra[port_name];
        let Some(handle) = handle.as_ref() else {
            return;
        };
        for message in messages {
            let _ = handle.sender.send(*message);
        }
    }

    /// Silence every channel on every open port.
    pub fn panic(&self) {
        let messages = panic_messages();
        self.send(&messages);
        if let Ok(extra) = self.extra.lock() {
            for handle in extra.values().flatten() {
                for message in &messages {
                    let _ = handle.sender.send(*message);
                }
            }
        }
    }

    /// Close every per-track port. Called when the song changes, so ports a
    /// previous song opened don't linger.
    pub fn close_extra_ports(&self) {
        let Ok(mut extra) = self.extra.lock() else {
            return;
        };
        for (_, handle) in extra.drain() {
            if let Some(handle) = handle {
                stop_output(handle);
            }
        }
    }
}

impl Drop for MidiOutputManager {
    fn drop(&mut self) {
        if let Ok(mut active) = self.active.lock() {
            if let Some(handle) = active.handle.take() {
                stop_output(handle);
            }
        }
        self.close_extra_ports();
    }
}

pub(crate) fn get_midi_output_names() -> Result<Vec<String>, String> {
    platform_transport().output_names()
}

/// Open `port_name` on its own writer thread. `panic_first` silences the
/// device before anything else is sent (used when a lost port comes back).
fn spawn_output(
    transport: Arc<dyn MidiTransport>,
    port_name: String,
    panic_first: bool,
) -> Result<OutputHandle, String> {
    let should_stop = Arc::new(AtomicBool::new(false));
    let (message_sender, message_receiver) = mpsc::channel::<OutboundMidiMessage>();
    let (startup_sender, startup_receiver) = mpsc::channel::<Result<(), String>>();

    let thread_stop = should_stop.clone();
    let thread = thread::Builder::new()
        .name("libretracks-midi-output".into())
        .spawn(move || {
            run_output_loop(
                transport.as_ref(),
                &port_name,
                panic_first,
                message_receiver,
                startup_sender,
                thread_stop,
            );
        })
        .map_err(|error| error.to_string())?;

    match startup_receiver.recv_timeout(OUTPUT_STARTUP_TIMEOUT) {
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            should_stop.store(true, Ordering::Release);
            let _ = thread.join();
            return Err(error);
        }
        Err(RecvTimeoutError::Timeout) => {
            should_stop.store(true, Ordering::Release);
            let _ = thread.join();
            return Err("timed out while opening MIDI output".into());
        }
        Err(RecvTimeoutError::Disconnected) => {
            should_stop.store(true, Ordering::Release);
            let _ = thread.join();
            return Err("MIDI output exited before startup completed".into());
        }
    }

    Ok(OutputHandle {
        should_stop,
        sender: message_sender,
        thread,
    })
}

fn run_output_loop(
    transport: &dyn MidiTransport,
    port_name: &str,
    panic_first: bool,
    message_receiver: mpsc::Receiver<OutboundMidiMessage>,
    startup_sender: Sender<Result<(), String>>,
    should_stop: Arc<AtomicBool>,
) {
    let mut connection = match transport.open_output(port_name) {
        Ok(connection) => connection,
        Err(error) => {
            let _ = startup_sender.send(Err(error));
            return;
        }
    };

    let _ = startup_sender.send(Ok(()));

    if panic_first {
        for message in panic_messages() {
            let _ = connection.send(&message.to_bytes());
        }
    }

    while !should_stop.load(Ordering::Acquire) {
        match message_receiver.recv_timeout(OUTPUT_POLL_INTERVAL) {
            Ok(message) => {
                let _ = connection.send(&message.to_bytes());
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }

    // Leaving a note ringing on a lighting desk is worse than a lost message,
    // so silence everything before dropping the port.
    for message in panic_messages() {
        let _ = connection.send(&message.to_bytes());
    }
    drop(connection);
}

fn stop_output(handle: OutputHandle) {
    handle.should_stop.store(true, Ordering::Release);
    drop(handle.sender);
    let _ = handle.thread.join();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sending_with_no_open_port_is_a_no_op() {
        let manager = MidiOutputManager::default();
        assert!(!manager.is_default_port_open());
        manager.send(&[OutboundMidiMessage::note_on(1, 60, 100)]);
        manager.panic();
    }

    #[test]
    fn closing_an_already_closed_output_is_ok() {
        let manager = MidiOutputManager::default();
        assert!(manager.restart(None).is_ok());
        assert!(manager.restart(Some("   ".into())).is_ok());
        assert!(!manager.is_default_port_open());
    }
}
