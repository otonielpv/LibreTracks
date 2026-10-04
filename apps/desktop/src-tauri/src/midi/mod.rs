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

pub(crate) mod bluetooth;
mod dispatch;
#[cfg(any(target_os = "android", target_os = "ios"))]
pub(crate) mod lifecycle;
pub mod message;
pub mod output;
#[cfg(test)]
mod reconnect_tests;
pub(crate) mod transport;
pub(crate) mod watch;

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
use dispatch::dispatch_midi_message;
pub(crate) use dispatch::MidiMessage;
use transport::{platform_transport, MidiTransport};

pub use transport::MidiCapabilities;

const MIDI_LOOP_POLL_INTERVAL: Duration = Duration::from_millis(100);
pub(crate) const MIDI_STARTUP_TIMEOUT: Duration = Duration::from_secs(2);

pub(crate) struct MidiListenerHandle {
    should_stop: Arc<AtomicBool>,
    listener_thread: JoinHandle<()>,
    dispatcher_thread: JoinHandle<()>,
}

/// What an incoming message does. The app passes MIDI Learn dispatch; tests
/// pass a recorder.
pub(crate) type DispatchFn = Arc<dyn Fn(MidiMessage) + Send + Sync>;

#[derive(Default)]
struct InputState {
    /// The port the user selected, whether or not it is open right now.
    desired: Option<String>,
    /// Open listener for `desired`. `None` with `desired` set = *waiting* for
    /// the port to (re)appear.
    active: Option<MidiListenerHandle>,
    dispatch: Option<DispatchFn>,
    /// Closed on purpose while the app is in the background (paso 08, with
    /// "Keep MIDI active in the background" off). Not waiting: nothing
    /// reopens it until `revalidate`.
    suspended: bool,
}

pub struct MidiManager {
    transport: Arc<dyn MidiTransport>,
    state: Mutex<InputState>,
}

impl Default for MidiManager {
    fn default() -> Self {
        Self::with_transport(platform_transport())
    }
}

impl MidiManager {
    pub(crate) fn with_transport(transport: Arc<dyn MidiTransport>) -> Self {
        Self {
            transport,
            state: Mutex::new(InputState::default()),
        }
    }

    pub fn restart(
        &self,
        app: AppHandle,
        _audio_sender: Sender<AudioCommand>,
        selected_device: Option<String>,
    ) -> Result<(), String> {
        let dispatch: DispatchFn = Arc::new(move |message| {
            if let Err(error) = dispatch_midi_message(&app, message) {
                eprintln!("[libretracks-midi] failed to dispatch MIDI message: {error}");
            }
        });
        let result = self.select(dispatch, selected_device);
        watch::ensure_running();
        result
    }

    /// Select (and open) the input port. Re-selecting the open port is a
    /// no-op. A port that fails to open stays selected and *waiting*: the
    /// watcher reopens it when it appears.
    pub(crate) fn select(
        &self,
        dispatch: DispatchFn,
        selected_device: Option<String>,
    ) -> Result<(), String> {
        let normalized_device = normalize_device_name(selected_device);
        let mut state = self
            .state
            .lock()
            .map_err(|_| "midi listener state lock poisoned".to_string())?;
        state.dispatch = Some(dispatch);

        if state.active.is_some() && state.desired == normalized_device {
            return Ok(());
        }
        // The user is choosing a port, so the app is in the foreground.
        state.suspended = false;

        if let Some(listener) = state.active.take() {
            stop_listener(listener);
        }
        state.desired = normalized_device;

        if let Some(device_name) = state.desired.clone() {
            let dispatch = state.dispatch.clone().expect("dispatch set above");
            state.active = Some(spawn_midi_listener(
                Arc::clone(&self.transport),
                device_name,
                move |message| dispatch(message),
            )?);
        }

        Ok(())
    }

    /// React to a new device list: close the listener of a port that has
    /// gone, reopen a waiting port that has come back. Returns true when it
    /// opened or closed anything.
    pub(crate) fn on_devices_changed(&self, inputs: &[String]) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        let Some(name) = state.desired.clone() else {
            return false;
        };
        let present = inputs.iter().any(|input| *input == name);

        if state.suspended {
            return false;
        }

        if !present {
            return match state.active.take() {
                Some(listener) => {
                    stop_listener(listener);
                    true
                }
                None => false,
            };
        }

        if state.active.is_some() {
            return false;
        }
        let Some(dispatch) = state.dispatch.clone() else {
            return false;
        };
        match spawn_midi_listener(Arc::clone(&self.transport), name, move |message| {
            dispatch(message)
        }) {
            Ok(listener) => {
                state.active = Some(listener);
                true
            }
            Err(error) => {
                eprintln!("[libretracks-midi] reopening input failed: {error}");
                false
            }
        }
    }

    /// The selected input port is open.
    pub(crate) fn is_connected(&self) -> bool {
        self.state
            .lock()
            .map(|state| state.active.is_some())
            .unwrap_or(false)
    }

    /// A port is selected but not open: waiting for it to appear.
    pub(crate) fn is_waiting(&self) -> bool {
        self.state
            .lock()
            .map(|state| state.desired.is_some() && state.active.is_none() && !state.suspended)
            .unwrap_or(false)
    }

    /// Whether the watcher has anything to do for inputs. A suspended input
    /// is not watched: no polling while the app sleeps in the background.
    pub(crate) fn wants_port(&self) -> bool {
        self.state
            .lock()
            .map(|state| state.desired.is_some() && !state.suspended)
            .unwrap_or(false)
    }

    /// Close the input for a stay in the background, keeping the selection.
    /// Returns true when a listener was open. Mobile only (midi/lifecycle.rs).
    #[cfg_attr(not(any(target_os = "android", target_os = "ios")), allow(dead_code))]
    pub(crate) fn suspend(&self) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        state.suspended = true;
        match state.active.take() {
            Some(listener) => {
                stop_listener(listener);
                true
            }
            None => false,
        }
    }

    /// Back in the foreground: end any suspension and drop the open listener,
    /// so the next device check reopens it from scratch. After minutes in the
    /// background a connection can look open and be dead (a BLE link the
    /// system dropped, a CoreMIDI client iOS invalidated); reopening costs a
    /// few milliseconds and rules that out.
    pub(crate) fn revalidate(&self) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        state.suspended = false;
        if let Some(listener) = state.active.take() {
            stop_listener(listener);
        }
    }
}

impl Drop for MidiManager {
    fn drop(&mut self) {
        if let Ok(mut state) = self.state.lock() {
            if let Some(listener) = state.active.take() {
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

/// Apply the platform MIDI settings that live in the transport rather than in
/// a port selection: our own virtual ports (iOS paso 07, Android paso 10) and
/// the iOS network session. Failures are logged, never fatal: a missing
/// virtual port must not stop the app from starting.
pub(crate) fn apply_platform_settings(settings: &crate::infra::settings::AppSettings) {
    let transport = platform_transport();
    let capabilities = transport.capabilities();
    if capabilities.virtual_ports {
        if let Err(error) = transport.set_virtual_ports(settings.midi_virtual_port) {
            eprintln!("[libretracks-midi] virtual ports: {error}");
        }
        // Android: switching our MidiDeviceService on or off makes the system
        // re-register EVERY MIDI service of the package, and connections made
        // just before can end up tied to the old instance: open, silent.
        // Seen on the emulator with the debug loopback. Once the system has
        // settled, reopen everything from scratch.
        #[cfg(target_os = "android")]
        {
            let _ = std::thread::Builder::new()
                .name("libretracks-midi-settle".into())
                .spawn(|| {
                    std::thread::sleep(std::time::Duration::from_millis(1500));
                    watch::revalidate_and_check();
                });
        }
    }
    if capabilities.network_session {
        if let Err(error) = transport.set_network_session(settings.midi_network_session) {
            eprintln!("[libretracks-midi] network session: {error}");
        }
    }
    // The port lists changed: refresh Settings and reopen anything waiting.
    watch::notify_changed();
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
