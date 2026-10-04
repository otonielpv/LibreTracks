//! MIDI input listener and module root.
//!
//! - `transport/`: the platform part (list, open, raw bytes in/out);
//! - `dispatch.rs`: what an incoming message does (MIDI Learn);
//! - `message.rs`: outbound message encoding;
//! - `output.rs`: the outbound port manager.
//!
//! Input runs on two threads: the listener owns the open connection and frames
//! raw bytes into messages; the dispatcher takes session locks and emits
//! events, so a slow dispatch never backs up the transport's callback.

mod dispatch;
pub mod message;
pub mod output;
pub(crate) mod transport;

use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, RecvTimeoutError, Sender},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::Duration,
};

use libretracks_core::midi_wire::{Framer, WireEvent};
use tauri::AppHandle;

use crate::audio::engine::AudioCommand;
use dispatch::{dispatch_midi_message, MidiMessage};
use transport::{platform_transport, MidiTransport};

pub use transport::MidiCapabilities;

const MIDI_LOOP_POLL_INTERVAL: Duration = Duration::from_millis(100);
pub(crate) const MIDI_STARTUP_TIMEOUT: Duration = Duration::from_secs(2);

pub(crate) struct MidiListenerHandle {
    device_name: String,
    should_stop: Arc<AtomicBool>,
    listener_thread: JoinHandle<()>,
    dispatcher_thread: JoinHandle<()>,
}

pub struct MidiManager {
    transport: Arc<dyn MidiTransport>,
    active_listener: Mutex<Option<MidiListenerHandle>>,
}

impl Default for MidiManager {
    fn default() -> Self {
        Self {
            transport: platform_transport(),
            active_listener: Mutex::new(None),
        }
    }
}

impl MidiManager {
    pub fn restart(
        &self,
        app: AppHandle,
        _audio_sender: Sender<AudioCommand>,
        selected_device: Option<String>,
    ) -> Result<(), String> {
        let normalized_device = normalize_device_name(selected_device);
        let mut active_listener = self
            .active_listener
            .lock()
            .map_err(|_| "midi listener state lock poisoned".to_string())?;

        if active_listener
            .as_ref()
            .map(|listener| listener.device_name.as_str())
            == normalized_device.as_deref()
        {
            return Ok(());
        }

        if let Some(listener) = active_listener.take() {
            stop_listener(listener);
        }

        if let Some(device_name) = normalized_device {
            let listener =
                spawn_midi_listener(Arc::clone(&self.transport), device_name, move |message| {
                    if let Err(error) = dispatch_midi_message(&app, message) {
                        eprintln!("[libretracks-midi] failed to dispatch MIDI message: {error}");
                    }
                })?;
            *active_listener = Some(listener);
        }

        Ok(())
    }
}

impl Drop for MidiManager {
    fn drop(&mut self) {
        if let Ok(mut active_listener) = self.active_listener.lock() {
            if let Some(listener) = active_listener.take() {
                stop_listener(listener);
            }
        }
    }
}

pub(crate) fn get_midi_input_names() -> Result<Vec<String>, String> {
    platform_transport().input_names()
}

pub(crate) fn get_midi_capabilities() -> MidiCapabilities {
    platform_transport().capabilities()
}

fn spawn_midi_listener(
    transport: Arc<dyn MidiTransport>,
    port_name: String,
    mut dispatch: impl FnMut(MidiMessage) + Send + 'static,
) -> Result<MidiListenerHandle, String> {
    let should_stop = Arc::new(AtomicBool::new(false));
    let (message_sender, message_receiver) = mpsc::channel();
    let (startup_sender, startup_receiver) = mpsc::channel();

    let listener_stop_flag = should_stop.clone();
    let listener_port_name = port_name.clone();
    let listener_thread = thread::Builder::new()
        .name("libretracks-midi-input".into())
        .spawn(move || {
            run_midi_listener_loop(
                transport.as_ref(),
                &listener_port_name,
                message_sender,
                startup_sender,
                listener_stop_flag,
            );
        })
        .map_err(|error| error.to_string())?;

    match startup_receiver.recv_timeout(MIDI_STARTUP_TIMEOUT) {
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            should_stop.store(true, Ordering::Release);
            let _ = listener_thread.join();
            return Err(error);
        }
        Err(RecvTimeoutError::Timeout) => {
            should_stop.store(true, Ordering::Release);
            let _ = listener_thread.join();
            return Err("timed out while starting MIDI listener".into());
        }
        Err(RecvTimeoutError::Disconnected) => {
            should_stop.store(true, Ordering::Release);
            let _ = listener_thread.join();
            return Err("MIDI listener exited before startup completed".into());
        }
    }

    let dispatcher_stop_flag = should_stop.clone();
    let dispatcher_thread = thread::Builder::new()
        .name("libretracks-midi-dispatch".into())
        .spawn(move || {
            while !dispatcher_stop_flag.load(Ordering::Acquire) {
                match message_receiver.recv_timeout(MIDI_LOOP_POLL_INTERVAL) {
                    Ok(message) => dispatch(message),
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => break,
                }
            }
        })
        .map_err(|error| error.to_string())?;

    Ok(MidiListenerHandle {
        device_name: port_name,
        should_stop,
        listener_thread,
        dispatcher_thread,
    })
}

fn run_midi_listener_loop(
    transport: &dyn MidiTransport,
    port_name: &str,
    message_sender: Sender<MidiMessage>,
    startup_sender: Sender<Result<(), String>>,
    should_stop: Arc<AtomicBool>,
) {
    let mut framer = Framer::new();
    let connection = match transport.open_input(
        port_name,
        Box::new(move |bytes| {
            framer.push(bytes, &mut |event| {
                // Real-time bytes (clock, start/stop) aren't bound to anything
                // yet; only full messages reach MIDI Learn.
                if let WireEvent::Message {
                    status,
                    data1,
                    data2,
                } = event
                {
                    let _ = message_sender.send(MidiMessage {
                        status,
                        data1,
                        data2,
                    });
                }
            });
        }),
    ) {
        Ok(connection) => connection,
        Err(error) => {
            let _ = startup_sender.send(Err(error));
            return;
        }
    };

    let _ = startup_sender.send(Ok(()));
    while !should_stop.load(Ordering::Acquire) {
        thread::sleep(MIDI_LOOP_POLL_INTERVAL);
    }
    drop(connection);
}

fn normalize_device_name(device_name: Option<String>) -> Option<String> {
    device_name.and_then(|name| {
        let trimmed = name.trim().to_string();
        (!trimmed.is_empty()).then_some(trimmed)
    })
}

fn stop_listener(listener: MidiListenerHandle) {
    listener.should_stop.store(true, Ordering::Release);
    let _ = listener.listener_thread.join();
    let _ = listener.dispatcher_thread.join();
}
