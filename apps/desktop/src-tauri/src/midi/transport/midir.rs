//! `midir` transport: WinMM/WinRT on Windows, CoreMIDI on macOS, ALSA on
//! Linux. The only file in the crate that imports `midir`.

use midir::{Ignore, MidiInput, MidiInputConnection, MidiOutput, MidiOutputConnection};

use super::{InputConnection, MidiCapabilities, MidiTransport, OnBytes, OutputConnection};

#[derive(Default)]
pub(crate) struct MidirTransport;

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
        Ok(sorted_unique(
            midi_input
                .ports()
                .iter()
                .filter_map(|port| midi_input.port_name(port).ok())
                .collect(),
        ))
    }

    fn output_names(&self) -> Result<Vec<String>, String> {
        let midi_output =
            MidiOutput::new("libretracks-midi-outputs").map_err(|error| error.to_string())?;
        Ok(sorted_unique(
            midi_output
                .ports()
                .iter()
                .filter_map(|port| midi_output.port_name(port).ok())
                .collect(),
        ))
    }

    fn open_input(
        &self,
        name: &str,
        mut on_bytes: OnBytes,
    ) -> Result<Box<dyn InputConnection>, String> {
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
            ..MidiCapabilities::default()
        }
    }
}
