//! `midir` transport: WinMM/WinRT on Windows, CoreMIDI on macOS, ALSA on
//! Linux. The only file in the crate that imports `midir`.

use midir::{Ignore, MidiInput, MidiInputConnection, MidiOutput, MidiOutputConnection};

use super::{InputConnection, MidiCapabilities, MidiTransport, OnBytes, OutputConnection};
#[cfg(target_os = "ios")]
use super::{
    virtual_names::{with_own_virtual_port, VIRTUAL_IN, VIRTUAL_OUT},
    virtual_ports::VirtualPorts,
};

#[derive(Default)]
pub(crate) struct MidirTransport {
    /// iOS: our own published ports (paso 07).
    #[cfg(target_os = "ios")]
    virtual_ports: VirtualPorts,
}

impl MidirTransport {
    /// Our own port in a direction, while publishing is on (iOS only).
    #[cfg(target_os = "ios")]
    fn own(&self, name: &'static str) -> Option<&'static str> {
        self.virtual_ports.is_enabled().then_some(name)
    }
}

struct MidirInput {
    _connection: MidiInputConnection<()>,
}

impl InputConnection for MidirInput {}

struct MidirOutput {
    connection: MidiOutputConnection,
}

impl OutputConnection for MidirOutput {
    fn send(&mut self, bytes: &[u8]) -> Result<(), String> {
        self.connection
            .send(bytes)
            .map_err(|error| error.to_string())
    }
}

fn sorted_unique(mut names: Vec<String>) -> Vec<String> {
    names.sort();
    names.dedup();
    names
}

impl MidiTransport for MidirTransport {
    fn input_names(&self) -> Result<Vec<String>, String> {
        let midi_input =
            MidiInput::new("libretracks-midi-inputs").map_err(|error| error.to_string())?;
        let names = sorted_unique(
            midi_input
                .ports()
                .iter()
                .filter_map(|port| midi_input.port_name(port).ok())
                .collect(),
        );
        #[cfg(target_os = "ios")]
        let names = with_own_virtual_port(names, self.own(VIRTUAL_IN));
        Ok(names)
    }

    fn output_names(&self) -> Result<Vec<String>, String> {
        let midi_output =
            MidiOutput::new("libretracks-midi-outputs").map_err(|error| error.to_string())?;
        let names = sorted_unique(
            midi_output
                .ports()
                .iter()
                .filter_map(|port| midi_output.port_name(port).ok())
                .collect(),
        );
        #[cfg(target_os = "ios")]
        let names = with_own_virtual_port(names, self.own(VIRTUAL_OUT));
        Ok(names)
    }

    fn open_input(
        &self,
        name: &str,
        mut on_bytes: OnBytes,
    ) -> Result<Box<dyn InputConnection>, String> {
        #[cfg(target_os = "ios")]
        if name == VIRTUAL_IN {
            return self.virtual_ports.attach_input(on_bytes);
        }
        let mut midi_input =
            MidiInput::new("libretracks-midi-listener").map_err(|error| error.to_string())?;
        midi_input.ignore(Ignore::None);
        let port = midi_input
            .ports()
            .into_iter()
            .find(|port| {
                midi_input
                    .port_name(port)
                    .map(|port_name| port_name == name)
                    .unwrap_or(false)
            })
            .ok_or_else(|| format!("MIDI input device not found: {name}"))?;
        let connection = midi_input
            .connect(
                &port,
                "libretracks-midi-callback",
                move |_timestamp, bytes, _| on_bytes(bytes),
                (),
            )
            .map_err(|error| error.to_string())?;
        Ok(Box::new(MidirInput {
            _connection: connection,
        }))
    }

    fn open_output(&self, name: &str) -> Result<Box<dyn OutputConnection>, String> {
        #[cfg(target_os = "ios")]
        if name == VIRTUAL_OUT {
            return self.virtual_ports.output();
        }
        let midi_output =
            MidiOutput::new("libretracks-midi-output").map_err(|error| error.to_string())?;
        let port = midi_output
            .ports()
            .into_iter()
            .find(|port| {
                midi_output
                    .port_name(port)
                    .map(|port_name| port_name == name)
                    .unwrap_or(false)
            })
            .ok_or_else(|| format!("MIDI output device not found: {name}"))?;
        let connection = midi_output
            .connect(&port, "libretracks-midi-send")
            .map_err(|error| error.to_string())?;
        Ok(Box::new(MidirOutput { connection }))
    }

    fn capabilities(&self) -> MidiCapabilities {
        MidiCapabilities {
            available: true,
            // iOS: RTP-MIDI session and our own virtual ports (paso 07).
            network_session: cfg!(target_os = "ios"),
            virtual_ports: cfg!(target_os = "ios"),
            // iOS: CABTMIDICentralViewController (paso 06).
            bluetooth_pairing: cfg!(target_os = "ios"),
            ..MidiCapabilities::default()
        }
    }

    #[cfg(target_os = "ios")]
    fn set_virtual_ports(&self, enabled: bool) -> Result<(), String> {
        self.virtual_ports.set_enabled(enabled)
    }

    #[cfg(target_os = "ios")]
    fn set_network_session(&self, enabled: bool) -> Result<(), String> {
        super::ios_network::set_network_session(enabled)
    }
}
