//! Outbound MIDI messages, already resolved to wire bytes. Shared by every
//! transport: the scheduler builds these, the writer threads send them.

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

    pub(crate) fn to_bytes(self) -> Vec<u8> {
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
}
