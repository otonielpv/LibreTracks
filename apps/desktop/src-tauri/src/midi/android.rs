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

/// Android stub for `midi::output`. Same surface as the desktop module so the
/// transport's MIDI runtime compiles unchanged; every send is discarded.
pub mod output {
    /// Mirrors the desktop message type so call sites need no cfg-gating.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct OutboundMidiMessage {
        pub status: u8,
        pub data1: u8,
        pub data2: u8,
        pub two_bytes: bool,
    }

    impl OutboundMidiMessage {
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
            Self::channel_voice(0x90, channel, note, velocity, false)
        }

        pub fn note_off(channel: u8, note: u8) -> Self {
            Self::channel_voice(0x80, channel, note, 0, false)
        }

        pub fn control_change(channel: u8, controller: u8, value: u8) -> Self {
            Self::channel_voice(0xB0, channel, controller, value, false)
        }

        pub fn program_change(channel: u8, program: u8) -> Self {
            Self::channel_voice(0xC0, channel, program, 0, true)
        }
    }

    pub fn panic_messages() -> Vec<OutboundMidiMessage> {
        Vec::new()
    }

    #[derive(Default)]
    pub struct MidiOutputManager;

    impl MidiOutputManager {
        pub fn restart(&self, _selected_device: Option<String>) -> Result<(), String> {
            Ok(())
        }

        pub fn is_open(&self) -> bool {
            false
        }

        pub fn send(&self, _messages: &[OutboundMidiMessage]) {}

        pub fn panic(&self) {}
    }

    pub(crate) fn get_midi_output_names() -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }
}
