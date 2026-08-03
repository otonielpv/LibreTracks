//! MIDI **output**: the mirror of the input listener in `midi/mod.rs`.
//!
//! LibreTracks sends MIDI to drive external show software (lighting desks,
//! lyric projection). Messages originate from MIDI tracks on the timeline and
//! are pushed from the transport tick, not from the audio thread — see
//! `state/midi_runtime.rs` for the scheduling side.
//!
//! The connection is owned by a dedicated thread rather than being shared: a
//! `midir::MidiOutputConnection` is `!Sync`, and the transport tick must never
//! block on a device that has gone away. Sends are queued over a channel and
//! drained by that thread, so a wedged device costs a bounded queue instead of
//! a stalled transport.

use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, RecvTimeoutError, Sender},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::Duration,
};

use midir::{MidiOutput, MidiOutputPort};

const OUTPUT_POLL_INTERVAL: Duration = Duration::from_millis(5);
const OUTPUT_STARTUP_TIMEOUT: Duration = Duration::from_secs(2);

/// Status byte nibbles. Channel is OR-ed into the low nibble at send time.
const STATUS_NOTE_OFF: u8 = 0x80;
const STATUS_NOTE_ON: u8 = 0x90;
const STATUS_CONTROL_CHANGE: u8 = 0xB0;
const STATUS_PROGRAM_CHANGE: u8 = 0xC0;

/// Channel-mode controllers used to silence a device.
const CC_ALL_SOUND_OFF: u8 = 120;
const CC_ALL_NOTES_OFF: u8 = 123;

/// One outbound MIDI message, already resolved to wire bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OutboundMidiMessage {
    pub status: u8,
    pub data1: u8,
    pub data2: u8,
    /// Program change is a 2-byte message; everything else here is 3.
    pub two_bytes: bool,
}

impl OutboundMidiMessage {
    /// Build a channel-voice message. `channel` is 1-16 as the user sees it and
    /// is converted to the wire's 0-based nibble here — the single place that
    /// conversion happens.
    fn channel_voice(status: u8, channel: u8, data1: u8, data2: u8, two_bytes: bool) -> Self {
        let nibble = channel.clamp(1, 16) - 1;
        Self {
            status: status | nibble,
            data1: data1.min(127),
            data2: data2.min(127),
            two_bytes,
        }
    }

    pub fn note_on(channel: u8, note: u8, velocity: u8) -> Self {
        Self::channel_voice(STATUS_NOTE_ON, channel, note, velocity, false)
    }

    pub fn note_off(channel: u8, note: u8) -> Self {
        Self::channel_voice(STATUS_NOTE_OFF, channel, note, 0, false)
    }

    pub fn control_change(channel: u8, controller: u8, value: u8) -> Self {
        Self::channel_voice(STATUS_CONTROL_CHANGE, channel, controller, value, false)
    }

    pub fn program_change(channel: u8, program: u8) -> Self {
        Self::channel_voice(STATUS_PROGRAM_CHANGE, channel, program, 0, true)
    }

    fn to_bytes(self) -> Vec<u8> {
        if self.two_bytes {
            vec![self.status, self.data1]
        } else {
            vec![self.status, self.data1, self.data2]
        }
    }
}

/// Every message needed to silence all 16 channels: All Sound Off followed by
/// All Notes Off. Sent on stop, on seek and when the port closes, so a jump
/// mid-note can never leave a hanging note on the receiving device.
pub fn panic_messages() -> Vec<OutboundMidiMessage> {
    let mut messages = Vec::with_capacity(32);
    for channel in 1..=16u8 {
        messages.push(OutboundMidiMessage::control_change(
            channel,
            CC_ALL_SOUND_OFF,
            0,
        ));
        messages.push(OutboundMidiMessage::control_change(
            channel,
            CC_ALL_NOTES_OFF,
            0,
        ));
    }
    messages
}

struct OutputHandle {
    port_name: String,
    should_stop: Arc<AtomicBool>,
    sender: Sender<OutboundMidiMessage>,
    thread: JoinHandle<()>,
}

/// Owns the currently open MIDI output port, if any.
#[derive(Default)]
pub struct MidiOutputManager {
    active: Mutex<Option<OutputHandle>>,
}

impl MidiOutputManager {
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

        if active.as_ref().map(|handle| handle.port_name.as_str()) == normalized.as_deref() {
            return Ok(());
        }

        if let Some(handle) = active.take() {
            stop_output(handle);
        }

        if let Some(port_name) = normalized {
            *active = Some(spawn_output(port_name)?);
        }

        Ok(())
    }

    /// True when a port is open. The transport tick checks this before doing
    /// any per-event work so a session with no MIDI device costs nothing.
    pub fn is_open(&self) -> bool {
        self.active
            .lock()
            .map(|active| active.is_some())
            .unwrap_or(false)
    }

    /// Queue messages for delivery. Never blocks on the device; if the port is
    /// closed the messages are dropped, which is what we want for a transport
    /// running without any MIDI hardware attached.
    pub fn send(&self, messages: &[OutboundMidiMessage]) {
        if messages.is_empty() {
            return;
        }
        let Ok(active) = self.active.lock() else {
            return;
        };
        let Some(handle) = active.as_ref() else {
            return;
        };
        for message in messages {
            // A disconnected receiver means the writer thread is gone; the next
            // restart() will rebuild it. Dropping here beats propagating an
            // error into the transport tick.
            let _ = handle.sender.send(*message);
        }
    }

    /// Silence every channel on the open port.
    pub fn panic(&self) {
        self.send(&panic_messages());
    }
}

impl Drop for MidiOutputManager {
    fn drop(&mut self) {
        if let Ok(mut active) = self.active.lock() {
            if let Some(handle) = active.take() {
                stop_output(handle);
            }
        }
    }
}

pub(crate) fn get_midi_output_names() -> Result<Vec<String>, String> {
    let midi_output =
        MidiOutput::new("libretracks-midi-outputs").map_err(|error| error.to_string())?;
    let mut names = midi_output
        .ports()
        .iter()
        .filter_map(|port| midi_output.port_name(port).ok())
        .collect::<Vec<_>>();
    names.sort();
    names.dedup();
    Ok(names)
}

fn spawn_output(port_name: String) -> Result<OutputHandle, String> {
    let should_stop = Arc::new(AtomicBool::new(false));
    let (message_sender, message_receiver) = mpsc::channel::<OutboundMidiMessage>();
    let (startup_sender, startup_receiver) = mpsc::channel::<Result<(), String>>();

    let thread_stop = should_stop.clone();
    let thread_port_name = port_name.clone();
    let thread = thread::Builder::new()
        .name("libretracks-midi-output".into())
        .spawn(move || {
            run_output_loop(
                &thread_port_name,
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
        port_name,
        should_stop,
        sender: message_sender,
        thread,
    })
}

fn run_output_loop(
    port_name: &str,
    message_receiver: mpsc::Receiver<OutboundMidiMessage>,
    startup_sender: Sender<Result<(), String>>,
    should_stop: Arc<AtomicBool>,
) {
    let midi_output = match MidiOutput::new("libretracks-midi-output") {
        Ok(midi_output) => midi_output,
        Err(error) => {
            let _ = startup_sender.send(Err(error.to_string()));
            return;
        }
    };

    let port = match resolve_output_port(&midi_output, port_name) {
        Ok(port) => port,
        Err(error) => {
            let _ = startup_sender.send(Err(error));
            return;
        }
    };

    let mut connection = match midi_output.connect(&port, "libretracks-midi-send") {
        Ok(connection) => connection,
        Err(error) => {
            let _ = startup_sender.send(Err(error.to_string()));
            return;
        }
    };

    let _ = startup_sender.send(Ok(()));

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
    connection.close();
}

fn resolve_output_port(midi_output: &MidiOutput, port_name: &str) -> Result<MidiOutputPort, String> {
    midi_output
        .ports()
        .into_iter()
        .find(|port| {
            midi_output
                .port_name(port)
                .map(|name| name == port_name)
                .unwrap_or(false)
        })
        .ok_or_else(|| format!("MIDI output device not found: {port_name}"))
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
    fn encodes_channel_as_zero_based_nibble() {
        // Channel 1 is wire nibble 0 — the off-by-one that silently sends to
        // the wrong channel if it leaks anywhere else.
        assert_eq!(OutboundMidiMessage::note_on(1, 60, 100).status, 0x90);
        assert_eq!(OutboundMidiMessage::note_on(16, 60, 100).status, 0x9F);
        assert_eq!(OutboundMidiMessage::control_change(10, 74, 5).status, 0xB9);
    }

    #[test]
    fn clamps_out_of_range_channels_and_data() {
        assert_eq!(OutboundMidiMessage::note_on(0, 60, 100).status, 0x90);
        assert_eq!(OutboundMidiMessage::note_on(99, 60, 100).status, 0x9F);
        assert_eq!(OutboundMidiMessage::note_on(1, 200, 200).data1, 127);
        assert_eq!(OutboundMidiMessage::note_on(1, 60, 200).data2, 127);
    }

    #[test]
    fn program_change_is_two_bytes() {
        let message = OutboundMidiMessage::program_change(1, 7);
        assert!(message.two_bytes);
        assert_eq!(message.to_bytes(), vec![0xC0, 7]);
        assert_eq!(
            OutboundMidiMessage::note_on(1, 60, 100).to_bytes(),
            vec![0x90, 60, 100]
        );
    }

    #[test]
    fn panic_covers_every_channel_twice() {
        let messages = panic_messages();
        assert_eq!(messages.len(), 32);
        assert!(messages
            .iter()
            .any(|m| m.status == 0xB0 && m.data1 == CC_ALL_NOTES_OFF));
        assert!(messages
            .iter()
            .any(|m| m.status == 0xBF && m.data1 == CC_ALL_SOUND_OFF));
    }

    #[test]
    fn sending_with_no_open_port_is_a_no_op() {
        let manager = MidiOutputManager::default();
        assert!(!manager.is_open());
        manager.send(&[OutboundMidiMessage::note_on(1, 60, 100)]);
        manager.panic();
    }

    #[test]
    fn closing_an_already_closed_output_is_ok() {
        let manager = MidiOutputManager::default();
        assert!(manager.restart(None).is_ok());
        assert!(manager.restart(Some("   ".into())).is_ok());
        assert!(!manager.is_open());
    }
}
