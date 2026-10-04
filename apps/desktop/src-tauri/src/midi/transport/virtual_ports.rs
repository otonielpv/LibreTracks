//! iOS: publish "LibreTracks In" / "LibreTracks Out" as CoreMIDI virtual
//! endpoints, so other apps on the same device (synths, lyrics) can exchange
//! MIDI with LibreTracks without cables (plan mobile-midi, paso 07).
//!
//! The ports exist while the setting is on, whether or not LibreTracks has
//! "opened" them: other apps must be able to see them at any time. One owner
//! thread creates and holds both `midir` connections (so their `Send`-ness
//! never matters); the app's input listener plugs into the destination's
//! callback through `sink`, and outputs reach the source over a channel.

use std::{
    sync::{
        mpsc::{self, Sender},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::Duration,
};

use midir::{
    os::unix::{VirtualInput, VirtualOutput},
    MidiInput, MidiOutput,
};

use super::{
    virtual_names::{VIRTUAL_IN, VIRTUAL_OUT},
    InputConnection, OnBytes, OutputConnection,
};

const STARTUP_TIMEOUT: Duration = Duration::from_secs(2);

enum Command {
    Send(Vec<u8>),
    Stop,
}

struct Owner {
    commands: Sender<Command>,
    thread: JoinHandle<()>,
}

type Sink = Arc<Mutex<Option<OnBytes>>>;

#[derive(Default)]
pub(crate) struct VirtualPorts {
    owner: Mutex<Option<Owner>>,
    /// The input listener's callback, while one is attached.
    sink: Sink,
}

impl VirtualPorts {
    pub(crate) fn is_enabled(&self) -> bool {
        self.owner.lock().map(|owner| owner.is_some()).unwrap_or(false)
    }

    pub(crate) fn set_enabled(&self, enabled: bool) -> Result<(), String> {
        let mut owner = self
            .owner
            .lock()
            .map_err(|_| "virtual MIDI ports lock poisoned".to_string())?;
        if enabled == owner.is_some() {
            return Ok(());
        }
        if !enabled {
            if let Some(owner) = owner.take() {
                let _ = owner.commands.send(Command::Stop);
                let _ = owner.thread.join();
            }
            return Ok(());
        }

        let (commands, command_receiver) = mpsc::channel::<Command>();
        let (ready, ready_receiver) = mpsc::channel::<Result<(), String>>();
        let sink = Arc::clone(&self.sink);
        let thread = thread::Builder::new()
            .name("libretracks-midi-virtual".into())
            .spawn(move || {
                let input = match MidiInput::new("libretracks-virtual-in") {
                    Ok(input) => input,
                    Err(error) => {
                        let _ = ready.send(Err(error.to_string()));
                        return;
                    }
                };
                let _input_connection = match input.create_virtual(
                    VIRTUAL_IN,
                    move |_timestamp, bytes, _| {
                        if let Ok(mut sink) = sink.lock() {
                            if let Some(on_bytes) = sink.as_mut() {
                                on_bytes(bytes);
                            }
                        }
                    },
                    (),
                ) {
                    Ok(connection) => connection,
                    Err(error) => {
                        let _ = ready.send(Err(error.to_string()));
                        return;
                    }
                };
                let output = match MidiOutput::new("libretracks-virtual-out") {
                    Ok(output) => output,
                    Err(error) => {
                        let _ = ready.send(Err(error.to_string()));
                        return;
                    }
                };
                let mut output_connection = match output.create_virtual(VIRTUAL_OUT) {
                    Ok(connection) => connection,
                    Err(error) => {
                        let _ = ready.send(Err(error.to_string()));
                        return;
                    }
                };
                let _ = ready.send(Ok(()));
                while let Ok(command) = command_receiver.recv() {
                    match command {
                        Command::Send(bytes) => {
                            let _ = output_connection.send(&bytes);
                        }
                        Command::Stop => break,
                    }
                }
            })
            .map_err(|error| error.to_string())?;

        match ready_receiver.recv_timeout(STARTUP_TIMEOUT) {
            Ok(Ok(())) => {
                *owner = Some(Owner { commands, thread });
                Ok(())
            }
            Ok(Err(error)) => {
                let _ = thread.join();
                Err(error)
            }
            Err(_) => {
                let _ = commands.send(Command::Stop);
                Err("timed out while publishing the virtual MIDI ports".into())
            }
        }
    }

    pub(crate) fn attach_input(&self, on_bytes: OnBytes) -> Result<Box<dyn InputConnection>, String> {
        if !self.is_enabled() {
            return Err(format!("{VIRTUAL_IN} is not published"));
        }
        *self
            .sink
            .lock()
            .map_err(|_| "virtual MIDI sink lock poisoned".to_string())? = Some(on_bytes);
        Ok(Box::new(VirtualInputHandle {
            sink: Arc::clone(&self.sink),
        }))
    }

    pub(crate) fn output(&self) -> Result<Box<dyn OutputConnection>, String> {
        let owner = self
            .owner
            .lock()
            .map_err(|_| "virtual MIDI ports lock poisoned".to_string())?;
        let owner = owner
            .as_ref()
            .ok_or_else(|| format!("{VIRTUAL_OUT} is not published"))?;
        Ok(Box::new(VirtualOutputHandle {
            commands: owner.commands.clone(),
        }))
    }
}

struct VirtualInputHandle {
    sink: Sink,
}

impl InputConnection for VirtualInputHandle {}

impl Drop for VirtualInputHandle {
    fn drop(&mut self) {
        if let Ok(mut sink) = self.sink.lock() {
            *sink = None;
        }
    }
}

struct VirtualOutputHandle {
    commands: Sender<Command>,
}

impl OutputConnection for VirtualOutputHandle {
    fn send(&mut self, bytes: &[u8]) -> Result<(), String> {
        self.commands
            .send(Command::Send(bytes.to_vec()))
            .map_err(|_| format!("{VIRTUAL_OUT} is no longer published"))
    }
}
