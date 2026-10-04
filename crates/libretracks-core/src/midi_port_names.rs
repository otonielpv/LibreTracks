//! Human port names for transports that only hand us device + port index.
//!
//! Settings and sessions store MIDI ports **by name** (so a `.ltset` made on
//! desktop still finds its port on a phone), which means the names a
//! transport lists must be unique and stable across reconnections. Android's
//! `MidiDeviceInfo` gives a product name, a per-port name that is often empty,
//! and a numeric id that changes on every reconnection — so the id can order
//! duplicates but must never appear in the name.
//!
//! Naming:
//! - the device is `product` (falling back to `name`, decided by the caller);
//! - a device with more than one port in this direction appends
//!   ` · <port name>`, or ` · <n>` (1-based) when the port has no name;
//! - two devices with the same name are told apart with ` (2)`, ` (3)`… in
//!   ascending device-id order;
//! - anything still colliding gets a final ` (n)` so names are always unique.

use std::collections::HashMap;

/// One port as the transport sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawPort {
    /// Transport id of the device. Orders duplicates; never shown.
    pub device_id: i64,
    pub device_name: String,
    /// Index of the port inside the device, in this direction.
    pub port_index: u32,
    pub port_name: Option<String>,
}

/// One unique display name per port, in the same order as `ports`.
pub fn disambiguate(ports: &[RawPort]) -> Vec<String> {
    let clean = |name: &str| name.trim().to_string();

    // Ports per device, to know whether a port suffix is needed.
    let mut port_counts: HashMap<i64, usize> = HashMap::new();
    for port in ports {
        *port_counts.entry(port.device_id).or_default() += 1;
    }

    // Distinct device ids per device name, ascending: position = suffix.
    let mut ids_by_name: HashMap<String, Vec<i64>> = HashMap::new();
    for port in ports {
        let ids = ids_by_name.entry(clean(&port.device_name)).or_default();
        if !ids.contains(&port.device_id) {
            ids.push(port.device_id);
        }
    }
    for ids in ids_by_name.values_mut() {
        ids.sort_unstable();
    }

    let mut names: Vec<String> = ports
        .iter()
        .map(|port| {
            let device_name = clean(&port.device_name);
            let ids = &ids_by_name[&device_name];
            let mut name = if ids.len() > 1 {
                let position = ids.iter().position(|id| *id == port.device_id).unwrap_or(0);
                if position == 0 {
                    device_name
                } else {
                    format!("{device_name} ({})", position + 1)
                }
            } else {
                device_name
            };
            if port_counts[&port.device_id] > 1 {
                let port_label = port
                    .port_name
                    .as_deref()
                    .map(str::trim)
                    .filter(|label| !label.is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| (port.port_index + 1).to_string());
                name = format!("{name} · {port_label}");
            }
            name
        })
        .collect();

    // Last resort: two ports of one device sharing a port name. Number the
    // repeats in (device id, port index) order so the result stays stable.
    let mut order: Vec<usize> = (0..ports.len()).collect();
    order.sort_by_key(|&i| (ports[i].device_id, ports[i].port_index));
    let mut seen: HashMap<String, usize> = HashMap::new();
    for i in order {
        let count = seen.entry(names[i].clone()).or_default();
        *count += 1;
        if *count > 1 {
            names[i] = format!("{} ({count})", names[i]);
        }
    }

    names
}

#[cfg(test)]
mod tests {
    use super::*;

    fn port(
        device_id: i64,
        device_name: &str,
        port_index: u32,
        port_name: Option<&str>,
    ) -> RawPort {
        RawPort {
            device_id,
            device_name: device_name.into(),
            port_index,
            port_name: port_name.map(str::to_string),
        }
    }

    #[test]
    fn a_single_port_is_just_the_device_name() {
        assert_eq!(
            disambiguate(&[port(7, "nanoKONTROL2", 0, Some("Port 1"))]),
            vec!["nanoKONTROL2"]
        );
    }

    #[test]
    fn several_ports_on_one_device_get_the_port_name() {
        assert_eq!(
            disambiguate(&[
                port(3, "UM-ONE", 0, Some("MIDI In")),
                port(3, "UM-ONE", 1, Some("MIDI Thru")),
            ]),
            vec!["UM-ONE · MIDI In", "UM-ONE · MIDI Thru"]
        );
    }

    #[test]
    fn unnamed_ports_get_their_one_based_number() {
        assert_eq!(
            disambiguate(&[port(3, "MIO", 0, None), port(3, "MIO", 1, Some("  ")),]),
            vec!["MIO · 1", "MIO · 2"]
        );
    }

    #[test]
    fn two_devices_with_the_same_name_are_numbered_by_id() {
        // Listed out of id order: numbering still follows the id.
        assert_eq!(
            disambiguate(&[port(12, "FS-1-WL", 0, None), port(4, "FS-1-WL", 0, None),]),
            vec!["FS-1-WL (2)", "FS-1-WL"]
        );
    }

    #[test]
    fn order_is_stable_and_follows_the_input() {
        let ports = vec![
            port(9, "B", 0, None),
            port(2, "A", 0, Some("x")),
            port(2, "A", 1, Some("y")),
        ];
        let first = disambiguate(&ports);
        assert_eq!(first, vec!["B", "A · x", "A · y"]);
        assert_eq!(disambiguate(&ports), first);
    }

    #[test]
    fn colliding_port_names_on_one_device_stay_unique() {
        assert_eq!(
            disambiguate(&[
                port(1, "Hub", 0, Some("MIDI")),
                port(1, "Hub", 1, Some("MIDI"))
            ]),
            vec!["Hub · MIDI", "Hub · MIDI (2)"]
        );
    }
}
