//! Pure half of the Android transport: turning `MidiBridge.listPorts` lines
//! into unique port names. Compiled on every platform so it is tested on the
//! host; the JNI half lives in `android.rs`.

use libretracks_core::midi_port_names::{disambiguate, RawPort};

/// Where a named port lives on the Android side.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct PortAddress {
    pub device_id: i32,
    pub port_index: i32,
}

/// Parse `deviceId \t portIndex \t deviceName \t portName \t own` lines (the
/// format `MidiBridge.listPorts` produces) and name every port uniquely.
/// Malformed lines are skipped rather than failing the whole list.
///
/// Lines with `own = 1` are LibreTracks' own virtual device (paso 10) and are
/// dropped: opening it through `MidiManager` would loop the app into itself.
/// The transport lists it instead as the internal "LibreTracks In"/"Out".
pub(crate) fn name_ports(lines: &[String]) -> Vec<(String, PortAddress)> {
    let mut raw = Vec::new();
    let mut addresses = Vec::new();
    for line in lines {
        let mut fields = line.splitn(5, '\t');
        let (Some(device_id), Some(port_index), Some(device_name)) =
            (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        let (Ok(device_id), Ok(port_index)) = (device_id.parse::<i32>(), port_index.parse::<i32>())
        else {
            continue;
        };
        let port_name = fields.next().map(str::to_string);
        if fields.next() == Some("1") {
            continue;
        }
        raw.push(RawPort {
            device_id: i64::from(device_id),
            device_name: device_name.to_string(),
            port_index: port_index.max(0) as u32,
            port_name,
        });
        addresses.push(PortAddress {
            device_id,
            port_index,
        });
    }
    disambiguate(&raw).into_iter().zip(addresses).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| item.to_string()).collect()
    }

    #[test]
    fn names_and_addresses_ports() {
        let ports = name_ports(&lines(&[
            "4\t0\tnanoKONTROL2\t",
            "9\t0\tUM-ONE\tMIDI 1",
            "9\t1\tUM-ONE\tMIDI 2",
        ]));
        let names: Vec<&str> = ports.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(names, vec!["nanoKONTROL2", "UM-ONE · MIDI 1", "UM-ONE · MIDI 2"]);
        assert_eq!(
            ports[2].1,
            PortAddress {
                device_id: 9,
                port_index: 1
            }
        );
    }

    #[test]
    fn our_own_virtual_device_is_never_listed_as_a_system_port() {
        let lines = lines(&[
            "5\t0\tLibreTracks\tLibreTracks In\t1",
            "6\t0\tPedal\t\t0",
            "7\t0\tLT Loopback\tin\t0",
        ]);
        let names: Vec<String> = name_ports(&lines).into_iter().map(|(name, _)| name).collect();
        assert_eq!(names, vec!["Pedal", "LT Loopback"]);

        // With publishing on, the transport adds the internal port exactly once.
        let inputs = super::super::virtual_names::with_own_virtual_port(
            names,
            Some(super::super::virtual_names::VIRTUAL_IN),
        );
        assert_eq!(inputs, vec!["Pedal", "LT Loopback", "LibreTracks In"]);
    }

    #[test]
    fn skips_malformed_lines() {
        let ports = name_ports(&lines(&["garbage", "x\t0\tA\t", "3\t0\tPedal\t"]));
        assert_eq!(ports.len(), 1);
        assert_eq!(ports[0].0, "Pedal");
    }
}
