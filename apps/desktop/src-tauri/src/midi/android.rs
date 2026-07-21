//! Android stub for the MIDI module — `midir` has no Android backend, so
//! MIDI input is unavailable on mobile. Keeps the same public surface as
//! `midi.rs` (what `state.rs`, `lib.rs` and `commands/system.rs` use) so no
//! call site needs cfg-gating.

use std::sync::mpsc::Sender;

use tauri::AppHandle;

use crate::audio::engine::AudioCommand;

#[derive(Default)]
pub struct MidiManager;

impl MidiManager {
    pub fn restart(
        &self,
        _app: AppHandle,
        _audio_sender: Sender<AudioCommand>,
        _selected_device: Option<String>,
    ) -> Result<(), String> {
        Ok(())
    }
}

pub(crate) fn get_midi_input_names() -> Result<Vec<String>, String> {
    Ok(Vec::new())
}
