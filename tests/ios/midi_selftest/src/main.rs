//! MIDI self-test for the iOS simulator (paso 02 del plan mobile-midi).
//!
//! Compiles the app's **real** transport (`midi/transport/`, via `#[path]`)
//! and drives it against CoreMIDI virtual endpoints created here, so the round
//! trip needs no hardware:
//!
//! - a virtual source `LT-SelfTest-Src` must show up in `input_names()`;
//! - a virtual destination `LT-SelfTest-Dst` must show up in `output_names()`;
//! - three CCs sent from the source in ONE packet must reach the framer as
//!   three messages;
//! - a note-on and a note-off sent through `open_output` must reach the
//!   destination.
//!
//! It also prints how `midir` splits a CoreMIDI packet (one callback per
//! message, or the whole packet) and what happens with running status.
//!
//! `LT_MIDI_SELFTEST_BREAK=skip_note_off` withholds the note-off on purpose:
//! the run must then fail, which is how CI proves this test can fail.
//!
//! Exit code 0 = pass. Runs on macOS too (`cargo run`), where CoreMIDI is the
//! same API.

#[path = "../../../../apps/desktop/src-tauri/src/midi/transport/mod.rs"]
#[allow(dead_code)]
mod transport;

use std::{
    process::ExitCode,
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use coremidi::{Client, PacketBuffer, PacketList};
use libretracks_core::midi_wire::{Framer, WireEvent};
use transport::platform_transport;

const SOURCE_NAME: &str = "LT-SelfTest-Src";
const DESTINATION_NAME: &str = "LT-SelfTest-Dst";
const WAIT: Duration = Duration::from_secs(2);

fn wait_until(mut done: impl FnMut() -> bool) -> bool {
    let started = Instant::now();
    while started.elapsed() < WAIT {
        if done() {
            return true;
        }
        thread::sleep(Duration::from_millis(10));
    }
    done()
}

fn main() -> ExitCode {
    let break_mode = std::env::var("LT_MIDI_SELFTEST_BREAK").unwrap_or_default();
    let mut failures: Vec<String> = Vec::new();
    let mut check = |ok: bool, what: &str| {
        println!("[{}] {what}", if ok { "PASS" } else { "FAIL" });
        if !ok {
            failures.push(what.to_string());
        }
    };

    let client = Client::new("lt-midi-selftest").expect("CoreMIDI client");
    let source = client
        .virtual_source(SOURCE_NAME)
        .expect("virtual source");
    let delivered: Arc<Mutex<Vec<u8>>> = Arc::default();
    let destination_sink = Arc::clone(&delivered);
    let _destination = client
        .virtual_destination(DESTINATION_NAME, move |packets: &PacketList| {
            let mut sink = destination_sink.lock().unwrap();
            for packet in packets.iter() {
                sink.extend_from_slice(packet.data());
            }
        })
        .expect("virtual destination");
    // CoreMIDI publishes new endpoints asynchronously.
    thread::sleep(Duration::from_millis(300));

    let transport = platform_transport();
    check(transport.capabilities().available, "capabilities().available");

    let inputs = transport.input_names().unwrap_or_default();
    println!("inputs: {inputs:?}");
    check(
        inputs.iter().any(|name| name == SOURCE_NAME),
        "input_names() lists the virtual source",
    );
    let outputs = transport.output_names().unwrap_or_default();
    println!("outputs: {outputs:?}");
    check(
        outputs.iter().any(|name| name == DESTINATION_NAME),
        "output_names() lists the virtual destination",
    );

    // ── Input: three CCs in one packet ─────────────────────────────────────
    let framed: Arc<Mutex<Vec<WireEvent>>> = Arc::default();
    let callbacks: Arc<Mutex<Vec<Vec<u8>>>> = Arc::default();
    let framed_sink = Arc::clone(&framed);
    let callback_sink = Arc::clone(&callbacks);
    let mut framer = Framer::new();
    match transport.open_input(
        SOURCE_NAME,
        Box::new(move |bytes| {
            callback_sink.lock().unwrap().push(bytes.to_vec());
            framer.push(bytes, &mut |event| framed_sink.lock().unwrap().push(event));
        }),
    ) {
        Ok(connection) => {
            thread::sleep(Duration::from_millis(100));
            let three_ccs = [0xB0, 1, 10, 0xB0, 2, 20, 0xB0, 3, 30];
            let _ = source.received(&PacketBuffer::new(0, &three_ccs));
            let arrived = wait_until(|| framed.lock().unwrap().len() >= 3);
            let events = framed.lock().unwrap().clone();
            println!(
                "one packet with 3 CCs -> midir callbacks: {:02X?}",
                callbacks.lock().unwrap()
            );
            check(
                arrived
                    && events
                        == vec![
                            WireEvent::Message { status: 0xB0, data1: 1, data2: 10 },
                            WireEvent::Message { status: 0xB0, data1: 2, data2: 20 },
                            WireEvent::Message { status: 0xB0, data1: 3, data2: 30 },
                        ],
                "three CCs in one packet arrive as three messages",
            );

            // Observation only: midir's CoreMIDI parser stops at a data byte
            // where it expects a status, so running status inside a packet
            // may be cut short. Printed for the bitácora, not asserted.
            framed.lock().unwrap().clear();
            callbacks.lock().unwrap().clear();
            let running_status = [0xB0, 4, 40, 5, 50, 6, 60];
            let _ = source.received(&PacketBuffer::new(0, &running_status));
            thread::sleep(Duration::from_millis(500));
            println!(
                "OBSERVE running status in one packet: sent 3 CCs, framed {} -> callbacks {:02X?}",
                framed.lock().unwrap().len(),
                callbacks.lock().unwrap()
            );
            drop(connection);
        }
        Err(error) => check(false, &format!("open_input failed: {error}")),
    }

    // ── Output: note-on + note-off reach the destination ───────────────────
    match transport.open_output(DESTINATION_NAME) {
        Ok(mut connection) => {
            let note_on = [0x90, 60, 100];
            let note_off = [0x80, 60, 0];
            let _ = connection.send(&note_on);
            if break_mode != "skip_note_off" {
                let _ = connection.send(&note_off);
            } else {
                println!("LT_MIDI_SELFTEST_BREAK=skip_note_off: note-off withheld on purpose");
            }
            let expected: Vec<u8> = note_on.iter().chain(note_off.iter()).copied().collect();
            let arrived = wait_until(|| delivered.lock().unwrap().len() >= expected.len());
            let got = delivered.lock().unwrap().clone();
            println!("destination received: {got:02X?}");
            check(arrived && got == expected, "note-on and note-off reach the destination");
        }
        Err(error) => check(false, &format!("open_output failed: {error}")),
    }

    // ── Virtual ports (paso 07): seen and used by another CoreMIDI client ──
    // The test's own client stands in for "another app on the device".
    match transport.set_virtual_ports(true) {
        Ok(()) => {
            thread::sleep(Duration::from_millis(300));
            let names_in = transport.input_names().unwrap_or_default();
            let names_out = transport.output_names().unwrap_or_default();
            check(
                names_in.iter().filter(|name| *name == "LibreTracks In").count() == 1
                    && names_out.iter().filter(|name| *name == "LibreTracks Out").count() == 1
                    && !names_in.iter().any(|name| name == "LibreTracks Out")
                    && !names_out.iter().any(|name| name == "LibreTracks In"),
                "each virtual port is listed once, in its own direction",
            );

            let other_app_sees = |name: &str, sources: bool| {
                if sources {
                    coremidi::Sources
                        .into_iter()
                        .any(|source| source.name().as_deref() == Some(name))
                } else {
                    coremidi::Destinations
                        .into_iter()
                        .any(|destination| destination.name().as_deref() == Some(name))
                }
            };
            check(
                other_app_sees("LibreTracks Out", true) && other_app_sees("LibreTracks In", false),
                "another client sees LibreTracks Out (source) and LibreTracks In (destination)",
            );

            // Another app sends to "LibreTracks In": our listener gets it.
            let virtual_in: Arc<Mutex<Vec<WireEvent>>> = Arc::default();
            let sink = Arc::clone(&virtual_in);
            let mut framer = Framer::new();
            let listener = transport.open_input(
                "LibreTracks In",
                Box::new(move |bytes| {
                    framer.push(bytes, &mut |event| sink.lock().unwrap().push(event));
                }),
            );
            let sender_port = client.output_port("lt-selftest-other-app-out").expect("output port");
            if let Some(destination) = coremidi::Destinations
                .into_iter()
                .find(|destination| destination.name().as_deref() == Some("LibreTracks In"))
            {
                let _ = sender_port.send(&destination, &PacketBuffer::new(0, &[0x90, 64, 90]));
            }
            check(
                listener.is_ok()
                    && wait_until(|| {
                        virtual_in.lock().unwrap().contains(&WireEvent::Message {
                            status: 0x90,
                            data1: 64,
                            data2: 90,
                        })
                    }),
                "a note sent to LibreTracks In reaches the input listener",
            );
            drop(listener);

            // We send on "LibreTracks Out": another app reading it gets it.
            let read_back: Arc<Mutex<Vec<u8>>> = Arc::default();
            let reader_sink = Arc::clone(&read_back);
            let reader = client
                .input_port("lt-selftest-other-app-in", move |packets: &PacketList| {
                    let mut sink = reader_sink.lock().unwrap();
                    for packet in packets.iter() {
                        sink.extend_from_slice(packet.data());
                    }
                })
                .expect("input port");
            if let Some(source) = coremidi::Sources
                .into_iter()
                .find(|source| source.name().as_deref() == Some("LibreTracks Out"))
            {
                let _ = reader.connect_source(&source);
            }
            thread::sleep(Duration::from_millis(100));
            let sent = transport
                .open_output("LibreTracks Out")
                .map(|mut connection| connection.send(&[0xC0, 5]));
            check(
                matches!(sent, Ok(Ok(())))
                    && wait_until(|| read_back.lock().unwrap().as_slice() == [0xC0, 5]),
                "a program change sent on LibreTracks Out reaches another client",
            );

            let _ = transport.set_virtual_ports(false);
            thread::sleep(Duration::from_millis(300));
            check(
                !transport
                    .input_names()
                    .unwrap_or_default()
                    .iter()
                    .any(|name| name == "LibreTracks In")
                    && !other_app_sees("LibreTracks Out", true),
                "turning publishing off removes both ports",
            );
        }
        Err(error) => check(false, &format!("set_virtual_ports(true) failed: {error}")),
    }

    if failures.is_empty() {
        println!("MIDI_SELFTEST_RESULT=PASS");
        ExitCode::SUCCESS
    } else {
        println!("MIDI_SELFTEST_RESULT=FAIL ({})", failures.join("; "));
        ExitCode::FAILURE
    }
}
