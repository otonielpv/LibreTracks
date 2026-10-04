//! Transport for platforms without MIDI: no ports, nothing opens.

use super::{InputConnection, MidiCapabilities, MidiTransport, OnBytes, OutputConnection};

pub(crate) struct NullTransport;

impl MidiTransport for NullTransport {
    fn input_names(&self) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }

    fn output_names(&self) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }

    fn open_input(
        &self,
        name: &str,
        _on_bytes: OnBytes,
    ) -> Result<Box<dyn InputConnection>, String> {
        Err(format!("MIDI is not available on this platform: {name}"))
    }

    fn open_output(&self, name: &str) -> Result<Box<dyn OutputConnection>, String> {
        Err(format!("MIDI is not available on this platform: {name}"))
    }

    fn capabilities(&self) -> MidiCapabilities {
        MidiCapabilities::default()
    }
}
