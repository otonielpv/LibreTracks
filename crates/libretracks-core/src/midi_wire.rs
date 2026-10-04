//! MIDI byte-stream framer.
//!
//! Every MIDI transport hands us bytes, but not all of them hand us *one
//! message per call*: Android's `MidiReceiver.onSend` delivers arbitrary
//! chunks that may hold several messages, running status and real-time bytes
//! interleaved mid-message, and a CoreMIDI packet may hold several messages.
//! The framer is the single place that turns a byte stream back into
//! messages, so every transport (desktop `midir` included) shares it.
//!
//! Rules (MIDI 1.0 spec):
//! - channel voice messages (`0x80`-`0xEF`) set *running status*: following
//!   data bytes without a status reuse the last one;
//! - real-time bytes (`0xF8`-`0xFF`) may appear anywhere, even inside another
//!   message; they are emitted on their own and do not disturb it;
//! - SysEx (`0xF0` … `0xF7`) is discarded whole, without buffering;
//! - system common (`0xF1`-`0xF7`) cancels running status;
//! - data bytes with no status to attach to are discarded.

/// One framed message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WireEvent {
    /// A channel voice or system common message. Messages shorter than three
    /// bytes carry `0` in the missing data fields, as the desktop parser did.
    Message { status: u8, data1: u8, data2: u8 },
    /// A single real-time byte (`0xF8` clock, `0xFA` start, …).
    Realtime(u8),
}

/// Push-style framer. Feed it bytes as they arrive; it keeps the partial
/// message between calls, so a message split across two chunks still frames.
#[derive(Debug, Default, Clone)]
pub struct Framer {
    /// Status of the message being assembled, if any.
    status: Option<u8>,
    data: [u8; 2],
    have: usize,
    in_sysex: bool,
}

impl Framer {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed `bytes`, calling `out` once per complete message.
    pub fn push(&mut self, bytes: &[u8], out: &mut impl FnMut(WireEvent)) {
        for &byte in bytes {
            self.push_byte(byte, out);
        }
    }

    fn push_byte(&mut self, byte: u8, out: &mut impl FnMut(WireEvent)) {
        if byte >= 0xF8 {
            out(WireEvent::Realtime(byte));
            return;
        }

        if byte == 0xF0 {
            self.in_sysex = true;
            self.status = None;
            self.have = 0;
            return;
        }

        if byte == 0xF7 {
            // End of SysEx (or a stray EOX): either way nothing to emit.
            self.in_sysex = false;
            self.status = None;
            self.have = 0;
            return;
        }

        if byte & 0x80 != 0 {
            // Any status byte ends a SysEx that never saw its EOX.
            self.in_sysex = false;
            self.have = 0;
            match data_len(byte) {
                Some(0) => {
                    // Tune request: complete on its own, cancels running status.
                    self.status = None;
                    out(WireEvent::Message {
                        status: byte,
                        data1: 0,
                        data2: 0,
                    });
                }
                Some(_) => self.status = Some(byte),
                // Undefined system common (0xF4, 0xF5): ignore and drop
                // running status, as the spec requires.
                None => self.status = None,
            }
            return;
        }

        if self.in_sysex {
            return;
        }
        let Some(status) = self.status else {
            return;
        };
        let Some(expected) = data_len(status) else {
            return;
        };

        self.data[self.have] = byte;
        self.have += 1;
        if self.have < expected {
            return;
        }

        out(WireEvent::Message {
            status,
            data1: self.data[0],
            data2: if expected == 2 { self.data[1] } else { 0 },
        });
        self.have = 0;
        if status >= 0xF0 {
            // System common never runs.
            self.status = None;
        }
    }
}

/// Data bytes that follow `status`, or `None` for statuses the framer never
/// assembles (SysEx delimiters, undefined system common, real-time).
fn data_len(status: u8) -> Option<usize> {
    match status {
        0x80..=0xBF | 0xE0..=0xEF => Some(2),
        0xC0..=0xDF => Some(1),
        0xF1 | 0xF3 => Some(1),
        0xF2 => Some(2),
        0xF6 => Some(0),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(chunks: &[&[u8]]) -> Vec<WireEvent> {
        let mut framer = Framer::new();
        let mut events = Vec::new();
        for chunk in chunks {
            framer.push(chunk, &mut |event| events.push(event));
        }
        events
    }

    fn msg(status: u8, data1: u8, data2: u8) -> WireEvent {
        WireEvent::Message {
            status,
            data1,
            data2,
        }
    }

    #[test]
    fn frames_a_three_byte_message() {
        assert_eq!(frame(&[&[0x90, 60, 100]]), vec![msg(0x90, 60, 100)]);
    }

    #[test]
    fn frames_a_two_byte_program_change() {
        assert_eq!(
            frame(&[&[0xC3, 7, 0x91, 61, 90]]),
            vec![msg(0xC3, 7, 0), msg(0x91, 61, 90)]
        );
    }

    #[test]
    fn reuses_running_status() {
        assert_eq!(
            frame(&[&[0xB0, 7, 100, 10, 64, 11, 127]]),
            vec![msg(0xB0, 7, 100), msg(0xB0, 10, 64), msg(0xB0, 11, 127)]
        );
        // Running status also for 2-byte messages.
        assert_eq!(
            frame(&[&[0xC0, 1, 2, 3]]),
            vec![msg(0xC0, 1, 0), msg(0xC0, 2, 0), msg(0xC0, 3, 0)]
        );
    }

    #[test]
    fn realtime_inside_a_message_does_not_break_it() {
        assert_eq!(
            frame(&[&[0x90, 0xF8, 60, 0xF8, 100]]),
            vec![
                WireEvent::Realtime(0xF8),
                WireEvent::Realtime(0xF8),
                msg(0x90, 60, 100)
            ]
        );
    }

    #[test]
    fn discards_long_sysex_then_frames_next_message() {
        let mut bytes = vec![0xF0];
        bytes.extend(std::iter::repeat(0x42).take(4096));
        bytes.push(0xF7);
        bytes.extend([0x80, 60, 0]);
        assert_eq!(frame(&[&bytes]), vec![msg(0x80, 60, 0)]);
    }

    #[test]
    fn sysex_without_eox_is_ended_by_the_next_status() {
        assert_eq!(
            frame(&[&[0xF0, 1, 2, 3, 0x90, 60, 1]]),
            vec![msg(0x90, 60, 1)]
        );
    }

    #[test]
    fn sysex_cancels_running_status() {
        assert_eq!(
            frame(&[&[0x90, 60, 1, 0xF0, 1, 0xF7, 61, 2]]),
            vec![msg(0x90, 60, 1)]
        );
    }

    #[test]
    fn discards_orphan_data_at_start() {
        assert_eq!(
            frame(&[&[60, 100, 0x90, 60, 100]]),
            vec![msg(0x90, 60, 100)]
        );
    }

    #[test]
    fn frames_several_messages_in_one_chunk() {
        assert_eq!(
            frame(&[&[0x90, 60, 100, 0x80, 60, 0, 0xB0, 64, 127]]),
            vec![msg(0x90, 60, 100), msg(0x80, 60, 0), msg(0xB0, 64, 127)]
        );
    }

    #[test]
    fn frames_a_message_split_across_pushes() {
        assert_eq!(
            frame(&[&[0x90], &[60], &[100, 0xB0, 1], &[2]]),
            vec![msg(0x90, 60, 100), msg(0xB0, 1, 2)]
        );
    }

    #[test]
    fn system_common_cancels_running_status() {
        assert_eq!(
            frame(&[&[0x90, 60, 1, 0xF3, 5, 61, 2]]),
            vec![msg(0x90, 60, 1), msg(0xF3, 5, 0)]
        );
    }

    /// The parser this framer replaced, kept here verbatim as the reference
    /// for the equivalence test: one message per callback, as `midir` hands
    /// them on desktop.
    fn legacy_parse(message: &[u8]) -> Option<(u8, u8, u8)> {
        let status = *message.first()?;
        let data1 = *message.get(1)?;
        let data2 = *message.get(2).unwrap_or(&0);
        Some((status, data1, data2))
    }

    #[test]
    fn matches_the_legacy_parser_for_every_channel_message() {
        let samples = [0u8, 1, 63, 64, 126, 127];
        for status in 0x80u8..=0xEF {
            let two_bytes = (0xC0..=0xDF).contains(&status);
            for &data1 in &samples {
                for &data2 in &samples {
                    let bytes: Vec<u8> = if two_bytes {
                        vec![status, data1]
                    } else {
                        vec![status, data1, data2]
                    };
                    let expected = legacy_parse(&bytes).unwrap();
                    // A fresh framer per message, like one midir callback.
                    let events = frame(&[&bytes]);
                    assert_eq!(
                        events,
                        vec![msg(expected.0, expected.1, expected.2)],
                        "bytes {bytes:02X?}"
                    );
                }
            }
        }
    }
}
