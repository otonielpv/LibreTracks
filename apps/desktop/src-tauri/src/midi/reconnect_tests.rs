//! Reconnection state machine (plan mobile-midi, paso 04) against a fake
//! transport whose device list the test controls.

use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use super::{
    output::MidiOutputManager,
    transport::{InputConnection, MidiCapabilities, MidiTransport, OnBytes, OutputConnection},
    DispatchFn, MidiManager,
};

#[derive(Default)]
struct FakeTransport {
    inputs: Mutex<Vec<String>>,
    outputs: Mutex<Vec<String>>,
    /// Inputs opened, ever.
    input_opens: AtomicUsize,
    /// Inputs open right now.
    inputs_open: Arc<AtomicUsize>,
    output_opens: AtomicUsize,
    /// Everything written to any output, in order.
    sent: Arc<Mutex<Vec<u8>>>,
}

impl FakeTransport {
    fn set_inputs(&self, names: &[&str]) {
        *self.inputs.lock().unwrap() = names.iter().map(|name| name.to_string()).collect();
    }

    fn set_outputs(&self, names: &[&str]) {
        *self.outputs.lock().unwrap() = names.iter().map(|name| name.to_string()).collect();
    }
}

struct FakeInput(Arc<AtomicUsize>);

impl InputConnection for FakeInput {}

impl Drop for FakeInput {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

struct FakeOutput(Arc<Mutex<Vec<u8>>>);

impl OutputConnection for FakeOutput {
    fn send(&mut self, bytes: &[u8]) -> Result<(), String> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(())
    }
}

impl MidiTransport for FakeTransport {
    fn input_names(&self) -> Result<Vec<String>, String> {
        Ok(self.inputs.lock().unwrap().clone())
    }

    fn output_names(&self) -> Result<Vec<String>, String> {
        Ok(self.outputs.lock().unwrap().clone())
    }

    fn open_input(&self, name: &str, _on_bytes: OnBytes) -> Result<Box<dyn InputConnection>, String> {
        if !self.inputs.lock().unwrap().iter().any(|input| input == name) {
            return Err(format!("not found: {name}"));
        }
        self.input_opens.fetch_add(1, Ordering::SeqCst);
        self.inputs_open.fetch_add(1, Ordering::SeqCst);
        Ok(Box::new(FakeInput(Arc::clone(&self.inputs_open))))
    }

    fn open_output(&self, name: &str) -> Result<Box<dyn OutputConnection>, String> {
        if !self.outputs.lock().unwrap().iter().any(|output| output == name) {
            return Err(format!("not found: {name}"));
        }
        self.output_opens.fetch_add(1, Ordering::SeqCst);
        Ok(Box::new(FakeOutput(Arc::clone(&self.sent))))
    }

    fn capabilities(&self) -> MidiCapabilities {
        MidiCapabilities {
            available: true,
            ..MidiCapabilities::default()
        }
    }
}

fn noop_dispatch() -> DispatchFn {
    Arc::new(|_| {})
}

fn names(transport: &FakeTransport, inputs: bool) -> Vec<String> {
    if inputs {
        transport.input_names().unwrap()
    } else {
        transport.output_names().unwrap()
    }
}

fn wait_for(mut done: impl FnMut() -> bool) -> bool {
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(2) {
        if done() {
            return true;
        }
        thread::sleep(Duration::from_millis(5));
    }
    done()
}

#[test]
fn input_goes_open_waiting_open_with_a_single_reopen() {
    let transport = Arc::new(FakeTransport::default());
    transport.set_inputs(&["Pedal"]);
    let manager = MidiManager::with_transport(transport.clone());

    manager.select(noop_dispatch(), Some("Pedal".into())).unwrap();
    assert!(manager.is_connected());
    assert_eq!(transport.input_opens.load(Ordering::SeqCst), 1);

    // Cable pulled.
    transport.set_inputs(&[]);
    assert!(manager.on_devices_changed(&names(&transport, true)));
    assert!(manager.is_waiting());
    assert_eq!(transport.inputs_open.load(Ordering::SeqCst), 0);
    // Nothing more to do while it stays missing.
    assert!(!manager.on_devices_changed(&names(&transport, true)));

    // Cable back.
    transport.set_inputs(&["Pedal"]);
    assert!(manager.on_devices_changed(&names(&transport, true)));
    assert!(manager.is_connected());
    assert_eq!(transport.input_opens.load(Ordering::SeqCst), 2);
    assert_eq!(transport.inputs_open.load(Ordering::SeqCst), 1);

    // Further checks with the device present never open a second listener.
    assert!(!manager.on_devices_changed(&names(&transport, true)));
    assert!(!manager.on_devices_changed(&names(&transport, true)));
    assert_eq!(transport.input_opens.load(Ordering::SeqCst), 2);
    assert_eq!(transport.inputs_open.load(Ordering::SeqCst), 1);
}

#[test]
fn an_input_missing_at_startup_waits_and_opens_when_it_appears() {
    let transport = Arc::new(FakeTransport::default());
    let manager = MidiManager::with_transport(transport.clone());

    assert!(manager.select(noop_dispatch(), Some("Pedal".into())).is_err());
    assert!(manager.is_waiting());
    assert!(manager.wants_port());

    transport.set_inputs(&["Other", "Pedal"]);
    assert!(manager.on_devices_changed(&names(&transport, true)));
    assert!(manager.is_connected());
    assert_eq!(transport.inputs_open.load(Ordering::SeqCst), 1);
}

#[test]
fn deselecting_stops_watching() {
    let transport = Arc::new(FakeTransport::default());
    transport.set_inputs(&["Pedal"]);
    let manager = MidiManager::with_transport(transport.clone());
    let outputs = MidiOutputManager::with_transport(transport.clone());
    assert!(!manager.wants_port());
    assert!(!outputs.wants_ports());

    manager.select(noop_dispatch(), Some("Pedal".into())).unwrap();
    assert!(manager.wants_port());
    manager.select(noop_dispatch(), None).unwrap();
    assert!(!manager.wants_port());
    assert_eq!(transport.inputs_open.load(Ordering::SeqCst), 0);
}

#[test]
fn a_returning_output_is_silenced_before_anything_else() {
    let transport = Arc::new(FakeTransport::default());
    transport.set_outputs(&["Desk"]);
    let manager = MidiOutputManager::with_transport(transport.clone());
    manager.restart(Some("Desk".into())).unwrap();
    assert!(manager.is_default_port_open());

    transport.set_outputs(&[]);
    assert!(manager.on_devices_changed(&names(&transport, false)));
    assert!(manager.is_waiting());
    // Closing writes a panic to the (gone) port; forget it.
    transport.sent.lock().unwrap().clear();

    transport.set_outputs(&["Desk"]);
    assert!(manager.on_devices_changed(&names(&transport, false)));
    assert!(manager.is_default_port_open());
    assert_eq!(transport.output_opens.load(Ordering::SeqCst), 2);

    manager.send(&[super::message::OutboundMidiMessage::note_on(1, 60, 100)]);
    // 32 panic messages (3 bytes each), then the note.
    let expected_len = 32 * 3 + 3;
    assert!(wait_for(|| transport.sent.lock().unwrap().len() >= expected_len));
    let sent = transport.sent.lock().unwrap().clone();
    assert_eq!(&sent[..3], &[0xB0, 120, 0], "All Sound Off on channel 1 first");
    assert_eq!(&sent[96..99], &[0x90, 60, 100], "then the note");
}

#[test]
fn a_per_track_port_that_failed_is_retried_when_it_appears() {
    let transport = Arc::new(FakeTransport::default());
    let manager = MidiOutputManager::with_transport(transport.clone());
    let note = [super::message::OutboundMidiMessage::note_on(1, 60, 100)];

    manager.send_to(Some("Lyrics"), &note);
    assert_eq!(transport.output_opens.load(Ordering::SeqCst), 0);
    assert!(manager.wants_ports());

    transport.set_outputs(&["Lyrics"]);
    assert!(manager.on_devices_changed(&names(&transport, false)));
    assert_eq!(transport.output_opens.load(Ordering::SeqCst), 1);
    assert!(!manager.on_devices_changed(&names(&transport, false)));
    assert_eq!(transport.output_opens.load(Ordering::SeqCst), 1);
}

#[test]
fn a_suspended_input_stays_closed_until_revalidated() {
    let transport = Arc::new(FakeTransport::default());
    transport.set_inputs(&["Pedal"]);
    let manager = MidiManager::with_transport(transport.clone());
    manager.select(noop_dispatch(), Some("Pedal".into())).unwrap();

    // Background with "keep MIDI active" off.
    assert!(manager.suspend());
    assert_eq!(transport.inputs_open.load(Ordering::SeqCst), 0);
    assert!(!manager.is_waiting(), "suspended is not waiting: no badge");
    assert!(!manager.wants_port(), "and nothing polls");
    assert!(!manager.on_devices_changed(&names(&transport, true)));
    assert_eq!(transport.input_opens.load(Ordering::SeqCst), 1);

    // Foreground: revalidate, then the next check reopens it once.
    manager.revalidate();
    assert!(manager.on_devices_changed(&names(&transport, true)));
    assert!(!manager.on_devices_changed(&names(&transport, true)));
    assert_eq!(transport.input_opens.load(Ordering::SeqCst), 2);
    assert_eq!(transport.inputs_open.load(Ordering::SeqCst), 1);
}

#[test]
fn revalidating_reopens_a_listener_that_looked_open() {
    let transport = Arc::new(FakeTransport::default());
    transport.set_inputs(&["Pedal"]);
    let manager = MidiManager::with_transport(transport.clone());
    manager.select(noop_dispatch(), Some("Pedal".into())).unwrap();

    manager.revalidate();
    assert_eq!(transport.inputs_open.load(Ordering::SeqCst), 0);
    assert!(manager.on_devices_changed(&names(&transport, true)));
    assert_eq!(transport.input_opens.load(Ordering::SeqCst), 2);
    assert_eq!(transport.inputs_open.load(Ordering::SeqCst), 1);
}

#[test]
fn without_a_backend_nothing_opens_and_nothing_is_watched() {
    let transport = Arc::new(super::transport::null::NullTransport);
    let manager = MidiManager::with_transport(transport.clone());
    let outputs = MidiOutputManager::with_transport(transport);
    assert!(manager.select(noop_dispatch(), Some("Pedal".into())).is_err());
    assert!(!manager.is_connected());
    assert!(outputs.restart(Some("Desk".into())).is_err());
    assert!(!outputs.is_default_port_open());
}
